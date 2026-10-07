const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');
const {cloudflareAccounts,setUpCloudflare}=require('../src/windows-drive-cloudflare');
const A='a'.repeat(32),B='b'.repeat(32),T='c'.repeat(32);
function fixture(){
 const calls=[],commands=[],steps=[],saved={},state={draft:null},accounts=[{id:A,name:'Account A'},{id:B,name:'Account B'}];
 const cloudflare=async(method,route,body)=>{
  calls.push({method,route,body});let result;
  if(route.startsWith('/accounts?'))result=accounts;
  else if(route.endsWith('/permission_groups'))result=[{id:'d'.repeat(32),name:'Workers R2 Storage Bucket Item Read'},{id:'e'.repeat(32),name:'Workers R2 Storage Bucket Item Write'}];
  else if(route.endsWith('/r2/buckets'))result=method==='GET'?{buckets:[]}:{name:'ember-drive'};
  else if(route.endsWith('/tokens'))result={id:T,value:'one-time-storage-secret'};
  else if(method==='DELETE')result={id:T};else throw new Error('Unexpected Cloudflare route');
  return {success:true,result};
 };
 const backend={request:async(command,args={})=>{
  commands.push({command,args});
  if(command==='setupDraft'){if(args.config){state.draft=args.config;return true;}if(!state.draft)return null;const {applicationKey,...publicDraft}=state.draft;return publicDraft;}
  if(command==='settings')return saved;
  if(command==='resumeSetup'){assert(state.draft);Object.assign(saved,state.draft,{applicationKey:'',hasSecret:true});state.draft=null;return true;}
  return true;
 }};
 return {cloudflare,backend,calls,commands,steps,state,saved,accounts,onStep:step=>steps.push(step)};
}
test('multiple Cloudflare accounts require an exact selection before resource writes',async()=>{
 const f=fixture();await assert.rejects(setUpCloudflare(f),/Choose the Cloudflare account/);assert.equal(f.calls.length,1);assert.equal(f.commands.length,0);
 await assert.rejects(setUpCloudflare({...f,accountID:'f'.repeat(32)}),/unavailable/);assert(f.calls.every(call=>call.method==='GET'));
});
test('selected-account provisioning scopes the key and persists it before connection testing',async()=>{
 const f=fixture(),result=await setUpCloudflare({...f,accountID:B});assert.equal(result.accountID,B);assert.equal(result.account,'Account B');
 assert(f.calls.slice(1).every(call=>call.route.startsWith('/accounts/'+B+'/')));
 const token=f.calls.find(call=>call.method==='POST'&&call.route.endsWith('/tokens'));assert.deepEqual(token.body.policies[0].resources,{[`com.cloudflare.edge.r2.bucket.${B}_default_ember-drive`]:'*'});
 const draft=f.commands.find(call=>call.command==='setupDraft'&&call.args.config);assert.equal(draft.args.config.applicationKey,crypto.createHash('sha256').update('one-time-storage-secret').digest('hex'));
 assert(f.commands.indexOf(draft)<f.commands.findIndex(call=>call.command==='resumeSetup'));assert.equal(f.state.draft,null);assert(!JSON.stringify(result).includes('secret'));assert(!JSON.stringify(f.steps).includes('secret'));
});
test('a failed connection resumes the saved key instead of creating another token',async()=>{
 const f=fixture(),request=f.backend.request;let fail=true;f.backend.request=async(command,args)=>{if(command==='resumeSetup'&&fail)throw new Error('Connection test failed');return request(command,args);};
 await assert.rejects(setUpCloudflare({...f,accountID:A}),/Connection test failed/);assert(f.state.draft);fail=false;
 const result=await setUpCloudflare({...f,accountID:A});assert.equal(result.accountID,A);assert.equal(f.calls.filter(call=>call.method==='POST'&&call.route.endsWith('/tokens')).length,1);
});
test('storage binding refusal happens before any Cloudflare resource write',async()=>{
 const f=fixture();f.backend.request=async()=>{throw new Error('Separate Drive root required');};await assert.rejects(setUpCloudflare({...f,accountID:A}),/Separate Drive root/);assert.deepEqual(f.calls.map(call=>call.method),['GET']);
});
test('uncertain token creation is attempted once and is not automatically replayed',async()=>{
 const f=fixture(),api=f.cloudflare;let writes=0;f.cloudflare=async(method,route,body)=>{if(method==='POST'&&route.endsWith('/tokens')){writes++;throw new Error('Connection lost after token write');}return api(method,route,body);};
 await assert.rejects(setUpCloudflare({...f,accountID:A}),/Connection lost/);assert.equal(writes,1);assert.equal(f.state.draft,null);
});
test('a dry connection check preserves its encrypted setup draft without mounting',async()=>{
 const f=fixture(),result=await setUpCloudflare({...f,accountID:A,dryRun:true});assert(result.tested);assert(f.state.draft);assert(f.commands.some(call=>call.command==='testSetup'));assert(!f.commands.some(call=>call.command==='resumeSetup'));
});
test('an existing configured drive is reused and another account draft is preserved',async()=>{
 const f=fixture();Object.assign(f.saved,{provider:'r2',accountID:A,bucketName:'ember-drive',hasSecret:true});await setUpCloudflare({...f,accountID:A});assert(f.commands.some(call=>call.command==='mount'));assert(f.calls.every(call=>call.method==='GET'));
 f.state.draft={provider:'r2',accountID:B,bucketName:'ember-drive',applicationKey:'preserved',keyID:T};await assert.rejects(setUpCloudflare({...f,accountID:A}),/unfinished storage setup/);assert.equal(f.state.draft.applicationKey,'preserved');assert(f.calls.every(call=>call.method==='GET'));
});
test('an unpersisted newly issued key is revoked once and an uncertain cleanup is reported',async()=>{
 const f=fixture(),request=f.backend.request;f.backend.request=async(command,args)=>{if(command==='setupDraft'&&args?.config)throw new Error('Encryption unavailable');return request(command,args);};
 await assert.rejects(setUpCloudflare({...f,accountID:A}),/key was removed/);assert.equal(f.calls.filter(call=>call.method==='DELETE').length,1);
 const g=fixture(),api=g.cloudflare;g.backend.request=f.backend.request;g.cloudflare=async(method,route,body)=>{if(method==='DELETE')throw new Error('Cleanup outcome uncertain');return api(method,route,body);};await assert.rejects(setUpCloudflare({...g,accountID:A}),new RegExp('Check Cloudflare token '+T));
});
test('account pagination enumerates all selectable accounts and rejects repeated pages',async()=>{
 let pages=0;const api=async()=>({success:true,result:[{id:++pages===1?A:B,name:'Account'}],result_info:{total_pages:2}});assert.equal((await cloudflareAccounts(api)).length,2);assert.equal(pages,2);
 await assert.rejects(cloudflareAccounts(async()=>({success:true,result:[{id:A}],result_info:{total_pages:2}})),/repeated/);
});
