// Cache accounting uses Cloud Files metadata, which does not hydrate content.
// Eviction delegates to the native helper's final ownership/dirty/pin checks.
class WindowsDriveCache {
  constructor({state,bridge}){this.state=state;this.bridge=bridge;}
  async inspect(){
    const snapshot=this.state.snapshot(),files=[],errors=[];let bytes=0,pinnedBytes=0,protectedBytes=0;
    for(const [local,identity] of Object.entries(snapshot.materialized||{})){
      if(identity.key.endsWith('/'))continue;
      try {
        const info=await this.bridge.inspect(local);if(!info.exists)continue;
        if(!info.cloud){errors.push({local,reason:'local-replacement'});continue;}
        const owned=JSON.parse(info.identity);
        if(owned.key!==identity.key||owned.etag!==identity.etag||owned.fileID!==identity.fileID)throw new Error('The cached revision does not match the recorded file.');
        const size=info.onDiskBytes;
        if(!Number.isSafeInteger(size)||size<0)throw new Error('Invalid cached byte count.');
        const pinned=info.pinState===1;
        const pending=Object.values(snapshot.uploads||{}).some(entry=>entry.local.toUpperCase()===local.toUpperCase()||entry.key===identity.key);
        const eligible=!pending&&info.inSync&&info.modifiedBytes===0&&(info.pinState===0||info.pinState===2);
        if(pinned)pinnedBytes+=size;else bytes+=size;
        if(!eligible&&!pinned)protectedBytes+=size;
        files.push({local,key:identity.key,size,pinned,eligible});
      }catch(error){errors.push({local,reason:error.message});}
    }
    for(const count of [bytes,pinnedBytes,protectedBytes])if(!Number.isSafeInteger(count))throw new Error('Drive cache accounting exceeds its limit.');
    return {bytes,pinnedBytes,protectedBytes,files,errors,limitGB:snapshot.cacheLimitGB??20};
  }
  async enforce({clear=false}={}){
    const before=await this.inspect(),target=clear?0:before.limitGB*1024**3;let remaining=before.bytes;const evicted=[],held=[];
    // Largest clean files first minimizes how many files need to rehydrate.
    for(const file of before.files.filter(file=>file.eligible&&file.size>0).sort((a,b)=>b.size-a.size)){
      if(remaining<=target)break;
      const uploads=this.state.snapshot().uploads||{};
      if(Object.values(uploads).some(entry=>entry.local.toUpperCase()===file.local.toUpperCase()||entry.key===file.key)){held.push({local:file.local,reason:'unfinished-upload'});continue;}
      try {
        await this.bridge.dehydrate(file.local);
        const current=await this.bridge.inspect(file.local);
        if(!current.exists||!current.cloud||!Number.isSafeInteger(current.onDiskBytes)||current.onDiskBytes<0)throw new Error('Eviction could not be confirmed.');
        remaining-=Math.max(0,file.size-current.onDiskBytes);evicted.push(file.local);
      }catch(error){held.push({local:file.local,reason:error.message});}
    }
    const after=await this.inspect();return {...after,evicted,held,overLimit:after.bytes>target,complete:after.bytes<=target&&after.errors.length===0&&held.length===0};
  }
}
module.exports={WindowsDriveCache};
