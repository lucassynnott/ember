const {validLocal,mapDirectory}=require('./windows-drive-names');
const {caseOnlyFileRename}=require('./windows-drive-rename-path');const {pendingOperations,operationTouches}=require('./windows-drive-pending');
const fs=require('node:fs/promises');const path=require('node:path');const crypto=require('node:crypto');
function storageIdentity(config){return config?JSON.stringify(['provider','bucketName','accountID','endpoint','region'].map(key=>String(config[key]||'').trim())):null;}
const LIMIT=64*1024*1024;
function folderMoveBlocks(state,local,key=''){return pendingOperations(state).some(entry=>entry.tree===true&&operationTouches(entry,local,key));}
function deletionBlocks(state,local,key=''){return Object.values(state.deletes||{}).some(entry=>operationTouches(entry,local,key));}
function moveBlocks(state,local,key){return folderMoveBlocks(state,local,key)||deletionBlocks(state,local,key)||Object.values(state.pinnedUpdates||{}).some(entry=>entry.local.toUpperCase()===local.toUpperCase()||entry.key===key)||Object.values(state.moves||{}).some(entry=>[entry.local,entry.from].some(name=>name.toUpperCase()===local.toUpperCase())||entry.key===key||entry.previous.key===key);}

function selectedConfig(config){
  if(!config||!['b2','r2','s3','wasabi','custom'].includes(config.provider)||!['keyID','applicationKey','bucketName'].every(field=>typeof config[field]==='string'&&config[field].trim()))throw new Error('Invalid Windows Drive storage configuration.');
  return Object.fromEntries(['provider','keyID','applicationKey','bucketName','bucketID','accountID','region','endpoint'].filter(key=>config[key]!=null).map(key=>[key,String(config[key])]));
}
function finishMove(state,id,identity){
    const entry=state.moves?.[id],original=entry&&state.materialized[entry.from];
    if(!entry||entry.phase!=='acknowledged'||!original||original.key!==entry.previous.key||original.etag!==entry.previous.etag||(original.fileID||null)!==(entry.previous.fileID||null)||identity.key!==entry.key||identity.etag!==entry.copied.etag||(identity.fileID||null)!==(entry.copied.fileID||null)||identity.size!==entry.size)throw new Error('Move completion does not match its recorded outcome.');
    if(Object.keys(state.materialized).some(name=>name!==entry.from&&name.toUpperCase()===entry.local.toUpperCase()))throw new Error('The move destination changed; existing files were preserved.');
    if(caseOnlyFileRename(entry.from,entry.local)){
      const parent=entry.previous.key.slice(0,entry.previous.key.lastIndexOf('/')+1),oldId='file:'+entry.previous.key.slice(parent.length),newId='file:'+entry.key.slice(parent.length),name=entry.local.split('/').at(-1);
      if(!entry.key.startsWith(parent)||entry.key.slice(parent.length).includes('/'))throw new Error('Case rename changed its cloud parent.');
      const mapping=state.mappings[parent]||{};
      if(Object.entries(mapping).some(([id,value])=>id!==oldId&&value.toUpperCase()===name.toUpperCase())||Object.hasOwn(mapping,newId)&&newId!==oldId)throw new Error('The renamed file mapping is occupied.');
      delete mapping[oldId];Object.defineProperty(mapping,newId,{value:name,enumerable:true,writable:true,configurable:true});state.mappings[parent]=mapping;
    }
    Object.defineProperty(state.materialized,entry.local,{value:{...original,...structuredClone(identity)},enumerable:true,writable:true,configurable:true});
    delete state.materialized[entry.from];delete state.moves[id];
}
class WindowsDriveState {
  constructor({directory,safeStorage}){this.directory=directory;this.file=path.join(directory,'state.dpapi');this.crypto=safeStorage;this.state=null;this.queue=Promise.resolve();}
  #encryption(){if(!this.crypto?.isEncryptionAvailable())throw new Error('Windows credential encryption is unavailable; Drive settings were not saved.');}
  async load(){
    this.#encryption();
    try {
      const stat=await fs.stat(this.file);if(!stat.isFile()||stat.size>LIMIT)throw new Error('Invalid Windows Drive state file.');
      const value=JSON.parse(this.crypto.decryptString(await fs.readFile(this.file)));
      if(value.version!==1||typeof value.identity!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.identity)||typeof value.mappings!=='object'||!value.mappings||Array.isArray(value.mappings)||typeof value.materialized!=='object'||!value.materialized||Array.isArray(value.materialized))throw new Error('Invalid Windows Drive state.');
      if(value.storageBinding==null)value.storageBinding=storageIdentity(value.config);
      if(value.storageBinding!==null&&typeof value.storageBinding!=='string')throw new Error('Invalid Drive storage identity.');
      if(value.config&&value.storageBinding!==storageIdentity(value.config))throw new Error('Drive storage identity does not match its configuration.');
      if(value.setupDraft!=null)selectedConfig(value.setupDraft);
      if(value.cacheLimitGB==null)value.cacheLimitGB=20;
      if(![5,10,20,50,100,250].includes(value.cacheLimitGB))throw new Error('Invalid Drive cache limit.');
      if(value.backups==null)value.backups={};
      if(typeof value.backups!=='object'||Array.isArray(value.backups))throw new Error('Invalid Drive backup journal.');
      if(value.folderUploads==null)value.folderUploads={};
      if(typeof value.folderUploads!=='object'||Array.isArray(value.folderUploads))throw new Error('Invalid Windows Drive folder journal.');
      if(value.uploads==null)value.uploads={};
      if(typeof value.uploads!=='object'||Array.isArray(value.uploads))throw new Error('Invalid Windows Drive upload journal.');
      if(value.folderMoves==null)value.folderMoves={};
      if(typeof value.folderMoves!=='object'||Array.isArray(value.folderMoves)||Object.keys(value.folderMoves).length>1000)throw new Error('Invalid Windows Drive folder move journal.');
      if(value.deletes==null)value.deletes={};
      if(typeof value.deletes!=='object'||Array.isArray(value.deletes)||Object.keys(value.deletes).length>1000)throw new Error('Invalid Windows Drive deletion journal.');
      if(value.remoteRemovals==null)value.remoteRemovals={};
      if(typeof value.remoteRemovals!=='object'||Array.isArray(value.remoteRemovals)||Object.keys(value.remoteRemovals).length>1000)throw new Error('Invalid Windows Drive remote removal journal.');
      if(value.moves==null)value.moves={};
      if(typeof value.moves!=='object'||Array.isArray(value.moves))throw new Error('Invalid Windows Drive move journal.');
      if(value.pinnedUpdates==null)value.pinnedUpdates={};
      if(typeof value.pinnedUpdates!=='object'||Array.isArray(value.pinnedUpdates))throw new Error('Invalid Windows Drive pinned update journal.');
      if(value.savedPinnedCopies==null)value.savedPinnedCopies={};
      if(typeof value.savedPinnedCopies!=='object'||Array.isArray(value.savedPinnedCopies)||Object.keys(value.savedPinnedCopies).length>1000)throw new Error('Invalid Windows Drive saved pinned copies.');
      this.state=value;
    }catch(error){if(error.code!=='ENOENT')throw new Error('Windows Drive settings could not be opened. The existing state was preserved.',{cause:error});this.state={version:1,identity:crypto.randomUUID(),config:null,storageBinding:null,mappings:{},materialized:{},uploads:{},folderUploads:{},backups:{},moves:{},folderMoves:{},deletes:{},remoteRemovals:{},pinnedUpdates:{},savedPinnedCopies:{},cacheLimitGB:20};}
    return structuredClone(this.state);
  }
  snapshot(){if(!this.state)throw new Error('Windows Drive state has not loaded.');return structuredClone(this.state);}
  forgetSavedPinnedCopies(id){
    if(typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new Error('Invalid saved copy identifier.');
    return this.update(state=>{if(state.savedPinnedCopies&&Object.hasOwn(state.savedPinnedCopies,id))delete state.savedPinnedCopies[id];});
  }
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
    let selected;try{selected=selectedConfig(config);}catch(error){return Promise.reject(error);}
    return this.update(state=>{const nextIdentity=storageIdentity(selected);if(Object.keys(state.materialized).length&&state.storageBinding!==nextIdentity)throw new Error('Switching storage requires a separate Drive root; existing files were preserved.');state.config=selected;state.storageBinding=nextIdentity;delete state.setupDraft;});
  }
  saveSetupDraft(config){
    let selected;try{selected=selectedConfig(config);}catch(error){return Promise.reject(error);}
    return this.update(state=>{
      if(Object.keys(state.materialized).length&&state.storageBinding!==storageIdentity(selected))throw new Error('Switching storage requires a separate Drive root; existing files were preserved.');
      if(state.setupDraft)throw new Error('An unfinished storage setup exists; its key was preserved.');
      state.setupDraft=selected;
    });
  }
  forget(){return this.update(state=>{state.storageBinding??=storageIdentity(state.config);state.config=null;delete state.setupDraft;});}
  setCacheLimit(gb){if(![5,10,20,50,100,250].includes(gb))return Promise.reject(new Error('Invalid Drive cache limit.'));return this.update(state=>{state.cacheLimitGB=gb;});}
  saveMappings(mappings){return this.update(state=>{state.mappings=structuredClone(mappings);});}
  async reserveLocalFile(local,{folder:directory=false}={}) {
    const parts=local.split('/');if(parts.some(part=>!validLocal(part)))throw new Error('Invalid local Drive path.');let key;
    await this.update(state=>{
      if(folderMoveBlocks(state,local)||deletionBlocks(state,local))throw new Error('An unfinished operation protects this local path.');
      let remote='',parent='';
      for(let index=0;index<parts.length;index++){
        const name=parts[index],folder=directory||index<parts.length-1,type=folder?'folder:':'file:';
        const mapping=Object.prototype.hasOwnProperty.call(state.mappings,remote)?state.mappings[remote]:{};
        let id=Object.entries(mapping).find(([id,value])=>id.startsWith(type)&&value.toUpperCase()===name.toUpperCase())?.[0];
        if(!id){id=type+name;if(Object.entries(mapping).some(([other,value])=>other!==id&&value.toUpperCase()===name.toUpperCase()))throw new Error('A different cloud object occupies this local name.');if(Object.hasOwn(mapping,id)&&mapping[id]!==name)throw new Error('Cloud name already maps to another local file.');Object.defineProperty(mapping,id,{value:name,enumerable:true,writable:true,configurable:true});}
        Object.defineProperty(state.mappings,remote,{value:mapping,enumerable:true,writable:true,configurable:true});
        remote+=id.slice(type.length)+(folder?'/':'');parent+=(parent?'/':'')+name;
        if(folder){const known=Object.prototype.hasOwnProperty.call(state.materialized,parent)?state.materialized[parent]:null;if(known&&known.key!==remote)throw new Error('Tracked directory identity differs from the local path.');Object.defineProperty(state.materialized,parent,{value:known||{key:remote,fileID:null,etag:null,remoteConfirmed:false},enumerable:true,writable:true,configurable:true});}
      }
      key=remote;if(folderMoveBlocks(state,local,key)||deletionBlocks(state,local,key))throw new Error('An unfinished operation protects this cloud path.');
    });return key;
  }
  async reserveLocalMove(from,local){
    if(!caseOnlyFileRename(from,local))return this.reserveLocalFile(local);
    let key;await this.update(state=>{
      const original=state.materialized[from];if(!original||original.key.endsWith('/'))throw new Error('The case rename has no recorded source file.');
      const parent=original.key.slice(0,original.key.lastIndexOf('/')+1),name=local.split('/').at(-1),oldId='file:'+original.key.slice(parent.length),mapping=state.mappings[parent]||{};
      key=parent+name;
      if(key===original.key||Buffer.byteLength(key)>1024||Object.entries(mapping).some(([id,value])=>id!==oldId&&(id==='file:'+name||value.toUpperCase()===name.toUpperCase())))throw new Error('The case rename destination is occupied or unchanged.');
    });return key;
  }
  async reserveLocalFolderMove(from,local){
    if(typeof from!=='string'||typeof local!=='string'||[from,local].some(value=>value.split('/').some(part=>!validLocal(part))))throw new Error('Invalid folder move path.');
    let key;await this.update(state=>{
      const original=state.materialized[from];if(!original?.key.endsWith('/')||original.remoteConfirmed===false)throw new Error('The renamed folder has no confirmed source.');
      if(from===local||from.toUpperCase()===local.toUpperCase()&&!caseOnlyFileRename(from,local)||local.toUpperCase().startsWith(from.toUpperCase()+'/')||from.toUpperCase().startsWith(local.toUpperCase()+'/'))throw new Error('Folder moves require separate source and destination trees.');
      if(Object.keys(state.materialized).some(name=>name!==from&&!name.startsWith(from+'/')&&(name.toUpperCase()===local.toUpperCase()||name.toUpperCase().startsWith(local.toUpperCase()+'/'))))throw new Error('The folder destination is occupied.');
      if(Object.values(state.folderMoves||{}).some(entry=>[entry.from,entry.local].some(name=>[from,local].some(tree=>name.toUpperCase()===tree.toUpperCase()||name.toUpperCase().startsWith(tree.toUpperCase()+'/')||tree.toUpperCase().startsWith(name.toUpperCase()+'/')))))throw new Error('An unfinished folder move protects this tree.');
      if(caseOnlyFileRename(from,local)){
        const originalName=original.key.slice(0,-1),parent=originalName.slice(0,originalName.lastIndexOf('/')+1),name=local.split('/').at(-1),oldId='folder:'+originalName.slice(parent.length),mapping=state.mappings[parent]||{};
        key=parent+name+'/';if(key===original.key||Buffer.byteLength(key)>1024||Object.entries(mapping).some(([id,value])=>id!==oldId&&(id==='folder:'+name||value.toUpperCase()===name.toUpperCase())))throw new Error('The case folder destination is occupied or unchanged.');return;
      }
      const parts=local.split('/'),name=parts.pop(),parent=parts.join('/'),binding=parent?state.materialized[parent]:null;if(parent&&(!binding?.key.endsWith('/')||binding.remoteConfirmed===false))throw new Error('Sync the destination parent folder first.');
      const remote=parent?binding.key:'',mapping=state.mappings[remote]||{};let id=Object.entries(mapping).find(([id,value])=>id.startsWith('folder:')&&value.toUpperCase()===name.toUpperCase())?.[0];
      if(!id){id='folder:'+name;if(Object.entries(mapping).some(([other,value])=>other!==id&&value.toUpperCase()===name.toUpperCase())||Object.hasOwn(mapping,id)&&mapping[id]!==name)throw new Error('The destination filename mapping is occupied.');Object.defineProperty(mapping,id,{value:name,enumerable:true,writable:true,configurable:true});}
      key=remote+id.slice(7)+'/';if(key===original.key||Buffer.byteLength(key)>1024)throw new Error('The folder cloud destination is unchanged or invalid.');state.mappings[remote]=mapping;
    });return key;
  }
  reserveLocalFolder(local){return this.reserveLocalFile(local,{folder:true});}
  async beginFolderUpload(local,key){
    let id;await this.update(state=>{
      if(!key.endsWith('/')||local.split('/').some(part=>!validLocal(part)))throw new Error('Invalid local Drive folder.');
      if(moveBlocks(state,local,key))throw new Error('An unfinished move or pinned update exists for this folder.');
      state.folderUploads??={};
      if(Object.values(state.folderUploads).some(entry=>entry.local.toUpperCase()===local.toUpperCase()||entry.key===key))throw new Error('An unfinished folder upload exists; resolve its outcome before retrying.');
      if(state.materialized[local]?.key!==key)throw new Error('Folder identity does not match its reservation.');
      id=crypto.randomUUID();state.folderUploads[id]={id,local,key,marker:key+'.ghost-keep',started:Date.now()};
    });return id;
  }
  completeFolderUpload(id,proof){return this.update(state=>{
    const entry=state.folderUploads?.[id];
    if(!entry||proof.name!==entry.marker||proof.size!==0||!proof.etag||state.materialized[entry.local]?.key!==entry.key)throw new Error('Folder confirmation does not match its recorded intent.');
    state.materialized[entry.local]={...state.materialized[entry.local],remoteConfirmed:true,markerRevision:{etag:proof.etag,fileID:proof.fileID||null}};delete state.folderUploads[id];
  });}
  async reserveRemoteFile(key){
    if(typeof key!=='string'||Buffer.byteLength(key)>1024||key.split('/').some(part=>!part||part==='.'||part==='..'||/[\x00-\x1f]/.test(part)))throw new Error('Invalid backup object name.');
    let local;await this.update(state=>{
      if(folderMoveBlocks(state,'',key)||deletionBlocks(state,'',key))throw new Error('An unfinished operation protects this remote path.');
      let remote='',parent='';const parts=key.split('/');
      for(let index=0;index<parts.length;index++){
        const name=parts[index],folder=index<parts.length-1,type=folder?'folder:':'file:',id=type+name;
        const mapping=Object.prototype.hasOwnProperty.call(state.mappings,remote)?state.mappings[remote]:{};
        const entries=Object.keys(mapping).map(id=>({id,name:id.slice(id.indexOf(':')+1)}));if(!Object.hasOwn(mapping,id))entries.push({id,name});
        const mapped=mapDirectory(entries,mapping);const chosen=mapped.get(id);
        Object.defineProperty(state.mappings,remote,{value:Object.fromEntries(mapped),enumerable:true,writable:true,configurable:true});
        remote+=name+(folder?'/':'');parent+=(parent?'/':'')+chosen;
        if(folder){const known=Object.prototype.hasOwnProperty.call(state.materialized,parent)?state.materialized[parent]:null;if(known&&known.key!==remote)throw new Error('Backup folder identity conflicts with an existing file.');Object.defineProperty(state.materialized,parent,{value:known||{key:remote,fileID:null,etag:null,remoteConfirmed:false},enumerable:true,writable:true,configurable:true});}
      }local=parent;if(folderMoveBlocks(state,local,key)||deletionBlocks(state,local,key))throw new Error('An unfinished operation protects this local path.');
    });return local;
  }
  async beginBackup(value){let id;await this.update(state=>{
    if(typeof value.hash!=='string'||!/^([0-9a-f]{64})$/.test(value.hash)||!Number.isSafeInteger(value.size)||value.size<0||value.local.split('/').some(part=>!validLocal(part)))throw new Error('Invalid backup snapshot.');
    if(moveBlocks(state,value.local,value.key))throw new Error('An unfinished move or pinned update exists for this backup.');
    const pending=[...Object.values(state.uploads||{}),...Object.values(state.backups||{})];
    if(pending.some(entry=>entry.local.toUpperCase()===value.local.toUpperCase()||entry.key===value.key))throw new Error('An unfinished operation exists for this backup.');
    const previous=Object.prototype.hasOwnProperty.call(state.materialized,value.local)?state.materialized[value.local]:null;
    if(previous&&previous.key!==value.key)throw new Error('Backup target identifies another cloud object.');
    id=crypto.randomUUID();state.backups??={};state.backups[id]={...structuredClone(value),id,previous,started:Date.now()};
  });return id;}
  completeBackup(id,hash){return this.update(state=>{const entry=state.backups?.[id];if(!entry||entry.hash!==hash)throw new Error('Backup completion does not match its intent.');delete state.backups[id];});}
  async beginUpload({local,key,size,modified,previous,hash}) {
    let id;
    await this.update(state=>{
      if(!/^[0-9a-f]{64}$/.test(hash||''))throw new Error('Upload requires a local content fingerprint.');
      if(moveBlocks(state,local,key))throw new Error('An unfinished move or pinned update exists for this upload.');
      state.uploads??={};
      if([...Object.values(state.uploads),...Object.values(state.backups||{})].some(upload=>upload.local.toUpperCase()===local.toUpperCase()||upload.key===key))throw new Error('An unfinished upload exists for this file. Resolve its recorded outcome before retrying.');
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
  async beginMove({from,local,key,previous,size,modified,hash}) {
    if(typeof from!=='string'||typeof local!=='string'||from.split('/').some(part=>!validLocal(part))||local.split('/').some(part=>!validLocal(part))||(from===local||from.toUpperCase()===local.toUpperCase()&&!caseOnlyFileRename(from,local)))throw new Error('A move requires distinct valid local files.');
    if(typeof key!=='string'||!key||Buffer.byteLength(key)>1024||key.endsWith('/')||/[\x00-\x1f]/.test(key)||typeof previous?.key!=='string'||!previous.key||previous.key.endsWith('/')||previous.key===key||typeof previous.etag!=='string'||!previous.etag||!Number.isSafeInteger(size)||size<0||!Number.isSafeInteger(modified)||modified<0||!/^([0-9a-f]{64})$/.test(hash||''))throw new Error('Invalid Drive move intent.');
    let id;await this.update(state=>{
      const original=state.materialized[from];
      if(!original||original.key!==previous.key||original.etag!==previous.etag||(original.fileID||null)!==(previous.fileID||null))throw new Error('The move source revision changed; it was preserved.');
      if(Object.keys(state.materialized).some(name=>name!==from&&name.toUpperCase()===local.toUpperCase()))throw new Error('The move destination is already tracked; it was preserved.');
      if(pendingOperations(state).some(entry=>operationTouches(entry,from,previous.key)||operationTouches(entry,local,key)))throw new Error('An unfinished operation exists for this move.');
      id=crypto.randomUUID();state.moves??={};state.moves[id]={id,from,local,key,previous:structuredClone(previous),size,modified,hash,phase:'prepared',started:Date.now()};
    });return id;
  }
  setMovePhase(id,phase,proof={}) {return this.update(state=>{
    const entry=state.moves?.[id];if(!entry)throw new Error('Move journal entry is missing.');
    if(({prepared:'copying',copying:'copied',copied:'deleting',deleting:'deleted',deleted:'acknowledged'})[entry.phase]!==phase)throw new Error('Move journal phase is out of order.');
    if(phase==='copied'&&(!proof.copied||proof.copied.key!==entry.key||proof.copied.size!==entry.size||typeof proof.copied.etag!=='string'||!proof.copied.etag))throw new Error('Move copy proof does not match its recorded intent.');
    state.moves[id]={...entry,phase,...(phase==='copied'?{copied:structuredClone(proof.copied)}:{})};
  });}
  completeMove(id,identity) {return this.update(state=>finishMove(state,id,identity));}
  resolveRecoveredMove(id,identity,hash) {return this.update(state=>{
    const entry=state.moves?.[id];if(!entry||entry.hash!==hash||identity.key!==entry.key||identity.size!==entry.size||typeof identity.etag!=='string'||!identity.etag)throw new Error('Move recovery proof does not match its recorded intent.');
    state.moves[id]={...entry,phase:'acknowledged',copied:structuredClone(identity)};finishMove(state,id,identity);
  });}
  markMaterialized(local,identity){return this.update(state=>{Object.defineProperty(state.materialized,local,{value:structuredClone(identity),enumerable:true,writable:true,configurable:true});});}
}
module.exports={WindowsDriveState,storageIdentity};
