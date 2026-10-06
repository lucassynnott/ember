const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { recordingFiles, convertRecording } = require("./windows-recording-media");

function optionsFromArgs(args) {
  const options = {};
  for (let i = 1; i < args.length; i++) {
    const name = args[i];
    if (["--system-audio", "--hide-cursor"].includes(name)) options[name] = true;
    else if (name.startsWith("--")) options[name] = args[++i];
  }
  return options;
}

class WindowsCapture {
  constructor({ electron, rendererDir, getFfmpeg, helper, convert = convertRecording, createDesktopFrames = (binary, rectangle) => new (require("./windows-desktop-frames").DesktopFrames)(binary, rectangle) }) {
    Object.assign(this, { electron, rendererDir, getFfmpeg, helper, convert, createDesktopFrames });
    this.sessions = new Map();
    const authorized = (event) => {
      const state = this.sessions.get(event.sender.id);
      if (!state || event.senderFrame !== event.sender.mainFrame) throw new Error("Unknown capture session.");
      return state;
    };
    electron.ipcMain.handle("windows-capture:desktop-frame", async event => {
      const state = authorized(event);
      if (!state.desktop || state.ended || state.finishing) throw new Error("Native desktop capture is unavailable.");
      let timer;
      try {
        const bytes = await Promise.race([state.desktop.nextFrame(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Desktop capture did not produce a frame.")), 10000); })]);
        return Uint8Array.from(bytes).buffer;
      } catch (error) { this.fail(state, error); throw error; }
      finally { clearTimeout(timer); }
    });
    electron.ipcMain.handle("windows-capture:config", (event) => authorized(event).config);
    electron.ipcMain.handle("windows-capture:chunk", (event, { kind, bytes }) => {
      const state = authorized(event);
      if (state.finishing || !["video", "camera", "system"].includes(kind) || !(bytes instanceof ArrayBuffer) || bytes.byteLength > 32 * 1024 * 1024) throw new Error("Invalid capture data.");
      const file = state.files[{ video: "rawVideo", camera: "rawCamera", system: "rawSystem" }[kind]];
      if (!state.fds.has(kind)) state.fds.set(kind, fs.openSync(file, "wx", 0o600));
      const buffer = Buffer.from(bytes);
      let written = 0;
      while (written < buffer.length) written += fs.writeSync(state.fds.get(kind), buffer, written, buffer.length - written);
      return true;
    });
    electron.ipcMain.on("windows-capture:event", (event, message) => {
      let state;
      try { state = authorized(event); } catch { return; }
      void this.onMessage(state, message).catch((error) => this.fail(state, error));
    });
  }
  async list() {
    const [sources, native] = await Promise.all([
      this.electron.desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } }),
      this.helper.windows(),
    ]);
    const frames = new Map(native.windows.map((window) => [window.id, window]));
    return { windows: sources.map((source) => {
      const id = Number(source.id.split(":")[1]);
      const info = frames.get(id);
      const bounds = info?.bounds ? this.electron.screen.screenToDipRect(null, info.bounds) : null;
      return { id, app: info?.app || "", title: source.name, frame: bounds ? [bounds.x, bounds.y, bounds.width, bounds.height] : null, frameGlobal: true };
    }) };
  }
  start(args) {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
    const state = { child, abort: new AbortController(), fds: new Map(), finishing: false, ended: false, paused: false, queued: [], samples: [], pauseMs: 0 };
    let commands = "";
    child.stdin.on("data", (chunk) => {
      commands += chunk.toString();
      let newline;
      while ((newline = commands.indexOf("\n")) >= 0) {
        const command = commands.slice(0, newline).trim(); commands = commands.slice(newline + 1);
        this.command(state, command);
      }
    });
    child.kill = () => { this.command(state, "cancel"); return true; };
    void this.initialize(state, optionsFromArgs(args)).catch((error) => this.fail(state, error));
    return child;
  }
  async initialize(state, options) {
    state.files = recordingFiles(options["--out"]);
    const display = this.electron.screen.getAllDisplays().find((candidate) => String(candidate.id) === options["--display"]);
    const sources = options["--camera"] ? [] : await this.electron.desktopCapturer.getSources({ types: [options["--window"] ? "window" : "screen"], thumbnailSize: { width: 0, height: 0 } });
    if (state.ended) return;
    const source = options["--window"]
      ? sources.find((candidate) => candidate.id.split(":")[1] === options["--window"])
      : sources.find((candidate) => candidate.display_id === options["--display"]);
    if (!options["--camera"] && !source) throw new Error("The selected screen or window is no longer available.");
    const rect = options["--rect"] ? options["--rect"].split(",").map(Number) : null;
    state.config = {
      sourceId: source?.id || null, displaySize: display?.size || null,
      rect: rect ? { x: rect[0], y: rect[1], width: rect[2], height: rect[3] } : null,
      microphone: options["--mic"] || "default", camera: options["--camera"] || options["--camera-track"] || null,
      cameraOnly: Boolean(options["--camera"]), systemAudio: Boolean(options["--system-audio"]), fps: 30,
    };
    if (display) state.region = rect
      ? { x: display.bounds.x + rect[0], y: display.bounds.y + rect[1], width: rect[2], height: rect[3] }
      : display.bounds;
    else if (options["--window"]) {
      const window = (await this.list()).windows.find((candidate) => String(candidate.id) === options["--window"]);
      if (window?.frame) { const [x, y, width, height] = window.frame; state.region = { x, y, width, height }; }
    }
    if (state.ended) return;
    if (options["--hide-cursor"] && display && !options["--window"] && !options["--camera"]) {
      const physical = this.electron.screen.dipToScreenRect(null, display.bounds);
      state.desktop = this.createDesktopFrames(this.getFfmpeg(), physical);
      state.config.nativeDesktop = true;
    }
    const window = new this.electron.BrowserWindow({
      show: false, focusable: false, skipTaskbar: true,
      webPreferences: { preload: path.join(__dirname, "windows-capture-preload.js"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    state.window = window;
    this.sessions.set(window.webContents.id, state);
    window.webContents.on("render-process-gone", () => this.fail(state, new Error("The capture process stopped.")));
    window.on("closed", () => { if (!state.ended) this.fail(state, new Error("The capture window closed.")); });
    await window.loadFile(path.join(this.rendererDir, "capture.html"));
  }
  command(state, command) {
    if (state.ended || state.finishing) return;
    if (command === "cancel" && !state.started) { this.emit(state, { type: "cancelled" }); this.close(state); return; }
    if (!state.started) { state.queued.push(command); return; }
    if (command === "pause" && !state.paused) { state.paused = true; state.pauseStarted = performance.now(); }
    if (command === "resume" && state.paused) { state.paused = false; state.pauseMs += performance.now() - state.pauseStarted; }
    state.window.webContents.send("windows-capture:command", command);
  }
  emit(state, message) { state.child.stdout.write(`${JSON.stringify(message)}\n`); }
  async onMessage(state, message) {
    if (state.ended || state.finishing) return;
    switch (message.type) {
      case "started":
        state.started = performance.now(); state.metadata = message;
        this.emit(state, { type: "started" });
        if (state.region) {
          state.pointer = (pointer) => {
            if (state.paused || state.finishing || state.ended) return;
            const point = this.electron.screen.screenToDipPoint({ x: pointer.x, y: pointer.y });
            const region = state.region;
            state.samples.push([(performance.now() - state.started - state.pauseMs) / 1000, (point.x - region.x) / region.width, (point.y - region.y) / region.height, pointer.pressed ? 1 : 0, pointer.shape || 0]);
          };
          this.helper.on("pointer", state.pointer); this.helper.watchPointer(true);
        }
        for (const command of state.queued.splice(0)) this.command(state, command);
        break;
      case "level": this.emit(state, { type: "level", value: Number(message.value) || 0 }); break;
      case "cancelled": this.emit(state, { type: "cancelled" }); this.close(state); break;
      case "captured":
        state.finishing = true;
        for (const fd of state.fds.values()) fs.closeSync(fd);
        state.fds.clear();
        await this.convert(this.getFfmpeg(), state.files, { ...state.metadata, duration: message.duration }, undefined, { signal: state.abort.signal });
        if (state.ended) return;
        await fsp.writeFile(state.files.cursor, JSON.stringify({ version: 2, region: state.region ? [state.region.x, state.region.y, state.region.width, state.region.height] : [], shapes: ["arrow", "text", "pointer", "grab", "grabbing", "crosshair", "resize-x", "resize-y", "not-allowed"], cursorHidden: Boolean(state.desktop), samples: state.samples }), { mode: 0o600 });
        await Promise.all(["rawVideo", "rawCamera", "rawSystem"].map((kind) => fsp.rm(state.files[kind], { force: true })));
        this.emit(state, { ...state.metadata, type: "done", duration: message.duration, file: state.files.video, wav: state.files.wav, thumb: state.files.thumb, cursor: state.files.cursor, camera: state.metadata.camera ? state.files.camera : null, system: state.metadata.system ? state.files.system : null });
        this.close(state);
        break;
      case "error": this.fail(state, new Error(message.message || "Windows capture failed.")); break;
    }
  }
  fail(state, error) { if (state.ended) return; this.emit(state, { type: "error", message: error.message }); this.close(state, 1); }
  async close(state, code = 0) {
    if (state.ended) return;
    state.ended = true;
    state.abort.abort();
    for (const fd of state.fds.values()) fs.closeSync(fd);
    state.fds.clear();
    if (state.pointer) { this.helper.off("pointer", state.pointer); this.helper.watchPointer(false); }
    if (state.window) { this.sessions.delete(state.window.webContents.id); if (!state.window.isDestroyed()) state.window.destroy(); }
    if (state.desktop) await state.desktop.close();
    state.child.emit("exit", code); state.child.emit("close", code);
  }
}
module.exports = { WindowsCapture, optionsFromArgs };
