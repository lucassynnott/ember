const {app,BrowserWindow}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const crypto=require('node:crypto');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const assert=require('node:assert/strict');
const {HotkeyHelper}=require('../src/hotkey');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  assert.equal(process.platform,'win32');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ember-edge-acceptance-'));
  const server=http.createServer((_request,response)=>{response.writeHead(200,{'Content-Type':'text/html'});response.end('<title>Ember browser acceptance</title><h1>Local browser reference page</h1>');});
  const helper=new HotkeyHelper({binaryPath:path.resolve('native/windows/bin/meeting-notes-hotkey.exe')});
  let browser,browserPid,fixture,helperError;
  helper.on('error',error=>{helperError=error;});
  try {
    const candidates=[process.env.EDGE_BIN,...[process.env['ProgramFiles(x86)'],process.env.ProgramFiles,process.env.LOCALAPPDATA].filter(Boolean).map(root=>path.join(root,'Microsoft','Edge','Application','msedge.exe'))].filter(Boolean);
    let binary;
    for(const candidate of candidates)if(await fs.access(candidate).then(()=>true).catch(()=>false)){binary=candidate;break;}
    assert.ok(binary,'Microsoft Edge is required for browser-address acceptance');
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const url=`http://127.0.0.1:${server.address().port}/ember-browser-acceptance?nonce=${crypto.randomUUID()}`;
    helper.start();
    browser=spawn(binary,[`--user-data-dir=${path.join(directory,'profile')}`,'--no-first-run','--no-default-browser-check','--force-renderer-accessibility','--new-window',url],{windowsHide:false,stdio:'ignore'});
    browser.on('error',error=>{helperError=error;});
    const deadline=Date.now()+30000;let found,lastFocus,lastResult;
    while(Date.now()<deadline){
      if(helperError)throw helperError;
      const focus=await helper.focus();lastFocus=focus;
      if(focus.bundleId!=='msedge') {
        const windows=await helper.windows();
        const ownWindow=(windows.windows || []).find(item=>item.app?.toLowerCase()==='msedge' && item.title?.includes('Ember browser acceptance'));
        if(ownWindow) {
          // Only activate the fixture identified by its served document title.
          const activated=await helper.activate(ownWindow.pid);
          if(activated.ok===false) throw new Error('Could not activate the Edge acceptance window.');
        }
      }
      if(focus.bundleId==='msedge'){
        const result=await helper.browserUrl('msedge');lastResult=result;
        if(result.url===url){found=result.url;browserPid=focus.pid;break;}
      }
      await delay(250);
    }
    assert.equal(found,url,`foreground Edge address must preserve the actual HTTP URL: ${JSON.stringify({lastFocus,lastResult})}`);
    fixture=new BrowserWindow({width:400,height:250,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
    await fixture.loadURL('data:text/html,<h1>Ember foreground switch</h1><input autofocus>');
    fixture.show();fixture.focus();
    const focusDeadline=Date.now()+10000;
    while((await helper.focus()).pid!==process.pid){assert.ok(Date.now()<focusDeadline,'acceptance window did not take focus');await delay(100);}
    assert.equal((await helper.browserUrl('msedge')).url,null,'a background browser must not supply the foreground URL');
    console.log(JSON.stringify({windowsBrowser:'passed',edgeForegroundUrl:true,httpSchemePreserved:true,foregroundSwitchRejected:true}));
  } finally {
    helper.stop();fixture?.destroy();
    for(const pid of new Set([browserPid,browser?.exitCode===null&&browser?.signalCode===null?browser.pid:null].filter(Boolean)))await promisify(execFile)('taskkill.exe',['/PID',String(pid),'/T','/F'],{windowsHide:true,timeout:10000}).catch(()=>{});
    server.closeAllConnections();
    if(server.listening)await new Promise(resolve=>server.close(resolve));
    await fs.rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:300});
  }
  app.exit(0);
}).catch(error=>{console.error(error.stack);app.exit(1);});
