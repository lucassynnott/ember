const {fingerprintFile}=require('./windows-drive-recovery');
async function uploadLocalFile({bridge,store,state,local,key,signal,progress=()=>{},fingerprint=fingerprintFile}){
  const lock=await bridge.lockUpload(local);
  try {
    let previous=null;
    if(lock.cloud){previous=JSON.parse(lock.identity);if(previous.key!==key)throw new Error('The local file identifies another remote object.');if(!previous.etag)throw new Error('The original cloud revision is unknown; local edits were preserved.');}
    if(!lock.cloud&&state.snapshot){
      const tracked=state.snapshot().materialized||{};
      if(Object.prototype.hasOwnProperty.call(tracked,local)){
        previous=tracked[local];
        if(previous.key!==key||!previous.etag)throw new Error('The tracked local replacement has no matching cloud revision; it was preserved.');
      }
    }
    if(signal?.aborted)throw new Error('Drive upload cancelled.');
    const hash=await fingerprint(lock.localPath,signal);
    const journal=await state.beginUpload({local,key,size:lock.size,modified:lock.modified,previous,hash});
    await state.setUploadPhase(journal,'sending');
    // The native read-share lock prevents writes and renames until acknowledgement.
    // Conditional completion preserves a concurrently changed cloud object.
    const uploaded=await store.upload(lock.localPath,key,{mtime:lock.modified,signal,progress,...(previous?{ifMatch:previous.etag}:{ifNoneMatch:'*'})});
    if(!uploaded?.ETag)throw new Error('Cloud storage did not identify the uploaded revision. Check the file before retrying.');
    await state.setUploadPhase(journal,'uploaded',{uploaded:{etag:uploaded.ETag,fileID:uploaded.VersionId||null}});
    const confirmed=await store.stat(key,signal);
    if(!confirmed||confirmed.size!==lock.size||confirmed.etag!==uploaded.ETag||(uploaded.VersionId&&confirmed.fileID!==uploaded.VersionId))throw new Error('The remote file changed after upload; local edits were preserved.');
    if(signal?.aborted)throw new Error('Drive upload cancelled after transfer; check the remote file before retrying.');
    await state.setUploadPhase(journal,'confirmed',{confirmed:{key,fileID:confirmed.fileID||null,etag:confirmed.etag}});
    await bridge.ackUpload(lock.token,confirmed);
    await state.completeUpload(journal,local,{key,fileID:confirmed.fileID||null,etag:confirmed.etag,size:confirmed.size,modified:Number.isSafeInteger(confirmed.modified)?confirmed.modified:lock.modified});
    return confirmed;
  }finally{await bridge.unlockUpload(lock.token).catch(()=>{});}
}
module.exports={uploadLocalFile};
