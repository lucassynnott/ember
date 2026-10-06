const {test}=require('node:test');const assert=require('node:assert/strict');const {WindowsDriveCache}=require('../src/windows-drive-cache');
function fixture(limit=5){
 const metadata={},materialized={},calls=[],snapshot={materialized,uploads:{},cacheLimitGB:limit};
 const state={snapshot:()=>structuredClone(snapshot)};
 const bridge={inspect:async local=>({...metadata[local]}),dehydrate:async local=>{calls.push(local);metadata[local].onDiskBytes=0;}};
 function file(local,size,extra={}){const identity={key:'remote/'+local,etag:'etag',fileID:null};materialized[local]=identity;metadata[local]={exists:true,cloud:true,identity:JSON.stringify(identity),inSync:true,modifiedBytes:0,pinState:0,onDiskBytes:size,...extra};}
 return {cache:new WindowsDriveCache({state,bridge}),snapshot,metadata,calls,file,bridge};
}
test('cache accounting does not hydrate and separates pins and protected edits',async()=>{
 const f=fixture();f.file('clean',10);f.file('pin',20,{pinState:1});f.file('dirty',30,{inSync:false,modifiedBytes:30});f.file('pending',40);f.snapshot.uploads.id={local:'PENDING',key:'remote/pending'};
 const result=await f.cache.inspect();assert.equal(result.bytes,80);assert.equal(result.pinnedBytes,20);assert.equal(result.protectedBytes,70);assert.deepEqual(f.calls,[]);
 const cleared=await f.cache.enforce({clear:true});assert.deepEqual(f.calls,['clean']);assert.equal(cleared.bytes,70);assert.equal(cleared.pinnedBytes,20);assert.equal(cleared.overLimit,true);
});
test('cache limit evicts the largest eligible file and proves remaining cached bytes',async()=>{
 const f=fixture();f.file('large',4*1024**3);f.file('small',2*1024**3);const result=await f.cache.enforce();assert.deepEqual(f.calls,['large']);assert.equal(result.bytes,2*1024**3);assert.equal(result.overLimit,false);
});
test('replacement files, foreign revisions and unknown pin policies are preserved',async()=>{
 const f=fixture();f.file('replacement',100,{cloud:false});f.file('foreign',100,{identity:JSON.stringify({key:'other',etag:'etag',fileID:null})});f.file('inherited',100,{pinState:4});
 const result=await f.cache.enforce({clear:true});assert.deepEqual(f.calls,[]);assert.equal(result.errors.length,2);assert.equal(result.protectedBytes,100);
});
test('a pin or edit acquired during eviction is held after native refusal',async()=>{
 const f=fixture();f.file('read-race',50);f.bridge.dehydrate=async()=>{throw new Error('Pinned files cannot be removed from the cache.');};const result=await f.cache.enforce({clear:true});assert.equal(result.bytes,50);assert.equal(result.evicted.length,0);assert.match(result.held[0].reason,/Pinned/);
});
test('an upload that starts after inspection is never selected for eviction',async()=>{
 const f=fixture();f.file('upload-race',50);const inspect=f.bridge.inspect;let first=true;
 f.bridge.inspect=async local=>{const result=await inspect(local);if(first){first=false;f.snapshot.uploads.id={local,key:'remote/'+local};}return result;};
 const result=await f.cache.enforce({clear:true});assert.deepEqual(f.calls,[]);assert.equal(result.held[0].reason,'unfinished-upload');
});
