const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {spawn}=require('node:child_process');const {app,safeStorage}=require('electron');
const {WindowsDriveClient}=require('../src/windows-drive-client');const {DriveIpcClient,endpointFor}=require('../src/windows-drive-ipc');
const profile=process.argv[2],role=process.argv[3],configFile=process.argv[4];assert(path.isAbsolute(profile));assert(['first','second','shutdown','restart','cleanup','verifyMove','recoverMove','verifyRecoveredMove','finishMove','verifyFinishedMove'].includes(role));
app.setPath('userData',profile);app.setPath('sessionData',profile);app.on('window-all-closed',()=>{});
const report=value=>console.log('EMBER_DRIVE_TEST:'+JSON.stringify(value));
async function main(){
  assert.equal(process.platform,'win32');await app.whenReady();let launches=0,diagnostics='';
  const appProxy={isPackaged:false,getAppPath:()=>path.resolve(__dirname,'..'),getPath:name=>app.getPath(name)};
  if(role==='cleanup'){
    const {WindowsDriveState}=require('../src/windows-drive-state'),{WindowsCloudFiles}=require('../src/windows-cloud-files');
    const state=new WindowsDriveState({directory:path.join(profile,'windows-drive'),safeStorage});await state.load();
    const bridge=new WindowsCloudFiles({app:appProxy,store:{read:async()=>{throw new Error('Cleanup must not hydrate cloud content');}}});
    try{await bridge.register(path.join(app.getPath('home'),'Ember Drive'),state.snapshot().identity);await bridge.unregister();report({complete:true,ownedRootUnregistered:true});}
    finally{bridge.close();}return;
  }
  const client=new WindowsDriveClient({app:appProxy,safeStorage,launch(executable,args,options){
    assert(['first','restart'].includes(role),'the second app must reuse the surviving provider');launches++;
    const child=spawn(executable,args,{...options,stdio:['ignore','ignore','pipe']});report({pid:child.pid});child.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk.toString()).slice(-8192);});return child;
  }});
  try{
    await client.start();assert.equal(launches,['first','restart'].includes(role)?1:0);assert.equal(client.status.supported,true);
    if(role==='first')assert.deepEqual(await client.request('settings'),{});
    if(configFile){
      if(role==='first')await client.request('save',{config:JSON.parse(await fs.readFile(configFile,'utf8'))});
      const status=await client.request('status');assert.equal(status.mounted,true);assert.equal(path.resolve(status.path).toLowerCase(),path.join(app.getPath('home'),'Ember Drive').toLowerCase());
      const settings=await client.request('settings');assert.equal(settings.hasSecret,true);assert.equal(settings.applicationKey,'');
      if(['second','restart'].includes(role))assert.equal(await client.request('resolve',{key:'background upload.txt'}),path.join(app.getPath('home'),'Ember Drive','background upload.txt'));
    }else assert.equal(client.status.mounted,false);
    if(role==='shutdown'){assert.equal(await client.shutdownForUpdate(),true);report({complete:true,providerExitVerified:true});return;}
    if(['verifyMove','verifyRecoveredMove','verifyFinishedMove'].includes(role)){
      const key=role==='verifyMove'?'renamed remote.txt':role==='verifyFinishedMove'?'finished remote.txt':'recovered remote.txt';
      assert.equal(await client.request('resolve',{key}),path.join(app.getPath('home'),'Ember Drive',key));
      assert.equal((await client.request('recover',{list:true})).count,0,'the completed move must clear its durable journal');
    }
    if(role==='recoverMove'){
      const list=await client.request('recover',{list:true});const entry=list.entries.find(entry=>entry.type==='move'&&entry.local==='recovered remote.txt');assert(entry,'the lost delete acknowledgement must produce a discoverable held move');
      const result=await client.request('recover',{kind:'move',id:entry.id});assert.equal(result.resolved,true);assert.equal(result.readOnlyCloudCheck,true);
    }
    if(role==='finishMove'){
      const list=await client.request('recover',{list:true});const entry=list.entries.find(entry=>entry.type==='move'&&entry.local==='finished remote.txt');assert(entry,'the lost copy acknowledgement must expose a held move');
      const checked=await client.request('recover',{kind:'move',id:entry.id});assert.equal(checked.resolved,false);assert.equal(checked.reason,'move-source-still-present');
      const finished=await client.request('recover',{kind:'move',id:entry.id,finish:true});assert.equal(finished.resolved,true);assert.equal(finished.readOnlyCloudCheck,false);
    }
    const encrypted=await fs.readFile(path.join(profile,'windows-drive','daemon.dpapi')),token=safeStorage.decryptString(encrypted);assert(!encrypted.includes(Buffer.from(token)));
    const denied=new DriveIpcClient({endpoint:endpointFor(profile),token:'0'.repeat(64)});try{await assert.rejects(denied.connect());}finally{denied.close();}
    await assert.rejects(client.request('unrecognized'),/not available/);
    client.stop();report({complete:true,dpapiIdentityVerified:true,reconnectWithoutRelaunchVerified:role==='second'});
  }catch(error){if(diagnostics)console.error('Drive daemon diagnostics:',diagnostics);throw error;}finally{client.stop();}
}
main().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
