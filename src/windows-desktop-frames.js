const { spawn } = require('node:child_process');

// Only the latest complete JPEG is retained, keeping capture independent of renderer speed.
class JpegFrames {
  constructor({ maxBytes = 32 * 1024 * 1024, onFrame = () => {} } = {}) {
    this.maxBytes = maxBytes; this.onFrame = onFrame; this.buffer = Buffer.alloc(0);
  }
  write(bytes) {
    this.buffer = Buffer.concat([this.buffer, bytes]);
    for (;;) {
      const start = this.buffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) { this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 1)); return; }
      if (start) this.buffer = this.buffer.subarray(start);
      const end = this.buffer.indexOf(Buffer.from([0xff, 0xd9]), 2);
      if (end < 0) { if (this.buffer.length > this.maxBytes) throw new Error('Desktop frame exceeds the capture limit.'); return; }
      const length = end + 2;
      if (length > this.maxBytes) throw new Error('Desktop frame exceeds the capture limit.');
      this.onFrame(Buffer.from(this.buffer.subarray(0, length)));
      this.buffer = this.buffer.subarray(length);
    }
  }
}
function desktopArgs({ x, y, width, height, fps = 30 }) {
  if (![x, y, width, height, fps].every(Number.isInteger) || width < 2 || height < 2 || width > 16384 || height > 16384 || fps < 1 || fps > 60) throw new Error('Invalid desktop capture rectangle.');
  return ['-hide_banner', '-loglevel', 'error', '-f', 'gdigrab', '-draw_mouse', '0', '-framerate', String(fps), '-offset_x', String(x), '-offset_y', String(y), '-video_size', `${width}x${height}`, '-i', 'desktop', '-an', '-c:v', 'mjpeg', '-q:v', '2', '-f', 'image2pipe', 'pipe:1'];
}
class DesktopFrames {
  constructor(binary, rectangle, { spawnProcess = spawn, args = desktopArgs(rectangle) } = {}) {
    this.sequence = 0; this.delivered = 0; this.latest = null; this.pending = null; this.error = null; this.stderr = '';
    this.child = spawnProcess(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const parser = new JpegFrames({ onFrame: bytes => {
      if (this.error) return;
      this.latest = bytes; this.sequence++;
      if (this.pending) { const pending = this.pending; this.pending = null; this.delivered = this.sequence; pending.resolve(bytes); }
    } });
    this.child.stdout.on('data', bytes => { try { parser.write(bytes); } catch (error) { this.fail(error); this.child.kill('SIGKILL'); } });
    this.child.stderr.on('data', bytes => { this.stderr = (this.stderr + bytes.toString()).slice(-8000); });
    this.child.once('error', error => this.fail(error));
    this.closed = new Promise(resolve => this.child.once('close', code => { this.fail(new Error(this.stderr || `Desktop capture ended (${code}).`)); resolve(); }));
  }
  fail(error) { this.error ||= error; this.latest = null; if (this.pending) { this.pending.reject(this.error); this.pending = null; } }
  nextFrame() {
    if (this.latest && this.sequence > this.delivered) { this.delivered = this.sequence; return Promise.resolve(this.latest); }
    if (this.error) return Promise.reject(this.error);
    if (this.pending) return Promise.reject(new Error('A desktop frame request is already pending.'));
    return new Promise((resolve, reject) => { this.pending = { resolve, reject }; });
  }
  close() { this.latest = null; this.fail(new Error('Desktop capture cancelled.')); this.child.kill('SIGKILL'); return this.closed; }
}
module.exports = { JpegFrames, desktopArgs, DesktopFrames };
