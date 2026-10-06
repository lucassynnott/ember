const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const {spawn,execFile}=require('node:child_process');
async function main(){
  assert.equal(process.platform,'win32');const profile=await fs.mkdtemp(path.join(os.tmpdir(),'ember-drive-daemon-'));const electron=require('electron');let daemonPid;
  async function worker(role){
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
    const child=spawn(electron,[path.join(__dirname,'test-windows-drive-daemon-worker.js'),profile,role],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
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
    const first=await worker('first');assert(first.dpapiIdentityVerified);assert(daemonPid>0);process.kill(daemonPid,0);
    // The first app process has exited. A second real Electron app must attach
    // to the existing provider and decrypt the same profile identity.
    const second=await worker('second');assert(second.reconnectWithoutRelaunchVerified);process.kill(daemonPid,0);
    console.log(JSON.stringify({daemonAuthenticationVerified:true,dpapiIdentityVerified:true,independentProcessVerified:true,survivesAppProcessExitVerified:true,reconnectWithoutRelaunchVerified:true,pid:daemonPid}));
  }finally{
    if(daemonPid)await new Promise(resolve=>execFile('taskkill.exe',['/PID',String(daemonPid),'/T','/F'],()=>resolve()));
    await fs.rm(profile,{recursive:true,force:true});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
