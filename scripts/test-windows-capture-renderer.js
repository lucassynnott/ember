// Run with Electron. Uses Chromium's generated camera/microphone, not user devices.
const { app, BrowserWindow, session } = require("electron");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { WindowsCapture } = require("../src/windows-capture");
const { runCommand } = require("../src/transcription");
const { wavToSamples } = require("../src/recordings");
app.commandLine.appendSwitch("use-fake-device-for-media-stream");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// Keep the process alive while assertions inspect files after the capture window closes.
app.on("window-all-closed", () => {});
let folder;
const timeout = setTimeout(() => { console.error("Capture renderer smoke test timed out"); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  folder = await fs.mkdtemp(path.join(os.tmpdir(), "ember-capture-renderer-"));
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === "media"));
  const helper = Object.assign(new EventEmitter(), { windows: async () => ({ windows: [] }), watchPointer() {} });
  const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
  const backend = new WindowsCapture({ electron: require("electron"), rendererDir: path.resolve(__dirname, "../renderer/dist"), getFfmpeg: () => ffmpeg, helper });
  const child = backend.start(["record", "--out", path.join(folder, "recording.mp4"), "--camera", "default", "--mic", "default"]);
  let output = "";
  const done = await new Promise((resolve, reject) => {
    child.stdout.on("data", (bytes) => {
      output += bytes;
      let newline;
      while ((newline = output.indexOf("\n")) >= 0) {
        const message = JSON.parse(output.slice(0, newline)); output = output.slice(newline + 1);
        if (message.type === "started") {
          setTimeout(() => child.stdin.write("pause\n"), 400);
          setTimeout(() => child.stdin.write("resume\n"), 600);
          setTimeout(() => child.stdin.write("stop\n"), 1600);
        } else if (message.type === "done") resolve(message);
        else if (message.type === "error") reject(new Error(message.message));
      }
    });
  });
  assert.equal(done.type, "done");
  assert.ok(done.duration >= 1 && done.duration < 2, `duration=${done.duration}`);
  assert.ok(done.width > 0 && done.height > 0);
  const audio = wavToSamples(await fs.readFile(done.wav));
  assert.ok(audio.samples.length > 16000);
  await runCommand(ffmpeg, ["-v", "error", "-i", done.file, "-f", "null", "-"]);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  const result = { rendererCapture: "passed", duration: done.duration, width: done.width, height: done.height, audioSamples: audio.samples.length };
  if (process.env.EMBER_CAPTURE_RESULT) await fs.writeFile(process.env.EMBER_CAPTURE_RESULT, JSON.stringify(result));
  console.log(JSON.stringify(result));
  clearTimeout(timeout); await fs.rm(folder, { recursive: true, force: true }); app.exit(0);
}).catch(async (error) => {
  console.error(error.stack); clearTimeout(timeout);
  if (folder) await fs.rm(folder, { recursive: true, force: true }).catch(() => {});
  app.exit(1);
});
