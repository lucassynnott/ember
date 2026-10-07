const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {spawn}=require('node:child_process');const {app,safeStorage}=require('electron');
const {WindowsDriveClient}=require('../src/windows-drive-client');const {DriveIpcClient,endpointFor}=require('../src/windows-drive-ipc');
const profile=process.argv[2],role=process.argv[3],configFile=process.argv[4];assert(path.isAbsolute(profile));assert(['first','second','shutdown','restart','cleanup','verifyMove','recoverMove','verifyRecoveredMove','finishMove','verifyFinishedMove','verifyCaseMove','pinRevision','verifyPinnedRevision','seedPinnedPartial','finishPinnedPartial','verifySavedPinnedCopies'].includes(role));
app.setPath('userData',profile);app.setPath('sessionData',profile);app.on('window-all-closed',()=>{});
const report=value=>console.log('EMBER_DRIVE_TEST:'+JSON.stringify(value));
async function main(){
  assert.equal(process.platform,'win32');await app.whenReady();let launches=0,diagnostics='';
  const appProxy={isPackaged:false,getAppPath:()=>path.resolve(__dirname,'..'),getPath:name=>app.getPath(name)};
  if(role==='seedPinnedPartial'){
    const {WindowsDriveState}=require('../src/windows-drive-state'),{WindowsDriveStore}=require('../src/windows-drive-store'),{stageRevision}=require('../src/windows-drive-staging'),{WindowsPinnedUpdateJournal}=require('../src/windows-drive-pinned-journal'),crypto=require('node:crypto');
    const state=new WindowsDriveState({directory:path.join(profile,'windows-drive'),safeStorage});await state.load();const root=path.join(app.getPath('home'),'Ember Drive'),local='FINISHED REMOTE.TXT',file=path.join(root,local),previous=state.snapshot().materialized[local],original=await fs.readFile(file),store=await WindowsDriveStore.create(state.snapshot().config);
    try{
      const object=await store.stat(previous.key),staged=await stageRevision({store,object,directory:path.join(state.directory,'pinned-revisions'),driveRoot:root}),journal=new WindowsPinnedUpdateJournal(state),id=await journal.begin({local,previous,staged}),backup=path.join(staged.directory,'previous'),saved=await fs.open(backup,'wx');
      try{await saved.writeFile(original);await saved.sync();}finally{await saved.close();}
      await journal.recordBackup(id,{file:backup,hash:crypto.createHash('sha256').update(original).digest('hex'),size:original.length});await journal.replacing(id);
      const partial=Buffer.from(original.subarray(0,4097));partial[0]^=255;const target=await fs.open(file,'r+');try{await target.write(partial,0,partial.length,0);await target.truncate(partial.length);await target.sync();}finally{await target.close();}
      assert.deepEqual(await fs.readFile(file),partial);report({complete:true,partialPinnedIntentSeeded:true,id});
    }finally{store.close();}return;
  }
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
    if(['verifyMove','verifyRecoveredMove','verifyFinishedMove','verifyCaseMove'].includes(role)){
      const key=role==='verifyCaseMove'?'FINISHED REMOTE.TXT':role==='verifyMove'?'renamed remote.txt':role==='verifyFinishedMove'?'finished remote.txt':'recovered remote.txt';
      const expected=path.join(app.getPath('home'),'Ember Drive',key),deadline=Date.now()+30000;let resolved,lastError;
      do{try{resolved=await client.request('resolve',{key});if(resolved===expected&&(await client.request('recover',{list:true})).count===0)break;}catch(error){lastError=error.message;}await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<deadline);
      assert.equal(resolved,expected,'the local move mapping must finish: '+(lastError||''));
      assert.equal((await client.request('recover',{list:true})).count,0,'the completed move must clear its durable journal');
    }
    if(role==='pinRevision')await client.request('pin',{keys:['FINISHED REMOTE.TXT']});
    if(role==='verifyPinnedRevision'){
      const deadline=Date.now()+30000;let cache;
      do{cache=await client.request('cache');if(cache.errors.length===0&&(await client.request('recover',{list:true})).count===0)break;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<deadline);
      const file=cache.files.find(file=>file.key==='FINISHED REMOTE.TXT');
      assert(file?.pinned,'the changed revision must remain pinned: '+JSON.stringify({cache,status:await client.request('status'),recovery:await client.request('recover',{list:true})}));assert.equal(file.size,8*1024*1024+321);assert.equal(cache.errors.length,0);
      const search=await client.request('search',{query:'FINISHED REMOTE'});assert.equal(search.hits[0].size,8*1024*1024+321,'search must represent the installed cloud revision');
      assert.equal((await client.request('recover',{list:true})).count,0,'the verified pinned replacement must clear its durable intent');
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
    if(role==='finishPinnedPartial'){
      const entry=(await client.request('recover',{list:true})).entries.find(entry=>entry.type==='pinned'&&entry.local==='FINISHED REMOTE.TXT');assert(entry,'the restarted daemon must discover the interrupted pinned overwrite');const file=path.join(app.getPath('home'),'Ember Drive',entry.local),before=await fs.readFile(file);
      for(const finish of [false,'true']){const result=await client.request('recover',{kind:'pinned',id:entry.id,finish});assert.equal(result.resolved,false);assert.equal(result.reason,'local-changed');assert.deepEqual(await fs.readFile(file),before,'read-only checks must preserve every partial local byte');}
      const result=await client.request('recover',{kind:'pinned',id:entry.id,finish:true});assert.equal(result.resolved,true);assert.equal(result.localCopiesPreserved,true);
      const list=await client.request('recover',{list:true});assert.equal(list.entries.some(item=>item.type==='pinned'&&item.id===entry.id),false);assert(list.entries.some(item=>item.type==='pinned-copy'&&item.id===entry.id),'the saved copies must remain discoverable');
    }
    if(role==='verifySavedPinnedCopies'){
      await client.request('unmount');assert.equal((await client.request('status')).mounted,false);const entry=(await client.request('recover',{list:true})).entries.find(entry=>entry.type==='pinned-copy'&&entry.local==='FINISHED REMOTE.TXT');assert(entry,'saved pinned copies must survive daemon restart');
      assert.deepEqual(await client.request('recover',{kind:'pinned-copy',id:entry.id,revealCopies:true,file:'C:\\untrusted'}),{revealed:true});
      const {WindowsDriveState}=require('../src/windows-drive-state'),{savedPinnedCopies}=require('../src/windows-drive-pinned-update'),crypto=require('node:crypto'),state=new WindowsDriveState({directory:path.join(profile,'windows-drive'),safeStorage});await state.load();const copies=await savedPinnedCopies({id:entry.id,state});assert.deepEqual(copies.map(copy=>copy.name),['original','local-1']);const hash=async file=>crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
      report({complete:true,savedCopiesAfterRestartAndDisconnectVerified:true,originalHash:await hash(copies[0].file),localHash:await hash(copies[1].file)});return;
    }
    const encrypted=await fs.readFile(path.join(profile,'windows-drive','daemon.dpapi')),token=safeStorage.decryptString(encrypted);assert(!encrypted.includes(Buffer.from(token)));
    const denied=new DriveIpcClient({endpoint:endpointFor(profile),token:'0'.repeat(64)});try{await assert.rejects(denied.connect());}finally{denied.close();}
    await assert.rejects(client.request('unrecognized'),/not available/);
    client.stop();report({complete:true,dpapiIdentityVerified:true,reconnectWithoutRelaunchVerified:role==='second'});
  }catch(error){if(diagnostics)console.error('Drive daemon diagnostics:',diagnostics);throw error;}finally{client.stop();}
}
main().then(()=>app.exit(0),error=>{console.error(error);app.exit(1);});
