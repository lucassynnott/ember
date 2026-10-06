const test=require('node:test');const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
const {WindowsCloudFiles}=require('../src/windows-cloud-files');
function fixture(store){
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};
  const messages=[];let input='';child.stdin.on('data',chunk=>{input+=chunk;let index;while((index=input.indexOf('\n'))>=0){messages.push(JSON.parse(input.slice(0,index)));input=input.slice(index+1);}});
  const send=message=>child.stdout.write(JSON.stringify(message)+'\n');
  const bridge=new WindowsCloudFiles({store,helper:'fixture',spawnImpl:()=>child,timeoutMs:1000});send({event:'ready',protocol:1});
  return {bridge,child,messages,send};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('Cloud Files bridge routes immutable ranges and rejects missing revisions',async()=>{
  const reads=[];const f=fixture({read:async(...args)=>{reads.push(args);return Buffer.from('four');}});
  try{
    f.send({event:'fetchData',id:'fetch-one',identity:JSON.stringify({key:'Notes/Café.txt',etag:'"v1"'}),offset:4096,length:4});await tick();
    assert.equal(reads.length,1);assert.equal(reads[0][0],'Notes/Café.txt');assert.equal(reads[0][1],4096);assert.equal(reads[0][5],'"v1"');assert.equal(Buffer.from(f.messages[0].data,'base64').toString(),'four');
    f.send({event:'fetchData',id:'fetch-two',identity:JSON.stringify({key:'unversioned'}),offset:0,length:4});await tick();assert.equal(reads.length,1);assert.equal(f.messages[1].ok,false);
  }finally{f.bridge.close();}
});
test('helper shutdown rejects outstanding writes without replay and aborts hydration',async()=>{
  let signal;const f=fixture({read:async(...args)=>{signal=args[4];return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))));}});
  const command=f.bridge.register('C:\\Ember Drive','fixture-root');await tick();
  f.send({event:'fetchData',id:'fetch-one',identity:JSON.stringify({key:'file',fileID:'revision'}),offset:0,length:4});await tick();
  const rejection=assert.rejects(command,/helper stopped/);f.child.emit('exit',1);await rejection;await tick();
  assert.equal(signal.aborted,true);assert.equal(f.messages.length,1);assert.equal(f.messages[0].command,'register');
});
test('short cloud reads fail hydration instead of supplying corrupt file bytes',async()=>{
  const f=fixture({read:async()=>Buffer.from('x')});
  try{f.send({event:'fetchData',id:'fetch-one',identity:JSON.stringify({key:'file',etag:'revision'}),offset:0,length:4});await tick();assert.equal(f.messages[0].ok,false);assert.equal(f.messages[0].data,undefined);}
  finally{f.bridge.close();}
});
test('pin waits for completed hydration and never retries a failed offline download',async()=>{
  const f=fixture({read:async()=>Buffer.alloc(0)});
  try{
    const pin=f.bridge.pin('folder/file.txt');await tick();assert.equal(f.messages[0].command,'pin');
    f.send({id:f.messages[0].id,ok:true});await tick();assert.equal(f.messages[1].command,'hydrate');
    const rejected=assert.rejects(pin,/download failed/);f.send({id:f.messages[1].id,ok:false,error:'download failed'});await rejected;await tick();assert.equal(f.messages.length,2);
  }finally{f.bridge.close();}
});
test('Windows fetch cancellation aborts the matching storage read and sends no bytes',async()=>{
  let signal;const f=fixture({read:async(...args)=>{signal=args[4];return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled'))));}});
  try{f.send({event:'fetchData',id:'fetch-cancel',identity:JSON.stringify({key:'file',etag:'revision'}),offset:0,length:4});await tick();f.send({event:'cancelFetchData',id:'fetch-cancel'});await tick();assert.equal(signal.aborted,true);assert.equal(f.messages[0].ok,false);assert.equal(f.messages[0].data,undefined);}
  finally{f.bridge.close();}
});
