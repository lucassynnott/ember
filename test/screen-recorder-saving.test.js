const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

test("automatic capture completion switches controls to saving and freezes elapsed time", async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "ember-saving-controls-"));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  class Window extends EventEmitter {
    constructor() {
      super(); this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), { isLoading: () => false, send() {} });
    }
    async loadFile() { setImmediate(() => this.emit("ready-to-show")); }
    setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} setContentProtection() {} showInactive() {}
    isDestroyed() { return this.destroyed; }
    getMediaSourceId() { return "window:77:0"; }
    destroy() { this.destroyed = true; this.emit("closed"); }
  }
  const display = { id: 7, bounds: { x: 0, y: 0, width: 1000, height: 700 }, workArea: { x: 0, y: 0, width: 1000, height: 700 } };
  const electron = { BrowserWindow: Window, ipcMain: { on() {}, handle() {} }, screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => display, getAllDisplays: () => [display] } };
  const module = { exports: {} };
  vm.runInNewContext(await fs.readFile(path.join(__dirname, "../src/screen-recorder.js"), "utf8"), {
    module, require: (name) => name === "electron" ? electron : require(name), process, console, setTimeout, clearTimeout,
  });
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write() {} } });
  const recorder = new module.exports.ScreenRecorder({
    binaryPath: "unused", rendererDir: folder, preload: "unused",
    store: { newId: () => "test", folder: () => folder, file: () => path.join(folder, "recording.mp4"), get: () => ({ id: "test" }) },
    getSettings: () => ({ recordCountdownSeconds: 0 }), savePrefs: async () => {}, notify() {}, captureBackend: { start: () => child },
  });
  recorder.state = "setup";
  const states = []; recorder.on("state", (state) => states.push(state));
  await recorder.start({ mode: "screen", displayId: 7, microphone: "none", countdown: 0 });
  const send = (message) => child.stdout.emit("data", JSON.stringify(message) + "\n");
  send({ type: "started" });
  assert.equal(recorder.state, "recording");
  send({ type: "saving", duration: 1.25 });
  assert.equal(recorder.state, "saving");
  assert.equal(states.at(-1).running, false);
  assert.equal(states.at(-1).elapsed, 1250);
  recorder.stop(); // A delayed Stop must not restart or advance the saved timer.
  assert.equal(recorder.runningSince, null);
  assert.equal(recorder.elapsed, 1250);
  send({ type: "error", message: "test cleanup" });
  assert.equal(recorder.state, "idle");
});
