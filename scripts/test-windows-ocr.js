const {app,BrowserWindow,nativeImage}=require('electron');
const assert=require('node:assert/strict');
const {WindowsOcr}=require('../src/windows-ocr');
const {captureResult}=require('../src/screen-text');
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  const ocr=new WindowsOcr({decodeImage: input=>{const image=nativeImage.createFromBuffer(input);return {bitmap:image.toBitmap(),...image.getSize()};}});
  try {
    await window.loadURL('data:text/html,<html><body></body></html>');
    const png=await window.webContents.executeJavaScript(`(()=>{const canvas=document.createElement('canvas');canvas.width=700;canvas.height=160;const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,700,160);ctx.fillStyle='black';ctx.font='36px Arial';ctx.fillText('Ember Windows screen text',25,65);ctx.fillText('Private image reading',25,120);return canvas.toDataURL('image/png').split(',')[1]})()`);
    if (process.env.EMBER_OCR_FIXTURE) await require('node:fs/promises').writeFile(process.env.EMBER_OCR_FIXTURE,Buffer.from(png,'base64'));
    const result=await ocr.read(Buffer.from(png,'base64'));
    const text=captureResult(result,{keepLineBreaks:true})?.text;
    assert.match(text,/Ember Windows screen text/);
    assert.match(text,/Private image reading/);
    assert.ok(result.lines.every(line=>line.w>0 && line.h>0));
    const {QRCodeWriter,BarcodeFormat}=require('@zxing/library');
    const matrix=new QRCodeWriter().encode('https://example.com/ember',BarcodeFormat.QR_CODE,240,240,new Map());
    const bitmap=Buffer.alloc(240*240*4,255);
    for(let y=0;y<240;y++)for(let x=0;x<240;x++)if(matrix.get(x,y)){const i=(y*240+x)*4;bitmap[i]=bitmap[i+1]=bitmap[i+2]=0;}
    const qrImage=nativeImage.createFromBitmap(bitmap,{width:240,height:240});
    const qr=await ocr.read(qrImage.toPNG());
    assert.equal(captureResult(qr).kind,'link');
    assert.equal(captureResult(qr).text,'https://example.com/ember');

    console.log(JSON.stringify({windowsOcr:'passed',offlineModel:true,textRecognized:true,lineBoxes:true,qrLink:true}));
  } finally {await ocr.close();window.destroy();}
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
