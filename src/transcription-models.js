const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { findFermionBinary } = require("./phonon-transcription");

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
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(parent, entry.name));
}

async function detectTranscriptionModels(extraWhisperCandidates = []) {
  const parakeetRoots = [
    path.join(os.homedir(), "Library", "Application Support", "com.pais.handy", "models"),
    path.join(os.homedir(), "Library", "Application Support", "MeetingNotes", "models"),
  ];
  const parakeetDirectories = (
    await Promise.all(parakeetRoots.map((root) => childDirectories(root)))
  ).flat();

  const models = [];
  const fermionBinary = await findFermionBinary();
  if (fermionBinary) {
    models.push({
      id: "phonon:phonon-2",
      type: "phonon",
      label: "Phonon-2",
      detail: "Local, English, live transcription",
      path: fermionBinary,
      realtime: true,
    });
  }

  for (const directory of parakeetDirectories) {
    if (!(await hasFiles(directory, PARAKEET_FILES))) continue;
    const handy = directory.includes(`${path.sep}com.pais.handy${path.sep}`);
    models.push({
      id: `parakeet:${directory}`,
      type: "parakeet",
      label: `Parakeet TDT 0.6B v3${handy ? " — Handy" : ""}`,
      detail: "Local, multilingual, live transcription",
      path: directory,
      realtime: true,
    });
  }

  for (const candidate of [...new Set(extraWhisperCandidates.filter(Boolean))]) {
    try {
      await fs.access(candidate);
    } catch {
      continue;
    }
    models.push({
      id: `whisper:${candidate}`,
      type: "whisper",
      label: `Whisper.cpp — ${path.basename(candidate)}`,
      detail: "Local, transcribes after recording",
      path: candidate,
      realtime: false,
    });
  }

  return models;
}

module.exports = { detectTranscriptionModels };
