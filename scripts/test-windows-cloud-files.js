const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {WindowsDriveCache}=require('../src/windows-drive-cache');
const {populateInitialNamespace}=require('../src/windows-drive-namespace');
const crypto=require('node:crypto');const {WindowsCloudFiles}=require('../src/windows-cloud-files');
async function main(){
  assert.equal(process.platform,'win32','Cloud Files acceptance requires Windows');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'ember-cloud-files-'));
  const helper=path.resolve('native/windows/bin/meeting-notes-hotkey.exe');
  let data=crypto.randomBytes(8*1024*1024+123),remoteRevision='fixture-version',remoteETag='"fixture-etag"';const reads=[];
  const identity='ember-fixture-'+crypto.randomUUID();let active,foreign;
  const store={listAll:async()=>[...['remote/Café.txt','remote/Nested/inside.txt'].map(name=>({name,kind:'file',size:data.length,modified:Date.now(),fileID:remoteRevision,etag:remoteETag})),{name:'empty/.ghost-keep',kind:'file',size:0,modified:Date.now(),etag:'"empty-marker"'}],read:async(key,offset,length,version,signal,etag)=>{
    assert.ok(['remote/Café.txt','remote/Nested/inside.txt'].includes(key));assert.equal(version,remoteRevision);assert.equal(etag,remoteETag);assert.equal(signal.aborted,false);
    reads.push({offset,length});return data.subarray(offset,offset+length);
  }};
  const connect=()=>new WindowsCloudFiles({store,helper,timeoutMs:45000});
  const deadline=setTimeout(()=>{active?.close();foreign?.close();console.error('Windows Cloud Files acceptance timed out');process.exit(1);},90000);
  try {
    active=connect();await active.register(root,identity);
    await assert.rejects(active.create('../escape.txt',{name:'remote/Café.txt',size:data.length,modified:Date.now(),fileID:remoteRevision,etag:remoteETag}),/Invalid Windows placeholder name/);
    let persistedMappings;await populateInitialNamespace(active,store,{saveMappings:async mappings=>{persistedMappings=mappings;}});
    assert.ok(persistedMappings['remote/']);
    assert.ok((await fs.stat(path.join(root,'empty'))).isDirectory());
    const local=path.join(root,'remote','Café.txt');assert.equal((await fs.stat(local)).size,data.length);assert.equal(reads.length,0,'metadata inspection must not hydrate');
    foreign=connect();await assert.rejects(foreign.register(root,'different-provider'),/another sync root/);foreign.close();foreign=null;
    await active.command('disconnect');active.close();
    active=connect();await active.register(root,identity);
    const resumed=await populateInitialNamespace(active,store,{mappings:persistedMappings});
    assert.equal(resumed.created,0);assert.equal(resumed.conflicts.length,0);assert.ok(resumed.existing>=5);
    const metadata=await active.inspect('remote/Café.txt');assert.equal(metadata.cloud,true);assert.equal(metadata.inSync,true);assert.equal(reads.length,0,'inspection and reconciliation must not hydrate');
    assert.deepEqual(await fs.readFile(local),data,'NTFS read must hydrate correct file bytes');
    assert.ok(reads.length>=2,'hydration should stream bounded chunks');assert.ok(reads.every(read=>read.length<=8*1024*1024&&read.offset%4096===0));
    assert.deepEqual(await fs.readFile(path.join(root,'remote','Nested','inside.txt')),data,'nested placeholder hydration');
    const count=reads.length;assert.deepEqual(await fs.readFile(local),data);assert.equal(reads.length,count,'hydrated file should serve from local storage');
    const pinned=await active.pin('remote/Café.txt');assert.equal(pinned.pinState,1);assert.ok(pinned.onDiskBytes>=data.length);
    await assert.rejects(active.dehydrate('remote/Café.txt'),/Pinned files/);
    const cacheEntries={};for(const name of ['remote/Café.txt','remote/Nested/inside.txt'])cacheEntries[name]=JSON.parse((await active.inspect(name)).identity);
    const cache=new WindowsDriveCache({bridge:active,state:{snapshot:()=>({materialized:cacheEntries,uploads:{},cacheLimitGB:5})}});
    const beforeCacheRead=reads.length,cacheReport=await cache.inspect();assert.ok(cacheReport.pinnedBytes>=data.length);assert.ok(cacheReport.bytes>=data.length);assert.equal(reads.length,beforeCacheRead,'cache metadata must not hydrate');
    const cacheClear=await cache.enforce({clear:true});assert.deepEqual(cacheClear.evicted,['remote/Nested/inside.txt']);assert.equal(cacheClear.bytes,0);assert.equal(cacheClear.complete,true);assert.equal((await active.inspect('remote/Nested/inside.txt')).onDiskBytes,0);assert.ok((await active.inspect('remote/Café.txt')).onDiskBytes>=data.length,'cache clearing must preserve pins');
    await active.unpin('remote/Café.txt');await active.dehydrate('remote/Café.txt');
    assert.equal((await active.inspect('remote/Café.txt')).onDiskBytes,0);
    const beforeRefetch=reads.length;assert.deepEqual(await fs.readFile(local),data);assert.ok(reads.length>beforeRefetch,'dehydrated file must re-fetch cloud bytes');
    const previous=(await active.inspect('remote/Café.txt')).identity;
    data=Buffer.from(data);data[1]^=255;remoteRevision='new-remote-version';remoteETag='"new-remote-etag"';
    await active.refresh('remote/Café.txt',{name:'remote/Café.txt',size:data.length,modified:Date.now(),fileID:remoteRevision,etag:remoteETag},previous);
    assert.equal((await active.inspect('remote/Café.txt')).onDiskBytes,0);
    assert.deepEqual(await fs.readFile(local),data,'remote refresh must hydrate the changed revision');
    cacheEntries['remote/Café.txt']=JSON.parse((await active.inspect('remote/Café.txt')).identity);
    const edited=Buffer.from(data);edited[0]^=255;await fs.writeFile(local,edited);
    await assert.rejects(active.dehydrate('remote/Café.txt'),/Local edits/);assert.deepEqual(await fs.readFile(local),edited,'eviction must preserve local edits');
    const dirtyCache=await cache.enforce({clear:true});assert.equal(dirtyCache.evicted.length,0);assert.equal(dirtyCache.complete,false);assert.deepEqual(await fs.readFile(local),edited,'cache coordinator must preserve local edits');
    const upload=await active.lockUpload('remote/Café.txt');
    try {
      await assert.rejects(fs.writeFile(local,Buffer.from('must not change while locked')));
      assert.deepEqual(await fs.readFile(local),edited,'upload lock must preserve the snapshot');
      data=edited;remoteRevision='uploaded-version';remoteETag='"uploaded-etag"';
      await active.ackUpload(upload.token,{name:'remote/Café.txt',fileID:remoteRevision,etag:remoteETag});
    }finally{await active.unlockUpload(upload.token);}
    assert.equal((await active.inspect('remote/Café.txt')).inSync,true);
    await active.dehydrate('remote/Café.txt');assert.deepEqual(await fs.readFile(local),edited,'acknowledged upload must hydrate its confirmed revision');
    const added=path.join(root,'new local.txt');await fs.writeFile(added,'New local file');
    const newUpload=await active.lockUpload('new local.txt');assert.equal(newUpload.cloud,false);
    try{await active.ackUpload(newUpload.token,{name:'uploaded/new local.txt',etag:'"new-local-revision"'});}finally{await active.unlockUpload(newUpload.token);}
    assert.equal((await active.inspect('new local.txt')).cloud,true);assert.equal((await active.inspect('new local.txt')).inSync,true);assert.equal(await fs.readFile(added,'utf8'),'New local file');
    await active.unregister();
    console.log(JSON.stringify({windowsCloudFiles:'passed',nativePlaceholder:true,metadataWithoutHydration:true,identityOwnership:true,reconnect:true,hydratedBytes:data.length,rangeRequests:reads.length,localCachedRead:true,pinVerified:true,dehydrateVerified:true,dirtyFilePreserved:true,remoteRefreshVerified:true,uploadLockVerified:true,uploadAcknowledgementVerified:true,newLocalConversionVerified:true,cacheAccountingVerified:true,cacheClearPreservesPinsAndEdits:true}));
  }finally{clearTimeout(deadline);foreign?.close();if(active&&!active.closed){try{await active.unregister();}catch{}active.close();}await fs.rm(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
