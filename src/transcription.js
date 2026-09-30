const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-20000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-20000);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}: ${stderr || stdout}`));
    });
  });
}

async function fileBlob(filePath, type) {
  if (typeof fs.openAsBlob === "function") return fs.openAsBlob(filePath, { type });
  return new Blob([await fsp.readFile(filePath)], { type });
}

async function transcribeWithApi({ audioPath, endpoint, key, model, provider }) {
  if (!key) throw new Error(`${provider} transcription requires an API key.`);

  const form = new FormData();
  form.set("model", model);
  form.set("response_format", "json");
  form.set("file", await fileBlob(audioPath, "audio/webm"), path.basename(audioPath));

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000);
    throw new Error(`${provider} transcription failed (${response.status}): ${detail}`);
  }

  const payload = await response.json();
  if (!payload.text?.trim()) throw new Error(`${provider} returned an empty transcript.`);
  return payload.text.trim();
}

async function transcribeLocally(audioPath, settings) {
  if (!settings.whisperModel) {
    throw new Error(
      "The whisper.cpp medium model is missing. Run npm run setup:local or set WHISPER_MODEL in .env.",
    );
  }

  const wavPath = `${audioPath}.16khz.wav`;
  const outputBase = `${audioPath}.transcript`;
  const outputPath = `${outputBase}.txt`;

  try {
    await runCommand(settings.ffmpegBinary, [
      "-y",
      "-i",
      audioPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      wavPath,
    ]);

    await runCommand(settings.whisperBinary, [
      "-m",
      settings.whisperModel,
      "-f",
      wavPath,
      "-l",
      "auto",
      "-otxt",
      "-of",
      outputBase,
      "-nt",
      "-np",
    ]);

    const transcript = (await fsp.readFile(outputPath, "utf8")).trim();
    if (!transcript) throw new Error("whisper.cpp returned an empty transcript.");
    return transcript;
  } finally {
    await Promise.allSettled([fsp.rm(wavPath, { force: true }), fsp.rm(outputPath, { force: true })]);
  }
}

function providerOrder(settings) {
  if (settings.transcriptionProvider !== "auto") return [settings.transcriptionProvider];

  const providers = [];
  if (settings.groqKey) providers.push("groq");
  if (settings.openAiKey) providers.push("openai");
  providers.push("local");
  return providers;
}

async function transcribeAudio(audioPath, settings, onProgress = () => {}) {
  const failures = [];

  for (const provider of providerOrder(settings)) {
    try {
      onProgress(`Transcribing with ${provider === "local" ? "whisper.cpp medium" : provider}…`);
      if (provider === "groq") {
        return {
          text: await transcribeWithApi({
            audioPath,
            endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
            key: settings.groqKey,
            model: "whisper-large-v3-turbo",
            provider: "Groq Whisper",
          }),
          provider: "Groq Whisper (whisper-large-v3-turbo)",
        };
      }
      if (provider === "openai") {
        return {
          text: await transcribeWithApi({
            audioPath,
            endpoint: "https://api.openai.com/v1/audio/transcriptions",
            key: settings.openAiKey,
            model: "whisper-1",
            provider: "OpenAI Whisper",
          }),
          provider: "OpenAI Whisper (whisper-1)",
        };
      }
      if (provider === "local") {
        return {
          text: await transcribeLocally(audioPath, settings),
          provider: `whisper.cpp (${path.basename(settings.whisperModel || "ggml-medium.bin")})`,
        };
      }
      throw new Error(`Unknown transcription provider: ${provider}`);
    } catch (error) {
      failures.push(`${provider}: ${error.message}`);
    }
  }

  throw new Error(`All transcription providers failed. ${failures.join(" | ")}`);
}

module.exports = {
  runCommand,
  transcribeAudio,
};
