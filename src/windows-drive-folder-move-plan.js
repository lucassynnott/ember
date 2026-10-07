// Preflight only: callers must journal, revalidate and lock the actual tree
// before executing any cloud/native operation from this snapshot.
const {validLocal}=require('./windows-drive-names');
const {TRASH}=require('./windows-drive-store');
const under=(name,parent)=>name===parent||name.startsWith(parent+'/');
function planFolderMove({from,local,key,materialized,objects,pending=[]}){
 for(const name of [from,local])if(typeof name!=='string'||!name||name.split('/').some(part=>!validLocal(part)))throw Error('Invalid folder move path.');
 if(from.toUpperCase()===local.toUpperCase()||under(local.toUpperCase(),from.toUpperCase())||under(from.toUpperCase(),local.toUpperCase()))throw Error('A folder move requires separate source and destination trees.');
 const source=materialized?.[from];if(!source||typeof source.key!=='string'||!source.key.endsWith('/'))throw Error('The source folder has no recorded cloud identity.');
 if(typeof key!=='string'||!key.endsWith('/')||key.startsWith(TRASH)||key===source.key||key.startsWith(source.key)||source.key.startsWith(key)||Buffer.byteLength(key)>1024||/[\x00-\x1f]/.test(key))throw Error('Invalid cloud folder destination.');
 if(!Array.isArray(objects)||objects.length>1000000||!Array.isArray(pending))throw Error('Invalid folder move snapshot.');
 const placeholders=[];
 for(const [name,identity] of Object.entries(materialized)){
  if(!under(name,from)){if(under(name.toUpperCase(),local.toUpperCase()))throw Error('The local destination tree is occupied.');continue;}
  if(!identity||typeof identity.key!=='string'||!identity.key.startsWith(source.key)||identity.remoteConfirmed===false)throw Error('The source tree contains a different cloud binding.');
  const target=local+name.slice(from.length);if(target.split('/').some(part=>!validLocal(part)))throw Error('Invalid recorded child path.');
  placeholders.push({from:name,local:target,previous:structuredClone(identity),key:key+identity.key.slice(source.key.length)});
 }
 if(new Set(placeholders.map(entry=>entry.previous.key)).size!==placeholders.length)throw Error('The source tree contains ambiguous duplicate cloud bindings.');
 for(const entry of pending){
  if(!entry||typeof entry.local!=='string'||typeof entry.key!=='string')throw Error('Invalid pending folder operation.');
  const path=entry.local.toUpperCase();if([from,local].some(tree=>under(path,tree.toUpperCase())||under(tree.toUpperCase(),path))||entry.key.startsWith(source.key)||entry.key.startsWith(key))throw Error('An unfinished operation touches the folder move.');
 }
 const seen=new Set(),copies=[];
 for(const object of objects){
  if(!object||typeof object.name!=='string'||seen.has(object.name))throw Error('Invalid or duplicated remote object.');seen.add(object.name);
  if(object.name.startsWith(key))throw Error('The cloud destination tree is occupied.');
  if(!object.name.startsWith(source.key))continue;
  if(object.name.endsWith('/')&&object.size!==0)throw Error('A cloud directory object contains unexpected bytes.');
  if(!Number.isSafeInteger(object.size)||object.size<0||typeof object.etag!=='string'||!object.etag)throw Error('A source object has no confirmed revision.');
  const destination=key+object.name.slice(source.key.length);if(Buffer.byteLength(destination)>1024)throw Error('A moved object exceeds the cloud key limit.');
  copies.push({source:structuredClone(object),key:destination});
 }
 for(const entry of placeholders){
  if(entry.previous.key.endsWith('/'))continue;
  const matches=copies.filter(copy=>copy.source.name===entry.previous.key);if(matches.length!==1)throw Error('A recorded source file is missing remotely.');
  const object=matches[0].source;if(object.etag!==entry.previous.etag||(object.fileID||null)!==(entry.previous.fileID||null)||object.size!==entry.previous.size)throw Error('A source file changed remotely.');
 }
 for(const copy of copies){if(copy.source.name.endsWith('/.ghost-keep')||copy.source.name.endsWith('/'))continue;if(!placeholders.some(entry=>entry.previous.key===copy.source.name))throw Error('An unmaterialized remote file requires refresh before moving.');}
 return {from,local,previousKey:source.key,key,placeholders,copies};
}
module.exports={planFolderMove};
