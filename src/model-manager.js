const { supportDirectory, executableName, venvExecutable } = require("./platform");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const SUPPORT_DIR = supportDirectory();
const MODELS_DIR = path.join(SUPPORT_DIR, "models");
const PHONON_VENV = path.join(SUPPORT_DIR, "phonon-venv");
const PHONON_CACHE = path.join(os.homedir(), ".cache", "fermion", "speech", "FermionResearch__Phonon-2");
// On-device AI (offline mode): models and a small MLX runtime, kept apart from transcription models.
const AI_MODELS_DIR = path.join(SUPPORT_DIR, "ai-models");
const AI_VENV = path.join(SUPPORT_DIR, "ai-venv");
const AI_PACKAGES = ["mlx-lm==0.32.0"];

const UV_VERSION = "0.10.8";
const UV_TARBALL = {
  url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-aarch64-apple-darwin.tar.gz`,
  sha256: "c3a6fff5b6b4abddff863117878194e35dbc6b0267d61ad259ab9896f9b8dcbb",
};
const WINDOWS_PHONON_PACKAGES = ["fermion-research==0.2.4", "torch==2.14.1", "safetensors==0.8.0", "soundfile==0.14.0", "scipy==1.18.1", "zstandard==0.25.0"];
const WINDOWS_UV = { url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`, sha256: "2e70ecd22196cbd9d14eefb700814bcafc5b75a0d8275b52e8402e5fe256d928" };
const PHONON_PACKAGES = [
  "fermion-research==0.2.4",
  "mlx",
  "mlx-audio",
  "mlx-lm",
  "soundfile",
  "scipy",
  "zstandard",
];

const PARAKEET_FILES = ({ decoder, decoderSize, encoder, encoderSize, vocabSize }) => [
  { name: "config.json", size: 97 },
  { name: "decoder_joint-model.int8.onnx", size: decoderSize, sha256: decoder },
  { name: "encoder-model.int8.onnx", size: encoderSize, sha256: encoder },
  {
    name: "nemo128.onnx",
    size: 139764,
    sha256: "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f",
  },
  { name: "vocab.txt", size: vocabSize },
];

// Hugging Face revisions are pinned so every download is reproducible and hash-checked.
const CATALOG = [
  {
    id: "phonon-2",
    type: "phonon",
    label: "Phonon-2",
    source: "Fermion Research",
    languages: "English",
    realtime: true,
    sizeLabel: "1.2 GB (model + runtime)",
    detail: "Fastest live transcription on Apple Silicon. Installs its own Python runtime.",
    install: { kind: "phonon" },
  },
  {
    id: "parakeet-tdt-0.6b-v3",
    type: "parakeet",
    label: "Parakeet TDT 0.6B v3",
    source: "NVIDIA · Hugging Face",
    languages: "25 European languages",
    realtime: true,
    sizeLabel: "670 MB",
    detail: "Multilingual live transcription.",
    install: {
      kind: "huggingface",
      repo: "istupakov/parakeet-tdt-0.6b-v3-onnx",
      revision: "8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce",
      target: "parakeet-tdt-0.6b-v3-int8",
      files: PARAKEET_FILES({
        decoder: "eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70",
        decoderSize: 18202004,
        encoder: "6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09",
        encoderSize: 652183999,
        vocabSize: 93939,
      }),
    },
  },
  {
    id: "parakeet-tdt-0.6b-v2",
    type: "parakeet",
    label: "Parakeet TDT 0.6B v2",
    source: "NVIDIA · Hugging Face",
    languages: "English",
    realtime: true,
    sizeLabel: "661 MB",
    detail: "English live transcription.",
    install: {
      kind: "huggingface",
      repo: "istupakov/parakeet-tdt-0.6b-v2-onnx",
      revision: "0bbb45a3365852604aef28b538a8f066f4ccaa85",
      target: "parakeet-tdt-0.6b-v2-int8",
      files: PARAKEET_FILES({
        decoder: "a449f49acd68979d418651dd2dcb737cc0f1bf0225e009e29ee326354edbf7d3",
        decoderSize: 8998286,
        encoder: "3e0581fda6ab843888b51e56d7ee78b6d5bc3237ec113af1f732d1d5286aa155",
        encoderSize: 652184014,
        vocabSize: 9384,
      }),
    },
  },
  {
    id: "whisper-large-v3-turbo-q5",
    type: "whisper",
    label: "Whisper large-v3 turbo",
    source: "OpenAI · whisper.cpp",
    languages: "99 languages",
    realtime: false,
    sizeLabel: "574 MB",
    detail: "Transcribes after the recording ends. Needs whisper-cpp and ffmpeg (Homebrew).",
    install: {
      kind: "huggingface",
      repo: "ggerganov/whisper.cpp",
      revision: "5359861c739e955e79d9a303bcbc70fb988958b1",
      target: "ggml-large-v3-turbo-q5_0.bin",
      single: true,
      files: [
        {
          name: "ggml-large-v3-turbo-q5_0.bin",
          size: 574041195,
          sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        },
      ],
    },
  },
  {
    id: "whisper-base-en",
    type: "whisper",
    label: "Whisper base.en",
    source: "OpenAI · whisper.cpp",
    languages: "English",
    realtime: false,
    sizeLabel: "148 MB",
    detail: "Small and quick, less accurate. Runs after the recording. Needs whisper-cpp and ffmpeg.",
    install: {
      kind: "huggingface",
      repo: "ggerganov/whisper.cpp",
      revision: "5359861c739e955e79d9a303bcbc70fb988958b1",
      target: "ggml-base.en.bin",
      single: true,
      files: [
        {
          name: "ggml-base.en.bin",
          size: 147964211,
          sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
        },
      ],
    },
  },
];

const GEMMA_SMALL_FILES = [
  { name: "chat_template.jinja", size: 17336 },
  { name: "generation_config.json", size: 208 },
  { name: "processor_config.json", size: 1316 },
  { name: "tokenizer.json", size: 32169626, sha256: "cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f" },
  { name: "tokenizer_config.json", size: 2740 },
];

// Models for offline mode. Picked in a bake-off on the app's own prompts (notes, tips, Ask, cleanup).
const AI_CATALOG = [
  {
    id: "gemma-4-e2b-text",
    type: "llm",
    label: "Gemma 4 E2B",
    source: "Google · text-only MLX build",
    sizeLabel: "2.6 GB",
    detail: "Fast and light. Good for tips, Ask and live help; notes are shorter than the cloud's.",
    install: {
      kind: "mlx-llm",
      repo: "ddalcu/gemma-4-e2b-it-4bit-textonly",
      revision: "0ac4fb7c45adbadbf71429950cf863bdb5e54fda",
      target: "gemma-4-e2b-it-4bit-textonly",
      files: [
        { name: "config.json", size: 4465 },
        ...GEMMA_SMALL_FILES,
        { name: "model.safetensors", size: 2604122581, sha256: "a3a02fa41f520eef689fa5d3533b36d2208438255ed207430e765e160d530047" },
      ],
    },
  },
  {
    id: "gemma-4-e4b",
    type: "llm",
    label: "Gemma 4 E4B",
    source: "Google · MLX",
    sizeLabel: "5.2 GB",
    detail: "Higher quality: fuller notes and cleaner dictation. Needs about 6.5 GB of memory while it runs.",
    install: {
      kind: "mlx-llm",
      repo: "mlx-community/gemma-4-e4b-it-4bit",
      revision: "475b9088d29754a3379866cf5aeb6b41acd313c2",
      target: "gemma-4-e4b-it-4bit",
      files: [
        { name: "config.json", size: 6628 },
        { name: "model.safetensors.index.json", size: 240961 },
        ...GEMMA_SMALL_FILES,
        { name: "model.safetensors", size: 5146800534, sha256: "932b8271fc3fe65adcc78b96c10c6268bbfb13e8f67d1358727c0d6ee97e1eff" },
      ],
    },
  },
];

function catalogTargetPath(entry, modelsDir = MODELS_DIR, phononVenv = PHONON_VENV) {
  if (entry.install.kind === "phonon") return venvExecutable(phononVenv, "fermion");
  return path.join(modelsDir, entry.install.target);
}

async function exists(candidate) {
  try {
    await fsp.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

// Downloads url to destination, resuming a partial file, reporting bytes and checking SHA-256.
async function downloadVerified({ url, destination, expectedSize, sha256, signal, onBytes = () => {}, fetchImpl = fetch }) {
  let offset = 0;
  try {
    offset = (await fsp.stat(destination)).size;
  } catch {}
  if (expectedSize && offset > expectedSize) {
    await fsp.rm(destination, { force: true });
    offset = 0;
  }

  if (!expectedSize || offset < expectedSize) {
    const response = await fetchImpl(url, {
      signal,
      headers: offset ? { Range: `bytes=${offset}-` } : {},
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`Download failed (${response.status}) for ${path.basename(destination)}.`);
    if (offset && response.status !== 206) offset = 0;
    onBytes(offset);
    let received = offset;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        onBytes(received);
        callback(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      counter,
      fs.createWriteStream(destination, { flags: offset ? "a" : "w", mode: 0o644 }),
      { signal },
    );
  } else {
    onBytes(offset);
  }

  if (sha256) {
    const actual = await sha256File(destination);
    if (actual !== sha256) {
      await fsp.rm(destination, { force: true });
      throw new Error(`${path.basename(destination)} failed its checksum. Please try again.`);
    }
  }
}

class CancelledError extends Error {
  constructor() {
    super("Download cancelled.");
    this.cancelled = true;
  }
}

class ModelManager extends EventEmitter {
  constructor({
    catalog = CATALOG,
    modelsDir = MODELS_DIR,
    supportDir = SUPPORT_DIR,
    phononVenv = PHONON_VENV,
    phononCache = PHONON_CACHE,
    aiVenv = AI_VENV,
    uvCandidates = [
      path.join(os.homedir(), ".local", "bin", executableName("uv")),
      "/opt/homebrew/bin/uv",
      "/usr/local/bin/uv",
    ],
    fetchImpl = fetch,
  } = {}) {
    super();
    this.entries = catalog;
    this.modelsDir = modelsDir;
    this.supportDir = supportDir;
    this.phononVenv = phononVenv;
    this.phononCache = phononCache;
    this.aiVenv = aiVenv;
    this.uvCandidates = uvCandidates;
    this.fetch = fetchImpl;
    this.jobs = new Map();
  }

  catalog() {
    return this.entries;
  }

  isBusy(id) {
    return this.jobs.has(id);
  }

  status(id) {
    return this.jobs.get(id)?.progress || null;
  }

  #progress(id, update) {
    const job = this.jobs.get(id);
    if (!job) return;
    job.progress = { ...job.progress, ...update, id };
    const now = Date.now();
    if (update.state === "downloading" && now - (job.lastEmit || 0) < 250) return;
    job.lastEmit = now;
    this.emit("progress", job.progress);
  }

  install(id) {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) return Promise.reject(new Error(`Unknown model: ${id}`));
    if (this.jobs.has(id)) return this.jobs.get(id).promise;

    const controller = new AbortController();
    const job = { controller, children: new Set(), progress: { id, state: "starting", message: "Starting…" } };
    this.jobs.set(id, job);
    this.emit("progress", job.progress);

    job.promise = (async () => {
      try {
        if (entry.install.kind === "phonon") await this.#installPhonon(entry, job);
        else await this.#downloadHuggingFace(entry, job);
        if (entry.install.kind === "mlx-llm") await this.#ensureMlxRuntime(entry, job);
        this.#progress(id, { state: "installed", message: "Installed", fraction: 1 });
      } catch (error) {
        const cancelled = error.cancelled || controller.signal.aborted;
        this.#progress(id, {
          state: cancelled ? "cancelled" : "failed",
          message: cancelled ? "Cancelled" : error.message,
        });
        if (!cancelled) throw error;
      } finally {
        this.jobs.delete(id);
        this.emit("changed", id);
      }
    })();
    return job.promise;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.controller.abort();
    for (const child of job.children) {
      if (process.platform === "win32" && child.pid) {
        execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 8000 }, error => { if (error) child.kill("SIGKILL"); });
      } else child.kill("SIGTERM");
    }
    return true;
  }

  async remove(id) {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Unknown model: ${id}`);
    if (this.jobs.has(id)) throw new Error("Cancel the download before removing the model.");
    if (entry.install.kind === "phonon") {
      await fsp.rm(this.phononVenv, { recursive: true, force: true });
      await fsp.rm(this.phononCache, { recursive: true, force: true });
    } else {
      const target = catalogTargetPath(entry, this.modelsDir);
      await fsp.rm(target, { recursive: true, force: true });
      await fsp.rm(`${target}.partial`, { recursive: true, force: true });
    }
    this.emit("changed", id);
  }

  /**
   * A Python that can run on-device AI models: Phonon-2's runtime already includes MLX, so it's
   * reused when present; otherwise the small runtime installed alongside the first AI model.
   */
  async mlxPython() {
    for (const venv of [this.phononVenv, this.aiVenv]) {
      const python = path.join(venv, "bin", "python");
      const lib = path.join(venv, "lib");
      if (!(await exists(python))) continue;
      try {
        for (const version of await fsp.readdir(lib)) {
          if (await exists(path.join(lib, version, "site-packages", "mlx_lm", "models", "gemma4_text.py"))) return python;
        }
      } catch {}
    }
    return null;
  }

  async #ensureMlxRuntime(entry, job) {
    if (await this.mlxPython()) return;
    const step = (fraction, message) => this.#progress(entry.id, { state: "installing", fraction, message });
    step(0.995, "Getting the uv Python installer…");
    const uv = await this.#findUv(job);
    try {
      step(0.996, "Installing Python 3.13…");
      await fsp.rm(this.aiVenv, { recursive: true, force: true });
      await this.#run(job, uv, ["venv", "--python", "3.13", this.aiVenv]);
      step(0.997, "Installing the MLX runtime (about 100 MB)…");
      await this.#run(job, uv, ["pip", "install", "--python", path.join(this.aiVenv, "bin", "python"), ...AI_PACKAGES], {
        onLine: (line) => /^(Resolved|Prepared|Installed|Downloading)/.test(line) && step(0.998, line),
      });
    } catch (error) {
      await fsp.rm(this.aiVenv, { recursive: true, force: true });
      throw error;
    }
  }

  #downloadFile(options) {
    return downloadVerified({ ...options, fetchImpl: this.fetch });
  }

  async #downloadHuggingFace(entry, job) {
    const { repo, revision, files, single } = entry.install;
    const target = catalogTargetPath(entry, this.modelsDir);
    const partialDir = `${target}.partial`;
    await fsp.mkdir(partialDir, { recursive: true });
    const total = files.reduce((sum, file) => sum + file.size, 0);
    const done = new Map();

    try {
      for (const file of files) {
        if (job.controller.signal.aborted) throw new CancelledError();
        await this.#downloadFile({
          url: `https://huggingface.co/${repo}/resolve/${revision}/${file.name}`,
          destination: path.join(partialDir, file.name),
          expectedSize: file.sha256 ? file.size : 0,
          sha256: file.sha256,
          signal: job.controller.signal,
          onBytes: (bytes) => {
            done.set(file.name, bytes);
            const received = [...done.values()].reduce((sum, value) => sum + value, 0);
            this.#progress(entry.id, {
              state: "downloading",
              received,
              total,
              fraction: Math.min(received / total, 0.999),
              message: `Downloading ${file.name}`,
            });
          },
        });
      }
    } catch (error) {
      if (error.name === "AbortError") throw new CancelledError();
      throw error;
    }

    this.#progress(entry.id, { state: "finishing", message: "Finishing…", fraction: 0.999 });
    await fsp.rm(target, { recursive: true, force: true });
    if (single) {
      await fsp.rename(path.join(partialDir, files[0].name), target);
      await fsp.rm(partialDir, { recursive: true, force: true });
    } else {
      await fsp.rename(partialDir, target);
    }
  }

  #run(job, command, args, { onLine } = {}) {
    return new Promise((resolve, reject) => {
      if (job.controller.signal.aborted) {
        reject(new CancelledError());
        return;
      }
      const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      job.children.add(child);
      let tail = "";
      const handle = (chunk) => {
        const text = chunk.toString("utf8");
        tail = (tail + text).slice(-4000);
        for (const line of text.split(/[\r\n]+/)) if (line.trim()) onLine?.(line.trim());
      };
      child.stdout.on("data", handle);
      child.stderr.on("data", handle);
      child.once("error", reject);
      child.once("close", (code) => {
        job.children.delete(child);
        if (job.controller.signal.aborted) reject(new CancelledError());
        else if (code === 0) resolve();
        else reject(new Error(`${path.basename(command)} failed: ${tail.trim().split("\n").slice(-3).join(" ")}`));
      });
    });
  }

  async #findUv(job) {
    for (const candidate of [path.join(this.supportDir, "bin", executableName("uv")), ...this.uvCandidates]) {
      try {
        await fsp.access(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }

    const binDir = path.join(this.supportDir, "bin");
    await fsp.mkdir(binDir, { recursive: true });
    if (process.platform === "win32") {
      const archive = path.join(binDir, "uv.zip");
      try {
        await this.#downloadFile({ ...WINDOWS_UV, destination: archive, signal: job.controller.signal, onBytes: () => {} });
        await require("extract-zip")(archive, { dir: path.resolve(binDir) });
        const executable = path.join(binDir, "uv.exe");
        if (!(await exists(executable))) throw new Error("The Windows uv archive is missing uv.exe.");
        return executable;
      } finally { await fsp.rm(archive, { force: true }); }
    }
    const tarball = path.join(binDir, "uv.tar.gz");
    await this.#downloadFile({
      url: UV_TARBALL.url,
      destination: tarball,
      sha256: UV_TARBALL.sha256,
      signal: job.controller.signal,
      onBytes: () => {},
    });
    await this.#run(job, "/usr/bin/tar", ["-xzf", tarball, "-C", binDir, "--strip-components", "1"]);
    await fsp.rm(tarball, { force: true });
    return path.join(binDir, "uv");
  }

  async #installPhonon(entry, job) {
    const step = (fraction, message) => this.#progress(entry.id, { state: "installing", fraction, message });
    let createdRuntime = false;
    try {
      step(0.02, "Getting the uv Python installer…");
      const uv = await this.#findUv(job);

      const venv = this.phononVenv;
      const fermion = venvExecutable(venv, "fermion");
      if (!(await exists(fermion))) {
        step(0.08, "Installing Python 3.13…");
        await fsp.rm(venv, { recursive: true, force: true });
        createdRuntime = true;
        await this.#run(job, uv, ["venv", "--python", "3.13", venv]);
        step(0.2, "Installing the Phonon runtime (about 1 GB)…");
        await this.#run(
          job,
          uv,
          ["pip", "install", "--python", venvExecutable(venv, "python"), ...(process.platform === "win32" ? WINDOWS_PHONON_PACKAGES : PHONON_PACKAGES)],
          { onLine: (line) => /^(Resolved|Prepared|Installed|Downloading)/.test(line) && step(0.45, line) },
        );
      }

      step(0.75, "Downloading and verifying the Phonon-2 model…");
      const probe = path.join(os.tmpdir(), `meeting-notes-phonon-probe-${process.pid}.wav`);
      await fsp.writeFile(probe, silentWav(0.5));
      try {
        await this.#run(job, fermion, ["transcribe", "phonon-2", probe], {
          onLine: (line) => {
            if (/fetching|verified|unpack|compiles shaders/i.test(line)) {
              step(0.85, line.replace(/^\[fermion\]\s*/, "").slice(0, 120));
            }
          },
        });
      } finally {
        await fsp.rm(probe, { force: true });
      }
    } catch (error) {
      // A half-built runtime would be detected as installed, so remove one this run created.
      if (createdRuntime) await fsp.rm(this.phononVenv, { recursive: true, force: true });
      throw error;
    }
  }
}

function silentWav(seconds, sampleRate = 16000) {
  const samples = Math.round(seconds * sampleRate);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples * 2, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples * 2, 40);
  return Buffer.concat([header, Buffer.alloc(samples * 2)]);
}

module.exports = {
  AI_CATALOG,
  AI_MODELS_DIR,
  CATALOG,
  SUPPORT_DIR,
  downloadVerified,
  MODELS_DIR,
  PHONON_VENV,
  ModelManager,
  catalogTargetPath,
};

module.exports.aiCatalogForPlatform = (platform = process.platform) => platform === "win32" ? require("./windows-ai").WINDOWS_AI_CATALOG : AI_CATALOG;
