const fs=require('node:fs/promises');const path=require('node:path');const crypto=require('node:crypto');
// Stage a confirmed revision outside the Drive. Callers must journal replacement
// before changing a pinned file; this download never touches its offline bytes.
async function stageRevision({store,object,directory,driveRoot,signal}){
 if(!object||typeof object.name!=='string'||!object.name||typeof object.etag!=='string'||!object.etag||!Number.isSafeInteger(object.size)||object.size<0)throw new Error('Staging requires a confirmed cloud revision.');
 if(typeof directory!=='string'||!path.isAbsolute(directory))throw new Error('Staging requires an absolute private directory.');
 const check=()=>{if(signal?.aborted)throw new Error('Revision staging cancelled.');};check();
 let ancestor=path.resolve(directory),parts=[],prospective;
 for(;;){try{prospective=path.join(await fs.realpath(ancestor),...parts);break;}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(ancestor);if(parent===ancestor)throw error;parts.unshift(path.basename(ancestor));ancestor=parent;}}
 const root=driveRoot?await fs.realpath(driveRoot):null;
 const outside=selected=>{if(root){const relative=path.relative(root,selected);if(relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))throw new Error('Revision staging must be outside the Drive root.');}};
 outside(prospective);await fs.mkdir(prospective,{recursive:true});const actualDirectory=await fs.realpath(prospective);outside(actualDirectory);
 const owned=await fs.mkdtemp(path.join(actualDirectory,'revision-')),file=path.join(owned,'content');let handle;
 try{
  handle=await fs.open(file,'wx',0o600);const hash=crypto.createHash('sha256');
  for(let offset=0;offset<object.size;){
   check();const length=Math.min(8*1024*1024,object.size-offset),bytes=await store.read(object.name,offset,length,object.fileID||null,signal,object.etag);
   check();if(bytes.length!==length)throw new Error('Revision staging returned incomplete cloud bytes.');
   let written=0;while(written<bytes.length){check();const result=await handle.write(bytes,written,bytes.length-written,offset+written);if(!result.bytesWritten)throw new Error('Revision staging could not save the downloaded bytes.');written+=result.bytesWritten;}
   hash.update(bytes);offset+=length;
  }
  await handle.sync();check();const stat=await handle.stat();if(stat.size!==object.size)throw new Error('Revision staging saved an incomplete file.');
  const latest=await store.stat(object.name,signal);check();
  if(!latest||latest.etag!==object.etag||(latest.fileID||null)!==(object.fileID||null)||latest.size!==object.size)throw new Error('The cloud revision changed during staging.');
  await handle.close();handle=null;
  return {file,directory:owned,hash:hash.digest('hex'),size:object.size,identity:{key:object.name,etag:object.etag,fileID:object.fileID||null,size:object.size,modified:object.modified},async cleanup(){await fs.rm(owned,{recursive:true,force:true});}};
 }catch(error){await handle?.close().catch(()=>{});await fs.rm(owned,{recursive:true,force:true});throw error;}
}
module.exports={stageRevision};
