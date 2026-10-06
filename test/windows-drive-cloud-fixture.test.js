const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {cloudFixture}=require('../scripts/windows-drive-cloud-fixture');const {WindowsDriveStore}=require('../src/windows-drive-store');
test('configured-daemon cloud fixture accepts production signed range reads and conditional uploads',async()=>{
 const cloud=await cloudFixture({'remote.txt':Buffer.from('Complete cloud bytes')}),store=await WindowsDriveStore.create(cloud.config),directory=await fs.mkdtemp(path.join(os.tmpdir(),'ember-cloud-fixture-'));
 try{
  const listed=await store.listAll();assert.equal(listed.length,1);assert.equal(listed[0].size,20);
  assert.deepEqual(await store.read('remote.txt',9,5,null,undefined,listed[0].etag),Buffer.from('cloud'));
  const file=path.join(directory,'local');await fs.writeFile(file,'New background upload');await store.upload(file,'new.txt',{ifNoneMatch:'*'});
  assert.equal(cloud.objects.get('new.txt').data.toString(),'New background upload');
  const revision=await store.stat('new.txt');await assert.rejects(store.upload(file,'new.txt',{ifNoneMatch:'*'}),error=>error.$metadata?.httpStatusCode===412);
  await assert.rejects(store.deleteVersion('new.txt','',{etag:'"wrong"'}),error=>error.$metadata?.httpStatusCode===412);assert(cloud.objects.has('new.txt'));
  await store.deleteVersion('new.txt','',{etag:revision.etag});assert(!cloud.objects.has('new.txt'));assert.equal(cloud.writes,1);
 }finally{store.close();await cloud.close();await fs.rm(directory,{recursive:true,force:true});}
});
test('configured-daemon cloud fixture rejects unsigned requests without exposing object bytes',async()=>{
 const cloud=await cloudFixture({'private.txt':Buffer.from('Fixture bytes')});
 try{const response=await fetch(cloud.config.endpoint+'/fixture-bucket/private.txt');assert.equal(response.status,403);assert.equal(await response.text(),'');}
 finally{await cloud.close();}
});
