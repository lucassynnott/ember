const test=require('node:test');const assert=require('node:assert/strict');
const {cloudFixture}=require('../scripts/windows-drive-cloud-fixture');const {WindowsDriveStore}=require('../src/windows-drive-store');
test('daemon cloud fixture executes signed conditional copies and a lost delete acknowledgement without retry',async()=>{
 const cloud=await cloudFixture({'Notes/Café.txt':Buffer.from('Source bytes'),'occupied.txt':Buffer.from('Keep destination')});const store=await WindowsDriveStore.create(cloud.config);
 try{
  const source=await store.stat('Notes/Café.txt');const copied=await store.copy(source,'renamed.txt');assert.equal(copied.CopyObjectResult.ETag,source.etag);assert.equal(cloud.objects.get('renamed.txt').data.toString(),'Source bytes');
  const request=cloud.requests.find(request=>request.method==='PUT');assert.equal(request.absent,'*');assert.equal(request.copyCondition,source.etag);
  await assert.rejects(store.copy(source,'occupied.txt'),error=>error.$metadata?.httpStatusCode===412);assert.equal(cloud.objects.get('occupied.txt').data.toString(),'Keep destination');
  cloud.loseNextDeleteAcknowledgement();await assert.rejects(store.deleteVersion(source.name,'',{etag:source.etag}),error=>error.$metadata?.httpStatusCode===503);assert.equal(cloud.objects.has(source.name),false);assert.equal(cloud.requests.filter(request=>request.method==='DELETE').length,1);assert.equal((await store.stat('renamed.txt')).etag,source.etag);
 }finally{store.close();await cloud.close();}
});
test('lost signed copy acknowledgement leaves both exact objects with only one attempted copy',async()=>{
 const cloud=await cloudFixture({'original.txt':Buffer.from('Original bytes')}),store=await WindowsDriveStore.create(cloud.config);
 try{const source=await store.stat('original.txt');cloud.loseNextCopyAcknowledgement();await assert.rejects(store.copy(source,'destination.txt'),error=>error.$metadata?.httpStatusCode===503);assert.deepEqual(cloud.objects.get('destination.txt').data,cloud.objects.get('original.txt').data);assert.equal(cloud.requests.filter(r=>r.method==='PUT').length,1);assert.equal(cloud.requests.filter(r=>r.method==='DELETE').length,0);await store.deleteVersion(source.name,'',{etag:source.etag});assert.equal(cloud.objects.has(source.name),false);assert.equal(cloud.requests.find(r=>r.method==='DELETE').condition,source.etag);}finally{store.close();await cloud.close();}
});
