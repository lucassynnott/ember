const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');
const {WindowsDriveState}=require('../src/windows-drive-state');const {moveLocalFile}=require('../src/windows-drive-move');
async function fixture(){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ember-move-transaction-')),secret=crypto.randomBytes(32);
 const cipher={isEncryptionAvailable:()=>true,encryptString(text){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',secret,iv);const body=Buffer.concat([c.update(text),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]);},decryptString(bytes){const c=crypto.createDecipheriv('aes-256-gcm',secret,bytes.subarray(0,12));c.setAuthTag(bytes.subarray(12,28));return Buffer.concat([c.update(bytes.subarray(28)),c.final()]).toString();}};
 const state=new WindowsDriveState({directory,safeStorage:cipher});await state.load();
 const source={name:'remote/original.txt',etag:'"old"',fileID:'original-version',size:4,modified:123};await state.markMaterialized('Folder/original.txt',{key:source.name,etag:source.etag,fileID:source.fileID,size:4,modified:123});
 const events=[],remote=new Map([[source.name,source]]),previous=JSON.stringify({key:source.name,etag:source.etag,fileID:source.fileID});
 const bridge={async inspect(){return {exists:false};},async lockUpload(){events.push('lock');return {token:'owned',cloud:true,identity:previous,modifiedBytes:0,size:4,modified:123,localPath:'owned-placeholder'};},async ackMove(token,object,identity){assert.equal(token,'owned');assert.equal(identity,previous);events.push('ack');},async unlockUpload(){events.push('unlock');}};
 const store={async stat(key){return remote.get(key)||null;},async copy(object,key){events.push('copy');assert.equal(object.etag,source.etag);if(remote.has(key))throw Error('Destination exists');const copied={...source,name:key,etag:'"copied"',fileID:'copy-version',modified:124};remote.set(key,copied);return {CopyObjectResult:{ETag:copied.etag},VersionId:copied.fileID};},async deleteVersion(key,version,{etag}){events.push('delete');assert.equal(version,'');if(remote.get(key)?.etag!==etag)throw Error('Source changed');remote.delete(key);}};
 const args={bridge,store,state,from:'Folder/original.txt',local:'Folder/renamed.txt',key:'remote/renamed.txt',fingerprint:async()=>{events.push('fingerprint');return 'a'.repeat(64);}};
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
 for(const fault of ['occupied','source-race','dirty','duplicate']){const f=await fixture();try{
  if(fault==='occupied')f.remote.set(f.args.key,{name:f.args.key,etag:'keep',fileID:'keep',size:8});
  if(fault==='source-race'){const copy=f.args.store.copy;f.args.store.copy=async(...args)=>{const result=await copy(...args);f.remote.set(f.source.name,{...f.source,etag:'changed'});return result;};}
  if(fault==='dirty'){const lock=f.args.bridge.lockUpload;f.args.bridge.lockUpload=async()=>({...await lock(),modifiedBytes:4});}
  if(fault==='duplicate')f.args.bridge.inspect=async()=>({exists:true});
  await assert.rejects(moveLocalFile(f.args));assert.equal(f.remote.has(f.source.name),true);assert.equal(f.events.includes('ack'),false);
  if(fault==='dirty'||fault==='duplicate'){assert.equal(f.events.includes('copy'),false);assert.deepEqual(f.state.snapshot().moves,{});}
  if(fault==='occupied')assert.equal(f.remote.get(f.args.key).etag,'keep');
  if(fault==='source-race')assert.equal(f.remote.get(f.source.name).etag,'changed');
 }finally{await f.close();}}
});
