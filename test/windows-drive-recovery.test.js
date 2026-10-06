const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');
const {fingerprintFile,recoverUpload}=require('../src/windows-drive-recovery');
test('recovery proves matching local and cloud content without replaying an upload',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drive-recovery-'));const local=path.join(root,'file');const bytes=crypto.randomBytes(8*1024*1024+17);await fs.writeFile(local,bytes);const hash=await fingerprintFile(local);const calls=[];
 const entry={local:'file',key:'remote/file',size:bytes.length,hash,phase:'sending'};
 const bridge={lockUpload:async()=>({token:'lock',size:bytes.length,localPath:local,cloud:false}),ackUpload:async()=>calls.push('ack'),unlockUpload:async()=>calls.push('unlock')};
 const store={stat:async()=>({size:bytes.length,etag:'confirmed',fileID:'version'}),read:async(key,offset,length,version,signal,etag)=>{assert.equal(version,'version');assert.equal(etag,'confirmed');calls.push('read');return bytes.subarray(offset,offset+length);},upload:async()=>{throw new Error('Recovery must never write');}};
 const state={snapshot:()=>({uploads:{id:entry}}),resolveRecoveredUpload:async()=>calls.push('resolve')};
 try{const result=await recoverUpload({id:'id',bridge,store,state});assert.equal(result.resolved,true);assert.deepEqual(calls,['read','read','ack','resolve','unlock']);}
 finally{await fs.rm(root,{recursive:true,force:true});}
});
test('recovery keeps unresolved journal and local dirty state when cloud bytes differ',async()=>{
 const calls=[],hash=crypto.createHash('sha256').update('local').digest('hex');
 const entry={local:'file',key:'remote/file',size:5,hash};
 const bridge={lockUpload:async()=>({token:'lock',size:5,localPath:'fixture',cloud:false}),ackUpload:async()=>calls.push('ack'),unlockUpload:async()=>calls.push('unlock')};
 const store={stat:async()=>({size:5,etag:'other',fileID:null}),read:async()=>Buffer.from('other')};const state={snapshot:()=>({uploads:{id:entry}}),resolveRecoveredUpload:async()=>calls.push('resolve')};
 const result=await recoverUpload({id:'id',bridge,store,state,fingerprint:async()=>hash});assert.equal(result.reason,'remote-content-differs');assert.deepEqual(calls,['unlock']);
});
