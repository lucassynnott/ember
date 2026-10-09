// Times every word of a recording's transcript, for editing the video by its text. Parakeet gives each word's real
// timing; without it, the words are laid over the speech in the sound (src/word-align.js), which is approximate.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { alignLine, offsetWords } = require("./word-align");

const PARAKEET_FILES = ["encoder-model.int8.onnx", "decoder_joint-model.int8.onnx", "nemo128.onnx", "vocab.txt"];

/**
 * A Parakeet model folder Ember's worker can load: Ember's own download first, then the same model already on this
 * Mac from another app that uses the same files (Handy), so nothing has to be downloaded twice.
 */
function findParakeet(modelsDir, home = os.homedir()) {
  const candidates = [
    path.join(modelsDir, "parakeet-tdt-0.6b-v3-int8"),
    path.join(modelsDir, "parakeet-tdt-0.6b-v2-int8"),
    path.join(home, "Library", "Application Support", "com.pais.handy", "models", "parakeet-tdt-0.6b-v3-int8"),
    path.join(home, "Library", "Application Support", "com.pais.handy", "models", "parakeet-tdt-0.6b-v2-int8"),
  ];
  return candidates.find((folder) => PARAKEET_FILES.every((file) => fs.existsSync(path.join(folder, file)))) || null;
}

/** 16 kHz mono samples from a WAV file written by the record helper (16-bit PCM). */
function readWav(file) {
  const buffer = fs.readFileSync(file);
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") {
      const pcm = new Int16Array(buffer.buffer.slice(buffer.byteOffset + offset + 8, buffer.byteOffset + offset + 8 + size));
      const samples = new Float32Array(pcm.length);
      for (let index = 0; index < pcm.length; index += 1) samples[index] = pcm[index] / 32768;
      return samples;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("That sound file couldn't be read.");
}

/**
 * Transcript lines with their words timed. With a Parakeet `transcriber` (start()ed), each line is heard again for
 * its words, and the line's text becomes what Parakeet heard so the words and text match; lines it hears nothing in
 * keep their text, laid over the speech instead.
 * @returns {{ lines: Array, timing: "parakeet" | "aligned" }}
 */
async function timeLines(samples, lines, { transcriber = null, rate = 16000, onProgress = () => {} } = {}) {
  const timed = [];
  let heard = 0;
  for (const [index, line] of lines.entries()) {
    let words = [];
    let text = line.text;
    if (transcriber && line.end > line.start) {
      const from = Math.max(0, Math.floor(line.start * rate));
      const to = Math.min(samples.length, Math.ceil(line.end * rate));
      if (to - from > rate * 0.2) {
        const result = await transcriber.transcribeWords(samples.subarray(from, to));
        words = offsetWords(result.words, from / rate);
        if (words.length) {
          text = words.map((word) => word.text).join(" ");
          heard += 1;
        }
      }
    }
    if (!words.length) words = alignLine(samples, line, rate);
    timed.push({ ...line, text, words });
    onProgress((index + 1) / lines.length);
  }
  return { lines: timed, timing: transcriber && heard ? "parakeet" : "aligned" };
}

module.exports = { findParakeet, readWav, timeLines, PARAKEET_FILES };
