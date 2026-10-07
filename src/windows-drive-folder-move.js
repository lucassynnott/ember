const fs=require('node:fs/promises');const path=require('node:path');const crypto=require('node:crypto');
const {planFolderMove}=require('./windows-drive-folder-move-plan');const {WindowsFolderMoveJournal}=require('./windows-drive-folder-move-journal');const {pendingOperations}=require('./windows-drive-pending');const {fingerprintFile}=require('./windows-drive-recovery');const {revisionFingerprint}=require('./windows-drive-content-proof');
const unchanged=(a,b)=>a?.etag===b?.etag&&(a?.fileID||null)===(b?.fileID||null)&&a?.size===b?.size;
const cancelled=signal=>{if(signal?.aborted)throw Error('Folder move cancelled; its recorded outcome must be checked.');};
async function moveLocalFolder({root,from,local,key,state,bridge,store,signal,fingerprint=fingerprintFile}){
 const journal=new WindowsFolderMoveJournal(state),folder=await bridge.lockFolder(local);let id;
 try{
  if((await bridge.inspect(from)).exists)throw Error('The source directory still exists; both local trees were preserved.');
  const plan=planFolderMove({from,local,key,objects:await store.listAll('',{signal}),materialized:state.snapshot().materialized,pending:pendingOperations(state)});
  if(JSON.parse(folder.identity).key!==plan.previousKey)throw Error('The renamed folder identifies a different cloud directory.');
  const known=new Set(plan.placeholders.map(item=>item.local)),directories=[local];
  for(let index=0;index<directories.length;index++){cancelled(signal);for(const child of await fs.readdir(path.join(root,...directories[index].split('/')),{withFileTypes:true})){const name=directories[index]+'/'+child.name;if(child.isSymbolicLink()||!known.has(name))throw Error('The folder contains untracked or linked local files; refresh or sync them first.');if(child.isDirectory())directories.push(name);}}
  const locked=async(item,operation)=>{
   cancelled(signal);const lock=await bridge.lockUpload(item.local);
   try{const identity=JSON.parse(lock.identity||'null');if(!lock.cloud||lock.modifiedBytes!==0||!identity||identity.key!==item.previous.key||!unchanged({...identity,size:lock.size},item.previous))throw Error('A local folder child changed; its bytes were preserved.');const hash=await fingerprint(lock.localPath,signal);return await operation(lock,hash);}finally{await bridge.unlockUpload(lock.token).catch(()=>{});}
  };
  const fingerprints={};
  for(const item of plan.placeholders){if(item.previous.key.endsWith('/'))continue;await locked(item,async(lock,hash)=>{const source=plan.copies.find(copy=>copy.source.name===item.previous.key).source;if(await revisionFingerprint(store,source,signal)!==hash)throw Error('A local folder child differs from its cloud source.');fingerprints[item.from]={hash,size:lock.size,pinState:lock.pinState};});}
  cancelled(signal);id=await journal.begin({from,local,key,objects:plan.copies.map(copy=>copy.source),fingerprints});
  for(const copy of plan.copies){
   const item=plan.placeholders.find(item=>item.previous.key===copy.source.name&&!item.previous.key.endsWith('/')),expected=item?fingerprints[item.from].hash:crypto.createHash('sha256').update('').digest('hex');
   const perform=async(_lock,hash)=>{
    if(hash!==expected)throw Error('The local folder child changed before copying.');cancelled(signal);
    const source=await store.stat(copy.source.name,signal);if(!unchanged(source,copy.source))throw Error('The folder cloud source changed before copying.');
    const result=await store.copy(source,copy.key,signal),destination=await store.stat(copy.key,signal);if(!destination||destination.etag!==result?.CopyObjectResult?.ETag||destination.size!==source.size||(result.VersionId&&destination.fileID!==result.VersionId)||await revisionFingerprint(store,destination,signal)!==expected)throw Error('The complete folder destination copy was not verified.');
    await journal.copied(id,copy.key,{key:copy.key,etag:destination.etag,fileID:destination.fileID||null,size:destination.size,modified:destination.modified,hash:expected});
   };
   if(item)await locked(item,perform);else{if(copy.source.size!==0)throw Error('A folder marker contains unexpected bytes.');await perform(null,expected);}
  }
  await journal.readyToDelete(id);
  for(const copy of plan.copies){
   const item=plan.placeholders.find(item=>item.previous.key===copy.source.name&&!item.previous.key.endsWith('/'));
   const perform=async(_lock,hash)=>{
    const recorded=state.snapshot().folderMoves[id].copied[copy.key];if(hash!==recorded.hash)throw Error('A local folder child changed before deletion.');cancelled(signal);
    const source=await store.stat(copy.source.name,signal),destination=await store.stat(copy.key,signal);if(!unchanged(source,copy.source)||!unchanged(destination,recorded)||await revisionFingerprint(store,destination,signal)!==recorded.hash)throw Error('A folder cloud revision changed before deletion.');
    await journal.deleting(id,copy.source.name);cancelled(signal);await store.deleteVersion(copy.source.name,'',{etag:copy.source.etag,signal});if(await store.stat(copy.source.name,signal))throw Error('The folder source deletion was not confirmed.');await journal.deleted(id,copy.source.name);
   };
   if(item)await locked(item,perform);else await perform(null,state.snapshot().folderMoves[id].copied[copy.key].hash);
  }
  await journal.readyToAcknowledge(id);
  await finishFolderRebindings({id,state,bridge,store,signal,fingerprint,rootLock:folder});return {id,resolved:true};
 }finally{await bridge.unlockFolder(folder.token).catch(()=>{});}
}
async function finishFolderRebindings({id,state,bridge,store,signal,fingerprint=fingerprintFile,rootLock=null}){
 const entry=state.snapshot().folderMoves?.[id];if(!entry)return {resolved:true,alreadyResolved:true};
 if(!['deleted','acknowledging'].includes(entry.phase))return {resolved:false,reason:'folder-cloud-transfers-unfinished'};
 if(!rootLock){const lockedRoot=await bridge.lockFolder(entry.local);try{return await finishFolderRebindings({id,state,bridge,store,signal,fingerprint,rootLock:lockedRoot});}finally{await bridge.unlockFolder(lockedRoot.token).catch(()=>{});}}
 const journal=new WindowsFolderMoveJournal(state);
 for(const copy of entry.copies){cancelled(signal);if(await store.stat(copy.source.name,signal))throw Error('A folder source exists after its recorded deletion.');const destination=await store.stat(copy.key,signal),recorded=entry.copied[copy.key];if(!unchanged(destination,recorded)||await revisionFingerprint(store,destination,signal)!==recorded.hash)throw Error('The folder destination changed during acknowledgement.');}
 const items=[...entry.placeholders].sort((a,b)=>Number(a.previous.key.endsWith('/'))-Number(b.previous.key.endsWith('/'))||b.local.split('/').length-a.local.split('/').length);
 if(entry.acknowledging){const pending=items.findIndex(item=>item.local===entry.acknowledging);if(pending<0)throw Error('The pending folder acknowledgement is invalid.');items.unshift(...items.splice(pending,1));}
 for(const item of items){
  cancelled(signal);let lock;const directory=item.previous.key.endsWith('/');
  try{
   lock=directory?(item.local===entry.local&&rootLock?rootLock:await bridge.lockFolder(item.local)):await bridge.lockUpload(item.local);
   const identity=JSON.parse(lock.identity||'null'),copied=entry.copied[item.key];const original=identity?.key===item.previous.key&&(directory||unchanged({...identity,size:lock.size},item.previous)),installed=identity?.key===item.key&&(directory||unchanged({...identity,size:lock.size},copied));
   if(!original&&!installed)throw Error('A folder child identifies another revision.');
   let hash;if(!directory){if(!lock.cloud||lock.modifiedBytes!==0)throw Error('The local folder child changed before acknowledgement.');hash=await fingerprint(lock.localPath,signal);if(hash!==entry.fingerprints[item.from].hash)throw Error('The local folder child bytes changed before acknowledgement.');}
   const current=state.snapshot().folderMoves[id];if(current.acknowledged?.[item.local]){const info=await bridge.inspect(item.local);if(!installed||!info.cloud||!directory&&(!info.inSync||info.modifiedBytes!==0||entry.fingerprints[item.from].pinState===1&&(info.pinState!==1||info.onDiskBytes<lock.size)))throw Error('A previously acknowledged folder identity or offline state changed.');continue;}
   if(current.acknowledging!==item.local)await journal.acknowledging(id,item.local);
   if(original){
    if(directory)await bridge.ackFolderMove(lock.token,item.key,lock.identity);
    else{await bridge.ackMove(lock.token,{name:item.key,...copied},lock.identity,hash);await bridge.unlockUpload(lock.token);lock=await bridge.lockUpload(item.local);}
   }
   const info=await bridge.inspect(item.local);let proof={placeholder:info};if(!directory){if(lock.modifiedBytes!==0)throw Error('The file changed after native acknowledgement.');proof={...proof,size:lock.size,hash:await fingerprint(lock.localPath,signal)};}
   await journal.acknowledged(id,item.local,proof);
  }finally{if(lock&&lock!==rootLock)await bridge[directory?'unlockFolder':'unlockUpload'](lock.token).catch(()=>{});}
 }
 cancelled(signal);await journal.complete(id);return {resolved:true,readOnlyCloudCheck:true};
}
async function recoverFolderMove({id,state,bridge,store,signal,finish=false,fingerprint=fingerprintFile}){
 let entry=state.snapshot().folderMoves?.[id];if(!entry)return {resolved:true,alreadyResolved:true};
 if(['deleted','acknowledging'].includes(entry.phase))return finishFolderRebindings({id,state,bridge,store,signal,fingerprint});
 const root=await bridge.lockFolder(entry.local),journal=new WindowsFolderMoveJournal(state);let cloudWrites=false;
 try{
  if(JSON.parse(root.identity).key!==entry.previousKey||(await bridge.inspect(entry.from)).exists)return {resolved:false,reason:'folder-local-root-changed'};
  const locked=async(copy,operation)=>{const item=entry.placeholders.find(item=>item.previous.key===copy.source.name&&!item.previous.key.endsWith('/'));if(!item){if(copy.source.size!==0||!(copy.source.name.endsWith('/.ghost-keep')||copy.source.name.endsWith('/')))throw Error('Invalid recorded folder marker.');return operation(null,crypto.createHash('sha256').update('').digest('hex'));}
   const lock=await bridge.lockUpload(item.local);try{const identity=JSON.parse(lock.identity||'null');if(!lock.cloud||lock.modifiedBytes!==0||identity?.key!==item.previous.key||!unchanged({...identity,size:lock.size},item.previous))throw Error('The held folder child changed.');const hash=await fingerprint(lock.localPath,signal);if(hash!==entry.fingerprints[item.from].hash)throw Error('The held folder child bytes changed.');return await operation(lock,hash);}finally{await bridge.unlockUpload(lock.token).catch(()=>{});}};
  for(const copy of entry.copies){
   cancelled(signal);let destination=await store.stat(copy.key,signal);const item=entry.placeholders.find(item=>item.previous.key===copy.source.name&&!item.previous.key.endsWith('/')),expected=item?entry.fingerprints[item.from].hash:crypto.createHash('sha256').update('').digest('hex');
   if(!destination){if(finish!==true||!['prepared','copying'].includes(entry.phase))return {resolved:false,reason:'folder-copy-missing'};
    await locked(copy,async(_lock,hash)=>{const source=await store.stat(copy.source.name,signal);if(!unchanged(source,copy.source)||hash!==expected)throw Error('The held folder source changed before copying.');cancelled(signal);cloudWrites=true;const result=await store.copy(source,copy.key,signal);destination=await store.stat(copy.key,signal);if(destination?.etag!==result?.CopyObjectResult?.ETag||(result.VersionId&&destination.fileID!==result.VersionId))throw Error('The recovered folder copy was not confirmed.');});
   }
   if(destination.size!==copy.source.size||entry.copied[copy.key]&&!unchanged(destination,entry.copied[copy.key])||await revisionFingerprint(store,destination,signal)!==expected)throw Error('The held folder destination changed.');
   if(!entry.copied[copy.key])await journal.copied(id,copy.key,{key:copy.key,etag:destination.etag,fileID:destination.fileID||null,size:destination.size,modified:destination.modified,hash:expected});
  }
  entry=state.snapshot().folderMoves[id];if(['prepared','copying'].includes(entry.phase))await journal.readyToDelete(id);
  for(const copy of entry.copies){
   entry=state.snapshot().folderMoves[id];cancelled(signal);const source=await store.stat(copy.source.name,signal);
   if(entry.deleted[copy.source.name]){if(source)return {resolved:false,reason:'folder-source-reappeared'};continue;}
   if(!source){if(entry.deleting!==copy.source.name)return {resolved:false,reason:'folder-source-missing-before-intent'};await journal.deleted(id,copy.source.name);continue;}
   if(finish!==true)return {resolved:false,reason:'folder-source-still-present'};
   await locked(copy,async(_lock,hash)=>{const current=await store.stat(copy.source.name,signal),destination=await store.stat(copy.key,signal),recorded=state.snapshot().folderMoves[id].copied[copy.key];if(!unchanged(current,copy.source)||!unchanged(destination,recorded)||hash!==recorded.hash||await revisionFingerprint(store,destination,signal)!==hash)throw Error('A folder revision changed before recovery deletion.');await journal.deleting(id,copy.source.name);cancelled(signal);cloudWrites=true;await store.deleteVersion(copy.source.name,'',{etag:copy.source.etag,signal});if(await store.stat(copy.source.name,signal))throw Error('The recovered folder deletion was not confirmed.');await journal.deleted(id,copy.source.name);});
  }
  await journal.readyToAcknowledge(id);const result=await finishFolderRebindings({id,state,bridge,store,signal,fingerprint,rootLock:root});return {...result,readOnlyCloudCheck:!cloudWrites};
 }finally{await bridge.unlockFolder(root.token).catch(()=>{});}
}
module.exports={moveLocalFolder,finishFolderRebindings,recoverFolderMove};
