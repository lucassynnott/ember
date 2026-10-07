const {mapDirectory}=require('./windows-drive-names');
const {KEEP,TRASH}=require('./windows-drive-store');

// Construct the complete namespace before native writes. S3 can contain a file
// and folder with the same name, repeated separators and case-only differences.
function planNamespace(objects,{mappings={}}={}) {
  if(!Array.isArray(objects)||objects.length>1000000)throw new Error('Drive namespace exceeds its limit.');
  const root={children:new Map(),remote:'',local:''};let count=0;
  for(const object of objects){
    if(typeof object.name!=='string'||!object.name||Buffer.byteLength(object.name)>1024||/[\x00-\x1f]/.test(object.name))throw new Error('Invalid remote object key.');
    if(object.name.startsWith(TRASH))continue;
    const components=object.name.split('/');
    let directory=object.kind==='folder'||object.name.endsWith('/');
    if(directory&&components.at(-1)==='')components.pop();
    if(components.at(-1)===KEEP){components.pop();directory=true;}
    if(!components.length)continue;
    let parent=root;
    for(let index=0;index<components.length;index++){
      const folder=index<components.length-1||directory,name=components[index],id=(folder?'folder:':'file:')+name;
      let node=parent.children.get(id);
      if(!node){if(++count>1000000)throw new Error('Drive namespace exceeds its node limit.');node={id,name,kind:folder?'folder':'file',remote:components.slice(0,index+1).join('/')+(folder?'/':''),children:new Map(),object:null};parent.children.set(id,node);}
      if(!folder){if(node.object)throw new Error('Duplicate remote object in Drive namespace.');if(!Number.isSafeInteger(object.size)||object.size<0||!Number.isSafeInteger(object.modified)||object.modified<0||(!object.fileID&&!object.etag))throw new Error('Remote file metadata is incomplete.');node.object=object;}
      parent=node;
    }
  }
  // Retain reservations for directories omitted by the remote listing too.
  // Their local files and encrypted upload intents can outlive remote deletion.
  const entries=[],nextMappings=Object.assign(Object.create(null),structuredClone(mappings)),queue=[root];
  for(let index=0;index<queue.length;index++){
    const directory=queue[index];
    const previous=Object.prototype.hasOwnProperty.call(mappings,directory.remote)?mappings[directory.remote]:{};
    const names=mapDirectory([...directory.children.values()].map(node=>({id:node.id,name:node.name})),previous);
    nextMappings[directory.remote]=Object.fromEntries(names);
    for(const node of [...directory.children.values()].sort((a,b)=>a.id.localeCompare(b.id))){
      const name=names.get(node.id);node.local=(directory.local?directory.local+'/':'')+name;
      entries.push({name,parent:directory.local,path:node.local,object:node.object||{name:node.remote,kind:'folder',size:0,modified:0,fileID:null,etag:null}});
      if(node.kind==='folder')queue.push(node);
    }
  }
  return {entries,mappings:nextMappings};
}
async function populateInitialNamespace(bridge,store,{mappings={},saveMappings=async()=>{},onMaterialized=async()=>{},materialized={},pending=[],preserveMissing=false,signal,refreshPinned=null}={}){
  if(!Array.isArray(pending)||pending.some(entry=>!entry||typeof entry.local!=='string'||typeof entry.key!=='string'))throw new Error('Invalid unfinished Drive operation.');
  const plan=planNamespace(await store.listAll('',{signal}),{mappings});
  if(signal?.aborted)throw new Error('Drive population cancelled.');
  // A held folder move owns both naming subtrees. Listing its partially copied
  // destination must not reserve new child spellings before final rebinding.
  for(const intent of pending.filter(intent=>intent.tree===true&&intent.key&&intent.key.endsWith('/'))){
    const folder=intent.key.slice(0,-1),separator=folder.lastIndexOf('/'),parent=folder.slice(0,separator+1),id='folder:'+folder.slice(separator+1);
    if(Object.hasOwn(mappings[parent]||{},id))plan.mappings[parent][id]=mappings[parent][id];else if(plan.mappings[parent])delete plan.mappings[parent][id];
    for(const key of Object.keys(plan.mappings).filter(key=>key.startsWith(intent.key))){
      if(Object.hasOwn(mappings,key))plan.mappings[key]=structuredClone(mappings[key]);else delete plan.mappings[key];
    }
  }
  // Persist the chosen names before creating any placeholders so a crash cannot
  // subsequently bind a different remote key to an existing local filename.
  await saveMappings(plan.mappings);
  let created=0,existing=0;const conflicts=[];
  for(const entry of plan.entries){
    if(signal?.aborted)throw new Error('Drive population cancelled.');
    if(pending.some(intent=>entry.path.toUpperCase()===intent.local.toUpperCase()||entry.path.toUpperCase().startsWith(intent.local.toUpperCase()+'/')||entry.object.name===intent.key||intent.tree===true&&entry.object.name.startsWith(intent.key))){
      conflicts.push({path:entry.path,key:entry.object.name,unfinishedUpload:true});continue;
    }
    const expected={key:entry.object.name,fileID:entry.object.fileID||null,etag:entry.object.etag||null,size:entry.object.size,modified:entry.object.modified};
    const current=bridge.inspect?await bridge.inspect(entry.path):{exists:false};
    if(current.exists){
      if(!current.cloud){
        const known=Object.prototype.hasOwnProperty.call(materialized,entry.path)?materialized[entry.path]:null;
        if(!known||known.key!==expected.key)throw new Error('An existing local file occupies a cloud filename; it was preserved.');
        if(entry.object.kind==='folder'&&current.directory===true){await onMaterialized(entry.path,{...known,remoteConfirmed:true});existing++;continue;}
        conflicts.push({path:entry.path,key:known.key,localChanged:true,remoteChanged:known.etag!==expected.etag||known.fileID!==expected.fileID});
        await onMaterialized(entry.path,known);existing++;continue;
      }
      let identity;try{identity=JSON.parse(current.identity);}catch{throw new Error('Existing placeholder has an invalid identity; it was preserved.');}
      if(identity.key!==expected.key)throw new Error('Existing placeholder identifies another remote object; it was preserved.');
      const dirty=entry.object.kind!=='folder'&&(!current.inSync||current.modifiedBytes>0);
      const remoteChanged=entry.object.kind!=='folder'&&(identity.fileID!==expected.fileID||identity.etag!==expected.etag);
      const known=Object.prototype.hasOwnProperty.call(materialized,entry.path)?materialized[entry.path]:null;
      const recorded=identity.fileID===expected.fileID&&identity.etag===expected.etag?expected:known&&known.key===identity.key&&known.fileID===identity.fileID&&known.etag===identity.etag?{...known,...identity}:identity;
      if(remoteChanged&&!dirty&&current.pinState===1&&refreshPinned){
        try{await refreshPinned(entry.path,entry.object,signal);await onMaterialized(entry.path,expected);existing++;continue;}
        catch(error){conflicts.push({path:entry.path,key:identity.key,localChanged:false,remoteChanged:true,error:error.message});await onMaterialized(entry.path,recorded);existing++;continue;}
      }
      if(remoteChanged&&!dirty&&current.pinState!==1&&bridge.refresh){
        try{await bridge.refresh(entry.path,entry.object,current.identity);await onMaterialized(entry.path,expected);existing++;continue;}
        catch(error){conflicts.push({path:entry.path,key:identity.key,localChanged:false,remoteChanged:true,error:error.message});await onMaterialized(entry.path,recorded);existing++;continue;}
      }
      if(dirty||remoteChanged)conflicts.push({path:entry.path,key:identity.key,localChanged:dirty,remoteChanged});
      // Search metadata must describe the revision actually represented locally.
      // A conflict must not label an older file with the replacement's size/date.
      await onMaterialized(entry.path,recorded);existing++;continue;
    }
    if(preserveMissing&&Object.hasOwn(materialized,entry.path)){conflicts.push({path:entry.path,key:materialized[entry.path].key,localMissing:true});continue;}
    await bridge.create(entry.name,entry.object,entry.parent);
    await onMaterialized(entry.path,expected);created++;
  }
  if(preserveMissing){const listed=new Set(plan.entries.map(entry=>entry.path));for(const [local,identity] of Object.entries(materialized))if(!listed.has(local))conflicts.push({path:local,key:identity.key,remoteMissing:true});}
  return {created,existing,conflicts,mappings:plan.mappings};
}
module.exports={planNamespace,populateInitialNamespace};
