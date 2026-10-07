const {fingerprintFile}=require('./windows-drive-recovery');
const {revisionFingerprint}=require('./windows-drive-content-proof');
// Called after a local file rename. Both cloud mutations have persisted intents;
// an uncertain response leaves that intent held rather than replaying the write.
async function moveLocalFile({bridge,store,state,from,local,key,signal,fingerprint=fingerprintFile}){
 const tracked=state.snapshot().materialized?.[from];
 if(!tracked||!tracked.etag)throw new Error('The renamed file has no confirmed source revision.');
 if((await bridge.inspect(from)).exists)throw new Error('The original local file still exists; it was preserved.');
 const lock=await bridge.lockUpload(local);
 try{
  if(!lock.cloud||lock.modifiedBytes!==0)throw new Error('Local edits must be synced before moving a cloud file.');
  const previous=JSON.parse(lock.identity);
  if(previous.key!==tracked.key||previous.etag!==tracked.etag||(previous.fileID||null)!==(tracked.fileID||null))throw new Error('The renamed placeholder identifies another source revision.');
  const source=await store.stat(previous.key,signal);
  if(!source||source.etag!==previous.etag||(source.fileID||null)!==(previous.fileID||null)||source.size!==lock.size)throw new Error('The cloud source changed; its original was preserved.');
  if(signal?.aborted)throw new Error('Drive move cancelled.');
  // Cache the complete original while its native read-share lock excludes edits.
  // After a lost delete acknowledgement, the user's bytes remain locally readable.
  const hash=await fingerprint(lock.localPath,signal);
  if(await revisionFingerprint(store,source,signal)!==hash)throw new Error('Local edits must be synced before moving a cloud file.');
  const id=await state.beginMove({from,local,key,previous,size:lock.size,modified:lock.modified,hash});
  await state.setMovePhase(id,'copying');
  const copied=await store.copy(source,key,signal),etag=copied?.CopyObjectResult?.ETag;
  if(!etag)throw new Error('Storage did not identify the move copy; check its recorded outcome.');
  const destination=await store.stat(key,signal);
  if(!destination||destination.size!==lock.size||destination.etag!==etag||(copied.VersionId&&destination.fileID!==copied.VersionId))throw new Error('The move destination changed; both cloud files were preserved.');
  const identity={key,fileID:destination.fileID||null,etag:destination.etag,size:destination.size,modified:Number.isSafeInteger(destination.modified)?destination.modified:lock.modified};
  await state.setMovePhase(id,'copied',{copied:identity});
  if(signal?.aborted)throw new Error('Drive move cancelled after copying; check its recorded outcome.');
  await state.setMovePhase(id,'deleting');
  await store.deleteVersion(previous.key,'',{etag:previous.etag,signal});
  if(await store.stat(previous.key,signal))throw new Error('The cloud source exists after deletion; check the recorded move.');
  await state.setMovePhase(id,'deleted');
  await bridge.ackMove(lock.token,destination,lock.identity,hash);
  await state.setMovePhase(id,'acknowledged');
  await state.completeMove(id,identity);
  return destination;
 }finally{await bridge.unlockUpload(lock.token).catch(()=>{});}
}
module.exports={moveLocalFile};

async function recoverMove({id,bridge,store,state,signal,fingerprint=fingerprintFile,finish=false}){
 const entry=state.snapshot().moves?.[id];if(!entry)return {resolved:true,alreadyResolved:true};
 if(!/^[0-9a-f]{64}$/.test(entry.hash||''))return {resolved:false,reason:'missing-fingerprint'};
 const source=await store.stat(entry.previous.key,signal);
 if(source&&!finish)return {resolved:false,reason:'move-source-still-present'};
 if(source&&(source.etag!==entry.previous.etag||(source.fileID||null)!==(entry.previous.fileID||null)||source.size!==entry.size||!['copying','copied','deleting'].includes(entry.phase)))return {resolved:false,reason:'remote-source-changed'};
 let lock;try{
  lock=await bridge.lockUpload(entry.local);
  if(!lock.cloud||lock.modifiedBytes!==0||lock.size!==entry.size)return {resolved:false,reason:'local-changed'};
  if(await fingerprint(lock.localPath,signal)!==entry.hash)return {resolved:false,reason:'local-changed'};
  const local=JSON.parse(lock.identity),original=local.key===entry.previous.key&&local.etag===entry.previous.etag&&(local.fileID||null)===(entry.previous.fileID||null);
  const remote=await store.stat(entry.key,signal);
  if(!remote||remote.size!==entry.size||!remote.etag)return {resolved:false,reason:'remote-missing-or-changed'};
  const acknowledged=local.key===entry.key&&local.etag===remote.etag&&(local.fileID||null)===(remote.fileID||null);
  if(!original&&!acknowledged)return {resolved:false,reason:'local-identity-changed'};
  if(entry.copied&&(remote.etag!==entry.copied.etag||(remote.fileID||null)!==(entry.copied.fileID||null)))return {resolved:false,reason:'remote-missing-or-changed'};
  const hash=require('node:crypto').createHash('sha256');
  for(let offset=0;offset<remote.size;){const length=Math.min(8*1024*1024,remote.size-offset),bytes=await store.read(entry.key,offset,length,remote.fileID||null,signal,remote.etag);if(bytes.length!==length)throw new Error('Move recovery returned incomplete cloud bytes.');hash.update(bytes);offset+=length;}
  if(hash.digest('hex')!==entry.hash)return {resolved:false,reason:'remote-content-differs'};
  const latest=await store.stat(entry.key,signal);
  if(!latest||latest.etag!==remote.etag||(latest.fileID||null)!==(remote.fileID||null)||latest.size!==remote.size)return {resolved:false,reason:'remote-changed-during-check'};
  const currentSource=await store.stat(entry.previous.key,signal);
  if(currentSource&&(!source||!finish||currentSource.etag!==source.etag||(currentSource.fileID||null)!==(source.fileID||null)||currentSource.size!==source.size))return {resolved:false,reason:'remote-changed-during-check'};
  if(currentSource){
   if(signal?.aborted)throw new Error('Move recovery cancelled.');
   const identity={key:entry.key,fileID:latest.fileID||null,etag:latest.etag,size:latest.size,modified:Number.isSafeInteger(latest.modified)?latest.modified:entry.modified};
   if(entry.phase==='copying')await state.setMovePhase(id,'copied',{copied:identity});
   if(entry.phase!=='deleting')await state.setMovePhase(id,'deleting');
   await store.deleteVersion(entry.previous.key,'',{etag:entry.previous.etag,signal});
   if(await store.stat(entry.previous.key,signal))return {resolved:false,reason:'remote-source-changed'};
   await state.setMovePhase(id,'deleted');
   const confirmed=await store.stat(entry.key,signal);
   if(!confirmed||confirmed.etag!==latest.etag||(confirmed.fileID||null)!==(latest.fileID||null)||confirmed.size!==latest.size)return {resolved:false,reason:'remote-changed-during-check'};
  }
  if(signal?.aborted)throw new Error('Move recovery cancelled.');
  if(original)await bridge.ackMove(lock.token,latest,lock.identity,entry.hash);
  await state.resolveRecoveredMove(id,{key:entry.key,fileID:latest.fileID||null,etag:latest.etag,size:latest.size,modified:Number.isSafeInteger(latest.modified)?latest.modified:entry.modified},entry.hash);
  return {resolved:true,readOnlyCloudCheck:!currentSource};
 }finally{if(lock)await bridge.unlockUpload(lock.token).catch(()=>{});}
}
module.exports.recoverMove=recoverMove;
