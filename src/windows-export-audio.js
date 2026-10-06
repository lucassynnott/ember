const fs = require('node:fs/promises');
const path = require('node:path');
const { probe } = require('./windows-record-tools');
const { runCommand } = require('./transcription');

const number = value => Number(value).toFixed(9).replace(/\.?0+$/, '') || '0';
const volume = value => Math.max(0, Math.min(2, Number.isFinite(value) ? value : 1));
function clipsOf(spec) {
  if (!Array.isArray(spec?.clips) || !spec.clips.length) throw new Error('There are no clips to export.');
  return spec.clips.map(clip => {
    const [start, end, speed, source = 0] = clip;
    if (![start, end, speed, source].every(Number.isFinite) || start < 0 || end <= start || speed <= 0 || !Number.isInteger(source) || source < 0) throw new Error('The export contains an invalid clip.');
    const duration = (end - start) / speed;
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("The export contains an invalid clip duration.");
    return { start, end, speed, source, duration };
  });
}
function tempo(speed) {
  if (speed === 1) return [];
  const filters = [];
  while (speed > 2) { filters.push('atempo=2'); speed /= 2; }
  while (speed < 0.5) { filters.push('atempo=0.5'); speed *= 2; }
  filters.push(`atempo=${number(speed)}`);
  return filters;
}

function audioPlan(spec, { sources, system, extras }) {
  const clips = clipsOf(spec);
  const duration = clips.reduce((sum, clip) => sum + clip.duration, 0);
  const files = [];
  const inputs = new Map();
  const chains = [];
  let serial = 0;
  const tag = () => `a${serial++}`;
  const references = new Map();
  const input = metadata => {
    if (!inputs.has(metadata.file)) { inputs.set(metadata.file, files.length); files.push(metadata.file); }
    const alias = tag();
    const list = references.get(metadata.file) || [];
    list.push(alias); references.set(metadata.file, list);
    return alias;
  };
  const silence = length => {
    const label = tag();
    chains.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${number(length)},asetpts=PTS-STARTPTS[${label}]`);
    return label;
  };
  const segment = (metadata, start, end, speed, length) => {
    if (!metadata?.audio || start >= metadata.duration) return silence(length);
    const stream = input(metadata);
    const label = tag();
    chains.push(`[${stream}]asetpts=PTS-STARTPTS,atrim=start=${number(start)}:end=${number(Math.min(end, metadata.duration))},asetpts=PTS-STARTPTS,${tempo(speed).map(filter => filter + ',').join('')}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_len=${Math.round(length * 48000)},atrim=end_sample=${Math.round(length * 48000)},asetpts=N/SR/TB[${label}]`);
    return label;
  };
  const muted = (spec.audio?.muted || []).filter(range => Array.isArray(range) && range.length === 2 && range.every(Number.isFinite) && range[1] > range[0]);
  const track = (labels, level, mute) => {
    const joined = tag();
    chains.push(`${labels.map(label => `[${label}]`).join('')}concat=n=${labels.length}:v=0:a=1,aresample=48000,asetpts=N/SR/TB,volume=${number(volume(level))}${mute ? muted.map(([from, to]) => `,volume=0:enable='gte(t,${number(Math.max(0, from))})*lt(t,${number(to)})'`).join('') : ''}[${joined}]`);
    return joined;
  };
  for (const clip of clips) if (!sources[clip.source]) throw new Error('A clip source is missing from the export.');
  const tracks = [];
  const microphone = clips.map(clip => segment(sources[clip.source], clip.start, clip.end, clip.speed, clip.duration));
  tracks.push(track(microphone, spec.audio?.volume, true));
  if (system?.audio) {
    const labels = clips.map(clip => clip.source === 0 ? segment(system, clip.start, clip.end, clip.speed, clip.duration) : silence(clip.duration));
    tracks.push(track(labels, spec.audio?.systemVolume, true));
  }
  for (const extra of extras) {
    const { metadata, block } = extra;
    if (!metadata.audio) continue;
    const start = Math.max(0, Number(block.start) || 0);
    const offset = Math.max(0, Number(block.offset) || 0);
    const length = Math.min(Number(block.duration) || 0, metadata.duration - offset, duration - start);
    if (length <= 0.05) continue;
    const label = segment(metadata, offset, offset + length, 1, length);
    const delayed = tag();
    chains.push(`[${label}]volume=${number(volume(block.volume))},adelay=${Math.round(start * 48000)}S:all=1,apad=whole_len=${Math.round(duration * 48000)},atrim=end_sample=${Math.round(duration * 48000)},asetpts=N/SR/TB[${delayed}]`);
    tracks.push(delayed);
  }
  const prefixes = [];
  for (const [file, labels] of references) prefixes.push(`[${inputs.get(file)}:a:0]asplit=${labels.length}${labels.map(label => `[${label}]`).join('')}`);
  chains.push(`${tracks.map(label => `[${label}]`).join('')}amix=inputs=${tracks.length}:duration=longest:normalize=0:dropout_transition=0,atrim=end_sample=${Math.round(duration * 48000)}[out]`);
  return { files, duration, graph: prefixes.concat(chains).join(';\n') };
}

async function renderExportAudio({ spec, source, system, output, ffmpeg, ffprobe, signal }) {
  const cache = new Map();
  const metadata = async file => {
    if (!cache.has(file)) cache.set(file, probe(ffprobe, file, signal).then(info => ({ file, audio: info.streams.some(stream => stream.codec_type === 'audio'), duration: Number(info.format?.duration) || 0 })));
    return cache.get(file);
  };
  const sources = await Promise.all([source, ...(spec.sourceFiles || [])].map(metadata));
  const systemInfo = system ? await metadata(system) : null;
  const extras = await Promise.all((spec.audio?.extras || []).map(async block => ({ block, metadata: await metadata(block.file) })));
  const plan = audioPlan(spec, { sources, system: systemInfo, extras });
  await fs.mkdir(path.dirname(output), { recursive: true });
  const staging = await fs.mkdtemp(path.join(path.dirname(output), '.export-audio-'));
  try {
    const graph = path.join(staging, 'filters.txt');
    const wav = path.join(staging, 'audio.wav');
    await fs.writeFile(graph, plan.graph);
    await runCommand(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...plan.files.flatMap(file => ['-i', file]), '-filter_complex_script', graph, '-map', '[out]', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', wav], { signal });
    signal?.throwIfAborted();
    await fs.rename(wav, output);
    return { file: output, duration: plan.duration };
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
module.exports = { clipsOf, tempo, audioPlan, renderExportAudio };
