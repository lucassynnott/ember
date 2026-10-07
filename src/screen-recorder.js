// Ember Record: the windows around a screen recording and the native helper that makes it.
//
//   setup   a small card to pick the screen, a window, an area or the camera alone, the camera and the microphone
//   camera  the round camera bubble; a window on screen, so it's in the recording
//   area    a full-display overlay to drag out the area to record
//   count   3, 2, 1 before it starts
//   controls the pill with stop, the time, pause, restart and delete; left out of the recording
//   frame   a dashed outline around the area being recorded; left out too
//
// All of them are record.html with the window's role in the hash.
const { BrowserWindow, ipcMain, screen, systemPreferences } = require("electron");
const { spawn } = require("node:child_process");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const path = require("node:path");

const CAMERA_SIZES = { small: 150, medium: 220, large: 320 };
const CONTROLS = { width: 64, height: 380 };
const SETUP = { width: 380, height: 540 };

function mediaWindowId(window) {
  if (!window || window.isDestroyed()) return null;
  const match = /^window:(\d+):/.exec(window.getMediaSourceId());
  return match ? match[1] : null;
}

function displayUnderCursor() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

class ScreenRecorder extends EventEmitter {
  constructor({ binaryPath, rendererDir, preload, store, getSettings, savePrefs, notify, captureBackend = null }) {
    super();
    this.binaryPath = binaryPath;
    this.captureBackend = captureBackend;
    this.rendererDir = rendererDir;
    this.preload = preload;
    this.store = store;
    this.getSettings = getSettings;
    this.savePrefs = savePrefs;
    this.notify = notify;
    this.state = "idle"; // idle | setup | preparing | area | countdown | starting | recording | saving
    this.windows = {};
    this.options = null;
    this.child = null;
    this.cameraSize = "medium";
    this.#handleIpc();
  }

  get busy() {
    return this.state !== "idle";
  }

  get recording() {
    return this.state === "starting" || this.state === "recording" || this.state === "saving";
  }

  /** The shortcut: opens the setup card, starts from it, or stops a recording. */
  toggle() {
    if (this.state === "idle") return void this.open();
    if (this.state === "setup") return void this.#send("setup", "record:start-now");
    if (this.state === "recording") return void this.stop();
    if (this.state === "countdown") return void this.#cancelFlow();
  }

  async open() {
    if (this.state !== "idle") {
      this.windows.setup?.show();
      return;
    }
    if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") === "denied") {
      this.notify("Ember can't record the screen", "Allow Ember in System Settings → Privacy & Security → Screen & System Audio Recording.");
    }
    this.state = "setup";
    const display = displayUnderCursor();
    const { workArea } = display;
    this.#make("setup", {
      width: SETUP.width,
      height: SETUP.height,
      x: Math.round(workArea.x + workArea.width - SETUP.width - 28),
      y: Math.round(workArea.y + 24),
      focusable: true,
    });
    this.windows.setup.once("ready-to-show", () => {
      this.windows.setup?.show();
      this.windows.setup?.focus();
    });
    const prefs = this.getSettings();
    if (prefs.recordCamera) await this.#showCamera(prefs.recordCameraId, display);
  }

  // Everything the setup card offers: displays from Electron (their ids are CoreGraphics display
  // ids) and windows from the helper, which sees them the way ScreenCaptureKit does.
  async sources() {
    const displays = screen.getAllDisplays().map((display, index) => ({
      id: display.id,
      label: display.label || `Display ${index + 1}`,
      width: display.size.width,
      height: display.size.height,
      primary: display.id === screen.getPrimaryDisplay().id,
      current: display.id === displayUnderCursor().id,
    }));
    let windows = [];
    try {
      const listed = this.captureBackend ? await this.captureBackend.list() : JSON.parse(await this.#run(["list"]));
      windows = (listed.windows || []).map((window) => ({ id: window.id, app: window.app, title: window.title, frame: window.frame, frameGlobal: window.frameGlobal }));
    } catch (error) {
      console.warn("Record: couldn't list windows:", error.message);
    }
    const prefs = this.getSettings();
    return {
      displays,
      windows,
      prefs: {
        mode: prefs.recordMode,
        camera: prefs.recordCamera,
        cameraId: prefs.recordCameraId,
        microphone: prefs.microphoneLabel || "default",
        countdown: prefs.recordCountdownSeconds ?? (prefs.recordCountdown === false ? 0 : 3),
        systemAudio: Boolean(prefs.recordSystemAudio),
        shortcut: prefs.recordHotkeyLabel || "",
      },
    };
  }

  async start(options) {
    if (this.state !== "setup") return;
    const mode = ["screen", "window", "area", "camera"].includes(options?.mode) ? options.mode : "screen";
    this.options = {
      mode,
      displayId: Number(options.displayId) || displayUnderCursor().id,
      windowId: Number(options.windowId) || null,
      microphone: options.microphone === "none" ? "none" : String(options.microphone || "default"),
      cameraName: String(options.cameraName || "default"),
      systemAudio: Boolean(options.systemAudio),
      rect: null,
    };
    await this.savePrefs({ recordMode: mode, recordSystemAudio: Boolean(options.systemAudio), ...([0, 3, 5, 10].includes(options.countdown) ? { recordCountdownSeconds: options.countdown } : {}) });
    if (mode === "window" && !this.options.windowId) return this.#send("setup", "record:error", "Pick a window to record.");
    this.state = "preparing";
    this.#close("setup");

    if (mode === "area") {
      this.state = "area";
      const display = screen.getAllDisplays().find((candidate) => candidate.id === this.options.displayId) || displayUnderCursor();
      this.options.displayId = display.id;
      this.#make("area", { ...display.bounds, focusable: true, enableLargerThanScreen: true });
      this.windows.area.once("ready-to-show", () => {
        this.windows.area?.show();
        this.windows.area?.focus();
      });
      return;
    }
    if (mode === "window") this.#placeCameraOver(this.#windowFrame());
    // Camera only records the camera itself; the bubble stays as your preview.
    if (mode === "camera" && !this.windows.camera) await this.#showCamera(this.getSettings().recordCameraId);
    await this.#countdown();
  }

  async areaChosen(rect) {
    if (this.state !== "area") return;
    this.#close("area");
    if (!rect || rect.width < 40 || rect.height < 40) return this.#cancelFlow();
    const display = screen.getAllDisplays().find((candidate) => candidate.id === this.options.displayId);
    const bounds = display.bounds;
    const x = Math.max(0, Math.round(rect.x)), y = Math.max(0, Math.round(rect.y));
    this.options.rect = {
      x,
      y,
      width: Math.min(bounds.width - x, Math.round(rect.width)),
      height: Math.min(bounds.height - y, Math.round(rect.height)),
    };
    const global = { x: bounds.x + x, y: bounds.y + y, width: this.options.rect.width, height: this.options.rect.height };
    this.#placeCameraOver(global);
    // The outline sits just outside the area, so it's never in the picture.
    const pad = 6;
    this.#make("frame", { x: global.x - pad, y: global.y - pad, width: global.width + pad * 2, height: global.height + pad * 2, focusable: false });
    this.windows.frame.setIgnoreMouseEvents(true);
    this.windows.frame.once("ready-to-show", () => this.windows.frame?.showInactive());
    await this.#countdown();
  }

  async #countdown() {
    this.state = "countdown";
    const display = this.#targetDisplay();
    const seconds = this.getSettings().recordCountdownSeconds ?? 3;
    if (!seconds) return this.#begin();
    // Room around the 200 px circle for its glow, so the window's edge never shows.
    const size = 340;
    const area = this.options.rect
      ? { x: display.bounds.x + this.options.rect.x, y: display.bounds.y + this.options.rect.y, width: this.options.rect.width, height: this.options.rect.height }
      : display.workArea;
    this.#make("count", {
      width: size,
      height: size,
      x: Math.round(area.x + (area.width - size) / 2),
      y: Math.round(area.y + (area.height - size) / 2),
      focusable: false,
    });
    await new Promise((resolve) => this.windows.count.once("ready-to-show", resolve));
    this.windows.count?.showInactive();
    for (let number = seconds; number >= 1; number -= 1) {
      if (this.state !== "countdown") return;
      this.#send("count", "record:count", number);
      await new Promise((resolve) => {
        this.skipCount = resolve;
        setTimeout(resolve, 900);
      });
      if (this.skipped) break;
    }
    this.skipped = false;
    this.#close("count");
    if (this.state === "countdown") await this.#begin();
  }

  async #begin() {
    this.state = "starting";
    await this.#showControls();
    // Leave out Ember's own controls and outline; for a window, take the camera bubble along.
    const exclude = ["controls", "frame", "count"].map((name) => mediaWindowId(this.windows[name])).filter(Boolean);
    const camera = mediaWindowId(this.windows.camera);
    this.recordingId = this.store.newId();
    const folder = this.store.folder(this.recordingId);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    this.outPath = this.store.file(this.recordingId, "video");

    const args = ["record", "--out", this.outPath, "--mic", this.options.microphone, "--fps", "30"];
    // With the screen, the camera is its own video for the editor to place; the bubble on screen is
    // just your preview, and where it sits is where the camera starts out in the editor.
    this.cameraLayout = null;
    if (this.options.mode !== "camera" && camera) {
      args.push("--camera-track", this.options.cameraName);
      exclude.push(camera);
      this.cameraLayout = this.#cameraLayout();
    }
    if (this.options.mode !== "camera" && this.getSettings().recordHideCursor !== false) args.push("--hide-cursor");
    if (this.options.systemAudio) args.push("--system-audio");
    if (this.options.mode === "camera") {
      args.push("--camera", this.options.cameraName);
    } else if (this.options.mode === "window") {
      args.push("--window", String(this.options.windowId));
    } else {
      args.push("--display", String(this.options.displayId));
      if (this.options.rect) {
        const { x, y, width, height } = this.options.rect;
        args.push("--rect", [x, y, width, height].join(","));
      }
      if (exclude.length) args.push("--exclude", exclude.join(","));
    }
    this.elapsed = 0;
    this.runningSince = null;
    this.paused = false;
    this.restartRequested = false;
    this.#spawn(args);
    this.#broadcast();
  }

  #spawn(args) {
    const child = this.captureBackend ? this.captureBackend.start(args) : spawn(this.binaryPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          this.#onMessage(JSON.parse(line));
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => console.warn("Record helper:", chunk.toString().trim()));
    child.on("error", (error) => this.#onMessage({ type: "error", message: error.message }));
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.recording) this.#onMessage({ type: "error", message: `The recorder stopped unexpectedly (${code}).` });
    });
  }

  #onMessage(message) {
    switch (message.type) {
      case "started":
        this.state = "recording";
        this.runningSince = Date.now();
        this.#broadcast();
        break;
      case "level":
        this.#send("controls", "record:level", message.value);
        break;
      case "warning":
        this.notify("Ember Record", message.message);
        break;
      case "saving":
        this.elapsed = Number.isFinite(message.duration) ? Math.max(0, message.duration * 1000) : this.elapsed + (this.runningSince ? Date.now() - this.runningSince : 0);
        this.runningSince = null;
        this.state = "saving";
        this.#broadcast();
        break;
      case "cancelled":
        this.child = null;
        if (this.restartRequested) {
          this.restartRequested = false;
          this.#close("controls");
          this.state = "countdown";
          void this.#countdown();
        } else {
          this.#cleanup();
        }
        break;
      case "done":
        this.child = null;
        void this.#finished(message);
        break;
      case "error":
        this.child = null;
        this.notify("Recording stopped", message.message || "Something went wrong.");
        this.#cleanup();
        break;
    }
  }

  async #finished(message) {
    const id = this.recordingId;
    const source =
      this.options.mode === "camera"
        ? "Camera only"
        : this.options.mode === "window"
        ? "A window"
        : this.options.rect
          ? "An area of the screen"
          : "The whole screen";
    try {
      await this.store.add(id, {
        createdAt: new Date(Date.now() - message.duration * 1000).toISOString(),
        duration: Math.round(message.duration * 10) / 10,
        width: message.width,
        height: message.height,
        source,
        status: "pending",
        camera: message.camera ? { layout: this.cameraLayout || { x: 0.1, y: 0.82, size: 0.28 } } : null,
      });
      this.#cleanup();
      this.emit("recorded", id);
    } catch (error) {
      this.#cleanup();
      this.notify("Couldn't save the recording", error.message);
    }
  }

  control(command) {
    if (!this.child || !["starting", "recording"].includes(this.state)) {
      if (command === "cancel" || command === "stop") this.#cancelFlow();
      return;
    }
    switch (command) {
      case "pause":
        if (this.paused || this.state !== "recording") return;
        this.paused = true;
        this.elapsed += Date.now() - this.runningSince;
        this.runningSince = null;
        this.child.stdin.write("pause\n");
        break;
      case "resume":
        if (!this.paused) return;
        this.paused = false;
        this.runningSince = Date.now();
        this.child.stdin.write("resume\n");
        break;
      case "stop":
        this.stop();
        return;
      case "hide-controls":
        this.windows.controls?.hide();
        this.emit("controls-hidden");
        return;
      case "toggle-camera":
        // The camera keeps recording to its own file; this is only the bubble you see.
        if (this.windows.camera?.isVisible()) this.windows.camera.hide();
        else this.windows.camera?.showInactive();
        this.#broadcast();
        return;
      case "restart":
        this.restartRequested = true;
        this.child.stdin.write("cancel\n");
        break;
      case "cancel":
        this.child.stdin.write("cancel\n");
        break;
    }
    this.#broadcast();
  }

  showControls() {
    this.windows.controls?.showInactive();
  }

  /** Outlines a window on screen for a moment, so you can see which one you picked. */
  highlight(windowId) {
    const window = this.lastWindows?.find((candidate) => candidate.id === Number(windowId));
    if (!window?.frame || this.state !== "setup") return;
    const [x, y, width, height] = window.frame;
    const pad = 6;
    this.#make("flash", { x: Math.round(x - pad), y: Math.round(y - pad), width: Math.round(width + pad * 2), height: Math.round(height + pad * 2), focusable: false });
    this.windows.flash.setIgnoreMouseEvents(true);
    this.windows.flash.once("ready-to-show", () => this.windows.flash?.showInactive());
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.#close("flash"), 1200);
  }

  stop() {
    if (!this.child || this.state === "saving") return;
    this.elapsed += this.runningSince ? Date.now() - this.runningSince : 0;
    this.runningSince = null;
    this.state = "saving";
    this.child.stdin.write("stop\n");
    this.#broadcast();
  }

  /** Before quitting: a recording in progress is saved first. */
  stopAndWait() {
    if (!this.recording) {
      this.#cancelFlow();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => resolve();
      this.once("idle", done);
      this.stop();
      setTimeout(done, 15000);
    });
  }

  #cancelFlow() {
    this.child?.stdin.write("cancel\n");
    this.#cleanup();
  }

  #cleanup() {
    for (const name of Object.keys(this.windows)) this.#close(name);
    if (this.recordingId && this.outPath && !this.store.get(this.recordingId)) {
      fs.rm(path.dirname(this.outPath), { recursive: true, force: true }, () => {});
    }
    this.state = "idle";
    this.options = null;
    this.recordingId = null;
    this.outPath = null;
    this.emit("idle");
  }

  #broadcast() {
    const status = {
      state: this.state,
      paused: this.paused,
      elapsed: this.elapsed + (this.runningSince ? Date.now() - this.runningSince : 0),
      running: Boolean(this.runningSince),
      camera: this.windows.camera ? this.windows.camera.isVisible() : null,
    };
    this.#send("controls", "record:state", status);
    this.emit("state", status);
  }

  /* Camera */

  async #showCamera(deviceId, display = displayUnderCursor()) {
    if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("camera") !== "granted") {
      const granted = await systemPreferences.askForMediaAccess("camera").catch(() => false);
      if (!granted) {
        this.notify("Ember can't use the camera", "Allow Ember in System Settings → Privacy & Security → Camera.");
        return;
      }
    }
    const size = CAMERA_SIZES[this.cameraSize];
    if (!this.windows.camera) {
      const { workArea } = display;
      this.#make("camera", {
        width: size,
        height: size,
        x: Math.round(workArea.x + 40),
        y: Math.round(workArea.y + workArea.height - size - 40),
        focusable: false,
        movable: true,
      });
      this.windows.camera.once("ready-to-show", () => this.windows.camera?.showInactive());
    }
    this.cameraDevice = deviceId || "";
    this.#send("camera", "record:camera", { deviceId: this.cameraDevice, size: this.cameraSize });
  }

  async camera({ on, deviceId }) {
    await this.savePrefs({ recordCamera: Boolean(on), ...(typeof deviceId === "string" ? { recordCameraId: deviceId } : {}) });
    if (on) await this.#showCamera(deviceId);
    else this.#close("camera");
  }

  resizeCamera(size) {
    const camera = this.windows.camera;
    if (!camera || !CAMERA_SIZES[size]) return;
    const [x, y] = camera.getPosition();
    const [, height] = camera.getSize();
    const next = CAMERA_SIZES[size];
    this.cameraSize = size;
    // Grow from the bottom left corner, the way it sits on screen.
    camera.setBounds({ x, y: y + height - next, width: next, height: next });
    this.#send("camera", "record:camera", { deviceId: this.cameraDevice, size });
  }

  // Keeps the bubble inside what's recorded: its bottom left corner.
  #placeCameraOver(area) {
    const camera = this.windows.camera;
    if (!camera || !area) return;
    const [width, height] = camera.getSize();
    const bounds = camera.getBounds();
    const inside = bounds.x >= area.x && bounds.y >= area.y && bounds.x + width <= area.x + area.width && bounds.y + height <= area.y + area.height;
    if (inside) return;
    if (area.width < width + 40 || area.height < height + 40) return;
    camera.setPosition(Math.round(area.x + 24), Math.round(area.y + area.height - height - 24));
  }

  #windowFrame() {
    const display = screen.getPrimaryDisplay();
    const window = this.lastWindows?.find((candidate) => candidate.id === this.options?.windowId);
    if (!window?.frame) return null;
    const [x, y, width, height] = window.frame;
    return { x: window.frameGlobal ? x : display.bounds.x + x, y: window.frameGlobal ? y : display.bounds.y + y, width, height };
  }

  #targetDisplay() {
    if (this.options?.mode === "window") {
      const frame = this.#windowFrame();
      if (frame) return screen.getDisplayMatching(frame);
    }
    return screen.getAllDisplays().find((display) => display.id === this.options?.displayId) || displayUnderCursor();
  }

  // What's being recorded, in screen points.
  #capturedRegion() {
    if (this.options.mode === "window") return this.#windowFrame();
    const display = screen.getAllDisplays().find((candidate) => candidate.id === this.options.displayId) || displayUnderCursor();
    const rect = this.options.rect;
    return rect ? { x: display.bounds.x + rect.x, y: display.bounds.y + rect.y, width: rect.width, height: rect.height } : display.bounds;
  }

  // The bubble's centre and size, relative to what's recorded.
  #cameraLayout() {
    const region = this.#capturedRegion();
    const camera = this.windows.camera;
    if (!region || !camera || camera.isDestroyed()) return null;
    const bounds = camera.getBounds();
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    return {
      x: clamp((bounds.x + bounds.width / 2 - region.x) / region.width, 0, 1),
      y: clamp((bounds.y + bounds.height / 2 - region.y) / region.height, 0, 1),
      size: clamp(bounds.width / region.height, 0.08, 0.6),
    };
  }

  /* Controls */

  async #showControls() {
    if (this.windows.controls) return;
    const display = this.#targetDisplay();
    const { workArea } = display;
    this.#make("controls", {
      width: CONTROLS.width,
      height: CONTROLS.height,
      x: Math.round(workArea.x + 18),
      y: Math.round(workArea.y + (workArea.height - CONTROLS.height) / 2),
      focusable: false,
      movable: true,
    });
    await new Promise((resolve) => this.windows.controls.once("ready-to-show", resolve));
    this.windows.controls?.showInactive();
    // ScreenCaptureKit only leaves out windows that are already on screen when it starts.
    await new Promise((resolve) => setTimeout(resolve, 120));
  }

  /* Windows */

  #make(role, { focusable = false, ...bounds }) {
    this.#close(role);
    const window = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable,
      type: "panel",
      backgroundColor: "#00000000",
      webPreferences: {
        preload: this.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    // The setup and area picker must stay visible through remote desktop capture.
    // Only overlays present during recording need to be excluded from capture.
    if (process.platform === "win32" && ["controls", "frame", "count", "flash", "camera"].includes(role)) {
      window.setContentProtection(true);
    }
    window.setAlwaysOnTop(true, role === "area" ? "screen-saver" : "pop-up-menu");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    window.on("closed", () => {
      if (this.windows[role] === window) delete this.windows[role];
      // Closing the setup card any other way than starting ends the flow.
      if (role === "setup" && this.state === "setup") this.#cleanup();
    });
    void window.loadFile(path.join(this.rendererDir, "record.html"), { hash: role });
    this.windows[role] = window;
    return window;
  }

  #close(role) {
    const window = this.windows[role];
    delete this.windows[role];
    if (window && !window.isDestroyed()) window.destroy();
  }

  #send(role, channel, payload) {
    const window = this.windows[role];
    if (!window || window.isDestroyed()) return;
    const send = () => !window.isDestroyed() && window.webContents.send(channel, payload);
    if (window.webContents.isLoading()) window.webContents.once("did-finish-load", send);
    else send();
  }

  #roleOf(event) {
    return Object.entries(this.windows).find(([, window]) => !window.isDestroyed() && window.webContents === event.sender)?.[0] || null;
  }

  #run(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("error", reject);
      child.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(out.trim() || `exit ${code}`))));
      setTimeout(() => child.kill(), 8000);
    });
  }

  #handleIpc() {
    const mine = (handler) => (event, ...args) => (this.#roleOf(event) ? handler(...args) : undefined);
    ipcMain.handle("record:sources", async (event) => {
      if (!this.#roleOf(event)) return null;
      const result = await this.sources();
      this.lastWindows = result.windows;
      return result;
    });
    ipcMain.handle("record:status", mine(() => ({ state: this.state, paused: this.paused, elapsed: this.elapsed + (this.runningSince ? Date.now() - this.runningSince : 0), running: Boolean(this.runningSince), cameraSize: this.cameraSize, cameraId: this.cameraDevice || "" })));
    ipcMain.handle("record:start", mine((options) => this.start(options)));
    ipcMain.handle("record:camera", mine((options) => this.camera(options || {})));
    ipcMain.on("record:camera-size", mine((size) => this.resizeCamera(size)));
    ipcMain.on("record:area", mine((rect) => void this.areaChosen(rect)));
    ipcMain.on("record:control", mine((command) => this.control(command)));
    ipcMain.on("record:skip-count", mine(() => {
      this.skipped = true;
      this.skipCount?.();
    }));
    ipcMain.on("record:close", mine(() => this.state === "setup" && this.#cleanup()));
    ipcMain.on("record:highlight", mine((windowId) => this.highlight(windowId)));
  }
}

module.exports = { ScreenRecorder, CAMERA_SIZES };
