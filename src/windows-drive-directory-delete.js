const crypto=require('node:crypto');
const {planDirectoryDeletion}=require('./windows-drive-directory-delete-plan');
const {pendingOperations}=require('./windows-drive-pending');
const {TRASH}=require('./windows-drive-store');
const cancelled=signal=>{if(signal?.aborted)throw Error('Directory deletion cancelled; check its recorded outcome.');};
const same=(object,revision)=>object?.name===revision?.name&&object?.etag===revision?.etag&&(object?.fileID||null)===(revision?.fileID||null)&&object?.size===0;
const sameBinding=(a,b)=>a?.key===b?.key&&(a?.etag||null)===(b?.etag||null)&&(a?.fileID||null)===(b?.fileID||null)&&a?.size===b?.size&&a?.remoteConfirmed===true;
const mutate=(state,id,operation)=>state.update(data=>{const entry=data.deletes?.[id];if(!entry||entry.directory!==true)throw Error('The directory deletion record changed.');operation(entry,data);});
function checkPrefix(entry,objects){
 for(const object of objects){if(!object.name.startsWith(entry.key))continue;const copy=entry.copies.find(copy=>copy.source.name===object.name);if(!copy||!same(object,copy.source)||copy.deleted)throw Error('The directory gained children or a cloud revision changed; it was preserved.');}
}
async function beginDirectoryDeletion({local,previous,state,objects}){
 let id;await state.update(data=>{
  const plan=planDirectoryDeletion({local,previous,objects,materialized:data.materialized,pending:pendingOperations(data)});
  data.deletes??={};if(Object.keys(data.deletes).length>=1000)throw Error('Resolve unfinished deletions before deleting more folders.');
  id=crypto.randomUUID();const started=Date.now(),stamp=new Date(started).toISOString().slice(0,10).replaceAll('-','');
  const copies=plan.sources.map(source=>{const key=TRASH+stamp+'/'+id+'/'+source.name;if(Buffer.byteLength(key)>1024)throw Error('The recoverable directory trash key exceeds the storage limit.');return {source,key,copied:null,deleting:false,deleted:false};});
  data.deletes[id]={id,local,key:plan.key,previous:plan.previous,nativePrevious:structuredClone(previous),directory:true,tree:true,copies,phase:'prepared',started};
 });return id;
}
async function recoverDirectoryDeletion({id,state,store,signal,finish=false}){
 let entry=state.snapshot().deletes?.[id];if(!entry)return {resolved:true,alreadyResolved:true};if(entry.directory!==true)throw Error('This is not a directory deletion.');
 let cloudWrites=false;const prefix=async()=>{const objects=await store.listAll('',{signal});cancelled(signal);checkPrefix(state.snapshot().deletes[id],objects);return objects.filter(object=>object.name.startsWith(entry.key));};
 const verifyCopies=async()=>{for(const copy of state.snapshot().deletes[id].copies){if(!same(await store.stat(copy.key,signal),copy.copied))throw Error('A verified directory trash copy changed.');cancelled(signal);}};
 await prefix();
 for(let index=0;index<entry.copies.length;index++){
  cancelled(signal);entry=state.snapshot().deletes[id];const copy=entry.copies[index],source=await store.stat(copy.source.name,signal);let trash=await store.stat(copy.key,signal);
  if(copy.copied){if(!same(trash,copy.copied))throw Error('The recoverable directory copy changed; deletion remains held.');continue;}
  if(!source)return {resolved:false,reason:'directory-delete-source-missing-before-intent'};
  if(!same(source,copy.source))throw Error('The directory object revision changed.');
  if(!trash){
   if(finish!==true)return {resolved:false,reason:'directory-delete-copy-missing'};
   await prefix();cancelled(signal);cloudWrites=true;const response=await store.copy(source,copy.key,signal);trash=await store.stat(copy.key,signal);
   if(!trash||trash.etag!==response?.CopyObjectResult?.ETag||response.VersionId&&trash.fileID!==response.VersionId)throw Error('The directory trash copy response was not confirmed.');
  }
  if(trash.name!==copy.key||trash.size!==0||typeof trash.etag!=='string'||!trash.etag)throw Error('The empty-directory trash revision is not confirmed.');
  cancelled(signal);await mutate(state,id,current=>{const item=current.copies[index];if(item.key!==copy.key||item.copied)throw Error('The directory copy record changed.');item.copied={name:trash.name,etag:trash.etag,fileID:trash.fileID||null,size:0};});
 }
 // Every marker copy is verified before the first original is removed.
 entry=state.snapshot().deletes[id];await verifyCopies();
 await prefix();
 for(let index=0;index<entry.copies.length;index++){
  cancelled(signal);entry=state.snapshot().deletes[id];const copy=entry.copies[index],source=await store.stat(copy.source.name,signal);
  if(copy.deleted){if(source)throw Error('A deleted directory object reappeared; it was preserved.');continue;}
  if(source){
   if(!same(source,copy.source))throw Error('The directory source revision changed before deletion.');
   if(finish!==true)return {resolved:false,reason:'directory-delete-source-still-present'};
   await prefix();await verifyCopies();cancelled(signal);await mutate(state,id,current=>{current.copies[index].deleting=true;current.phase='deleting';});cloudWrites=true;
   await store.deleteVersion(copy.source.name,'',{etag:copy.source.etag,signal});if(await store.stat(copy.source.name,signal))throw Error('The directory source deletion was not confirmed.');
  }else if(!copy.deleting)return {resolved:false,reason:'directory-delete-source-missing-before-intent'};
  cancelled(signal);await mutate(state,id,current=>{current.copies[index].deleted=true;current.copies[index].deleting=false;});
 }
 if((await prefix()).length)return {resolved:false,reason:'directory-delete-source-still-present'};
 await verifyCopies();cancelled(signal);await mutate(state,id,current=>{if(current.copies.some(copy=>!copy.deleted))throw Error('Directory source deletion is unfinished.');current.phase='deleted';});
 return {id,resolved:false,readyForLocalDeletion:true,reason:'directory-delete-local-still-present',readOnlyCloudCheck:!cloudWrites};
}
async function prepareDirectoryDeletion({local,previous,state,store,signal}){
 const pending=Object.values(state.snapshot().deletes||{}).find(entry=>entry.local===local);
 if(pending&&(!pending.directory||pending.key!==previous.key))throw Error('The held directory deletion identifies another object.');
 let id=pending?.id;
 if(!id){const objects=await store.listAll('',{signal});cancelled(signal);id=await beginDirectoryDeletion({local,previous,state,objects});}
 return recoverDirectoryDeletion({id,state,store,signal,finish:true});
}
async function completeDirectoryDeletion({id,state,store,bridge,signal}){
 const entry=state.snapshot().deletes?.[id];if(!entry)return {resolved:true,alreadyResolved:true};const checked=await recoverDirectoryDeletion({id,state,store,signal});if(!checked.readyForLocalDeletion)return checked;
 const info=await bridge.inspect(entry.local);cancelled(signal);if(info.exists!==false)return {resolved:false,reason:'directory-delete-local-still-present'};
 await mutate(state,id,(current,data)=>{if(current.phase!=='deleted'||!sameBinding(data.materialized[current.local],current.previous)||Object.keys(data.materialized).some(name=>name.toUpperCase().startsWith(current.local.toUpperCase()+'/')))throw Error('The directory binding or children changed before completion.');delete data.materialized[current.local];delete data.deletes[id];});
 return {resolved:true,readOnlyCloudCheck:true};
}
module.exports={beginDirectoryDeletion,prepareDirectoryDeletion,recoverDirectoryDeletion,completeDirectoryDeletion};
