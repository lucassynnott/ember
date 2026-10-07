const test=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const {revisionFingerprint}=require('../src/windows-drive-content-proof');
function fixture(size){const data=Buffer.alloc(size,71),object={name:'Unicode/Café.txt',etag:'"revision"',fileID:'version',size};const calls=[];return {data,object,calls,store:{async read(key,offset,length,version,signal,etag){calls.push({key,offset,length,version,etag});return data.subarray(offset,offset+length);},async stat(){return object;}}};}
test('content proof bounds revision-specific ranges and handles an empty file',async()=>{
 for(const size of [0,8*1024*1024+123]){const f=fixture(size);assert.equal(await revisionFingerprint(f.store,f.object),crypto.createHash('sha256').update(f.data).digest('hex'));assert.equal(f.calls.length,size?2:0);for(const c of f.calls){assert.equal(c.key,f.object.name);assert.equal(c.etag,f.object.etag);assert.equal(c.version,f.object.fileID);assert.ok(c.length<=8*1024*1024);}}
});
test('content proof refuses incomplete bytes or a replaced cloud revision',async()=>{
 for(const fault of ['short','missing','etag','version','size']){const f=fixture(4);if(fault==='short')f.store.read=async()=>Buffer.alloc(3);else f.store.stat=async()=>fault==='missing'?null:{...f.object,...({etag:{etag:'new'},version:{fileID:'new'},size:{size:5}}[fault])};await assert.rejects(revisionFingerprint(f.store,f.object),fault==='short'?/incomplete/:/changed/);}
});
test('cancellation stops verification before reading or accepting a proof',async()=>{
 const f=fixture(4),controller=new AbortController();controller.abort();await assert.rejects(revisionFingerprint(f.store,f.object,controller.signal),/cancelled/);assert.equal(f.calls.length,0);
 const g=fixture(4),during=new AbortController(),read=g.store.read;g.store.read=async(...args)=>{const bytes=await read(...args);during.abort();return bytes;};await assert.rejects(revisionFingerprint(g.store,g.object,during.signal),/cancelled/);
});
