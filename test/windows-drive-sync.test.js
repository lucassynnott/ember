const test=require('node:test');const assert=require('node:assert/strict');const {WindowsDriveSync}=require('../src/windows-drive-sync');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fixture(){const data={materialized:{'folder/file.txt':{key:'remote/file'}},uploads:{}};let writes=0;const statuses=[];
 const sync=new WindowsDriveSync({root:'fixture',state:{snapshot:()=>structuredClone(data)},bridge:{inspect:async()=>({exists:true,cloud:false})},upload:async()=>writes++,onStatus:value=>statuses.push(value),debounceMs:5});return {sync,data,statuses,get writes(){return writes;}};
}
test('repeated edit notifications debounce to one tracked upload',async()=>{
 const f=fixture();try{f.sync.notify('folder/file.txt');f.sync.notify('folder/FILE.txt');f.sync.notify('folder/file.txt');await delay(25);assert.equal(f.writes,1);assert.equal(f.statuses.at(-1).synced,'folder/file.txt');}finally{await f.sync.close();}
});
test('uncertain upload journal holds subsequent notifications instead of replaying',async()=>{
 const f=fixture();f.sync.upload=async()=>{f.data.uploads.pending={local:'folder/file.txt',key:'remote/file',phase:'sending'};throw new Error('uncertain write');};
 try{f.sync.notify('folder/file.txt');await delay(25);f.sync.notify('folder/file.txt');await delay(25);assert.equal(f.statuses.filter(s=>s.uploading).length,1);assert.equal(f.statuses.at(-1).reason,'unfinished-upload');}finally{await f.sync.close();}
});
test('clean placeholders and missing local files never trigger upload',async()=>{
 const f=fixture();try{f.sync.bridge.inspect=async()=>({exists:true,cloud:true,inSync:true,modifiedBytes:0});f.sync.notify('folder/file.txt');await delay(25);assert.equal(f.writes,0);f.sync.bridge.inspect=async()=>({exists:false});f.sync.notify('folder/file.txt');await delay(25);assert.equal(f.writes,0);assert.equal(f.statuses.at(-1).reason,'local-missing');}finally{await f.sync.close();}
});
test('actual filesystem watching uploads a tracked edit and stops after close',async()=>{
 const fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'ember-drive-watch-'));const file=path.join(root,'file.txt');await fsp.writeFile(file,'Before');let dirty=false;const uploaded=[];
 const sync=new WindowsDriveSync({root,state:{snapshot:()=>({materialized:{'file.txt':{key:'remote/file'}},uploads:{}})},bridge:{inspect:async()=>({exists:true,cloud:true,inSync:!dirty,modifiedBytes:dirty?1:0})},upload:async()=>{uploaded.push(await fsp.readFile(file,'utf8'));dirty=false;},debounceMs:10,scanIntervalMs:60000});
 try{sync.start();await delay(30);dirty=true;await fsp.writeFile(file,'After edit');const deadline=Date.now()+2000;while(!uploaded.length&&Date.now()<deadline)await delay(10);assert.deepEqual(uploaded,['After edit']);await sync.close();dirty=true;await fsp.writeFile(file,'After close');await delay(30);assert.equal(uploaded.length,1);}
 finally{await sync.close();await fsp.rm(root,{recursive:true,force:true});}
});
test('new file discovery reserves its cloud key before uploading actual local bytes',async()=>{
 const fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const root=await fsp.mkdtemp(path.join(os.tmpdir(),'ember-drive-add-'));await fsp.mkdir(path.join(root,'New folder'));await fsp.writeFile(path.join(root,'New folder','file.txt'),'New content');const calls=[];
 const sync=new WindowsDriveSync({root,state:{snapshot:()=>({materialized:{},uploads:{}})},bridge:{inspect:async()=>({exists:true,cloud:false})},reserveFile:async local=>{calls.push('reserve:'+local);return 'cloud/'+local;},upload:async(local,key)=>{calls.push('upload:'+key);assert.equal(await fsp.readFile(path.join(root,...local.split('/')),'utf8'),'New content');},debounceMs:5});
 try{await sync.scan();const deadline=Date.now()+2000;while(calls.length<2&&Date.now()<deadline)await delay(10);assert.deepEqual(calls,['reserve:New folder/file.txt','upload:cloud/New folder/file.txt']);}finally{await sync.close();await fsp.rm(root,{recursive:true,force:true});}
});
test('actual empty-folder discovery reserves before sync and holds an uncertain folder intent',async()=>{
 const fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const root=await fsp.mkdtemp(path.join(os.tmpdir(),'ember-drive-empty-folder-'));await fsp.mkdir(path.join(root,'Empty'));const calls=[],data={materialized:{},uploads:{},folderUploads:{}};
 const sync=new WindowsDriveSync({root,state:{snapshot:()=>structuredClone(data)},bridge:{},reserveFolder:async local=>{calls.push('reserve:'+local);data.materialized[local]={key:'remote/'+local+'/',remoteConfirmed:false};return 'remote/'+local+'/';},syncFolder:async(local,key)=>{calls.push('folder:'+key);data.folderUploads.id={local,key};throw new Error('Uncertain folder write');},upload:async()=>{throw new Error('Folder discovery must not upload file bytes');},debounceMs:5});
 try{await sync.scan();const deadline=Date.now()+2000;while(calls.length<2&&Date.now()<deadline)await delay(10);await sync.scan();await delay(30);assert.deepEqual(calls,['reserve:Empty','folder:remote/Empty/']);}finally{await sync.close();await fsp.rm(root,{recursive:true,force:true});}
});
test('namespace pause finishes an active upload and defers new edits until refresh completes',async()=>{
 const f=fixture();let finishUpload,finishRefresh;const calls=[];
 f.sync.upload=async()=>{calls.push('upload');await new Promise(resolve=>finishUpload=resolve);};
 try{
  f.sync.notify('folder/file.txt');await delay(20);assert.equal(calls.length,1);
  const paused=f.sync.pauseFor(async()=>{calls.push('refresh');await new Promise(resolve=>finishRefresh=resolve);});
  f.sync.notify('folder/file.txt');await delay(20);assert.deepEqual(calls,['upload']);finishUpload();await delay(10);assert.deepEqual(calls,['upload','refresh']);
  finishRefresh();await paused;await delay(10);assert.deepEqual(calls,['upload','refresh','upload']);finishUpload();
 }finally{finishUpload?.();finishRefresh?.();await f.sync.close();}
});
test('closing a paused synchronizer aborts refresh and releases waiting notifications',async()=>{
 const f=fixture();let entered;const started=new Promise(resolve=>entered=resolve);
 const paused=f.sync.pauseFor(signal=>new Promise((resolve,reject)=>{entered();signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});}));
 const rejected=assert.rejects(paused,/aborted/);await started;f.sync.notify('folder/file.txt');await delay(10);await f.sync.close();await rejected;assert.equal(f.writes,0);assert.equal(f.sync.paused,false);
});
