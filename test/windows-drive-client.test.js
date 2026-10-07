const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const {once}=require('node:events');
const {WindowsDriveClient}=require('../src/windows-drive-client');const {DriveIpcServer,daemonToken,endpointFor}=require('../src/windows-drive-ipc');
test('Ember attaches to an existing provider and closing the client preserves the daemon',async t=>{
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'ember-client-'));
  const safeStorage={isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from(text),decryptString:bytes=>bytes.toString()};
  const token=await daemonToken(path.join(profile,'windows-drive'),safeStorage),calls=[],updates=[],events=[];
  const snapshot={status:{supported:true,mounted:true,configured:true},mountPath:'owned-root'};
  const server=new DriveIpcServer({endpoint:endpointFor(profile),token,snapshot:()=>snapshot,dispatch:async(command,args)=>{calls.push([command,args]);return 'verified';}});await server.listen();
  const client=new WindowsDriveClient({app:{getPath:()=>profile},safeStorage,onStatus:status=>updates.push(status),onEvent:(...event)=>events.push(event),launch:()=>{throw new Error('Existing provider must be reused');}});
  t.after(async()=>{client.stop();await server.close();await fs.rm(profile,{recursive:true,force:true});});
  await client.start();assert.equal(client.mountPath,'owned-root');assert.equal(client.status.supported,true);assert.equal(client.status.daemonConnected,true);
  assert.equal(await client.request('resolve',{key:'remote:name'}),'verified');assert.equal(await client.backUp('source','Notes/file.md'),'verified');
  assert.deepEqual(calls,[['request',{command:'resolve',args:{key:'remote:name'}}],['backup',{file:'source',relative:'Notes/file.md'}]]);
  server.publish('test',{checks:[{state:'passed'}]});await once(client.client,'event');assert.deepEqual(events,[['test',{checks:[{state:'passed'}]}]]);
  const disconnected=once(client.client,'disconnect');client.stop();await disconnected;assert.equal(server.server.listening,true);assert.equal(client.mountPath,null);assert.equal(updates.at(-1).daemonConnected,false);
  await client.start();assert.equal(client.mountPath,'owned-root');assert.equal(await client.request('settings'),'verified');
});
test('a stopped startup cannot attach later and stale connections cannot alter a replacement',async t=>{
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'ember-client-race-'));
  const safeStorage={isEncryptionAvailable:()=>true,encryptString:text=>Buffer.from(text),decryptString:bytes=>bytes.toString()};
  const token=await daemonToken(path.join(profile,'windows-drive'),safeStorage),snapshot={status:{supported:true,mounted:true},mountPath:'current-root'},events=[];
  const server=new DriveIpcServer({endpoint:endpointFor(profile),token,snapshot:()=>snapshot,dispatch:async()=>true});await server.listen();
  const client=new WindowsDriveClient({app:{getPath:()=>profile},safeStorage,onEvent:(...args)=>events.push(args),launch:()=>{throw new Error('No new daemon should launch');}});
  t.after(async()=>{client.stop();await server.close();await fs.rm(profile,{recursive:true,force:true});});
  const canceled=client.start();client.stop();await assert.rejects(canceled,/was stopped/);assert.equal(client.mountPath,null);assert.equal(client.ready,null);
  await client.start();const previous=client.client;client.stop();await client.start();assert.notEqual(client.client,previous);
  previous.emit('event','status',{status:{mounted:false},mountPath:null});previous.emit('event','test',{stale:true});previous.emit('disconnect');
  assert.equal(client.mountPath,'current-root');assert.equal(client.status.daemonConnected,true);assert.deepEqual(events,[]);assert.equal(await client.request('status'),true);
});
