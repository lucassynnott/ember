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
