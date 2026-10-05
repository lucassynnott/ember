const path = require("node:path");
const { BrowserWindow, ipcMain, screen } = require("electron");

const WIDTH = 420;
const HEIGHT = 64;
const RESULT_VISIBLE_MS = { pasted: 1100, copied: 1800, empty: 1500, cancelled: 900, error: 4000 };

// A floating, non-activating pill near the bottom of the screen that also records the microphone.
class DictationOverlay {
  constructor({ getMicrophoneLabel, onCaptureStart = () => {}, onCaptureEnd = () => {} }) {
    this.getMicrophoneLabel = getMicrophoneLabel;
    this.onCaptureStart = onCaptureStart;
    this.onCaptureEnd = onCaptureEnd;
    this.window = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
    this.hideTimer = null;

    ipcMain.on("capture:started", (_event, { id, error }) => this.#settle(id, error, undefined));
    ipcMain.on("capture:stopped", (_event, { id, samples, error }) =>
      this.#settle(id, error, samples ? new Float32Array(samples) : new Float32Array(0)),
    );
  }

  #settle(id, error, value) {
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    if (error) waiter.reject(new Error(error));
    else waiter.resolve(value);
  }

  #ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return this.ready;
    this.window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      type: "panel",
      webPreferences: {
        preload: path.join(__dirname, "dictation-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    this.window.setAlwaysOnTop(true, "screen-saver");
    // skipTransformProcessType: without it Electron turns the whole app into a menu-bar-only one and Ember leaves the Dock.
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    this.window.setIgnoreMouseEvents(true);
    this.window.on("closed", () => {
      this.window = null;
      for (const waiter of this.pending.values()) waiter.reject(new Error("Dictation window closed."));
      this.pending.clear();
    });
    this.ready = this.window.loadFile(path.join(__dirname, "..", "renderer", "dist", "dictation.html"));
    return this.ready;
  }

  async preload() {
    await this.#ensureWindow();
  }

  #request(channel, payload, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The microphone didn't respond. Check the Microphone setting."));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      this.window.webContents.send(channel, { id, ...payload });
    });
  }

  #position() {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y, width, height } = display.workArea;
    this.window.setBounds({
      x: Math.round(x + (width - WIDTH) / 2),
      y: Math.round(y + height - HEIGHT - 24),
      width: WIDTH,
      height: HEIGHT,
    });
  }

  async startCapture() {
    await this.#ensureWindow();
    this.onCaptureStart();
    try {
      await this.#request("capture:start", { microphoneLabel: this.getMicrophoneLabel() }, 8000);
    } catch (error) {
      this.onCaptureEnd();
      throw error;
    }
  }

  async stopCapture({ tailMs = 0 } = {}) {
    if (!this.window || this.window.isDestroyed()) return new Float32Array(0);
    try {
      return await this.#request("capture:stop", { tailMs }, tailMs + 8000);
    } finally {
      this.onCaptureEnd();
    }
  }

  cancelCapture() {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send("capture:cancel");
    this.onCaptureEnd();
  }

  show(state, message = "") {
    if (!this.window || this.window.isDestroyed()) return;
    clearTimeout(this.hideTimer);
    clearTimeout(this.hideWindowTimer);
    if (!this.window.isVisible()) this.#position();
    this.window.webContents.send("overlay:state", { state, message });
    this.window.showInactive();
    const visibleFor = RESULT_VISIBLE_MS[state];
    if (visibleFor) this.hideTimer = setTimeout(() => this.hide(), visibleFor);
  }

  hide() {
    clearTimeout(this.hideTimer);
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("overlay:state", { state: "hidden" });
    clearTimeout(this.hideWindowTimer);
    this.hideWindowTimer = setTimeout(() => {
      if (this.window && !this.window.isDestroyed()) this.window.hide();
    }, 160);
  }

  destroy() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
  }
}

module.exports = { DictationOverlay };
