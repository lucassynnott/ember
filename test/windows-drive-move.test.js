const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');
const {WindowsDriveState}=require('../src/windows-drive-state');const {moveLocalFile,recoverMove}=require('../src/windows-drive-move');
async function fixture(){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ember-move-transaction-')),secret=crypto.randomBytes(32);
 const cipher={isEncryptionAvailable:()=>true,encryptString(text){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',secret,iv);const body=Buffer.concat([c.update(text),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]);},decryptString(bytes){const c=crypto.createDecipheriv('aes-256-gcm',secret,bytes.subarray(0,12));c.setAuthTag(bytes.subarray(12,28));return Buffer.concat([c.update(bytes.subarray(28)),c.final()]).toString();}};
 const state=new WindowsDriveState({directory,safeStorage:cipher});await state.load();
 const source={name:'remote/original.txt',etag:'"old"',fileID:'original-version',size:4,modified:123};await state.markMaterialized('Folder/original.txt',{key:source.name,etag:source.etag,fileID:source.fileID,size:4,modified:123});
 const events=[],remote=new Map([[source.name,source]]),previous=JSON.stringify({key:source.name,etag:source.etag,fileID:source.fileID});
 const bridge={async inspect(){return {exists:false};},async lockUpload(){events.push('lock');return {token:'owned',cloud:true,inSync:true,identity:previous,modifiedBytes:0,size:4,modified:123,localPath:'owned-placeholder'};},async ackMove(token,object,identity){assert.equal(token,'owned');assert.equal(identity,previous);events.push('ack');},async unlockUpload(){events.push('unlock');}};
 const store={async read(key,offset,length,version,signal,etag){events.push('read');assert.equal(remote.get(key)?.etag,etag);assert.equal(remote.get(key)?.fileID,version);return Buffer.from('Data').subarray(offset,offset+length);},async stat(key){return remote.get(key)||null;},async copy(object,key){events.push('copy');assert.equal(object.etag,source.etag);if(remote.has(key))throw Error('Destination exists');const copied={...source,name:key,etag:'"copied"',fileID:'copy-version',modified:124};remote.set(key,copied);return {CopyObjectResult:{ETag:copied.etag},VersionId:copied.fileID};},async deleteVersion(key,version,{etag}){events.push('delete');assert.equal(version,'');if(remote.get(key)?.etag!==etag)throw Error('Source changed');remote.delete(key);}};
 const args={bridge,store,state,from:'Folder/original.txt',local:'Folder/renamed.txt',key:'remote/renamed.txt',fingerprint:async()=>{events.push('fingerprint');return crypto.createHash('sha256').update('Data').digest('hex');}};
 return {args,events,remote,source,state,async reopen(){const next=new WindowsDriveState({directory,safeStorage:cipher});await next.load();return next;},async close(){await fs.rm(directory,{recursive:true,force:true});}};
}
test('move confirms copy and source deletion before native acknowledgement and atomic encrypted rebinding',async()=>{
 const f=await fixture();try{const result=await moveLocalFile(f.args);assert.equal(result.name,f.args.key);assert.deepEqual(f.events,['lock','fingerprint','copy','delete','ack','unlock']);assert.equal(f.remote.has(f.source.name),false);const restored=await f.reopen();assert.deepEqual(restored.snapshot().moves,{});assert.equal(Object.hasOwn(restored.snapshot().materialized,f.args.from),false);assert.equal(restored.snapshot().materialized[f.args.local].etag,'"copied"');}finally{await f.close();}
});
test('lost copy response persists a held copying intent without deleting or replaying cloud writes',async()=>{
 const f=await fixture();try{const copy=f.args.store.copy;f.args.store.copy=async(...args)=>{await copy(...args);throw Error('Response lost');};await assert.rejects(moveLocalFile(f.args),/Response lost/);const restored=await f.reopen();assert.equal(Object.values(restored.snapshot().moves)[0].phase,'copying');assert.equal(f.remote.has(f.source.name),true);assert.equal(f.remote.has(f.args.key),true);assert.equal(f.events.includes('delete'),false);await assert.rejects(moveLocalFile({...f.args,state:restored}),/unfinished operation/);assert.equal(f.events.filter(event=>event==='copy').length,1);assert.equal(restored.snapshot().materialized[f.args.from].etag,'"old"');}finally{await f.close();}
});
test('lost delete response and failed native acknowledgement retain recoverable intents and original local bindings',async()=>{
 for(const failure of ['delete','ack']){const f=await fixture();try{const operation=f.args[failure==='delete'?'store':'bridge'][failure==='delete'?'deleteVersion':'ackMove'];f.args[failure==='delete'?'store':'bridge'][failure==='delete'?'deleteVersion':'ackMove']=async(...args)=>{if(failure==='delete')await operation(...args);throw Error('Uncertain '+failure);};await assert.rejects(moveLocalFile(f.args),/Uncertain/);const state=(await f.reopen()).snapshot();assert.equal(Object.values(state.moves)[0].phase,failure==='delete'?'deleting':'deleted');assert.equal(state.materialized[f.args.from].etag,'"old"');assert.equal(Object.hasOwn(state.materialized,f.args.local),false);assert.equal(f.remote.has(f.args.key),true);assert.equal(f.events.at(-1),'unlock');}finally{await f.close();}}
});
test('moves preserve occupied destinations, source races and locally modified or duplicated placeholders',async()=>{
 for(const fault of ['occupied','source-race','dirty','out-of-sync','duplicate']){const f=await fixture();try{
  if(fault==='occupied')f.remote.set(f.args.key,{name:f.args.key,etag:'keep',fileID:'keep',size:8});
  if(fault==='source-race'){const copy=f.args.store.copy;f.args.store.copy=async(...args)=>{const result=await copy(...args);f.remote.set(f.source.name,{...f.source,etag:'changed'});return result;};}
  if(fault==='dirty'||fault==='out-of-sync'){const lock=f.args.bridge.lockUpload;f.args.bridge.lockUpload=async()=>({...await lock(),modifiedBytes:fault==='dirty'?4:0,inSync:fault!=='out-of-sync'});}
  if(fault==='duplicate')f.args.bridge.inspect=async()=>({exists:true});
  await assert.rejects(moveLocalFile(f.args));assert.equal(f.remote.has(f.source.name),true);assert.equal(f.events.includes('ack'),false);
  if(fault==='dirty'||fault==='out-of-sync'||fault==='duplicate'){assert.equal(f.events.includes('copy'),false);assert.deepEqual(f.state.snapshot().moves,{});}
  if(fault==='occupied')assert.equal(f.remote.get(f.args.key).etag,'keep');
  if(fault==='source-race')assert.equal(f.remote.get(f.source.name).etag,'changed');
 }finally{await f.close();}}
});

async function interruptedDelete(f){const remove=f.args.store.deleteVersion;f.args.store.deleteVersion=async(...args)=>{await remove(...args);throw Error('Lost delete acknowledgement');};await assert.rejects(moveLocalFile(f.args),/Lost delete/);return Object.keys(f.state.snapshot().moves)[0];}
test('read-only move recovery proves complete destination bytes and clears a lost delete acknowledgement',async()=>{
 const f=await fixture();try{const id=await interruptedDelete(f),before=f.events.length;const result=await recoverMove({...f.args,id,state:await f.reopen()});assert.deepEqual(result,{resolved:true,readOnlyCloudCheck:true});assert.deepEqual(f.events.slice(before),['lock','read','ack','unlock']);const saved=(await f.reopen()).snapshot();assert.deepEqual(saved.moves,{});assert.equal(saved.materialized[f.args.local].etag,'"copied"');assert.equal(Object.hasOwn(saved.materialized,f.args.from),false);}finally{await f.close();}
});
test('move recovery never copies or deletes when the original source still exists',async()=>{
 const f=await fixture();try{const copy=f.args.store.copy;f.args.store.copy=async(...args)=>{await copy(...args);throw Error('Lost copy response');};await assert.rejects(moveLocalFile(f.args));const id=Object.keys(f.state.snapshot().moves)[0],before=f.events.length;assert.deepEqual(await recoverMove({...f.args,id}),{resolved:false,reason:'move-source-still-present'});assert.deepEqual(f.events.slice(before),[]);assert.equal(f.state.snapshot().moves[id].phase,'copying');}finally{await f.close();}
});
test('recovery finishes an already-acknowledged native move without repeating its acknowledgement',async()=>{
 const f=await fixture();try{const id=await interruptedDelete(f);const lock=f.args.bridge.lockUpload;f.args.bridge.lockUpload=async()=>({...await lock(),identity:JSON.stringify({key:f.args.key,etag:'"copied"',fileID:'copy-version'})});const before=f.events.length;assert.equal((await recoverMove({...f.args,id})).resolved,true);assert.deepEqual(f.events.slice(before),['lock','read','unlock']);assert.deepEqual(f.state.snapshot().moves,{});}finally{await f.close();}
});
test('move recovery preserves held local bindings for dirty files, changed content and cloud races',async()=>{
 for(const failure of ['dirty','out-of-sync','content','source-race','revision-race','cancelled']){const f=await fixture();try{const id=await interruptedDelete(f),before=f.events.length;let signal;
  if(failure==='dirty'||failure==='out-of-sync'){const lock=f.args.bridge.lockUpload;f.args.bridge.lockUpload=async()=>({...await lock(),modifiedBytes:failure==='dirty'?4:0,inSync:failure!=='out-of-sync'});}
  if(failure==='content')f.args.store.read=async()=>Buffer.from('Else');
  if(failure==='source-race'||failure==='revision-race'||failure==='cancelled'){const read=f.args.store.read,controller=new AbortController();signal=controller.signal;f.args.store.read=async(...args)=>{const bytes=await read(...args);if(failure==='source-race')f.remote.set(f.source.name,{...f.source,etag:'new-source'});else if(failure==='revision-race')f.remote.set(f.args.key,{...f.remote.get(f.args.key),etag:'new-destination'});else controller.abort();return bytes;};}
  if(failure==='cancelled')await assert.rejects(recoverMove({...f.args,id,signal}),/cancelled/);else assert.equal((await recoverMove({...f.args,id,signal})).resolved,false);
  assert.equal(f.events.slice(before).some(event=>['copy','delete','ack'].includes(event)),false);assert.equal(f.state.snapshot().moves[id].phase,'deleting');assert.equal(f.state.snapshot().materialized[f.args.from].etag,'"old"');
 }finally{await f.close();}}
});
