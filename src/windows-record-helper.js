const readline = require('node:readline');
const { mediaToolPath } = require('./platform');
const { importVideo, audioPeaks } = require('./windows-record-tools');
const controller = new AbortController();
const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (line.trim() === 'cancel') controller.abort();
});
const tools = {
  source: option('--source'), output: option('--out'), signal: controller.signal,
  ffmpeg: process.env.EMBER_FFMPEG_BIN || mediaToolPath('ffmpeg'),
  ffprobe: process.env.EMBER_FFPROBE_BIN || mediaToolPath('ffprobe'),
};
(async () => {
  if (!tools.source) throw new Error('No source file was supplied.');
  if (args[0] === 'import') emit(await importVideo(tools));
  else if (args[0] === 'peaks') emit(await audioPeaks({ ...tools, count: Number(option('--fps')) || 4000 }));
  else throw new Error(`Windows record operation is not implemented: ${args[0]}`);
})().then(() => process.exit(0)).catch(error => {
  emit({ type: controller.signal.aborted ? 'cancelled' : 'error', message: error.message });
  process.exit(1);
});
