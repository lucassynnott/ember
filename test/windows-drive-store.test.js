const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {WindowsDriveStore,storageConfig,TRASH}=require('../src/windows-drive-store');
const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
test('R2 trash purge skips unsupported versioning and deletes only expired confirmed revisions',async()=>{
  const config=await storageConfig({provider:'r2',accountID:'a'.repeat(32),keyID:'fixture-key',applicationKey:'fixture-secret',bucketName:'fixture-bucket'});
  assert.equal(config.provider,'r2');
  const store=new WindowsDriveStore(config),requests=[],old=TRASH+'20200101/fixture/old.txt',fresh=TRASH+'20990101/fixture/new.txt';
  store.client.destroy();store.client={destroy(){},async send(command){
    requests.push(command);
    if(command.constructor.name==='ListObjectsV2Command')return {Contents:[{Key:old,ETag:'"confirmed"'},{Key:fresh,ETag:'"fresh"'}]};
    if(command.constructor.name==='DeleteObjectCommand')return {};
    throw new Error('Unsupported R2 operation: '+command.constructor.name);
  }};
  try{assert.equal(await store.purgeTrash(7),1);assert.deepEqual(requests.map(command=>command.constructor.name),['ListObjectsV2Command','DeleteObjectCommand']);assert.equal(requests[1].input.Key,old);assert.equal(requests[1].input.IfMatch,'"confirmed"');}
  finally{store.close();}
});
test('a versioning access failure stops non-R2 purge before enumeration or deletion',async()=>{
  const store=new WindowsDriveStore({provider:'custom',endpoint:'http://127.0.0.1:1',region:'us-east-1',bucket:'fixture',credentials:{accessKeyId:'fixture',secretAccessKey:'fixture'}}),requests=[];
  store.client.destroy();store.client={destroy(){},async send(command){requests.push(command.constructor.name);throw Object.assign(new Error('AccessDenied'),{$metadata:{httpStatusCode:403}});}};
  try{await assert.rejects(store.purgeTrash(7),/AccessDenied/);assert.deepEqual(requests,['GetBucketVersioningCommand']);}
  finally{store.close();}
});
async function fixture(){
  const objects=new Map(),requests=[];let lifecycle='',failCopy=false,ignoreRange=false,changeAfterCopy=false;
  const server=http.createServer(async(request,response)=>{
    try {
      const url=new URL(request.url,'http://localhost');
      const name=decodeURIComponent(url.pathname).replace(/^\/fixture-bucket\/?/,'');
      requests.push({method:request.method,name,range:request.headers.range,version:url.searchParams.get('versionId'),condition:request.headers['if-match'],absent:request.headers['if-none-match'],copyCondition:request.headers['x-amz-copy-source-if-match']});
      assert.match(request.headers.authorization||'',/^AWS4-HMAC-SHA256 Credential=fixture-key\//);
      const fail=(code,message)=>{response.writeHead(code,{'Content-Type':'application/xml'});response.end(`<Error><Code>${message}</Code><Message>fixture error</Message></Error>`);};
      if(name==='forbidden')return fail(403,'AccessDenied');
      if(url.searchParams.has('lifecycle')){
        if(request.method==='GET'){response.writeHead(200,{'Content-Type':'application/xml'});return response.end('<LifecycleConfiguration><Rule><ID>customer-policy</ID><Status>Enabled</Status><Filter><Prefix>customer/</Prefix></Filter><Expiration><Days>90</Days></Expiration></Rule></LifecycleConfiguration>');}
        const chunks=[];for await(const chunk of request)chunks.push(chunk);lifecycle=Buffer.concat(chunks).toString();response.writeHead(200);return response.end();
      }
      if(url.searchParams.get('list-type')==='2'){
        const prefix=url.searchParams.get('prefix')||'',delimiter=url.searchParams.get('delimiter');
        const entries=[],folders=new Set();
        for(const [key,value]of [...objects].sort(([a],[b])=>a.localeCompare(b))){
          if(!key.startsWith(prefix))continue;
          const rest=key.slice(prefix.length),slash=delimiter?rest.indexOf('/'): -1;
          if(slash>=0)folders.add(prefix+rest.slice(0,slash+1));
          else entries.push(`<Contents><Key>${xml(key)}</Key><Size>${value.data.length}</Size><LastModified>2026-10-06T10:00:00Z</LastModified><ETag>${xml(value.etag)}</ETag></Contents>`);
        }
        for(const folder of folders)entries.push(`<CommonPrefixes><Prefix>${xml(folder)}</Prefix></CommonPrefixes>`);
        const index=Number(url.searchParams.get('continuation-token')||0),more=index+1<entries.length;
        response.writeHead(200,{'Content-Type':'application/xml'});return response.end(`<ListBucketResult><IsTruncated>${more}</IsTruncated>${more?`<NextContinuationToken>${index+1}</NextContinuationToken>`:''}${entries[index]||''}</ListBucketResult>`);
      }
      if(request.method==='PUT'){
        if(request.headers['if-match']&&request.headers['if-match']!==objects.get(name)?.etag)return fail(412,'PreconditionFailed');
        if(request.headers['if-none-match']==='*'&&objects.has(name))return fail(412,'PreconditionFailed');
        const source=request.headers['x-amz-copy-source'];
        if(source){
          if(failCopy)return fail(503,'ServiceUnavailable');
          const sourceKey=decodeURIComponent(source.split('?')[0]).replace(/^\/?fixture-bucket\//,'');
          const object=objects.get(sourceKey);if(!object)return fail(404,'NoSuchKey');
          if(request.headers['x-amz-copy-source-if-match']&&request.headers['x-amz-copy-source-if-match']!==object.etag)return fail(412,'PreconditionFailed');
          objects.set(name,{...object,data:Buffer.from(object.data)});if(changeAfterCopy)objects.set(sourceKey,{data:Buffer.from('Remote edit'),etag:'"changed-etag"'});response.writeHead(200,{'Content-Type':'application/xml'});return response.end(`<CopyObjectResult><ETag>${xml(object.etag)}</ETag><LastModified>2026-10-06T10:00:00Z</LastModified></CopyObjectResult>`);
        }
        const chunks=[];for await(const chunk of request)chunks.push(chunk);
        const data=Buffer.concat(chunks);objects.set(name,{data,etag:'"fixture-etag"'});response.writeHead(200,{ETag:'"fixture-etag"'});return response.end();
      }
      const object=objects.get(name);if(!object)return fail(404,'NoSuchKey');
      if(request.method==='DELETE'){
        if(request.headers['if-match']&&request.headers['if-match']!==object.etag)return fail(412,'PreconditionFailed');
        objects.delete(name);response.writeHead(204);return response.end();
      }
      if(request.method==='HEAD'){response.writeHead(200,{'Content-Length':object.data.length,ETag:object.etag,'Last-Modified':'Tue, 06 Oct 2026 10:00:00 GMT','x-amz-version-id':'fixture-version'});return response.end();}
      if(request.headers['if-match']&&request.headers['if-match']!==object.etag)return fail(412,'PreconditionFailed');
      const range=ignoreRange?null:/bytes=(\d+)-(\d+)/.exec(request.headers.range||'');
      const data=range?object.data.subarray(Number(range[1]),Number(range[2])+1):object.data;
      response.writeHead(range?206:200,{'Content-Length':data.length,ETag:object.etag,...(range?{'Content-Range':`bytes ${range[1]}-${Number(range[1])+data.length-1}/${object.data.length}`}:{})});response.end(data);
    }catch(error){response.writeHead(500);response.end(error.message);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const store=await WindowsDriveStore.create({provider:'custom',endpoint:`http://127.0.0.1:${server.address().port}`,keyID:'fixture-key',applicationKey:'fixture-secret',bucketName:'fixture-bucket'});
  return {store,objects,requests,get lifecycle(){return lifecycle;},set failCopy(value){failCopy=value;},set ignoreRange(value){ignoreRange=value;},set changeAfterCopy(value){changeAfterCopy=value;},close:async()=>{store.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
test('Windows Drive executes signed S3 upload, paginated listing, range reads, copy, trash and sharing',async()=>{
  const service=await fixture(),root=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drive-store-'));
  try {
    const file=path.join(root,'notes.txt');await fs.writeFile(file,'Café budget review');
    await service.store.upload(file,'Notes/Café & budget.txt');
    await service.store.putEmpty('Notes/empty/.ghost-keep');
    assert.equal((await service.store.list(''))[0].name,'Notes/');
    const files=await service.store.listAll('Notes/');assert.equal(files.length,2);assert.ok(files.some(item=>item.name==='Notes/empty/.ghost-keep'));assert.equal(files[0].size,19);
    const stat=await service.store.stat(files[0].name);assert.equal(stat.fileID,'fixture-version');
    assert.equal((await service.store.read(stat.name,6,6,stat.fileID)).toString(),'budget');
    assert.equal(service.requests.at(-1).version,'fixture-version');
    await service.store.copy(stat,'Notes/renamed.txt');assert.equal(service.objects.get('Notes/renamed.txt').data.toString(),'Café budget review');
    const link=new URL(await service.store.shareURL(stat.name,60));assert.equal(link.searchParams.get('X-Amz-Expires'),'60');assert.ok(link.searchParams.has('X-Amz-Signature'));assert.equal(decodeURIComponent(link.pathname),'/fixture-bucket/Notes/Café & budget.txt');
    const trash=await service.store.hide(stat.name);assert.ok(trash.startsWith(TRASH));assert.equal(await service.store.stat(stat.name),null);assert.equal(service.objects.get(trash).data.toString(),'Café budget review');assert.equal(service.requests.findLast(item=>item.method==='DELETE').condition,'"fixture-etag"');
    assert.equal((await service.store.listAll('')).some(item=>item.name.startsWith(TRASH)),false);
    await service.store.configureTrashLifecycle(7);assert.match(service.lifecycle,/<ID>customer-policy<\/ID>/);assert.match(service.lifecycle,/<ID>ember-trash<\/ID>/);
    await assert.rejects(service.store.stat('forbidden'),error=>error.$metadata?.httpStatusCode===403);
    await assert.rejects(service.store.read('Notes/renamed.txt',-1,1),/Invalid/);
  }finally{await service.close();await fs.rm(root,{recursive:true,force:true});}
});
test('failed trash copy preserves the original and does not send deletion',async()=>{
  const service=await fixture();
  try{
    await service.store.putEmpty('original.txt');service.failCopy=true;
    await assert.rejects(service.store.hide('original.txt'),/fixture error/);
    assert.ok(service.objects.has('original.txt'));assert.equal(service.requests.some(item=>item.method==='DELETE'),false);
  }finally{await service.close();}
});
test('B2 discovery enforces the selected bucket and validates the returned credential endpoint',async()=>{
  const config={provider:'b2',keyID:'fixture-key',applicationKey:'fixture-secret',bucketName:'selected'};
  const response=data=>async()=>({ok:true,json:async()=>({apiInfo:{storageApi:data}})});
  await assert.rejects(storageConfig(config,{fetchImpl:response({s3ApiUrl:'https://attacker.test',allowed:{buckets:[]}})}),/invalid storage endpoint/);
  await assert.rejects(storageConfig(config,{fetchImpl:response({s3ApiUrl:'https://s3.eu-central-003.backblazeb2.com',allowed:{buckets:[{id:'other',name:'other'}]}})}),/selected bucket/);
  const selected=await storageConfig(config,{fetchImpl:response({s3ApiUrl:'https://s3.eu-central-003.backblazeb2.com',allowed:{buckets:[{id:'selected-id',name:'selected'}]}})});
  assert.equal(selected.bucket,'selected');assert.equal(selected.region,'eu-central-003');
});
test('ignored ranges are rejected and remote edits are preserved during trash deletion',async()=>{
  const service=await fixture(),root=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drive-races-'));
  try{
    const file=path.join(root,'text');await fs.writeFile(file,'Original content');await service.store.upload(file,'original.txt');
    service.ignoreRange=true;
    await assert.rejects(service.store.read('original.txt',1,30),/did not honor/);
    service.changeAfterCopy=true;
    await assert.rejects(service.store.hide('original.txt'),error=>error.$metadata?.httpStatusCode===412);
    assert.equal(service.objects.get('original.txt').data.toString(),'Remote edit');
    service.ignoreRange=false;
    await assert.rejects(service.store.read('original.txt',0,6,null,undefined,'"fixture-etag"'),error=>error.$metadata?.httpStatusCode===412);
    assert.equal([...service.objects.entries()].find(([name])=>name.startsWith(TRASH))[1].data.toString(),'Original content');
  }finally{await service.close();await fs.rm(root,{recursive:true,force:true});}
});
test('versioned trash purge enumerates revisions and markers before permanent deletion',async()=>{
  const old=TRASH+'20200101/fixture/file.txt',fresh=TRASH+'20990101/fixture/file.txt',requests=[];
  const server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://localhost');requests.push({method:req.method,key:decodeURIComponent(u.pathname).slice('/fixture-bucket/'.length),version:u.searchParams.get('versionId')});
    res.setHeader('Content-Type','application/xml');
    if(u.searchParams.has('versioning'))return res.end('<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>');
    if(u.searchParams.has('versions')){
      if(!u.searchParams.has('key-marker'))return res.end(`<ListVersionsResult><IsTruncated>true</IsTruncated><NextKeyMarker>${xml(old)}</NextKeyMarker><NextVersionIdMarker>v1</NextVersionIdMarker><Version><Key>${xml(old)}</Key><VersionId>v1</VersionId></Version></ListVersionsResult>`);
      assert.equal(u.searchParams.get('version-id-marker'),'v1');
      return res.end(`<ListVersionsResult><IsTruncated>false</IsTruncated><Version><Key>${xml(old)}</Key><VersionId>null</VersionId></Version><DeleteMarker><Key>${xml(old)}</Key><VersionId>deleted-v2</VersionId></DeleteMarker><Version><Key>${xml(fresh)}</Key><VersionId>future</VersionId></Version></ListVersionsResult>`);
    }
    if(req.method==='DELETE'){res.statusCode=204;return res.end();}
    res.statusCode=500;res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const store=await WindowsDriveStore.create({provider:'custom',endpoint:`http://127.0.0.1:${server.address().port}`,keyID:'fixture-key',applicationKey:'fixture-secret',bucketName:'fixture-bucket'});
  try {
    assert.equal(await store.purgeTrash(7),3);
    const deletes=requests.filter(r=>r.method==='DELETE');assert.deepEqual(deletes.map(r=>r.version),['v1','null','deleted-v2']);assert.ok(deletes.every(r=>r.key===old));
    assert.ok(requests.slice(0,3).every(r=>r.method==='GET'));
  }finally{store.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('trash purge refuses incomplete version enumeration before deleting any revision',async()=>{
  const requests=[],old=TRASH+'20200101/fixture/file.txt';
  const server=http.createServer((req,res)=>{
    const u=new URL(req.url,'http://localhost');requests.push(req.method);res.setHeader('Content-Type','application/xml');
    if(u.searchParams.has('versioning'))return res.end('<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>');
    res.end(`<ListVersionsResult><IsTruncated>true</IsTruncated><Version><Key>${xml(old)}</Key><VersionId>old</VersionId></Version></ListVersionsResult>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const store=await WindowsDriveStore.create({provider:'custom',endpoint:`http://127.0.0.1:${server.address().port}`,keyID:'fixture-key',applicationKey:'fixture-secret',bucketName:'fixture-bucket'});
  try{await assert.rejects(store.purgeTrash(7),/incomplete trash version pagination/);assert.deepEqual(requests,['GET','GET']);}
  finally{store.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test('conditional uploads preserve remotely changed and already-existing objects',async()=>{
 const service=await fixture(),root=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drive-conditional-'));
 try{
   const file=path.join(root,'file');await fs.writeFile(file,'Local draft');
   await service.store.upload(file,'new.txt',{ifNoneMatch:'*'});assert.equal(service.requests.at(-1).absent,'*');
   service.objects.set('new.txt',{data:Buffer.from('Remote revision'),etag:'"remote-revision"'});
   await assert.rejects(service.store.upload(file,'new.txt',{ifNoneMatch:'*'}),e=>e.$metadata?.httpStatusCode===412);
   await assert.rejects(service.store.upload(file,'new.txt',{ifMatch:'"stale-revision"'}),e=>e.$metadata?.httpStatusCode===412);
   assert.equal(service.objects.get('new.txt').data.toString(),'Remote revision');
   await service.store.upload(file,'new.txt',{ifMatch:'"remote-revision"'});assert.equal(service.objects.get('new.txt').data.toString(),'Local draft');
 }finally{await service.close();await fs.rm(root,{recursive:true,force:true});}
});
test('empty-folder markers use signed conditional writes and preserve existing content',async()=>{
 const service=await fixture();try{
  const marker='Empty/.ghost-keep';await service.store.putEmpty(marker,undefined,{ifNoneMatch:'*'});assert.equal(service.requests.find(request=>request.method==='PUT').absent,'*');assert.equal(service.objects.get(marker).data.length,0);
  service.objects.set(marker,{data:Buffer.from('Existing marker content'),etag:'"existing"'});await assert.rejects(service.store.putEmpty(marker,undefined,{ifNoneMatch:'*'}),/Precondition|412/);assert.equal(service.objects.get(marker).data.toString(),'Existing marker content');
 }finally{await service.close();}
});

test('signed conditional copy preserves occupied destinations and changed sources without deletion',async()=>{
  const service=await fixture();
  try {
    service.objects.set('source.txt',{data:Buffer.from('Original revision'),etag:'"source-revision"'});
    service.objects.set('occupied.txt',{data:Buffer.from('Destination contents'),etag:'"destination-revision"'});
    const source=await service.store.stat('source.txt');
    await assert.rejects(service.store.copy(source,'occupied.txt'),error=>error.$metadata?.httpStatusCode===412);
    assert.equal(service.objects.get('occupied.txt').data.toString(),'Destination contents');
    assert.equal(service.objects.get('source.txt').data.toString(),'Original revision');
    assert.equal(service.requests.at(-1).absent,'*');assert.equal(service.requests.at(-1).copyCondition,'"source-revision"');
    service.objects.set('source.txt',{data:Buffer.from('Concurrent source edit'),etag:'"changed-revision"'});
    await assert.rejects(service.store.copy(source,'new.txt'),error=>error.$metadata?.httpStatusCode===412);
    assert.equal(service.objects.has('new.txt'),false);assert.equal(service.objects.get('source.txt').data.toString(),'Concurrent source edit');
    assert.equal(service.requests.some(request=>request.method==='DELETE'),false);
    const count=service.requests.length;
    await assert.rejects(service.store.copy({name:'source.txt'},'new.txt'),/source revision/);
    await assert.rejects(service.store.copy(source,'source.txt'),/different destination/);
    assert.equal(service.requests.length,count);
    await service.store.copy(await service.store.stat('source.txt'),'new.txt');
    assert.equal(service.objects.get('new.txt').data.toString(),'Concurrent source edit');
  }finally{await service.close();}
});

test('trash keeps its original when copied content has no matching destination proof',async()=>{
  const service=await fixture();
  try {
    service.objects.set('original.txt',{data:Buffer.from('Keep these bytes'),etag:'"original-revision"'});
    const copy=service.store.copy.bind(service.store);
    service.store.copy=async(...args)=>{const result=await copy(...args);service.objects.set(args[1],{data:Buffer.from('Concurrent destination edit'),etag:'"changed-trash"'});return result;};
    await assert.rejects(service.store.hide('original.txt'),/trash copy was not confirmed/);
    assert.equal(service.objects.get('original.txt').data.toString(),'Keep these bytes');
    assert.equal(service.requests.some(request=>request.method==='DELETE'),false);
    service.store.copy=async(...args)=>{await copy(...args);return {};};
    await assert.rejects(service.store.hide('original.txt'),/did not identify the trash copy/);
    assert.equal(service.objects.get('original.txt').data.toString(),'Keep these bytes');
    assert.equal(service.requests.some(request=>request.method==='DELETE'),false);
  }finally{await service.close();}
});
