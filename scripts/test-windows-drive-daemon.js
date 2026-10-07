const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const {spawn,execFile}=require('node:child_process');
async function main(){
  assert.equal(process.platform,'win32');const profile=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drive-daemon-'));const electron=require('electron');let daemonPid,cloud,ownedRoot,rootIdentity,configFile,pinnedBackupBytes;
  const configured=process.argv.includes('--configured'),remoteBytes=require('node:crypto').randomBytes(8*1024*1024+123),localBytes=Buffer.from('Uploaded after the real app process exited.');
  async function worker(role){
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(electron,[path.join(__dirname,'test-windows-drive-daemon-worker.js'),profile,role,...(configFile?[configFile]:[])],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let buffer='',diagnostics='',result;
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
      buffer+=chunk;let end;
      while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.startsWith('EMBER_DRIVE_TEST:'))continue;const message=JSON.parse(line.slice('EMBER_DRIVE_TEST:'.length));if(message.pid)daemonPid=message.pid;if(message.complete)result=message;}
    });
    child.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk.toString()).slice(-8192);});
    const timer=setTimeout(()=>{void execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F']);},45000);
    try{
      const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
      assert.equal(code,0,diagnostics||`${role} worker failed`);assert(result,`${role} worker did not confirm acceptance`);return result;
    }finally{clearTimeout(timer);}
  }
  try{
    if(configured){
      // Never share or replace an existing user's Drive. The fixture owns the
      // root only after exclusive creation and retains its filesystem identity.
      const root=path.join(os.homedir(),'Ember Drive');await fs.mkdir(root);ownedRoot=root;rootIdentity=await fs.stat(root);
      cloud=await require('./windows-drive-cloud-fixture').cloudFixture({'unread remote.txt':remoteBytes,'Move folder/':Buffer.alloc(0),'Move folder/payload.bin':remoteBytes,'Move folder/Empty/.ghost-keep':Buffer.alloc(0)});configFile=path.join(profile,'fixture-config.json');await fs.writeFile(configFile,JSON.stringify(cloud.config),{flag:'wx'});
    }
    const first=await worker('first');assert(first.dpapiIdentityVerified);assert(daemonPid>0);process.kill(daemonPid,0);
    if(configured){
      assert.equal(cloud.requests.filter(request=>request.method==='GET'&&request.range&&request.url.includes('unread')).length,0,'the remote fixture must remain unhydrated until the first app exits');
      assert.deepEqual(await fs.readFile(path.join(ownedRoot,'unread remote.txt')),remoteBytes,'the surviving native provider must hydrate exact cloud bytes after app exit');
      await fs.writeFile(path.join(ownedRoot,'background upload.txt'),localBytes,{flag:'wx'});
      const deadline=Date.now()+30000;while(Date.now()<deadline&&!cloud.objects.get('background upload.txt')?.data.equals(localBytes))await new Promise(resolve=>setTimeout(resolve,100));
      assert.deepEqual(cloud.objects.get('background upload.txt')?.data,localBytes,'the surviving provider must upload a new local file after app exit');
      const lateBytes=Buffer.from('Remote addition while Ember is closed');cloud.put('late remote.txt',lateBytes);
      const refreshDeadline=Date.now()+75000;let discovered=false;
      while(Date.now()<refreshDeadline){try{const stat=await fs.stat(path.join(ownedRoot,'late remote.txt'));if(stat.size===lateBytes.length){discovered=true;break;}}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,250));}
      assert.equal(discovered,true,'the surviving provider must discover remote additions without reopening Ember');
      assert.deepEqual(await fs.readFile(path.join(ownedRoot,'late remote.txt')),lateBytes);
      const waitForMove=async(from,to)=>{const deadline=Date.now()+30000;while(Date.now()<deadline&&(cloud.objects.has(from)||!cloud.objects.get(to)?.data.equals(remoteBytes)))await new Promise(resolve=>setTimeout(resolve,100));assert.equal(cloud.objects.has(from),false,'the confirmed move must remove its original cloud key');assert.deepEqual(cloud.objects.get(to)?.data,remoteBytes,'the confirmed move must preserve every cloud byte');};
      await fs.rename(path.join(ownedRoot,'unread remote.txt'),path.join(ownedRoot,'renamed remote.txt'));await waitForMove('unread remote.txt','renamed remote.txt');
      await worker('verifyMove');assert.deepEqual(await fs.readFile(path.join(ownedRoot,'renamed remote.txt')),remoteBytes);
      cloud.loseNextDeleteAcknowledgement();await fs.rename(path.join(ownedRoot,'renamed remote.txt'),path.join(ownedRoot,'recovered remote.txt'));await waitForMove('renamed remote.txt','recovered remote.txt');
      const mutationsBefore=cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length;
      await worker('recoverMove');await worker('verifyRecoveredMove');
      assert.equal(cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length,mutationsBefore,'move recovery must not repeat a cloud copy or deletion');
      assert.deepEqual(await fs.readFile(path.join(ownedRoot,'recovered remote.txt')),remoteBytes,'recovery must preserve the actual renamed local file bytes');
      cloud.loseNextCopyAcknowledgement();await fs.rename(path.join(ownedRoot,'recovered remote.txt'),path.join(ownedRoot,'finished remote.txt'));
      const copyDeadline=Date.now()+30000;while(Date.now()<copyDeadline&&!cloud.objects.get('finished remote.txt')?.data.equals(remoteBytes))await new Promise(resolve=>setTimeout(resolve,100));
      assert.deepEqual(cloud.objects.get('finished remote.txt')?.data,remoteBytes,'the uncertain copy must have reached cloud storage');
      assert.deepEqual(cloud.objects.get('recovered remote.txt')?.data,remoteBytes,'a lost copy response must preserve its original');
      const putsBefore=cloud.requests.filter(request=>request.method==='PUT').length,deletesBefore=cloud.requests.filter(request=>request.method==='DELETE').length;
      await worker('finishMove');await worker('verifyFinishedMove');
      assert.equal(cloud.requests.filter(request=>request.method==='PUT').length,putsBefore,'explicit finish must not repeat the cloud copy');
      assert.equal(cloud.requests.filter(request=>request.method==='DELETE').length,deletesBefore+1,'explicit finish must perform exactly one conditional source deletion');
      assert.equal(cloud.objects.has('recovered remote.txt'),false);
      assert.deepEqual(await fs.readFile(path.join(ownedRoot,'finished remote.txt')),remoteBytes,'explicit completion must preserve every local byte');
      await fs.rename(path.join(ownedRoot,'finished remote.txt'),path.join(ownedRoot,'FINISHED REMOTE.TXT'));await waitForMove('finished remote.txt','FINISHED REMOTE.TXT');
      await worker('verifyCaseMove');assert.deepEqual(await fs.readFile(path.join(ownedRoot,'FINISHED REMOTE.TXT')),remoteBytes,'case-only rename must preserve all local bytes');
      assert.equal((await fs.readdir(ownedRoot)).includes('finished remote.txt'),false,'the old spelling must not remain as a physical directory entry');
      await worker('pinFolderMove');await fs.rename(path.join(ownedRoot,'Move folder'),path.join(ownedRoot,'Moved folder'));
      const folderDeadline=Date.now()+45000;while(Date.now()<folderDeadline&&([...cloud.objects.keys()].some(key=>key.startsWith('Move folder/'))||!cloud.objects.get('Moved folder/payload.bin')?.data.equals(remoteBytes)))await new Promise(resolve=>setTimeout(resolve,100));
      assert.equal([...cloud.objects.keys()].some(key=>key.startsWith('Move folder/')),false,'the daemon must complete all recorded folder source deletions');assert.deepEqual(cloud.objects.get('Moved folder/payload.bin')?.data,remoteBytes);assert.equal(cloud.objects.get('Moved folder/')?.data.length,0);assert.equal(cloud.objects.get('Moved folder/Empty/.ghost-keep')?.data.length,0);
      await worker('verifyFolderMove');const beforeFolderOffline=cloud.requests.filter(request=>request.method==='GET'&&request.range).length;assert.deepEqual(await fs.readFile(path.join(ownedRoot,'Moved folder','payload.bin')),remoteBytes);assert.equal((await fs.stat(path.join(ownedRoot,'Moved folder','Empty'))).isDirectory(),true);assert.equal(cloud.requests.filter(request=>request.method==='GET'&&request.range).length,beforeFolderOffline,'the moved pinned child must remain offline after app exit');
      await worker('pinRevision');
      const nextPinnedBytes=require('node:crypto').randomBytes(8*1024*1024+321),mutationsBeforePinned=cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length;
      pinnedBackupBytes=nextPinnedBytes;
      cloud.put('FINISHED REMOTE.TXT',nextPinnedBytes);
      const pinnedDeadline=Date.now()+75000;let pinnedInstalled=false;
      while(Date.now()<pinnedDeadline){
        try{const bytes=await fs.readFile(path.join(ownedRoot,'FINISHED REMOTE.TXT'));if(bytes.equals(nextPinnedBytes)){pinnedInstalled=true;break;}}
        catch(error){if(!['EBUSY','EACCES','EPERM'].includes(error.code))throw error;}
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      if(!pinnedInstalled){const diagnostic=await worker('diagnosePinned');assert.equal(pinnedInstalled,true,'the surviving provider must automatically install a changed pinned revision: '+JSON.stringify(diagnostic));}
      await worker('verifyPinnedRevision');
      const getsBeforeOfflineRead=cloud.requests.filter(request=>request.method==='GET'&&request.range).length;
      assert.deepEqual(await fs.readFile(path.join(ownedRoot,'FINISHED REMOTE.TXT')),nextPinnedBytes);
      assert.equal(cloud.requests.filter(request=>request.method==='GET'&&request.range).length,getsBeforeOfflineRead,'the new pinned revision must be fully available offline');
      assert.equal(cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length,mutationsBeforePinned,'pinned refresh must not modify cloud objects');
      const notes=path.join(profile,'scheduled-notes');await fs.mkdir(notes);await fs.writeFile(path.join(notes,'after-exit.md'),'Notes created while Ember is closed.');
      const recordingId='20261007-120000',recordingFolder=path.join(profile,'recordings',recordingId);await fs.mkdir(recordingFolder,{recursive:true});
      const run=require('node:util').promisify(execFile),ffmpeg=process.env.FFMPEG_BIN||require('../src/platform').mediaToolPath('ffmpeg');
      for(const [name,color] of [['finished.mp4','red'],['edited.mp4','blue']])await run(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i',`color=c=${color}:s=64x36:r=10`,'-t','0.4','-c:v','libx264','-pix_fmt','yuv420p',path.join(recordingFolder,name)],{timeout:30000});
      await fs.writeFile(path.join(profile,'recordings','recordings.json'),JSON.stringify({recordings:{[recordingId]:{id:recordingId,title:'Background call',createdAt:'2026-10-07T12:00:00Z',status:'processing',finished:true,edited:{auto:false},summary:'Saved summary.',transcript:[{text:'Saved transcript.'}],chapters:[]}}}));
      await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify({driveBackupNotes:true,driveBackupRecordings:true,notesDir:notes}));
      const recordingKey='Ember/Recordings/2026-10-07 Background call/Background call',expectedBackups=new Map([
       ['Ember/Notes/after-exit.md',Buffer.from('Notes created while Ember is closed.')],
       [recordingKey+'.mp4',await fs.readFile(path.join(recordingFolder,'finished.mp4'))],
       [recordingKey+' (edited).mp4',await fs.readFile(path.join(recordingFolder,'edited.mp4'))],
       [recordingKey+'.md',Buffer.from('# Background call\n\nSaved summary.\n\n\nSaved transcript.')]
      ]),backupDeadline=Date.now()+75000;
      while(Date.now()<backupDeadline&&[...expectedBackups].some(([key,bytes])=>!cloud.objects.get(key)?.data.equals(bytes)))await new Promise(resolve=>setTimeout(resolve,250));
      for(const [key,bytes] of expectedBackups)assert.deepEqual(cloud.objects.get(key)?.data,bytes,'the surviving daemon must schedule complete notes, recording and summary bytes after the app exits: '+key);
      await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify({driveBackupNotes:false,driveBackupRecordings:false,notesDir:notes}));





    }
    // The first app process has exited. A second real Electron app must attach
    // to the existing provider and decrypt the same profile identity.
    const second=await worker('second');assert(second.reconnectWithoutRelaunchVerified);process.kill(daemonPid,0);
    const priorPid=daemonPid;const shutdown=await worker('shutdown');assert.equal(shutdown.providerExitVerified,true);assert.throws(()=>process.kill(priorPid,0));
    await worker('restart');assert.notEqual(daemonPid,priorPid);process.kill(daemonPid,0);
    if(configured){
      await worker('shutdown');const next=require('node:crypto').randomBytes(8*1024*1024+555);cloud.put('FINISHED REMOTE.TXT',next);await worker('seedPinnedPartial');const partial=await fs.readFile(path.join(ownedRoot,'FINISHED REMOTE.TXT'));assert.equal(partial.length,4097);
      await worker('restart');assert.deepEqual(await fs.readFile(path.join(ownedRoot,'FINISHED REMOTE.TXT')),partial,'reconnect must hold a partial pinned update without replaying it');const mutations=cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length;
      await worker('finishPinnedPartial');assert.equal(cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length,mutations,'explicit pinned finishing must leave all cloud objects unchanged');const reads=cloud.requests.filter(request=>request.method==='GET'&&request.range).length;
      assert.deepEqual(await fs.readFile(path.join(ownedRoot,'FINISHED REMOTE.TXT')),next);assert.equal(cloud.requests.filter(request=>request.method==='GET'&&request.range).length,reads,'explicitly finished bytes must be fully offline');
      await worker('shutdown');await worker('restart');const copies=await worker('verifySavedPinnedCopies'),hash=bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex');assert.equal(copies.savedCopiesAfterRestartAndDisconnectVerified,true);assert.equal(copies.savedCopyEntryRemovalPreservesFilesVerified,true);assert.equal(copies.originalHash,hash(pinnedBackupBytes));assert.equal(copies.localHash,hash(partial));
    }
    console.log(JSON.stringify({daemonAuthenticationVerified:true,dpapiIdentityVerified:true,independentProcessVerified:true,gracefulUpdateShutdownVerified:true,restartAfterUpdateShutdownVerified:true,survivesAppProcessExitVerified:true,reconnectWithoutRelaunchVerified:true,...(configured?{configuredCloudVerified:true,hydrationAfterAppExitVerified:true,uploadAfterAppExitVerified:true,remoteAdditionAfterAppExitVerified:true,fileRenameAfterAppExitVerified:true,readOnlyMoveRecoveryVerified:true,explicitMoveCompletionVerified:true,caseOnlyFileRenameVerified:true,folderMoveAfterAppExitVerified:true,movedFolderPinnedChildOfflineVerified:true,pinnedRevisionRefreshAfterAppExitVerified:true,pinnedRevisionOfflineReadVerified:true,scheduledNotesBackupAfterAppExitVerified:true,scheduledRecordingBackupAfterAppExitVerified:true,scheduledEditedBackupAfterAppExitVerified:true,scheduledSummaryBackupAfterAppExitVerified:true,scheduledRecordingWhileWriteUpPendingVerified:true,explicitPartialPinnedFinishingVerified:true,savedPinnedCopiesAfterRestartAndDisconnectVerified:true,savedCopyEntryRemovalPreservesFilesVerified:true,hydratedBytes:remoteBytes.length}:{}),pid:daemonPid}));
  }finally{
    let rootRemoved=!ownedRoot;
    try{
      if(daemonPid)await new Promise(resolve=>execFile('taskkill.exe',['/PID',String(daemonPid),'/T','/F'],()=>resolve()));
      if(ownedRoot){
        const current=await fs.lstat(ownedRoot);assert.equal(current.isSymbolicLink(),false);assert.equal(current.ino,rootIdentity.ino);assert.equal(current.dev,rootIdentity.dev);
        const cleanup=await worker('cleanup');assert.equal(cleanup.ownedRootUnregistered,true);await fs.rm(ownedRoot,{recursive:true,force:true});rootRemoved=true;
      }
    }finally{await cloud?.close();if(rootRemoved)await fs.rm(profile,{recursive:true,force:true});}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
