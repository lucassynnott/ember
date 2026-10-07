const fs=require('node:fs');const fsp=require('node:fs/promises');const path=require('node:path');const {validLocal}=require('./windows-drive-names');
class WindowsDriveSync {
  constructor({root,state,bridge,upload,onStatus=()=>{},watchImpl=fs.watch,reserveFile=null,reserveFolder=null,syncFolder=null,debounceMs=750,scanIntervalMs=60000}){
    Object.assign(this,{root,state,bridge,upload,onStatus,watchImpl,reserveFile,reserveFolder,syncFolder,debounceMs,scanIntervalMs});this.added=new Map();this.pending=new Map();this.ready=new Set();this.closed=false;this.running=null;this.controller=new AbortController();this.preparing=new Set();this.paused=false;this.pauseGate=null;this.pauseOperation=null;
  }
  start(){
    this.watcher=this.watchImpl(this.root,{recursive:true,encoding:'utf8'},(_event,filename)=>{if(filename)this.notify(String(filename).replaceAll('\\','/'));else void this.scan();});
    this.watcher.on('error',error=>this.onStatus({error:error.message}));this.watcher.unref?.();
    this.interval=setInterval(()=>void this.scan(),this.scanIntervalMs);this.interval.unref?.();void this.scan();
  }
  notify(local){
    if(this.closed)return;
    const tracked=this.state.snapshot().materialized||{};
    // Native namespace reconciliation handles additions/deletions separately.
    const actual=Object.keys(tracked).find(name=>name.toUpperCase()===local.toUpperCase());
    if(actual&&tracked[actual].key.endsWith('/')&&(tracked[actual].remoteConfirmed!==false||!this.syncFolder))return;
    if(!actual&&!this.reserveFile&&!this.reserveFolder)return;
    const selected=actual||local;if(selected.split('/').some(part=>!validLocal(part)))return;
    clearTimeout(this.pending.get(selected));
    const timer=setTimeout(()=>{this.pending.delete(selected);void this.#prepare(selected).catch(error=>this.onStatus({held:selected,error:error.message}));},this.debounceMs);timer.unref?.();this.pending.set(selected,timer);
  }
  async #prepare(local){
    const operation=this.#prepareAfter(local,this.pauseGate);this.preparing.add(operation);
    try{await operation;}finally{this.preparing.delete(operation);}
  }
  async #prepareAfter(local,gate){
    if(gate)await gate;
    if(this.closed)return;
    if(!this.state.snapshot().materialized?.[local]){
      const stat=await fsp.lstat(path.join(this.root,...local.split('/')));if(stat.isSymbolicLink())return;
      if(stat.isDirectory()&&this.reserveFolder)this.added.set(local,{key:await this.reserveFolder(local)});
      else if(stat.isFile()&&this.reserveFile)this.added.set(local,{key:await this.reserveFile(local)});else return;
    }
    if(this.closed)return;this.ready.add(local);this.#pump();
  }
  async scan(){
    if(this.closed)return;
    for(const [local,identity]of Object.entries(this.state.snapshot().materialized||{}))if(!identity.key.endsWith('/')||identity.remoteConfirmed===false)this.notify(local);
    if(this.reserveFile||this.reserveFolder){
      try{const directories=[''];let count=0;for(let index=0;index<directories.length&&!this.closed;index++){
        const parent=directories[index];for(const entry of await fsp.readdir(path.join(this.root,parent),{withFileTypes:true})){
          if(++count>1000000)throw new Error('Local Drive directory exceeds its limit.');if(entry.isSymbolicLink())continue;
          const local=(parent?parent+'/':'')+entry.name;if(entry.isDirectory()){directories.push(local);if(this.reserveFolder)this.notify(local);}else if(entry.isFile())this.notify(local);
        }
      }}catch(error){if(!this.closed)this.onStatus({error:error.message});}
    }
  }
  #pump(){
    if(this.running||this.closed||this.paused)return;
    this.running=this.#run().catch(error=>this.onStatus({error:error.message})).finally(()=>{this.running=null;if(this.ready.size&&!this.closed)this.#pump();});
  }
  async #run(){
    while(this.ready.size&&!this.closed&&!this.paused){
      const local=this.ready.values().next().value;this.ready.delete(local);
      const snapshot=this.state.snapshot(),identity=snapshot.materialized?.[local]||this.added.get(local);if(!identity)continue;
      if([...Object.values(snapshot.uploads||{}),...Object.values(snapshot.folderUploads||{}),...Object.values(snapshot.backups||{})].some(entry=>entry.local.toUpperCase()===local.toUpperCase()||entry.key===identity.key)){this.onStatus({held:local,reason:'unfinished-upload'});continue;}
      try{
        if(identity.key.endsWith('/')){if(!this.syncFolder)continue;this.onStatus({uploading:local});await this.syncFolder(local,identity.key,{signal:this.controller.signal});this.added.delete(local);this.onStatus({synced:local});continue;}
        const current=await this.bridge.inspect(local);
        if(!current.exists){this.onStatus({held:local,reason:'local-missing'});continue;}
        if(current.cloud&&current.inSync&&current.modifiedBytes===0)continue;
        this.onStatus({uploading:local});
        await this.upload(local,identity.key,{signal:this.controller.signal});
        this.added.delete(local);this.onStatus({synced:local});
      }catch(error){if(!this.closed)this.onStatus({held:local,error:error.message});}
    }
  }
  pauseFor(operation){
    if(this.closed||this.paused)return Promise.reject(new Error('Drive synchronization cannot be paused now.'));
    const preparing=[...this.preparing],running=this.running;let resume;this.paused=true;this.pauseGate=new Promise(resolve=>{resume=resolve;});
    // Finish already-started reservations/uploads; new notifications wait for
    // the fresh namespace rather than racing its persisted filename mappings.
    const task=(async()=>{
      try{await Promise.allSettled([...preparing,...(running?[running]:[])]);if(this.closed)throw new Error('Drive synchronization stopped.');return await operation(this.controller.signal);}
      finally{this.paused=false;this.pauseGate=null;resume();this.#pump();}
    })();
    this.pauseOperation=task;task.finally(()=>{if(this.pauseOperation===task)this.pauseOperation=null;}).catch(()=>{});return task;
  }
  async close(){this.closed=true;this.watcher?.close();clearInterval(this.interval);for(const timer of this.pending.values())clearTimeout(timer);this.pending.clear();this.ready.clear();this.controller.abort();await Promise.allSettled([this.running,this.pauseOperation,...this.preparing].filter(Boolean));}
}
module.exports={WindowsDriveSync};
