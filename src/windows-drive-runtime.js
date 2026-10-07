const {replacePinnedRevision,recoverPinnedRevision,pinnedRecoveryCopies}=require('./windows-drive-pinned-update');
const {moveLocalFile,recoverMove}=require('./windows-drive-move');
const {pendingOperations}=require('./windows-drive-pending');
const path=require('node:path');const fs=require('node:fs/promises');const os=require('node:os');const crypto=require('node:crypto');
const {backUpFile,recoverBackUpFile}=require('./windows-drive-backup');
const {syncLocalFolder,recoverLocalFolder}=require('./windows-drive-folders');
const {WindowsDriveCache}=require('./windows-drive-cache');
const {WindowsDriveSync}=require('./windows-drive-sync');
const {recoverUpload}=require('./windows-drive-recovery');
const {uploadLocalFile}=require('./windows-drive-upload');
const {WindowsDriveState,storageIdentity}=require('./windows-drive-state');const {WindowsDriveStore}=require('./windows-drive-store');const {WindowsCloudFiles}=require('./windows-cloud-files');const {populateInitialNamespace}=require('./windows-drive-namespace');

// Owns one cloud identity and its local root inside the persistent Drive daemon.
// Cloud refresh serializes namespace changes with local upload reservations.
class WindowsDriveRuntime {
  constructor({app,safeStorage,directory,root,platform=process.platform,onStatus=()=>{},storeFactory=WindowsDriveStore.create,bridgeFactory=options=>new WindowsCloudFiles(options),state=null,syncEnabled=true,refreshIntervalMs=60000}){
    Object.assign(this,{app,onStatus,storeFactory,bridgeFactory,syncEnabled,refreshIntervalMs});this.refreshTimer=null;this.refreshPending=null;this.refreshController=null;this.refreshGeneration=0;this.recoveryController=null;this.backupController=null;this.sync=null;this.cacheTimer=null;this.state=state||new WindowsDriveState({directory,safeStorage});this.root=root;this.store=null;this.bridge=null;this.started=false;this.queue=Promise.resolve();
    this.status={supported:platform==='win32',configured:false,mounted:false,path:null,conflicts:[]};
  }
  #publish(update){this.status={...this.status,...update};this.onStatus({...this.status});}
  #serial(operation){const pending=this.queue.then(operation);this.queue=pending.catch(()=>{});return pending;}
  async start(){
    if(!this.status.supported)return;if(this.started)return;
    const state=await this.state.load();this.started=true;this.#publish({configured:Boolean(state.config),provider:state.config?.provider||null,bucket:state.config?.bucketName||null,cacheLimitGB:state.cacheLimitGB??20});
    if(state.config)await this.mount();
  }
  backupStatus(scan){this.#publish({backupScan:scan});}
  get mountPath(){return this.status.mounted?this.root:null;}
  async test(config){
    const store=await this.storeFactory(config);const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drive-connection-')),name='.ember-connection-test/'+crypto.randomUUID();let uploaded=false,revision=null,cleanupAttempted=false;
    try {
      const bytes=crypto.randomBytes(64),file=path.join(directory,'fixture');await fs.writeFile(file,bytes);await store.upload(file,name);uploaded=true;
      revision=await store.stat(name);if(!revision||revision.size!==bytes.length||!revision.etag)throw new Error('Cloud storage did not confirm the test upload.');
      const read=await store.read(name,0,bytes.length,revision.fileID,undefined,revision.etag);if(!read.equals(bytes))throw new Error('Cloud storage returned different test bytes.');
      cleanupAttempted=true;await store.deleteVersion(name,revision.fileID||'',{etag:revision.etag});uploaded=false;return true;
    }finally{
      // A failed or uncertain write is never replayed. Remove only the unique
      // test object's confirmed revision; otherwise report it for later cleanup.
      if(uploaded&&revision?.etag&&!cleanupAttempted)await store.deleteVersion(name,revision.fileID||'',{etag:revision.etag}).catch(()=>{});
      store.close();await fs.rm(directory,{recursive:true,force:true});
    }
  }
  save(config){this.refreshGeneration++;this.refreshController?.abort();this.recoveryController?.abort();this.backupController?.abort();return this.#serial(async()=>{
    const before=this.state.snapshot();
    if((before.storageBinding??storageIdentity(before.config))!==storageIdentity(config)&&Object.keys(before.materialized).length)throw new Error('Switching storage requires a separate Drive root; existing files were preserved.');
    await this.test(config);await this.#unmount();await this.state.configure(config);this.#publish({configured:true,provider:config.provider,bucket:config.bucketName});await this.#mount();return true;
  });}
  forget(){this.refreshGeneration++;this.refreshController?.abort();this.recoveryController?.abort();this.backupController?.abort();return this.#serial(async()=>{
    await this.#unmount();await this.state.forget();
    this.#publish({configured:false,provider:null,bucket:null,pins:{keys:[],syncing:false,done:0,total:0},message:null});return true;
  });}
  mount(){return this.#serial(()=>this.#mount());}
  async #mount(){
    if(this.bridge&&!this.bridge.closed)return;
    const state=this.state.snapshot();if(!state.config)throw new Error('Configure storage before mounting Ember Drive.');
    const store=await this.storeFactory(state.config);let bridge;const controller=new AbortController();this.refreshController=controller;
    try {
      await fs.mkdir(this.root,{recursive:true});bridge=this.bridgeFactory({app:this.app,store});
      bridge.on('stopped',()=>{if(this.bridge===bridge){clearInterval(this.cacheTimer);clearInterval(this.refreshTimer);this.refreshTimer=null;this.refreshController?.abort();this.recoveryController?.abort();this.backupController?.abort();this.cacheTimer=null;void this.sync?.close();this.sync=null;this.bridge=null;this.store=null;store.close();this.#publish({mounted:false,path:null,message:'The Windows Drive provider stopped. Reconnect the drive to resume syncing.'});}});
      await bridge.register(this.root,state.identity);
      if(controller.signal.aborted)throw new Error('Drive mount cancelled.');
      const result=await populateInitialNamespace(bridge,store,{mappings:state.mappings,materialized:state.materialized,pending:this.#pending(state),preserveMissing:true,signal:controller.signal,refreshPinned:(local,object,signal)=>replacePinnedRevision({local,object,signal,root:this.root,bridge,store,state:this.state}),saveMappings:mappings=>this.state.saveMappings(mappings),onMaterialized:(local,identity)=>this.state.markMaterialized(local,identity.key.endsWith('/')?{...identity,remoteConfirmed:true}:identity)});
      if(controller.signal.aborted)throw new Error('Drive mount cancelled.');
      this.store=store;this.bridge=bridge;
      if(this.syncEnabled){this.sync=new WindowsDriveSync({root:this.root,state:this.state,bridge,reserveFile:(local,from)=>from?this.state.reserveLocalMove(from,local):this.state.reserveLocalFile(local),reserveFolder:local=>this.state.reserveLocalFolder(local),syncFolder:(...args)=>this.syncFolder(...args),move:(...args)=>this.move(...args),upload:(...args)=>this.upload(...args),onStatus:sync=>this.#publish({sync})});this.sync.start();}
      this.#publish({mounted:true,path:this.root,conflicts:result.conflicts,message:null});
      if(bridge.explorerStatus){try{const shellStatus=await bridge.explorerStatus();this.#publish({sidebarReady:Boolean(shellStatus.registered)});}catch(error){this.#publish({sidebarReady:false,message:error.message});}}
      if(this.syncEnabled){this.refreshTimer=setInterval(()=>void this.refresh().catch(()=>{}),this.refreshIntervalMs);this.refreshTimer.unref?.();this.cacheTimer=setInterval(()=>void this.enforceCache().catch(error=>this.#publish({message:error.message})),60000);this.cacheTimer.unref?.();void this.enforceCache().catch(error=>this.#publish({message:error.message}));}
    }catch(error){await this.sync?.close();this.sync=null;this.bridge=null;this.store=null;bridge?.close();store.close();this.#publish({mounted:false,path:null,message:error.message});throw error;}
    finally{if(this.refreshController===controller)this.refreshController=null;}
  }
  unmount(){this.refreshGeneration++;this.refreshController?.abort();this.recoveryController?.abort();this.backupController?.abort();return this.#serial(()=>this.#unmount());}
  async #unmount(){clearInterval(this.refreshTimer);this.refreshTimer=null;this.refreshController?.abort();clearInterval(this.cacheTimer);this.cacheTimer=null;await this.sync?.close();this.sync=null;const bridge=this.bridge,store=this.store;this.bridge=null;this.store=null;try{if(bridge&&!bridge.closed)await bridge.command('disconnect');}finally{try{if(bridge?.closeAndWait)await bridge.closeAndWait();else bridge?.close();}finally{store?.close();this.#publish({mounted:false,path:null});}}}
  #pending(snapshot){return pendingOperations(snapshot);}
  refresh(){
    if(this.refreshPending)return this.refreshPending;
    const generation=this.refreshGeneration;
    const task=this.#serial(async()=>{
      if(generation!==this.refreshGeneration)throw new Error('Drive refresh cancelled.');
      if(!this.bridge||!this.store)throw new Error('Drive is not mounted.');
      const bridge=this.bridge,store=this.store,controller=new AbortController();this.refreshController=controller;
      const populate=async signal=>{
        const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
        try{
          const snapshot=this.state.snapshot();
          const result=await populateInitialNamespace(bridge,store,{mappings:snapshot.mappings,materialized:snapshot.materialized,pending:this.#pending(snapshot),preserveMissing:true,signal:controller.signal,refreshPinned:(local,object,signal)=>replacePinnedRevision({local,object,signal,root:this.root,bridge,store,state:this.state}),saveMappings:mappings=>this.state.saveMappings(mappings),onMaterialized:(local,identity)=>this.state.markMaterialized(local,identity.key.endsWith('/')?{...identity,remoteConfirmed:true}:identity)});
          if(controller.signal.aborted||this.bridge!==bridge)throw new Error('Drive refresh cancelled.');
          this.#publish({conflicts:result.conflicts,lastRefreshed:Date.now(),message:null});return result;
        }finally{signal?.removeEventListener('abort',abort);}
      };
      try{return await (this.sync?this.sync.pauseFor(populate):populate());}
      catch(error){if(this.bridge===bridge&&!controller.signal.aborted)this.#publish({message:error.message});throw error;}
      finally{if(this.refreshController===controller)this.refreshController=null;}
    });
    this.refreshPending=task;task.finally(()=>{if(this.refreshPending===task)this.refreshPending=null;}).catch(()=>{});return task;
  }
  sidebar(){return this.#serial(async()=>{
    if(!this.bridge)throw new Error('Drive is not mounted.');const result=await this.bridge.explorerRegister();
    if(!result.registered)throw new Error('Windows did not confirm the File Explorer registration.');
    this.#publish({sidebarReady:true,message:null});return {error:null};
  });}
  async cache(){
    if(!this.bridge)throw new Error('Drive is not mounted.');
    const result=await new WindowsDriveCache({state:this.state,bridge:this.bridge}).inspect();
    this.#publish({pins:{keys:result.files.filter(file=>file.pinned).map(file=>file.key),syncing:false,done:0,total:0},cacheLimitGB:result.limitGB});return result;
  }
  enforceCache(options){return this.#serial(async()=>{
    if(!this.bridge)throw new Error('Drive is not mounted.');
    const result=await new WindowsDriveCache({state:this.state,bridge:this.bridge}).enforce(options);
    this.#publish({cacheLimitGB:result.limitGB,cache:{bytes:result.bytes,pinnedBytes:result.pinnedBytes,protectedBytes:result.protectedBytes,overLimit:result.overLimit,held:result.held,errors:result.errors}});return result;
  });}
  async setCacheLimit(gb){await this.state.setCacheLimit(gb);this.#publish({cacheLimitGB:gb});if(this.bridge)await this.enforceCache();return true;}
  backUp(file,relative,{signal}={}){const generation=this.refreshGeneration;return this.#serial(async()=>{
    if(generation!==this.refreshGeneration)throw new Error('Backup cancelled.');
    if(!this.bridge||!this.mountPath)return false;
    const controller=new AbortController();this.backupController=controller;
    const combined=AbortSignal.any([controller.signal,signal].filter(Boolean));
    try{if(combined.aborted)throw new Error('Backup cancelled.');return await backUpFile({root:this.root,file,relative,state:this.state,bridge:this.bridge,signal:combined});}
    finally{if(this.backupController===controller)this.backupController=null;}
  });}
  recoveryEntries({offset=0,limit=50}={}){
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>200)throw new Error('Invalid recovery page.');
    const snapshot=this.state.snapshot(),entries=['uploads','folderUploads','backups','moves','pinnedUpdates'].flatMap((name,index)=>Object.entries(snapshot[name]||{}).map(([id,entry])=>({id,type:['upload','folder','backup','move','pinned'][index],local:typeof entry.local==='string'?entry.local:'Unknown file',started:Number.isSafeInteger(entry.started)?entry.started:0})));
    entries.sort((a,b)=>a.started-b.started||a.id.localeCompare(b.id));return {entries:entries.slice(offset,offset+limit),count:entries.length};
  }
  #recover(operation,signal,{mounted=true}={}){return this.#serial(async()=>{
    if(mounted&&(!this.bridge||!this.store))throw new Error('Drive is not mounted.');
    const controller=new AbortController();this.recoveryController=controller;
    const run=parent=>operation(AbortSignal.any([controller.signal,signal,parent].filter(Boolean)));
    try{return await (this.sync?this.sync.pauseFor(run):run());}finally{if(this.recoveryController===controller)this.recoveryController=null;}
  });}
  pinnedRecoveryCopies(id,{signal}={}){return this.#recover(signal=>pinnedRecoveryCopies({id,state:this.state,signal}),signal,{mounted:false});}
  recoverPinned(id,{signal}={}){return this.#recover(signal=>recoverPinnedRevision({id,state:this.state,bridge:this.bridge,store:this.store,signal}),signal);}
  recoverBackup(id,{signal}={}){return this.#recover(signal=>recoverBackUpFile({id,state:this.state,bridge:this.bridge,signal}),signal);}
  async syncFolder(local,key,{signal}={}){if(!this.bridge||!this.store)throw new Error('Drive is not mounted.');return syncLocalFolder({root:this.root,local,key,bridge:this.bridge,store:this.store,state:this.state,signal});}
  recoverFolder(id,{signal}={}){return this.#recover(signal=>recoverLocalFolder({id,root:this.root,bridge:this.bridge,store:this.store,state:this.state,signal}),signal);}
  recover(id,{signal}={}){return this.#recover(signal=>recoverUpload({id,bridge:this.bridge,store:this.store,state:this.state,signal}),signal);}
  move(from,local,key,{signal}={}){if(!this.bridge||!this.store)return Promise.reject(new Error('Drive is not mounted.'));return moveLocalFile({from,local,key,bridge:this.bridge,store:this.store,state:this.state,signal});}
  recoverMove(id,{signal,finish=false}={}){return this.#recover(signal=>recoverMove({id,bridge:this.bridge,store:this.store,state:this.state,signal,finish}),signal);}
  async upload(local,key,{signal,progress}={}){if(!this.bridge||!this.store)throw new Error('Drive is not mounted.');return uploadLocalFile({bridge:this.bridge,store:this.store,state:this.state,local,key,signal,progress});}
  async pin(local){if(!this.bridge)throw new Error('Drive is not mounted.');const result=await this.bridge.pin(local);await this.cache();return result;}
  async unpin(local){if(!this.bridge)throw new Error('Drive is not mounted.');const result=await this.bridge.unpin(local);await this.cache();return result;}
  async share(key){if(!this.store)throw new Error('Drive is not mounted.');return this.store.shareURL(key);}
  async search(query){
    if(typeof query!=='string'||query.length>200)throw new Error('Invalid Drive search.');const text=query.trim().toLocaleLowerCase();
    return Object.entries(this.state.snapshot().materialized).filter(([local,identity])=>!identity.key.endsWith('/')&&local.toLocaleLowerCase().includes(text)).slice(0,200).map(([local,identity])=>({key:identity.key,path:local,name:path.posix.basename(local)}));
  }
}
module.exports={WindowsDriveRuntime};
