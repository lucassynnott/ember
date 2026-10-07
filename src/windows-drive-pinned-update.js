const fs=require('node:fs/promises');const path=require('node:path');const {stageRevision}=require('./windows-drive-staging');const {fingerprintFile}=require('./windows-drive-recovery');const {WindowsPinnedUpdateJournal}=require('./windows-drive-pinned-journal');
const identity=object=>({key:object.name??object.key,etag:object.etag,fileID:object.fileID||null,size:object.size,modified:object.modified});
const same=(a,b)=>a&&b&&a.key===b.key&&a.etag===b.etag&&(a.fileID||null)===(b.fileID||null)&&a.size===b.size;
function lockedIdentity(lock){return lock.cloud?{...JSON.parse(lock.identity),size:lock.size}:null;}
async function cleanup(state,entry){
 const expected=await fs.realpath(path.join(state.directory,'pinned-revisions')),directory=entry.staged.directory;
 if(!/^revision-[a-zA-Z0-9_-]+$/.test(path.basename(directory)))return;
 let info;try{info=await fs.lstat(directory);}catch(error){if(error.code==='ENOENT')return;throw error;}if(!info.isDirectory()||info.isSymbolicLink())return;
 if(await fs.realpath(path.dirname(directory))!==await fs.realpath(expected))return;
 for(const proof of [entry.staged,entry.backup].filter(Boolean)){
  if(!['content','previous'].includes(path.basename(proof.file))||path.dirname(proof.file)!==directory)continue;
  try{const stat=await fs.lstat(proof.file);if(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===proof.size&&await fingerprintFile(proof.file)===proof.hash)await fs.unlink(proof.file);}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 await fs.rmdir(directory).catch(()=>{});
}
async function checkRemote(store,expected,signal){const object=await store.stat(expected.key,signal);if(!same(identity(object||{}),expected))throw new Error('The cloud pinned revision changed; recovery files were preserved.');return object;}
function verifyPinned(proof,expected,hash){
 const info=proof?.placeholder;let reason=null;
 if(proof?.hash!==hash||proof?.size!==expected.size)reason='the complete local bytes differ from the downloaded revision';
 else if(!info?.cloud)reason='the file is no longer a cloud placeholder';
 else if(!info.inSync)reason='Windows still marks the file as unsynced';
 else if(info.pinState!==1)reason='Windows did not retain its offline pin';
 else if(info.modifiedBytes!==0)reason='Windows still reports modified bytes';
 else if(!Number.isSafeInteger(info.onDiskBytes)||info.onDiskBytes<expected.size)reason='Windows did not confirm every byte is cached';
 else{try{if(!same({...JSON.parse(info.identity),size:proof.size},expected))reason='the placeholder identifies a different revision';}catch{reason='the placeholder identity is invalid';}}
 if(reason)throw new Error('Pinned verification failed: '+reason+'; recovery files were preserved.');
}
async function replacePinnedRevision({local,object,root,bridge,store,state,signal}){
 const previous=state.snapshot().materialized?.[local];if(!previous||previous.key!==object?.name)throw new Error('Pinned replacement has no matching recorded source.');
 const journal=new WindowsPinnedUpdateJournal(state);let staged,lock,id;
 try{
  staged=await stageRevision({store,object,directory:path.join(state.directory,'pinned-revisions'),driveRoot:root,signal});
  lock=await bridge.lockPinnedUpdate(local);if(!lock.cloud||!lock.inSync||lock.pinState!==1||lock.modifiedBytes!==0||!same(lockedIdentity(lock),previous))throw new Error('Local pinned edits or another revision prevent replacement.');
  await checkRemote(store,staged.identity,signal);if(signal?.aborted)throw new Error('Pinned replacement cancelled.');
  id=await journal.begin({local,previous,staged});
  const backup=await bridge.capturePinnedBackup(lock.token,{updateId:id,backup:path.join(staged.directory,'previous'),expectedIdentity:lock.identity,size:lock.size,signal});
  await journal.recordBackup(id,backup);await checkRemote(store,staged.identity,signal);
  if(signal?.aborted)throw new Error('Pinned replacement cancelled before overwrite.');
  await journal.replacing(id);
  const result=await bridge.replacePinned(lock.token,{updateId:id,source:staged.file,backup:backup.file,expectedIdentity:lock.identity,hash:staged.hash,size:staged.size,previousHash:backup.hash,previousSize:backup.size,signal});
  await journal.installed(id,result);const latest=await checkRemote(store,staged.identity,signal);
  if(signal?.aborted)throw new Error('Pinned replacement cancelled after installation; check its recorded outcome.');
  await bridge.ackPinnedUpdate(lock.token,latest,lock.identity,staged.hash);
  verifyPinned(await bridge.fingerprintPinned(lock.token,{updateId:id,signal}),staged.identity,staged.hash);
  const entry=state.snapshot().pinnedUpdates[id];await journal.complete(id,identity(latest),staged.hash);await cleanup(state,entry).catch(()=>{});return latest;
 }catch(error){if(staged&&!id)await cleanup(state,{staged}).catch(()=>{});throw error;}
 finally{if(lock)await bridge.unlockUpload(lock.token).catch(()=>{});}
}
async function recoverPinnedRevision({id,bridge,store,state,signal}){
 const entry=state.snapshot().pinnedUpdates?.[id];if(!entry)return {resolved:true,alreadyResolved:true};
 const journal=new WindowsPinnedUpdateJournal(state);let lock;
 try{
  lock=await bridge.lockPinnedRecovery(entry.local);const proof=await bridge.fingerprintPinned(lock.token,{updateId:id,signal});
  if(['prepared','backedUp'].includes(entry.phase)){
   if(!lock.cloud||!lock.inSync||lock.pinState!==1||lock.modifiedBytes!==0||!same(lockedIdentity(lock),entry.previous)||proof.size!==entry.previous.size||entry.backup&&proof.hash!==entry.backup.hash)return {resolved:false,reason:'local-changed'};
   await journal.cancelBeforeReplacement(id,entry.previous,proof.hash);await cleanup(state,entry).catch(()=>{});return {resolved:true,originalPreserved:true,readOnlyCloudCheck:true};
  }
  if(proof.hash!==entry.staged.hash||proof.size!==entry.staged.size)return {resolved:false,reason:'local-changed'};
  const latest=await checkRemote(store,entry.staged.identity,signal);if(signal?.aborted)throw new Error('Pinned recovery cancelled.');
  let acknowledged=false;try{verifyPinned(proof,entry.staged.identity,entry.staged.hash);acknowledged=true;}catch{}
  if(!acknowledged){await bridge.ackPinnedUpdate(lock.token,latest,JSON.stringify({key:entry.previous.key,fileID:entry.previous.fileID||null,etag:entry.previous.etag}),entry.staged.hash);verifyPinned(await bridge.fingerprintPinned(lock.token,{updateId:id,signal}),entry.staged.identity,entry.staged.hash);}
  await journal.resolveRecovered(id,identity(latest),entry.staged.hash);await cleanup(state,entry).catch(()=>{});return {resolved:true,readOnlyCloudCheck:true};
 }finally{if(lock)await bridge.unlockUpload(lock.token).catch(()=>{});}
}
async function pinnedRecoveryCopies({id,state,signal}){
 const entry=state.snapshot().pinnedUpdates?.[id];if(!entry)throw new Error('This pinned update no longer has recovery copies.');
 const root=await fs.realpath(path.join(state.directory,'pinned-revisions')),directory=entry.staged?.directory;
 if(typeof directory!=='string'||!/^revision-[a-zA-Z0-9_-]+$/.test(path.basename(directory)))throw new Error('Invalid pinned recovery directory.');
 const info=await fs.lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||await fs.realpath(path.dirname(directory))!==root)throw new Error('Pinned recovery copies are outside their recorded directory.');
 const files=[];
 for(const [name,proof] of [['downloaded',entry.staged],['original',entry.backup]]){
  if(!proof)continue;
  if(path.dirname(proof.file)!==directory||path.basename(proof.file)!==(name==='original'?'previous':'content'))throw new Error('Invalid pinned recovery filename.');
  const stat=await fs.lstat(proof.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==proof.size||await fingerprintFile(proof.file,signal)!==proof.hash)throw new Error('Pinned recovery copy could not be verified.');
  files.push({name,file:proof.file});
 }
 if(signal?.aborted)throw new Error('Pinned recovery check cancelled.');return files;
}
module.exports={replacePinnedRevision,recoverPinnedRevision,pinnedRecoveryCopies};
