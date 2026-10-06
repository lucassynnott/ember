const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {spawn}=require('node:child_process');const {app,safeStorage}=require('electron');
const {WindowsDriveClient}=require('../src/windows-drive-client');const {DriveIpcClient,endpointFor}=require('../src/windows-drive-ipc');
const profile=process.argv[2],role=process.argv[3];assert(path.isAbsolute(profile));assert(['first','second'].includes(role));
app.setPath('userData',profile);app.setPath('sessionData',profile);app.on('window-all-closed',()=>{});
const report=value=>console.log('EMBER_DRIVE_TEST:'+JSON.stringify(value));
async function main(){
  assert.equal(process.platform,'win32');await app.whenReady();let launches=0,diagnostics='';
  const appProxy={isPackaged:false,getAppPath:()=>path.resolve(__dirname,'..'),getPath:name=>app.getPath(name)};
  const client=new WindowsDriveClient({app:appProxy,safeStorage,launch(executable,args,options){
    assert.equal(role,'first','the second app must reuse the surviving provider');launches++;
    const child=spawn(executable,args,{...options,stdio:['ignore','ignore','pipe']});report({pid:child.pid});child.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk.toString()).slice(-8192);});return child;
  }});
  try{
    await client.start();assert.equal(launches,role==='first'?1:0);assert.equal(client.status.supported,true);assert.equal(client.status.mounted,false);
    assert.deepEqual(await client.request('settings'),{});
    const encrypted=await fs.readFile(path.join(profile,'windows-drive','daemon.dpapi')),token=safeStorage.decryptString(encrypted);assert(!encrypted.includes(Buffer.from(token)));
    const denied=new DriveIpcClient({endpoint:endpointFor(profile),token:'0'.repeat(64)});try{await assert.rejects(denied.connect());}finally{denied.close();}
    await assert.rejects(client.request('unrecognized'),/not available/);
    client.stop();report({complete:true,dpapiIdentityVerified:true,reconnectWithoutRelaunchVerified:role==='second'});
  }catch(error){if(diagnostics)console.error('Drive daemon diagnostics:',diagnostics);throw error;}finally{client.stop();}
}
main().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
