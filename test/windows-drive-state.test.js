const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const crypto=require('node:crypto');
const {WindowsDriveState}=require('../src/windows-drive-state');
// Authenticated cipher fixture exercises actual persisted encrypted bytes; real
// Windows safeStorage/DPAPI is verified separately in the Windows runtime gate.
function cipher(){const key=crypto.randomBytes(32);return {isEncryptionAvailable:()=>true,encryptString(text){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);const bytes=Buffer.concat([c.update(text,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),bytes]);},decryptString(bytes){const c=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));c.setAuthTag(bytes.subarray(12,28));return Buffer.concat([c.update(bytes.subarray(28)),c.final()]).toString();}};}
test('Drive state encrypts credentials, survives restart and serializes concurrent mappings',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drive-state-')),safeStorage=cipher();
 try{const state=new WindowsDriveState({directory,safeStorage}),initial=await state.load();await state.configure({provider:'custom',keyID:'fixture-id',applicationKey:'never-plaintext-fixture',bucketName:'bucket',endpoint:'https://example.test'});
 await Promise.all([state.saveMappings({'folder/':{'file:notes.txt':'notes.txt'}}),state.markMaterialized('folder/notes.txt',{key:'folder/notes.txt',etag:'revision'})]);
 await state.setCacheLimit(50);await assert.rejects(state.setCacheLimit(0),/Invalid Drive cache limit/);
 await state.markMaterialized('__proto__',{key:'__proto__',etag:'prototype-named-file'});
 const bytes=await fs.readFile(state.file);assert.equal(bytes.includes(Buffer.from('never-plaintext-fixture')),false);assert.equal(bytes.includes(Buffer.from('notes.txt')),false);
 const restored=await new WindowsDriveState({directory,safeStorage}).load();assert.equal(restored.cacheLimitGB,50);assert.equal(restored.identity,initial.identity);assert.equal(restored.config.applicationKey,'never-plaintext-fixture');assert.equal(restored.mappings['folder/']['file:notes.txt'],'notes.txt');assert.equal(restored.materialized['folder/notes.txt'].etag,'revision');assert.equal(Object.hasOwn(restored.materialized,'__proto__'),true);assert.equal(restored.materialized.__proto__.etag,'prototype-named-file');
 assert.deepEqual((await fs.readdir(directory)),['state.dpapi']);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('unavailable encryption and corrupt existing state fail without overwriting files',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drive-state-fail-'));
 try{const bytes=Buffer.from('unreadable existing ciphertext');await fs.writeFile(path.join(directory,'state.dpapi'),bytes);
 await assert.rejects(new WindowsDriveState({directory,safeStorage:{isEncryptionAvailable:()=>false}}).load(),/encryption is unavailable/);
 await assert.rejects(new WindowsDriveState({directory,safeStorage:cipher()}).load(),/existing state was preserved/);assert.deepEqual(await fs.readFile(path.join(directory,'state.dpapi')),bytes);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('encrypted upload journal survives interruption and blocks replay until completion is proven',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drive-journal-')),safeStorage=cipher();
 try{
   const state=new WindowsDriveState({directory,safeStorage});await state.load();
   const id=await state.beginUpload({local:'Folder/file.txt',key:'remote/file',size:4,modified:123,hash:'a'.repeat(64),previous:{etag:'old'}});
   await state.setUploadPhase(id,'sending');await state.setUploadPhase(id,'uploaded',{uploaded:{etag:'new',fileID:'version'}});
   const restored=new WindowsDriveState({directory,safeStorage});await restored.load();assert.equal(restored.snapshot().uploads[id].uploaded.etag,'new');
   await assert.rejects(restored.beginUpload({local:'folder/FILE.txt',key:'remote/file',size:4,modified:123,hash:'a'.repeat(64)}),/unfinished upload/);
   await assert.rejects(restored.completeUpload(id,'Folder/file.txt',{key:'remote/file',etag:'new'}),/does not match/);
   await restored.setUploadPhase(id,'confirmed',{confirmed:{key:'remote/file',etag:'new',fileID:'version'}});
   await restored.completeUpload(id,'Folder/file.txt',{key:'remote/file',etag:'new',fileID:'version'});
   const final=await new WindowsDriveState({directory,safeStorage}).load();assert.deepEqual(final.uploads,{});assert.equal(final.materialized['Folder/file.txt'].etag,'new');
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('new local paths preserve literal names and map through encoded cloud parent folders',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drive-local-names-')),safeStorage=cipher();
 try{const state=new WindowsDriveState({directory,safeStorage});await state.load();await state.saveMappings({'':{'folder:Cloud:notes':'Cloud~003anotes'}});await state.markMaterialized('Cloud~003anotes',{key:'Cloud:notes/',fileID:null,etag:null});
 assert.equal(await state.reserveLocalFile('Cloud~003anotes/New folder/literal~file.txt'),'Cloud:notes/New folder/literal~file.txt');
 const saved=await new WindowsDriveState({directory,safeStorage}).load();assert.equal(saved.mappings['Cloud:notes/New folder/']['file:literal~file.txt'],'literal~file.txt');assert.equal(saved.materialized['Cloud~003anotes/New folder'].key,'Cloud:notes/New folder/');
 await assert.rejects(state.reserveLocalFile('../escape'),/Invalid local/);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('forget removes storage credentials but preserves file bindings and prevents cross-account replacement',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drive-forget-')),safeStorage=cipher();
 try{
  const state=new WindowsDriveState({directory,safeStorage});await state.load();const config={provider:'custom',keyID:'key',applicationKey:'secret-to-forget',bucketName:'original',endpoint:'https://example.test'};await state.configure(config);await state.markMaterialized('file.txt',{key:'file.txt',etag:'original'});const original=state.snapshot();
  const pending=await state.beginUpload({local:'file.txt',key:'file.txt',size:1,modified:1,hash:'a'.repeat(64)});await state.forget();
  const reopened=new WindowsDriveState({directory,safeStorage});await reopened.load();const forgotten=reopened.snapshot();assert.equal(forgotten.config,null);assert.equal(forgotten.identity,original.identity);assert.equal(forgotten.materialized['file.txt'].etag,'original');assert.equal(forgotten.uploads[pending].key,'file.txt');assert(!safeStorage.decryptString(await fs.readFile(state.file)).includes('secret-to-forget'));
  await assert.rejects(reopened.configure({...config,bucketName:'other-account'}),/separate Drive root/);assert.equal(reopened.snapshot().config,null);await reopened.configure({...config,applicationKey:'new-secret'});assert.equal(reopened.snapshot().config.applicationKey,'new-secret');
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
