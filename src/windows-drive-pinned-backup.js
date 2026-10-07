const fs=require('node:fs/promises');const streams=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {fingerprintFile}=require('./windows-drive-recovery');
// The caller holds the native read-share lock throughout capture. It excludes
// edits, rename and deletion while keeping the pinned offline source readable.
async function capturePinnedRevision({lock,directory,driveRoot,signal}){
 if(!lock?.token||!lock.cloud||!lock.inSync||lock.modifiedBytes!==0||lock.pinState!==1||!Number.isSafeInteger(lock.size)||lock.size<0||typeof lock.localPath!=='string'||!path.isAbsolute(lock.localPath))throw new Error('Offline backup requires a locked, clean pinned revision.');
 const check=()=>{if(signal?.aborted)throw new Error('Offline backup cancelled.');};check();
 const root=await fs.realpath(driveRoot),actualDirectory=await fs.realpath(directory),relative=path.relative(root,actualDirectory);
 if(relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))throw new Error('Offline backup must be outside the Drive root.');
 const file=path.join(actualDirectory,'previous');let handle,created=false;
 try{
  handle=await fs.open(file,'wx',0o600);created=true;const hash=crypto.createHash('sha256');let size=0;
  for await(const bytes of streams.createReadStream(lock.localPath,{signal})){
   check();if(size+bytes.length>lock.size)throw new Error('The offline source changed during backup.');
   let written=0;while(written<bytes.length){check();const result=await handle.write(bytes,written,bytes.length-written,size+written);if(!result.bytesWritten)throw new Error('Offline backup could not save its bytes.');written+=result.bytesWritten;}
   hash.update(bytes);size+=bytes.length;
  }
  if(size!==lock.size)throw new Error('Offline backup returned incomplete source bytes.');
  await handle.sync();check();const fingerprint=hash.digest('hex');
  if(await fingerprintFile(lock.localPath,signal)!==fingerprint)throw new Error('The offline source changed during backup.');
  await handle.close();handle=null;return {file,hash:fingerprint,size};
 }catch(error){await handle?.close().catch(()=>{});if(created)await fs.rm(file,{force:true});throw error;}
}
module.exports={capturePinnedRevision};
