const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');
const {WindowsDriveService}=require('../src/windows-drive-service');
function fixture(){
 const root=path.resolve('test-drive-root'),calls=[],events=[];
 const saved={provider:'s3',keyID:'key',applicationKey:'secret',bucketName:'bucket'};
 const entries={'Encoded~name':{key:'remote:name',size:12},'Folder':{key:'cloud/'},'Folder/Child.txt':{key:'cloud/Child.txt',size:3}};
 const runtime={status:{supported:true,mounted:true},mountPath:root,state:{snapshot:()=>({config:saved,materialized:entries})},start:async()=>{},unmount:async()=>{},test:async config=>{calls.push(['test',config]);return true;},save:async config=>{calls.push(['save',config]);return true;},share:async key=>key,pin:async local=>calls.push(['pin',local]),unpin:async local=>calls.push(['unpin',local]),search:async()=>[{key:'remote:name',name:'Encoded~name',path:'Encoded~name'}]};
 const service=new WindowsDriveService({runtime,shell:{showItemInFolder:target=>calls.push(['reveal',target]),openPath:async()=>''},onEvent:(...event)=>events.push(event)});
 return {service,runtime,calls,events,entries};
}
test('renderer settings redact the secret; blank values reuse only the same access key',async()=>{
 const {service,calls}=fixture();const settings=await service.request('settings');assert.equal(settings.applicationKey,'');assert.equal(settings.hasSecret,true);assert(!JSON.stringify(settings).includes('secret'));
 await service.request('save',{config:{provider:'s3',keyID:'key',applicationKey:'',bucketName:'bucket'}});assert.equal(calls[0][1].applicationKey,'secret');
 await service.request('save',{config:{provider:'s3',keyID:'different',applicationKey:'',bucketName:'bucket'}});assert.equal(calls[1][1].applicationKey,'');
});
test('reveal resolves the recorded filename and refuses unknown or unsafe mappings',async()=>{
 const {service,calls,runtime,entries}=fixture();await service.request('reveal',{key:'remote:name'});assert.equal(calls[0][1],path.join(runtime.mountPath,'Encoded~name'));
 assert.equal(await service.request('resolve',{key:'remote:name'}),path.join(runtime.mountPath,'Encoded~name'));
 await assert.rejects(service.request('reveal',{key:'../elsewhere'}),/unique local/);
 entries['../elsewhere']={key:'malicious'};await assert.rejects(service.request('reveal',{key:'malicious'}),/Invalid local/);
 entries['one\\two']={key:'backslash'};await assert.rejects(service.request('reveal',{key:'backslash'}),/Invalid local/);
});
test('search follows the existing renderer shape and folder pinning resolves descendants',async()=>{
 const {service,calls}=fixture();const result=await service.request('search',{query:'Encoded'});assert.equal(result.count,2);assert.equal(result.hits[0].size,12);assert.equal(result.hits[0].folder,'');
 await service.request('pin',{keys:['cloud/','cloud/Child.txt']});assert.deepEqual(calls,[['pin','Folder/Child.txt']]);
});
test('connection checks deliver failure events without pretending the test passed',async()=>{
 const {service,runtime,events}=fixture();runtime.test=async()=>{throw new Error('Storage denied access');};await assert.rejects(service.request('test',{config:{provider:'s3',keyID:'key'}}),/denied/);assert.deepEqual(events.map(event=>event[1].checks[0].state),['running','failed']);
});
test('a failed startup preserves access to settings and a later mount attempt',async()=>{
 const {service,runtime}=fixture();runtime.start=async()=>{throw new Error('Offline');};await assert.rejects(service.start(),/Offline/);
 assert.equal((await service.request('settings')).bucketName,'bucket');runtime.mount=async()=>true;assert.equal(await service.request('mount'),true);
});
test('unfinished setup settings stay redacted and resume with the persisted secret',async()=>{
 const {service,runtime,calls}=fixture(),draft={provider:'r2',accountID:'a'.repeat(32),bucketName:'ember-drive',keyID:'draft-key',applicationKey:'preserved-secret'};
 runtime.state.snapshot=()=>({config:null,setupDraft:draft,materialized:{}});
 const settings=await service.request('settings');assert.equal(settings.keyID,'draft-key');assert.equal(settings.hasSecret,true);assert(!JSON.stringify(settings).includes('preserved-secret'));
 const pending=await service.request('setupDraft');assert(!Object.hasOwn(pending,'applicationKey'));
 await service.request('resumeSetup');assert.equal(calls[0][1].applicationKey,'preserved-secret');
 await service.request('save',{config:{...settings,applicationKey:''}});assert.equal(calls[1][1].applicationKey,'preserved-secret');
});
test('recovery discovery and user checks use separate commands without exposing credential state',async()=>{
 const {service,runtime}=fixture();const calls=[];runtime.recoveryEntries=()=>({entries:[{id:'one',local:'file.txt',type:'upload',started:1}],count:1});runtime.recover=async id=>{calls.push(id);return {resolved:false,reason:'remote-content-differs'};};assert.equal((await service.request('recover',{list:true})).count,1);assert.deepEqual(calls,[]);assert.deepEqual(await service.request('recover',{id:'one'}),{resolved:false,reason:'remote-content-differs'});assert.deepEqual(calls,['one']);
});

test('move recovery uses the existing allowed recovery command and never falls through to upload recovery',async()=>{
 const {service,runtime}=fixture(),calls=[];runtime.recoverMove=async id=>{calls.push(['move',id]);return {resolved:false,reason:'move-source-still-present'};};runtime.recover=async()=>{throw Error('Wrong recovery type');};assert.equal((await service.request('recover',{kind:'move',id:'held-move'})).resolved,false);assert.deepEqual(calls,[['move','held-move']]);
});
test('finishing a held move requires an explicit boolean request',async()=>{
 const {service,runtime}=fixture(),calls=[];runtime.recoverMove=async(id,options)=>{calls.push(options.finish);return {resolved:true};};
 for(const finish of [undefined,'true',false,true])await service.request('recover',{kind:'move',id:'held',finish});assert.deepEqual(calls,[false,false,false,true]);
});
test('pinned recovery routes to the pinned verifier rather than replaying uploads',async()=>{
 const {service,runtime}=fixture(),calls=[];runtime.recoverPinned=async id=>{calls.push(id);return {resolved:true,originalPreserved:true};};runtime.recover=async()=>{throw Error('Wrong recovery type');};
 assert.deepEqual(await service.request('recover',{kind:'pinned',id:'pinned-update'}),{resolved:true,originalPreserved:true});assert.deepEqual(calls,['pinned-update']);
});

test('pinned finishing requires an explicit boolean and saved-copy reveals use verified server paths',async()=>{
 const {service,runtime}=fixture(),calls=[];runtime.recoverPinned=async(id,options)=>{calls.push(['finish',options.finish]);return {resolved:true};};
 for(const finish of [undefined,false,'true',true])await service.request('recover',{kind:'pinned',id:'held',finish});assert.deepEqual(calls,[['finish',false],['finish',false],['finish',false],['finish',true]]);
 runtime.savedPinnedCopies=async()=>[{name:'original',file:'/verified/previous'},{name:'local-1',file:'/verified/preserved'}];service.shell.showItemInFolder=file=>calls.push(['reveal',file]);
 await assert.rejects(service.request('recover',{kind:'pinned-copy',id:'saved'}),/Reveal saved copies/);assert.deepEqual(await service.request('recover',{kind:'pinned-copy',id:'saved',revealCopies:true,file:'/untrusted'}),{revealed:true});assert.deepEqual(calls.at(-1),['reveal','/verified/preserved']);
 runtime.savedPinnedCopies=async()=>{throw Error('Changed saved proof');};await assert.rejects(service.request('recover',{kind:'pinned-copy',id:'saved',revealCopies:true}),/Changed saved proof/);assert.equal(calls.filter(call=>call[0]==='reveal').length,1);
});
test('revealing pinned recovery copies uses verified journal paths and never accepts a renderer path',async()=>{
 const {service,runtime,calls}=fixture();runtime.pinnedRecoveryCopies=async id=>{assert.equal(id,'held');return [{name:'downloaded',file:'/verified/content'},{name:'original',file:'/verified/previous'}];};
 assert.deepEqual(await service.request('recover',{kind:'pinned',id:'held',revealCopies:true,file:'/untrusted'}),{revealed:true});assert.deepEqual(calls,[['reveal','/verified/previous']]);
 runtime.pinnedRecoveryCopies=async()=>{throw Error('Proof changed');};await assert.rejects(service.request('recover',{kind:'pinned',id:'held',revealCopies:true}),/Proof changed/);assert.equal(calls.length,1);
});
