const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { JpegFrames, desktopArgs, DesktopFrames } = require('../src/windows-desktop-frames');
const jpeg = Buffer.from([255,216,1,2,3,255,217]);
test('Desktop JPEG frames tolerate split markers and discard bounded framing noise', () => {
  const frames = []; const parser = new JpegFrames({ onFrame: frame => frames.push(frame) });
  const bytes = Buffer.concat([Buffer.from('noise'), jpeg, jpeg]);
  for (const byte of bytes) parser.write(Buffer.from([byte]));
  assert.deepEqual(frames, [jpeg, jpeg]);
  assert.ok(parser.buffer.length <= 1);
  assert.throws(() => new JpegFrames({ maxBytes: 4 }).write(jpeg), /capture limit/);
});
test('Desktop capture requests omit cursor composition and preserve negative monitor coordinates', () => {
  const args = desktopArgs({ x: -1920, y: -100, width: 1920, height: 1080 });
  assert.equal(args[args.indexOf('-draw_mouse') + 1], '0');
  assert.equal(args[args.indexOf('-offset_x') + 1], '-1920');
  assert.throws(() => desktopArgs({ x: 0, y: 0, width: NaN, height: 1080 }));
});
test('Desktop frame delivery drops stale frames and cancels pending requests', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() { queueMicrotask(() => this.emit('close', 1)); } });
  const capture = new DesktopFrames('fixture', { x: 0, y: 0, width: 2, height: 2 }, { spawnProcess: () => child });
  const first = capture.nextFrame(); child.stdout.write(jpeg); assert.deepEqual(await first, jpeg);
  child.stdout.write(Buffer.concat([jpeg, jpeg])); assert.deepEqual(await capture.nextFrame(), jpeg); assert.equal(capture.delivered, 3);
  const pending = capture.nextFrame(); const rejection = assert.rejects(pending, /cancelled/); await capture.close(); await rejection;
});

test('Desktop frame transport reads actual FFmpeg JPEG output', async () => {
  const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
  const capture = new DesktopFrames(ffmpeg, { x: 0, y: 0, width: 64, height: 48 }, { args: ['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:size=64x48:rate=10','-frames:v','3','-threads','1','-c:v','mjpeg','-f','image2pipe','pipe:1'] });
  try {
    const frame = await capture.nextFrame();
    assert.equal(frame.readUInt16BE(0), 0xffd8);
    assert.equal(frame.readUInt16BE(frame.length-2), 0xffd9);
    assert.ok(frame.length > 100);
    await capture.closed;
    assert.equal(capture.sequence, 3);
  } finally { await capture.close(); }
});

test('Cancelled desktop capture rejects late frames and additional reads', async () => {
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill(){queueMicrotask(()=>this.emit('close',1));}});
  const capture=new DesktopFrames('fixture',{x:0,y:0,width:2,height:2},{spawnProcess:()=>child});
  await capture.close();
  child.stdout.write(jpeg);
  assert.equal(capture.latest,null);
  await assert.rejects(capture.nextFrame(),/cancelled/);
});


test('A failed desktop source cannot deliver its cached last frame', async () => {
  const child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),kill(){queueMicrotask(()=>this.emit('close',1));}});
  const capture=new DesktopFrames('fixture',{x:0,y:0,width:2,height:2},{spawnProcess:()=>child});
  child.stdout.write(jpeg);
  child.stderr.write('Desktop source disconnected');
  child.emit('close',1);
  await capture.closed;
  await assert.rejects(capture.nextFrame(),/Desktop source disconnected/);
  assert.equal(capture.latest,null);
});
