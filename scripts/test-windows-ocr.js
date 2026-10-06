const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const {WindowsOcr}=require('../src/windows-ocr');
const {captureResult}=require('../src/screen-text');
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  const ocr=new WindowsOcr();
  try {
    await window.loadURL('data:text/html,<html><body></body></html>');
    const png=await window.webContents.executeJavaScript(`(()=>{const canvas=document.createElement('canvas');canvas.width=700;canvas.height=160;const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,700,160);ctx.fillStyle='black';ctx.font='36px Arial';ctx.fillText('Ember Windows screen text',25,65);ctx.fillText('Private image reading',25,120);return canvas.toDataURL('image/png').split(',')[1]})()`);
    if (process.env.EMBER_OCR_FIXTURE) await require('node:fs/promises').writeFile(process.env.EMBER_OCR_FIXTURE,Buffer.from(png,'base64'));
    const result=await ocr.read(Buffer.from(png,'base64'));
    const text=captureResult(result,{keepLineBreaks:true})?.text;
    assert.match(text,/Ember Windows screen text/);
    assert.match(text,/Private image reading/);
    assert.ok(result.lines.every(line=>line.w>0 && line.h>0));
    console.log(JSON.stringify({windowsOcr:'passed',offlineModel:true,textRecognized:true,lineBoxes:true}));
  } finally {await ocr.close();window.destroy();}
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
