const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { WindowsCapture } = require("../src/windows-capture");
const { recordingFiles, conversionCommands, convertRecording } = require("../src/windows-recording-media");
const { runCommand } = require("../src/transcription");
const { wavToSamples } = require("../src/recordings");

function harness(folder, convert = async () => {}, createDesktopFrames) {
  const handlers = new Map(), events = new EventEmitter(), helper = new EventEmitter();
  helper.windows = async () => ({ windows: [{ id: 91, app: "demo", bounds: { x: -1200, y: 40, width: 900, height: 600 } }] });
  helper.watchPointer = (active) => { helper.watching = active; };
  const windows = [];
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), { id: windows.length + 1, mainFrame: {}, send: (...args) => this.sent.push(args) });
      this.sent = []; windows.push(this);
    }
    async loadFile(file) { this.file = file; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const electron = {
    BrowserWindow: Window,
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => events.on(name, handler) },
    desktopCapturer: { getSources: async ({ types }) => types[0] === "window" ? [{ id: "window:91:0", name: "Demo" }] : [{ id: "screen:0:0", display_id: "7" }] },
    screen: { getAllDisplays: () => [{ id: 7, size: { width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }], dipToScreenRect: (_window, bounds) => bounds, screenToDipRect: (_window, bounds) => bounds, screenToDipPoint: (point) => point },
  };
  const backend = new WindowsCapture({ electron, rendererDir: folder, getFfmpeg: () => "ffmpeg", helper, convert, createDesktopFrames });
  const event = () => ({ sender: windows[0].webContents, senderFrame: windows[0].webContents.mainFrame });
  const send = (message) => events.emit("windows-capture:event", event(), message);
  return { backend, windows, handlers, helper, event, send };
}
async function settle() { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); }

test("capture resolves the selected display and confines writes to its session", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "ember-win-capture-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const h = harness(folder);
  const child = h.backend.start(["record", "--out", path.join(folder, "recording.mp4"), "--display", "7", "--rect", "10,20,300,200", "--mic", "none"]);
  await settle();
  const config = h.handlers.get("windows-capture:config")(h.event());
  assert.equal(config.sourceId, "screen:0:0");
  assert.deepEqual(config.rect, { x: 10, y: 20, width: 300, height: 200 });
  assert.equal(h.windows[0].options.webPreferences.sandbox, true);
  const write = h.handlers.get("windows-capture:chunk");
  assert.throws(() => write({ sender: { id: 99 }, senderFrame: {} }, { kind: "video", bytes: new ArrayBuffer(2) }), /Unknown capture/);
  assert.throws(() => write({ ...h.event(), senderFrame: {} }, { kind: "video", bytes: new ArrayBuffer(2) }), /Unknown capture/);
  assert.throws(() => write(h.event(), { kind: "../escape", bytes: new ArrayBuffer(2) }), /Invalid capture/);
  write(h.event(), { kind: "video", bytes: new Uint8Array([1, 2, 3]).buffer });
  assert.deepEqual([...await fs.readFile(path.join(folder, "capture.video.webm"))], [1, 2, 3]);
  child.stdin.write("cancel\n");
  assert.equal(h.windows[0].destroyed, true);
});

test("capture preserves pause controls, pointer samples, separate tracks and done event", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "ember-win-finish-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  let converted;
  const h = harness(folder, async (...args) => { converted = args; });
  const child = h.backend.start(["record", "--out", path.join(folder, "recording.mp4"), "--display", "7", "--camera-track", "default", "--system-audio"]);
  const messages = []; child.stdout.on("data", (bytes) => messages.push(JSON.parse(bytes)));
  child.stdin.write("pause\n");
  await settle();
  h.send({ type: "started", width: 1920, height: 1080, microphone: true, camera: true, system: true });
  assert.equal(h.helper.watching, true);
  assert.deepEqual(h.windows[0].sent[0], ["windows-capture:command", "pause"]);
  h.helper.emit("pointer", { x: 500, y: 500, pressed: true }); // Paused samples are omitted.
  child.stdin.write("resume\n");
  h.helper.emit("pointer", { x: 960, y: 540, pressed: true, shape: 2 });
  const finished = new Promise((resolve) => child.once("exit", resolve));
  h.send({ type: "captured", duration: 1.2 });
  await finished;
  const done = messages.at(-1);
  assert.equal(done.type, "done");
  assert.equal(done.camera, path.join(folder, "recording.camera.mp4"));
  assert.equal(done.system, path.join(folder, "recording.system.m4a"));
  assert.equal(converted[2].duration, 1.2);
  const pointer = JSON.parse(await fs.readFile(done.cursor));
  assert.equal(pointer.samples.length, 1);
  assert.deepEqual(pointer.samples[0].slice(1), [0.5, 0.5, 1, 2]);
  assert.equal(pointer.cursorHidden, false);
  assert.equal(h.helper.watching, false);
  assert.equal(h.backend.sessions.size, 0);
});

test("window sources preserve global bounds across multiple displays", async () => {
  const h = harness("/tmp");
  assert.deepEqual((await h.backend.list()).windows[0], { id: 91, app: "demo", title: "Demo", frame: [-1200, 40, 900, 600], frameGlobal: true });
});

test("conversion fails visibly and closes capture resources", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "ember-win-error-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const h = harness(folder, async () => { throw new Error("Encoder failed"); });
  const child = h.backend.start(["record", "--out", path.join(folder, "recording.mp4"), "--display", "7"]);
  const messages = []; child.stdout.on("data", (bytes) => messages.push(JSON.parse(bytes)));
  await settle();
  h.send({ type: "started", width: 640, height: 480, microphone: true });
  h.send({ type: "captured", duration: 1 });
  await settle();
  assert.deepEqual(messages.at(-1), { type: "error", message: "Encoder failed" });
  assert.equal(h.helper.watching, false);
  assert.equal(h.windows[0].destroyed, true);
});

test("audio-less capture produces a bounded silent WAV; empty capture is rejected", () => {
  const commands = conversionCommands(recordingFiles("/tmp/recording.mp4"), { duration: 2, microphone: false, camera: false, system: false });
  assert.ok(commands[1].includes("anullsrc=r=16000:cl=mono"));
  assert.ok(commands[1].includes("2"));
  assert.throws(() => conversionCommands({}, { duration: 0 }), /Nothing was recorded/);
});

test("real FFmpeg conversion creates playable video, separate companions and mixed 16kHz notes audio", async (t) => {
  const ffmpeg = process.env.FFMPEG_BIN || "ffmpeg";
  try { await runCommand(ffmpeg, ["-version"]); } catch { t.skip("FFmpeg is unavailable on this host"); return; }
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "ember-win-media-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const files = recordingFiles(path.join(folder, "recording.mp4"));
  await runCommand(ffmpeg, ["-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=10", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "0.6", "-c:v", "libvpx", "-c:a", "libopus", files.rawVideo]);
  await runCommand(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=blue:size=160x120:rate=10", "-t", "0.6", "-c:v", "libvpx", files.rawCamera]);
  await runCommand(ffmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000", "-t", "0.6", "-c:a", "libopus", files.rawSystem]);
  await convertRecording(ffmpeg, files, { duration: 0.6, microphone: true, camera: true, system: true });
  for (const name of ["video", "camera", "system", "thumb", "wav"]) assert.ok((await fs.stat(files[name])).size > 100);
  const wav = wavToSamples(await fs.readFile(files.wav));
  assert.ok(wav.samples.length >= 9000 && wav.samples.length < 11000);
  assert.ok(wav.samples.some((value) => Math.abs(value) > 0.01));
  await runCommand(ffmpeg, ["-v", "error", "-i", files.video, "-f", "null", "-"]);
  await runCommand(ffmpeg, ["-v", "error", "-i", files.camera, "-f", "null", "-"]);
});

test("a lost capture renderer aborts encoding and never reports a successful recording", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "ember-win-abort-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  let encodingSignal;
  const h = harness(folder, async (_ffmpeg, _files, _metadata, _run, { signal }) => {
    encodingSignal = signal;
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Encoding aborted")), { once: true }));
  });
  const child = h.backend.start(["record", "--out", path.join(folder, "recording.mp4"), "--display", "7"]);
  const messages = []; child.stdout.on("data", (bytes) => messages.push(JSON.parse(bytes)));
  await settle();
  h.send({ type: "started", width: 640, height: 480, microphone: true });
  h.send({ type: "captured", duration: 1 });
  assert.equal(encodingSignal.aborted, false);
  h.windows[0].webContents.emit("render-process-gone");
  await settle();
  assert.equal(encodingSignal.aborted, true);
  assert.equal(messages.filter((message) => message.type === "error").length, 1);
  assert.ok(messages.every((message) => message.type !== "done"));
});

test("media subprocesses support cancellation without leaving a child running", async () => {
  const controller = new AbortController();
  const operation = runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal });
  controller.abort();
  await assert.rejects(operation, { name: "AbortError" });
});

test('Cursor-free desktop frames stay confined to their session and close after capture', async t => {
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'ember-desktop-frame-ipc-'));
  t.after(()=>fs.rm(folder,{recursive:true,force:true}));
  let rectangle,closed=false;
  const jpeg=Buffer.from([255,216,3,4,255,217]);
  const h=harness(folder,async()=>{},(_binary,region)=>{rectangle=region;return {nextFrame:async()=>jpeg,close:async()=>{closed=true;}};});
  const child=h.backend.start(['record','--out',path.join(folder,'recording.mp4'),'--display','7','--hide-cursor','--mic','none']);
  await settle();
  assert.deepEqual(rectangle,{x:0,y:0,width:1920,height:1080});
  assert.equal(h.handlers.get('windows-capture:config')(h.event()).nativeDesktop,true);
  const frame=h.handlers.get('windows-capture:desktop-frame');
  assert.deepEqual(Buffer.from(await frame(h.event())),jpeg);
  await assert.rejects(frame({...h.event(),senderFrame:{}}),/Unknown capture/);
  h.send({type:'started',width:1920,height:1080,microphone:false,camera:false,system:false});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  h.send({type:'captured',duration:1});await exited;
  assert.equal(closed,true);
  const cursor=JSON.parse(await fs.readFile(recordingFiles(path.join(folder,'recording.mp4')).cursor,'utf8'));
  assert.equal(cursor.cursorHidden,true);
});
