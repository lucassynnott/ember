const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const {WindowsDriveAccounts}=require('../src/windows-drive-accounts');const {WindowsDriveState,storageIdentity}=require('../src/windows-drive-state');
const safeStorage={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from('encrypted:'+Buffer.from(value).toString('base64')),decryptString:value=>Buffer.from(value.toString().slice(10),'base64').toString()};
const config=bucket=>({provider:'s3',bucketName:bucket,region:'eu-west-1',keyID:'access-'+bucket,applicationKey:'secret-'+bucket});
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ember-accounts-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const options={directory:path.join(directory,'profile','windows-drive'),home:path.join(directory,'home'),safeStorage};await fs.mkdir(options.home);const registry=new WindowsDriveAccounts(options);await registry.load();return {registry,options};}
test('separate accounts retain credentials, offline bindings and interrupted recovery through restart and forgetting',async t=>{
 const {registry,options}=await fixture(t);const legacy=registry.profile(),original=new WindowsDriveState({directory:legacy.directory,safeStorage});await original.load();await original.configure(config('original'));
 await original.update(value=>{value.materialized['offline.txt']={key:'offline.txt',etag:'original-revision',size:123,pinned:true};value.pinnedUpdates.held={phase:'restored',original:'preserved-original',downloaded:'preserved-download'};});
 const before=await fs.readFile(original.file);await registry.adoptLegacy(original.snapshot().storageBinding);
 const second=await registry.reserve(config('second'));assert.notEqual(second.id,'legacy');assert.notEqual(second.root,legacy.root);assert.notEqual(second.directory,legacy.directory);assert.equal(registry.snapshot().active,'legacy');
 const secondState=new WindowsDriveState({directory:second.directory,safeStorage});await secondState.load();await secondState.configure(config('second'));await secondState.update(value=>{value.materialized['offline.txt']={key:'different.txt',etag:'second-revision',size:456};});
 assert.notEqual(secondState.snapshot().identity,original.snapshot().identity);await registry.activate(second.id,secondState.snapshot().storageBinding);assert.deepEqual(await fs.readFile(original.file),before);
 const reopened=new WindowsDriveAccounts(options);await reopened.load();assert.equal(reopened.profile().root,second.root);assert.equal((await reopened.reserve({...config('original'),keyID:'renewed-key'})).id,'legacy');
 await reopened.activate('legacy',original.snapshot().storageBinding);await original.forget();const again=new WindowsDriveState({directory:legacy.directory,safeStorage});await again.load();assert.equal(again.snapshot().config,null);assert.equal(again.snapshot().materialized['offline.txt'].etag,'original-revision');assert.equal(again.snapshot().pinnedUpdates.held.phase,'restored');
 assert.equal((await reopened.reserve(config('original'))).root,legacy.root);assert.equal(secondState.snapshot().config.applicationKey,'secret-second');
 const bytes=await fs.readFile(reopened.file);assert(!bytes.includes(Buffer.from('secret-original')));assert(!bytes.includes(Buffer.from('access-original')));assert.equal(JSON.parse(safeStorage.decryptString(bytes)).accounts.every(entry=>Object.keys(entry).sort().join(',')==='binding,id'),true);
});
test('concurrent reservations deduplicate identities and failed activation preserves the selected profile',async t=>{
 const {registry}=await fixture(t);await registry.adoptLegacy(storageIdentity(config('original')));
 const [one,two]=await Promise.all([registry.reserve(config('second')),registry.reserve(config('second'))]);assert.equal(one.id,two.id);assert.equal(registry.snapshot().accounts.length,2);
 const before=await fs.readFile(registry.file);await assert.rejects(registry.activate(one.id,storageIdentity(config('original'))),/does not match/);await assert.rejects(registry.activate('../outside',one.binding),/does not match/);assert.deepEqual(await fs.readFile(registry.file),before);assert.equal(registry.snapshot().active,'legacy');
 await assert.rejects(registry.adoptLegacy(one.binding),/changed/);assert.equal(registry.profile('legacy').binding,storageIdentity(config('original')));
});
test('corrupt, aliased or unavailable encrypted account registries are preserved without replacement',async t=>{
 const {registry,options}=await fixture(t);await registry.adoptLegacy(storageIdentity(config('original')));const original=await fs.readFile(registry.file);
 const invalid={version:1,active:'legacy',accounts:[{id:'legacy',binding:storageIdentity(config('original'))},{id:'../outside',binding:storageIdentity(config('second'))}]};await fs.writeFile(registry.file,safeStorage.encryptString(JSON.stringify(invalid)));const corrupted=await fs.readFile(registry.file);
 await assert.rejects(new WindowsDriveAccounts(options).load(),/preserved/);assert.deepEqual(await fs.readFile(registry.file),corrupted);
 await fs.writeFile(registry.file,original);await assert.rejects(new WindowsDriveAccounts({...options,safeStorage:{...safeStorage,isEncryptionAvailable:()=>false}}).load(),/unavailable/);assert.deepEqual(await fs.readFile(registry.file),original);
 await fs.rename(registry.file,registry.file+'.original');await fs.symlink(registry.file+'.original',registry.file);await assert.rejects(new WindowsDriveAccounts(options).load(),/preserved/);assert.deepEqual(await fs.readFile(registry.file+'.original'),original);
});

const {WindowsDriveAccountRuntime}=require('../src/windows-drive-account-runtime');
async function managerFixture(t,{failBucket=null}={}){
 const {registry,options}=await fixture(t),calls=[],instances=[];
 const runtimeFactory=({directory,root,onStatus})=>{
  const state=new WindowsDriveState({directory,safeStorage}),runtime={state,root,status:{supported:true,configured:false,mounted:false},started:false,get mountPath(){return this.status.mounted?root:null;},
   start:async function(){if(!this.started){await state.load();this.started=true;}if(state.snapshot().config)await this.mount();},
   save:async function(value){calls.push(['save',value.bucketName,root]);if(value.bucketName===failBucket)throw Error('Connection denied');await state.configure(value);await this.mount();return true;},
   mount:async function(){calls.push(['mount',state.snapshot().config?.bucketName,root]);this.status={...this.status,mounted:true,configured:true};onStatus(this.status);},
   unmount:async function(){calls.push(['unmount',state.snapshot().config?.bucketName,root]);this.status.mounted=false;onStatus(this.status);},
   forget:async function(){await this.unmount();await state.forget();return true;},
   backUp:async function(file,relative){calls.push(['backup',state.snapshot().config?.bucketName,file,relative]);return true;}
  };instances.push(runtime);return runtime;
 };
 const manager=new WindowsDriveAccountRuntime({...options,accounts:registry,runtimeFactory}),runtime=manager.facade;await runtime.start();return {manager,runtime,registry,options,calls,instances,runtimeFactory};
}
test('stable daemon facade switches isolated profiles and backups follow the selected root without changing prior journals',async t=>{
 const {runtime,registry,calls,instances,options,runtimeFactory}=await managerFixture(t);await runtime.save(config('original'));const old=instances[0],oldIdentity=old.state.snapshot().identity;
 await old.state.update(value=>{value.materialized['file.txt']={key:'first',etag:'one',size:1};value.uploads.held={phase:'sending',hash:'saved-first'};});const oldBytes=await fs.readFile(old.state.file);
 await runtime.save(config('second'));const secondID=runtime.accountID;assert.notEqual(runtime.state.snapshot().identity,oldIdentity);assert.equal(old.status.mounted,false);assert.deepEqual(await fs.readFile(old.state.file),oldBytes);
 await runtime.backUp('/fixture/video.mp4','Recordings/video.mp4');assert.equal(calls.at(-1)[1],'second');assert.equal(runtime.status.accounts.length,2);
 await runtime.selectAccount('legacy');assert.equal(runtime.accountID,'legacy');assert.equal(runtime.state.snapshot().uploads.held.hash,'saved-first');assert.equal(instances[1].status.mounted,false);
 await runtime.selectAccount(secondID);const reloaded=new WindowsDriveAccountRuntime({...options,runtimeFactory});await reloaded.facade.start();assert.equal(reloaded.facade.accountID,secondID);assert.equal(reloaded.facade.state.snapshot().config.bucketName,'second');assert.equal(registry.snapshot().active,secondID);
});
test('failed new-account setup restores the old mount and durable selection; reserved first profiles remain reconnectable after restart',async t=>{
 const {runtime,registry,calls,options,runtimeFactory}=await managerFixture(t,{failBucket:'denied'});await runtime.save(config('original'));const before=await fs.readFile(runtime.state.file);
 await assert.rejects(runtime.save(config('denied')),/denied/);assert.equal(runtime.accountID,'legacy');assert.equal(runtime.mountPath,registry.profile('legacy').root);assert.deepEqual(await fs.readFile(runtime.state.file),before);assert.equal(calls.at(-1)[1],'original');const denied=registry.snapshot().accounts.find(entry=>entry.binding===storageIdentity(config('denied')));
 await assert.rejects(runtime.selectAccount(denied.id),/Reconnect/);assert.equal(runtime.accountID,'legacy');
 const first=await managerFixture(t,{failBucket:'denied'});await assert.rejects(first.runtime.save(config('denied')),/denied/);const restarted=new WindowsDriveAccountRuntime({...first.options,runtimeFactory:first.runtimeFactory});await restarted.facade.start();assert.equal(restarted.facade.accountID,'legacy');assert.equal(restarted.facade.state.snapshot().config,null);
});
test('operations queued against a previous account cannot run after a pending switch',async t=>{
 const {runtime,calls}=await managerFixture(t);await runtime.save(config('first'));const switching=runtime.save(config('second'));const stale=runtime.backUp('/old-recording','old-recording');const refused=assert.rejects(stale,/selected Drive account changed/);await switching;await refused;assert.equal(calls.some(call=>call[0]==='backup'),false);
 await runtime.backUp('/new-recording','new-recording');assert.deepEqual(calls.at(-1).slice(0,3),['backup','second','/new-recording']);
});

test('new-account setup keys survive failure and restart without changing the active profile',async t=>{
 const {runtime,options,runtimeFactory}=await managerFixture(t,{failBucket:'denied'});await runtime.save(config('original'));
 await runtime.state.update(value=>{value.materialized['offline.txt']={key:'offline.txt',etag:'original',size:1};value.uploads.held={phase:'sending'};});const before=await fs.readFile(runtime.state.file),root=runtime.mountPath;
 await runtime.saveSetupDraft(config('denied'));assert.deepEqual(await fs.readFile(runtime.state.file),before);assert.equal(runtime.mountPath,root);
 await assert.rejects(runtime.saveSetupDraft(config('third')),/unfinished/);await assert.rejects(runtime.save(runtime.getSetupDraft()),/denied/);assert.equal(runtime.getSetupDraft().applicationKey,'secret-denied');assert.equal(runtime.accountID,'legacy');assert.deepEqual(await fs.readFile(runtime.state.file),before);
 const restarted=new WindowsDriveAccountRuntime({...options,runtimeFactory});await restarted.facade.start();assert.equal(restarted.facade.getSetupDraft().applicationKey,'secret-denied');assert.equal(restarted.facade.mountPath,root);
 const bytes=await fs.readFile(restarted.setupState.file);assert(!bytes.includes(Buffer.from('secret-denied')));
 // A successful connection moves to its own root and consumes only the saved draft.
 const success=await managerFixture(t);await success.runtime.save(config('first'));await success.runtime.saveSetupDraft(config('second'));await success.runtime.save(success.runtime.getSetupDraft());assert.equal(success.runtime.state.snapshot().config.bucketName,'second');assert.equal(success.runtime.getSetupDraft(),null);assert.notEqual(success.runtime.accountID,'legacy');
});

test('legacy setup drafts migrate durably and remain available after selecting another saved account',async t=>{
 const {runtime,options,runtimeFactory,instances}=await managerFixture(t);await runtime.save(config('first'));const legacy=instances[0];await legacy.state.saveSetupDraft(config('first'));
 const restart=new WindowsDriveAccountRuntime({...options,runtimeFactory});await restart.facade.start();assert.equal(restart.facade.getSetupDraft().applicationKey,'secret-first');assert.equal(restart.facade.state.snapshot().setupDraft,undefined);
 await restart.facade.save(config('second'));assert.equal(restart.facade.getSetupDraft().applicationKey,'secret-first');assert.equal(restart.facade.state.snapshot().config.bucketName,'second');
 await restart.facade.forget();assert.equal(restart.facade.getSetupDraft(),null);const original=new WindowsDriveState({directory:legacy.state.directory,safeStorage});await original.load();assert.equal(original.snapshot().config.bucketName,'first');
});
