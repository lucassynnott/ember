const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { clipsOf, tempo, renderExportAudio } = require('../src/windows-export-audio');
const { probe } = require('../src/windows-record-tools');
const { runCommand } = require('../src/transcription');
const { mediaToolPath } = require('../src/platform');
const ffmpeg = process.env.FFMPEG_BIN || mediaToolPath('ffmpeg');
const ffprobe = process.env.FFPROBE_BIN || mediaToolPath('ffprobe');
async function tone(file, frequency) {
  await runCommand(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=1.5`, '-c:a', 'pcm_s16le', file]);
}
async function samples(file) {
  const { stdout } = await promisify(execFile)(ffmpeg, ['-v', 'error', '-i', file, '-ac', '1', '-f', 'f32le', '-'], { encoding: 'buffer', maxBuffer: 4e6 });
  return Array.from({ length: stdout.length / 4 }, (_, index) => stdout.readFloatLE(index * 4));
}
function amplitude(pcm, frequency, start, end) {
  const from = Math.ceil(start * 48000), to = Math.floor(end * 48000);
  let sine = 0, cosine = 0;
  for (let index = from; index < to; index++) {
    const phase = 2 * Math.PI * frequency * index / 48000;
    sine += pcm[index] * Math.sin(phase); cosine += pcm[index] * Math.cos(phase);
  }
  return 2 * Math.hypot(sine, cosine) / (to - from);
}

test('export audio preserves clip timing, pitch, source changes, system gaps and independently added sound', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-export-audio-'));
  try {
    const own = path.join(directory, 'own.wav'), other = path.join(directory, 'other.wav');
    const system = path.join(directory, 'system.wav'), extra = path.join(directory, 'extra.wav');
    await tone(own, 440); await tone(other, 880); await tone(system, 660); await tone(extra, 1100);
    const output = path.join(directory, 'export.wav');
    const spec = { clips: [[0.2, 0.6, 1, 0], [0.1, 0.5, 2, 1], [0.6, 1, 1, 0]], sourceFiles: [other], audio: {
      volume: 0.8, systemVolume: 0.4, muted: [[0.2, 0.32]], extras: [{ file: extra, start: 0.2, offset: 0.1, duration: 0.12, volume: 0.5 }],
    } };
    const result = await renderExportAudio({ spec, source: own, system, output, ffmpeg, ffprobe });
    assert.ok(Math.abs(result.duration - 1) < 1e-9);
    const info = await probe(ffprobe, output);
    assert.equal(info.streams[0].sample_rate, '48000');
    assert.equal(info.streams[0].channels, 2);
    assert.ok(Math.abs(Number(info.format.duration) - 1) < 0.002);
    const pcm = await samples(output);
    assert.ok(amplitude(pcm, 440, 0.04, 0.14) > 0.06, 'microphone keeps its volume');
    assert.ok(amplitude(pcm, 660, 0.04, 0.14) > 0.025, 'system audio remains separate in the mix');
    assert.ok(amplitude(pcm, 880, 0.45, 0.55) > 0.06, 'sped-up source preserves pitch');
    assert.ok(amplitude(pcm, 660, 0.45, 0.55) < 0.005, 'another recording does not inherit system audio');
    assert.ok(amplitude(pcm, 440, 0.24, 0.29) < 0.003, 'mute applies on the edited timeline');
    assert.ok(amplitude(pcm, 1100, 0.24, 0.29) > 0.035, `added audio continues over muted recording clips: ${amplitude(pcm, 1100, 0.24, 0.29)}`);
    assert.ok(!(await fs.readdir(directory)).some(name => name.startsWith('.export-audio-')));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('exports valid silence for a source without audio and validates clip speeds', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-export-silent-'));
  try {
    const source = path.join(directory, 'silent.mp4'), output = path.join(directory, 'export.wav');
    await runCommand(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=160x90:r=10:d=0.6', source]);
    await renderExportAudio({ spec: { clips: [[0, 0.4, 1]] }, source, output, ffmpeg, ffprobe });
    assert.ok((await samples(output)).every(value => value === 0));
    assert.throws(() => clipsOf({ clips: [[0, 1, 0]] }), /invalid clip/);
    assert.throws(() => clipsOf({ clips: [[0, 1, -1]] }), /invalid clip/);
    assert.deepEqual(tempo(8), ['atempo=2', 'atempo=2', 'atempo=2']);
    assert.deepEqual(tempo(0.125), ['atempo=0.5', 'atempo=0.5', 'atempo=0.5']);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
