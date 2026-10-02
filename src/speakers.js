// Tells the other people in a call apart by voice, on this Mac.
//
// Each stretch of the other side's speech gets a voice print (an embedding). Prints that sound alike
// are grouped into Speaker 1, Speaker 2… as the call goes, then tidied once it ends. Voices you have
// named before are recognised in later calls.

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Worker } = require("node:worker_threads");

const MODEL = Object.freeze({
  id: "voices",
  label: "Voice model (WeSpeaker ResNet34)",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/wespeaker_en_voxceleb_resnet34_LM.onnx",
  sha256: "e9848563da86f263117134dfd7ad63c92355b37de492b55e325400c9d9c39012",
  size: 26530550,
  fileName: "wespeaker_en_voxceleb_resnet34_LM.onnx",
});

// Tuned on a real three-person call: below this, two prints are treated as different people.
const SAME_SPEAKER = 0.5;
// Stricter, because putting a name on the wrong person is worse than "Speaker 2". On a real call the
// same person scored 0.89–0.97 against themselves and different people at most 0.61.
const KNOWN_VOICE = 0.72;
// The best match must also clearly beat the runner-up.
const KNOWN_MARGIN = 0.08;
const MIN_SEGMENT_SECONDS = 1;
const MIN_SPEAKER_SECONDS = 4;
const MIN_LEARN_SECONDS = 8;

function normalize(vector) {
  const length = Math.hypot(...vector) || 1;
  return Array.from(vector, (value) => value / length);
}

function cosine(left, right) {
  let sum = 0;
  for (let index = 0; index < left.length; index += 1) sum += left[index] * right[index];
  return sum;
}

function centroid(cluster) {
  return normalize(cluster.sum);
}

/** Groups voice prints within one call. */
class SpeakerTracker {
  constructor({ threshold = SAME_SPEAKER } = {}) {
    this.threshold = threshold;
    this.clusters = [];
  }

  // Returns the live label for this stretch of speech, or null when it's too short to judge.
  add(embedding, seconds) {
    if (!embedding || seconds < MIN_SEGMENT_SECONDS) return null;
    const print = normalize(embedding);
    let best = null;
    let bestScore = -Infinity;
    for (const cluster of this.clusters) {
      const score = cosine(print, centroid(cluster));
      if (score > bestScore) {
        best = cluster;
        bestScore = score;
      }
    }
    if (!best || bestScore < this.threshold) {
      best = { label: `Speaker ${this.clusters.length + 1}`, sum: new Array(print.length).fill(0), seconds: 0 };
      this.clusters.push(best);
    }
    best.sum = best.sum.map((value, index) => value + print[index] * seconds);
    best.seconds += seconds;
    return best.label;
  }

  /**
   * Tidies the groups once the call ends: scraps under a few seconds join the closest real speaker,
   * the rest are renumbered in order of who spoke first, and known voices get their names.
   * Returns { labels: { liveLabel: finalLabel }, speakers: { finalLabel: { embedding, seconds, known } } }.
   */
  finalize(knownVoices = []) {
    const main = this.clusters.filter((cluster) => cluster.seconds >= MIN_SPEAKER_SECONDS);
    const keep = main.length ? main : this.clusters.slice(0, 1);
    const target = new Map();
    for (const cluster of this.clusters) {
      if (keep.includes(cluster)) {
        target.set(cluster, cluster);
        continue;
      }
      let best = keep[0];
      let bestScore = -Infinity;
      for (const candidate of keep) {
        const score = cosine(centroid(cluster), centroid(candidate));
        if (score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
      target.set(cluster, best);
    }
    for (const [cluster, into] of target) {
      if (cluster === into) continue;
      into.sum = into.sum.map((value, index) => value + cluster.sum[index]);
      into.seconds += cluster.seconds;
    }

    const used = new Set();
    const finalLabel = new Map();
    const speakers = {};
    let number = 0;
    for (const cluster of keep) {
      const print = centroid(cluster);
      const ranked = knownVoices
        .filter((voice) => !used.has(voice.id))
        .map((voice) => ({ voice, score: cosine(print, voice.embedding) }))
        .sort((a, b) => b.score - a.score);
      const [first, second] = ranked;
      const name =
        first && first.score >= KNOWN_VOICE && (!second || first.score - second.score >= KNOWN_MARGIN) ? first.voice : null;
      let label;
      if (name) {
        used.add(name.id);
        label = name.name;
      } else {
        number += 1;
        label = `Speaker ${number}`;
      }
      finalLabel.set(cluster, label);
      speakers[label] = { embedding: print, seconds: Math.round(cluster.seconds), known: Boolean(name) };
    }
    const labels = {};
    for (const [cluster, into] of target) labels[cluster.label] = finalLabel.get(into);
    return { labels, speakers };
  }
}

/** Voices you've named, kept on this Mac. */
class VoiceBank {
  constructor(filePath) {
    this.filePath = filePath;
    this.voices = null;
  }

  async list() {
    if (this.voices) return this.voices;
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      this.voices = Array.isArray(data.voices) ? data.voices : [];
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.voices = [];
    }
    return this.voices;
  }

  async #save() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ voices: this.voices })}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
  }

  // Adds a voice under a name, or folds it into that name's existing print.
  async learn(name, embedding, seconds) {
    const clean = String(name || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!clean || !embedding?.length || seconds < MIN_LEARN_SECONDS) return null;
    const voices = await this.list();
    const print = normalize(embedding);
    let voice = voices.find((candidate) => candidate.name.toLowerCase() === clean.toLowerCase());
    if (voice) {
      const weight = Math.min(voice.seconds, 600);
      voice.embedding = normalize(voice.embedding.map((value, index) => value * weight + print[index] * seconds));
      voice.seconds = weight + seconds;
      voice.updatedAt = new Date().toISOString();
    } else {
      voice = { id: crypto.randomUUID(), name: clean, embedding: print, seconds, updatedAt: new Date().toISOString() };
      voices.push(voice);
    }
    await this.#save();
    return voice;
  }

  async forget(id) {
    const voices = await this.list();
    this.voices = voices.filter((voice) => voice.id !== id);
    await this.#save();
  }

  async summary() {
    return (await this.list())
      .map(({ id, name, seconds, updatedAt }) => ({ id, name, seconds: Math.round(seconds), updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** Computes voice prints in a worker thread so the app stays responsive. */
class VoiceEmbedder {
  constructor(modelPath) {
    this.modelPath = modelPath;
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  #start() {
    if (this.worker) return this.worker;
    const worker = new Worker(path.join(__dirname, "voice-embedder-worker.js"), { workerData: { model: this.modelPath } });
    worker.on("message", ({ id, embedding, error }) => {
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);
      if (error) waiter.reject(new Error(error));
      else waiter.resolve(embedding);
    });
    worker.on("error", (error) => this.#failAll(error));
    worker.on("exit", (code) => {
      this.worker = null;
      if (code) this.#failAll(new Error(`The voice model stopped (${code}).`));
    });
    this.worker = worker;
    return worker;
  }

  #failAll(error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  embed(samples) {
    const worker = this.#start();
    const id = this.nextId++;
    const copy = new Float32Array(samples);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, samples: copy.buffer }, [copy.buffer]);
    });
  }

  async stop() {
    const worker = this.worker;
    this.worker = null;
    if (worker) await worker.terminate();
  }
}

// Replaces speaker labels in a transcript, e.g. "Speaker 2: hello" → "Harry: hello".
function relabelTranscript(text, labels) {
  const entries = Object.entries(labels).filter(([from, to]) => from && to && from !== to);
  if (!entries.length) return text;
  return String(text)
    .split("\n")
    .map((line) => {
      const match = /^([^:]{1,60}):\s/.exec(line);
      if (!match) return line;
      const replacement = labels[match[1]];
      return replacement && replacement !== match[1] ? `${replacement}${line.slice(match[1].length)}` : line;
    })
    .join("\n");
}

module.exports = {
  KNOWN_VOICE,
  MODEL,
  SAME_SPEAKER,
  SpeakerTracker,
  VoiceBank,
  VoiceEmbedder,
  cosine,
  normalize,
  relabelTranscript,
};
