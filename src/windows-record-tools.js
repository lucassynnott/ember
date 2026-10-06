const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runCommand } = require('./transcription');

async function probe(ffprobe, file, signal) {
  const { stdout } = await runCommand(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { signal });
  return JSON.parse(stdout);
}

async function importVideo({ source, output, ffmpeg, ffprobe, signal }) {
  const original = await probe(ffprobe, source, signal);
  if (!original.streams?.some(stream => stream.codec_type === 'video')) throw new Error('That file has no video Ember can read.');
  const folder = path.dirname(output);
  await fs.mkdir(folder, { recursive: true });
  const staging = await fs.mkdtemp(path.join(folder, '.import-'));
  const video = path.join(staging, 'video.mp4');
  const thumb = output.replace(/\.[^.]+$/, '.jpg');
  const wav = output.replace(/\.[^.]+$/, '.wav');
  const base = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
  try {
    await runCommand(ffmpeg, [...base, '-i', source, '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', video], { signal });
    const converted = await probe(ffprobe, video, signal);
    const track = converted.streams.find(stream => stream.codec_type === 'video');
    const duration = Number(converted.format?.duration);
    if (!(duration > 0) || !(track?.width > 0) || !(track?.height > 0)) throw new Error('The converted video could not be read.');
    const stagedThumb = path.join(staging, 'thumb.jpg');
    const stagedWav = path.join(staging, 'audio.wav');
    await runCommand(ffmpeg, [...base, '-i', video, '-frames:v', '1', '-vf', 'scale=640:-1', stagedThumb], { signal });
    const audio = converted.streams.some(stream => stream.codec_type === 'audio')
      ? ['-i', video, '-map', '0:a:0']
      : ['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', String(duration)];
    await runCommand(ffmpeg, [...base, ...audio, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', stagedWav], { signal });
    signal?.throwIfAborted();
    await fs.rename(stagedThumb, thumb);
    await fs.rename(stagedWav, wav);
    await fs.rename(video, output);
    return { type: 'done', file: output, thumb, wav, duration, width: track.width, height: track.height };
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

// Decode to disk so waveform extraction has bounded memory even for long recordings.
async function audioPeaks({ source, count = 4000, ffmpeg, ffprobe, signal }) {
  const info = await probe(ffprobe, source, signal);
  if (!info.streams?.some(stream => stream.codec_type === 'audio')) return [];
  const buckets = Math.max(1, Math.min(20000, Math.floor(Number(count) || 4000)));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ember-peaks-'));
  const raw = path.join(directory, 'samples.pcm');
  try {
    await runCommand(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '8000', '-c:a', 'pcm_s16le', '-f', 's16le', raw], { signal });
    const samples = Math.floor((await fs.stat(raw)).size / 2);
    const size = Math.max(1, Math.floor(samples / buckets));
    const peaks = new Array(buckets).fill(0);
    const handle = await fs.open(raw, 'r');
    try {
      const buffer = Buffer.alloc(65536);
      let sample = 0;
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        for (let offset = 0; offset + 1 < bytesRead; offset += 2, sample++) {
          const bucket = Math.floor(sample / size);
          if (bucket < buckets) peaks[bucket] = Math.max(peaks[bucket], Math.abs(buffer.readInt16LE(offset)));
        }
      }
    } finally { await handle.close(); }
    const loudest = Math.max(1, ...peaks);
    return peaks.map(peak => Math.round(peak / loudest * 1000) / 1000);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
module.exports = { probe, importVideo, audioPeaks };
