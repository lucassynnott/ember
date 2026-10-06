const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { importVideo, audioPeaks, probe } = require('../src/windows-record-tools');
const { runCommand } = require('../src/transcription');
const { mediaToolPath } = require('../src/platform');
const ffmpeg = process.env.FFMPEG_BIN || mediaToolPath('ffmpeg');
const ffprobe = process.env.FFPROBE_BIN || mediaToolPath('ffprobe');

test('imports WebM video into decodable editor media and produces a normalized waveform', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-import-'));
  try {
    const source = path.join(directory, 'source with spaces.webm');
    const output = path.join(directory, 'recording.mp4');
    await runCommand(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000', '-t', '0.6', '-c:v', 'libvpx', '-c:a', 'libopus', source]);
    const done = await importVideo({ source, output, ffmpeg, ffprobe });
    assert.equal(done.type, 'done');
    assert.equal(done.width, 160);
    assert.equal(done.height, 90);
    assert.ok(done.duration >= 0.5 && done.duration < 1);
    const audio = (await probe(ffprobe, done.wav)).streams[0];
    assert.equal(audio.codec_name, 'pcm_s16le');
    assert.equal(audio.sample_rate, '16000');
    await runCommand(ffmpeg, ['-v', 'error', '-i', output, '-f', 'null', '-']);
    assert.ok((await fs.stat(done.thumb)).size > 100);
    const peaks = await audioPeaks({ source: output, count: 30, ffmpeg, ffprobe });
    assert.equal(peaks.length, 30);
    assert.equal(Math.max(...peaks), 1);
    assert.ok(peaks.every(value => value >= 0 && value <= 1));
    const { stdout } = await promisify(execFile)(process.execPath, [path.join(__dirname, '../src/windows-record-helper.js'), 'peaks', '--source', output, '--fps', '30'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', EMBER_FFMPEG_BIN: ffmpeg, EMBER_FFPROBE_BIN: ffprobe } });
    assert.deepEqual(JSON.parse(stdout), peaks);
    assert.ok(!(await fs.readdir(directory)).some(name => name.startsWith('.import-')));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('imports silent videos with a notes WAV and rejects audio-only files without leaving output', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-import-silent-'));
  try {
    const source = path.join(directory, 'silent.mkv');
    const output = path.join(directory, 'recording.mp4');
    await runCommand(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10', '-t', '0.5', source]);
    const done = await importVideo({ source, output, ffmpeg, ffprobe });
    assert.ok((await fs.stat(done.wav)).size > 16000);
    assert.deepEqual(await audioPeaks({ source: output, ffmpeg, ffprobe }), []);
    const rejected = path.join(directory, 'not-video.mp4');
    await assert.rejects(importVideo({ source: done.wav, output: rejected, ffmpeg, ffprobe }), /no video/);
    await assert.rejects(fs.stat(rejected), { code: 'ENOENT' });
    const abort = new AbortController(); abort.abort();
    await assert.rejects(importVideo({ source, output: rejected, ffmpeg, ffprobe, signal: abort.signal }), /abort/i);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
