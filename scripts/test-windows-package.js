// Inspect the actual electron-builder output, not the source configuration.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
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
for (const name of ['composio-LICENSE', 'composio-source.txt']) assert.ok(fs.statSync(path.join(bin, name)).size > 0);
const archive = path.join(root, 'resources/app.asar');
for (const name of ['src/main.js', 'src/windows-capture.js', 'src/windows-export.js', 'src/windows-record-helper.js', 'renderer/dist/capture.html', 'renderer/dist/export.html']) {
  assert.ok(asar.extractFile(archive, name).length > 0, `packaged ${name}`);
}
const pkg = JSON.parse(asar.extractFile(archive, 'package.json'));
assert.equal(pkg.main, 'src/main.js');
const unpacked = path.join(root, 'resources/app.asar.unpacked/node_modules');
assert.ok(fs.existsSync(path.join(unpacked, 'sherpa-onnx-win-x64')), 'Windows speech native module unpacked');
if (process.platform === 'win32') {
  const speechModule = path.join(archive, 'node_modules/sherpa-onnx-node');
  const code = `const speech = require(${JSON.stringify(speechModule)}); const assert = require('node:assert/strict'); assert.equal(typeof speech.OfflineRecognizer, 'function'); assert.equal(typeof speech.readWave, 'function'); console.log(JSON.stringify({speechModule:'loaded',version:speech.version}));`;
  const result = execFileSync(path.join(root, 'Ember.exe'), ['-e', code], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.ok(result.includes('"speechModule":"loaded"'), 'packaged Electron loads speech native addon');
  for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
    const output = execFileSync(path.join(bin, name), ['-version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.ok(output.includes(name.replace('.exe', '') + ' version'), `packaged ${name} startup`);
  }
}
console.log(JSON.stringify({ windowsPackage: 'passed', root, version: pkg.version, nativeExecutables: 6 }));
