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
      this.state=value;
    }catch(error){if(error.code!=='ENOENT')throw new Error('Windows Drive settings could not be opened. The existing state was preserved.',{cause:error});this.state={version:1,identity:crypto.randomUUID(),config:null,mappings:{},materialized:{}};}
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
  saveMappings(mappings){return this.update(state=>{state.mappings=structuredClone(mappings);});}
  markMaterialized(local,identity){return this.update(state=>{Object.defineProperty(state.materialized,local,{value:structuredClone(identity),enumerable:true,writable:true,configurable:true});});}
}
module.exports={WindowsDriveState};
