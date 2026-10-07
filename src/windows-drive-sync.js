const {pendingOperations,operationTouches}=require('./windows-drive-pending');
const {caseOnlyFileRename,sourceRemovedForRename}=require('./windows-drive-rename-path');
const fs=require('node:fs');const fsp=require('node:fs/promises');const path=require('node:path');const {validLocal}=require('./windows-drive-names');
class WindowsDriveSync {
  constructor({root,state,bridge,upload,onStatus=()=>{},watchImpl=fs.watch,reserveFile=null,reserveFolder=null,syncFolder=null,move=null,moveFolder=null,reserveFolderMove=null,debounceMs=750,scanIntervalMs=60000}){
    Object.assign(this,{root,state,bridge,upload,onStatus,watchImpl,reserveFile,reserveFolder,syncFolder,move,moveFolder,reserveFolderMove,debounceMs,scanIntervalMs});this.added=new Map();this.renamed=new Map();this.pending=new Map();this.ready=new Set();this.closed=false;this.running=null;this.controller=new AbortController();this.preparing=new Set();this.paused=false;this.pauseGate=null;this.pauseOperation=null;
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
    const selected=this.move&&actual&&caseOnlyFileRename(actual,local)?local:actual||local;if(selected.split('/').some(part=>!validLocal(part)))return;
    clearTimeout(this.pending.get(selected));
    const timer=setTimeout(()=>{this.pending.delete(selected);void this.#prepare(selected).catch(error=>this.onStatus({held:selected,error:error.message}));},this.debounceMs);timer.unref?.();this.pending.set(selected,timer);
  }
  async #prepare(local){
    const operation=this.#prepareAfter(local,this.pauseGate);this.preparing.add(operation);
    try{await operation;}finally{this.preparing.delete(operation);}
  }
  async #redirectCase(local){
    if(!this.move||!this.state.snapshot().materialized?.[local]||this.state.snapshot().materialized[local].key.endsWith('/'))return false;
    const parts=local.split('/'),name=parts.pop();let entries;
    try{entries=await fsp.readdir(path.join(this.root,...parts),{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return false;throw error;}
    if(entries.some(entry=>entry.name===name))return false;
    const matches=entries.filter(entry=>entry.name.toUpperCase()===name.toUpperCase()&&entry.isFile()&&!entry.isSymbolicLink());
    if(matches.length!==1)return false;
    this.notify([...parts,matches[0].name].join('/'));return true;
  }
  async #prepareAfter(local,gate){
    if(gate)await gate;
    if(this.closed||await this.#redirectCase(local))return;
    if(!this.state.snapshot().materialized?.[local]){
      const stat=await fsp.lstat(path.join(this.root,...local.split('/')));if(stat.isSymbolicLink())return;
      if(this.move&&this.bridge.inspect){
        const current=await this.bridge.inspect(local);
        if(current.cloud){
          if(stat.isDirectory()){
            if(!this.moveFolder||!this.reserveFolderMove)throw new Error('Folder moves are not available yet; existing cloud files were preserved.');
            const identity=JSON.parse(current.identity),matches=Object.entries(this.state.snapshot().materialized||{}).filter(([,entry])=>entry.key===identity.key);
            if(matches.length!==1)throw new Error('The renamed directory has no unique source binding.');const from=matches[0][0];if((await this.bridge.inspect(from)).exists)throw new Error('The original directory still exists; both trees were preserved.');
            const key=await this.reserveFolderMove(from,local);this.added.set(local,{key});this.renamed.set(local,{from,key,folder:true});if(this.closed)return;this.ready.add(local);this.#pump();return;
          }
          const parts=local.split('/');for(let index=1;index<parts.length;index++){
            const parent=parts.slice(0,index).join('/'),info=await this.bridge.inspect(parent),recorded=this.state.snapshot().materialized?.[parent];
            if(info.cloud&&info.directory&&(!recorded||recorded.key!==JSON.parse(info.identity).key))throw new Error('Folder moves are not available yet; their children were preserved.');
          }
          const identity=JSON.parse(current.identity),matches=Object.entries(this.state.snapshot().materialized||{}).filter(([,entry])=>entry.key===identity.key);
          if(matches.length!==1)throw new Error('The renamed placeholder has no unique recorded source.');
          const from=matches[0][0];if(!await sourceRemovedForRename({bridge:this.bridge,from,local,localPath:path.join(this.root,...local.split('/'))}))throw new Error('The original local file still exists; both files were preserved.');
          if(!this.reserveFile)throw new Error('Drive cannot reserve the renamed file.');
          const key=await this.reserveFile(local,from);this.added.set(local,{key});this.renamed.set(local,{from,key});
          if(this.closed)return;this.ready.add(local);this.#pump();return;
        }
      }
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
      if(pendingOperations(snapshot).some(entry=>operationTouches(entry,local,identity.key))){this.onStatus({held:local,reason:'unfinished-upload'});continue;}
      try{
        if(await this.#redirectCase(local))continue;
        const completed=this.renamed.get(local);if(completed&&snapshot.materialized?.[local]?.key===completed.key){this.renamed.delete(local);this.added.delete(local);}
        const renamed=this.renamed.get(local);if(renamed){this.onStatus({moving:local});await (renamed.folder?this.moveFolder:this.move)(renamed.from,local,renamed.key,{signal:this.controller.signal});this.renamed.delete(local);this.added.delete(local);this.onStatus({synced:local});continue;}
        if(identity.key.endsWith('/')){if(!this.syncFolder||snapshot.materialized?.[local]?.remoteConfirmed!==false){this.added.delete(local);continue;}this.onStatus({uploading:local});await this.syncFolder(local,identity.key,{signal:this.controller.signal});this.added.delete(local);this.onStatus({synced:local});continue;}
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
