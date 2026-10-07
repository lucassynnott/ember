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
 try{await assert.rejects(runtime.start(),/native failure/);assert.equal(updates.some(s=>s.mounted),false);assert.equal(runtime.status.message,'native failure');assert.equal(closed,1);assert.equal(bridge.closed,true);}
 finally{await fs.rm(root,{recursive:true,force:true});}
});
test('forget disconnects before removing credentials and refuses a new account before cloud access',async()=>{
 let snapshot={config:{provider:'custom',bucketName:'original'},materialized:{'file':{key:'file',etag:'original'}}};const calls=[];
 const fixture={snapshot:()=>structuredClone(snapshot),forget:async()=>{calls.push('forget');snapshot.storageBinding=JSON.stringify(['custom','original','','','']);snapshot.config=null;}};
 const runtime=new WindowsDriveRuntime({state:fixture,platform:'win32',syncEnabled:false,storeFactory:async()=>{calls.push('cloud');throw new Error('Should not reach cloud');}});runtime.status.configured=true;runtime.status.mounted=true;runtime.bridge={closed:false,command:async command=>calls.push(command),close:()=>calls.push('close')};runtime.store={close:()=>calls.push('store-close')};
 await runtime.forget();assert.deepEqual(calls,['disconnect','close','store-close','forget']);assert.equal(runtime.status.configured,false);assert.equal(runtime.mountPath,null);
 await assert.rejects(runtime.save({provider:'custom',bucketName:'different'}),/separate Drive root/);assert.equal(calls.includes('cloud'),false);
});
test('File Explorer readiness is published only after native registration confirmation',async()=>{
 const updates=[],runtime=new WindowsDriveRuntime({state:state(),platform:'win32',syncEnabled:false,onStatus:value=>updates.push(value)});let confirmed=false;
 runtime.bridge={explorerRegister:async()=>({registered:confirmed})};await assert.rejects(runtime.sidebar(),/did not confirm/);assert.equal(updates.some(value=>value.sidebarReady),false);
 confirmed=true;assert.deepEqual(await runtime.sidebar(),{error:null});assert.equal(runtime.status.sidebarReady,true);
});
test('refresh discovers new files without reconnecting and listing failures preserve the mounted provider',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drive-refresh-'));const entries=new Map();let files=[],failure=false,registered=0;
 const store={listAll:async()=>{if(failure)throw new Error('cloud unavailable');return files;},close(){}};
 const bridge=new EventEmitter();Object.assign(bridge,{register:async()=>registered++,inspect:async local=>entries.has(local)?{exists:true,cloud:true,inSync:true,modifiedBytes:0,identity:JSON.stringify(entries.get(local))}:{exists:false},create:async(name,object)=>entries.set(name,{key:object.name,etag:object.etag,fileID:null}),refresh:async(local,object)=>entries.set(local,{key:object.name,etag:object.etag,fileID:null}),command:async()=>{},close(){this.closed=true;}});
 const runtime=new WindowsDriveRuntime({root,state:state(),platform:'win32',syncEnabled:false,storeFactory:async()=>store,bridgeFactory:()=>bridge});
 try{await runtime.start();files=[{name:'new.txt',size:4,modified:0,etag:'first'}];await runtime.refresh();assert.equal(entries.get('new.txt').etag,'first');files[0].etag='second';await runtime.refresh();assert.equal(entries.get('new.txt').etag,'second');assert.equal(registered,1);failure=true;await assert.rejects(runtime.refresh(),/cloud unavailable/);assert.equal(runtime.mountPath,root);assert.equal(runtime.status.message,'cloud unavailable');failure=false;await runtime.refresh();assert.equal(runtime.status.message,null);}
 finally{await runtime.unmount();await fs.rm(root,{recursive:true,force:true});}
});
