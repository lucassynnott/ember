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
  const entries=[],nextMappings=Object.create(null),queue=[root];
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
async function populateInitialNamespace(bridge,store,{mappings={},saveMappings=async()=>{},onMaterialized=async()=>{},signal}={}){
  const plan=planNamespace(await store.listAll('',{signal}),{mappings});
  // Persist the chosen names before creating any placeholders so a crash cannot
  // subsequently bind a different remote key to an existing local filename.
  await saveMappings(plan.mappings);
  let created=0,existing=0;const conflicts=[];
  for(const entry of plan.entries){
    if(signal?.aborted)throw new Error('Drive population cancelled.');
    const expected={key:entry.object.name,fileID:entry.object.fileID||null,etag:entry.object.etag||null};
    const current=bridge.inspect?await bridge.inspect(entry.path):{exists:false};
    if(current.exists){
      if(!current.cloud)throw new Error('An existing local file occupies a cloud filename; it was preserved.');
      let identity;try{identity=JSON.parse(current.identity);}catch{throw new Error('Existing placeholder has an invalid identity; it was preserved.');}
      if(identity.key!==expected.key)throw new Error('Existing placeholder identifies another remote object; it was preserved.');
      const dirty=entry.object.kind!=='folder'&&(!current.inSync||current.modifiedBytes>0);
      const remoteChanged=entry.object.kind!=='folder'&&(identity.fileID!==expected.fileID||identity.etag!==expected.etag);
      if(remoteChanged&&!dirty&&current.pinState!==1&&bridge.refresh){
        try{await bridge.refresh(entry.path,entry.object,current.identity);await onMaterialized(entry.path,expected);existing++;continue;}
        catch(error){conflicts.push({path:entry.path,key:identity.key,localChanged:false,remoteChanged:true,error:error.message});await onMaterialized(entry.path,identity);existing++;continue;}
      }
      if(dirty||remoteChanged)conflicts.push({path:entry.path,key:identity.key,localChanged:dirty,remoteChanged});
      await onMaterialized(entry.path,identity);existing++;continue;
    }
    await bridge.create(entry.name,entry.object,entry.parent);
    await onMaterialized(entry.path,expected);created++;
  }
  return {created,existing,conflicts,mappings:plan.mappings};
}
module.exports={planNamespace,populateInitialNamespace};
