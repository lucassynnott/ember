const {WindowsDriveAccounts}=require('./windows-drive-accounts');const {WindowsDriveRuntime}=require('./windows-drive-runtime');const {storageIdentity}=require('./windows-drive-state');
// Serializes account changes with operations against the selected native root.
// A failed switch keeps the previous account selected and every profile on disk.
class WindowsDriveAccountRuntime {
 constructor({app,safeStorage,directory,home,onStatus=()=>{},runtimeFactory=options=>new WindowsDriveRuntime(options),accounts=null}){
  Object.assign(this,{app,safeStorage,onStatus,runtimeFactory});this.accounts=accounts||new WindowsDriveAccounts({directory,home,safeStorage});this.runtimes=new Map();this.current=null;this.queue=Promise.resolve();this.started=false;
  this.facade=new Proxy(this,{get:(manager,key)=>{
   if(key in manager){const value=manager[key];return typeof value==='function'?value.bind(manager):value;}
   if(!manager.current)throw Error('Drive account profiles have not loaded.');
   const value=manager.current[key];const selected=manager.current;return typeof value==='function'?(...args)=>manager.#serial(()=>{if(manager.current!==selected)throw Error('The selected Drive account changed; retry this operation.');return selected[key](...args);}):value;
  },set:(manager,key,value)=>{if(key==='status'&&manager.current){manager.current.status=value;return true;}manager[key]=value;return true;}});
 }
 #serial(operation){const task=this.queue.then(operation);this.queue=task.catch(()=>{});return task;}
 #runtime(profile){
  if(!this.runtimes.has(profile.id)){let runtime;runtime=this.runtimeFactory({app:this.app,safeStorage:this.safeStorage,directory:profile.directory,root:profile.root,onStatus:()=>{if(this.current===runtime)this.onStatus(this.status);}});this.runtimes.set(profile.id,runtime);}
  return this.runtimes.get(profile.id);
 }
 get state(){if(!this.current)throw Error('Drive account profiles have not loaded.');return this.current.state;}
 backupStatus(scan){this.current?.backupStatus(scan);}
 get accountID(){return this.current?this.accounts.snapshot().active:null;}
 get mountPath(){return this.current?.mountPath||null;}
 get status(){return this.current?{...this.current.status,accountID:this.accountID,accounts:this.listAccounts()}:{supported:process.platform==='win32',configured:false,mounted:false,path:null,accounts:[]};}
 listAccounts(){return this.accounts.snapshot().accounts.filter(entry=>entry.binding!==null).map(entry=>{const [provider,bucket]=JSON.parse(entry.binding);return {id:entry.id,provider,bucket,path:this.accounts.profile(entry.id).root,selected:entry.id===this.accounts.snapshot().active};});}
 start(){return this.#serial(async()=>{
  if(this.started)return;await this.accounts.load();const legacy=this.#runtime(this.accounts.profile('legacy')),snapshot=await legacy.state.load();
  const binding=snapshot.storageBinding??storageIdentity(snapshot.config),registered=this.accounts.profile('legacy').binding;
  if(registered===null)await this.accounts.adoptLegacy(binding);
  else if(registered!==binding&&(binding!==null||Object.keys(snapshot.materialized).length||['uploads','backups','folderUploads','moves','folderMoves','deletes','pinnedUpdates','savedPinnedCopies'].some(key=>Object.keys(snapshot[key]||{}).length)))throw Error('Legacy Drive account binding changed; all profiles were preserved.');
  const profile=this.accounts.profile(),runtime=this.#runtime(profile);
  if(runtime!==legacy){const state=await runtime.state.load();if(state.storageBinding!==profile.binding)throw Error('Drive account profile does not match its registered storage identity.');}
  this.current=runtime;this.started=true;await runtime.start();this.onStatus(this.status);
 });}
 save(config){return this.#serial(async()=>{
  if(!this.started)throw Error('Drive account profiles have not loaded.');
  const profile=await this.accounts.reserve(config),candidate=this.#runtime(profile),previous=this.current;
  if(candidate===previous){await candidate.save(config);await this.accounts.activate(profile.id,candidate.state.snapshot().storageBinding);this.onStatus(this.status);return true;}
  const state=candidate.state.state?candidate.state.snapshot():await candidate.state.load();if(state.storageBinding!==null&&state.storageBinding!==profile.binding)throw Error('The selected Drive profile belongs to another storage identity.');
  await previous.unmount();
  try{await candidate.save(config);await this.accounts.activate(profile.id,candidate.state.snapshot().storageBinding);this.current=candidate;this.onStatus(this.status);return true;}
  catch(error){await candidate.unmount().catch(()=>{});if(previous.state.snapshot().config)await previous.mount().catch(restore=>{error.restoreError=restore.message;});this.onStatus(this.status);throw error;}
 });}
 selectAccount(id){return this.#serial(async()=>{
  const profile=this.accounts.profile(id),candidate=this.#runtime(profile),previous=this.current;if(!previous)throw Error('Drive account profiles have not loaded.');
  const state=candidate.state.state?candidate.state.snapshot():await candidate.state.load();if(!state.config||state.storageBinding!==profile.binding)throw Error('Reconnect this Drive account with its storage credentials first.');
  if(candidate===previous){await candidate.mount();return true;}
  await previous.unmount();
  try{await candidate.start();await candidate.mount();await this.accounts.activate(id,state.storageBinding);this.current=candidate;this.onStatus(this.status);return true;}
  catch(error){await candidate.unmount().catch(()=>{});if(previous.state.snapshot().config)await previous.mount().catch(restore=>{error.restoreError=restore.message;});this.onStatus(this.status);throw error;}
 });}
}
module.exports={WindowsDriveAccountRuntime};
