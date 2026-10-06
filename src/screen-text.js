// "Grab text from screen": pick an area with the system's crosshair, read it with Apple's Vision on
// this Mac, and put the text (or a QR code's link) on the clipboard. Also reads clipboard images.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const URL_PATTERN = /^(https?:\/\/|www\.)[^\s]+$/i;

function run(file, args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else resolve(stdout);
    });
  });
}

// Lines that wrap in the same column become one paragraph; a gap, a different indent, a list item or
// a short line ending a sentence starts a new one. With keepLineBreaks every line stays on its own.
function joinLines(lines, { keepLineBreaks = false } = {}) {
  const items = (lines || []).filter((line) => String(line?.text || "").trim());
  if (keepLineBreaks) return items.map((line) => line.text.trim()).join("\n");
  let text = "";
  let previous = null;
  let widest = 0;
  for (const line of items) {
    const current = line.text.trim();
    if (!previous) {
      text = current;
      widest = line.w;
      previous = line;
      continue;
    }
    const lineHeight = Math.max(previous.h, line.h, 1);
    const gap = line.y - (previous.y + previous.h);
    const sameColumn = Math.abs(line.x - previous.x) < lineHeight * 1.5;
    const endedEarly = /[.!?:]$/.test(previous.text.trim()) && previous.w < widest * 0.8;
    const listItem = /^([•\-–*·]|\d+[.)])\s/.test(current);
    const wraps = sameColumn && gap < lineHeight * 0.75 && gap > -lineHeight * 0.5 && !endedEarly && !listItem;
    if (wraps) {
      text = /[A-Za-z]-$/.test(text) ? `${text.slice(0, -1)}${current}` : `${text} ${current}`;
      widest = Math.max(widest, line.w);
    } else {
      text += gap > lineHeight * 0.75 ? `\n\n${current}` : `\n${current}`;
      widest = line.w;
    }
    previous = line;
  }
  return text;
}

// What a capture becomes on the clipboard: a QR code or barcode wins over the text around it.
function captureResult({ lines = [], codes = [] } = {}, options = {}) {
  const text = joinLines(lines, options);
  const code = codes[0];
  if (code && (!text || codes.length === 1)) {
    return { kind: URL_PATTERN.test(code.payload.trim()) ? "link" : code.kind === "qr" ? "qr" : "barcode", text: code.payload.trim(), codes };
  }
  if (!text) return null;
  return { kind: URL_PATTERN.test(text) ? "link" : "text", text, codes };
}

class ScreenText {
  constructor({ binary, read = null, capture = null, tempDir = os.tmpdir() }) {
    this.binary = binary;
    this.read = read;
    this.captureImage = capture;
    this.tempDir = tempDir;
    this.busy = false;
  }

  async #read(args) {
    if (this.read) return this.read(args);
    const stdout = await run(this.binary, args, { timeout: 90000 });
    const result = JSON.parse(stdout);
    if (result.error) throw new Error(result.error);
    return result;
  }

  // Lets the user drag over an area (Space switches to picking a window, Esc cancels). Returns null
  // when cancelled. Needs Screen Recording permission.
  async capture(options = {}) {
    if (this.busy) return null;
    this.busy = true;
    await fs.mkdir(this.tempDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.tempDir, `grab-${crypto.randomUUID()}.png`);
    try {
      if (this.captureImage) await this.captureImage(file);
      else await run("/usr/sbin/screencapture", ["-i", "-x", "-o", file], { timeout: 5 * 60000 }).catch(() => {});
      const exists = await fs.stat(file).then((stat) => stat.size > 0).catch(() => false);
      if (!exists) return null;
      return { ...(await this.#result(["file", file], options)) };
    } finally {
      this.busy = false;
      await fs.rm(file, { force: true });
    }
  }

  async fromFile(file, options = {}) {
    return this.#result(["file", file], options);
  }

  async fromClipboard(options = {}) {
    return this.#result(["clipboard"], options);
  }

  async #result(args, { keepLineBreaks = false, fast = false } = {}) {
    const read = await this.#read([...args, ...(fast ? ["--fast"] : [])]);
    return { result: captureResult(read, { keepLineBreaks }), lines: read.lines.length };
  }
}

module.exports = { ScreenText, captureResult, joinLines };
