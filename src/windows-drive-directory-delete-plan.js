const {validLocal}=require('./windows-drive-names');
const {operationTouches}=require('./windows-drive-pending');
const {TRASH}=require('./windows-drive-store');

// Directory identities describe a prefix. Only its explicit zero-byte object
// and empty-folder marker may be removed by an empty-directory deletion.
function planDirectoryDeletion({local,previous,objects,materialized,pending=[]}){
 if(typeof local!=='string'||!local||local.split('/').some(part=>!validLocal(part))||!previous||typeof previous.key!=='string'||!previous.key.endsWith('/')||previous.key.startsWith(TRASH)||previous.key==='/'||!Array.isArray(objects)||objects.length>100000)throw Error('Invalid empty-directory deletion.');
 const binding=materialized?.[local];
 if(!binding||binding.key!==previous.key||binding.remoteConfirmed!==true)throw Error('The empty-directory binding is not confirmed.');
 const tree={local,key:previous.key,tree:true};
 for(const [name,identity] of Object.entries(materialized)){
  if(name===local)continue;
  if(operationTouches(tree,name,identity.key)||identity.key===previous.key)throw Error('A child or alias still occupies the directory.');
 }
 if(pending.some(entry=>operationTouches(entry,local,previous.key)||operationTouches(tree,entry.local,entry.key)))throw Error('An unfinished operation protects the directory.');
 const sources=[],seen=new Set();
 for(const object of objects){
  if(typeof object?.name!=='string')throw Error('The cloud directory listing is invalid.');
  if(!object.name.startsWith(previous.key))continue;
  if(![previous.key,previous.key+'.ghost-keep'].includes(object.name))throw Error('The cloud directory is not empty.');
  if(seen.has(object.name)||object.size!==0||typeof object.etag!=='string'||!object.etag||object.fileID!=null&&typeof object.fileID!=='string')throw Error('The empty-directory object revision is not confirmed.');
  seen.add(object.name);sources.push({name:object.name,size:0,etag:object.etag,fileID:object.fileID||null});
 }
 return {local,key:previous.key,previous:structuredClone(binding),sources};
}
module.exports={planDirectoryDeletion};
