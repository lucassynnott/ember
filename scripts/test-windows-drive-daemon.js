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
      cloud=await require('./windows-drive-cloud-fixture').cloudFixture({'unread remote.txt':remoteBytes,'delete after app exit.txt':remoteBytes,'delete copy fault.txt':Buffer.from('Copy deletion recovery'),'delete source fault.txt':Buffer.from('Source deletion recovery'),'Move folder/':Buffer.alloc(0),'Move folder/payload.bin':remoteBytes,'Move folder/Empty/.ghost-keep':Buffer.alloc(0)});configFile=path.join(profile,'fixture-config.json');await fs.writeFile(configFile,JSON.stringify(cloud.config),{flag:'wx'});
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
      await worker('verifyDeletionUnhydrated');
      await fs.unlink(path.join(ownedRoot,'delete after app exit.txt'));
      assert.equal(cloud.objects.has('delete after app exit.txt'),false,'the surviving provider must remove the original only after saving its complete trash copy');
      const savedDeletion=[...cloud.objects.entries()].filter(([key])=>key.startsWith('.ghost-trash/')&&key.endsWith('/delete after app exit.txt'));assert.equal(savedDeletion.length,1);assert.deepEqual(savedDeletion[0][1].data,remoteBytes);
      await worker('verifyDeletion');
      const copyDeletePath=path.join(ownedRoot,'delete copy fault.txt');cloud.loseNextCopyAcknowledgement();await assert.rejects(fs.unlink(copyDeletePath));assert.equal(cloud.objects.has('delete copy fault.txt'),true);await fs.stat(copyDeletePath);
      const copyDeleteTrash=[...cloud.objects.entries()].find(([key])=>key.startsWith('.ghost-trash/')&&key.endsWith('/delete copy fault.txt'));assert(copyDeleteTrash);assert.equal(copyDeleteTrash[1].data.toString(),'Copy deletion recovery');
      const copyDeleteMutations=cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length;await worker('shutdown');await worker('restart');assert.equal(cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length,copyDeleteMutations,'restart must not finish a refused deletion');
      const copyDeletePuts=cloud.requests.filter(request=>request.method==='PUT').length;await fs.unlink(copyDeletePath);await worker('verifyDeletionCopyRecovery');assert.equal(cloud.objects.has('delete copy fault.txt'),false);assert.equal(cloud.requests.filter(request=>request.method==='PUT').length,copyDeletePuts,'retry must reuse the confirmed trash copy');assert.equal(cloud.objects.get(copyDeleteTrash[0]),copyDeleteTrash[1]);
      const sourceDeletePath=path.join(ownedRoot,'delete source fault.txt');cloud.loseNextDeleteAcknowledgement();await assert.rejects(fs.unlink(sourceDeletePath));assert.equal(cloud.objects.has('delete source fault.txt'),false);await fs.stat(sourceDeletePath);
      const sourceDeleteTrash=[...cloud.objects.entries()].find(([key])=>key.startsWith('.ghost-trash/')&&key.endsWith('/delete source fault.txt'));assert(sourceDeleteTrash);assert.equal(sourceDeleteTrash[1].data.toString(),'Source deletion recovery');
      const sourceDeleteMutations=cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length;await worker('shutdown');await worker('restart');assert.equal(cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length,sourceDeleteMutations,'restart must only inspect the lost deletion outcome');await fs.stat(sourceDeletePath);
      await fs.unlink(sourceDeletePath);await worker('verifyDeletionSourceRecovery');assert.equal(cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length,sourceDeleteMutations,'local retry must not repeat any confirmed cloud write');assert.equal(cloud.objects.get(sourceDeleteTrash[0]),sourceDeleteTrash[1]);

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
      await fs.rename(path.join(ownedRoot,'Moved folder'),path.join(ownedRoot,'MOVED FOLDER'));
      const caseFolderDeadline=Date.now()+45000;while(Date.now()<caseFolderDeadline&&([...cloud.objects.keys()].some(key=>key.startsWith('Moved folder/'))||!cloud.objects.get('MOVED FOLDER/payload.bin')?.data.equals(remoteBytes)))await new Promise(resolve=>setTimeout(resolve,100));
      assert.equal([...cloud.objects.keys()].some(key=>key.startsWith('Moved folder/')),false,'the capitalization-only folder move must remove the exact original cloud spelling');assert.deepEqual(cloud.objects.get('MOVED FOLDER/payload.bin')?.data,remoteBytes);assert.equal(cloud.objects.get('MOVED FOLDER/')?.data.length,0);assert.equal(cloud.objects.get('MOVED FOLDER/Empty/.ghost-keep')?.data.length,0);await worker('verifyCaseFolderMove');assert.equal((await fs.readdir(ownedRoot)).includes('Moved folder'),false,'the old folder spelling must not remain as a physical directory entry');
      const beforeCaseOffline=cloud.requests.filter(request=>request.method==='GET'&&request.range).length;assert.deepEqual(await fs.readFile(path.join(ownedRoot,'MOVED FOLDER','payload.bin')),remoteBytes);assert.equal(cloud.requests.filter(request=>request.method==='GET'&&request.range).length,beforeCaseOffline,'the case-only folder move must preserve the complete pinned child cache');
      const folderObjects=prefix=>[...cloud.objects.keys()].filter(key=>key.startsWith(prefix+'/'));
      cloud.loseNextCopyAcknowledgement();await fs.rename(path.join(ownedRoot,'MOVED FOLDER'),path.join(ownedRoot,'Copy recovered folder'));
      const folderCopyDeadline=Date.now()+45000;while(Date.now()<folderCopyDeadline&&folderObjects('Copy recovered folder').length===0)await new Promise(resolve=>setTimeout(resolve,100));
      assert.equal(folderObjects('Copy recovered folder').length,1,'a lost first-copy response must stop the folder transaction');assert.equal(folderObjects('MOVED FOLDER').length,3,'every original object must survive the uncertain copy');const firstCopiedKey=folderObjects('Copy recovered folder')[0],firstCopied=cloud.objects.get(firstCopiedKey),folderCopyMutations=cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length;
      await worker('checkFolderCopyHold');assert.equal(cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length,folderCopyMutations,'folder checks must not complete missing copies or delete originals');await worker('shutdown');await worker('restart');
      const folderCopyPuts=cloud.requests.filter(request=>request.method==='PUT').length,folderCopyDeletes=cloud.requests.filter(request=>request.method==='DELETE').length;await worker('finishFolderCopy');await worker('verifyFolderCopyRecovery');
      assert.equal(cloud.requests.filter(request=>request.method==='PUT').length,folderCopyPuts+2,'explicit folder recovery must copy only the two missing objects');assert.equal(cloud.requests.filter(request=>request.method==='DELETE').length,folderCopyDeletes+3,'explicit folder recovery must conditionally delete exactly the three recorded originals');assert.strictEqual(cloud.objects.get(firstCopiedKey),firstCopied,'recovery must not replay the copy whose response was lost');assert.equal(folderObjects('MOVED FOLDER').length,0);assert.deepEqual(cloud.objects.get('Copy recovered folder/payload.bin')?.data,remoteBytes);
      cloud.loseNextDeleteAcknowledgement();await fs.rename(path.join(ownedRoot,'Copy recovered folder'),path.join(ownedRoot,'Delete recovered folder'));
      const folderDeleteDeadline=Date.now()+45000;while(Date.now()<folderDeleteDeadline&&folderObjects('Copy recovered folder').length===3)await new Promise(resolve=>setTimeout(resolve,100));
      assert.equal(folderObjects('Copy recovered folder').length,2,'a lost first deletion response must preserve the remaining originals');assert.equal(folderObjects('Delete recovered folder').length,3,'every destination copy must be verified before the first deletion');const folderDeleteMutations=cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length;
      await worker('checkFolderDeleteHold');assert.equal(cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length,folderDeleteMutations,'read-only recovery must acknowledge the lost deletion without repeating writes');await worker('shutdown');await worker('restart');
      const folderDeletePuts=cloud.requests.filter(request=>request.method==='PUT').length,folderDeletes=cloud.requests.filter(request=>request.method==='DELETE').length;await worker('finishFolderDelete');await worker('verifyFolderDeleteRecovery');
      assert.equal(cloud.requests.filter(request=>request.method==='PUT').length,folderDeletePuts,'delete recovery must not repeat any destination copy');assert.equal(cloud.requests.filter(request=>request.method==='DELETE').length,folderDeletes+2,'delete recovery must delete only the two remaining originals');assert.equal(folderObjects('Copy recovered folder').length,0);assert.deepEqual(cloud.objects.get('Delete recovered folder/payload.bin')?.data,remoteBytes);assert.equal(cloud.objects.get('Delete recovered folder/')?.data.length,0);assert.equal(cloud.objects.get('Delete recovered folder/Empty/.ghost-keep')?.data.length,0);
      const beforeRecoveredOffline=cloud.requests.filter(request=>request.method==='GET'&&request.range).length;assert.deepEqual(await fs.readFile(path.join(ownedRoot,'Delete recovered folder','payload.bin')),remoteBytes);assert.equal((await fs.stat(path.join(ownedRoot,'Delete recovered folder','Empty'))).isDirectory(),true);assert.equal(cloud.requests.filter(request=>request.method==='GET'&&request.range).length,beforeRecoveredOffline,'restarted folder recovery must preserve the complete pinned child cache');
      const emptyDirectoryKey='Delete recovered folder/Empty/',beforeEmptyDelete=cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length;await fs.rmdir(path.join(ownedRoot,'Delete recovered folder','Empty'));await worker('verifyEmptyDirectoryDeletion');assert.equal(cloud.objects.has(emptyDirectoryKey+'.ghost-keep'),false);const emptyDirectoryTrash=[...cloud.objects.entries()].filter(([key])=>key.startsWith('.ghost-trash/')&&key.endsWith('/'+emptyDirectoryKey+'.ghost-keep'));assert.equal(emptyDirectoryTrash.length,1);assert.equal(emptyDirectoryTrash[0][1].data.length,0);assert.equal(cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length,beforeEmptyDelete+2,'an empty folder marker requires exactly one recoverable copy and one conditional deletion');
      const beforeNonemptyDirectoryDelete=cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length;await assert.rejects(fs.rmdir(path.join(ownedRoot,'Delete recovered folder')));assert.equal(cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length,beforeNonemptyDirectoryDelete);assert.deepEqual(cloud.objects.get('Delete recovered folder/payload.bin')?.data,remoteBytes);

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
      assert.equal(cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length,mutationsBeforePinned,'pinned refresh must not modify cloud objects: '+JSON.stringify(cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).slice(mutationsBeforePinned)));
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
      const restoreReads=cloud.requests.filter(request=>request.method==='GET'&&request.range).length;await worker('restorePinnedPartial');assert.deepEqual(await fs.readFile(path.join(ownedRoot,'FINISHED REMOTE.TXT')),pinnedBackupBytes);assert.equal(cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length,mutations,'original restoration must leave the cloud unchanged');assert.equal(cloud.requests.filter(request=>request.method==='GET'&&request.range).length,restoreReads,'restoration must use verified offline original bytes');await worker('shutdown');await worker('restart');await worker('verifyRestoredPinned');assert.deepEqual(await fs.readFile(path.join(ownedRoot,'FINISHED REMOTE.TXT')),pinnedBackupBytes,'restarted daemon must preserve the restored original instead of refreshing or uploading it');assert.equal(cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length,mutations);assert.equal(cloud.requests.filter(request=>request.method==='GET'&&request.range).length,restoreReads);
      await worker('finishPinnedPartial');assert.equal(cloud.requests.filter(request=>['PUT','DELETE'].includes(request.method)).length,mutations,'explicit pinned finishing must leave all cloud objects unchanged');const reads=cloud.requests.filter(request=>request.method==='GET'&&request.range).length;
      assert.deepEqual(await fs.readFile(path.join(ownedRoot,'FINISHED REMOTE.TXT')),next);assert.equal(cloud.requests.filter(request=>request.method==='GET'&&request.range).length,reads,'explicitly finished bytes must be fully offline');
      // No app or IPC sync request runs between these cloud changes and
      // observed local removal: the independent daemon's timer must reconcile.
      const cachedRemote = 'remote cached after exit.bin', unreadRemote = 'remote unread after exit.bin';
      cloud.put(cachedRemote, remoteBytes);cloud.put(unreadRemote, remoteBytes);
      async function waitRemoteFiles(present) {
        const deadline=Date.now()+75000;
        while(Date.now()<deadline){
          const existence=await Promise.all([cachedRemote,unreadRemote].map(async name=>{try{await fs.stat(path.join(ownedRoot,name));return true;}catch(error){if(error.code!=='ENOENT')throw error;return false;}}));
          if(existence.every(value=>value===present))return;
          await new Promise(resolve=>setTimeout(resolve,250));
        }
        assert.fail('Independent daemon did not '+(present?'discover':'remove')+' remote deletion fixtures');
      }
      await waitRemoteFiles(true);assert.deepEqual(await fs.readFile(path.join(ownedRoot,cachedRemote)),remoteBytes);
      assert.equal(cloud.requests.filter(request=>request.range&&request.url.includes('remote%20unread%20after%20exit.bin')).length,0);
      const removalWrites=cloud.writes,removalReads=cloud.requests.filter(request=>request.range).length;
      cloud.objects.delete(cachedRemote);cloud.objects.delete(unreadRemote);await waitRemoteFiles(false);
      assert.equal(cloud.writes,removalWrites,'Remote removal after app exit must not write to the cloud');
      assert.equal(cloud.requests.filter(request=>request.range).length,removalReads,'Remote removal after app exit must not hydrate any file');
      const retained=await worker('verifyRemoteCopies');assert.equal(retained.cachedHash,require('node:crypto').createHash('sha256').update(remoteBytes).digest('hex'));
      await worker('shutdown');await worker('restart');const copies=await worker('verifySavedPinnedCopies'),hash=bytes=>require('node:crypto').createHash('sha256').update(bytes).digest('hex');assert.equal(copies.savedCopiesAfterRestartAndDisconnectVerified,true);assert.equal(copies.savedCopyEntryRemovalPreservesFilesVerified,true);assert.equal(copies.originalHash,hash(pinnedBackupBytes));assert.equal(copies.localHash,hash(partial));
    }
    console.log(JSON.stringify({daemonAuthenticationVerified:true,dpapiIdentityVerified:true,independentProcessVerified:true,gracefulUpdateShutdownVerified:true,restartAfterUpdateShutdownVerified:true,survivesAppProcessExitVerified:true,reconnectWithoutRelaunchVerified:true,...(configured?{configuredCloudVerified:true,hydrationAfterAppExitVerified:true,uploadAfterAppExitVerified:true,remoteAdditionAfterAppExitVerified:true,fileRenameAfterAppExitVerified:true,readOnlyMoveRecoveryVerified:true,explicitMoveCompletionVerified:true,caseOnlyFileRenameVerified:true,emptyDirectoryDeletionAfterAppExitVerified:true,emptyDirectoryTrashMarkerVerified:true,nonemptyDirectoryDeletionRefusedAfterAppExitVerified:true,fileDeletionAfterAppExitVerified:true,fileDeletionTrashBytesVerified:true,fileDeletionCompletionVerified:true,fileDeletionCopyRecoveryAfterRestartVerified:true,fileDeletionSourceRecoveryAfterRestartVerified:true,fileDeletionRestartReadOnlyVerified:true,folderMoveAfterAppExitVerified:true,caseOnlyFolderRenameVerified:true,folderCopyRecoveryAfterRestartVerified:true,folderDeleteRecoveryAfterRestartVerified:true,folderRecoveryRequiresBooleanFinishingVerified:true,folderRecoveryDoesNotReplayConfirmedWrites:true,movedFolderPinnedChildOfflineVerified:true,pinnedRevisionRefreshAfterAppExitVerified:true,pinnedRevisionOfflineReadVerified:true,scheduledNotesBackupAfterAppExitVerified:true,scheduledRecordingBackupAfterAppExitVerified:true,scheduledEditedBackupAfterAppExitVerified:true,scheduledSummaryBackupAfterAppExitVerified:true,scheduledRecordingWhileWriteUpPendingVerified:true,originalPinnedRestorationVerified:true,originalPinnedRestorationAfterRestartVerified:true,originalPinnedRestorationNoCloudWritesVerified:true,explicitPartialPinnedFinishingVerified:true,savedPinnedCopiesAfterRestartAndDisconnectVerified:true,savedCopyEntryRemovalPreservesFilesVerified:true,remoteCachedRemovalAfterAppExitVerified:true,remoteUnhydratedRemovalAfterAppExitVerified:true,remoteRemovalRetainedBytesVerified:true,remoteRemovalNoCloudWritesVerified:true,remoteRemovalNoHydrationVerified:true,hydratedBytes:remoteBytes.length}:{}),pid:daemonPid}));
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
