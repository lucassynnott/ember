const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { LivePhononTranscriber, encodeWav, findFermionBinary } = require("../src/phonon-transcription");

test("encodes 16 kHz mono float PCM as a WAV file", () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1]);
  const wav = encodeWav(samples);
  assert.equal(wav.length, 44 + samples.length * 4);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(20), 3);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readFloatLE(44 + 4), 0.5);
});

function speechSamples(sentence) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "phonon-test-"));
  const aiff = path.join(directory, "speech.aiff");
  const raw = path.join(directory, "speech.caf");
  spawnSync("say", ["-o", aiff, sentence]);
  spawnSync("afconvert", ["-f", "caff", "-d", "LEF32@16000", "-c", "1", aiff, raw]);
  const data = fs.readFileSync(raw);
  const offset = data.indexOf("data") + 16; // CAF data chunk: size (8) + edit count (4)
  const bytes = data.subarray(offset);
  fs.rmSync(directory, { recursive: true, force: true });
  const samples = new Float32Array(bytes.length / 4);
  for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readFloatLE(index * 4);
  return samples;
}

test("transcribes live segments through a local Phonon-2 server", async (t) => {
  const binaryPath = await findFermionBinary();
  if (process.platform !== "darwin" || !binaryPath) {
    t.skip("Phonon-2 runtime is not installed; run npm run setup:local");
    return;
  }
  const transcriber = new LivePhononTranscriber({ binaryPath });
  try {
    await transcriber.start();
    const text = await transcriber.transcribe(speechSamples("The budget review moves to Thursday afternoon."));
    assert.match(text.toLowerCase(), /budget review/);
    assert.match(text.toLowerCase(), /thursday/);
  } finally {
    await transcriber.stop();
  }
  assert.equal(fs.existsSync(transcriber.socketPath), false);
});
