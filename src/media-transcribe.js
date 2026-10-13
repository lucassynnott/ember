// Any video or audio file to a transcript with every word timed, on this Mac with Parakeet, and the transcript in
// the formats editing tools and AI models read: Whisper-style JSON with word timings, SRT, VTT, plain text, and a
// compact word list (a third the size of the JSON, for handing to an AI that edits the video by its words).
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const { splitForTranscription } = require("./dictation");
const { LiveParakeetTranscriber } = require("./live-transcription");
const { MODELS_DIR } = require("./model-manager");
const { offsetWords } = require("./word-align");
const { findParakeet, readWav } = require("./word-timing");

const RATE = 16000;
const FORMATS = {
  json: { ext: "json", label: "Word timings (JSON)" },
  words: { ext: "words.txt", label: "Word list (compact)" },
  srt: { ext: "srt", label: "Subtitles (SRT)" },
  vtt: { ext: "vtt", label: "Subtitles (VTT)" },
  txt: { ext: "txt", label: "Plain text" },
};

const round = (value) => Math.round(value * 1000) / 1000;

/**
 * Timed words grouped into caption-sized segments: a new one after a sentence ends (once the segment is a second
 * or more), at a pause, or when it gets long.
 */
function segmentWords(words, { pause = 0.8, maxSeconds = 10, maxWords = 28 } = {}) {
  const segments = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    segments.push({
      id: segments.length,
      start: current[0].start,
      end: current[current.length - 1].end,
      text: current.map((word) => word.text).join(" "),
      words: current,
    });
    current = [];
  };
  for (const word of words) {
    const last = current[current.length - 1];
    if (last) {
      const length = last.end - current[0].start;
      const sentence = /[.?!…]["”')\]]*$/.test(last.text) && length >= 1;
      if (sentence || word.start - last.end >= pause || length >= maxSeconds || current.length >= maxWords) flush();
    }
    current.push(word);
  }
  flush();
  return segments;
}

function clock(seconds, separator) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (value, size = 2) => String(value).padStart(size, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
}

function shortClock(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  const pad = (value) => String(value).padStart(2, "0");
  return whole >= 3600 ? `${Math.floor(whole / 3600)}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}` : `${pad(Math.floor(whole / 60))}:${pad(whole % 60)}`;
}

/** The transcript in one of FORMATS. `result` is { source, duration, model, segments } from transcribeMedia. */
function formatTranscript(result, format = "json") {
  const segments = result.segments || [];
  switch (format) {
    case "json": {
      // Standard JSON, laid out one word a line so it stays readable and small.
      const head = {
        source: result.source ? path.basename(result.source) : undefined,
        duration: result.duration === undefined ? undefined : round(result.duration),
        model: result.model,
        text: segments.map((segment) => segment.text).join(" "),
      };
      const fields = Object.entries(head)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
      const body = segments.map((segment) => {
        const words = segment.words.map((word) => `      ${JSON.stringify({ word: word.text, start: round(word.start), end: round(word.end) })}`).join(",\n");
        return `    {"id": ${segment.id}, "start": ${round(segment.start)}, "end": ${round(segment.end)}, "text": ${JSON.stringify(segment.text)}, "words": [\n${words}\n    ]}`;
      });
      return `{\n${[...fields, `  "segments": [\n${body.join(",\n")}\n  ]`].join(",\n")}\n}\n`;
    }
    case "words":
      // One word a line, "start end word" in seconds, with a blank line between segments.
      return `# ${result.source ? path.basename(result.source) : "transcript"}: start end word (seconds)\n${segments
        .map((segment) => segment.words.map((word) => `${word.start.toFixed(2)} ${word.end.toFixed(2)} ${word.text}`).join("\n"))
        .join("\n\n")}\n`;
    case "srt":
      return segments.map((segment, index) => `${index + 1}\n${clock(segment.start, ",")} --> ${clock(segment.end, ",")}\n${segment.text}\n`).join("\n");
    case "vtt":
      return `WEBVTT\n\n${segments.map((segment) => `${clock(segment.start, ".")} --> ${clock(segment.end, ".")}\n${segment.text}\n`).join("\n")}`;
    case "txt":
      return `${segments.map((segment) => `[${shortClock(segment.start)}] ${segment.text}`).join("\n")}\n`;
    default:
      throw new Error(`Unknown format “${format}”. Use ${Object.keys(FORMATS).join(", ")}.`);
  }
}

/** Ember's own helpers, from the app bundle (Contents/Resources/bin) or a development checkout. */
function helperPaths(appRoot = path.resolve(__dirname, "..")) {
  const resources = /\.asar$/.test(appRoot) ? path.dirname(appRoot) : null;
  return resources
    ? { record: path.join(resources, "bin", "meeting-notes-record"), parakeet: path.join(resources, "bin", "meeting-notes-parakeet-worker") }
    : {
        record: path.join(appRoot, "native", "record", "meeting-notes-record"),
        parakeet: path.join(appRoot, "native", "parakeet-worker", "target", "release", "meeting-notes-parakeet-worker"),
      };
}

/** The file's sound as 16 kHz mono samples, decoded by the record helper (any format AVFoundation reads). */
async function decode(source, recordHelper) {
  const folder = await fsp.mkdtemp(path.join(os.tmpdir(), "ember-transcribe-"));
  const wav = path.join(folder, "sound.wav");
  try {
    const error = await new Promise((resolve) =>
      execFile(recordHelper, ["wav", "--source", source, "--out", wav], { timeout: 30 * 60 * 1000, maxBuffer: 1e6 }, (failed, stdout) => {
        if (!failed) return resolve(null);
        let message = null;
        try {
          message = JSON.parse(String(stdout || "").trim().split("\n").pop()).message;
        } catch {
          // Not JSON.
        }
        resolve(message || "Couldn't read the sound in that file.");
      }),
    );
    if (error) throw new Error(error);
    return readWav(wav);
  } finally {
    await fsp.rm(folder, { recursive: true, force: true });
  }
}

/**
 * Transcribes a video or audio file with every word timed.
 * @returns {{ source, duration, model, segments: Array<{ id, start, end, text, words: Array<{ text, start, end }> }> }}
 */
async function transcribeMedia(source, { helpers = helperPaths(), modelPath = findParakeet(MODELS_DIR), onProgress = () => {}, transcriber = null } = {}) {
  const file = path.resolve(String(source || ""));
  if (!fs.existsSync(file)) throw new Error(`There's no file at ${file}.`);
  if (!transcriber && !modelPath) throw new Error("Parakeet isn't on this Mac yet. Open Ember, then Settings → Transcription, and download Parakeet v3.");
  const samples = await decode(file, helpers.record);
  const pieces = splitForTranscription(samples, { maxSeconds: 24, searchSeconds: 6 });
  const own = !transcriber;
  transcriber ||= new LiveParakeetTranscriber({ binaryPath: helpers.parakeet, modelPath });
  const words = [];
  try {
    if (own) await transcriber.start();
    let offset = 0;
    for (const [index, piece] of pieces.entries()) {
      let peak = 0;
      for (let at = 0; at < piece.length; at += 16) peak = Math.max(peak, Math.abs(piece[at]));
      if (piece.length >= RATE * 0.2 && peak >= 0.01) {
        const heard = await transcriber.transcribeWords(piece);
        words.push(...offsetWords(heard.words, offset / RATE));
      }
      offset += piece.length;
      onProgress((index + 1) / pieces.length);
    }
  } finally {
    if (own) await transcriber.stop().catch(() => {});
  }
  return { source: file, duration: samples.length / RATE, model: path.basename(modelPath || "parakeet"), segments: segmentWords(words) };
}

module.exports = { FORMATS, formatTranscript, helperPaths, segmentWords, transcribeMedia };
