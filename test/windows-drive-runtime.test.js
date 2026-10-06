const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const {EventEmitter}=require('node:events');
const {WindowsDriveRuntime}=require('../src/windows-drive-runtime');
function state(){let data={identity:'fixture',config:{provider:'custom',bucketName:'bucket'},mappings:{},materialized:{}};return {load:async()=>data,snapshot:()=>structuredClone(data),saveMappings:async value=>{data.mappings=value;},markMaterialized:async(local,identity)=>{data.materialized[local]=identity;},configure:async config=>{data.config=config;}};}
test('runtime publishes mounted only after materialization and disconnects on unmount',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drive-runtime-'));const updates=[],calls=[];let closed=0;
 const store={listAll:async()=>[{name:'file.txt',size:4,modified:0,etag:'revision'}],close:()=>closed++};
 const bridge=new EventEmitter();Object.assign(bridge,{closed:false,register:async()=>calls.push('register'),inspect:async()=>({exists:false}),create:async()=>{assert.equal(updates.some(s=>s.mounted),false);calls.push('create');},command:async cmd=>calls.push(cmd),close(){this.closed=true;this.emit('stopped');}});
 const runtime=new WindowsDriveRuntime({root,state:state(),platform:'win32',syncEnabled:false,storeFactory:async()=>store,bridgeFactory:()=>bridge,onStatus:status=>updates.push(status)});
 try{await runtime.start();assert.equal(runtime.mountPath,root);assert.deepEqual(calls,['register','create']);assert.equal((await runtime.search('file'))[0].key,'file.txt');await runtime.unmount();assert.equal(runtime.mountPath,null);assert.equal(closed,1);assert.equal(calls.at(-1),'disconnect');}
 finally{await fs.rm(root,{recursive:true,force:true});}
});
test('uncertain connection-test deletion is attempted once and never replayed',async()=>{
 let body,deletes=0,closed=0;const store={upload:async file=>{body=await fs.readFile(file);},stat:async()=>({size:64,etag:'revision',fileID:'version'}),read:async()=>body,deleteVersion:async()=>{deletes++;throw new Error('uncertain delete');},close:()=>closed++};
 const runtime=new WindowsDriveRuntime({state:state(),platform:'win32',syncEnabled:false,storeFactory:async()=>store});
 await assert.rejects(runtime.test({}),/uncertain delete/);assert.equal(deletes,1);assert.equal(closed,1);
});
test('failed native population never reports a mounted Drive and closes its resources',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drive-runtime-fail-'));let closed=0;const updates=[];
 const store={listAll:async()=>[{name:'file.txt',size:4,modified:0,etag:'revision'}],close:()=>closed++};
 const bridge=new EventEmitter();Object.assign(bridge,{register:async()=>{},inspect:async()=>({exists:false}),create:async()=>{throw new Error('native failure');},close(){this.closed=true;}});
 const runtime=new WindowsDriveRuntime({root,state:state(),platform:'win32',syncEnabled:false,storeFactory:async()=>store,bridgeFactory:()=>bridge,onStatus:s=>updates.push(s)});
 try{await assert.rejects(runtime.start(),/native failure/);assert.equal(updates.some(s=>s.mounted),false);assert.equal(closed,1);assert.equal(bridge.closed,true);}
 finally{await fs.rm(root,{recursive:true,force:true});}
});
