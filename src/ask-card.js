const path = require("node:path");
const { EventEmitter } = require("node:events");
const { BrowserWindow, ipcMain, screen } = require("electron");

const WIDTH = 560;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 520;
// Leaves room for the dictation pill below it.
const BOTTOM_GAP = 96;

// The floating card that shows a spoken question's answer. It can be clicked but never takes focus,
// so whatever you were typing in keeps the keyboard.
class AskCard extends EventEmitter {
  constructor({ getMeetings, onOpenMeeting }) {
    super();
    this.getMeetings = getMeetings;
    this.onOpenMeeting = onOpenMeeting;
    this.window = null;
    this.ready = null;
    this.visible = false;
    this.state = {};
    this.height = 200;
    this.anchor = null;

    ipcMain.on("ask-card:close", (event) => {
      if (this.#from(event)) this.hide();
    });
    ipcMain.on("ask-card:open-meeting", (event, id) => {
      if (!this.#from(event)) return;
      this.hide();
      this.onOpenMeeting(String(id));
    });
    ipcMain.on("ask-card:resize", (event, height) => {
      if (!this.#from(event)) return;
      this.height = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Number(height) || MIN_HEIGHT)));
      if (this.visible) this.#position();
    });
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
        preload: path.join(__dirname, "ask-card-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window.setAlwaysOnTop(true, "screen-saver");
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.window.on("closed", () => {
      this.window = null;
      this.visible = false;
    });
    this.ready = this.window.loadFile(path.join(__dirname, "..", "renderer", "dist", "ask-card.html"));
    return this.ready;
  }

  #position() {
    if (!this.window || this.window.isDestroyed()) return;
    const display = this.anchor || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y, width, height } = display.workArea;
    this.window.setBounds({
      x: Math.round(x + (width - WIDTH) / 2),
      y: Math.round(y + height - BOTTOM_GAP - this.height),
      width: WIDTH,
      height: this.height,
    });
  }

  async show(state) {
    await this.#ensureWindow();
    this.anchor = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    this.state = { ...state, meetings: await this.getMeetings().catch(() => []) };
    this.window.webContents.send("ask-card:state", this.state);
    this.#position();
    this.window.showInactive();
    this.visible = true;
  }

  update(change) {
    if (!this.window || this.window.isDestroyed()) return;
    this.state = { ...this.state, ...change };
    this.window.webContents.send("ask-card:state", this.state);
  }

  hide() {
    const wasVisible = this.visible;
    this.visible = false;
    if (this.window && !this.window.isDestroyed()) this.window.hide();
    if (wasVisible) this.emit("closed");
  }

  destroy() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
  }
}

module.exports = { AskCard };
