// The menu bar icon: a small audio waveform, with a glowing red dot beside it while a call records.
// Drawn here at 2x with anti-aliasing so there are no image files to keep in sync.

const SCALE = 2;
const HEIGHT = 22;
const WAVE_WIDTH = 20;
const RECORDING_WIDTH = 34;
// Bar heights in points, left to right.
const BARS = [6, 12, 16, 10, 6];
const BAR_WIDTH = 2;
const BAR_GAP = 1.6;
const DOT = { x: 27, y: 11, radius: 3.1 };
const RED = [255, 69, 58];

function clamp(value) {
  return Math.min(1, Math.max(0, value));
}

// Distance from a point to a vertical capsule centred at (cx, cy).
function capsuleDistance(px, py, cx, cy, height, radius) {
  const half = Math.max(0, height / 2 - radius);
  const dy = Math.max(0, Math.abs(py - cy) - half);
  return Math.hypot(px - cx, dy) - radius;
}

function blend(pixels, offset, [r, g, b], alpha) {
  if (alpha <= 0) return;
  const existing = pixels[offset + 3] / 255;
  const out = alpha + existing * (1 - alpha);
  const mix = (channel, value) => Math.round((value * alpha + pixels[offset + channel] * existing * (1 - alpha)) / out);
  pixels[offset] = mix(0, r);
  pixels[offset + 1] = mix(1, g);
  pixels[offset + 2] = mix(2, b);
  pixels[offset + 3] = Math.round(out * 255);
}

function draw(widthPoints, paint) {
  const width = widthPoints * SCALE;
  const height = HEIGHT * SCALE;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      paint(pixels, (y * width + x) * 4, (x + 0.5) / SCALE, (y + 0.5) / SCALE);
    }
  }
  // Native bitmaps are BGRA with premultiplied alpha.
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const alpha = pixels[offset + 3] / 255;
    const red = pixels[offset];
    pixels[offset] = Math.round(pixels[offset + 2] * alpha);
    pixels[offset + 1] = Math.round(pixels[offset + 1] * alpha);
    pixels[offset + 2] = Math.round(red * alpha);
  }
  return { pixels, width, height };
}

function paintWave(pixels, offset, px, py, color) {
  const total = BARS.length * BAR_WIDTH + (BARS.length - 1) * BAR_GAP;
  let start = (WAVE_WIDTH - total) / 2 + BAR_WIDTH / 2;
  let coverage = 0;
  for (const bar of BARS) {
    const distance = capsuleDistance(px, py, start, HEIGHT / 2, bar, BAR_WIDTH / 2);
    coverage = Math.max(coverage, clamp(0.5 - distance * SCALE));
    start += BAR_WIDTH + BAR_GAP;
  }
  blend(pixels, offset, color, coverage);
}

// glow is 0..1: how far the soft halo reaches this frame.
function paintDot(pixels, offset, px, py, glow) {
  const distance = Math.hypot(px - DOT.x, py - DOT.y) - DOT.radius;
  if (distance > 0) {
    const sigma = 1.1 + glow * 1.3;
    blend(pixels, offset, RED, (0.28 + glow * 0.4) * Math.exp(-(distance * distance) / (2 * sigma * sigma)));
  }
  blend(pixels, offset, RED, clamp(0.5 - distance * SCALE));
}

function idleTrayImage(nativeImage) {
  const { pixels, width, height } = draw(WAVE_WIDTH, (data, offset, px, py) => paintWave(data, offset, px, py, [0, 0, 0]));
  const image = nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: SCALE });
  // A template image lets macOS tint the waveform for light and dark menu bars.
  image.setTemplateImage(true);
  return image;
}

// Frames of the recording icon. Colour can't live in a template image, so the waveform is drawn
// white or black to match the menu bar, and the glow breathes across the frames.
function recordingTrayFrames(nativeImage, { dark, frames = 12 }) {
  const wave = dark ? [255, 255, 255] : [0, 0, 0];
  return Array.from({ length: frames }, (_, index) => {
    const glow = 0.5 - 0.5 * Math.cos((index / frames) * Math.PI * 2);
    const { pixels, width, height } = draw(RECORDING_WIDTH, (data, offset, px, py) => {
      paintWave(data, offset, px, py, wave);
      paintDot(data, offset, px, py, glow);
    });
    return nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: SCALE });
  });
}

// Keeps the tray icon in step with the recording state.
class TrayIcon {
  constructor({ tray, nativeImage, nativeTheme, setInterval: every = setInterval, clearInterval: stop = clearInterval }) {
    this.tray = tray;
    this.nativeImage = nativeImage;
    this.nativeTheme = nativeTheme;
    this.every = every;
    this.stop = stop;
    this.idle = idleTrayImage(nativeImage);
    this.frames = null;
    this.timer = null;
    this.recording = false;
    tray.setImage(this.idle);
    nativeTheme?.on?.("updated", () => {
      this.frames = null;
      if (this.recording) this.#animate();
    });
  }

  setRecording(recording) {
    if (recording === this.recording) return;
    this.recording = recording;
    if (recording) this.#animate();
    else {
      this.stop(this.timer);
      this.timer = null;
      this.tray.setImage(this.idle);
    }
  }

  #animate() {
    this.stop(this.timer);
    this.frames ||= recordingTrayFrames(this.nativeImage, { dark: Boolean(this.nativeTheme?.shouldUseDarkColors) });
    let index = 0;
    this.tray.setImage(this.frames[0]);
    // One breath every ~1.8 s.
    this.timer = this.every(() => {
      index = (index + 1) % this.frames.length;
      this.tray.setImage(this.frames[index]);
    }, 150);
  }
}

module.exports = { TrayIcon, idleTrayImage, recordingTrayFrames };
