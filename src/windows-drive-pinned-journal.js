const path=require('node:path');const crypto=require('node:crypto');const {validLocal}=require('./windows-drive-names');const {pendingOperations,operationTouches}=require('./windows-drive-pending');
const hashValid=hash=>/^[0-9a-f]{64}$/.test(hash||'');
const sameRevision=(a,b)=>a?.key===b?.key&&a?.etag===b?.etag&&(a?.fileID||null)===(b?.fileID||null)&&a?.size===b?.size;
class WindowsPinnedUpdateJournal{
 constructor(state){this.state=state;}
 async begin({local,previous,staged}){
  const next=staged?.identity;
  if(typeof local!=='string'||local.split('/').some(part=>!validLocal(part))||!previous?.etag||!next?.etag||next.key!==previous.key||next.key.endsWith('/')||!Number.isSafeInteger(next.size)||next.size<0||!hashValid(staged?.hash)||staged.size!==next.size||!path.isAbsolute(staged.directory||'')||path.dirname(staged.file||'')!==staged.directory||sameRevision(previous,next))throw new Error('Invalid pinned revision replacement intent.');
  let id;await this.state.update(state=>{
   if(!sameRevision(state.materialized[local],previous))throw new Error('The pinned source binding changed; it was preserved.');
   if(pendingOperations(state).some(entry=>operationTouches(entry,local,next.key)))throw new Error('An unfinished operation already protects this pinned file.');
   id=crypto.randomUUID();state.pinnedUpdates??={};state.pinnedUpdates[id]={id,local,key:next.key,previous:structuredClone(previous),staged:{file:staged.file,directory:staged.directory,hash:staged.hash,size:staged.size,identity:structuredClone(next)},phase:'prepared',started:Date.now()};
  });return id;
 }
 recordBackup(id,backup){return this.state.update(state=>{
  const entry=state.pinnedUpdates?.[id];if(!entry||entry.phase!=='prepared'||!hashValid(backup?.hash)||backup.size!==entry.previous.size||path.dirname(backup.file||'')!==entry.staged.directory||backup.file===entry.staged.file)throw new Error('Offline backup proof does not match its pinned update.');
  state.pinnedUpdates[id]={...entry,backup:structuredClone(backup),phase:'backedUp'};
 });}
 replacing(id){return this.state.update(state=>{const entry=state.pinnedUpdates?.[id];if(!entry||entry.phase!=='backedUp')throw new Error('Pinned replacement requires a durable offline backup first.');state.pinnedUpdates[id]={...entry,phase:'replacing'};});}
 preserveCurrent(id,copy,proof){return this.state.update(state=>{
  const entry=state.pinnedUpdates?.[id];
  if(!entry||!['replacing','installed','finishing'].includes(entry.phase)||!entry.backup||!sameRevision(state.materialized[entry.local],entry.previous)||!hashValid(copy?.hash)||copy.hash!==proof?.hash||copy.size!==proof?.size||!Number.isSafeInteger(copy.size)||copy.size<0||path.dirname(copy.file||'')!==entry.staged.directory||!/^preserved-[0-9a-f-]{36}$/.test(path.basename(copy.file))||(entry.preserved||[]).length>=16||Object.keys(state.savedPinnedCopies||{}).length>=1000)throw new Error('Pinned finishing requires a durable matching copy of the current local file.');
  state.pinnedUpdates[id]={...entry,preserved:[...(entry.preserved||[]),structuredClone(copy)],phase:'finishing'};
 });}
 installed(id,proof){return this.state.update(state=>{const entry=state.pinnedUpdates?.[id];if(!entry||!['replacing','finishing'].includes(entry.phase)||proof?.hash!==entry.staged.hash||proof?.size!==entry.staged.size)throw new Error('Pinned installation proof does not match its staged revision.');state.pinnedUpdates[id]={...entry,phase:'installed'};});}
 #finish(state,id,identity,hash,recovery){
  const entry=state.pinnedUpdates?.[id];
  if(!entry||!(recovery?['replacing','installed','finishing']:['installed']).includes(entry.phase)||hash!==entry.staged.hash||!sameRevision(identity,entry.staged.identity)||!sameRevision(state.materialized[entry.local],entry.previous))throw new Error('Pinned completion proof does not match its recorded outcome.');
  if(entry.preserved?.length){state.savedPinnedCopies??={};if(Object.hasOwn(state.savedPinnedCopies,id)||Object.keys(state.savedPinnedCopies).length>=1000)throw new Error('The saved pinned recovery record is occupied or its history is full.');state.savedPinnedCopies[id]={id,local:entry.local,started:Date.now(),directory:entry.staged.directory,copies:[{name:'original',...structuredClone(entry.backup)},...entry.preserved.map((copy,index)=>({name:'local-'+(index+1),...structuredClone(copy)}))]};}
  state.materialized[entry.local]={...state.materialized[entry.local],...structuredClone(identity)};delete state.pinnedUpdates[id];
 }
 cancelBeforeReplacement(id,identity,hash){return this.state.update(state=>{
  const entry=state.pinnedUpdates?.[id];if(!entry||!['prepared','backedUp'].includes(entry.phase)||!sameRevision(identity,entry.previous)||!sameRevision(state.materialized[entry.local],entry.previous)||entry.backup&&hash!==entry.backup.hash)throw new Error('Pinned cancellation does not match the unchanged offline source.');
  delete state.pinnedUpdates[id];
 });}
 complete(id,identity,hash){return this.state.update(state=>this.#finish(state,id,identity,hash,false));}
 resolveRecovered(id,identity,hash){return this.state.update(state=>this.#finish(state,id,identity,hash,true));}
}
module.exports={WindowsPinnedUpdateJournal};
