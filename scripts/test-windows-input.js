const {app,BrowserWindow,clipboard}=require('electron');
const {spawn}=require('node:child_process');
const path=require('node:path');
const assert=require('node:assert/strict');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
app.commandLine.appendSwitch('force-renderer-accessibility');
app.on('window-all-closed',()=>{});
let window,helper;
const waiting=new Map();let sequence=0;
const deadline=setTimeout(()=>{console.error('Windows input acceptance timed out');helper?.kill();app.exit(1);},45000);
function request(cmd,args={}) {
  return new Promise((resolve,reject)=>{
    const id=++sequence;
    const timer=setTimeout(()=>{waiting.delete(id);reject(new Error(`${cmd} helper timeout`));},10000);
    waiting.set(id,{resolve,reject,timer});
    helper.stdin.write(JSON.stringify({id,cmd,...args})+'\n');
  });
}
async function focus(selector) {
  window.show();window.focus();
  await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  const expires=Date.now()+10000;
  for(;;){
    const state=await request('focus');
    if(state.focusFound&&state.pid===process.pid)return state;
    assert.ok(Date.now()<expires,`Foreground field was not found: ${JSON.stringify(state)}`);
    await delay(100);
  }
}
app.whenReady().then(async()=>{
  assert.equal(process.platform,'win32');
  window=new BrowserWindow({width:600,height:350,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await window.loadURL('data:text/html,'+encodeURIComponent('<h1>Ember Windows input acceptance</h1><label>Notes<textarea id="notes" rows="5"></textarea></label><label>Password<input id="password" type="password" value="private fixture"></label>'));
  helper=spawn(path.resolve('native/windows/bin/meeting-notes-hotkey.exe'),[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let buffer='',errors='';
  helper.stdout.on('data',bytes=>{
    buffer+=bytes;let index;
    while((index=buffer.indexOf('\n'))>=0){
      const message=JSON.parse(buffer.slice(0,index));buffer=buffer.slice(index+1);
      const entry=waiting.get(message.id);if(!entry)continue;
      waiting.delete(message.id);clearTimeout(entry.timer);entry.resolve(message);
    }
  });
  helper.stderr.on('data',bytes=>{errors=(errors+bytes).slice(-8000);});
  helper.on('error',error=>{for(const entry of waiting.values()){clearTimeout(entry.timer);entry.reject(error);}waiting.clear();});
  helper.on('close',code=>{for(const entry of waiting.values()){clearTimeout(entry.timer);entry.reject(new Error(`Helper exited ${code}: ${errors}`));}waiting.clear();});
  assert.equal((await request('status')).tap,true);
  const normal=await focus('#notes');
  assert.equal(normal.secure,false);assert.equal(normal.editable,true);
  const text='Café budget review — Thursday afternoon';clipboard.writeText(text);
  assert.equal((await request('paste')).ok,true);
  await delay(300);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#notes").value'),text);
  await window.webContents.executeJavaScript('document.querySelector("#notes").select()');
  clipboard.writeText('copy sentinel');
  assert.equal((await request('copy')).ok,true);await delay(300);
  assert.equal(clipboard.readText(),text);
  const password=await focus('#password');assert.equal(password.secure,true);
  clipboard.writeText('protected sentinel');
  assert.equal((await request('paste')).ok,false);
  assert.equal((await request('copy')).ok,false);
  assert.equal(clipboard.readText(),'protected sentinel');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#password").value'),'private fixture');
  const closed=new Promise(resolve=>helper.once('close',resolve));helper.stdin.end();assert.equal(await closed,0,'helper must exit cleanly after stdin closes');
  window.destroy();clearTimeout(deadline);
  console.log(JSON.stringify({windowsInput:'passed',chromiumFocus:true,unicodePaste:true,selectedTextCopy:true,passwordProtected:true}));app.exit(0);
}).catch(error=>{console.error(error.stack);clearTimeout(deadline);helper?.kill();window?.destroy();app.exit(1);});
