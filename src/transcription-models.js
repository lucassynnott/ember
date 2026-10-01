const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { findFermionBinary } = require("./phonon-transcription");
const { CATALOG, MODELS_DIR, catalogTargetPath } = require("./model-manager");

function catalogEntryFor(type, modelPath) {
  return CATALOG.find(
    (entry) =>
      entry.type === type &&
      (entry.type === "phonon" || path.resolve(catalogTargetPath(entry)) === path.resolve(modelPath)),
  );
}

async function whisperFilesIn(directory) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^ggml-.+\.bin$/.test(entry.name))
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

const PARAKEET_FILES = [
  "encoder-model.int8.onnx",
  "decoder_joint-model.int8.onnx",
  "nemo128.onnx",
  "vocab.txt",
];

async function isDirectory(candidate) {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function hasFiles(directory, names) {
  const checks = await Promise.all(
    names.map(async (name) => {
      try {
        await fs.access(path.join(directory, name));
        return true;
      } catch {
        return false;
      }
    }),
  );
  return checks.every(Boolean);
}

async function childDirectories(parent) {
  if (!(await isDirectory(parent))) return [];
  const entries = await fs.readdir(parent, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".partial"))
    .map((entry) => path.join(parent, entry.name));
}

async function detectTranscriptionModels(extraWhisperCandidates = [], { isInstalling = () => false } = {}) {
  const parakeetRoots = [
    path.join(os.homedir(), "Library", "Application Support", "com.pais.handy", "models"),
    MODELS_DIR,
  ];
  const parakeetDirectories = (
    await Promise.all(parakeetRoots.map((root) => childDirectories(root)))
  ).flat();

  const models = [];
  const fermionBinary = isInstalling("phonon-2") ? null : await findFermionBinary();
  if (fermionBinary) {
    models.push({
      id: "phonon:phonon-2",
      type: "phonon",
      catalogId: "phonon-2",
      label: "Phonon-2",
      detail: "Local, English, live transcription",
      path: fermionBinary,
      realtime: true,
    });
  }

  for (const directory of parakeetDirectories) {
    if (!(await hasFiles(directory, PARAKEET_FILES))) continue;
    const handy = directory.includes(`${path.sep}com.pais.handy${path.sep}`);
    const entry = catalogEntryFor("parakeet", directory);
    const english = /v2/i.test(path.basename(directory));
    models.push({
      id: `parakeet:${directory}`,
      type: "parakeet",
      catalogId: entry?.id,
      label: `${entry?.label || `Parakeet TDT 0.6B ${english ? "v2" : "v3"}`}${handy ? " (Handy)" : ""}`,
      detail: english ? "Local, English, live transcription" : "Local, multilingual, live transcription",
      path: directory,
      realtime: true,
    });
  }

  const whisperCandidates = [...extraWhisperCandidates, ...(await whisperFilesIn(MODELS_DIR))];
  for (const candidate of [...new Set(whisperCandidates.filter(Boolean).map((file) => path.resolve(file)))]) {
    try {
      await fs.access(candidate);
    } catch {
      continue;
    }
    const entry = catalogEntryFor("whisper", candidate);
    models.push({
      id: `whisper:${candidate}`,
      type: "whisper",
      catalogId: entry?.id,
      label: entry?.label || `Whisper.cpp (${path.basename(candidate)})`,
      detail: "Local, transcribes after recording",
      path: candidate,
      realtime: false,
    });
  }

  return models;
}

module.exports = { detectTranscriptionModels };
