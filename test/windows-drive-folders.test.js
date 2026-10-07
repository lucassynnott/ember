const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const crypto=require('node:crypto');
const {WindowsDriveState}=require('../src/windows-drive-state');const {syncLocalFolder,recoverLocalFolder}=require('../src/windows-drive-folders');
function cipher(){const key=crypto.randomBytes(32);return {isEncryptionAvailable:()=>true,encryptString(text){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv),bytes=Buffer.concat([c.update(text),c.final()]);return Buffer.concat([iv,c.getAuthTag(),bytes]);},decryptString(bytes){const c=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));c.setAuthTag(bytes.subarray(12,28));return Buffer.concat([c.update(bytes.subarray(28)),c.final()]).toString();}};}
async function fixture(){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drive-folder-')),root=path.join(directory,'root'),local='Empty folder';await fs.mkdir(path.join(root,local),{recursive:true});const safeStorage=cipher(),state=new WindowsDriveState({directory:path.join(directory,'state'),safeStorage});await state.load();const key=await state.reserveLocalFolder(local),calls=[],remote=new Map();
 const bridge={inspect:async()=>({exists:true,cloud:false})},store={stat:async name=>remote.get(name)||null,putEmpty:async(name,signal,options)=>{assert.deepEqual(options,{ifNoneMatch:'*'});assert.equal(Object.keys(state.snapshot().folderUploads).length,1,'intent must be durable before cloud write');calls.push(name);remote.set(name,{name,size:0,etag:'created',fileID:null});return {ETag:'created'};}};
 return {directory,root,local,key,safeStorage,state,bridge,store,calls,remote};
}
test('empty-folder marker is conditionally uploaded after persisted reservation and survives state reload',async()=>{
 const f=await fixture();try{await syncLocalFolder(f);assert.deepEqual(f.calls,['Empty folder/.ghost-keep']);const restored=await new WindowsDriveState({directory:f.state.directory,safeStorage:f.safeStorage}).load();assert.equal(restored.materialized[f.local].remoteConfirmed,true);assert.deepEqual(restored.folderUploads,{});assert.equal((await fs.readFile(f.state.file)).includes(Buffer.from('Empty folder')),false);}finally{await fs.rm(f.directory,{recursive:true,force:true});}
});
test('uncertain marker upload cannot replay; reopened intent resolves with a read-only check',async()=>{
 const f=await fixture();try{
  const put=f.store.putEmpty;f.store.putEmpty=async(...args)=>{await put(...args);throw new Error('Connection dropped after write');};await assert.rejects(syncLocalFolder(f),/Connection dropped/);
  await assert.rejects(syncLocalFolder(f),/unfinished folder upload/);assert.equal(f.calls.length,1);
  const state=new WindowsDriveState({directory:f.state.directory,safeStorage:f.safeStorage});await state.load();const id=Object.keys(state.snapshot().folderUploads)[0];assert.deepEqual(await recoverLocalFolder({...f,state,id}),{resolved:true,readOnlyCloudCheck:true});assert.equal(f.calls.length,1);assert.equal(state.snapshot().materialized[f.local].remoteConfirmed,true);
 }finally{await fs.rm(f.directory,{recursive:true,force:true});}
});
test('unexpected marker contents and missing outcomes retain the journal without another write',async()=>{
 const f=await fixture();try{
  const marker=f.key+'.ghost-keep';f.remote.set(marker,{name:marker,size:7,etag:'existing'});await assert.rejects(syncLocalFolder(f),/unexpected content/);assert.equal(f.calls.length,0);
  const id=Object.keys(f.state.snapshot().folderUploads)[0];f.remote.delete(marker);assert.equal((await recoverLocalFolder({...f,id})).resolved,false);assert.equal(Object.keys(f.state.snapshot().folderUploads).length,1);assert.equal(f.calls.length,0);
 }finally{await fs.rm(f.directory,{recursive:true,force:true});}
});
test('an existing valid marker confirms the folder without overwriting cloud data',async()=>{
 const f=await fixture();try{const marker=f.key+'.ghost-keep';f.remote.set(marker,{name:marker,size:0,etag:'existing'});await syncLocalFolder(f);assert.equal(f.calls.length,0);assert.equal(f.state.snapshot().materialized[f.local].markerRevision.etag,'existing');}finally{await fs.rm(f.directory,{recursive:true,force:true});}
});
