const { EventEmitter } = require('node:events');
const { PassThrough, Readable } = require('node:stream');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { clipsOf, renderExportAudio } = require('./windows-export-audio');
const { probe } = require('./windows-record-tools');

async function mediaResponse(request, files) {
  const file = files.get(request.url.split('?')[0]);
  if (!file) return new Response('Not found', { status: 404 });
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
  const size = (await fsp.stat(file)).size;
  const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': /\.webm$/i.test(file) ? 'video/webm' : 'video/mp4' };
  const range = request.headers.get('range');
  let start = 0, end = size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    if (match[1]) { start = Number(match[1]); end = match[2] ? Math.min(end, Number(match[2])) : end; }
    else start = Math.max(0, size - Number(match[2]));
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(Math.max(0, end - start + 1));
  return new Response(request.method === 'HEAD' || !size ? null : Readable.toWeb(fs.createReadStream(file, { start, end })), { status: range ? 206 : 200, headers });
}
function parseArgs(args) {
  const values = {};
  for (let index = 1; index < args.length; index += 2) values[args[index]] = args[index + 1];
  return values;
}
class WindowsExport {
  constructor({ electron, rendererDir, getFfmpeg, getFfprobe }) {
    Object.assign(this, { electron, rendererDir, getFfmpeg, getFfprobe });
    this.sessions = new Map();
    const authorize = event => {
      const state = this.sessions.get(event.sender.id);
      if (!state || event.senderFrame !== event.sender.mainFrame || state.closing) throw new Error('Unknown export session.');
      return state;
    };
    electron.ipcMain.handle('windows-export:config', event => authorize(event).config);
    electron.ipcMain.handle('windows-export:frame', async (event, { index, bytes }) => {
      const state = authorize(event), spec = state.spec;
      if (state.finishing || state.writing || index !== state.frames || index >= state.expected || !(bytes instanceof ArrayBuffer) || bytes.byteLength < 24 || bytes.byteLength > spec.width * spec.height * 4 + 1048576) throw new Error('Invalid export frame.');
      const frame = Buffer.from(bytes);
      if (!frame.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || frame.readUInt32BE(16) !== spec.width || frame.readUInt32BE(20) !== spec.height) throw new Error('Export frame dimensions do not match.');
      state.writing = true;
      try {
        await new Promise((resolve, reject) => state.encoder.stdin.write(frame, error => error ? reject(error) : resolve()));
        state.controller.signal.throwIfAborted(); state.frames++;
        if (state.frames % Math.max(1, spec.fps) === 0 || state.frames === state.expected) this.emit(state, { type: 'progress', value: 0.9 * state.frames / state.expected });
      } catch (error) { void this.fail(state, error); throw error; }
      finally { state.writing = false; }
    });
    electron.ipcMain.handle('windows-export:finish', event => this.finish(authorize(event)));
    electron.ipcMain.on('windows-export:error', (event, message) => { try { void this.fail(authorize(event), new Error(String(message).slice(0, 2000))); } catch {} });
  }
  start(args) {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    const state = { child, controller: new AbortController(), frames: 0, closing: false, finishing: false, writing: false };
    child.kill = () => { void this.cancel(state); return true; };
    let input = '';
    child.stdin.on('data', bytes => { input += bytes; let at; while ((at = input.indexOf('\n')) >= 0) { const command = input.slice(0, at).trim(); input = input.slice(at + 1); if (command === 'cancel') void this.cancel(state); } });
    void this.initialize(state, parseArgs(args)).catch(error => this.fail(state, error));
    return child;
  }
  async initialize(state, options) {
    state.output = options['--out'];
    if (!state.output || !options['--source'] || !options['--spec']) throw new Error('The export is missing its files.');
    const spec = JSON.parse(await fsp.readFile(options['--spec'], 'utf8'));
    const duration = clipsOf(spec).reduce((sum, clip) => sum + clip.duration, 0);
    if (![spec.width, spec.height, spec.fps].every(value => Number.isInteger(value) && value > 0) || spec.width > 8192 || spec.height > 8192 || spec.fps > 120 || !Array.isArray(spec.view)) throw new Error('Invalid export dimensions or timing.');
    state.spec = spec; state.expected = Math.ceil(duration * spec.fps);
    state.controller.signal.throwIfAborted();
    await fsp.mkdir(path.dirname(state.output), { recursive: true });
    state.staging = await fsp.mkdtemp(path.join(path.dirname(state.output), '.export-'));
    if (state.closing) { await fsp.rm(state.staging, { recursive: true, force: true, maxRetries: 5 }); return; }
    const audio = path.join(state.staging, 'audio.wav');
    const ffmpeg = this.getFfmpeg(), ffprobe = this.getFfprobe();
    if (!spec.gif) await renderExportAudio({ spec, source: options['--source'], system: options['--system-source'], output: audio, ffmpeg, ffprobe, signal: state.controller.signal });
    state.controller.signal.throwIfAborted();
    const files = new Map();
    const url = file => { if (!file) return null; const key = `ember-export://media/${files.size}`; files.set(key, file); return key; };
    state.config = { spec: { ...spec, sourceFiles: undefined, audio: undefined }, duration, sources: [options['--source'], ...(spec.sourceFiles || [])].map(url), camera: url(options['--camera-source']), background: url(options['--background-video']) };
    const session = this.electron.session.fromPartition(`ember-export-${randomUUID()}`);
    state.session = session; session.protocol.handle('ember-export', request => mediaResponse(request, files));
    state.encoded = path.join(state.staging, spec.gif ? 'video.gif' : 'video.mp4');
    const base = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(spec.fps), '-i', 'pipe:0'];
    const encoding = spec.gif
      ? ['-filter_complex', `[0:v]fps=${spec.gif.fps},scale=${spec.gif.width}:-1:flags=lanczos,split[a][b];[a]palettegen=reserve_transparent=0[p];[b][p]paletteuse=dither=sierra2_4a[out]`, '-map', '[out]', '-loop', spec.gif.loop ? '0' : '-1', '-t', String(duration)]
      : ['-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-preset', spec.encoding === 'quality' ? 'medium' : 'veryfast', '-crf', spec.encoding === 'fast' ? '23' : '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-t', String(duration), '-movflags', '+faststart'];
    state.encoder = spawn(ffmpeg, [...base, ...encoding, state.encoded], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let errorText = '';
    state.encoder.stderr.on('data', bytes => { errorText = (errorText + bytes).slice(-8000); });
    state.encoder.stdin.on('error', error => { if (!state.closing) void this.fail(state, error); });
    state.encoderDone = new Promise((resolve, reject) => { state.encoder.once('error', reject); state.encoder.once('close', code => code === 0 ? resolve() : reject(new Error(errorText || `Video encoder stopped (${code}).`))); });
    state.encoderDone.catch(error => { if (!state.closing) void this.fail(state, error); });
    const window = new this.electron.BrowserWindow({ show: false, focusable: false, skipTaskbar: true, webPreferences: { session, preload: path.join(__dirname, 'windows-export-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    state.window = window; this.sessions.set(window.webContents.id, state);
    window.webContents.on('render-process-gone', () => { if (!state.closing) void this.fail(state, new Error('The export renderer stopped.')); });
    window.on('closed', () => { if (!state.closing) void this.fail(state, new Error('The export window closed.')); });
    await window.loadFile(path.join(this.rendererDir, 'export.html'));
  }
  emit(state, message) { if (!state.child.stdout.destroyed) state.child.stdout.write(JSON.stringify(message) + '\n'); }
  async finish(state) {
    if (state.finishing || state.writing || state.frames !== state.expected) throw new Error('Export frames are incomplete.');
    state.finishing = true; state.encoder.stdin.end();
    try {
      await state.encoderDone; state.controller.signal.throwIfAborted();
      const info = await probe(this.getFfprobe(), state.encoded, state.controller.signal);
      const video = info.streams.find(stream => stream.codec_type === 'video');
      if (!video?.width || !video.height) throw new Error('The encoded export could not be read.');
      state.controller.signal.throwIfAborted();
      await fsp.rename(state.encoded, state.output);
      this.emit(state, { type: 'done', file: state.output, duration: Number(info.format?.duration) || state.config.duration, width: video.width, height: video.height });
      await this.close(state, 0);
    } catch (error) { await this.fail(state, error); }
  }
  async cancel(state) { if (!state.closing) { state.controller.abort(); await this.fail(state, new Error('Cancelled.')); } }
  async fail(state, error) {
    if (state.closing) return;
    this.emit(state, { type: state.controller.signal.aborted ? 'cancelled' : 'error', message: error.message });
    await this.close(state, 1);
  }
  async close(state, code) {
    if (state.closing) return; state.closing = true; state.controller.abort();
    if (state.window) { this.sessions.delete(state.window.webContents.id); if (!state.window.isDestroyed()) state.window.destroy(); }
    state.session?.protocol.unhandle('ember-export');
    if (state.encoder && state.encoder.exitCode === null) { state.encoder.stdin.destroy(); state.encoder.kill('SIGKILL'); await state.encoderDone.catch(() => {}); }
    if (state.staging) await fsp.rm(state.staging, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    state.child.stdout.end(); state.child.stderr.end(); state.child.emit('close', code);
  }
}
module.exports = { WindowsExport, mediaResponse };
