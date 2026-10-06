const path=require('node:path');const fs=require('node:fs/promises');const os=require('node:os');const crypto=require('node:crypto');
const {WindowsDriveState}=require('./windows-drive-state');const {WindowsDriveStore}=require('./windows-drive-store');const {WindowsCloudFiles}=require('./windows-cloud-files');const {populateInitialNamespace}=require('./windows-drive-namespace');

// Owns one cloud identity and its local root. The persistent daemon/app wiring
// and write reconciliation build on this lifecycle; this class is not UI-enabled yet.
class WindowsDriveRuntime {
  constructor({app,safeStorage,directory,root,platform=process.platform,onStatus=()=>{},storeFactory=WindowsDriveStore.create,bridgeFactory=options=>new WindowsCloudFiles(options),state=null}){
    Object.assign(this,{app,onStatus,storeFactory,bridgeFactory});this.state=state||new WindowsDriveState({directory,safeStorage});this.root=root;this.store=null;this.bridge=null;this.started=false;this.queue=Promise.resolve();
    this.status={supported:platform==='win32',configured:false,mounted:false,path:null,conflicts:[]};
  }
  #publish(update){this.status={...this.status,...update};this.onStatus({...this.status});}
  #serial(operation){const pending=this.queue.then(operation);this.queue=pending.catch(()=>{});return pending;}
  async start(){
    if(!this.status.supported)return;if(this.started)return;
    const state=await this.state.load();this.started=true;this.#publish({configured:Boolean(state.config)});
    if(state.config)await this.mount();
  }
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
  save(config){return this.#serial(async()=>{
    const before=this.state.snapshot();
    const storageIdentity=value=>JSON.stringify(['provider','bucketName','accountID','endpoint','region'].map(key=>value?.[key]||''));
    if(before.config&&storageIdentity(before.config)!==storageIdentity(config)&&Object.keys(before.materialized).length)throw new Error('Switching storage requires a separate Drive root; existing files were preserved.');
    await this.test(config);await this.#unmount();await this.state.configure(config);this.#publish({configured:true});await this.#mount();return true;
  });}
  mount(){return this.#serial(()=>this.#mount());}
  async #mount(){
    if(this.bridge&&!this.bridge.closed)return;
    const state=this.state.snapshot();if(!state.config)throw new Error('Configure storage before mounting Ember Drive.');
    const store=await this.storeFactory(state.config);let bridge;
    try {
      await fs.mkdir(this.root,{recursive:true});bridge=this.bridgeFactory({app:this.app,store});
      bridge.on('stopped',()=>{if(this.bridge===bridge){this.bridge=null;this.store=null;store.close();this.#publish({mounted:false,path:null});}});
      await bridge.register(this.root,state.identity);
      const result=await populateInitialNamespace(bridge,store,{mappings:state.mappings,saveMappings:mappings=>this.state.saveMappings(mappings),onMaterialized:(local,identity)=>this.state.markMaterialized(local,identity)});
      this.store=store;this.bridge=bridge;this.#publish({mounted:true,path:this.root,conflicts:result.conflicts});
    }catch(error){bridge?.close();store.close();this.#publish({mounted:false,path:null});throw error;}
  }
  unmount(){return this.#serial(()=>this.#unmount());}
  async #unmount(){const bridge=this.bridge,store=this.store;this.bridge=null;this.store=null;try{if(bridge&&!bridge.closed)await bridge.command('disconnect');}finally{bridge?.close();store?.close();this.#publish({mounted:false,path:null});}}
  async pin(local){if(!this.bridge)throw new Error('Drive is not mounted.');return this.bridge.pin(local);}
  async unpin(local){if(!this.bridge)throw new Error('Drive is not mounted.');return this.bridge.unpin(local);}
  async share(key){if(!this.store)throw new Error('Drive is not mounted.');return this.store.shareURL(key);}
  async search(query){
    if(typeof query!=='string'||query.length>200)throw new Error('Invalid Drive search.');const text=query.trim().toLocaleLowerCase();
    return Object.entries(this.state.snapshot().materialized).filter(([local])=>local.toLocaleLowerCase().includes(text)).slice(0,200).map(([local,identity])=>({key:identity.key,path:local,name:path.posix.basename(local)}));
  }
}
module.exports={WindowsDriveRuntime};
