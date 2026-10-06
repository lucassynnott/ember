const test=require('node:test');
const assert=require('node:assert/strict');
const {QRCodeWriter,BarcodeFormat}=require('@zxing/library');
const {decodeBarcodes}=require('../src/windows-barcodes');
const {captureResult}=require('../src/screen-text');
function image(width,height){return {width,height,bitmap:Buffer.alloc(width*height*4,255)};}
function drawQr(image,text,left=0,top=0){const matrix=new QRCodeWriter().encode(text,BarcodeFormat.QR_CODE,240,240,new Map());for(let y=0;y<240;y++)for(let x=0;x<240;x++)if(matrix.get(x,y)){const i=((y+top)*image.width+x+left)*4;image.bitmap[i]=image.bitmap[i+1]=image.bitmap[i+2]=0;}}
test('reads QR links and preserves multiple codes for the existing capture result policy',()=>{
  const single=image(260,260);drawQr(single,'https://example.com/ember',10,10);
  const codes=decodeBarcodes(single);assert.deepEqual(codes,[{kind:'qr',payload:'https://example.com/ember'}]);
  assert.equal(captureResult({lines:[],codes}).kind,'link');
  const multiple=image(620,280);drawQr(multiple,'https://example.com/one',10,20);drawQr(multiple,'https://example.com/two',360,20);
  assert.deepEqual(decodeBarcodes(multiple).map(code=>code.payload).sort(),['https://example.com/one','https://example.com/two']);
});
test('reads an EAN-13 product barcode from actual bars',()=>{
  const value='5901234123457';
  const L=['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
  const G=['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
  const parity='LGGLLG';
  const bits='101'+[...value.slice(1,7)].map((digit,index)=>(parity[index]==='L'?L:G)[Number(digit)]).join('')+'01010'+[...value.slice(7)].map(digit=>L[Number(digit)].replace(/[01]/g,bit=>bit==='0'?'1':'0')).join('')+'101';
  const sample=image((bits.length+24)*3,140);
  for(let index=0;index<bits.length;index++)if(bits[index]==='1')for(let x=(index+12)*3;x<(index+13)*3;x++)for(let y=10;y<130;y++){const i=(y*sample.width+x)*4;sample.bitmap[i]=sample.bitmap[i+1]=sample.bitmap[i+2]=0;}
  assert.deepEqual(decodeBarcodes(sample),[{kind:'ean-13',payload:value}]);
  assert.deepEqual(decodeBarcodes(image(100,100)),[]);
});
