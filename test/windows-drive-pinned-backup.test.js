const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');const {capturePinnedRevision}=require('../src/windows-drive-pinned-backup');
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'ember-pinned-backup-')),driveRoot=path.join(root,'Drive'),directory=path.join(root,'staging');await fs.mkdir(driveRoot);await fs.mkdir(directory);const bytes=Buffer.alloc(8*1024*1024+123,51),localPath=path.join(driveRoot,'pinned.txt');await fs.writeFile(localPath,bytes);const lock={token:'held-native-lock',cloud:true,inSync:true,modifiedBytes:0,pinState:1,size:bytes.length,localPath};return {root,driveRoot,directory,bytes,lock,async close(){await fs.rm(root,{recursive:true,force:true});}};}
test('offline backup saves complete hashed bytes without changing the pinned source',async()=>{
 const f=await fixture();try{const backup=await capturePinnedRevision(f);assert.deepEqual(await fs.readFile(backup.file),f.bytes);assert.equal(backup.hash,crypto.createHash('sha256').update(f.bytes).digest('hex'));assert.equal(backup.size,f.bytes.length);assert.deepEqual(await fs.readFile(f.lock.localPath),f.bytes);}finally{await f.close();}
});
test('dirty, unpinned or unlocked sources cannot create an offline replacement backup',async()=>{
 const f=await fixture();try{for(const changed of [{token:null},{cloud:false},{inSync:false},{modifiedBytes:1},{pinState:0}])await assert.rejects(capturePinnedRevision({...f,lock:{...f.lock,...changed}}),/locked, clean pinned/);assert.deepEqual(await fs.readdir(f.directory),[]);}finally{await f.close();}
});
test('short or oversized sources remove only their incomplete backup, preserving offline bytes',async()=>{
 const f=await fixture();try{for(const delta of [-1,1]){await assert.rejects(capturePinnedRevision({...f,lock:{...f.lock,size:f.lock.size+delta}}),/source changed|incomplete/);assert.deepEqual(await fs.readdir(f.directory),[]);}assert.deepEqual(await fs.readFile(f.lock.localPath),f.bytes);}finally{await f.close();}
});
test('existing recovery backup and directories in the Drive are preserved',async()=>{
 const f=await fixture();try{const previous=path.join(f.directory,'previous');await fs.writeFile(previous,'Previous recovery evidence');await assert.rejects(capturePinnedRevision(f),error=>error.code==='EEXIST');assert.equal(await fs.readFile(previous,'utf8'),'Previous recovery evidence');await assert.rejects(capturePinnedRevision({...f,directory:f.driveRoot}),/outside/);assert.deepEqual(await fs.readdir(f.driveRoot),['pinned.txt']);}finally{await f.close();}
});
test('cancelled backup leaves its offline source untouched',async()=>{
 const f=await fixture(),controller=new AbortController();try{controller.abort();await assert.rejects(capturePinnedRevision({...f,signal:controller.signal}),/cancelled/);assert.deepEqual(await fs.readdir(f.directory),[]);assert.deepEqual(await fs.readFile(f.lock.localPath),f.bytes);}finally{await f.close();}
});
