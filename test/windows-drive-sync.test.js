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
test('refresh waits for an in-flight filename reservation while later reservations wait for refresh',async()=>{
 const fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const root=await fsp.mkdtemp(path.join(os.tmpdir(),'ember-drive-reservation-'));await fsp.writeFile(path.join(root,'first.txt'),'one');await fsp.writeFile(path.join(root,'second.txt'),'two');let release;const calls=[];
 const sync=new WindowsDriveSync({root,state:{snapshot:()=>({materialized:{},uploads:{}})},bridge:{inspect:async()=>({exists:true,cloud:false})},reserveFile:async local=>{calls.push('reserve:'+local);if(local==='first.txt')await new Promise(resolve=>release=resolve);return local;},upload:async local=>calls.push('upload:'+local),debounceMs:5});
 try{sync.notify('first.txt');await delay(15);const refresh=sync.pauseFor(async()=>{calls.push('refresh');assert.equal(calls.includes('reserve:second.txt'),false);});sync.notify('second.txt');await delay(15);assert.deepEqual(calls,['reserve:first.txt']);release();await refresh;await delay(20);assert.equal(calls.indexOf('refresh')<calls.indexOf('reserve:second.txt'),true);assert.equal(calls.indexOf('refresh')<calls.indexOf('upload:first.txt'),true);}
 finally{release?.();await sync.close();await fsp.rm(root,{recursive:true,force:true});}
});

test('actual local rename notifications dispatch one move rather than uploading the old cloud identity',async()=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const root=await fs.mkdtemp(path.join(os.tmpdir(),'ember-watch-move-'));await fs.writeFile(path.join(root,'original.txt'),'Original bytes');
 const data={materialized:{'original.txt':{key:'cloud/original.txt',etag:'old',fileID:null}},uploads:{},moves:{}},calls=[];
 const inspect=async local=>{try{await fs.stat(path.join(root,local));return {exists:true,cloud:true,inSync:true,modifiedBytes:0,identity:JSON.stringify({key:'cloud/original.txt',etag:'old',fileID:null})};}catch(error){if(error.code==='ENOENT')return {exists:false};throw error;}};
 const sync=new WindowsDriveSync({root,state:{snapshot:()=>structuredClone(data)},bridge:{inspect},reserveFile:async local=>{calls.push('reserve:'+local);return 'cloud/'+local;},move:async(from,local,key)=>{calls.push('move:'+from+':'+local);assert.equal(await fs.readFile(path.join(root,local),'utf8'),'Original bytes');delete data.materialized[from];data.materialized[local]={key,etag:'moved'};},upload:async()=>calls.push('upload'),debounceMs:5,scanIntervalMs:60000});
 try{sync.start();await delay(30);await fs.rename(path.join(root,'original.txt'),path.join(root,'renamed.txt'));const deadline=Date.now()+2000;while(!data.materialized['renamed.txt']&&Date.now()<deadline)await delay(10);assert.deepEqual(calls,['reserve:renamed.txt','move:original.txt:renamed.txt']);assert.equal(data.materialized['renamed.txt'].key,'cloud/renamed.txt');}finally{await sync.close();await fs.rm(root,{recursive:true,force:true});}
});

test('uncertain moves protect both paths and watcher scans never replay the move as an upload',async()=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const root=await fs.mkdtemp(path.join(os.tmpdir(),'ember-watch-held-move-'));await fs.writeFile(path.join(root,'renamed.txt'),'Held bytes');
 const data={materialized:{'original.txt':{key:'cloud/original.txt',etag:'old'}},uploads:{},moves:{}},statuses=[];let moves=0,uploads=0;
 const sync=new WindowsDriveSync({root,state:{snapshot:()=>structuredClone(data)},bridge:{inspect:async local=>local==='original.txt'?{exists:false}:{exists:true,cloud:true,identity:JSON.stringify({key:'cloud/original.txt'})}},reserveFile:async()=> 'cloud/renamed.txt',move:async(from,local,key)=>{moves++;data.moves.pending={from,local,key,previous:{key:'cloud/original.txt'},phase:'copying'};throw Error('Lost response');},upload:async()=>uploads++,onStatus:value=>statuses.push(value),debounceMs:5});
 try{sync.notify('renamed.txt');await delay(25);await sync.scan();await delay(25);assert.equal(moves,1);assert.equal(uploads,0);assert.ok(statuses.some(status=>status.held==='renamed.txt'&&status.reason==='unfinished-upload'));assert.ok(statuses.some(status=>status.held==='original.txt'&&status.reason==='unfinished-upload'));}finally{await sync.close();await fs.rm(root,{recursive:true,force:true});}
});

test('copied placeholders and children of renamed cloud folders never dispatch destructive moves',async()=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const root=await fs.mkdtemp(path.join(os.tmpdir(),'ember-watch-move-refusal-'));await fs.mkdir(path.join(root,'Moved folder'));await fs.writeFile(path.join(root,'copy.txt'),'Copy');await fs.writeFile(path.join(root,'Moved folder','inside.txt'),'Child');let writes=0;
 const data={materialized:{'original.txt':{key:'cloud/original.txt'},'Original folder':{key:'cloud/folder/'},'Original folder/inside.txt':{key:'cloud/folder/inside.txt'}},uploads:{},moves:{}};
 const bridge={inspect:async local=>local==='Moved folder'?{exists:true,cloud:true,directory:true,identity:JSON.stringify({key:'cloud/folder/'})}:local==='copy.txt'||local==='original.txt'?{exists:true,cloud:true,identity:JSON.stringify({key:'cloud/original.txt'})}:local==='Moved folder/inside.txt'?{exists:true,cloud:true,identity:JSON.stringify({key:'cloud/folder/inside.txt'})}:{exists:false}};
 const sync=new WindowsDriveSync({root,state:{snapshot:()=>structuredClone(data)},bridge,reserveFile:async()=>{writes++;},reserveFolder:async()=>{writes++;},move:async()=>{writes++;},upload:async()=>{writes++;},debounceMs:5});
 try{sync.notify('copy.txt');sync.notify('Moved folder');sync.notify('Moved folder/inside.txt');await delay(30);assert.equal(writes,0);}finally{await sync.close();await fs.rm(root,{recursive:true,force:true});}
});

test('a recovered move retires its queued rename and later edits upload to the confirmed destination',async()=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const root=await fs.mkdtemp(path.join(os.tmpdir(),'ember-recovered-watch-move-'));await fs.writeFile(path.join(root,'renamed.txt'),'Bytes');
 const data={materialized:{'original.txt':{key:'cloud/original.txt'}},moves:{},uploads:{}};let moves=0;const uploaded=[];
 const sync=new WindowsDriveSync({root,state:{snapshot:()=>structuredClone(data)},bridge:{inspect:async local=>local==='original.txt'?{exists:false}:{exists:true,cloud:true,inSync:false,modifiedBytes:1,identity:JSON.stringify({key:data.materialized['renamed.txt']?.key||'cloud/original.txt'})}},reserveFile:async()=> 'cloud/renamed.txt',move:async(from,local,key)=>{moves++;data.moves.id={from,local,key,previous:{key:'cloud/original.txt'}};throw Error('Lost delete response');},upload:async(local,key)=>uploaded.push(key),debounceMs:5});
 try{sync.notify('renamed.txt');await delay(30);assert.equal(moves,1);data.moves={};delete data.materialized['original.txt'];data.materialized['renamed.txt']={key:'cloud/renamed.txt',etag:'confirmed'};sync.notify('renamed.txt');await delay(30);assert.equal(moves,1);assert.deepEqual(uploaded,['cloud/renamed.txt']);}finally{await sync.close();await fs.rm(root,{recursive:true,force:true});}
});
async function caseWatchFixture(){
 const fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const root=await fsp.mkdtemp(path.join(os.tmpdir(),'ember-case-watch-'));await fsp.writeFile(path.join(root,'original.txt'),'Preserve bytes');
 const data={materialized:{'original.txt':{key:'remote/original.txt'}},moves:{},uploads:{}},calls=[],statuses=[];
 const sync=new WindowsDriveSync({root,state:{snapshot:()=>structuredClone(data)},bridge:{inspect:async()=>({exists:true,cloud:true,inSync:true,modifiedBytes:0,identity:JSON.stringify({key:data.materialized['ORIGINAL.TXT']?.key||'remote/original.txt'})})},reserveFile:async(local,from)=>{calls.push(['reserve',local,from]);return 'remote/'+local;},move:async(from,local,key)=>{calls.push(['move',from,local,key]);delete data.materialized[from];data.materialized[local]={key};},upload:async(local,key)=>calls.push(['upload',local,key]),onStatus:value=>statuses.push(value),debounceMs:5,scanIntervalMs:60000});
 return {fsp,path,root,data,calls,statuses,sync,async close(){await sync.close();await fsp.rm(root,{recursive:true,force:true});}};
}
test('actual case-only filesystem rename routes to one move with its original source rather than an upload',async()=>{
 const f=await caseWatchFixture();try{f.sync.start();await delay(30);await f.fsp.rename(f.path.join(f.root,'original.txt'),f.path.join(f.root,'ORIGINAL.TXT'));const deadline=Date.now()+2000;while(!f.data.materialized['ORIGINAL.TXT']&&Date.now()<deadline)await delay(10);assert.deepEqual(f.calls,[['reserve','ORIGINAL.TXT','original.txt'],['move','original.txt','ORIGINAL.TXT','remote/ORIGINAL.TXT']]);assert.equal(await f.fsp.readFile(f.path.join(f.root,'ORIGINAL.TXT'),'utf8'),'Preserve bytes');}finally{await f.close();}
});
test('a missed case-only notification is redirected by the directory scan without uploading the old cloud key',async()=>{
 const f=await caseWatchFixture();try{await f.fsp.rename(f.path.join(f.root,'original.txt'),f.path.join(f.root,'ORIGINAL.TXT'));await f.sync.scan();const deadline=Date.now()+2000;while(!f.data.materialized['ORIGINAL.TXT']&&Date.now()<deadline)await delay(10);assert.equal(f.calls.filter(call=>call[0]==='move').length,1);assert.equal(f.calls.some(call=>call[0]==='upload'),false);assert.equal(f.calls[0][2],'original.txt');}finally{await f.close();}
});
test('a capitalization alias notification cannot move an unchanged original',async()=>{
 const f=await caseWatchFixture();try{f.sync.notify('ORIGINAL.TXT');await delay(30);assert.equal(f.calls.length,0);assert.equal(f.data.materialized['original.txt'].key,'remote/original.txt');assert.equal(await f.fsp.readFile(f.path.join(f.root,'original.txt'),'utf8'),'Preserve bytes');}finally{await f.close();}
});
