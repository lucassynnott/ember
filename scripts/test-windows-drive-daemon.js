const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const {spawn,execFile}=require('node:child_process');
async function main(){
  assert.equal(process.platform,'win32');const profile=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drive-daemon-'));const electron=require('electron');let daemonPid,cloud,ownedRoot,rootIdentity,configFile;
  const configured=process.argv.includes('--configured'),remoteBytes=require('node:crypto').randomBytes(8*1024*1024+123),localBytes=Buffer.from('Uploaded after the real app process exited.');
  async function worker(role){
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(electron,[path.join(__dirname,'test-windows-drive-daemon-worker.js'),profile,role,...(configFile?[configFile]:[])],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let buffer='',diagnostics='',result;
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
      buffer+=chunk;let end;
      while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.startsWith('EMBER_DRIVE_TEST:'))continue;const message=JSON.parse(line.slice('EMBER_DRIVE_TEST:'.length));if(message.pid)daemonPid=message.pid;if(message.complete)result=message;}
    });
    child.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk.toString()).slice(-8192);});
    const timer=setTimeout(()=>{void execFile('taskkill.exe',['/PID',String(child.pid),'/T','/F']);},45000);
    try{
      const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
      assert.equal(code,0,diagnostics||`${role} worker failed`);assert(result,`${role} worker did not confirm acceptance`);return result;
    }finally{clearTimeout(timer);}
  }
  try{
    if(configured){
      // Never share or replace an existing user's Drive. The fixture owns the
      // root only after exclusive creation and retains its filesystem identity.
      const root=path.join(os.homedir(),'Ember Drive');await fs.mkdir(root);ownedRoot=root;rootIdentity=await fs.stat(root);
      cloud=await require('./windows-drive-cloud-fixture').cloudFixture({'unread remote.txt':remoteBytes});configFile=path.join(profile,'fixture-config.json');await fs.writeFile(configFile,JSON.stringify(cloud.config),{flag:'wx'});
    }
    const first=await worker('first');assert(first.dpapiIdentityVerified);assert(daemonPid>0);process.kill(daemonPid,0);
    if(configured){
      assert.equal(cloud.requests.filter(request=>request.method==='GET'&&request.range&&request.url.includes('unread')).length,0,'the remote fixture must remain unhydrated until the first app exits');
      assert.deepEqual(await fs.readFile(path.join(ownedRoot,'unread remote.txt')),remoteBytes,'the surviving native provider must hydrate exact cloud bytes after app exit');
      await fs.writeFile(path.join(ownedRoot,'background upload.txt'),localBytes,{flag:'wx'});
      const deadline=Date.now()+30000;while(Date.now()<deadline&&!cloud.objects.get('background upload.txt')?.data.equals(localBytes))await new Promise(resolve=>setTimeout(resolve,100));
      assert.deepEqual(cloud.objects.get('background upload.txt')?.data,localBytes,'the surviving provider must upload a new local file after app exit');
      const lateBytes=Buffer.from('Remote addition while Ember is closed');cloud.put('late remote.txt',lateBytes);
      const refreshDeadline=Date.now()+75000;let discovered=false;
      while(Date.now()<refreshDeadline){try{const stat=await fs.stat(path.join(ownedRoot,'late remote.txt'));if(stat.size===lateBytes.length){discovered=true;break;}}catch(error){if(error.code!=='ENOENT')throw error;}await new Promise(resolve=>setTimeout(resolve,250));}
      assert.equal(discovered,true,'the surviving provider must discover remote additions without reopening Ember');
      assert.deepEqual(await fs.readFile(path.join(ownedRoot,'late remote.txt')),lateBytes);

    }
    // The first app process has exited. A second real Electron app must attach
    // to the existing provider and decrypt the same profile identity.
    const second=await worker('second');assert(second.reconnectWithoutRelaunchVerified);process.kill(daemonPid,0);
    console.log(JSON.stringify({daemonAuthenticationVerified:true,dpapiIdentityVerified:true,independentProcessVerified:true,survivesAppProcessExitVerified:true,reconnectWithoutRelaunchVerified:true,...(configured?{configuredCloudVerified:true,hydrationAfterAppExitVerified:true,uploadAfterAppExitVerified:true,remoteAdditionAfterAppExitVerified:true,hydratedBytes:remoteBytes.length}:{}),pid:daemonPid}));
  }finally{
    let rootRemoved=!ownedRoot;
    try{
      if(daemonPid)await new Promise(resolve=>execFile('taskkill.exe',['/PID',String(daemonPid),'/T','/F'],()=>resolve()));
      if(ownedRoot){
        const current=await fs.lstat(ownedRoot);assert.equal(current.isSymbolicLink(),false);assert.equal(current.ino,rootIdentity.ino);assert.equal(current.dev,rootIdentity.dev);
        const cleanup=await worker('cleanup');assert.equal(cleanup.ownedRootUnregistered,true);await fs.rm(ownedRoot,{recursive:true,force:true});rootRemoved=true;
      }
    }finally{await cloud?.close();if(rootRemoved)await fs.rm(profile,{recursive:true,force:true});}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
