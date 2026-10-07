const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {app,safeStorage}=require('electron');
const [profile,helper,rootsJson,action='cleanup']=process.argv.slice(2);assert(['cleanup','stop'].includes(action));assert(path.isAbsolute(profile)&&path.isAbsolute(helper));const roots=JSON.parse(rootsJson);assert(Array.isArray(roots)&&roots.length<=2&&roots.every(root=>path.isAbsolute(root)));
app.setPath('userData',profile);app.setPath('sessionData',profile);app.on('window-all-closed',()=>{});
async function main(){
 await app.whenReady();const {DriveIpcClient,endpointFor,daemonToken}=require('../src/windows-drive-ipc'),directory=path.join(profile,'windows-drive');
 const client=new DriveIpcClient({endpoint:endpointFor(profile),token:await daemonToken(directory,safeStorage)});await client.connect();let stopped;
 try{stopped=await client.request('shutdown',{},30000);assert.equal(stopped.stopped,true);assert(Number.isSafeInteger(stopped.pid)&&stopped.pid>0&&stopped.pid!==process.pid);await client.request('shutdownExit',{pid:stopped.pid},10000).catch(error=>{if(!/^Drive daemon (?:disconnected|connection closed)/.test(error.message))throw error;});}finally{client.close();}
 const deadline=Date.now()+15000;for(;;){try{process.kill(stopped.pid,0);}catch(error){if(error.code==='ESRCH')break;throw error;}assert(Date.now()<deadline,'The owned packaged daemon did not exit');await new Promise(resolve=>setTimeout(resolve,100));}
 if(action==='stop'){console.log('EMBER_PACKAGED_DRIVE_STOP:'+JSON.stringify({ownedPackagedDriveStopped:true,daemonExited:true,pid:stopped.pid}));return;}
 const {WindowsDriveAccounts}=require('../src/windows-drive-accounts'),{WindowsDriveState}=require('../src/windows-drive-state'),{WindowsCloudFiles}=require('../src/windows-cloud-files');
 const registry=new WindowsDriveAccounts({directory,home:app.getPath('home'),safeStorage});await registry.load();
 for(const root of roots){const entries=registry.snapshot().accounts.map(entry=>registry.profile(entry.id)).filter(entry=>entry.root===root);assert.equal(entries.length,1,'Cleanup must resolve an exact registered fixture root');const entry=entries[0],binding=JSON.parse(entry.binding);assert.equal(binding[0],'custom');assert.equal(binding[1],'fixture-bucket');assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(binding[3]));const state=new WindowsDriveState({directory:entry.directory,safeStorage});await state.load();assert.equal(state.snapshot().storageBinding,entry.binding);
  const bridge=new WindowsCloudFiles({helper,store:{read:async()=>{throw Error('Cleanup must not hydrate');}},timeoutMs:30000});try{await bridge.register(root,state.snapshot().identity);await bridge.unregister();}finally{await bridge.closeAndWait();}await fs.rm(root,{recursive:true,force:true});
 }
 console.log(JSON.stringify({ownedPackagedDriveCleanup:true,rootsRemoved:roots.length,daemonExited:true}));
}
main().then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});
