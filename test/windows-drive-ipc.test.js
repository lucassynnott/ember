const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');const net=require('node:net');const {once}=require('node:events');
const {endpointFor,daemonToken,DriveIpcServer,DriveIpcClient}=require('../src/windows-drive-ipc');
async function fixture(t,dispatch){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ember-ipc-')),token=crypto.randomBytes(32).toString('hex'),endpoint=endpointFor(directory);
  const server=new DriveIpcServer({endpoint,token,dispatch,snapshot:()=>({status:{supported:true,mounted:true},mountPath:'owned-root'})});await server.listen();
  const clients=[];t.after(async()=>{for(const client of clients)client.close();await server.close();await fs.rm(directory,{recursive:true,force:true});});
  return {server,token,endpoint,client(options={}){const client=new DriveIpcClient({endpoint,token,...options});clients.push(client);return client;}};
}
test('daemon transport authenticates and survives one app client disconnecting',async t=>{
  const calls=[],f=await fixture(t,async(command,args)=>{calls.push([command,args]);return args.value;});
  const first=f.client(),second=f.client();assert.equal((await first.connect()).mountPath,'owned-root');await second.connect();
  assert.equal(await first.request('save',{value:'stored'}),'stored');
  const event=once(second,'event');f.server.publish('status',{mounted:true});assert.deepEqual(await event,['status',{mounted:true}]);
  const disconnected=once(first,'disconnect');first.close();await disconnected;
  assert.equal(await second.request('cache',{value:42}),42);assert.deepEqual(calls,[['save',{value:'stored'}],['cache',{value:42}]]);
});
test('unauthenticated and malformed clients cannot dispatch daemon commands',async t=>{
  let calls=0;const f=await fixture(t,()=>{calls++;return true;});
  await assert.rejects(f.client({token:'0'.repeat(64)}).connect(),/closed/);assert.equal(calls,0);
  const raw=net.createConnection(f.endpoint);raw.on('error',()=>{});await once(raw,'connect');const closed=once(raw,'close');raw.write(JSON.stringify({type:'request',id:1,command:'save',args:{}})+'\n');await closed;assert.equal(calls,0);
  const oversized=net.createConnection(f.endpoint);oversized.on('error',()=>{});await once(oversized,'connect');const overClosed=new Promise(resolve=>oversized.once('close',resolve));oversized.write('x'.repeat(300000));await overClosed;assert.equal(calls,0);
});
test('a timed-out write is dispatched once and is never replayed',async t=>{
  let calls=0,release;const f=await fixture(t,async()=>{calls++;await new Promise(resolve=>release=resolve);return true;});const client=f.client();
  await assert.rejects(client.request('save',{},30),/outcome may be uncertain/);assert.equal(calls,1);release();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal(client.pending.size,0);
});
test('an impersonated pipe server cannot obtain the identity token or accept an app connection',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ember-impostor-')),endpoint=endpointFor(directory),token=crypto.randomBytes(32).toString('hex');let hello;
 const impostor=net.createServer(socket=>{socket.on('error',()=>{});socket.once('data',data=>{hello=JSON.parse(data.toString());socket.write(JSON.stringify({type:'challenge',nonce:'1'.repeat(64),proof:'0'.repeat(64)})+'\n');});});
 await new Promise(resolve=>impostor.listen(endpoint,resolve));const client=new DriveIpcClient({endpoint,token});
 t.after(async()=>{client.close();await new Promise(resolve=>impostor.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
 await assert.rejects(client.connect(),/closed/);assert.equal(hello.type,'hello');assert.equal(typeof hello.nonce,'string');assert(!JSON.stringify(hello).includes(token));assert.equal(Object.hasOwn(hello,'token'),false);
});
test('disconnecting an in-flight command reports uncertainty and does not retry it',async t=>{
  let calls=0,release;const started=new Promise(resolve=>release=resolve);const f=await fixture(t,async()=>{calls++;release();await new Promise(resolve=>setTimeout(resolve,40));return true;});const client=f.client();
  const request=client.request('backup',{});await started;client.close();await assert.rejects(request,/outcome may be uncertain/);assert.equal(calls,1);
});
test('daemon command errors propagate without sending private stack traces',async t=>{
  const f=await fixture(t,()=>{throw new Error('Storage refused access');});await assert.rejects(f.client().request('save',{}),error=>error.message==='Storage refused access'&&!error.stack.includes('Storage refused access\n    at DriveIpcServer'));
});
test('concurrent starters retain one encrypted daemon identity and refuse corrupt state',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ember-token-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const key=crypto.randomBytes(32),safeStorage={isEncryptionAvailable:()=>true,encryptString(text){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);const body=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]);},decryptString(bytes){const decipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8');}};
  const tokens=await Promise.all(Array.from({length:8},()=>daemonToken(directory,safeStorage)));assert.equal(new Set(tokens).size,1);assert(!(await fs.readFile(path.join(directory,'daemon.dpapi'))).includes(Buffer.from(tokens[0])));
  await assert.rejects(daemonToken(directory,{isEncryptionAvailable:()=>false}),/unavailable/);
  await fs.writeFile(path.join(directory,'daemon.dpapi'),'corrupt');await assert.rejects(daemonToken(directory,safeStorage));assert.equal(await fs.readFile(path.join(directory,'daemon.dpapi'),'utf8'),'corrupt');
});
test('update drain waits for dispatched work and refuses new operations without replay',async t=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const profile=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drain-'));let finish,entered;const begun=new Promise(resolve=>entered=resolve),calls=[];
 const token='1'.repeat(64),server=new DriveIpcServer({endpoint:endpointFor(profile),token,dispatch:async command=>{calls.push(command);entered();await new Promise(resolve=>finish=resolve);return true;}});await server.listen();const client=new DriveIpcClient({endpoint:endpointFor(profile),token});
 t.after(async()=>{finish?.();client.close();await server.close();await fs.rm(profile,{recursive:true,force:true});});
 const active=client.request('backup');await begun;let drained=false;const drain=server.drain().then(()=>drained=true);await new Promise(resolve=>setImmediate(resolve));assert.equal(drained,false);await assert.rejects(client.request('another-write'),/shutting down/);assert.deepEqual(calls,['backup']);finish();assert.equal(await active,true);await drain;assert.equal(drained,true);
});
