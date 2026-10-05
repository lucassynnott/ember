const path = require("node:path");
const { EventEmitter } = require("node:events");
const { BrowserWindow, ipcMain, screen } = require("electron");

const WIDTH = 640;
const HEIGHT = 460;

// The clipboard history popup: opens over whatever you're doing on its shortcut, takes the keyboard
// so you can search and pick, then hands focus back and pastes into the app you were in.
class ClipboardPicker extends EventEmitter {
  constructor() {
    super();
    this.window = null;
    this.ready = null;
    this.visible = false;
    this.target = null;

    ipcMain.on("clipboard-picker:close", (event) => {
      if (this.#from(event)) this.hide({ restoreFocus: true });
    });
    ipcMain.on("clipboard-picker:choose", (event, id, how) => {
      if (!this.#from(event)) return;
      const target = this.target;
      this.hide({ restoreFocus: false });
      this.emit("choose", { id: String(id), how: ["paste", "plain", "copy"].includes(how) ? how : "paste", target });
    });
    ipcMain.on("clipboard-picker:open-page", (event) => {
      if (!this.#from(event)) return;
      this.hide({ restoreFocus: false });
      this.emit("open-page");
    });
  }

  isSender(event) {
    return this.#from(event);
  }

  #from(event) {
    return this.window && !this.window.isDestroyed() && event.sender === this.window.webContents;
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
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      type: "panel",
      webPreferences: {
        preload: path.join(__dirname, "clipboard-picker-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window.setAlwaysOnTop(true, "pop-up-menu");
    // Kept out of screen sharing: the history can hold anything you've copied.
    this.window.setContentProtection(true);
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.window.on("blur", () => {
      if (this.visible) this.hide({ restoreFocus: false });
    });
    this.window.on("closed", () => {
      this.window = null;
      this.visible = false;
    });
    this.ready = this.window.loadFile(path.join(__dirname, "..", "renderer", "dist", "clipboard.html"));
    return this.ready;
  }

  preload() {
    return this.#ensureWindow();
  }

  // target: the app that was in front ({ pid, app }), to paste back into.
  async show(target) {
    await this.#ensureWindow();
    this.target = target || null;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y, width, height } = display.workArea;
    this.window.setBounds({ x: Math.round(x + (width - WIDTH) / 2), y: Math.round(y + height * 0.22), width: WIDTH, height: HEIGHT });
    this.window.webContents.send("clipboard-picker:open", { app: target?.app || "" });
    this.window.show();
    this.window.focus();
    this.visible = true;
  }

  toggle(target) {
    if (this.visible) this.hide({ restoreFocus: true });
    else void this.show(target);
  }

  hide({ restoreFocus = true } = {}) {
    if (!this.visible) return;
    this.visible = false;
    if (this.window && !this.window.isDestroyed()) this.window.hide();
    if (restoreFocus && this.target?.pid) this.emit("restore-focus", this.target);
  }

  destroy() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
  }
}

module.exports = { ClipboardPicker };
