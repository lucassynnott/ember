const test=require('node:test');const assert=require('node:assert/strict');const {uploadLocalFile}=require('../src/windows-drive-upload');
function fixture({cloud=true}={}){
 const calls=[];
 const bridge={lockUpload:async()=>({token:'lock',cloud,identity:cloud?JSON.stringify({key:'remote/file',etag:'old'}):null,size:4,modified:123,localPath:'local-file'}),ackUpload:async()=>calls.push('ack'),unlockUpload:async()=>calls.push('unlock')};
 const store={upload:async(file,key,options)=>{calls.push({file,key,options});return {ETag:'new',VersionId:'new-version'};},stat:async()=>({name:'remote/file',size:4,etag:'new',fileID:'new-version'})};
 const state={beginUpload:async()=>{calls.push('prepare');return 'journal';},setUploadPhase:async(id,phase)=>calls.push(phase),completeUpload:async()=>calls.push('state')};return {bridge,store,state,calls,local:'file',key:'remote/file',fingerprint:async()=>'a'.repeat(64)};
}
test('locked upload confirms the remote revision before acknowledging local sync',async()=>{
 const f=fixture();await uploadLocalFile(f);assert.equal(f.calls[2].options.ifMatch,'old');assert.deepEqual(f.calls.map(call=>typeof call==='string'?call:'write'),['prepare','sending','write','uploaded','confirmed','ack','state','unlock']);
 const fresh=fixture({cloud:false});await uploadLocalFile(fresh);assert.equal(fresh.calls[2].options.ifNoneMatch,'*');
});
test('uncertain upload is not retried or acknowledged and releases the local lock',async()=>{
 const f=fixture();let writes=0;f.store.upload=async()=>{writes++;throw new Error('connection lost after write');};
 await assert.rejects(uploadLocalFile(f),/connection lost/);assert.equal(writes,1);assert.deepEqual(f.calls,['prepare','sending','unlock']);
});
test('a remotely replaced upload preserves local dirty state and never marks it synced',async()=>{
 const f=fixture();f.store.stat=async()=>({size:4,etag:'other-writer',fileID:'different'});
 await assert.rejects(uploadLocalFile(f),/changed after upload/);assert.deepEqual(f.calls.map(call=>typeof call==='string'?call:'write'),['prepare','sending','write','uploaded','unlock']);
});
test('a mismatched local identity cannot upload to another remote key',async()=>{
 const f=fixture();f.key='other-key';await assert.rejects(uploadLocalFile(f),/another remote object/);assert.deepEqual(f.calls,['unlock']);
});
test('tracked ordinary-file replacements use the recorded cloud revision instead of overwriting blindly',async()=>{
 const f=fixture({cloud:false});f.state.snapshot=()=>({materialized:{file:{key:'remote/file',etag:'tracked-revision'}}});await uploadLocalFile(f);assert.equal(f.calls[2].options.ifMatch,'tracked-revision');assert.equal(f.calls[2].options.ifNoneMatch,undefined);
});
