const crypto=require('node:crypto');
const BUCKET='ember-drive';const validId=value=>typeof value==='string'&&/^[a-f0-9]{32}$/i.test(value);
async function api(cloudflare,method,route,body){
  const answer=await cloudflare(method,route,body);
  if(!answer||answer.success===false||!Object.hasOwn(answer,'result'))throw new Error(answer?.errors?.[0]?.message||'Cloudflare did not confirm the request.');return answer;
}
async function cloudflareAccounts(cloudflare){
  const accounts=[],seen=new Set();
  for(let page=1;page<=100;page++){
    const answer=await api(cloudflare,'GET',`/accounts?per_page=50&page=${page}`);if(!Array.isArray(answer.result))throw new Error('Cloudflare returned an invalid account list.');
    for(const account of answer.result){if(!validId(account?.id)||seen.has(account.id))throw new Error('Cloudflare returned an invalid or repeated account.');seen.add(account.id);accounts.push({id:account.id,name:typeof account.name==='string'?account.name.slice(0,200):account.id});}
    const pages=answer.result_info?.total_pages;
    if(Number.isSafeInteger(pages)&&pages>0?page>=pages:answer.result.length<50)return accounts;
  }
  throw new Error('Cloudflare account pagination exceeded its limit.');
}
async function setUpCloudflare({backend,cloudflare,onStep=()=>{},accountID=null,dryRun=false}){
  onStep('Finding your Cloudflare account…');const accounts=await cloudflareAccounts(cloudflare);
  if(!accounts.length)throw new Error('This Cloudflare login has no accounts.');
  const account=accountID?accounts.find(candidate=>candidate.id===accountID):accounts.length===1?accounts[0]:null;
  if(!account)throw new Error(accountID?'The selected Cloudflare account is unavailable.':'Choose the Cloudflare account for this drive.');
  const storage={provider:'r2',accountID:account.id,bucketName:BUCKET};
  await backend.request('assertStorage',{config:storage});
  const draft=await backend.request('setupDraft'),saved=await backend.request('settings');
  const matches=config=>config?.provider==='r2'&&config.accountID===account.id&&config.bucketName===BUCKET;
  async function finish(){
    onStep(dryRun?'Checking the saved storage key…':'Connecting Ember Drive…');
    await backend.request(dryRun?'testSetup':'resumeSetup',{},300000);
    return {bucket:BUCKET,account:account.name,accountID:account.id,...(dryRun?{tested:true}:{})};
  }
  if(draft){if(!matches(draft))throw new Error('Another account has an unfinished storage setup. Its key was preserved; finish it or forget the settings first.');return finish();}
  if(matches(saved)&&saved.hasSecret){
    onStep('Reconnecting your existing drive…');
    await backend.request(dryRun?'test':'mount',dryRun?{config:saved}:{},300000);return {bucket:BUCKET,account:account.name,accountID:account.id,...(dryRun?{tested:true}:{})};
  }
  onStep('Checking storage permissions…');const groups=(await api(cloudflare,'GET',`/accounts/${account.id}/tokens/permission_groups`)).result;
  if(!Array.isArray(groups))throw new Error('Cloudflare returned an invalid permission list.');
  const names=['Workers R2 Storage Bucket Item Read','Workers R2 Storage Bucket Item Write'];
  const wanted=names.map(name=>groups.find(group=>group.name===name&&group.is_selectable!==false&&validId(group.id)));
  if(wanted.some(group=>!group))throw new Error('Cloudflare did not offer R2 storage keys for this account.');
  onStep('Making storage for your drive…');const listing=(await api(cloudflare,'GET',`/accounts/${account.id}/r2/buckets`)).result;
  if(!Array.isArray(listing?.buckets))throw new Error('Cloudflare returned an invalid bucket list.');
  if(!listing.buckets.some(bucket=>bucket.name===BUCKET)){
    const created=(await api(cloudflare,'POST',`/accounts/${account.id}/r2/buckets`,{name:BUCKET})).result;
    if(created?.name!==BUCKET)throw new Error('Cloudflare did not confirm the new bucket. Check its outcome before trying again.');
  }
  onStep('Making a key for that storage…');
  const token=(await api(cloudflare,'POST',`/accounts/${account.id}/tokens`,{name:'ember-drive',policies:[{effect:'allow',resources:{[`com.cloudflare.edge.r2.bucket.${account.id}_default_${BUCKET}`]:'*'},permission_groups:wanted.map(({id,name})=>({id,name}))}]})).result;
  if(!validId(token?.id)||typeof token.value!=='string'||!token.value||token.value.length>4096)throw new Error('Cloudflare did not return the storage key. Check the token outcome before trying again.');
  const config={...storage,keyID:token.id,applicationKey:crypto.createHash('sha256').update(token.value).digest('hex')};
  // Keep the one-time key before connection testing. A failed test/restart can
  // resume with that key instead of creating another token or losing the secret.
  try{await backend.request('setupDraft',{config});}
  catch(error){
    let removed=false;try{await api(cloudflare,'DELETE',`/accounts/${account.id}/tokens/${token.id}`);removed=true;}catch{}
    throw new Error(removed?'The new key was removed because encrypted settings could not be saved.':`Encrypted settings could not be saved. Check Cloudflare token ${token.id} before retrying.`,{cause:error});
  }
  return finish();
}
module.exports={cloudflareAccounts,setUpCloudflare};
