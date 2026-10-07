const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const assert=require('node:assert/strict');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {connect,freePort}=require('./test-windows-app-startup');
const run=promisify(execFile);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
  assert.equal(process.platform,'win32');
  const executable=path.resolve(process.argv[2]||'dist/win-unpacked/Ember.exe');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ember-relaunch-'));
  const evidence=path.resolve(process.env.EMBER_RELAUNCH_EVIDENCE||'dist/windows-relaunch-evidence');
  await fs.mkdir(evidence,{recursive:true});
  let child,client,logs='',exited=false;
  try {
    await run(process.execPath,[path.resolve('scripts/test-windows-app-startup.js'),executable],{timeout:120000,windowsHide:true,env:{...process.env,EMBER_STARTUP_PROFILE_ROOT:directory,EMBER_STARTUP_PRESERVE_PROFILE:'1',EMBER_STARTUP_EVIDENCE:path.join(evidence,'first-run')}});
    const profile=path.join(directory,'user-data');
    const saved=JSON.parse(await fs.readFile(path.join(profile,'settings.json'),'utf8'));
    assert.equal(saved.speakerName,'Ember Windows acceptance');
    const port=await freePort();
    const environment={...process.env,APPDATA:path.join(directory,'roaming'),LOCALAPPDATA:path.join(directory,'local')};
    delete environment.ELECTRON_RUN_AS_NODE;
    child=spawn(executable,[`--remote-debugging-port=${port}`,`--user-data-dir=${profile}`],{env:environment,windowsHide:false,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',bytes=>{logs=(logs+bytes).slice(-100000);});
    child.stderr.on('data',bytes=>{logs=(logs+bytes).slice(-100000);});
    child.on('error',error=>{logs+=error.message;exited=true;});child.on('exit',()=>{exited=true;});
    const deadline=Date.now()+90000;let target;
    while(!target||!logs.includes('Ember ready:')){
      assert.ok(!exited,`Relaunched Ember exited: ${logs}`);
      assert.ok(Date.now()<deadline,`Relaunch timed out: ${logs}`);
      const pages=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000)}).then(r=>r.json()).catch(()=>[]);
      target=pages.find(page=>page.type==='page'&&/(?:onboarding|settings|index)\.html(?:[?#]|$)/.test(page.url));await delay(200);
    }
    client=await connect(target.webSocketDebuggerUrl);
    const result=await client.request('Runtime.evaluate',{expression:'window.meetingRecorder.getSettings()',awaitPromise:true,returnByValue:true});
    assert.ok(!result.exceptionDetails,JSON.stringify(result.exceptionDetails));
    assert.equal(result.result.value.speakerName,saved.speakerName,'restarted app loads its persisted speaker name');
    const driveSettings=await client.request('Runtime.evaluate',{expression:'window.meetingRecorder.driveRequest("settings")',awaitPromise:true,returnByValue:true});assert.ok(!driveSettings.exceptionDetails,JSON.stringify(driveSettings.exceptionDetails));assert.deepEqual(driveSettings.result.value,{});
    const driveStatus=await client.request('Runtime.evaluate',{expression:'window.meetingRecorder.driveStatus()',awaitPromise:true,returnByValue:true});assert.ok(!driveStatus.exceptionDetails,JSON.stringify(driveStatus.exceptionDetails));assert.equal(driveStatus.result.value.daemonConnected,true,'a relaunched packaged app must authenticate with its persisted daemon identity');
    const screenshot=await client.request('Page.captureScreenshot',{format:'png'});
    await fs.writeFile(path.join(evidence,'relaunch.png'),Buffer.from(screenshot.data,'base64'));
    const proof={page:target.url,windowsRelaunch:'passed',newProcessReady:true,sameProfile:true,persistedNameLoaded:true,packagedDriveReconnect:true};
    await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
  }finally{
    client?.close();
    if(child&&!exited)await run('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:15000}).catch(()=>{});
    await fs.writeFile(path.join(evidence,'relaunch.log'),logs);
    await fs.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:300}).catch(()=>{});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
