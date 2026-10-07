const fs=require('node:fs/promises');const path=require('node:path');const crypto=require('node:crypto');
const {storageIdentity}=require('./windows-drive-state');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LIMIT=1024*1024;
function validBinding(binding){
 if(binding===null)return true;
 try{const fields=JSON.parse(binding);return Array.isArray(fields)&&fields.length===5&&fields.every(field=>typeof field==='string')&&['b2','r2','s3','wasabi','custom'].includes(fields[0])&&Boolean(fields[1])&&JSON.stringify(fields)===binding;}catch{return false;}
}
function validate(value){
 if(!value||value.version!==1||!Array.isArray(value.accounts)||!value.accounts.length||value.accounts.length>100||typeof value.active!=='string')throw Error('Invalid Windows Drive account registry.');
 const ids=new Set(),bindings=new Set();
 for(const entry of value.accounts){
  if(!entry||!(entry.id==='legacy'||UUID.test(entry.id))||ids.has(entry.id)||!validBinding(entry.binding)||entry.id!=='legacy'&&entry.binding===null||entry.binding!==null&&bindings.has(entry.binding))throw Error('Invalid Windows Drive account binding.');
  if(Object.keys(entry).some(key=>!['id','binding'].includes(key)))throw Error('Unexpected Windows Drive account data.');
  ids.add(entry.id);if(entry.binding!==null)bindings.add(entry.binding);
 }
 if(!ids.has('legacy')||!ids.has(value.active))throw Error('The active Windows Drive account is missing.');
 return value;
}
// Only root identifiers and non-secret storage bindings live here. Each account's
// credentials, mappings and recovery journals remain in its own DPAPI state file.
class WindowsDriveAccounts {
 constructor({directory,home,safeStorage}){if(!path.isAbsolute(directory)||!path.isAbsolute(home))throw Error('Drive accounts require absolute profile paths.');Object.assign(this,{directory,home,safeStorage});this.file=path.join(directory,'accounts.dpapi');this.value=null;this.queue=Promise.resolve();}
 #encryption(){if(!this.safeStorage?.isEncryptionAvailable())throw Error('Windows account encryption is unavailable; existing profiles were preserved.');}
 async load(){
  this.#encryption();
  try{const info=await fs.lstat(this.file);if(!info.isFile()||info.isSymbolicLink()||info.size>LIMIT)throw Error('Invalid encrypted account file.');this.value=validate(JSON.parse(this.safeStorage.decryptString(await fs.readFile(this.file))));}
  catch(error){if(error.code!=='ENOENT')throw Error('Windows Drive accounts could not be opened. Existing profiles were preserved.',{cause:error});this.value={version:1,active:'legacy',accounts:[{id:'legacy',binding:null}]};}
  return this.snapshot();
 }
 snapshot(){if(!this.value)throw Error('Windows Drive accounts have not loaded.');return structuredClone(this.value);}
 profile(id=this.snapshot().active){
  const entry=this.snapshot().accounts.find(account=>account.id===id);if(!entry)throw Error('Unknown Windows Drive account.');
  return {...entry,directory:id==='legacy'?this.directory:path.join(this.directory,'accounts',id),root:path.join(this.home,id==='legacy'?'Ember Drive':'Ember Drive ('+id+')')};
 }
 async #update(change){
  const pending=this.queue.then(async()=>{
   this.#encryption();const next=this.snapshot();const result=await change(next);validate(next);const bytes=this.safeStorage.encryptString(JSON.stringify(next));if(bytes.length>LIMIT)throw Error('Windows Drive account registry exceeds its limit.');
   await fs.mkdir(this.directory,{recursive:true});const folder=await fs.lstat(this.directory);if(!folder.isDirectory()||folder.isSymbolicLink())throw Error('Windows Drive account directory is invalid.');
   const temporary=this.file+'.'+crypto.randomUUID()+'.tmp';let handle;
   try{handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(bytes);await handle.sync();await handle.close();handle=null;await fs.rename(temporary,this.file);this.value=next;}
   finally{await handle?.close();await fs.rm(temporary,{force:true});}
   return result;
  });this.queue=pending.catch(()=>{});return pending;
 }
 async adoptLegacy(binding){
  if(!validBinding(binding))throw Error('Invalid legacy storage binding.');
  return this.#update(value=>{const legacy=value.accounts.find(entry=>entry.id==='legacy');if(legacy.binding!==null&&legacy.binding!==binding)throw Error('Legacy Drive storage identity changed; its root was preserved.');if(binding!==null&&value.accounts.some(entry=>entry.id!=='legacy'&&entry.binding===binding))throw Error('Legacy storage identity belongs to another account.');legacy.binding=binding;return this.profile('legacy').id;});
 }
 async reserve(config){
  const binding=storageIdentity(config);if(binding===null||!validBinding(binding))throw Error('Invalid Drive account storage identity.');
  const id=await this.#update(async value=>{
   const existing=value.accounts.find(entry=>entry.binding===binding);if(existing)return existing.id;
   const legacy=value.accounts.find(entry=>entry.id==='legacy');
   if(legacy.binding===null){legacy.binding=binding;return legacy.id;}
   if(value.accounts.length>=100)throw Error('Windows Drive account limit reached.');
   const id=crypto.randomUUID(),root=path.join(this.home,'Ember Drive ('+id+')'),directory=path.join(this.directory,'accounts',id);
   for(const file of [root,directory]){try{await fs.lstat(file);throw Error('The new Drive profile path is already occupied.');}catch(error){if(error.code!=='ENOENT')throw error;}}
   value.accounts.push({id,binding});return id;
  });return this.profile(id);
 }
 async activate(id,binding){
  return this.#update(value=>{const entry=value.accounts.find(account=>account.id===id);if(!entry||entry.binding===null||entry.binding!==binding)throw Error('Drive account activation does not match its storage identity.');value.active=id;return true;});
 }
}
module.exports={WindowsDriveAccounts};
