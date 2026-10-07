const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const crypto=require('node:crypto');const {WindowsDriveState}=require('../src/windows-drive-state');const {replacePinnedRevision,recoverPinnedRevision}=require('../src/windows-drive-pinned-update');
async function fixture(){
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'ember-pinned-coordinator-')),root=path.join(base,'Drive'),file=path.join(root,'pinned.txt');await fs.mkdir(root);await fs.writeFile(file,'Data');const secret=crypto.randomBytes(32);
 const safeStorage={isEncryptionAvailable:()=>true,encryptString(text){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',secret,iv),bytes=Buffer.concat([c.update(text),c.final()]);return Buffer.concat([iv,c.getAuthTag(),bytes]);},decryptString(bytes){const c=crypto.createDecipheriv('aes-256-gcm',secret,bytes.subarray(0,12));c.setAuthTag(bytes.subarray(12,28));return Buffer.concat([c.update(bytes.subarray(28)),c.final()]).toString();}};
 const state=new WindowsDriveState({directory:path.join(base,'profile'),safeStorage});await state.load();const previous={key:'remote/pinned.txt',etag:'"old"',fileID:'old-version',size:4,modified:1};await state.markMaterialized('pinned.txt',previous);
 const object={name:previous.key,etag:'"new"',fileID:'new-version',size:4,modified:2},expectedIdentity=JSON.stringify({key:previous.key,fileID:previous.fileID,etag:previous.etag}),events=[];let info={cloud:true,inSync:true,pinState:1,modifiedBytes:0,onDiskBytes:4,identity:expectedIdentity};
 const phase=()=>Object.values(state.snapshot().pinnedUpdates)[0]?.phase;
 const lock=async()=>({token:'held',size:(await fs.stat(file)).size,localPath:file,modified:1,...info});
 const bridge={async lockPinnedUpdate(){events.push('lock');return lock();},async lockPinnedRecovery(){events.push('recover-lock');return lock();},async unlockUpload(){events.push('unlock');},async capturePinnedBackup(token,args){assert.equal(phase(),'prepared');events.push('backup');const bytes=await fs.readFile(file),handle=await fs.open(args.backup,'wx');try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}return {file:args.backup,size:bytes.length,hash:crypto.createHash('sha256').update(bytes).digest('hex')};},async replacePinned(token,args){assert.equal(phase(),'replacing');events.push('replace');const bytes=await fs.readFile(args.source);await fs.writeFile(file,bytes);info={...info,inSync:false};return {hash:args.hash,size:bytes.length};},async ackPinnedUpdate(){assert.ok(['installed','replacing'].includes(phase()));events.push('ack');info={cloud:true,inSync:true,pinState:1,modifiedBytes:0,onDiskBytes:4,identity:JSON.stringify({key:object.name,fileID:object.fileID,etag:object.etag})};},async fingerprintPinned(){events.push('fingerprint');const bytes=await fs.readFile(file);return {hash:crypto.createHash('sha256').update(bytes).digest('hex'),size:bytes.length,placeholder:info};}};
 const store={async read(){return Buffer.from('Next');},async stat(){return object;}};return {base,root,file,state,object,events,bridge,store,args:{local:'pinned.txt',object,root,bridge,store,state},async close(){await fs.rm(base,{recursive:true,force:true});}};
}
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
