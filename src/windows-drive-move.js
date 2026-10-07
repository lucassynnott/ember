const {fingerprintFile}=require('./windows-drive-recovery');
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
  await bridge.ackMove(lock.token,destination,lock.identity);
  await state.setMovePhase(id,'acknowledged');
  await state.completeMove(id,identity);
  return destination;
 }finally{await bridge.unlockUpload(lock.token).catch(()=>{});}
}
module.exports={moveLocalFile};
