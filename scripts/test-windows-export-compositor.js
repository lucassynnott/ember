const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => { console.error('Export compositor check timed out'); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await window.loadFile(path.resolve(__dirname, '../renderer/dist/export.html'));
  const result = await window.webContents.executeJavaScript(`(async () => {
    const { ExportFrameCompositor, trackSample } = window.emberExport;
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const canvas = (w, h, color) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').fillStyle = color; c.getContext('2d').fillRect(0,0,w,h); return c; };
    const sprite = c => c.toDataURL('image/png').split(',')[1];
    const output = canvas(100,80,'black'), context = output.getContext('2d');
    const pixel = (x,y) => Array.from(context.getImageData(x,y,1,1).data);
    const rgb = (x,y,color) => pixel(x,y).slice(0,3).every((value,index) => Math.abs(value-color[index]) < 4);
    const mask = canvas(80,60,'transparent'), maskContext = mask.getContext('2d');
    maskContext.fillStyle='white'; maskContext.beginPath(); maskContext.roundRect(0,0,80,60,10); maskContext.fill();
    const camera = canvas(40,30,'green'); camera.getContext('2d').fillStyle='yellow'; camera.getContext('2d').fillRect(20,0,20,30);
    const spec = {width:100,height:80,fps:30,content:[10,10,80,60],contentMask:1,
      sprites:[sprite(canvas(100,80,'red')),sprite(mask),sprite(canvas(8,8,'white')),sprite(canvas(8,8,'magenta'))],
      background:{kind:'image',image:0},view:[[0,0,0,80,60],[1,0,0,80,60]],
      webcam:{track:[[0,70,55,20,15,0]],mirror:true,shadow:0,crop:[0,0,1,1]},
      layers:[{kind:'picture',sprite:2,start:0,end:1,rect:[15,15,20,10],fadeIn:0.2},{kind:'blur',start:0,end:1,rect:[40,20,10,10],fill:'#ff0000'}],
      effects:[{rect:[20,50,10,10],frames:[[0.4,3],[0.6,2]]}],
      cursorSprites:[{sprite:2,hotX:0,hotY:0,size:8}],cursor:[[0,70,40,0,8,1,0,1],[0.8,70,40,0,8,1,0,0]]};
    const compositor=await ExportFrameCompositor.create(spec), screen=canvas(80,60,'blue');
    compositor.draw(context,0.5,{image:screen,width:80,height:60},{image:camera,width:40,height:30});
    check(rgb(0,0,[255,0,0]),'background'); check(rgb(11,11,[255,0,0]),'rounded content mask');
    check(rgb(55,40,[0,0,255]),'screen placement'); check(rgb(20,20,[255,255,255]),'picture layer');
    check(rgb(45,25,[255,0,0]),'redaction fill'); check(rgb(24,54,[255,0,255]),'click effect');
    check(rgb(73,43,[255,255,255]),'cursor hotspot'); check(rgb(72,60,[255,255,0]),'mirrored camera crop');
    compositor.draw(context,0.1,{image:screen,width:80,height:60},{image:camera,width:40,height:30});
    check(rgb(20,20,[128,128,255]),'layer fade');
    compositor.draw(context,0.9,{image:screen,width:80,height:60});
    check(rgb(73,43,[0,0,255]),'discrete cursor visibility'); check(rgb(24,54,[0,0,255]),'effect interval');
    compositor.close();
    const plain={...spec,layers:[],effects:[],cursor:[],webcam:null,view:[[0,0,0,20,40,1]]};
    const letterbox=await ExportFrameCompositor.create(plain);
    letterbox.draw(context,0,{image:canvas(20,40,'blue'),width:20,height:40});
    check(rgb(15,40,[0,0,0]) && rgb(50,40,[0,0,255]),'other-source letterbox'); letterbox.close();
    const split=canvas(80,60,'cyan'); split.getContext('2d').fillStyle='blue'; split.getContext('2d').fillRect(40,0,40,60);
    const zoomed=await ExportFrameCompositor.create({...plain,view:[[0,0,0,40,60],[1,40,0,40,60]]});
    zoomed.draw(context,0.5,{image:split,width:80,height:60});
    check(rgb(20,40,[0,255,255]) && rgb(80,40,[0,0,255]),'interpolated zoom view'); zoomed.close();
    const stepped=trackSample([[0,0],[1,1]],0.5,true), continuous=trackSample([[0,0],[1,1]],0.5);
    check(stepped[1]===0 && continuous[1]===0.5,'track interpolation versus stepping');
    return {exportCompositor:'passed',pixelChecks:13,width:100,height:80};
  })()`);
  assert.equal(result.exportCompositor, 'passed');
  if (process.env.EMBER_EXPORT_RESULT) await fs.writeFile(process.env.EMBER_EXPORT_RESULT, JSON.stringify(result));
  console.log(JSON.stringify(result)); window.destroy(); clearTimeout(timeout); app.exit(0);
}).catch(error => { console.error(error.stack); clearTimeout(timeout); app.exit(1); });
