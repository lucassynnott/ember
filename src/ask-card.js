const path = require("node:path");
const { EventEmitter } = require("node:events");
const { BrowserWindow, ipcMain, screen } = require("electron");

// The card is 560 px wide; the window adds a 24 px transparent margin each side for its glow.
const MARGIN = 24;
const WIDTH = 560 + MARGIN * 2;
const MIN_HEIGHT = 120 + MARGIN * 2;
const MAX_HEIGHT = 520 + MARGIN * 2;
// Leaves room for the dictation pill below it.
const BOTTOM_GAP = 96 - MARGIN;

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
    ipcMain.on("ask-card:open-source", (event, id) => {
      if (!this.#from(event)) return;
      const source = this.state.sources?.[id];
      if (source?.file) this.emit("open-source", source.file);
    });
    ipcMain.on("ask-card:join", (event) => {
      if (!this.#from(event) || !this.state.join?.url) return;
      this.emit("join", this.state.join.url);
    });
    ipcMain.on("ask-card:action", (event, name) => {
      if (this.#from(event) && ["nudge:more", "nudge:off", "nudge:fewer", "nudge:settings", "prep:off", "prep:settings"].includes(name)) this.emit("action", name);
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
    // Asks macOS to leave the card out of screen sharing and recordings. Some capture methods ignore it.
    this.window.setContentProtection(true);
    // skipTransformProcessType: without it Electron turns the whole app into a menu-bar-only one and Ember leaves the Dock.
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
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
