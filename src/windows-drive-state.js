const {validLocal}=require('./windows-drive-names');
const fs=require('node:fs/promises');const path=require('node:path');const crypto=require('node:crypto');
const LIMIT=64*1024*1024;
class WindowsDriveState {
  constructor({directory,safeStorage}){this.directory=directory;this.file=path.join(directory,'state.dpapi');this.crypto=safeStorage;this.state=null;this.queue=Promise.resolve();}
  #encryption(){if(!this.crypto?.isEncryptionAvailable())throw new Error('Windows credential encryption is unavailable; Drive settings were not saved.');}
  async load(){
    this.#encryption();
    try {
      const stat=await fs.stat(this.file);if(!stat.isFile()||stat.size>LIMIT)throw new Error('Invalid Windows Drive state file.');
      const value=JSON.parse(this.crypto.decryptString(await fs.readFile(this.file)));
      if(value.version!==1||typeof value.identity!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.identity)||typeof value.mappings!=='object'||!value.mappings||Array.isArray(value.mappings)||typeof value.materialized!=='object'||!value.materialized||Array.isArray(value.materialized))throw new Error('Invalid Windows Drive state.');
      if(value.cacheLimitGB==null)value.cacheLimitGB=20;
      if(![5,10,20,50,100,250].includes(value.cacheLimitGB))throw new Error('Invalid Drive cache limit.');
      if(value.uploads==null)value.uploads={};
      if(typeof value.uploads!=='object'||Array.isArray(value.uploads))throw new Error('Invalid Windows Drive upload journal.');
      this.state=value;
    }catch(error){if(error.code!=='ENOENT')throw new Error('Windows Drive settings could not be opened. The existing state was preserved.',{cause:error});this.state={version:1,identity:crypto.randomUUID(),config:null,mappings:{},materialized:{},uploads:{},cacheLimitGB:20};}
    return structuredClone(this.state);
  }
  snapshot(){if(!this.state)throw new Error('Windows Drive state has not loaded.');return structuredClone(this.state);}
  async update(change){
    const operation=this.queue.then(async()=>{
      if(!this.state)throw new Error('Windows Drive state has not loaded.');this.#encryption();
      const next=structuredClone(this.state);await change(next);
      const json=JSON.stringify(next);if(Buffer.byteLength(json)>LIMIT)throw new Error('Windows Drive state exceeds its limit.');
      const encrypted=this.crypto.encryptString(json);if(encrypted.length>LIMIT)throw new Error('Encrypted Drive state exceeds its limit.');
      await fs.mkdir(this.directory,{recursive:true});const temporary=this.file+'.'+crypto.randomUUID()+'.tmp';let handle;
      try{handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(encrypted);await handle.sync();await handle.close();handle=null;await fs.rename(temporary,this.file);this.state=next;}
      finally{await handle?.close();await fs.rm(temporary,{force:true});}
      return structuredClone(next);
    });
    this.queue=operation.catch(()=>{});return operation;
  }
  configure(config){
    if(!config||!['b2','r2','s3','wasabi','custom'].includes(config.provider)||!['keyID','applicationKey','bucketName'].every(field=>typeof config[field]==='string'&&config[field].trim()))return Promise.reject(new Error('Invalid Windows Drive storage configuration.'));
    const selected=Object.fromEntries(['provider','keyID','applicationKey','bucketName','bucketID','accountID','region','endpoint'].filter(key=>config[key]!=null).map(key=>[key,String(config[key])]));
    return this.update(state=>{state.config=selected;});
  }
  setCacheLimit(gb){if(![5,10,20,50,100,250].includes(gb))return Promise.reject(new Error('Invalid Drive cache limit.'));return this.update(state=>{state.cacheLimitGB=gb;});}
  saveMappings(mappings){return this.update(state=>{state.mappings=structuredClone(mappings);});}
  async reserveLocalFile(local) {
    const parts=local.split('/');if(parts.some(part=>!validLocal(part)))throw new Error('Invalid local Drive path.');let key;
    await this.update(state=>{
      let remote='',parent='';
      for(let index=0;index<parts.length;index++){
        const name=parts[index],folder=index<parts.length-1,type=folder?'folder:':'file:';
        const mapping=Object.prototype.hasOwnProperty.call(state.mappings,remote)?state.mappings[remote]:{};
        let id=Object.entries(mapping).find(([id,value])=>id.startsWith(type)&&value.toUpperCase()===name.toUpperCase())?.[0];
        if(!id){id=type+name;if(Object.entries(mapping).some(([other,value])=>other!==id&&value.toUpperCase()===name.toUpperCase()))throw new Error('A different cloud object occupies this local name.');if(Object.hasOwn(mapping,id)&&mapping[id]!==name)throw new Error('Cloud name already maps to another local file.');Object.defineProperty(mapping,id,{value:name,enumerable:true,writable:true,configurable:true});}
        Object.defineProperty(state.mappings,remote,{value:mapping,enumerable:true,writable:true,configurable:true});
        remote+=id.slice(type.length)+(folder?'/':'');parent+=(parent?'/':'')+name;
        if(folder){const known=Object.prototype.hasOwnProperty.call(state.materialized,parent)?state.materialized[parent]:null;if(known&&known.key!==remote)throw new Error('Tracked directory identity differs from the local path.');Object.defineProperty(state.materialized,parent,{value:known||{key:remote,fileID:null,etag:null},enumerable:true,writable:true,configurable:true});}
      }
      key=remote;
    });return key;
  }
  async beginUpload({local,key,size,modified,previous,hash}) {
    let id;
    await this.update(state=>{
      if(!/^[0-9a-f]{64}$/.test(hash||''))throw new Error('Upload requires a local content fingerprint.');
      state.uploads??={};
      if(Object.values(state.uploads).some(upload=>upload.local.toUpperCase()===local.toUpperCase()||upload.key===key))throw new Error('An unfinished upload exists for this file. Resolve its recorded outcome before retrying.');
      id=crypto.randomUUID();state.uploads[id]={id,local,key,size,modified,previous:previous||null,hash,phase:'prepared',started:Date.now()};
    });
    return id;
  }
  setUploadPhase(id,phase,proof={}) {
    if(!['sending','uploaded','confirmed'].includes(phase))return Promise.reject(new Error('Invalid upload phase.'));
    return this.update(state=>{const upload=state.uploads?.[id];if(!upload)throw new Error('Upload journal entry is missing.');if(({prepared:'sending',sending:'uploaded',uploaded:'confirmed'})[upload.phase]!==phase)throw new Error('Upload journal phase is out of order.');state.uploads[id]={...upload,...(proof.uploaded?{uploaded:structuredClone(proof.uploaded)}:{}),...(proof.confirmed?{confirmed:structuredClone(proof.confirmed)}:{}),phase};});
  }
  completeUpload(id,local,identity) {
    return this.update(state=>{
      if(!state.uploads?.[id]||state.uploads[id].local!==local||state.uploads[id].key!==identity.key||state.uploads[id].phase!=='confirmed')throw new Error('Upload acknowledgement does not match the journal.');
      Object.defineProperty(state.materialized,local,{value:structuredClone(identity),enumerable:true,writable:true,configurable:true});delete state.uploads[id];
    });
  }
  resolveRecoveredUpload(id,local,identity,hash) {
    return this.update(state=>{
      const entry=state.uploads?.[id];if(!entry||entry.local!==local||entry.key!==identity.key||entry.hash!==hash)throw new Error('Recovery proof does not match the upload journal.');
      Object.defineProperty(state.materialized,local,{value:structuredClone(identity),enumerable:true,writable:true,configurable:true});delete state.uploads[id];
    });
  }
  markMaterialized(local,identity){return this.update(state=>{Object.defineProperty(state.materialized,local,{value:structuredClone(identity),enumerable:true,writable:true,configurable:true});});}
}
module.exports={WindowsDriveState};
