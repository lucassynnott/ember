const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { WindowsExport, mediaResponse } = require('../src/windows-export');

test('export media serves only its registered files and supports exact byte ranges', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-export-protocol-'));
  try {
    const file = path.join(folder, 'video.mp4'); await fs.writeFile(file, '0123456789');
    const url = 'ember-export://media/0', files = new Map([[url, file]]);
    const response = await mediaResponse(new Request(url, { headers: { Range: 'bytes=2-5' } }), files);
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(await response.text(), '2345');
    const suffix = await mediaResponse(new Request(url, { headers: { Range: 'bytes=-3' } }), files);
    assert.equal(await suffix.text(), '789');
    assert.equal((await mediaResponse(new Request(url, { headers: { Range: 'bytes=20-' } }), files)).status, 416);
    assert.equal((await mediaResponse(new Request('ember-export://media/../../private'), files)).status, 404);
    const head = await mediaResponse(new Request(url, { method: 'HEAD' }), files);
    assert.equal(head.headers.get('content-length'), '10'); assert.equal(await head.text(), '');
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('export frames reject unrelated renderers, subframes, wrong sequence and mismatched PNG dimensions', async () => {
  const handlers = new Map();
  const backend = new WindowsExport({ electron: { ipcMain: { handle: (key, handler) => handlers.set(key, handler), on() {} } } });
  const frame = handlers.get('windows-export:frame');
  await assert.rejects(frame({ sender: { id: 42 }, senderFrame: {} }, {}), /Unknown export/);
  const sender = { id: 1, mainFrame: {} }, event = { sender, senderFrame: sender.mainFrame };
  const state = { spec: { width: 10, height: 10, fps: 30 }, frames: 0, expected: 10, closing: false };
  backend.sessions.set(1, state);
  await assert.rejects(frame({ sender, senderFrame: {} }, {}), /Unknown export/);
  await assert.rejects(frame(event, { index: 1, bytes: new ArrayBuffer(24) }), /Invalid export frame/);
  const bytes = new Uint8Array(24); bytes.set([137,80,78,71,13,10,26,10]);
  new DataView(bytes.buffer).setUint32(16, 9); new DataView(bytes.buffer).setUint32(20, 10);
  await assert.rejects(frame(event, { index: 0, bytes: bytes.buffer }), /dimensions do not match/);
  await assert.rejects(handlers.get('windows-export:finish')(event), /frames are incomplete/);
});

test('cancelling export before initialization creates no window or partial output', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-export-cancel-'));
  try {
    const spec = path.join(folder, 'spec.json');
    await fs.writeFile(spec, JSON.stringify({ width: 100, height: 100, fps: 30, clips: [[0,1,1]], view: [] }));
    const backend = new WindowsExport({ electron: { ipcMain: { handle() {}, on() {} }, BrowserWindow: class { constructor() { throw new Error('Must not create a cancelled export window.'); } } } });
    const output = path.join(folder, 'output.mp4');
    const child = backend.start(['export','--source','unused.mp4','--spec',spec,'--out',output]);
    let messages = ''; child.stdout.on('data', bytes => { messages += bytes; });
    const closed = once(child, 'close'); child.stdin.write('cancel\n'); await closed;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(JSON.parse(messages).type, 'cancelled');
    await assert.rejects(fs.stat(output), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(folder), ['spec.json']);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});
