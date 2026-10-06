const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const {spawn,execFile}=require('node:child_process');
const {app,safeStorage}=require('electron');
const {WindowsDriveClient}=require('../src/windows-drive-client');
const {DriveIpcClient,endpointFor}=require('../src/windows-drive-ipc');
app.on('window-all-closed',()=>{});
async function main(){
  assert.equal(process.platform,'win32');await app.whenReady();
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drive-daemon-'));let child,launches=0;
  const appProxy={isPackaged:false,getAppPath:()=>path.resolve(__dirname,'..'),getPath:name=>{assert.equal(name,'userData');return profile;}};
  const create=()=>new WindowsDriveClient({app:appProxy,safeStorage,launch(...args){launches++;child=spawn(...args);return child;}});
  const first=create(),second=create();
  try{
    await first.start();assert.equal(launches,1);assert(child.pid>0);assert.equal(first.status.supported,true);assert.equal(first.status.mounted,false);
    assert.deepEqual(await first.request('settings'),{});
    const encrypted=await fs.readFile(path.join(profile,'windows-drive','daemon.dpapi'));const token=safeStorage.decryptString(encrypted);assert(!encrypted.includes(Buffer.from(token)));
    const denied=new DriveIpcClient({endpoint:endpointFor(profile),token:'0'.repeat(64)});
    try{await assert.rejects(denied.connect());}finally{denied.close();}
    first.stop();process.kill(child.pid,0);
    await second.start();assert.equal(launches,1,'closing the app must not require a second provider');
    assert.deepEqual(await second.request('settings'),{});assert.equal(second.status.supported,true);
    await assert.rejects(second.request('unrecognized'),/not available/);
    second.stop();process.kill(child.pid,0);
    console.log(JSON.stringify({daemonAuthenticationVerified:true,dpapiIdentityVerified:true,independentProcessVerified:true,reconnectWithoutRelaunchVerified:true,pid:child.pid}));
  }finally{
    first.stop();second.stop();
    if(child?.pid)await new Promise(resolve=>execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F'],()=>resolve()));
    await fs.rm(profile,{recursive:true,force:true});
  }
}
main().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
