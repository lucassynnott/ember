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
  await fixture.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<html><head><title>Ember recording acceptance</title></head><body style="margin:0;background:#0000ff;height:100vh"><h1 style="color:white">Ember desktop capture fixture</h1><div id="changing" style="position:absolute;left:20px;top:100px;width:40px;height:40px;background:#ff0000"></div><script>let green=false;setInterval(()=>{green=!green;document.getElementById("changing").style.background=green?"#00ff00":"#ff0000"},200)</script></body></html>'));
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
      const native='using System; using System.Runtime.InteropServices; public class EmberCapturePointer { [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; } [StructLayout(LayoutKind.Sequential)] public struct Info { public uint size,flags; public IntPtr cursor; public Point point; } [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, IntPtr process); [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach); [DllImport("user32.dll")] public static extern IntPtr LoadCursor(IntPtr instance, IntPtr name); [DllImport("user32.dll")] public static extern IntPtr SetCursor(IntPtr cursor); [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra); [DllImport("user32.dll")] public static extern int ShowCursor(bool show); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref Info info); }';
      // Cursor visibility belongs to the thread owning mouse input. Attach to the
      // fixture's input queue while showing its arrow, then verify global state.
      const command=`Add-Type -TypeDefinition '${native}'; $current=[EmberCapturePointer]::GetCurrentThreadId(); $owner=[EmberCapturePointer]::GetWindowThreadProcessId([IntPtr]::new(${id}),[IntPtr]::Zero); if (![EmberCapturePointer]::AttachThreadInput($current,$owner,$true)) { throw 'Cursor input attachment failed' }; try { if (![EmberCapturePointer]::SetCursorPos(${point.x},${point.y})) { throw 'Cursor placement failed' }; [void][EmberCapturePointer]::SetCursor([EmberCapturePointer]::LoadCursor([IntPtr]::Zero,[IntPtr]::new(32512))); for ($attempt=0; $attempt -lt 32; $attempt++) { if ([EmberCapturePointer]::ShowCursor($true) -ge 0) { break } }; [EmberCapturePointer]::mouse_event(1,1,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 100; if (![EmberCapturePointer]::SetCursorPos(${point.x},${point.y})) { throw 'Cursor placement failed' }; Start-Sleep -Milliseconds 200; $info=[EmberCapturePointer+Info]::new(); $info.size=[Runtime.InteropServices.Marshal]::SizeOf($info); if (![EmberCapturePointer]::GetCursorInfo([ref]$info)) { throw 'Cursor query failed' }; [Console]::WriteLine($info.flags) } finally { [void][EmberCapturePointer]::AttachThreadInput($current,$owner,$false) }`;
      const visible=await execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true,timeout:15000});
      assert.equal(Number(visible.stdout.trim())&1,1,'test cursor must be visible inside the recorded area');
    }
    const result=await record(backend,['record','--out',path.join(directory,`${mode}.mp4`),...target,...(mode==='cursor-free-area'?['--hide-cursor']:[]),'--mic','default']);
    assert.ok(result.duration>=1);
    const {stdout}=await execFile(ffmpeg,['-v','error','-ss','0.7','-i',result.file,'-frames:v','1','-vf','crop=2:2:iw/2:ih/2','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{encoding:'buffer',windowsHide:true,timeout:15000});
    assert.equal(stdout.length,12);
    assert.ok(stdout[0]<25&&stdout[1]<25&&stdout[2]>220,`${mode} did not capture the known blue desktop pixels: ${[...stdout]}`);
    if(mode==='window') {
      const {stdout:motion}=await execFile(ffmpeg,['-v','error','-i',result.file,'-vf','crop=2:2:iw*0.0625:ih*0.25,scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{encoding:'buffer',windowsHide:true,timeout:15000});
      let red=false,green=false;
      for(let index=0;index<motion.length;index+=3){red ||= motion[index]>200&&motion[index+1]<40;green ||= motion[index+1]>200&&motion[index]<40;}
      assert.ok(red&&green,'selected window recording froze instead of capturing changing content');
    }
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
  const proof={windowsDesktopCapture:'passed',realDesktopPixels:true,movingWindowFrames:true,microphone:'generated',captured};
  if(process.env.EMBER_DESKTOP_CAPTURE_RESULT)await fs.writeFile(process.env.EMBER_DESKTOP_CAPTURE_RESULT,JSON.stringify(proof));
  console.log(JSON.stringify(proof));clearTimeout(timeout);await fs.rm(directory,{recursive:true,force:true});app.exit(0);
}).catch(async error=>{console.error(error.stack);clearTimeout(timeout);if(directory)await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});app.exit(1);});
