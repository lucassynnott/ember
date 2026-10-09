const path = require("node:path");
const { EventEmitter } = require("node:events");
const { BrowserWindow, ipcMain, screen } = require("electron");

const WIDTH = 440;
const MIN_HEIGHT = 56;
const MAX_HEIGHT = 460;
const TOP_GAP = 6;

// The coach chip: a small pill at the top of the screen during calls with the call's goal, how much of the
// checklist is covered, time left, and a short cue now and then ("You've been talking a while"). Click it to see the
// checklist. Like the ask card it never takes focus and asks macOS to keep it out of screen shares.
class CoachChip extends EventEmitter {
  constructor() {
    super();
    this.window = null;
    this.ready = null;
    this.visible = false;
    this.state = null;
    this.height = MIN_HEIGHT;
    this.display = null;

    ipcMain.on("coach-chip:resize", (event, height) => {
      if (!this.#from(event)) return;
      this.height = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Number(height) || MIN_HEIGHT)));
      if (this.visible) this.#position();
    });
    ipcMain.on("coach-chip:action", (event, name, value) => {
      if (!this.#from(event)) return;
      if (["toggle-item", "hide", "open-live", "open-source", "settings"].includes(name)) this.emit("action", name, value);
    });
    ipcMain.handle("coach-chip:state", (event) => (this.#from(event) ? this.state : null));
  }

  #from(event) {
    return this.window && !this.window.isDestroyed() && event.sender === this.window.webContents;
  }

  #ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return this.ready;
    this.window = new BrowserWindow({
      width: WIDTH,
      height: this.height,
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
        preload: path.join(__dirname, "coach-chip-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window.setAlwaysOnTop(true, "floating");
    this.window.setContentProtection(true);
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    this.window.on("closed", () => {
      this.window = null;
      this.visible = false;
    });
    this.ready = this.window.loadFile(path.join(__dirname, "..", "renderer", "dist", "coach-chip.html"));
    return this.ready;
  }

  #position() {
    if (!this.window || this.window.isDestroyed()) return;
    const display = this.display || screen.getPrimaryDisplay();
    const { x, y, width } = display.workArea;
    this.window.setBounds({ x: Math.round(x + (width - WIDTH) / 2), y: y + TOP_GAP, width: WIDTH, height: this.height });
  }

  async show(state) {
    this.state = state;
    await this.#ensureWindow();
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send("coach-chip:state", state);
    if (!this.visible) {
      this.display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      this.#position();
      this.window.showInactive();
      this.visible = true;
    }
  }

  update(state) {
    this.state = state;
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send("coach-chip:state", state);
  }

  hide() {
    this.visible = false;
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }

  destroy() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
  }
}

module.exports = { CoachChip };
