const crypto=require('node:crypto');const {planFolderMove}=require('./windows-drive-folder-move-plan');const {pendingOperations}=require('./windows-drive-pending');
const same=(a,b)=>a?.key===b?.key&&a?.etag===b?.etag&&(a?.fileID||null)===(b?.fileID||null)&&a?.size===b?.size;
class WindowsFolderMoveJournal{
 constructor(state){this.state=state;}
 async begin({from,local,key,objects,fingerprints}){
  let id;await this.state.update(state=>{
   const plan=planFolderMove({from,local,key,objects,materialized:state.materialized,pending:pendingOperations(state)});
   const hashes={};for(const entry of plan.placeholders){if(entry.previous.key.endsWith('/'))continue;const proof=fingerprints?.[entry.from];if(!proof||!/^[0-9a-f]{64}$/.test(proof.hash||'')||proof.size!==entry.previous.size)throw Error('A folder move requires complete locked source fingerprints.');hashes[entry.from]={hash:proof.hash,size:proof.size};}
   state.folderMoves??={};if(Object.keys(state.folderMoves).length>=1000)throw Error('The folder move journal is full.');id=crypto.randomUUID();state.folderMoves[id]={id,...plan,fingerprints:hashes,phase:'prepared',started:Date.now(),copied:{},deleted:{}};
  });return id;
 }
 copied(id,key,proof){return this.state.update(state=>{
  const entry=state.folderMoves?.[id],item=entry?.copies.find(copy=>copy.key===key);if(!entry||!item||!['prepared','copying'].includes(entry.phase)||typeof proof?.etag!=='string'||!proof.etag||proof.key!==key||proof.size!==item.source.size)throw Error('Folder copy proof does not match its intent.');
  const file=entry.placeholders.find(value=>value.previous.key===item.source.name),expected=file?entry.fingerprints[file.from]?.hash:item.source.name.endsWith('/.ghost-keep')&&item.source.size===0?crypto.createHash('sha256').update('').digest('hex'):null;if(!expected||proof.hash!==expected)throw Error('Folder copy bytes do not match the locked source fingerprint.');
  if(entry.copied[key]&&!same(entry.copied[key],proof))throw Error('The recorded folder destination changed.');entry.copied[key]=structuredClone(proof);entry.phase='copying';
 });}
 readyToDelete(id){return this.state.update(state=>{const entry=state.folderMoves?.[id];if(!entry||!['prepared','copying'].includes(entry.phase)||entry.copies.some(item=>!entry.copied[item.key]))throw Error('Every folder copy must be confirmed before deleting sources.');entry.phase='copied';});}
 deleting(id,key){return this.state.update(state=>{const entry=state.folderMoves?.[id];if(!entry||!['copied','deleting'].includes(entry.phase)||!entry.copies.some(item=>item.source.name===key)||entry.deleted[key])throw Error('Invalid folder source deletion intent.');entry.phase='deleting';entry.deleting=key;});}
 deleted(id,key){return this.state.update(state=>{const entry=state.folderMoves?.[id];if(!entry||entry.phase!=='deleting'||entry.deleting!==key)throw Error('Folder deletion outcome has no matching intent.');entry.deleted[key]=true;delete entry.deleting;});}
 readyToAcknowledge(id){return this.state.update(state=>{const entry=state.folderMoves?.[id];if(!entry||!['copied','deleting'].includes(entry.phase)||entry.deleting||entry.copies.some(item=>entry.deleted[item.source.name]!==true))throw Error('Every recorded source deletion must be confirmed before rebinding the folder.');entry.phase='deleted';});}
 acknowledging(id,local){return this.state.update(state=>{const entry=state.folderMoves?.[id];if(!entry||!['deleted','acknowledging'].includes(entry.phase)||entry.acknowledging||!entry.placeholders.some(item=>item.local===local))throw Error('Invalid folder native acknowledgement intent.');entry.phase='acknowledging';entry.acknowledging=local;});}
 acknowledged(id,local,proof){return this.state.update(state=>{
  const entry=state.folderMoves?.[id],item=entry?.placeholders.find(value=>value.local===local),info=proof?.placeholder;let identity;try{identity=JSON.parse(info?.identity);}catch{throw Error('Invalid folder destination identity.');}
  if(!entry||entry.phase!=='acknowledging'||entry.acknowledging!==local||!item||info.cloud!==true||identity.key!==item.key)throw Error('Folder native acknowledgement does not match its intent.');
  if(item.previous.key.endsWith('/')){if(info.directory!==true)throw Error('The moved folder is no longer a directory.');}
  else{const copied=entry.copied[item.key];if(info.directory===true||info.inSync!==true||info.modifiedBytes!==0||proof.size!==copied.size||proof.hash!==entry.fingerprints[item.from].hash||identity.etag!==copied.etag||(identity.fileID||null)!==(copied.fileID||null))throw Error('The moved file content or revision is not confirmed.');}
  entry.acknowledged??={};entry.acknowledged[local]=structuredClone(proof);delete entry.acknowledging;
 });}
 complete(id){return this.state.update(state=>{
  const entry=state.folderMoves?.[id];if(!entry||entry.phase!=='acknowledging'||entry.acknowledging||entry.placeholders.some(item=>!entry.acknowledged?.[item.local]))throw Error('Every moved placeholder requires native acknowledgement.');
  for(const item of entry.placeholders){if(!same(state.materialized[item.from],item.previous)||Object.keys(state.materialized).some(name=>name.toUpperCase()===item.local.toUpperCase()))throw Error('The folder source or destination binding changed.');}
  const mappings=Object.entries(state.mappings).filter(([key])=>key.startsWith(entry.previousKey));for(const [key,value] of mappings){const target=entry.key+key.slice(entry.previousKey.length);if(Object.keys(state.mappings[target]||{}).length)throw Error('The destination filename mapping is occupied.');state.mappings[target]=structuredClone(value);}
  for(const item of entry.placeholders){const next=item.previous.key.endsWith('/')?{...item.previous,key:item.key,remoteConfirmed:true}:{...item.previous,...entry.copied[item.key]};delete next.hash;Object.defineProperty(state.materialized,item.local,{value:next,writable:true,enumerable:true,configurable:true});delete state.materialized[item.from];}
  delete state.folderMoves[id];
 });}
}
module.exports={WindowsFolderMoveJournal};
