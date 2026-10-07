// Test-only fault injection against an isolated acceptance profile after its daemon exits.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {app,safeStorage}=require('electron');const [profile,helper,accountID,root]=process.argv.slice(2);
assert.equal(process.platform,'win32');assert(path.isAbsolute(profile)&&path.isAbsolute(helper)&&path.isAbsolute(root));assert(path.basename(profile)==='user-data');
app.setPath('userData',profile);app.setPath('sessionData',profile);app.on('window-all-closed',()=>{});
async function main(){
 await app.whenReady();const directory=path.join(profile,'windows-drive');
 const {DriveIpcClient,endpointFor,daemonToken}=require('../src/windows-drive-ipc');const client=new DriveIpcClient({endpoint:endpointFor(profile),token:await daemonToken(directory,safeStorage)});
 try{await assert.rejects(client.connect(),error=>['ENOENT','ECONNREFUSED'].includes(error.code),'The isolated daemon must have exited before fault injection');}finally{client.close();}
 const {WindowsDriveAccounts}=require('../src/windows-drive-accounts'),{WindowsDriveState}=require('../src/windows-drive-state'),{WindowsDriveStore}=require('../src/windows-drive-store'),{WindowsCloudFiles}=require('../src/windows-cloud-files'),{replacePinnedRevision}=require('../src/windows-drive-pinned-update');
 const registry=new WindowsDriveAccounts({directory,home:app.getPath('home'),safeStorage});await registry.load();assert.equal(registry.snapshot().active,accountID);const selected=registry.profile(accountID);assert.equal(selected.root,root);const binding=JSON.parse(selected.binding);assert.equal(binding[0],'custom');assert.equal(binding[1],'fixture-bucket');assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(binding[3]));
 const state=new WindowsDriveState({directory:selected.directory,safeStorage});await state.load();assert.equal(state.snapshot().storageBinding,selected.binding);const snapshot=state.snapshot();assert.equal(Object.keys(snapshot.pinnedUpdates||{}).length,0);const local='recovery.txt',file=path.join(root,local),original=await fs.readFile(file);assert.equal(snapshot.materialized[local].key,local);
 const store=await WindowsDriveStore.create(snapshot.config),bridge=new WindowsCloudFiles({helper,store});
 try{await bridge.register(root,snapshot.identity);const info=await bridge.inspect(local);assert.equal(info.pinState,1);assert.equal(info.inSync,true);const object=await store.stat(local);assert.notEqual(object.etag,snapshot.materialized[local].etag);
  bridge.replacePinned=async()=>{throw Error('Acceptance interrupted pinned replacement');};await assert.rejects(replacePinnedRevision({local,object,root,state,store,bridge}),/Acceptance interrupted pinned replacement/);
  const entry=Object.values(state.snapshot().pinnedUpdates).find(entry=>entry.local===local);assert.equal(entry.phase,'replacing');assert.deepEqual(await fs.readFile(entry.backup.file),original);
  const partial=Buffer.from(original.subarray(0,4097));partial[0]^=255;const handle=await fs.open(file,'r+');try{await handle.write(partial,0,partial.length,0);await handle.truncate(partial.length);await handle.sync();}finally{await handle.close();}
  await bridge.command('disconnect');await bridge.closeAndWait();console.log('EMBER_PACKAGED_RECOVERY_SEED:'+JSON.stringify({id:entry.id,local,directory:entry.staged.directory,original:entry.backup.file,downloaded:entry.staged.file,partialHash:crypto.createHash('sha256').update(partial).digest('hex'),partialSize:partial.length}));
 }finally{await bridge.closeAndWait().catch(()=>{});store.close();}
}
main().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
