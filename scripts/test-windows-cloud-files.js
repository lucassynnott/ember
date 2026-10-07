const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {WindowsDriveCache}=require('../src/windows-drive-cache');
const {populateInitialNamespace}=require('../src/windows-drive-namespace');
const crypto=require('node:crypto');const {WindowsCloudFiles}=require('../src/windows-cloud-files');
async function main(){
  assert.equal(process.platform,'win32','Cloud Files acceptance requires Windows');
  // Exercise the same user-profile location as the production Ember Drive root.
  // Runner work/temp volumes have different shell indexing and folder policy.
  const root=await fs.mkdtemp(path.join(os.homedir(),'Ember Drive Acceptance - '));
  const helper=path.resolve('native/windows/bin/meeting-notes-hotkey.exe');
  let data=crypto.randomBytes(8*1024*1024+123),remoteRevision='fixture-version',remoteETag='"fixture-etag"';const reads=[];
  const identity='ember-fixture-'+crypto.randomUUID();let active,foreign,backupStaging,pinnedStaging;
  const store={listAll:async()=>[...['remote/Café.txt','remote/Nested/inside.txt'].map(name=>({name,kind:'file',size:data.length,modified:Date.now(),fileID:remoteRevision,etag:remoteETag})),{name:'empty/.ghost-keep',kind:'file',size:0,modified:Date.now(),etag:'"empty-marker"'}],read:async(key,offset,length,version,signal,etag)=>{
    assert.ok(['remote/Café.txt','remote/Nested/inside.txt','remote/Moved.txt'].includes(key));assert.equal(version,remoteRevision);assert.equal(etag,remoteETag);assert.equal(signal.aborted,false);
    reads.push({offset,length});return data.subarray(offset,offset+length);
  }};
  const connect=()=>new WindowsCloudFiles({store,helper,timeoutMs:45000});
  const deadline=setTimeout(()=>{active?.close();foreign?.close();console.error('Windows Cloud Files acceptance timed out');process.exit(1);},90000);
  try {
    active=connect();let explorer;
    try{explorer=await active.prepareExplorer(root,identity);}
    catch(error){
      // Observe from another process before and after starting the actual shell.
      // Keep the failed registration gate red; these probes do not replace proof.
      const probe=async label=>{
        const observer=connect();try{console.log(JSON.stringify({explorerProbe:label,result:await observer.command('explorerProbe',{folder:root,identity})}));}
        catch(probeError){console.log(JSON.stringify({explorerProbe:label,error:probeError.message}));}finally{observer.close();}
      };
      await probe('fresh-process-before-shell');
      const {spawnSync}=require('node:child_process');
      const shell=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','Write-Output ("Explorer processes before: " + @(Get-Process explorer -ErrorAction SilentlyContinue).Count); Start-Process -FilePath "$env:WINDIR\\explorer.exe" -ArgumentList $env:EMBER_EXPLORER_TEST_ROOT; Start-Sleep -Seconds 3; Write-Output ("Explorer processes after: " + @(Get-Process explorer -ErrorAction SilentlyContinue).Count)'],{env:{...process.env,EMBER_EXPLORER_TEST_ROOT:root},encoding:'utf8',timeout:15000,windowsHide:true});
      console.log(JSON.stringify({explorerShellProbe:{status:shell.status,error:shell.error?.message,stdout:shell.stdout,stderr:shell.stderr}}));
      await probe('fresh-process-after-shell');throw error;
    }
    assert.equal(explorer.registered,true);await active.register(root,identity);
    assert.equal((await active.explorerStatus()).registered,true);assert.equal(path.resolve(explorer.path).toLowerCase(),path.resolve(root).toLowerCase());assert.equal((await active.explorerStatus()).id,explorer.id);assert.equal((await active.explorerRegister()).id,explorer.id,'repeated registration must preserve the same root');
    await assert.rejects(active.command('explorerProbe',{folder:root+'.different',identity}),/different Drive root/);
    assert.equal((await active.explorerStatus()).registered,true,'a mismatched path must preserve the owned registration');
    assert.equal((await active.command('explorerProbe',{folder:root,identity:'different-provider'})).explorer.registered,false,'a different identity must not claim the owned shell registration');
    await assert.rejects(active.create('../escape.txt',{name:'remote/Café.txt',size:data.length,modified:Date.now(),fileID:remoteRevision,etag:remoteETag}),/Invalid Windows placeholder name/);
    let persistedMappings;await populateInitialNamespace(active,store,{saveMappings:async mappings=>{persistedMappings=mappings;}});
    assert.ok(persistedMappings['remote/']);
    assert.ok((await fs.stat(path.join(root,'empty'))).isDirectory());assert.equal((await active.inspect('empty')).directory,true);
    const local=path.join(root,'remote','Café.txt');assert.equal((await fs.stat(local)).size,data.length);assert.equal(reads.length,0,'metadata inspection must not hydrate');
    foreign=connect();await assert.rejects(foreign.register(root,'different-provider'),/another sync root/);foreign.close();foreign=null;
    await active.command('disconnect');active.close();
    active=connect();await active.register(root,identity);
    assert.equal((await active.explorerStatus()).registered,true,'disconnect must retain the Explorer registration');
    const resumed=await populateInitialNamespace(active,store,{mappings:persistedMappings});
    assert.equal(resumed.created,0);assert.equal(resumed.conflicts.length,0);assert.ok(resumed.existing>=5);
    const metadata=await active.inspect('remote/Café.txt');assert.equal(metadata.cloud,true);assert.equal(metadata.inSync,true);assert.equal(reads.length,0,'inspection and reconciliation must not hydrate');
    assert.deepEqual(await fs.readFile(local),data,'NTFS read must hydrate correct file bytes');
    assert.ok(reads.length>=2,'hydration should stream bounded chunks');assert.ok(reads.every(read=>read.length<=8*1024*1024&&read.offset%4096===0));
    assert.deepEqual(await fs.readFile(path.join(root,'remote','Nested','inside.txt')),data,'nested placeholder hydration');
    const count=reads.length;assert.deepEqual(await fs.readFile(local),data);assert.equal(reads.length,count,'hydrated file should serve from local storage');
    const pinned=await active.pin('remote/Café.txt');assert.equal(pinned.pinState,1);assert.ok(pinned.onDiskBytes>=data.length);
    await assert.rejects(active.dehydrate('remote/Café.txt'),/Pinned files/);
    pinnedStaging=await fs.mkdtemp(path.join(os.tmpdir(),'ember-pinned-native-'));
    const oldPinnedBytes=Buffer.from(data),newPinnedBytes=Buffer.from(data);newPinnedBytes[18]^=255;
    const newPinnedFile=path.join(pinnedStaging,'content'),oldPinnedFile=path.join(pinnedStaging,'previous');await fs.writeFile(newPinnedFile,newPinnedBytes,{flag:'wx'});
    const pinnedLock=await active.lockPinnedUpdate('remote/Café.txt'),pinnedUpdateId=crypto.randomUUID(),newPinnedHash=crypto.createHash('sha256').update(newPinnedBytes).digest('hex');
    try{
      assert.equal(pinnedLock.pinState,1);assert.equal(pinnedLock.inSync,true);
      await assert.rejects(fs.readFile(local),'exclusive pinned replacement must deny competing data reads');await assert.rejects(fs.writeFile(local,Buffer.from('must not overwrite pinned bytes')));
      const offline=await active.capturePinnedBackup(pinnedLock.token,{updateId:pinnedUpdateId,backup:oldPinnedFile,expectedIdentity:pinnedLock.identity,size:data.length});
      assert.equal(offline.hash,crypto.createHash('sha256').update(oldPinnedBytes).digest('hex'));assert.deepEqual(await fs.readFile(oldPinnedFile),oldPinnedBytes);
      const options={updateId:pinnedUpdateId,source:newPinnedFile,backup:oldPinnedFile,expectedIdentity:pinnedLock.identity,hash:newPinnedHash,size:newPinnedBytes.length,previousHash:offline.hash,previousSize:offline.size};
      await assert.rejects(active.replacePinned(pinnedLock.token,{...options,hash:'0'.repeat(64)}),/content changed/);
      await assert.rejects(active.replacePinned(pinnedLock.token,{...options,previousHash:'0'.repeat(64)}),/content changed/);
      assert.equal((await active.fingerprintPinned(pinnedLock.token,{updateId:pinnedUpdateId})).hash,offline.hash,'bad proofs must preserve all original offline bytes');
      await assert.rejects(active.ackUpload(pinnedLock.token,{name:'remote/Café.txt',etag:'"wrong"'}),/own acknowledgement/);
      assert.deepEqual(await active.replacePinned(pinnedLock.token,options),{hash:newPinnedHash,size:newPinnedBytes.length});
      assert.equal((await active.fingerprintPinned(pinnedLock.token,{updateId:pinnedUpdateId})).hash,newPinnedHash);
      data=newPinnedBytes;remoteRevision='pinned-new-version';remoteETag='"pinned-new-etag"';
      await active.ackPinnedUpdate(pinnedLock.token,{name:'remote/Café.txt',fileID:remoteRevision,etag:remoteETag},pinnedLock.identity,newPinnedHash);
      const confirmed=await active.fingerprintPinned(pinnedLock.token,{updateId:pinnedUpdateId}),info=confirmed.placeholder,diagnostic=JSON.stringify(confirmed);
      assert.equal(confirmed.hash,newPinnedHash,diagnostic);assert.equal(confirmed.size,newPinnedBytes.length,diagnostic);
      assert.equal(info.cloud,true,diagnostic);assert.equal(info.inSync,true,diagnostic);assert.equal(info.pinState,1,diagnostic);assert.equal(info.modifiedBytes,0,diagnostic);assert.ok(info.onDiskBytes>=newPinnedBytes.length,diagnostic);
      assert.equal(JSON.parse(info.identity).fileID,remoteRevision,diagnostic);

    }finally{await active.unlockUpload(pinnedLock.token);}
    const refreshedPin=await active.inspect('remote/Café.txt');assert.equal(refreshedPin.pinState,1);assert.equal(refreshedPin.inSync,true);assert.equal(JSON.parse(refreshedPin.identity).fileID,remoteRevision);assert.ok(refreshedPin.onDiskBytes>=data.length);
    const beforePinnedOfflineRead=reads.length;assert.deepEqual(await fs.readFile(local),data);assert.equal(reads.length,beforePinnedOfflineRead,'new pinned revision must remain readable without any cloud request');assert.deepEqual(await fs.readFile(oldPinnedFile),oldPinnedBytes,'replacement must keep the complete prior revision available for recovery');

    const cacheEntries={};for(const name of ['remote/Café.txt','remote/Nested/inside.txt'])cacheEntries[name]=JSON.parse((await active.inspect(name)).identity);
    const cache=new WindowsDriveCache({bridge:active,state:{snapshot:()=>({materialized:cacheEntries,uploads:{},cacheLimitGB:5})}});
    const beforeCacheRead=reads.length,cacheReport=await cache.inspect();assert.ok(cacheReport.pinnedBytes>=data.length);assert.ok(cacheReport.bytes>=data.length);assert.equal(reads.length,beforeCacheRead,'cache metadata must not hydrate');
    const cacheClear=await cache.enforce({clear:true});assert.deepEqual(cacheClear.evicted,['remote/Nested/inside.txt']);assert.equal(cacheClear.bytes,0);assert.equal(cacheClear.complete,true);assert.equal((await active.inspect('remote/Nested/inside.txt')).onDiskBytes,0);assert.ok((await active.inspect('remote/Café.txt')).onDiskBytes>=data.length,'cache clearing must preserve pins');
    await active.unpin('remote/Café.txt');await active.dehydrate('remote/Café.txt');
    assert.equal((await active.inspect('remote/Café.txt')).onDiskBytes,0);
    const beforeRefetch=reads.length;assert.deepEqual(await fs.readFile(local),data);assert.ok(reads.length>beforeRefetch,'dehydrated file must re-fetch cloud bytes');
    const previous=(await active.inspect('remote/Café.txt')).identity;
    data=Buffer.from(data);data[1]^=255;remoteRevision='new-remote-version';remoteETag='"new-remote-etag"';
    await active.refresh('remote/Café.txt',{name:'remote/Café.txt',size:data.length,modified:Date.now(),fileID:remoteRevision,etag:remoteETag},previous);
    assert.equal((await active.inspect('remote/Café.txt')).onDiskBytes,0);
    assert.deepEqual(await fs.readFile(local),data,'remote refresh must hydrate the changed revision');
    cacheEntries['remote/Café.txt']=JSON.parse((await active.inspect('remote/Café.txt')).identity);
    const edited=Buffer.from(data);edited[0]^=255;await fs.writeFile(local,edited);
    await assert.rejects(active.dehydrate('remote/Café.txt'),/Local edits/);assert.deepEqual(await fs.readFile(local),edited,'eviction must preserve local edits');
    const dirtyCache=await cache.enforce({clear:true});assert.equal(dirtyCache.evicted.length,0);assert.equal(dirtyCache.complete,false);assert.deepEqual(await fs.readFile(local),edited,'cache coordinator must preserve local edits');
    const upload=await active.lockUpload('remote/Café.txt');
    try {
      await assert.rejects(fs.writeFile(local,Buffer.from('must not change while locked')));
      await assert.rejects(fs.rename(local,local+'.renamed'));await assert.rejects(fs.unlink(local));
      assert.deepEqual(await fs.readFile(local),edited,'upload lock must preserve the snapshot');
      data=edited;remoteRevision='uploaded-version';remoteETag='"uploaded-etag"';
      await active.ackUpload(upload.token,{name:'remote/Café.txt',fileID:remoteRevision,etag:remoteETag});
    }finally{await active.unlockUpload(upload.token);}
    assert.equal((await active.inspect('remote/Café.txt')).inSync,true);
    await active.dehydrate('remote/Café.txt');assert.deepEqual(await fs.readFile(local),edited,'acknowledged upload must hydrate its confirmed revision');
    await fs.mkdir(path.join(root,'new empty folder'));const newDirectory=await active.inspect('new empty folder');assert.equal(newDirectory.directory,true);assert.equal(newDirectory.cloud,false);
    const added=path.join(root,'new local.txt');await fs.writeFile(added,'New local file');
    const newUpload=await active.lockUpload('new local.txt');assert.equal(newUpload.cloud,false);
    try{await active.ackUpload(newUpload.token,{name:'uploaded/new local.txt',etag:'"new-local-revision"'});}finally{await active.unlockUpload(newUpload.token);}
    assert.equal((await active.inspect('new local.txt')).cloud,true);assert.equal((await active.inspect('new local.txt')).inSync,true);assert.equal(await fs.readFile(added,'utf8'),'New local file');
    backupStaging=await fs.mkdtemp(path.join(os.tmpdir(),'ember-cloud-backup-source-'));const backupSource=path.join(backupStaging,'source');await fs.writeFile(backupSource,data);const backupHash=crypto.createHash('sha256').update(data).digest('hex');
    const backupIdentity=JSON.parse((await active.inspect('new local.txt')).identity);
    const copiedBackup=await active.copyBackup('new local.txt',backupSource,{backupId:crypto.randomUUID(),expectedIdentity:backupIdentity,hash:backupHash,size:data.length});assert.equal(copiedBackup.hash,backupHash);assert.deepEqual(await fs.readFile(added),data,'native backup must copy the complete staged snapshot');
    const copiedInfo=await active.inspect('new local.txt');if(copiedInfo.cloud)assert.equal(copiedInfo.inSync,false,'backup replacement must remain unsynced before upload');
    await assert.rejects(active.copyBackup('new local.txt',backupSource,{backupId:crypto.randomUUID(),expectedIdentity:backupIdentity,hash:backupHash,size:data.length}),/Local edits/);assert.deepEqual(await fs.readFile(added),data,'dirty backup replacement must preserve local bytes');
    await active.copyBackup('new backup.txt',backupSource,{backupId:crypto.randomUUID(),hash:backupHash,size:data.length});assert.deepEqual(await fs.readFile(path.join(root,'new backup.txt')),data,'native backup must create a complete new file');
    const movedLocal=path.join(root,'remote','Moved.txt');await fs.rename(local,movedLocal);
    const moveLock=await active.lockUpload('remote/Moved.txt');assert.equal(moveLock.cloud,true);assert.equal(moveLock.modifiedBytes,0);
    const moveHash=crypto.createHash('sha256').update(data).digest('hex');
    const moveDestination={name:'remote/Moved.txt',fileID:'moved-version',etag:'"moved-etag"'};
    try{
      await assert.rejects(active.ackMove(moveLock.token,moveDestination,'wrong-source-identity',moveHash),/source identity/);
      await assert.rejects(active.ackUpload(moveLock.token,moveDestination),/cannot change the remote key/);
      await assert.rejects(active.ackMove(moveLock.token,moveDestination,moveLock.identity),/content fingerprint/);
      await assert.rejects(active.ackMove(moveLock.token,moveDestination,moveLock.identity,'0'.repeat(64)),/local file changed/);
      remoteRevision=moveDestination.fileID;remoteETag=moveDestination.etag;
      await active.ackMove(moveLock.token,moveDestination,moveLock.identity,moveHash);
    }finally{await active.unlockUpload(moveLock.token);}
    const movedInfo=await active.inspect('remote/Moved.txt');assert.equal(movedInfo.inSync,true);assert.equal(JSON.parse(movedInfo.identity).key,moveDestination.name);
    assert.deepEqual(await fs.readFile(movedLocal),data,'moving must preserve the resident file bytes');
    await active.dehydrate('remote/Moved.txt');assert.deepEqual(await fs.readFile(movedLocal),data,'moved placeholders must hydrate through their confirmed new object identity');
    const movedEdit=Buffer.from(data);movedEdit[0]^=255;
    const editHandle=await fs.open(movedLocal,'r+');try{await editHandle.write(movedEdit.subarray(0,1),0,1,0);await editHandle.sync();}finally{await editHandle.close();}
    const dirtyMoveLock=await active.lockUpload('remote/Moved.txt');
    try{assert.ok(!dirtyMoveLock.inSync||dirtyMoveLock.modifiedBytes>0);await assert.rejects(active.ackMove(dirtyMoveLock.token,{name:'remote/Another.txt',etag:'"another"'},dirtyMoveLock.identity,moveHash),/local file changed/);assert.deepEqual(await fs.readFile(movedLocal),movedEdit,'a refused dirty move must preserve local edits');}
    finally{await active.unlockUpload(dirtyMoveLock.token);}
    // Truncating writes may remove the Cloud Files identity entirely. A held
    // ordinary-file replacement must still never be acknowledged as a move.
    await fs.writeFile(movedLocal,movedEdit);
    const replacementMoveLock=await active.lockUpload('remote/Moved.txt');
    try{await assert.rejects(active.ackMove(replacementMoveLock.token,{name:'remote/Replacement.txt',etag:'"replacement"'},replacementMoveLock.identity,moveHash),/local file changed/);assert.deepEqual(await fs.readFile(movedLocal),movedEdit);}
    finally{await active.unlockUpload(replacementMoveLock.token);}

    const explorerUI=process.env.EMBER_VERIFY_EXPLORER_UI==='1'?await require('./windows-drive-explorer-acceptance').verifyExplorer(root):null;
    await active.unregister();
    console.log(JSON.stringify({windowsCloudFiles:'passed',nativePlaceholder:true,metadataWithoutHydration:true,identityOwnership:true,reconnect:true,hydratedBytes:data.length,rangeRequests:reads.length,localCachedRead:true,pinVerified:true,pinnedRevisionReplacementVerified:true,pinnedOfflineBackupVerified:true,dehydrateVerified:true,dirtyFilePreserved:true,remoteRefreshVerified:true,uploadLockVerified:true,uploadAcknowledgementVerified:true,newLocalConversionVerified:true,nativeMoveAcknowledgementVerified:true,movedRevisionHydrationVerified:true,dirtyMovePreserved:true,replacedMovePreserved:true,cacheAccountingVerified:true,cacheClearPreservesPinsAndEdits:true,ordinaryDirectoryMetadataVerified:true,nativeBackupCopyVerified:true,dirtyBackupPreserved:true,explorerRegistrationVerified:true,explorerReconnectVerified:true,...(explorerUI?{visibleExplorerNavigationVerified:true}:{} )}));
  }finally{clearTimeout(deadline);foreign?.close();if(active&&!active.closed){try{await active.unregister();}catch{}active.close();}await fs.rm(root,{recursive:true,force:true});if(backupStaging)await fs.rm(backupStaging,{recursive:true,force:true});if(pinnedStaging)await fs.rm(pinnedStaging,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
