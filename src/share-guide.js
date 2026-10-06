// A small card that floats over the browser while sharing is set up, saying what to do in
// Cloudflare and Composio at each step and moving on by itself as each one is done.
const { BrowserWindow, ipcMain, screen, shell } = require("electron");
const path = require("node:path");

const SIZE = { width: 380, height: 420 };
const CLOUDFLARE_KEYS = "https://dash.cloudflare.com/profile/api-tokens";

class ShareGuide {
  constructor({ rendererDir }) {
    this.rendererDir = rendererDir;
    this.window = null;
    this.state = null;
    this.waiters = new Map();
    this.onCancel = null;
    ipcMain.handle("guide:state", (event) => (this.#mine(event) ? this.state : null));
    ipcMain.on("guide:action", (event, action) => this.#mine(event) && this.#action(String(action)));
    // The window is as tall as its card, so the rest of the screen stays clickable.
    ipcMain.on("guide:resize", (event, height) => {
      if (!this.#mine(event)) return;
      const [width] = this.window.getSize();
      this.window.setSize(width, Math.max(120, Math.min(640, Math.round(Number(height) || SIZE.height))));
    });
  }

  #mine(event) {
    return this.window && !this.window.isDestroyed() && event.sender === this.window.webContents;
  }

  /** Shows the card at a step: { step, message?, url?, substep? }. */
  show(state) {
    this.state = { ...this.state, ...state };
    if (!this.window || this.window.isDestroyed()) {
      const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      this.window = new BrowserWindow({
        width: SIZE.width,
        height: SIZE.height,
        x: Math.round(workArea.x + workArea.width - SIZE.width - 20),
        y: Math.round(workArea.y + 20),
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
        // Clicks work, but the browser keeps the keyboard for pasting.
        focusable: false,
        type: "panel",
        backgroundColor: "#00000000",
        webPreferences: {
          preload: path.join(__dirname, "guide-preload.js"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      this.window.setAlwaysOnTop(true, "floating");
      this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      this.window.on("closed", () => (this.window = null));
      this.window.once("ready-to-show", () => this.window?.showInactive());
      void this.window.loadFile(path.join(this.rendererDir, "record.html"), { hash: "guide" });
    } else {
      this.window.webContents.send("guide:state", this.state);
      if (!this.window.isVisible()) this.window.showInactive();
    }
  }

  hide() {
    clearTimeout(this.closeTimer);
    for (const [, waiter] of this.waiters) waiter.reject(new Error("Cancelled."));
    this.waiters.clear();
    this.state = null;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }

  /** Done: shows it for a moment, then goes. */
  finish(state) {
    this.show(state);
    clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => this.hide(), 7000);
  }

  /** Resolves when the person presses the step's button (e.g. "I've copied it"). */
  waitFor(action) {
    return new Promise((resolve, reject) => this.waiters.set(action, { resolve, reject }));
  }

  #action(action) {
    if (action === "cancel") {
      this.onCancel?.();
      this.hide();
      return;
    }
    if (action === "back") {
      this.onBack?.();
      this.hide();
      return;
    }
    if (action === "open-keys") return void shell.openExternal(CLOUDFLARE_KEYS);
    if (action === "open-link" && /^https:\/\//.test(this.state?.url || "")) return void shell.openExternal(this.state.url);
    if (action === "open-r2" && /^https:\/\/dash\.cloudflare\.com\//.test(this.state?.url || "")) return void shell.openExternal(this.state.url);
    const waiter = this.waiters.get(action);
    if (waiter) {
      this.waiters.delete(action);
      waiter.resolve();
    }
  }
}

module.exports = { ShareGuide, CLOUDFLARE_KEYS };
