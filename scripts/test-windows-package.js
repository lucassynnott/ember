// Inspect the actual electron-builder output, not the source configuration.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const root = path.resolve(process.argv[2] || 'dist/win-unpacked');
function pe(file) {
  const data = fs.readFileSync(file);
  assert.equal(data.readUInt16LE(0), 0x5a4d, `${file}: DOS signature`);
  const offset = data.readUInt32LE(0x3c);
  assert.equal(data.readUInt32LE(offset), 0x4550, `${file}: PE signature`);
  assert.equal(data.readUInt16LE(offset + 4), 0x8664, `${file}: x64 machine`);
}
pe(path.join(root, 'Ember.exe'));
const bin = path.join(root, 'resources/bin');
for (const name of ['meeting-notes-hotkey.exe', 'meeting-notes-parakeet-worker.exe', 'ffmpeg.exe', 'ffprobe.exe', 'composio.exe']) pe(path.join(bin, name));
pe(path.join(bin, 'DirectML.dll'));
for (const name of ['whisper-cli.exe','whisper.dll','ggml.dll','ggml-base.dll','ggml-cpu-x64.dll']) pe(path.join(bin,'whisper',name));
assert.ok(fs.statSync(path.join(bin,'whisper/LICENSE')).size>0);
for (const name of ['llama-server.exe','llama-server-impl.dll','llama.dll','ggml.dll','ggml-base.dll','ggml-cpu-x64.dll','libomp.dll']) pe(path.join(bin, 'llama', name));
assert.ok(fs.statSync(path.join(bin, 'llama/LICENSE')).size > 0);
for (const name of ['composio-LICENSE', 'composio-source.txt', 'NAudio-LICENSE.txt']) assert.ok(fs.statSync(path.join(bin, name)).size > 0);
const archive = path.join(root, 'resources/app.asar');
for (const name of ['src/main.js', 'src/windows-capture.js', 'src/windows-export.js', 'src/windows-record-helper.js', 'renderer/dist/capture.html', 'renderer/dist/export.html']) {
  assert.ok(asar.extractFile(archive, path.normalize(name)).length > 0, `packaged ${name}`);
}
const pkg = JSON.parse(asar.extractFile(archive, 'package.json'));
assert.equal(pkg.main, 'src/main.js');
const unpacked = path.join(root, 'resources/app.asar.unpacked/node_modules');
assert.ok(fs.existsSync(path.join(unpacked, 'sherpa-onnx-win-x64')), 'Windows speech native module unpacked');
if (process.platform === 'win32') {
  const audioSnapshot = JSON.parse(execFileSync(path.join(bin, 'meeting-notes-hotkey.exe'), ['audio-apps'], { encoding: 'utf8', timeout: 15000, windowsHide: true }));
  assert.equal(audioSnapshot.type, 'audio-apps');
  assert.ok(Array.isArray(audioSnapshot.apps), 'packaged native audio observer returns a snapshot');
  const speechModule = path.join(archive, 'node_modules/sherpa-onnx-node');
  const code = `const speech = require(${JSON.stringify(speechModule)}); const assert = require('node:assert/strict'); assert.equal(typeof speech.OfflineRecognizer, 'function'); assert.equal(typeof speech.readWave, 'function'); console.log(JSON.stringify({speechModule:'loaded',version:speech.version}));`;
  const result = execFileSync(path.join(root, 'Ember.exe'), ['-e', code], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.ok(result.includes('"speechModule":"loaded"'), 'packaged Electron loads speech native addon');
  const ocrModule=path.join(archive,'src/windows-ocr.js');
  const fixture=path.resolve(__dirname,'../test/fixtures/windows-ocr.png');
  const ocrCode=`(async()=>{const {WindowsOcr}=require(${JSON.stringify(ocrModule)});const ocr=new WindowsOcr();try{const result=await ocr.read(require('node:fs').readFileSync(${JSON.stringify(fixture)}));require('node:assert/strict').match(result.lines.map(line=>line.text).join(' '),/Ember Windows screen text/);console.log('PACKAGED_OCR_PASSED');}finally{await ocr.close();}})().catch(error=>{console.error(error);process.exitCode=1;});`;
  const ocrResult=execFileSync(path.join(root,'Ember.exe'),['-e',ocrCode],{encoding:'utf8',timeout:45000,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
  assert.ok(ocrResult.includes('PACKAGED_OCR_PASSED'),'packaged offline OCR worker/model loads and recognizes text');
  const barcodeModule=path.join(archive,'src/windows-barcodes-async.js');
  const zxingModule=path.join(archive,'node_modules/@zxing/library');
  const barcodeCode=`(async()=>{const {QRCodeWriter,BarcodeFormat}=require(${JSON.stringify(zxingModule)});const matrix=new QRCodeWriter().encode('https://example.com/ember',BarcodeFormat.QR_CODE,240,240,new Map());const bitmap=Buffer.alloc(240*240*4,255);for(let y=0;y<240;y++)for(let x=0;x<240;x++)if(matrix.get(x,y)){const i=(y*240+x)*4;bitmap[i]=bitmap[i+1]=bitmap[i+2]=0;}const codes=await require(${JSON.stringify(barcodeModule)}).decodeBarcodesAsync({bitmap,width:240,height:240});require('node:assert/strict').equal(codes[0].payload,'https://example.com/ember');console.log('PACKAGED_BARCODE_PASSED');})().catch(error=>{console.error(error);process.exitCode=1;});`;
  const barcodeResult=execFileSync(path.join(root,'Ember.exe'),['-e',barcodeCode],{encoding:'utf8',timeout:45000,windowsHide:true,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
  assert.ok(barcodeResult.includes('PACKAGED_BARCODE_PASSED'),'packaged barcode worker and its dependencies load');


  const documentsModule = path.join(archive, 'src/windows-documents.js');
  const pdfFixture = path.resolve(__dirname, '../test/fixtures/windows-knowledge.pdf');
  const odtFixture = path.resolve(__dirname, '../test/fixtures/windows-knowledge.odt');
  const docxFixture = path.resolve(__dirname, '../test/fixtures/windows-knowledge.docx');
  const htmlFixture = path.resolve(__dirname, '../test/fixtures/windows-knowledge.html');
  const rtfFixture = path.resolve(__dirname, '../test/fixtures/windows-knowledge.rtf');
  const documentHelper = path.join(bin, 'meeting-notes-hotkey.exe');
  const documentsCode = `(async()=>{const {readPdf,convertDocument}=require(${JSON.stringify(documentsModule)});const assert=require('node:assert/strict');assert.match(await readPdf(${JSON.stringify(pdfFixture)}),/customer retention playbook/);assert.match(await convertDocument(${JSON.stringify(docxFixture)}),/confirm the budget owner/);assert.match(await convertDocument(${JSON.stringify(htmlFixture)}),/Confirm timing & budget/);assert.match(await convertDocument(${JSON.stringify(rtfFixture)},{nativeHelper:${JSON.stringify(documentHelper)}}),/Café budget owner/);assert.match(await convertDocument(${JSON.stringify(odtFixture)}),/Café renewal/);console.log('PACKAGED_DOCUMENTS_PASSED');})().catch(error=>{console.error(error);process.exitCode=1;});`;
  const documentsResult = execFileSync(path.join(root, 'Ember.exe'), ['-e', documentsCode], { encoding:'utf8', timeout:45000, windowsHide:true, env:{...process.env,ELECTRON_RUN_AS_NODE:'1'} });
  assert.ok(documentsResult.includes('PACKAGED_DOCUMENTS_PASSED'), 'packaged PDF and DOCX extraction loads bundled dependencies');

  const llamaVersion = spawnSync(path.join(bin, 'llama/llama-server.exe'), ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(llamaVersion.status, 0, String(llamaVersion.error || llamaVersion.stderr));
  assert.match(llamaVersion.stdout + llamaVersion.stderr, /version|build/i, 'packaged local AI runtime startup');
  for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
    const output = execFileSync(path.join(bin, name), ['-version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.ok(output.includes(name.replace('.exe', '') + ' version'), `packaged ${name} startup`);
  }
}
console.log(JSON.stringify({ windowsPackage: 'passed', root, version: pkg.version, nativeExecutables: 7 }));
