const fs=require('node:fs/promises');const path=require('node:path');const {validLocal}=require('./windows-drive-names');const {fingerprintFile}=require('./windows-drive-recovery');
async function backUpFile({root,file,relative,state,bridge,signal}){
  if(!root)return false;
  if(typeof relative!=='string'||!relative||path.posix.isAbsolute(relative)||path.win32.isAbsolute(relative))throw new Error('Invalid backup path.');
  const parts=relative.replaceAll('\\','/').split('/');if(parts.some(part=>!part||part==='.'||part==='..'||/[\x00-\x1f]/.test(part)))throw new Error('Invalid backup path.');
  let source;try{source=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return false;throw error;}
  if(!source.isFile()||source.isSymbolicLink())throw new Error('Backups require a regular source file without links.');
  const key='Ember/'+parts.join('/'),local=await state.reserveRemoteFile(key),target=path.join(root,...local.split('/'));
  if(local.split('/').some(part=>!validLocal(part)))throw new Error('Invalid mapped backup path.');
  const rootInfo=await fs.lstat(root);if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())throw new Error('Backup root is not a directory without links.');
  let parent=root;
  for(const component of local.split('/').slice(0,-1)){
    parent=path.join(parent,component);try{await fs.mkdir(parent);}catch(error){if(error.code!=='EEXIST')throw error;}
    const directory=await fs.lstat(parent);if(!directory.isDirectory()||directory.isSymbolicLink())throw new Error('A backup parent is not a directory without links.');
  }
  const existing=await bridge.inspect(local);let previous=null;
  if(existing.exists){
    const identity=state.snapshot().materialized[local];
    if(!existing.cloud||existing.directory||!existing.inSync||existing.modifiedBytes!==0||!identity||identity.key!==key)throw new Error('Local edits or another file prevent replacing this backup.');
    previous=JSON.parse(existing.identity);
    if(previous.key!==key||previous.etag!==identity.etag||previous.fileID!==(identity.fileID||null))throw new Error('The backup revision changed; the existing file was preserved.');
    const targetInfo=await fs.stat(target);if(targetInfo.size===source.size&&targetInfo.mtimeMs>=source.mtimeMs)return false;
  }
  const stagingRoot=path.join(state.directory,'backups');await fs.mkdir(stagingRoot,{recursive:true});if((await fs.lstat(stagingRoot)).isSymbolicLink())throw new Error('Backup staging cannot be a link.');
  const staging=await fs.mkdtemp(path.join(stagingRoot,'copy-')),snapshot=path.join(staging,'source');let journal=null,complete=false;
  try {
    await fs.copyFile(file,snapshot);const after=await fs.lstat(file);if(!after.isFile()||after.isSymbolicLink()||after.size!==source.size||after.mtimeMs!==source.mtimeMs)throw new Error('The backup source changed while it was copied.');
    const hash=await fingerprintFile(snapshot,signal);
    journal=await state.beginBackup({local,key,source:snapshot,size:source.size,modified:source.mtimeMs,hash});
    const result=await bridge.copyBackup(local,snapshot,{backupId:journal,expectedIdentity:previous,size:source.size,hash,signal});
    if(result.hash!==hash||result.size!==source.size)throw new Error('Native backup copying was not confirmed; its intent was preserved.');
    if(signal?.aborted)throw new Error('Backup cancelled after copying; check its recorded outcome.');
    await state.completeBackup(journal,hash);complete=true;return true;
  }finally{if(!journal||complete)await fs.rm(staging,{recursive:true,force:true});}
}
async function recoverBackUpFile({id,state,bridge,signal}){
  const entry=state.snapshot().backups?.[id];if(!entry)return {resolved:true,alreadyResolved:true};let lock;
  try {
    lock=await bridge.lockUpload(entry.local);if(lock.cloud&&JSON.parse(lock.identity).key!==entry.key)return {resolved:false,reason:'backup-identity-changed'};
    if(lock.size!==entry.size||await fingerprintFile(lock.localPath,signal)!==entry.hash)return {resolved:false,reason:'backup-content-differs'};
    if(signal?.aborted)throw new Error('Backup recovery cancelled.');await state.completeBackup(id,entry.hash);
    const staging=path.dirname(entry.source),relative=path.relative(path.join(state.directory,'backups'),staging);
    if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&path.basename(staging).startsWith('copy-')&&path.basename(entry.source)==='source')await fs.rm(staging,{recursive:true,force:true});
    return {resolved:true,localCopyVerified:true};
  }finally{if(lock)await bridge.unlockUpload(lock.token).catch(()=>{});}
}
module.exports={backUpFile,recoverBackUpFile};
