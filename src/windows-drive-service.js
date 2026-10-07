const path=require('node:path');
const {validLocal}=require('./windows-drive-names');
const {WindowsDriveAccountRuntime}=require('./windows-drive-account-runtime');
const {storageIdentity}=require('./windows-drive-state');

// Translates the existing renderer protocol without exposing encrypted state
// or treating a remote object key as a local filesystem path.
class WindowsDriveService {
  constructor({app,safeStorage,shell,onStatus=()=>{},onEvent=()=>{},runtime=null}) {
    this.shell=shell;this.onEvent=onEvent;this.ready=null;
    this.runtime=runtime||new WindowsDriveAccountRuntime({app,safeStorage,directory:path.join(app.getPath('userData'),'windows-drive'),home:app.getPath('home'),onStatus}).facade;
  }
  get status(){return this.runtime.status;}
  get mountPath(){return this.runtime.mountPath;}
  start(){if(!this.ready){const pending=this.runtime.start();this.ready=pending;pending.catch(()=>{if(this.ready===pending)this.ready=null;});}return this.ready;}
  stop(){return this.runtime.unmount();}
  async backUp(file,relative){if(this.ready)await this.ready;return this.runtime.backUp(file,relative);}
  #config(input){
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Missing storage settings.');
    const config={...input},snapshot=this.runtime.state.snapshot(),saved=[snapshot.config,snapshot.setupDraft].find(candidate=>candidate&&candidate.provider===config.provider&&candidate.keyID===config.keyID);
    // A blank secret retains it only for the same access-key identity.
    if(!config.applicationKey&&saved&&saved.provider===config.provider&&saved.keyID===config.keyID)config.applicationKey=saved.applicationKey;
    return config;
  }
  localPath(key){
    if(typeof key!=='string'||!key)throw new Error('Missing Drive object name.');
    const matches=Object.entries(this.runtime.state.snapshot().materialized).filter(([,identity])=>identity.key===key);
    if(matches.length!==1)throw new Error('The Drive object does not have a unique local file.');
    const local=matches[0][0],root=this.mountPath;
    if(local.split('/').some(component=>!validLocal(component)))throw new Error('Invalid local Drive path.');
    if(!root)throw new Error('Drive is not mounted.');
    const target=path.resolve(root,...local.split('/')),relative=path.relative(root,target);
    if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('Invalid local Drive path.');
    return {local,target};
  }
  async request(command,args={}){
    if(this.ready)await this.ready;
    if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('Invalid Drive command arguments.');
    switch(command){
      case 'status':return this.status;
      case 'settings':{
        const snapshot=this.runtime.state.snapshot(),saved=snapshot.config||snapshot.setupDraft;if(!saved)return {};
        const {applicationKey,...publicSettings}=saved;return {...publicSettings,applicationKey:'',hasSecret:Boolean(applicationKey)};
      }
      case 'test':{
        this.onEvent('test',{checks:[{id:1,title:'Read and write cloud storage',state:'running',detail:'Uploading, reading and removing a unique test file.'}]});
        try{const result=await this.runtime.test(this.#config(args.config));this.onEvent('test',{checks:[{id:1,title:'Read and write cloud storage',state:'passed',detail:'The uploaded bytes were read back and the test file was removed.'}]});return result;}
        catch(error){this.onEvent('test',{checks:[{id:1,title:'Read and write cloud storage',state:'failed',detail:error.message}]});throw error;}
      }
      case 'save':return this.runtime.save(this.#config(args.config));
      case 'assertStorage':{
        const snapshot=this.runtime.state.snapshot();
        if(!this.runtime.selectAccount&&Object.keys(snapshot.materialized).length&&(snapshot.storageBinding??storageIdentity(snapshot.config))!==storageIdentity(args.config))throw new Error('Switching storage requires a separate Drive root; existing files were preserved.');return true;
      }
      case 'setupDraft':{
        if(args.config)return this.runtime.state.saveSetupDraft(args.config);
        const draft=this.runtime.state.snapshot().setupDraft;if(!draft)return null;const {applicationKey,...publicDraft}=draft;return publicDraft;
      }
      case 'resumeSetup':case 'testSetup':{
        const draft=this.runtime.state.snapshot().setupDraft;if(!draft)throw new Error('No unfinished storage setup exists.');
        return command==='resumeSetup'?this.runtime.save(draft):this.runtime.test(draft);
      }
      case 'forget':return this.runtime.forget();
      case 'sync':return this.runtime.refresh();
      case 'mount':await this.runtime.mount();return true;
      case 'unmount':await this.runtime.unmount();return true;
      case 'open':{
        if(!this.mountPath)throw new Error('Drive is not mounted.');const error=await this.shell.openPath(this.mountPath);if(error)throw new Error(error);return true;
      }
      case 'reveal':this.shell.showItemInFolder(this.localPath(args.key).target);return true;
      case 'resolve':return this.localPath(args.key).target;
      case 'share':this.localPath(args.key);return this.runtime.share(args.key);
      case 'search':{
        const hits=await this.runtime.search(args.query||'');const entries=this.runtime.state.snapshot().materialized;
        return {hits:hits.map(hit=>({...hit,folder:path.posix.dirname(hit.path)==='.'?'':path.posix.dirname(hit.path),size:entries[hit.path]?.size||0})),count:Object.values(entries).filter(entry=>!entry.key.endsWith('/')).length};
      }
      case 'pin':case 'unpin':{
        if(!Array.isArray(args.keys)||!args.keys.length||args.keys.length>1000)throw new Error('Choose files to change offline availability.');
        const entries=this.runtime.state.snapshot().materialized,locals=new Set();
        for(const key of args.keys){
          const selected=this.localPath(key).local;
          if(key.endsWith('/')){for(const [local,identity] of Object.entries(entries))if(local.startsWith(selected+'/')&&!identity.key.endsWith('/'))locals.add(local);}
          else locals.add(selected);
        }
        if(locals.size>10000)throw new Error('The offline selection exceeds its limit.');
        for(const local of locals)await this.runtime[command](local);return true;
      }
      case 'sidebar':return this.runtime.sidebar();
      case 'cache':return this.runtime.cache();
      case 'cacheLimit':return this.runtime.setCacheLimit(args.gb);
      case 'clearCache':return this.runtime.enforceCache({clear:true});
      case 'recoverBackup':return this.runtime.recoverBackup(args.id);
      case 'recoverFolder':return this.runtime.recoverFolder(args.id);
      case 'recover':{
        if(args.kind==='account'){if(args.select!==true||typeof this.runtime.selectAccount!=='function')throw new Error('Choose a saved Windows Drive account.');return this.runtime.selectAccount(args.id);}
        if(args.kind==='delete'){
          if(args.finish===true)throw new Error('Retry the deletion in File Explorer after checking its recorded outcome.');
          if(args.revealFile===true){const entry=this.runtime.state.snapshot().deletes?.[args.id];if(!entry)throw new Error('The deletion record no longer exists.');const local=this.localPath(entry.key);if(local.local!==entry.local)throw new Error('The deletion binding changed.');this.shell.showItemInFolder(local.target);return {revealed:true};}
          return this.runtime.recoverDelete(args.id);
        }
        if(args.kind==='pinned-copy'){if(args.forget===true)return this.runtime.forgetSavedPinnedCopies(args.id);if(args.revealCopies!==true)throw new Error('Choose Reveal saved copies to inspect this completed recovery.');const files=await this.runtime.savedPinnedCopies(args.id);this.shell.showItemInFolder((files.find(file=>file.name==='local-1')||files[0]).file);return {revealed:true};}
        if(args.kind==='pinned'&&args.restore===true){if(args.finish===true)throw new Error('Choose either restoring the original or finishing the downloaded update.');return this.runtime.restorePinned(args.id,{restore:true});}
        if(args.kind==='pinned'&&args.revealCopies===true){const files=await this.runtime.pinnedRecoveryCopies(args.id);this.shell.showItemInFolder((files.find(file=>file.name==='original')||files[0]).file);return {revealed:true};}
        return args.list===true?this.runtime.recoveryEntries({offset:args.offset,limit:args.limit}):args.kind==='pinned'?this.runtime.recoverPinned(args.id,{finish:args.finish===true}):args.kind==='folder-move'?this.runtime.recoverFolderMove(args.id,{finish:args.finish===true}):args.kind==='move'?this.runtime.recoverMove(args.id,{finish:args.finish===true}):this.runtime.recover(args.id);
      }
      default:throw new Error(`Windows Drive command is not available: ${command}`);
    }
  }
}
module.exports={WindowsDriveService};
