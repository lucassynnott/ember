const test=require('node:test');const assert=require('node:assert/strict');
const {planNamespace,populateInitialNamespace}=require('../src/windows-drive-namespace');
const file=(name)=>({name,kind:'file',size:4,modified:1791280800000,etag:'"revision"'});
test('remote omissions retain file and directory reservations across later listings',()=>{
  const initial=planNamespace([file('notes.txt'),file('folder/old.txt')]);
  const omitted=planNamespace([file('NOTES.TXT')],{mappings:initial.mappings});
  assert.equal(omitted.mappings['']['file:notes.txt'],'notes.txt');
  assert.equal(omitted.mappings['']['folder:folder'],'folder');
  assert.equal(omitted.mappings['folder/']['file:old.txt'],'old.txt');
  assert.notEqual(omitted.entries[0].path.toUpperCase(),'NOTES.TXT');
  const returning=planNamespace([file('notes.txt'),file('NOTES.TXT'),file('folder/OLD.TXT')],{mappings:omitted.mappings});
  assert.equal(returning.entries.find(entry=>entry.object.name==='notes.txt').path,'notes.txt');
  assert.notEqual(returning.entries.find(entry=>entry.object.name==='folder/OLD.TXT').path.toUpperCase(),'FOLDER/OLD.TXT');
});
test('namespace preserves file/folder collisions, empty folders, empty components and case differences',()=>{
  const plan=planNamespace([file('Notes'),file('Notes/Café.txt'),file('notes.txt'),file('NOTES.TXT'),file('empty/.ghost-keep'),file('/leading.txt'),file('a//repeated.txt'),file('.ghost-trash/20200101/deleted')]);
  const paths=plan.entries.map(entry=>entry.path);assert.equal(new Set(paths.map(p=>p.toUpperCase())).size,paths.length);
  assert.ok(plan.entries.some(entry=>entry.object.name==='Notes'&&entry.object.kind==='file'));
  assert.ok(plan.entries.some(entry=>entry.object.name==='Notes/'&&entry.object.kind==='folder'));
  assert.ok(plan.entries.some(entry=>entry.path==='empty'&&entry.object.kind==='folder'));
  assert.ok(plan.entries.some(entry=>entry.object.name==='/leading.txt'&&entry.path.startsWith('~empty/')));
  assert.ok(plan.entries.some(entry=>entry.object.name==='a//repeated.txt'&&entry.path==='a/~empty/repeated.txt'));
  assert.ok(paths.every(p=>!p.includes('.ghost-keep')&&!p.includes('.ghost-trash')));
  for(const entry of plan.entries)if(entry.parent)assert.ok(paths.indexOf(entry.parent)<paths.indexOf(entry.path));
});
test('population saves stable mapping before native writes and stops on an uncertain create',async()=>{
  const calls=[];let creates=0;
  const store={listAll:async()=>[file('folder/one.txt'),file('folder/two.txt')]};
  const bridge={create:async(name,object,parent)=>{calls.push({name,remote:object.name,parent});if(++creates===2)throw new Error('native timeout');}};
  await assert.rejects(populateInitialNamespace(bridge,store,{saveMappings:async mapping=>{calls.push('saved');assert.equal(mapping['folder/']['file:one.txt'],'one.txt');}}),/native timeout/);
  assert.equal(calls[0],'saved');assert.equal(creates,2);assert.equal(calls.length,3);
});
test('incomplete file metadata rejects the whole namespace before materialization',async()=>{
  let writes=0;
  await assert.rejects(populateInitialNamespace({create:async()=>writes++},{listAll:async()=>[file('good'),{name:'bad',size:4,modified:0}]},{saveMappings:async()=>writes++}),/metadata is incomplete/);
  assert.equal(writes,0);
});
test('reconnection preserves local edits and remote revision changes without overwriting',async()=>{
  const files=[file('edited.txt'),file('remote-changed.txt')],saved=[];let creates=0;
  const bridge={inspect:async name=>({exists:true,cloud:true,identity:JSON.stringify({key:name,fileID:null,etag:name==='edited.txt'?'"revision"':'"old"'}),inSync:name!=='edited.txt',modifiedBytes:name==='edited.txt'?4:0}),create:async()=>creates++};
  const result=await populateInitialNamespace(bridge,{listAll:async()=>files},{onMaterialized:async(...args)=>saved.push(args)});
  assert.equal(creates,0);assert.equal(result.existing,2);assert.equal(result.conflicts.length,2);
  assert.ok(result.conflicts.find(c=>c.key==='edited.txt').localChanged);assert.ok(result.conflicts.find(c=>c.key==='remote-changed.txt').remoteChanged);
  assert.equal(saved.find(([name])=>name==='remote-changed.txt')[1].etag,'"old"');
});
test('an ordinary existing local file is preserved and blocks its replacement',async()=>{
  let creates=0;await assert.rejects(populateInitialNamespace({inspect:async()=>({exists:true,cloud:false}),create:async()=>creates++},{listAll:async()=>[file('existing.txt')]}),/existing local file/);assert.equal(creates,0);
});
test('clean remote refresh records the new identity only after native invalidation succeeds',async()=>{
 const stored=[],calls=[];let fail=false;
 const bridge={inspect:async()=>({exists:true,cloud:true,identity:JSON.stringify({key:'file',etag:'old',fileID:null}),inSync:true,modifiedBytes:0,pinState:0}),refresh:async(...args)=>{calls.push(args);if(fail)throw new Error('file locked');}};
 const options={onMaterialized:async(local,identity)=>stored.push(identity)};
 const first=await populateInitialNamespace(bridge,{listAll:async()=>[file('file')]},options);assert.equal(first.conflicts.length,0);assert.equal(stored[0].etag,'"revision"');assert.equal(JSON.parse(calls[0][2]).etag,'old');
 fail=true;const second=await populateInitialNamespace(bridge,{listAll:async()=>[file('file')]},options);assert.equal(second.conflicts[0].error,'file locked');assert.equal(stored[1].etag,'old');
});
test('tracked replacement files remain local conflicts without blocking namespace reconnection',async()=>{
 let creates=0;const previous={key:'file',etag:'old',fileID:null};
 const result=await populateInitialNamespace({inspect:async()=>({exists:true,cloud:false}),create:async()=>creates++},{listAll:async()=>[file('file')]},{materialized:{file:previous}});
 assert.equal(creates,0);assert.equal(result.existing,1);assert.equal(result.conflicts[0].localChanged,true);
});
test('confirmed remote folder markers reconnect tracked ordinary directories without a replacement conflict',async()=>{
 const stored=[];const result=await populateInitialNamespace({inspect:async()=>({exists:true,cloud:false,directory:true})},{listAll:async()=>[{name:'empty/.ghost-keep',kind:'file',size:0,modified:0,etag:'marker'}]},{materialized:{empty:{key:'empty/',etag:null,fileID:null,remoteConfirmed:false}},onMaterialized:async(local,identity)=>stored.push(identity)});
 assert.equal(result.existing,1);assert.equal(result.conflicts.length,0);assert.equal(stored[0].remoteConfirmed,true);
 const fileCollision=await populateInitialNamespace({inspect:async()=>({exists:true,cloud:false,directory:false})},{listAll:async()=>[{name:'empty/.ghost-keep',kind:'file',size:0,modified:0,etag:'marker'}]},{materialized:{empty:{key:'empty/',etag:null,fileID:null}}});assert.equal(fileCollision.conflicts.length,1);
});
test('search metadata follows the confirmed local revision and preserves older sizes during conflicts',async()=>{
 const remote={...file('file'),size:8192,modified:1791280900000},stored=[];let current=null;
 const bridge={inspect:async()=>current||{exists:false},create:async()=>{},refresh:async()=>{throw new Error('locked');}};
 const options={onMaterialized:async(local,identity)=>stored.push(identity),materialized:{file:{key:'file',fileID:null,etag:'old',size:42,modified:100}}};
 await populateInitialNamespace(bridge,{listAll:async()=>[remote]},options);assert.equal(stored.at(-1).size,8192);assert.equal(stored.at(-1).modified,remote.modified);
 current={exists:true,cloud:true,inSync:true,modifiedBytes:0,pinState:0,identity:JSON.stringify({key:'file',fileID:null,etag:'old'})};
 await populateInitialNamespace(bridge,{listAll:async()=>[remote]},options);assert.equal(stored.at(-1).size,42);assert.equal(stored.at(-1).modified,100);
 current.identity=JSON.stringify({key:'file',fileID:null,etag:remote.etag});await populateInitialNamespace(bridge,{listAll:async()=>[remote]},options);assert.equal(stored.at(-1).size,8192);assert.equal(stored.at(-1).modified,remote.modified);
});
test('refresh preserves pending operations, missing tracked paths and remote omissions',async()=>{
 const touched=[];const bridge={inspect:async local=>{touched.push(local);return {exists:false};},create:async local=>touched.push('create:'+local)};
 const result=await populateInitialNamespace(bridge,{listAll:async()=>[file('pending.txt'),file('missing.txt'),file('new.txt')]},{pending:[{local:'pending.txt',key:'pending.txt'}],preserveMissing:true,materialized:{'pending.txt':{key:'pending.txt'},'missing.txt':{key:'missing.txt'},'removed.txt':{key:'removed.txt'}}});
 assert.deepEqual(touched,['missing.txt','new.txt','create:new.txt']);assert.equal(result.created,1);
 assert.ok(result.conflicts.find(c=>c.unfinishedUpload&&c.path==='pending.txt'));assert.ok(result.conflicts.find(c=>c.localMissing&&c.path==='missing.txt'));assert.ok(result.conflicts.find(c=>c.remoteMissing&&c.path==='removed.txt'));
});
test('pinned refresh installs clean revisions and keeps failed or pending revisions held',async()=>{
 const previous={key:'file',fileID:null,etag:'old',size:42,modified:100},saved=[],calls=[];let dirty=false,fail=false;
 const bridge={inspect:async()=>({exists:true,cloud:true,identity:JSON.stringify(previous),inSync:!dirty,modifiedBytes:dirty?1:0,pinState:1}),refresh:async()=>{throw Error('Pinned files must retain offline content');}};
 const options={materialized:{file:previous},onMaterialized:async(_,identity)=>saved.push(identity),refreshPinned:async(local,object,signal)=>{calls.push({local,object,signal});if(fail)throw Error('replacement interrupted');}};
 const store={listAll:async()=>[file('file')]};
 assert.equal((await populateInitialNamespace(bridge,store,options)).conflicts.length,0);assert.equal(saved.at(-1).etag,'"revision"');assert.equal(calls.length,1);
 fail=true;const held=await populateInitialNamespace(bridge,store,options);assert.equal(held.conflicts[0].error,'replacement interrupted');assert.equal(saved.at(-1).etag,'old');
 dirty=true;await populateInitialNamespace(bridge,store,options);assert.equal(calls.length,2);
 dirty=false;await populateInitialNamespace(bridge,store,{...options,pending:[{local:'file',key:'file'}]});assert.equal(calls.length,2);
});
