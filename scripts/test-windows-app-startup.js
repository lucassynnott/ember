const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve,reject) => {
    const timer=setTimeout(()=>{socket.close();reject(new Error("CDP connection timeout"));},15000);
    socket.onopen=()=>{clearTimeout(timer);resolve();};
    socket.onerror=error=>{clearTimeout(timer);reject(error);};
  });
  let next = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);clearTimeout(request.timer);
    message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
  };
  return {
    close:()=>socket.close(),
    request:(method,params={})=>new Promise((resolve,reject)=>{
      const id=++next;
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},15000);
      pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
    }),
  };
}
async function main() {
  assert.equal(process.platform,'win32','packaged app acceptance requires Windows');
  const executable = path.resolve(process.argv[2] || 'dist/win-unpacked/Ember.exe');
  const directory = process.env.EMBER_STARTUP_PROFILE_ROOT ? path.resolve(process.env.EMBER_STARTUP_PROFILE_ROOT) : await fs.mkdtemp(path.join(os.tmpdir(),'ember-app-startup-'));
  const evidence = path.resolve(process.env.EMBER_STARTUP_EVIDENCE || 'dist/windows-startup-evidence');
  await fs.mkdir(evidence,{recursive:true});
  const port = await freePort();
  const environment = {...process.env,APPDATA:path.join(directory,'roaming'),LOCALAPPDATA:path.join(directory,'local')};
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable,[`--remote-debugging-port=${port}`,`--user-data-dir=${path.join(directory,'user-data')}`],{env:environment,windowsHide:false,stdio:['ignore','pipe','pipe']});
  let logs='',exited=false,client,driveClient;
  child.stdout.on('data',bytes=>{logs=(logs+bytes).slice(-100000);});
  child.stderr.on('data',bytes=>{logs=(logs+bytes).slice(-100000);});
  child.on('error',error=>{logs+=error.message;exited=true;});
  child.on('exit',()=>{exited=true;});
  try {
    const deadline=Date.now()+90000;
    let target;
    while (!target || !logs.includes('Ember ready:')) {
      assert.ok(!exited,`Ember exited during startup: ${logs}`);
      assert.ok(Date.now()<deadline,`Ember startup timed out: ${logs}`);
      const pages=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000)}).then(response=>response.json()).catch(()=>[]);
      target=pages.find(page=>page.type==='page' && page.url.includes('onboarding.html'));
      await delay(200);
    }
    client=await connect(target.webSocketDebuggerUrl);
    const result=await client.request('Runtime.evaluate',{expression:`(async()=>({text:document.body.innerText,settings:await window.meetingRecorder.getSettings(),permissions:await window.meetingRecorder.onboardingPermissions()}))()`,awaitPromise:true,returnByValue:true});
    assert.ok(!result.exceptionDetails,JSON.stringify(result.exceptionDetails));
    const value=result.result.value;
    assert.ok(value.text.includes('Ember'),'onboarding renders Ember');
    assert.ok(value.text.trim().length>50,'onboarding renders content');
    assert.ok(value.settings && typeof value.settings==='object','settings bridge responds');
    assert.ok(value.permissions && typeof value.permissions==='object','permissions bridge responds');
    const screenshot=await client.request('Page.captureScreenshot',{format:'png'});
    await fs.writeFile(path.join(evidence,'onboarding.png'),Buffer.from(screenshot.data,'base64'));
    assert.doesNotMatch(value.text, /this Mac|your Mac/, 'Windows welcome uses platform-neutral copy');
    await client.request('Runtime.evaluate', { expression: `Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='Get started').click()` });
    const nameDeadline=Date.now()+10000;
    for (;;) {
      const input=await client.request('Runtime.evaluate',{expression:`Boolean(document.querySelector('#onb-name'))`,returnByValue:true});
      if(input.result.value)break;
      assert.ok(Date.now()<nameDeadline,'name step did not open');await delay(100);
    }
    await client.request('Runtime.evaluate',{expression:`document.querySelector('#onb-name').focus()`});
    await client.request('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    await client.request('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    await client.request('Input.insertText',{text:'Ember Windows acceptance'});
    await delay(150);
    await client.request('Runtime.evaluate',{expression:`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='Continue').click()`});
    const savedDeadline=Date.now()+10000;
    let saved;
    for (;;) {
      try {saved=JSON.parse(await fs.readFile(path.join(directory,'user-data/settings.json'),'utf8'));}catch{}
      if(saved?.speakerName==='Ember Windows acceptance')break;
      assert.ok(Date.now()<savedDeadline,'onboarding name did not persist');await delay(100);
    }
    for (;;) {
      const page=await client.request('Runtime.evaluate',{expression:`document.body.innerText`,returnByValue:true});
      if(page.result.value?.includes('Allow the permissions below.')) {assert.doesNotMatch(page.result.value,/macOS|this Mac|your Mac/,'Windows permission instructions must match Windows');break;}
      assert.ok(Date.now()<savedDeadline,'permissions step did not render');await delay(100);
    }
    const permissionsScreenshot=await client.request('Page.captureScreenshot',{format:'png'});
    await fs.writeFile(path.join(evidence,'permissions.png'),Buffer.from(permissionsScreenshot.data,'base64'));
    const enabledLogin=await client.request('Runtime.evaluate',{expression:`window.meetingRecorder.saveSettings({launchAtLogin:true})`,awaitPromise:true,returnByValue:true});
    assert.ok(!enabledLogin.exceptionDetails,JSON.stringify(enabledLogin.exceptionDetails));
    assert.equal(enabledLogin.result.value.launchAtLogin,true,'packaged startup registration must report enabled');
    const registered=await promisify(execFile)('reg.exe',['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'],{encoding:'utf8',windowsHide:true});
    assert.ok(registered.stdout.split('\n').some(line=>line.includes('--ember-login')&&line.toLowerCase().includes(executable.toLowerCase())),'Windows Run key must contain the packaged executable and login flag');
    const disabledLogin=await client.request('Runtime.evaluate',{expression:`window.meetingRecorder.saveSettings({launchAtLogin:false})`,awaitPromise:true,returnByValue:true});
    assert.ok(!disabledLogin.exceptionDetails,JSON.stringify(disabledLogin.exceptionDetails));
    assert.equal(disabledLogin.result.value.launchAtLogin,false);
    const removed=await promisify(execFile)('reg.exe',['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'],{encoding:'utf8',windowsHide:true});
    assert.ok(!removed.stdout.split('\n').some(line=>line.includes('--ember-login')&&line.toLowerCase().includes(executable.toLowerCase())),'disabled startup must remove its registry entry');
    const driveSettings=await client.request('Runtime.evaluate',{expression:'window.meetingRecorder.driveRequest("settings")',awaitPromise:true,returnByValue:true});
    assert.ok(!driveSettings.exceptionDetails,JSON.stringify(driveSettings.exceptionDetails));assert.deepEqual(driveSettings.result.value,{},'a fresh packaged profile must reach the unconfigured Drive daemon');
    const driveState=await client.request('Runtime.evaluate',{expression:'window.meetingRecorder.driveStatus()',awaitPromise:true,returnByValue:true});
    assert.ok(!driveState.exceptionDetails,JSON.stringify(driveState.exceptionDetails));assert.equal(driveState.result.value.supported,true);assert.equal(driveState.result.value.daemonConnected,true);assert.equal(driveState.result.value.configured,false);assert.equal(driveState.result.value.mounted,false);
    const daemonIdentity=await fs.readFile(path.join(directory,'user-data','windows-drive','daemon.dpapi'));
    assert.ok(daemonIdentity.length>64,'the packaged daemon identity must be persisted in encrypted form');assert.doesNotMatch(daemonIdentity.toString('utf8'),/^[a-f0-9]{64}$/,'the daemon identity must not be stored as a plaintext token');
    const opened=await client.request('Runtime.evaluate',{expression:'window.meetingRecorder.openSettings("drive")',awaitPromise:true,returnByValue:true});assert.ok(!opened.exceptionDetails,JSON.stringify(opened.exceptionDetails));
    const driveDeadline=Date.now()+15000;let driveTarget;
    while(!driveTarget){
      assert.ok(Date.now()<driveDeadline,'the packaged Drive settings page did not open');
      const pages=await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000)}).then(response=>response.json());
      driveTarget=pages.find(page=>page.type==='page'&&page.url.includes('settings.html')&&page.url.endsWith('#drive'));if(!driveTarget)await delay(100);
    }
    driveClient=await connect(driveTarget.webSocketDebuggerUrl);
    for(;;){
      const body=await driveClient.request('Runtime.evaluate',{expression:'document.body.innerText',returnByValue:true});
      if(body.result.value?.includes('Your cloud storage in File Explorer.')){assert.doesNotMatch(body.result.value,/Ember Drive needs macOS|Ember Drive is unavailable/);break;}
      assert.ok(Date.now()<driveDeadline,'the packaged Windows Drive setup did not render');await delay(100);
    }
    const driveScreenshot=await driveClient.request('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(evidence,'drive-settings.png'),Buffer.from(driveScreenshot.data,'base64'));
    const proof={windowsAppStartup:'passed',mainReady:true,onboardingRendered:true,settingsBridge:true,permissionsBridge:true,onboardingNamePersisted:true,loginRegistrationVerified:true,packagedDriveDaemonBridge:true,driveIdentityPersisted:true,windowsDriveSettingsRendered:true};
    await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify(proof,null,2));
    console.log(JSON.stringify(proof));
  } finally {
    if(client&&!exited)await client.request('Runtime.evaluate',{expression:`window.meetingRecorder.saveSettings({launchAtLogin:false})`,awaitPromise:true}).catch(()=>{});
    driveClient?.close();client?.close();
    if (!exited && child.pid) await promisify(execFile)('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>{});
    await fs.writeFile(path.join(evidence,'startup.log'),logs);
    if(process.env.EMBER_STARTUP_PRESERVE_PROFILE !== '1')await fs.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:300}).catch(()=>{});
  }
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});

module.exports={connect,freePort};
