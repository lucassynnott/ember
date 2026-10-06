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
  const child=backend.start(args);let output='',done;

  return new Promise((resolve,reject)=>{
    child.once('close',code=>{if(code===0&&done)resolve(done);else reject(new Error('Desktop capture did not finish cleanly'));});
    child.stdout.on('data',bytes=>{
      output+=bytes;let newline;
      while((newline=output.indexOf('\n'))>=0){
        const event=JSON.parse(output.slice(0,newline));output=output.slice(newline+1);
        if(event.type==='started')setTimeout(()=>child.stdin.write('stop\n'),1800);
        else if(event.type==='done')done=event;
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
  for(const mode of ['window','area','cursor-free-area']){
    const target=mode==='window'?['--window',String(id)]:['--display',String(display.id),'--rect',`${bounds.x-display.bounds.x+100},${bounds.y-display.bounds.y+100},200,120`];
    if(mode==='cursor-free-area') {
      const point=screen.dipToScreenPoint({x:bounds.x+180,y:bounds.y+160});
      const native='using System; using System.Runtime.InteropServices; public class EmberCapturePointer { [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; } [StructLayout(LayoutKind.Sequential)] public struct Info { public uint size,flags; public IntPtr cursor; public Point point; } [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref Info info); }';
      const command=`Add-Type -TypeDefinition '${native}'; if (![EmberCapturePointer]::SetCursorPos(${point.x},${point.y})) { throw 'Cursor placement failed' }; $info=[EmberCapturePointer+Info]::new(); $info.size=[Runtime.InteropServices.Marshal]::SizeOf($info); if (![EmberCapturePointer]::GetCursorInfo([ref]$info)) { throw 'Cursor query failed' }; [Console]::WriteLine($info.flags)`;
      const visible=await execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true,timeout:15000});
      assert.equal(Number(visible.stdout.trim())&1,1,'test cursor must be visible inside the recorded area');
    }
    const result=await record(backend,['record','--out',path.join(directory,`${mode}.mp4`),...target,...(mode==='cursor-free-area'?['--hide-cursor']:[]),'--mic','default']);
    assert.ok(result.duration>=1);
    const {stdout}=await execFile(ffmpeg,['-v','error','-ss','0.7','-i',result.file,'-frames:v','1','-vf','crop=2:2:iw/2:ih/2','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{encoding:'buffer',windowsHide:true,timeout:15000});
    assert.equal(stdout.length,12);
    assert.ok(stdout[0]<25&&stdout[1]<25&&stdout[2]>220,`${mode} did not capture the known blue desktop pixels: ${[...stdout]}`);
    if(mode!=='window'){assert.equal(result.width,200);assert.equal(result.height,120);}
    if(mode==='cursor-free-area') {
      const {stdout:pixels}=await execFile(ffmpeg,['-v','error','-ss','0.7','-i',result.file,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{encoding:'buffer',windowsHide:true,timeout:15000});
      assert.equal(pixels.length,result.width*result.height*3);
      for(let index=0;index<pixels.length;index+=3)assert.ok(pixels[index]<35&&pixels[index+1]<35&&pixels[index+2]>200,'visible cursor pixels leaked into the cursor-free recording');
    }
    const cursor = JSON.parse(await fs.readFile(result.cursor, 'utf8'));
    assert.equal(cursor.cursorHidden, mode==='cursor-free-area');
    captured.push({mode,width:result.width,height:result.height,duration:result.duration});
  }
  fixture.destroy();assert.equal(BrowserWindow.getAllWindows().length,0);
  const proof={windowsDesktopCapture:'passed',realDesktopPixels:true,microphone:'generated',captured};
  if(process.env.EMBER_DESKTOP_CAPTURE_RESULT)await fs.writeFile(process.env.EMBER_DESKTOP_CAPTURE_RESULT,JSON.stringify(proof));
  console.log(JSON.stringify(proof));clearTimeout(timeout);await fs.rm(directory,{recursive:true,force:true});app.exit(0);
}).catch(async error=>{console.error(error.stack);clearTimeout(timeout);if(directory)await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});app.exit(1);});
