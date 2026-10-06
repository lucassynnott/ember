const path=require('node:path');
const {validLocal}=require('./windows-drive-names');
const {WindowsDriveRuntime}=require('./windows-drive-runtime');

// Translates the existing renderer protocol without exposing encrypted state
// or treating a remote object key as a local filesystem path.
class WindowsDriveService {
  constructor({app,safeStorage,shell,onStatus=()=>{},onEvent=()=>{},runtime=null}) {
    this.shell=shell;this.onEvent=onEvent;this.ready=null;
    this.runtime=runtime||new WindowsDriveRuntime({app,safeStorage,directory:path.join(app.getPath('userData'),'windows-drive'),root:path.join(app.getPath('home'),'Ember Drive'),onStatus});
  }
  get status(){return this.runtime.status;}
  get mountPath(){return this.runtime.mountPath;}
  start(){if(!this.ready)this.ready=this.runtime.start();return this.ready;}
  stop(){return this.runtime.unmount();}
  #config(input){
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Missing storage settings.');
    const config={...input},saved=this.runtime.state.snapshot().config;
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
        const saved=this.runtime.state.snapshot().config;if(!saved)return {};
        const {applicationKey,...publicSettings}=saved;return {...publicSettings,applicationKey:'',hasSecret:Boolean(applicationKey)};
      }
      case 'test':{
        this.onEvent('test',{checks:[{id:1,title:'Read and write cloud storage',state:'running',detail:'Uploading, reading and removing a unique test file.'}]});
        try{const result=await this.runtime.test(this.#config(args.config));this.onEvent('test',{checks:[{id:1,title:'Read and write cloud storage',state:'passed',detail:'The uploaded bytes were read back and the test file was removed.'}]});return result;}
        catch(error){this.onEvent('test',{checks:[{id:1,title:'Read and write cloud storage',state:'failed',detail:error.message}]});throw error;}
      }
      case 'save':return this.runtime.save(this.#config(args.config));
      case 'forget':return this.runtime.forget();
      case 'mount':await this.runtime.mount();return true;
      case 'unmount':await this.runtime.unmount();return true;
      case 'open':{
        if(!this.mountPath)throw new Error('Drive is not mounted.');const error=await this.shell.openPath(this.mountPath);if(error)throw new Error(error);return true;
      }
      case 'reveal':this.shell.showItemInFolder(this.localPath(args.key).target);return true;
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
      case 'cache':return this.runtime.cache();
      case 'cacheLimit':return this.runtime.setCacheLimit(args.gb);
      case 'clearCache':return this.runtime.enforceCache({clear:true});
      case 'recoverFolder':return this.runtime.recoverFolder(args.id);
      case 'recover':return this.runtime.recover(args.id);
      default:throw new Error(`Windows Drive command is not available: ${command}`);
    }
  }
}
module.exports={WindowsDriveService};
