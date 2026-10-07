const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const crypto=require('node:crypto');const {WindowsDriveState}=require('../src/windows-drive-state');const {replacePinnedRevision,recoverPinnedRevision}=require('../src/windows-drive-pinned-update');
const {restorePinnedRevision}=require('../src/windows-drive-pinned-update');
async function fixture(){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'ember-pinned-coordinator-')),root=path.join(base,'Drive'),file=path.join(root,'pinned.txt');await fs.mkdir(root);await fs.writeFile(file,'Data');const secret=crypto.randomBytes(32);
 const safeStorage={isEncryptionAvailable:()=>true,encryptString(text){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',secret,iv),bytes=Buffer.concat([c.update(text),c.final()]);return Buffer.concat([iv,c.getAuthTag(),bytes]);},decryptString(bytes){const c=crypto.createDecipheriv('aes-256-gcm',secret,bytes.subarray(0,12));c.setAuthTag(bytes.subarray(12,28));return Buffer.concat([c.update(bytes.subarray(28)),c.final()]).toString();}};
 const state=new WindowsDriveState({directory:path.join(base,'profile'),safeStorage});await state.load();const previous={key:'remote/pinned.txt',etag:'"old"',fileID:'old-version',size:4,modified:1};await state.markMaterialized('pinned.txt',previous);
 const object={name:previous.key,etag:'"new"',fileID:'new-version',size:4,modified:2},expectedIdentity=JSON.stringify({key:previous.key,fileID:previous.fileID,etag:previous.etag}),events=[];let info={cloud:true,inSync:true,pinState:1,modifiedBytes:0,onDiskBytes:4,identity:expectedIdentity};
 const phase=()=>Object.values(state.snapshot().pinnedUpdates)[0]?.phase;
 const lock=async()=>({token:'held',size:(await fs.stat(file)).size,localPath:file,modified:1,...info});
 const bridge={async lockPinnedUpdate(){events.push('lock');return lock();},async lockPinnedRecovery(){events.push('recover-lock');return lock();},async unlockUpload(){events.push('unlock');},async capturePinnedBackup(token,args){assert.equal(phase(),'prepared');events.push('backup');const bytes=await fs.readFile(file),handle=await fs.open(args.backup,'wx');try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}return {file:args.backup,size:bytes.length,hash:crypto.createHash('sha256').update(bytes).digest('hex')};},async replacePinned(token,args){assert.equal(phase(),'replacing');events.push('replace');const bytes=await fs.readFile(args.source);await fs.writeFile(file,bytes);info={...info,inSync:false};return {hash:args.hash,size:bytes.length};},async ackPinnedUpdate(token,revision=object){assert.ok(['installed','replacing','finishing','restoring','restored'].includes(phase()));events.push('ack');info={cloud:true,inSync:true,pinState:1,modifiedBytes:0,onDiskBytes:4,identity:JSON.stringify({key:revision.name,fileID:revision.fileID,etag:revision.etag})};},async fingerprintPinned(){events.push('fingerprint');const bytes=await fs.readFile(file);return {hash:crypto.createHash('sha256').update(bytes).digest('hex'),size:bytes.length,placeholder:info};}};
 bridge.capturePinnedCurrent=async(token,args)=>{assert.ok(['replacing','installed','finishing','restoring','restored'].includes(phase()));events.push('current-backup');const bytes=await fs.readFile(file),handle=await fs.open(args.backup,'wx');try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}return {file:args.backup,size:bytes.length,hash:crypto.createHash('sha256').update(bytes).digest('hex')};};
 bridge.finishPinned=async(token,args)=>{assert.ok(['finishing','restoring'].includes(phase()));events.push('finish');const entry=Object.values(state.snapshot().pinnedUpdates)[0];assert.equal(entry.preserved.at(-1).file,args.backup);assert.deepEqual(await fs.readFile(args.backup),await fs.readFile(file));const bytes=await fs.readFile(args.source);await fs.writeFile(file,bytes);info={...info,inSync:false};return {hash:args.hash,size:bytes.length};};
 const store={async read(){return Buffer.from('Next');},async stat(){return object;}};return {base,root,file,state,object,events,bridge,store,args:{local:'pinned.txt',object,root,bridge,store,state},async close(){await fs.rm(base,{recursive:true,force:true});}};
}
test('original restoration requires literal confirmation and preserves current, downloaded and original bytes',async()=>{
 const f=await fixture();try{
  f.bridge.replacePinned=async()=>{await fs.writeFile(f.file,'Partial edited bytes');throw Error('Interrupted');};await assert.rejects(replacePinnedRevision(f.args));const id=Object.keys(f.state.snapshot().pinnedUpdates)[0];
  f.store.stat=async()=>{throw Error('Restoration must not access or write the cloud');};
  for(const restore of [false,'true']){const before=f.events.length;assert.equal((await restorePinnedRevision({...f.args,id,restore})).reason,'pinned-original-restoration-confirmation-required');assert.equal(f.events.slice(before).some(e=>['current-backup','finish','ack'].includes(e)),false);assert.equal(await fs.readFile(f.file,'utf8'),'Partial edited bytes');}
  assert.equal((await restorePinnedRevision({...f.args,id,restore:true})).originalRestored,true);const held=f.state.snapshot().pinnedUpdates[id];assert.equal(held.phase,'restored');assert.equal(await fs.readFile(f.file,'utf8'),'Data');assert.equal(await fs.readFile(held.backup.file,'utf8'),'Data');assert.equal(await fs.readFile(held.staged.file,'utf8'),'Next');assert.equal(await fs.readFile(held.preserved[0].file,'utf8'),'Partial edited bytes');assert.equal(f.state.snapshot().materialized['pinned.txt'].etag,'"old"');
  const before=f.events.length;assert.equal((await recoverPinnedRevision({...f.args,id})).reason,'pinned-original-restored');assert.equal(f.events.slice(before).some(e=>['current-backup','finish','ack'].includes(e)),false);assert(f.state.snapshot().pinnedUpdates[id]);
 }finally{await f.close();}
});
test('lost original overwrite and acknowledgement responses retain durable intent and retry without repeating overwrite',async()=>{
 for(const at of ['finish','ack']){const f=await fixture();try{
  f.bridge.replacePinned=async()=>{await fs.writeFile(f.file,'Part');throw Error('Interrupted');};await assert.rejects(replacePinnedRevision(f.args));const id=Object.keys(f.state.snapshot().pinnedUpdates)[0],method=at==='finish'?'finishPinned':'ackPinnedUpdate',operation=f.bridge[method];f.bridge[method]=async(...args)=>{await operation(...args);throw Error('Lost restoration reply');};
  await assert.rejects(restorePinnedRevision({...f.args,id,restore:true}),/Lost restoration reply/);assert.equal(f.state.snapshot().pinnedUpdates[id].phase,'restoring');assert.equal(await fs.readFile(f.file,'utf8'),'Data');await f.state.load();assert.equal(f.state.snapshot().pinnedUpdates[id].phase,'restoring');f.bridge[method]=operation;
  const before=f.events.length;assert.equal((await restorePinnedRevision({...f.args,id,restore:true})).originalRestored,true);assert.equal(f.events.slice(before).includes('finish'),false);assert.equal(f.events.slice(before).includes('current-backup'),false);if(at==='ack')assert.equal(f.events.slice(before).includes('ack'),false);assert.equal(f.state.snapshot().pinnedUpdates[id].phase,'restored');
 }finally{await f.close();}}
});
test('restoration refuses changed original bytes and cancellation before overwrite preserves every copy',async()=>{
 for(const fault of ['original','cancel']){const f=await fixture(),controller=new AbortController();try{
  f.bridge.replacePinned=async()=>{await fs.writeFile(f.file,'Part');throw Error('Interrupted');};await assert.rejects(replacePinnedRevision(f.args));const id=Object.keys(f.state.snapshot().pinnedUpdates)[0],entry=f.state.snapshot().pinnedUpdates[id];
  if(fault==='original')await fs.writeFile(entry.backup.file,'Fake');else{const capture=f.bridge.capturePinnedCurrent;f.bridge.capturePinnedCurrent=async(...args)=>{const result=await capture(...args);controller.abort();return result;};}
  const before=f.events.length;await assert.rejects(restorePinnedRevision({...f.args,id,restore:true,signal:controller.signal}));assert.equal(await fs.readFile(f.file,'utf8'),'Part');assert.equal(f.events.slice(before).includes('finish'),false);assert.equal(f.events.at(-1),'unlock');assert(f.state.snapshot().pinnedUpdates[id]);if(fault==='cancel')assert.equal(await fs.readFile(f.state.snapshot().pinnedUpdates[id].preserved[0].file,'utf8'),'Part');
 }finally{await f.close();}}
});
test('explicit finishing after original restoration installs the downloaded revision and keeps all local history',async()=>{
 const f=await fixture();try{
  f.bridge.replacePinned=async()=>{await fs.writeFile(f.file,'Part');throw Error('Interrupted');};await assert.rejects(replacePinnedRevision(f.args));const id=Object.keys(f.state.snapshot().pinnedUpdates)[0];await restorePinnedRevision({...f.args,id,restore:true});assert.equal((await recoverPinnedRevision({...f.args,id,finish:true})).resolved,true);assert.equal(await fs.readFile(f.file,'utf8'),'Next');assert.deepEqual(f.state.snapshot().pinnedUpdates,{});const history=f.state.snapshot().savedPinnedCopies[id];assert.equal(await fs.readFile(history.copies[1].file,'utf8'),'Part');assert.equal(await fs.readFile(history.copies[2].file,'utf8'),'Data');
 }finally{await f.close();}
});
test('pinned coordinator journals its backup and replacement before mutation then confirms pin and cached bytes',async()=>{
 const f=await fixture();try{await replacePinnedRevision(f.args);assert.deepEqual(f.events,['lock','backup','replace','ack','fingerprint','unlock']);assert.equal(await fs.readFile(f.file,'utf8'),'Next');assert.equal(f.state.snapshot().materialized['pinned.txt'].etag,'"new"');assert.deepEqual(f.state.snapshot().pinnedUpdates,{});assert.deepEqual(await fs.readdir(path.join(f.state.directory,'pinned-revisions')),[]);}finally{await f.close();}
});
test('failed capture or a cloud race before overwrite retains original offline bytes and can clear without repeating writes',async()=>{
 for(const fault of ['backup','cloud']){const f=await fixture();try{const backup=f.bridge.capturePinnedBackup;f.bridge.capturePinnedBackup=async(...args)=>{const result=await backup(...args);if(fault==='backup')throw Error('Lost backup response');f.store.stat=async()=>({...f.object,etag:'"changed"'});return result;};await assert.rejects(replacePinnedRevision(f.args));const id=Object.keys(f.state.snapshot().pinnedUpdates)[0],before=f.events.length;assert.equal(await fs.readFile(f.file,'utf8'),'Data');assert.equal((await recoverPinnedRevision({...f.args,id})).originalPreserved,true);assert.equal(f.events.slice(before).some(e=>['backup','replace','ack'].includes(e)),false);assert.deepEqual(f.state.snapshot().pinnedUpdates,{});}finally{await f.close();}}
});
test('lost overwrite or acknowledgement responses recover verified new bytes without repeating the overwrite',async()=>{
 for(const fault of ['replace','ack']){const f=await fixture();try{
  const acknowledge=f.bridge.ackPinnedUpdate,operation=f.bridge[fault==='replace'?'replacePinned':'ackPinnedUpdate'];f.bridge[fault==='replace'?'replacePinned':'ackPinnedUpdate']=async(...args)=>{await operation(...args);throw Error('Lost '+fault+' response');};
  await assert.rejects(replacePinnedRevision(f.args),/Lost/);const id=Object.keys(f.state.snapshot().pinnedUpdates)[0],entry=f.state.snapshot().pinnedUpdates[id];assert.equal(await fs.readFile(entry.backup.file,'utf8'),'Data');const before=f.events.length;f.bridge.ackPinnedUpdate=acknowledge;
  assert.equal((await recoverPinnedRevision({...f.args,id})).resolved,true);assert.equal(f.events.slice(before).includes('replace'),false);if(fault==='ack')assert.equal(f.events.slice(before).includes('ack'),false);assert.deepEqual(f.state.snapshot().pinnedUpdates,{});assert.equal(await fs.readFile(f.file,'utf8'),'Next');
 }finally{await f.close();}}
});
test('partial installation and a changed cloud revision preserve held recovery files without overwriting local bytes',async()=>{
 for(const fault of ['partial','cloud']){const f=await fixture();try{const replace=f.bridge.replacePinned;f.bridge.replacePinned=async(...args)=>{if(fault==='partial'){await fs.writeFile(f.file,'Part');throw Error('Interrupted overwrite');}const result=await replace(...args);f.store.stat=async()=>({...f.object,etag:'"another"'});return result;};await assert.rejects(replacePinnedRevision(f.args));const id=Object.keys(f.state.snapshot().pinnedUpdates)[0],entry=f.state.snapshot().pinnedUpdates[id],before=f.events.length;
  if(fault==='partial')assert.deepEqual(await recoverPinnedRevision({...f.args,id}),{resolved:false,reason:'local-changed'});else await assert.rejects(recoverPinnedRevision({...f.args,id}),/cloud pinned revision changed/);
  assert.equal(f.events.slice(before).some(e=>['backup','replace','ack'].includes(e)),false);assert.equal(await fs.readFile(entry.backup.file,'utf8'),'Data');assert.equal(await fs.readFile(entry.staged.file,'utf8'),'Next');assert.equal(await fs.readFile(f.file,'utf8'),fault==='partial'?'Part':'Next');assert.equal(Object.hasOwn(f.state.snapshot().pinnedUpdates,id),true);
 }finally{await f.close();}}
});
test('dirty pinned source is refused before starting a journal or changing its offline file',async()=>{
 const f=await fixture();try{const lock=f.bridge.lockPinnedUpdate;f.bridge.lockPinnedUpdate=async()=>({...await lock(),inSync:false});await assert.rejects(replacePinnedRevision(f.args),/Local pinned edits/);assert.deepEqual(f.state.snapshot().pinnedUpdates,{});assert.equal(await fs.readFile(f.file,'utf8'),'Data');assert.deepEqual(await fs.readdir(path.join(f.state.directory,'pinned-revisions')),[]);}finally{await f.close();}
});
test('cancelling a pinned refresh before or after overwrite preserves recovery proof and unlocks the file',async()=>{
 for(const at of ['backup','replace']){const f=await fixture(),controller=new AbortController();try{
  const method=at==='backup'?'capturePinnedBackup':'replacePinned',operation=f.bridge[method];f.bridge[method]=async(...args)=>{const result=await operation(...args);controller.abort();return result;};
  await assert.rejects(replacePinnedRevision({...f.args,signal:controller.signal}));
  const id=Object.keys(f.state.snapshot().pinnedUpdates)[0],entry=f.state.snapshot().pinnedUpdates[id];assert(id);assert.equal(f.events.at(-1),'unlock');assert.equal(f.events.includes('ack'),false);
  assert.equal(await fs.readFile(entry.backup.file,'utf8'),'Data');assert.equal(await fs.readFile(entry.staged.file,'utf8'),'Next');assert.equal(await fs.readFile(f.file,'utf8'),at==='backup'?'Data':'Next');
  const before=f.events.length;assert.equal((await recoverPinnedRevision({...f.args,id})).resolved,true);assert.equal(f.events.slice(before).includes('replace'),false);assert.deepEqual(f.state.snapshot().pinnedUpdates,{});
 }finally{await f.close();}}
});
test('held pinned recovery reveals only verified private copies and refuses altered files or escaping paths',async()=>{
 const {pinnedRecoveryCopies}=require('../src/windows-drive-pinned-update');
 const f=await fixture();try{
  f.bridge.replacePinned=async()=>{await fs.writeFile(f.file,'Part');throw Error('Interrupted');};await assert.rejects(replacePinnedRevision(f.args));const id=Object.keys(f.state.snapshot().pinnedUpdates)[0],entry=f.state.snapshot().pinnedUpdates[id];
  const copies=await pinnedRecoveryCopies({id,state:f.state});assert.deepEqual(copies.map(p=>p.name),['downloaded','original']);assert.equal(await fs.readFile(copies[1].file,'utf8'),'Data');assert.equal(await fs.readFile(f.file,'utf8'),'Part');
  await fs.writeFile(entry.backup.file,'Fake');await assert.rejects(pinnedRecoveryCopies({id,state:f.state}),/could not be verified/);
  await fs.writeFile(entry.backup.file,'Data');await fs.unlink(entry.backup.file);await fs.symlink(f.file,entry.backup.file);await assert.rejects(pinnedRecoveryCopies({id,state:f.state}),/could not be verified/);
  await f.state.update(state=>{state.pinnedUpdates[id].staged.directory=f.root;});await assert.rejects(pinnedRecoveryCopies({id,state:f.state}),/Invalid pinned recovery directory/);
 }finally{await f.close();}
});
test('pinned confirmation failures identify the missing Windows proof and keep both recovery copies',async()=>{
 const failures=[
  [proof=>({...proof,hash:'0'.repeat(64)}),/complete local bytes differ/],
  [proof=>({...proof,size:3}),/complete local bytes differ/],
  [proof=>({...proof,placeholder:{...proof.placeholder,cloud:false}}),/no longer a cloud placeholder/],
  [proof=>({...proof,placeholder:{...proof.placeholder,inSync:false}}),/still marks the file as unsynced/],
  [proof=>({...proof,placeholder:{...proof.placeholder,pinState:0}}),/did not retain its offline pin/],
  [proof=>({...proof,placeholder:{...proof.placeholder,modifiedBytes:1}}),/still reports modified bytes/],
  [proof=>({...proof,placeholder:{...proof.placeholder,onDiskBytes:0}}),/did not confirm every byte is cached/],
  [proof=>({...proof,placeholder:{...proof.placeholder,identity:JSON.stringify({key:'another',etag:'new'})}}),/identifies a different revision/],
  [proof=>({...proof,placeholder:{...proof.placeholder,identity:'invalid'}}),/identity is invalid/]
 ];
 for(const [alter,error] of failures){const f=await fixture();try{
  const fingerprint=f.bridge.fingerprintPinned;f.bridge.fingerprintPinned=async(...args)=>alter(await fingerprint(...args));await assert.rejects(replacePinnedRevision(f.args),error);
  const entry=Object.values(f.state.snapshot().pinnedUpdates)[0];assert.equal(entry.phase,'installed');assert.equal(await fs.readFile(entry.backup.file,'utf8'),'Data');assert.equal(await fs.readFile(entry.staged.file,'utf8'),'Next');assert.equal(f.state.snapshot().materialized['pinned.txt'].etag,'"old"');assert.equal(f.events.at(-1),'unlock');
 }finally{await f.close();}}
});

test('explicit pinned finishing preserves current and original bytes with encrypted discovery after restart',async()=>{
 const {savedPinnedCopies}=require('../src/windows-drive-pinned-update'),f=await fixture();try{
  f.bridge.replacePinned=async()=>{await fs.writeFile(f.file,'Part');throw Error('Interrupted');};await assert.rejects(replacePinnedRevision(f.args));const id=Object.keys(f.state.snapshot().pinnedUpdates)[0],before=f.events.length;
  for(const finish of [undefined,false,'true'])assert.equal((await recoverPinnedRevision({...f.args,id,finish})).resolved,false);
  assert.equal(f.events.slice(before).some(event=>['current-backup','finish','ack'].includes(event)),false);
  assert.deepEqual(await recoverPinnedRevision({...f.args,id,finish:true}),{resolved:true,readOnlyCloudCheck:true,localCopiesPreserved:true});
  assert.equal(await fs.readFile(f.file,'utf8'),'Next');assert.equal(f.state.snapshot().materialized['pinned.txt'].etag,'"new"');assert.deepEqual(f.state.snapshot().pinnedUpdates,{});
  const reopened=new WindowsDriveState({directory:f.state.directory,safeStorage:f.state.crypto});await reopened.load();const files=await savedPinnedCopies({id,state:reopened});assert.deepEqual(files.map(file=>file.name),['original','local-1']);assert.equal(await fs.readFile(files[0].file,'utf8'),'Data');assert.equal(await fs.readFile(files[1].file,'utf8'),'Part');
  assert.deepEqual((await fs.readdir(path.dirname(files[0].file))).sort(),files.map(file=>path.basename(file.file)).sort());
 }finally{await f.close();}
});

test('explicit finishing saves empty, shrunk and grown current files at their actual size before replacement',async()=>{
 const {savedPinnedCopies}=require('../src/windows-drive-pinned-update');for(const partial of ['', 'P', 'Current local bytes longer than either recorded revision']){const f=await fixture();try{
  f.bridge.replacePinned=async()=>{await fs.writeFile(f.file,partial);throw Error('Interrupted resize');};await assert.rejects(replacePinnedRevision(f.args));const id=Object.keys(f.state.snapshot().pinnedUpdates)[0];assert.equal((await recoverPinnedRevision({...f.args,id,finish:true})).resolved,true);assert.equal(await fs.readFile(f.file,'utf8'),'Next');
  const saved=f.state.snapshot().savedPinnedCopies[id];assert.equal(saved.copies[1].size,Buffer.byteLength(partial));const files=await savedPinnedCopies({id,state:f.state});assert.equal(await fs.readFile(files[0].file,'utf8'),'Data');assert.equal(await fs.readFile(files[1].file,'utf8'),partial);
 }finally{await f.close();}}
});

test('a changed source before replacement never advertises or executes partial-overwrite finishing',async()=>{
 for(const phase of ['prepared','backedUp']){const f=await fixture();try{
  const capture=f.bridge.capturePinnedBackup;f.bridge.capturePinnedBackup=async(...args)=>{await capture(...args);throw Error('Lost capture');};await assert.rejects(replacePinnedRevision(f.args));const id=Object.keys(f.state.snapshot().pinnedUpdates)[0],entry=f.state.snapshot().pinnedUpdates[id];
  if(phase==='backedUp'){const {WindowsPinnedUpdateJournal}=require('../src/windows-drive-pinned-journal');await new WindowsPinnedUpdateJournal(f.state).recordBackup(id,{file:path.join(entry.staged.directory,'previous'),hash:crypto.createHash('sha256').update('Data').digest('hex'),size:4});}
  await fs.writeFile(f.file,'New local edit');const before=f.events.length;assert.deepEqual(await recoverPinnedRevision({...f.args,id,finish:true}),{resolved:false,reason:'pinned-source-changed-before-replacement'});assert.equal(await fs.readFile(f.file,'utf8'),'New local edit');assert.equal(f.events.slice(before).some(event=>['current-backup','finish','ack'].includes(event)),false);assert.equal(f.state.snapshot().pinnedUpdates[id].phase,phase);
 }finally{await f.close();}}
});

test('a changed cloud revision or altered staged copy refuses explicit finishing before any local write',async()=>{
 for(const fault of ['cloud','stage','identity']){const f=await fixture();try{
  f.bridge.replacePinned=async()=>{await fs.writeFile(f.file,'Part');throw Error('Interrupted');};await assert.rejects(replacePinnedRevision(f.args));const id=Object.keys(f.state.snapshot().pinnedUpdates)[0],entry=f.state.snapshot().pinnedUpdates[id],before=f.events.length;
  if(fault==='cloud')f.store.stat=async()=>({...f.object,etag:'"changed"'});else if(fault==='stage')await fs.writeFile(entry.staged.file,'Fake');else{const lock=f.bridge.lockPinnedRecovery;f.bridge.lockPinnedRecovery=async()=>({...await lock(),identity:JSON.stringify({key:'unrelated',etag:'"changed"'})});}
  if(fault==='identity')assert.deepEqual(await recoverPinnedRevision({...f.args,id,finish:true}),{resolved:false,reason:'local-identity-changed'});else await assert.rejects(recoverPinnedRevision({...f.args,id,finish:true}));
  assert.equal(await fs.readFile(f.file,'utf8'),'Part');assert.equal(await fs.readFile(entry.backup.file,'utf8'),'Data');assert.equal(f.events.slice(before).some(event=>['current-backup','finish','ack'].includes(event)),false);assert(f.state.snapshot().pinnedUpdates[id]);
 }finally{await f.close();}}
});

test('lost pinned finishing responses are recovered without repeating replacement and preserve saved copies',async()=>{
 for(const fault of ['finish','ack']){const f=await fixture();try{
  f.bridge.replacePinned=async()=>{await fs.writeFile(f.file,'Part');throw Error('Interrupted');};await assert.rejects(replacePinnedRevision(f.args));const id=Object.keys(f.state.snapshot().pinnedUpdates)[0],original=f.bridge[fault==='finish'?'finishPinned':'ackPinnedUpdate'];f.bridge[fault==='finish'?'finishPinned':'ackPinnedUpdate']=async(...args)=>{await original(...args);throw Error('Lost '+fault);};
  await assert.rejects(recoverPinnedRevision({...f.args,id,finish:true}),/Lost/);assert(f.state.snapshot().pinnedUpdates[id]);assert.equal(await fs.readFile(f.file,'utf8'),'Next');
  f.bridge[fault==='finish'?'finishPinned':'ackPinnedUpdate']=original;const before=f.events.length;assert.equal((await recoverPinnedRevision({...f.args,id})).resolved,true);assert.equal(f.events.slice(before).includes('finish'),false);assert.equal(f.events.slice(before).includes('current-backup'),false);
  const saved=f.state.snapshot().savedPinnedCopies[id];assert.equal(await fs.readFile(saved.copies[0].file,'utf8'),'Data');assert.equal(await fs.readFile(saved.copies[1].file,'utf8'),'Part');
 }finally{await f.close();}}
});

test('cancelling explicit finishing retains every captured local copy and holds incomplete results',async()=>{
 for(const at of ['capture','finish']){const f=await fixture(),controller=new AbortController();try{
  f.bridge.replacePinned=async()=>{await fs.writeFile(f.file,'Part');throw Error('Interrupted');};await assert.rejects(replacePinnedRevision(f.args));const id=Object.keys(f.state.snapshot().pinnedUpdates)[0],method=at==='capture'?'capturePinnedCurrent':'finishPinned',original=f.bridge[method];f.bridge[method]=async(...args)=>{const result=await original(...args);controller.abort();return result;};
  await assert.rejects(recoverPinnedRevision({...f.args,id,finish:true,signal:controller.signal}),/cancelled/);const entry=f.state.snapshot().pinnedUpdates[id];assert.equal(await fs.readFile(entry.preserved[0].file,'utf8'),'Part');assert.equal(await fs.readFile(entry.backup.file,'utf8'),'Data');assert.equal(await fs.readFile(f.file,'utf8'),at==='capture'?'Part':'Next');assert.equal(f.events.at(-1),'unlock');
  f.bridge[method]=original;assert.equal((await recoverPinnedRevision({...f.args,id,...(at==='capture'?{finish:true}:{})})).resolved,true);const saved=f.state.snapshot().savedPinnedCopies[id];assert.equal(saved.copies.length,at==='capture'?3:2);for(const proof of saved.copies.slice(1))assert.equal(await fs.readFile(proof.file,'utf8'),'Part');
 }finally{await f.close();}}
});

test('saved local recovery copies refuse altered or linked files and escaping archive records',async()=>{
 const {savedPinnedCopies}=require('../src/windows-drive-pinned-update'),f=await fixture();try{
  f.bridge.replacePinned=async()=>{await fs.writeFile(f.file,'Part');throw Error('Interrupted');};await assert.rejects(replacePinnedRevision(f.args));const id=Object.keys(f.state.snapshot().pinnedUpdates)[0];await recoverPinnedRevision({...f.args,id,finish:true});const saved=f.state.snapshot().savedPinnedCopies[id],copy=saved.copies[1];
  await fs.writeFile(copy.file,'Fake');await assert.rejects(savedPinnedCopies({id,state:f.state}),/could not be verified/);await fs.unlink(copy.file);await fs.symlink(f.file,copy.file);await assert.rejects(savedPinnedCopies({id,state:f.state}),/could not be verified/);
  await f.state.update(state=>{state.savedPinnedCopies[id].directory=f.root;});await assert.rejects(savedPinnedCopies({id,state:f.state}),/Invalid saved pinned directory/);
 }finally{await f.close();}
});

test('removing saved-copy history preserves files, active transfers and other history after encrypted reload',async()=>{
 const f=await fixture();try{
  f.bridge.replacePinned=async()=>{await fs.writeFile(f.file,'Part');throw Error('Interrupted');};await assert.rejects(replacePinnedRevision(f.args));const id=Object.keys(f.state.snapshot().pinnedUpdates)[0];await recoverPinnedRevision({...f.args,id,finish:true});const saved=f.state.snapshot().savedPinnedCopies[id],other=crypto.randomUUID();await f.state.update(state=>{state.savedPinnedCopies[other]=structuredClone(saved);});
  for(const invalid of ['__proto__',null,{},'not-an-id'])assert.throws(()=>f.state.forgetSavedPinnedCopies(invalid),/Invalid saved copy/);
  const materialized=f.state.snapshot().materialized;await f.state.forgetSavedPinnedCopies(id);await f.state.forgetSavedPinnedCopies(id);
  const reopened=new WindowsDriveState({directory:f.state.directory,safeStorage:f.state.crypto});await reopened.load();assert.equal(Object.hasOwn(reopened.snapshot().savedPinnedCopies,id),false);assert.deepEqual(reopened.snapshot().savedPinnedCopies[other],saved);assert.deepEqual(reopened.snapshot().materialized,materialized);assert.equal(await fs.readFile(saved.copies[0].file,'utf8'),'Data');assert.equal(await fs.readFile(saved.copies[1].file,'utf8'),'Part');assert.equal(await fs.readFile(f.file,'utf8'),'Next');
  await fs.unlink(saved.copies[1].file);await reopened.forgetSavedPinnedCopies(other);assert.deepEqual(reopened.snapshot().savedPinnedCopies,{});assert.equal(await fs.readFile(saved.copies[0].file,'utf8'),'Data','stale history removal must not delete the other saved file');
 }finally{await f.close();}
});

test('restored original with the same bytes as the downloaded revision can explicitly finish without replacing again',async()=>{
 const f=await fixture();try{
  f.store.read=async()=>Buffer.from('Data');f.bridge.replacePinned=async()=>{await fs.writeFile(f.file,'Part');throw Error('Interrupted');};await assert.rejects(replacePinnedRevision(f.args));const id=Object.keys(f.state.snapshot().pinnedUpdates)[0];await restorePinnedRevision({...f.args,id,restore:true});const before=f.events.length;assert.equal((await recoverPinnedRevision({...f.args,id,finish:true})).resolved,true);assert.equal(f.events.slice(before).includes('finish'),false);assert.equal(f.state.snapshot().materialized['pinned.txt'].etag,'"new"');assert.deepEqual(f.state.snapshot().pinnedUpdates,{});assert.equal(await fs.readFile(f.file,'utf8'),'Data');
 }finally{await f.close();}
});

test('a changed recorded binding refuses original acknowledgement retry before any native write',async()=>{
 const f=await fixture();try{
  f.bridge.replacePinned=async()=>{await fs.writeFile(f.file,'Part');throw Error('Interrupted');};await assert.rejects(replacePinnedRevision(f.args));const id=Object.keys(f.state.snapshot().pinnedUpdates)[0],finish=f.bridge.finishPinned;f.bridge.finishPinned=async(...args)=>{await finish(...args);throw Error('Lost restoration reply');};await assert.rejects(restorePinnedRevision({...f.args,id,restore:true}),/Lost restoration reply/);f.bridge.finishPinned=finish;
  await f.state.markMaterialized('pinned.txt',{...f.state.snapshot().materialized['pinned.txt'],etag:'"different"'});const before=f.events.length;await assert.rejects(restorePinnedRevision({...f.args,id,restore:true}),/restoration binding changed/);assert.equal(f.events.slice(before).some(event=>['finish','ack','current-backup'].includes(event)),false);assert.equal(await fs.readFile(f.file,'utf8'),'Data');assert.equal(f.state.snapshot().pinnedUpdates[id].phase,'restoring');assert.equal(await fs.readFile(f.state.snapshot().pinnedUpdates[id].preserved[0].file,'utf8'),'Part');
 }finally{await f.close();}
});
