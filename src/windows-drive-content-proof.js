const crypto=require('node:crypto');
// Read a single confirmed revision in bounded ranges, then recheck its identity.
// This proof is needed because Windows also clears InSync on a clean rename.
async function revisionFingerprint(store,object,signal){
 if(!object||!object.etag||!Number.isSafeInteger(object.size)||object.size<0)throw new Error('Content verification requires a confirmed cloud revision.');
 const hash=crypto.createHash('sha256');
 for(let offset=0;offset<object.size;){
  if(signal?.aborted)throw new Error('Content verification cancelled.');
  const length=Math.min(8*1024*1024,object.size-offset);
  const bytes=await store.read(object.name,offset,length,object.fileID||null,signal,object.etag);
  if(bytes.length!==length)throw new Error('Content verification returned incomplete cloud bytes.');
  hash.update(bytes);offset+=length;
 }
 if(signal?.aborted)throw new Error('Content verification cancelled.');
 const latest=await store.stat(object.name,signal);
 if(!latest||latest.etag!==object.etag||(latest.fileID||null)!==(object.fileID||null)||latest.size!==object.size)throw new Error('The cloud revision changed during content verification.');
 return hash.digest('hex');
}
module.exports={revisionFingerprint};
