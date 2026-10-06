const fs=require('node:fs/promises');const path=require('node:path');const {validLocal}=require('./windows-drive-names');
async function localFolder(root,local,bridge){
  if(typeof local!=='string'||local.split('/').some(part=>!validLocal(part)))throw new Error('Invalid local Drive folder.');
  const info=await bridge.inspect(local);if(!info.exists)throw new Error('The local Drive folder is missing.');
  const stat=await fs.lstat(path.join(root,...local.split('/')));if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Folder sync requires a directory without links.');
}
function markerProof(value,name){return value?.name===name&&value.size===0&&typeof value.etag==='string'&&value.etag.length>0;}
async function syncLocalFolder({root,local,key,bridge,state,store,signal}){
  if(typeof key!=='string'||!key.endsWith('/')||Buffer.byteLength(key+'.ghost-keep')>1024)throw new Error('Invalid cloud Drive folder name.');
  await localFolder(root,local,bridge);
  const id=await state.beginFolderUpload(local,key),marker=key+'.ghost-keep';
  // A durable intent is written before storage access. An uncertain PUT holds
  // subsequent scans until read-only recovery confirms the folder marker.
  let proof=await store.stat(marker,signal);
  if(!proof){
    const uploaded=await store.putEmpty(marker,signal,{ifNoneMatch:'*'});
    proof=await store.stat(marker,signal);
    if(!uploaded?.ETag||proof?.etag!==uploaded.ETag||(uploaded.VersionId&&proof.fileID!==uploaded.VersionId))throw new Error('The folder marker upload was not confirmed; its intent was preserved.');
  }
  if(!markerProof(proof,marker))throw new Error('The cloud folder marker contains unexpected content; it was preserved.');
  if(signal?.aborted)throw new Error('Folder sync cancelled; check the recorded outcome before retrying.');
  await state.completeFolderUpload(id,proof);return proof;
}
async function recoverLocalFolder({id,root,bridge,state,store,signal}){
  const entry=state.snapshot().folderUploads?.[id];if(!entry)return {resolved:true,alreadyResolved:true};
  await localFolder(root,entry.local,bridge);const proof=await store.stat(entry.marker,signal);
  if(!markerProof(proof,entry.marker))return {resolved:false,reason:'folder-marker-missing-or-changed'};
  if(signal?.aborted)throw new Error('Folder recovery cancelled.');
  await state.completeFolderUpload(id,proof);return {resolved:true,readOnlyCloudCheck:true};
}
module.exports={syncLocalFolder,recoverLocalFolder};
