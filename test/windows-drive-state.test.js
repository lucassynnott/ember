const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const crypto=require('node:crypto');
const {WindowsDriveState}=require('../src/windows-drive-state');
// Authenticated cipher fixture exercises actual persisted encrypted bytes; real
// Windows safeStorage/DPAPI is verified separately in the Windows runtime gate.
function cipher(){const key=crypto.randomBytes(32);return {isEncryptionAvailable:()=>true,encryptString(text){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv);const bytes=Buffer.concat([c.update(text,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),bytes]);},decryptString(bytes){const c=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));c.setAuthTag(bytes.subarray(12,28));return Buffer.concat([c.update(bytes.subarray(28)),c.final()]).toString();}};}
test('Drive state encrypts credentials, survives restart and serializes concurrent mappings',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drive-state-')),safeStorage=cipher();
 try{const state=new WindowsDriveState({directory,safeStorage}),initial=await state.load();await state.configure({provider:'custom',keyID:'fixture-id',applicationKey:'never-plaintext-fixture',bucketName:'bucket',endpoint:'https://example.test'});
 await Promise.all([state.saveMappings({'folder/':{'file:notes.txt':'notes.txt'}}),state.markMaterialized('folder/notes.txt',{key:'folder/notes.txt',etag:'revision'})]);
 await state.markMaterialized('__proto__',{key:'__proto__',etag:'prototype-named-file'});
 const bytes=await fs.readFile(state.file);assert.equal(bytes.includes(Buffer.from('never-plaintext-fixture')),false);assert.equal(bytes.includes(Buffer.from('notes.txt')),false);
 const restored=await new WindowsDriveState({directory,safeStorage}).load();assert.equal(restored.identity,initial.identity);assert.equal(restored.config.applicationKey,'never-plaintext-fixture');assert.equal(restored.mappings['folder/']['file:notes.txt'],'notes.txt');assert.equal(restored.materialized['folder/notes.txt'].etag,'revision');assert.equal(Object.hasOwn(restored.materialized,'__proto__'),true);assert.equal(restored.materialized.__proto__.etag,'prototype-named-file');
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
