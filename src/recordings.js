// Ember Record's library: each recording is a folder under userData/recordings with the MP4 and its
// poster frame, and recordings.json holds the title, transcript, summary and chapters.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const ID_PATTERN = /^\d{8}-\d{6}(-\d+)?$/;
const SAMPLE_RATE = 16000;

function pad(value) {
  return String(value).padStart(2, "0");
}

function newRecordingId(date = new Date(), taken = () => false) {
  const base = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  let id = base;
  for (let index = 2; taken(id); index += 1) id = `${base}-${index}`;
  return id;
}

/** 75 → "1:15", 3725 → "1:02:05". */
function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

function defaultTitle(date) {
  const when = new Date(date);
  return `Recording, ${when.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} at ${when.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

/** Mono WAV, 16-bit (as the record helper writes it) or 32-bit float, to Float32 samples. */
function wavToSamples(buffer) {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file.");
  }
  let offset = 12;
  let format = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = { channels: buffer.readUInt16LE(body + 2), rate: buffer.readUInt32LE(body + 4), bits: buffer.readUInt16LE(body + 14) };
    } else if (id === "data") {
      if (!format || format.channels !== 1 || ![16, 32].includes(format.bits)) throw new Error("Expected 16-bit or float mono audio.");
      const width = format.bits / 8;
      const count = Math.floor(Math.min(size, buffer.length - body) / width);
      const samples = new Float32Array(count);
      for (let index = 0; index < count; index += 1) {
        samples[index] = width === 2 ? buffer.readInt16LE(body + index * 2) / 32768 : buffer.readFloatLE(body + index * 4);
      }
      return { samples, rate: format.rate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("The WAV file has no audio.");
}

/** Pieces cut from one Float32Array (subarrays of it) to timed segments, dropping empty ones. */
function timedSegments(whole, pieces, texts, rate = SAMPLE_RATE) {
  const base = whole.byteOffset;
  return pieces
    .map((piece, index) => {
      const start = (piece.byteOffset - base) / Float32Array.BYTES_PER_ELEMENT / rate;
      return { start: round(start), end: round(start + piece.length / rate), text: String(texts[index] || "").trim() };
    })
    .filter((segment) => segment.text);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

const WRITE_UP_PROMPT = `You write up a screen recording someone made to share with others, like a Loom video: they show their screen and talk it through.
From the timestamped transcript, return only JSON:
{"title": "...", "summary": "...", "chapters": [{"start": 0, "title": "..."}]}
- title: 3 to 7 words naming what the recording shows or explains. No quotes, no trailing full stop, no "Recording of".
- summary: one to three plain sentences on what it covers and anything the viewer is asked to do. Written about the content ("Walks through…", "Shows…"), never "In this video".
- chapters: only when the recording is longer than 90 seconds and changes topic. 2 to 8 chapters in order, the first at 0, each start being a time in seconds where that part begins in the transcript, each title 2 to 5 words. Otherwise [].
Use the speaker's own terms. Never invent anything not in the transcript.`;

function writeUpPrompt(segments, duration) {
  const lines = segments.map((segment) => `[${formatClock(segment.start)}] ${segment.text}`);
  let transcript = lines.join("\n");
  // Long recordings: keep the start and end whole and thin out the middle.
  if (transcript.length > 30000) transcript = `${transcript.slice(0, 18000)}\n[…]\n${transcript.slice(-11000)}`;
  return `Length: ${formatClock(duration)}\n\nTranscript:\n${transcript}`;
}

/** The model's JSON, made safe: a short title, a summary, and chapters in order within the video. */
function parseWriteUp(object, duration) {
  const text = (value, max) => String(value || "").replace(/\s+/g, " ").trim().replace(/^["“']|["”']$/g, "").slice(0, max);
  const title = text(object?.title, 90).replace(/\.$/, "");
  const summary = text(object?.summary, 600);
  const chapters = [];
  for (const chapter of Array.isArray(object?.chapters) ? object.chapters : []) {
    const start = Number(chapter?.start);
    const name = text(chapter?.title, 60);
    if (!Number.isFinite(start) || start < 0 || !name) continue;
    if (duration && start >= duration) continue;
    if (chapters.length && start <= chapters.at(-1).start + 5) continue;
    chapters.push({ start: chapters.length ? Math.round(start) : 0, title: name });
  }
  return { title, summary, chapters: chapters.length >= 2 && duration > 90 ? chapters.slice(0, 8) : [] };
}

/** A share as the app shows it: never the password's hash. Out of date once a newer edit is exported. */
function publicShare(item) {
  const { password: _password, ...share } = item.share;
  // Outdated: the version it was shared as has been made again since.
  const exported = share.edited ? item.edited?.exportedAt : item.finished?.exportedAt;
  return { ...share, outdated: Boolean(exported && exported > share.sharedAt) };
}

class RecordingsStore {
  constructor({ dir }) {
    this.dir = dir;
    this.indexPath = path.join(dir, "recordings.json");
    this.items = {};
    this.folders = [];
    try {
      const data = JSON.parse(fs.readFileSync(this.indexPath, "utf8"));
      for (const [id, item] of Object.entries(data.recordings || {})) {
        if (ID_PATTERN.test(id)) this.items[id] = item;
      }
      this.folders = Array.isArray(data.folders) ? data.folders.filter((folder) => folder && typeof folder.id === "string") : [];
    } catch {}
    // Anything left mid-write-up when Ember quit is picked up again.
    for (const item of Object.values(this.items)) if (item.status === "processing") item.status = "pending";
  }

  folder(id) {
    if (!ID_PATTERN.test(String(id))) throw new Error("Unknown recording.");
    return path.join(this.dir, id);
  }

  file(id, kind) {
    const names = {
      video: "recording.mp4",
      thumb: "recording.jpg",
      wav: "recording.wav",
      cursor: "recording.cursor.json",
      camera: "recording.camera.mp4",
      system: "recording.system.m4a",
      project: "edit.json",
      edited: "edited.mp4",
      finished: "finished.mp4",
    };
    if (!names[kind]) throw new Error("Unknown file.");
    return path.join(this.folder(id), names[kind]);
  }

  newId(date = new Date()) {
    return newRecordingId(date, (id) => Boolean(this.items[id]) || fs.existsSync(path.join(this.dir, id)));
  }

  async save() {
    await fsp.mkdir(this.dir, { recursive: true });
    const temp = `${this.indexPath}.tmp`;
    await fsp.writeFile(temp, JSON.stringify({ version: 1, recordings: this.items, folders: this.folders }, null, 2), { mode: 0o600 });
    await fsp.rename(temp, this.indexPath);
  }

  get(id) {
    return this.items[id] || null;
  }

  async add(id, fields) {
    this.items[id] = { id, title: "", summary: "", chapters: [], transcript: [], status: "pending", ...fields };
    await this.save();
    return this.items[id];
  }

  async update(id, fields) {
    if (!this.items[id]) throw new Error("Unknown recording.");
    Object.assign(this.items[id], fields);
    await this.save();
    return this.items[id];
  }

  async remove(id, trash) {
    if (!this.items[id]) return;
    const folder = this.folder(id);
    delete this.items[id];
    await this.save();
    if (fs.existsSync(folder)) await (trash ? trash(folder) : fsp.rm(folder, { recursive: true, force: true }));
  }

  /* Folders */

  async createFolder(name, color) {
    const folder = { id: `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: String(name || "Folder").trim().slice(0, 60) || "Folder", color: /^#[0-9a-f]{6}$/i.test(color) ? color : "#ff7a2f" };
    this.folders.push(folder);
    await this.save();
    return folder;
  }

  async updateFolder(id, changes) {
    const folder = this.folders.find((item) => item.id === id);
    if (!folder) throw new Error("Unknown folder.");
    if (typeof changes.name === "string" && changes.name.trim()) folder.name = changes.name.trim().slice(0, 60);
    if (/^#[0-9a-f]{6}$/i.test(changes.color || "")) folder.color = changes.color;
    await this.save();
    return folder;
  }

  async deleteFolder(id) {
    this.folders = this.folders.filter((folder) => folder.id !== id);
    for (const item of Object.values(this.items)) if (item.folder === id) item.folder = null;
    await this.save();
  }

  /** Newest first, with display titles; the transcript only when asked for one recording. */
  list(query = "") {
    const needle = String(query).trim().toLowerCase();
    return Object.values(this.items)
      .map((item) => this.summaryOf(item))
      .filter((item) => !needle || `${item.title}\n${item.summary}\n${this.items[item.id].transcript.map((s) => s.text).join(" ")}`.toLowerCase().includes(needle))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  summaryOf(item) {
    return {
      id: item.id,
      title: item.title || defaultTitle(item.createdAt),
      summary: item.summary || "",
      createdAt: item.createdAt,
      duration: item.duration || 0,
      width: item.width || 0,
      height: item.height || 0,
      status: item.status,
      error: item.error || null,
      chapterCount: (item.chapters || []).length,
      hasThumb: fs.existsSync(path.join(this.dir, item.id, "recording.jpg")),
      // The edited version, when one has been exported and is still on disk.
      edited: item.edited && !item.edited.auto && fs.existsSync(path.join(this.dir, item.id, "edited.mp4")) ? item.edited : null,
      // The plain version (webcam and cursor added, nothing else): what the recording page shows and shares.
      finished: item.finished && fs.existsSync(path.join(this.dir, item.id, "finished.mp4")) ? item.finished : null,
      share: item.share ? publicShare(item) : null,
      // The webcam, recorded separately: where its bubble sat while recording.
      camera: fs.existsSync(path.join(this.dir, item.id, "recording.camera.mp4")) ? item.camera?.layout || { x: 0.1, y: 0.82, size: 0.28 } : null,
      folder: item.folder && this.folders.some((folder) => folder.id === item.folder) ? item.folder : null,
      editedAt: item.editedAt || item.createdAt,
    };
  }

  detail(id) {
    const item = this.items[id];
    if (!item) return null;
    return { ...this.summaryOf(item), chapters: item.chapters || [], transcript: item.transcript || [], source: item.source || "" };
  }
}

module.exports = {
  RecordingsStore,
  ID_PATTERN,
  WRITE_UP_PROMPT,
  defaultTitle,
  formatClock,
  newRecordingId,
  parseWriteUp,
  timedSegments,
  wavToSamples,
  writeUpPrompt,
};
