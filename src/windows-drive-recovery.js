const fs=require('node:fs');const crypto=require('node:crypto');
async function fingerprintFile(file,signal){
  const hash=crypto.createHash('sha256'),stream=fs.createReadStream(file,{signal});
  try{for await(const chunk of stream)hash.update(chunk);return hash.digest('hex');}finally{stream.destroy();}
}
async function recoverUpload({id,bridge,store,state,signal,fingerprint=fingerprintFile}){
  const entry=state.snapshot().uploads?.[id];if(!entry)return {resolved:true,alreadyResolved:true};
  if(!/^[0-9a-f]{64}$/.test(entry.hash||''))return {resolved:false,reason:'missing-fingerprint'};
  let lock;
  try{
    lock=await bridge.lockUpload(entry.local);
    if(lock.size!==entry.size||await fingerprint(lock.localPath,signal)!==entry.hash)return {resolved:false,reason:'local-changed'};
    if(lock.cloud&&JSON.parse(lock.identity).key!==entry.key)return {resolved:false,reason:'local-identity-changed'};
    const remote=await store.stat(entry.key,signal);
    if(!remote||remote.size!==entry.size||!remote.etag)return {resolved:false,reason:'remote-missing-or-changed'};
    const hash=crypto.createHash('sha256');
    for(let offset=0;offset<remote.size;){
      const length=Math.min(8*1024*1024,remote.size-offset),bytes=await store.read(entry.key,offset,length,remote.fileID||null,signal,remote.etag);
      if(bytes.length!==length)throw new Error('Cloud recovery read returned incomplete bytes.');hash.update(bytes);offset+=length;
    }
    if(hash.digest('hex')!==entry.hash)return {resolved:false,reason:'remote-content-differs'};
    const current=await store.stat(entry.key,signal);
    if(!current||current.etag!==remote.etag||current.fileID!==remote.fileID||current.size!==remote.size)return {resolved:false,reason:'remote-changed-during-check'};
    if(signal?.aborted)throw new Error('Upload recovery cancelled.');
    await bridge.ackUpload(lock.token,current);
    await state.resolveRecoveredUpload(id,entry.local,{key:entry.key,fileID:current.fileID||null,etag:current.etag,size:current.size,modified:Number.isSafeInteger(current.modified)?current.modified:entry.modified},entry.hash);
    return {resolved:true,readOnlyCloudCheck:true};
  }finally{if(lock)await bridge.unlockUpload(lock.token).catch(()=>{});}
}
module.exports={fingerprintFile,recoverUpload};
