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
