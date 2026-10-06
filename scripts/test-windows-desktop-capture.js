// Real Windows desktop/window pixels; the microphone is Chromium's generated device.
const { app, BrowserWindow, session, screen } = require('electron');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { WindowsCapture } = require('../src/windows-capture');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
app.on('window-all-closed',()=>{});
let directory;
const timeout=setTimeout(()=>{console.error('Real desktop capture timed out');app.exit(1);},60000);
async function record(backend,args) {
  const child=backend.start(args);let output='';
  return new Promise((resolve,reject)=>{
    child.stdout.on('data',bytes=>{
      output+=bytes;let newline;
      while((newline=output.indexOf('\n'))>=0){
        const event=JSON.parse(output.slice(0,newline));output=output.slice(newline+1);
        if(event.type==='started')setTimeout(()=>child.stdin.write('stop\n'),1800);
        else if(event.type==='done')resolve(event);
        else if(event.type==='error')reject(new Error(event.message));
      }
    });
  });
}
app.whenReady().then(async()=>{
  assert.equal(process.platform,'win32');
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'ember-real-desktop-'));
  session.defaultSession.setPermissionRequestHandler((_contents,permission,callback)=>callback(permission==='media'));
  const display=screen.getPrimaryDisplay();
  const fixture=new BrowserWindow({x:display.bounds.x+80,y:display.bounds.y+80,width:640,height:480,frame:false,show:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await fixture.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<html><body style="margin:0;background:#0000ff;height:100vh"><h1 style="color:white">Ember desktop capture fixture</h1></body></html>'));
  fixture.show();fixture.focus();await new Promise(resolve=>setTimeout(resolve,500));
  const id=Number(fixture.getNativeWindowHandle().readBigUInt64LE());
  const bounds=fixture.getBounds();
  const nativeBounds=screen.dipToScreenRect(fixture,bounds);
  const helper=Object.assign(new EventEmitter(),{windows:async()=>({windows:[{id,app:'Ember fixture',bounds:nativeBounds}]}),watchPointer(){}});
  const ffmpeg=process.env.FFMPEG_BIN||'ffmpeg';
  const backend=new WindowsCapture({electron:require('electron'),rendererDir:path.resolve(__dirname,'../renderer/dist'),getFfmpeg:()=>ffmpeg,helper});
  const captured=[];
  for(const mode of ['window','area']){
    const target=mode==='window'?['--window',String(id)]:['--display',String(display.id),'--rect',`${bounds.x-display.bounds.x+100},${bounds.y-display.bounds.y+100},200,120`];
    const result=await record(backend,['record','--out',path.join(directory,`${mode}.mp4`),...target,'--mic','default']);
    assert.ok(result.duration>=1);
    const {stdout}=await execFile(ffmpeg,['-v','error','-ss','0.7','-i',result.file,'-frames:v','1','-vf','crop=2:2:iw/2:ih/2','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{encoding:'buffer',windowsHide:true,timeout:15000});
    assert.equal(stdout.length,12);
    assert.ok(stdout[0]<25&&stdout[1]<25&&stdout[2]>220,`${mode} did not capture the known blue desktop pixels: ${[...stdout]}`);
    if(mode==='area'){assert.equal(result.width,200);assert.equal(result.height,120);}
    captured.push({mode,width:result.width,height:result.height,duration:result.duration});
  }
  fixture.destroy();assert.equal(BrowserWindow.getAllWindows().length,0);
  const proof={windowsDesktopCapture:'passed',realDesktopPixels:true,microphone:'generated',captured};
  if(process.env.EMBER_DESKTOP_CAPTURE_RESULT)await fs.writeFile(process.env.EMBER_DESKTOP_CAPTURE_RESULT,JSON.stringify(proof));
  console.log(JSON.stringify(proof));clearTimeout(timeout);await fs.rm(directory,{recursive:true,force:true});app.exit(0);
}).catch(async error=>{console.error(error.stack);clearTimeout(timeout);if(directory)await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});app.exit(1);});
