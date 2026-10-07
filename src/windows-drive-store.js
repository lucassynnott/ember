const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const {
  S3Client, ListObjectsV2Command, ListObjectVersionsCommand, GetBucketVersioningCommand, HeadObjectCommand, GetObjectCommand,
  PutObjectCommand, CopyObjectCommand, DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand, PutBucketLifecycleConfigurationCommand,
} = require('@aws-sdk/client-s3');
const {Upload} = require('@aws-sdk/lib-storage');
const {getSignedUrl} = require('@aws-sdk/s3-request-presigner');
const KEEP = '.ghost-keep', TRASH = '.ghost-trash/';
function key(value, {empty=false}={}) {
  if(typeof value !== 'string' || (!empty && !value) || Buffer.byteLength(value)>1024 || /[\u0000-\u001f]/.test(value)) throw new Error('Invalid cloud object name.');
  return value;
}
function endpoint(value) {
  const url = new URL(value);
  if(!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid storage endpoint.');
  return url.href.replace(/\/$/,'');
}
async function storageConfig(config, {fetchImpl=fetch}={}) {
  const provider=config.provider;
  if(!['b2','r2','s3','wasabi','custom'].includes(provider))throw new Error('Choose a supported storage provider.');
  for(const field of ['keyID','applicationKey','bucketName'])if(typeof config[field]!=='string'||!config[field].trim())throw new Error(`Missing storage ${field}.`);
  const bucket=config.bucketName.trim();
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,221}$/.test(bucket))throw new Error('Invalid storage bucket name.');
  let region=config.region?.trim()||'us-east-1',url;
  if(provider==='b2') {
    const response=await fetchImpl('https://api.backblazeb2.com/b2api/v4/b2_authorize_account',{headers:{Authorization:'Basic '+Buffer.from(config.keyID.trim()+':'+config.applicationKey.trim()).toString('base64')},redirect:'error',signal:AbortSignal.timeout(30000)});
    if(!response.ok)throw new Error(`Backblaze authorization failed (${response.status}).`);
    const answer=await response.json(), storage=answer.apiInfo?.storageApi;
    const s3=new URL(storage?.s3ApiUrl);
    if(s3.protocol!=='https:' || !/^s3\.[a-z0-9-]+\.backblazeb2\.com$/.test(s3.hostname) || s3.username || s3.password || s3.port || s3.pathname!=='/' || s3.search || s3.hash)throw new Error('Backblaze returned an invalid storage endpoint.');
    const allowed=storage.allowed?.buckets;
    if(Array.isArray(allowed)&&allowed.length&&!allowed.some(item=>item.name===bucket || (config.bucketID && item.id===config.bucketID)))throw new Error('The Backblaze key does not include the selected bucket.');
    url=s3.href;region=s3.hostname.split('.')[1];
  } else if(provider==='r2') {
    if(!/^[a-fA-F0-9]{32}$/.test(config.accountID||''))throw new Error('Enter the Cloudflare account ID.');
    url=`https://${config.accountID}.r2.cloudflarestorage.com`;region='auto';
  } else if(provider==='s3'||provider==='wasabi') {
    if(!/^[a-z0-9-]+$/.test(config.region||''))throw new Error('Choose a storage region.');
    url=`https://s3.${region}.${provider==='s3'?'amazonaws.com':'wasabisys.com'}`;
  } else url=config.endpoint;
  return {provider,endpoint:endpoint(url),region,bucket,credentials:{accessKeyId:config.keyID.trim(),secretAccessKey:config.applicationKey.trim()}};
}
class WindowsDriveStore {
  static async create(config,options={}) {
    return new WindowsDriveStore(await storageConfig(config,options));
  }
  constructor(config) {
    this.bucket=config.bucket;this.provider=config.provider;this.maxShareSeconds=604800;
    this.client=new S3Client({...config,requestHandler:{connectionTimeout:10000,requestTimeout:60000,socketTimeout:60000},forcePathStyle:true,maxAttempts:1,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
  }
  close(){this.client.destroy();}
  async #send(Command,input,signal){return this.client.send(new Command({Bucket:this.bucket,...input}),{abortSignal:signal});}
  async #list(prefix,recursive,{includeTrash=false,signal}={}) {
    key(prefix,{empty:true});const objects=[],seen=new Set();let token;
    do {
      const page=await this.#send(ListObjectsV2Command,{Prefix:prefix,...(!recursive?{Delimiter:'/'}:{}),MaxKeys:1000,...(token?{ContinuationToken:token}:{})},signal);
      for(const item of page.Contents||[]){
        if(!item.Key || (!recursive&&(item.Key.endsWith('/'+KEEP)||item.Key===KEEP)) || (!includeTrash&&item.Key.startsWith(TRASH)))continue;
        objects.push({name:item.Key,kind:item.Key.endsWith('/')?'folder':'file',size:item.Size||0,modified:item.LastModified?.getTime()||0,fileID:null,etag:item.ETag||null});
      }
      for(const item of page.CommonPrefixes||[])if(item.Prefix&&(includeTrash||!item.Prefix.startsWith(TRASH)))objects.push({name:item.Prefix,kind:'folder',size:0,modified:0,fileID:null});
      token=page.IsTruncated?page.NextContinuationToken:null;
      if(page.IsTruncated&&!token)throw new Error('Storage returned an incomplete directory page.');
      if(token){if(seen.has(token)||seen.size>=1000)throw new Error('Storage directory pagination exceeded its limit.');seen.add(token);}
      if(objects.length>1000000)throw new Error('Storage directory exceeds its limit.');
    }while(token);
    return objects;
  }
  list(prefix='',options={}){return this.#list(prefix,false,options);}
  listAll(prefix='',options={}){return this.#list(prefix,true,options);}
  async stat(name,signal) {
    key(name);
    try {
      const data=await this.#send(HeadObjectCommand,{Key:name},signal);
      return {name,kind:'file',size:data.ContentLength||0,modified:data.LastModified?.getTime()||0,fileID:data.VersionId||null,etag:data.ETag||null};
    }catch(error){if(error.$metadata?.httpStatusCode===404)return null;throw error;}
  }
  async read(name,offset,length,fileID=null,signal,etag=null) {
    key(name);if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<0||length>16*1024*1024||!Number.isSafeInteger(offset+length))throw new Error('Invalid storage byte range.');
    if(!length)return Buffer.alloc(0);
    const response=await this.#send(GetObjectCommand,{Key:name,Range:`bytes=${offset}-${offset+length-1}`,...(fileID?{VersionId:fileID}:{}),...(etag?{IfMatch:etag}:{})},signal);
    const parts=[];let size=0;
    try {
      const range=/^bytes (\d+)-(\d+)\/(?:\d+|\*)$/.exec(response.ContentRange||'');
      if(response.$metadata?.httpStatusCode!==206||!range||Number(range[1])!==offset||Number(range[2])>=offset+length)throw new Error('Storage did not honor the requested byte range.');
      for await(const part of response.Body){size+=part.length;if(size>length)throw new Error('Storage exceeded the requested byte range.');parts.push(Buffer.from(part));}
      if(size!==Number(range[2])-offset+1)throw new Error('Storage returned an incomplete byte range.');
      return Buffer.concat(parts,size);
    }finally{response.Body?.destroy?.();}
  }
  async upload(file,name,{mtime=null,progress=()=>{},signal,ifMatch=null,ifNoneMatch=null}={}) {
    key(name);
    if(ifMatch!=null&&(typeof ifMatch!=='string'||!ifMatch||/[\r\n]/.test(ifMatch)))throw new Error('Invalid upload revision.');
    if(ifNoneMatch!=null&&ifNoneMatch!=='*')throw new Error('Invalid new-file upload condition.');
    if(ifMatch&&ifNoneMatch)throw new Error('Choose one upload condition.');
    const stat=await fsp.stat(file);if(!stat.isFile())throw new Error('Only files can be uploaded.');
    const stream=fs.createReadStream(file);
    const upload=new Upload({client:this.client,params:{Bucket:this.bucket,Key:name,Body:stream,ContentLength:stat.size,...(ifMatch?{IfMatch:ifMatch}:{}),...(ifNoneMatch?{IfNoneMatch:ifNoneMatch}:{}),Metadata:{'ember-mtime':String(mtime??stat.mtimeMs)}},queueSize:2,partSize:8*1024*1024,leavePartsOnError:false});
    upload.on('httpUploadProgress',event=>progress(event.loaded||0));
    const abort=()=>void upload.abort();signal?.addEventListener('abort',abort,{once:true});
    try {if(signal?.aborted)throw new Error('Upload cancelled.');return await upload.done();}
    finally {signal?.removeEventListener('abort',abort);stream.destroy();}
  }
  async putEmpty(name,signal,{ifNoneMatch=null}={}){key(name);if(ifNoneMatch!==null&&ifNoneMatch!=='*')throw new Error('Invalid empty-object write condition.');return this.#send(PutObjectCommand,{Key:name,Body:Buffer.alloc(0),...(ifNoneMatch?{IfNoneMatch:ifNoneMatch}:{})},signal);}
  async copy(from,to,signal) {
    key(from.name);key(to);
    if(!from.etag)throw new Error('Storage did not identify the copy source revision; existing files were preserved.');
    if(from.name===to)throw new Error('A cloud copy requires a different destination.');
    const source=[this.bucket,...from.name.split('/')].map(encodeURIComponent).join('/')+(from.fileID?'?versionId='+encodeURIComponent(from.fileID):'');
    return this.#send(CopyObjectCommand,{Key:to,CopySource:source,CopySourceIfMatch:from.etag,IfNoneMatch:'*'},signal);
  }
  async deleteVersion(name,fileID='',{etag=null,signal}={}) {
    key(name);return this.#send(DeleteObjectCommand,{Key:name,...(fileID?{VersionId:fileID}:{}),...(etag?{IfMatch:etag}:{})},signal);
  }
  async hide(name,signal) {
    const source=await this.stat(name,signal);if(!source)return null;
    if(!source.etag)throw new Error('Storage did not identify the file revision; the original was preserved.');
    const stamp=new Date().toISOString().slice(0,10).replaceAll('-','');
    const trash=TRASH+stamp+'/'+crypto.randomUUID()+'/'+name;
    await this.copy(source,trash,signal);
    // Preserve a remotely changed original. Unsupported conditional deletes fail safely.
    await this.deleteVersion(name,'',{etag:source.etag,signal});return trash;
  }
  async shareURL(name,seconds=this.maxShareSeconds) {
    key(name);if(!Number.isInteger(seconds)||seconds<1||seconds>this.maxShareSeconds)throw new Error('Invalid share-link duration.');
    return getSignedUrl(this.client,new GetObjectCommand({Bucket:this.bucket,Key:name}),{expiresIn:seconds});
  }
  async configureTrashLifecycle(days,signal) {
    if(!Number.isInteger(days)||days<1||days>3650)throw new Error('Invalid trash retention.');
    let rules=[];
    try {rules=(await this.#send(GetBucketLifecycleConfigurationCommand,{},signal)).Rules||[];}
    catch(error){if(error.name!=='NoSuchLifecycleConfiguration')throw error;}
    const existing=rules.filter(rule=>rule.ID!=='ember-trash');
    if(existing.length>=1000)throw new Error('The bucket has no room for an Ember trash policy.');
    await this.#send(PutBucketLifecycleConfigurationCommand,{LifecycleConfiguration:{Rules:[...existing,{ID:'ember-trash',Filter:{Prefix:TRASH},Status:'Enabled',Expiration:{Days:days}}]}},signal);
  }
  async purgeTrash(days,{now=Date.now(),signal}={}) {
    if(!Number.isInteger(days)||days<1||days>3650)throw new Error('Invalid trash retention.');
    const cutoff=new Date(now-days*86400000).toISOString().slice(0,10).replaceAll('-','');let deleted=0;
    const expired=name=>{const stamp=name.slice(TRASH.length).split('/')[0];return name.startsWith(TRASH)&&/^\d{8}$/.test(stamp)&&stamp<cutoff;};
    // R2 has no object versioning and does not implement GetBucketVersioning.
    // Other providers still require an affirmative response: an access failure
    // must never become permission to permanently delete their current objects.
    const versioning=this.provider==='r2'?{}:await this.#send(GetBucketVersioningCommand,{},signal);
    if(versioning.Status==='Enabled'||versioning.Status==='Suspended') {
      const versions=[],seen=new Set();let keyMarker,versionMarker;
      do {
        const page=await this.#send(ListObjectVersionsCommand,{Prefix:TRASH,MaxKeys:1000,...(keyMarker?{KeyMarker:keyMarker}:{}),...(versionMarker?{VersionIdMarker:versionMarker}:{})},signal);
        for(const item of [...(page.Versions||[]),...(page.DeleteMarkers||[])]) {
          if(!item.Key||!expired(item.Key))continue;
          if(!item.VersionId)throw new Error('Storage did not identify a trash version; purge was stopped.');
          versions.push({name:item.Key,id:item.VersionId});
        }
        if(versions.length>1000000)throw new Error('Trash version listing exceeds its limit.');
        if(!page.IsTruncated)break;
        keyMarker=page.NextKeyMarker;versionMarker=page.NextVersionIdMarker;
        const marker=JSON.stringify([keyMarker,versionMarker]);
        if(!keyMarker||seen.has(marker)||seen.size>=1000)throw new Error('Storage returned incomplete trash version pagination.');
        seen.add(marker);
      }while(true);
      // Finish enumeration first so deletion cannot disturb provider pagination.
      for(const item of versions){await this.deleteVersion(item.name,item.id,{signal});deleted++;}
    } else {
      for(const object of await this.#list(TRASH,true,{includeTrash:true,signal})){
        if(!expired(object.name))continue;
        if(!object.etag)throw new Error('Storage did not identify a trash revision; purge was stopped.');
        await this.deleteVersion(object.name,'',{etag:object.etag,signal});deleted++;
      }
    }
    return deleted;
  }
}
module.exports={WindowsDriveStore,storageConfig,KEEP,TRASH};
