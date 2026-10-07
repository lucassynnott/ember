const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const {waitForEncryptionKey}=require('../src/windows-drive-profile');
test('daemon startup waits for a complete persisted DPAPI profile key without changing it',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ember-profile-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const file=path.join(directory,'Local State');
 await fs.writeFile(file,'{"os_crypt":');const pending=waitForEncryptionKey(directory,{timeoutMs:500,intervalMs:5});
 const original=JSON.stringify({os_crypt:{encrypted_key:Buffer.concat([Buffer.from('DPAPI'),Buffer.alloc(32,7)]).toString('base64')},other:'preserved'});
 await new Promise(resolve=>setTimeout(resolve,20));await fs.writeFile(file,original);assert.equal(await pending,true);assert.equal(await fs.readFile(file,'utf8'),original);
});
test('missing or invalid profile keys prevent daemon launch without inventing a replacement',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ember-profile-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 await assert.rejects(waitForEncryptionKey(directory,{timeoutMs:20,intervalMs:5}),/not persisted/);await assert.rejects(fs.stat(path.join(directory,'Local State')),error=>error.code==='ENOENT');
 const original=JSON.stringify({os_crypt:{encrypted_key:'invalid'},other:'preserved'});await fs.writeFile(path.join(directory,'Local State'),original);await assert.rejects(waitForEncryptionKey(directory,{timeoutMs:20,intervalMs:5}),/not persisted/);assert.equal(await fs.readFile(path.join(directory,'Local State'),'utf8'),original);
});
