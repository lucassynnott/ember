const test=require('node:test');const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
const {WindowsCloudFiles}=require('../src/windows-cloud-files');
function fixture(store,options={}){
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};
  const messages=[];let input='';child.stdin.on('data',chunk=>{input+=chunk;let index;while((index=input.indexOf('\n'))>=0){messages.push(JSON.parse(input.slice(0,index)));input=input.slice(index+1);}});
  const send=message=>child.stdout.write(JSON.stringify(message)+'\n');
  const bridge=new WindowsCloudFiles({store,helper:'fixture',spawnImpl:()=>child,timeoutMs:1000,...options});send({event:'ready',protocol:1});
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
test('backup progress keeps the copy pending and cancellation sends control without replaying the copy',async()=>{
 const f=fixture({}),controller=new AbortController(),progress=[];f.bridge.on('backupProgress',value=>progress.push(value));
 try{
  const copy=f.bridge.copyBackup('file','staged',{backupId:'backup',hash:'a'.repeat(64),size:4,signal:controller.signal});await tick();const request=f.messages[0];assert.equal(request.command,'copyBackup');let resolved=false;copy.then(()=>{resolved=true;},()=>{});
  f.send({id:request.id,event:'backupProgress',bytes:2,total:4});await tick();assert.equal(resolved,false);assert.equal(progress[0].bytes,2);
  controller.abort();await tick();assert.equal(f.messages[1].command,'cancelBackup');assert.equal(f.messages[1].backupId,'backup');f.send({id:f.messages[1].id,ok:true});const rejection=assert.rejects(copy,/cancelled/);f.send({id:request.id,ok:false,error:'copy cancelled'});await rejection;assert.equal(f.messages.filter(message=>message.command==='copyBackup').length,1);
 }finally{f.bridge.close();}
});
test('pinned replacement progress renews its command and cancellation never replays the overwrite',async()=>{
 const f=fixture({}),controller=new AbortController(),progress=[];f.bridge.on('pinnedProgress',value=>progress.push(value));
 try{const copying=f.bridge.replacePinned('held',{updateId:'update',source:'new-stage',backup:'old-stage',expectedIdentity:'old-identity',hash:'a'.repeat(64),size:4,previousHash:'b'.repeat(64),previousSize:4,signal:controller.signal});await tick();const request=f.messages[0];assert.equal(request.command,'replacePinned');assert.equal(request.backup,'old-stage');f.send({id:request.id,event:'pinnedProgress',stage:'replace',bytes:2,total:4});await tick();assert.deepEqual(progress,[{stage:'replace',bytes:2,total:4}]);controller.abort();await tick();assert.equal(f.messages[1].command,'cancelPinned');assert.equal(f.messages[1].updateId,'update');f.send({id:f.messages[1].id,ok:true});const rejected=assert.rejects(copying,/cancelled/);f.send({id:request.id,ok:false,error:'cancelled'});await rejected;assert.equal(f.messages.filter(message=>message.command==='replacePinned').length,1);assert.equal(f.messages.filter(message=>message.command==='cancelPinned').length,1);}finally{f.bridge.close();}
});
test('a pre-cancelled pinned replacement emits no native operation',async()=>{
 const f=fixture({}),controller=new AbortController();try{controller.abort();await assert.rejects(f.bridge.replacePinned('held',{updateId:'update',signal:controller.signal}),/cancelled/);assert.equal(f.messages.length,0);}finally{f.bridge.close();}
});
test('native pinned backup and fingerprint transport preserves their proofs and progress',async()=>{
 const f=fixture({}),events=[];f.bridge.on('pinnedProgress',value=>events.push(value));
 try{for(const command of ['capturePinnedBackup','fingerprintPinned']){const operation=f.bridge[command]('held',{updateId:'same-journal',backup:'previous',size:4,expectedIdentity:'source'});await tick();const request=f.messages.at(-1);assert.equal(request.command,command);f.send({id:request.id,event:'pinnedProgress',stage:'check',bytes:4,total:4});const proof={hash:'a'.repeat(64),size:4};f.send({id:request.id,ok:true,replacement:proof});assert.deepEqual(await operation,proof);}assert.equal(events.length,2);}finally{f.bridge.close();}
});

test('current-copy capture and explicit finishing remain pending beyond the original deadline when progress arrives',async context=>{
 context.mock.timers.enable({apis:['setTimeout']});
 try{for(const command of ['capturePinnedCurrent','finishPinned']){const f=fixture({});let settled=false;try{
  const operation=f.bridge[command]('held',{updateId:'recovery',source:'content',backup:'preserved',size:4});operation.then(()=>settled=true,()=>settled=true);await tick();const request=f.messages.at(-1);
  context.mock.timers.tick(900);f.send({id:request.id,event:'pinnedProgress',stage:'replace',bytes:2,total:4});context.mock.timers.tick(900);await tick();assert.equal(settled,false,command+' must not time out while its native job makes progress');
  const proof={hash:'a'.repeat(64),size:4};f.send({id:request.id,ok:true,replacement:proof});assert.deepEqual(await operation,proof);assert.equal(f.messages.filter(message=>message.command===command).length,1);assert.equal(f.messages.some(message=>message.command==='cancelPinned'),false);
 }finally{f.bridge.close();}}}finally{context.mock.timers.reset();}
});
test('native deletion is acknowledged only after an explicit verified handler outcome',async()=>{
 const requests=[],f=fixture({}, {onDelete:async request=>{requests.push(request);return {readyForLocalDeletion:true};}});
 try{f.send({event:'notifyDelete',id:'delete-one',path:'Folder/file',identity:JSON.stringify({key:'remote/file',etag:'old',fileID:'v1'}),size:4});await tick();assert.equal(requests.length,1);assert.equal(requests[0].local,'Folder/file');assert.deepEqual(requests[0].previous,{key:'remote/file',etag:'old',fileID:'v1',size:4});assert.equal(requests[0].signal.aborted,false);assert.deepEqual(f.messages[0],{id:'delete-one',ok:true});
  f.bridge.onDelete=async()=>({readyForLocalDeletion:'true'});f.send({event:'notifyDelete',id:'delete-two',path:'Folder/file',identity:JSON.stringify({key:'remote/file',etag:'old'}),size:4});await tick();assert.equal(f.messages[1].ok,false);
 }finally{f.bridge.close();}
});
test('unsupported and malformed native deletions never reach a cloud deletion handler',async()=>{
 let calls=0;const f=fixture({}, {onDelete:async()=>{calls++;return {readyForLocalDeletion:true};}});
 try{for(const patch of [{path:'../escape'},{path:'con'},{identity:JSON.stringify({key:'folder/',etag:'old'})},{identity:JSON.stringify({key:'file'})},{size:-1},{size:1.5}])f.send({event:'notifyDelete',id:String(Math.random()),path:'file',identity:JSON.stringify({key:'file',etag:'old'}),size:4,...patch});await tick();assert.equal(calls,0);assert.equal(f.messages.length,6);assert(f.messages.every(message=>message.ok===false));}finally{f.bridge.close();}
});
test('provider shutdown cancels an in-progress deletion without acknowledging local removal',async()=>{
 let signal;const f=fixture({}, {onDelete:async request=>{signal=request.signal;await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('Stopped')),{once:true}));return {readyForLocalDeletion:true};}});
 f.send({event:'notifyDelete',id:'delete-pending',path:'file',identity:JSON.stringify({key:'file',etag:'old'}),size:4});await tick();assert.equal(signal.aborted,false);f.bridge.close();await tick();assert.equal(signal.aborted,true);assert.equal(f.messages.some(message=>message.id==='delete-pending'&&message.ok===true),false);
});
