const { EventEmitter } = require("node:events");

const FIRST_CHECK_MS = 20 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

// Checks this repo's GitHub releases for signed builds, downloads them in the background
// and installs on restart. Never restarts by itself: a call might be recording.
class Updater extends EventEmitter {
  constructor({ app, autoUpdater, log = console }) {
    super();
    this.app = app;
    this.autoUpdater = autoUpdater;
    this.log = log;
    this.state = { state: "idle", currentVersion: app.getVersion(), supported: Boolean(app.isPackaged) };
    this.timer = null;
  }

  #set(update) {
    this.state = { ...this.state, ...update };
    this.emit("state", this.state);
  }

  start() {
    if (!this.state.supported || !this.autoUpdater) return;
    const updater = this.autoUpdater;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.allowPrerelease = false;
    updater.logger = null;
    // For testing a release end to end against a local folder of build output.
    if (process.env.MEETING_NOTES_UPDATE_URL) updater.setFeedURL({ provider: "generic", url: process.env.MEETING_NOTES_UPDATE_URL });
    updater.on("checking-for-update", () => this.#set({ state: "checking", error: null }));
    updater.on("update-not-available", () => this.#set({ state: "up-to-date", checkedAt: Date.now() }));
    updater.on("update-available", (info) => this.#set({ state: "downloading", version: info.version, percent: 0 }));
    updater.on("download-progress", (progress) => this.#set({ state: "downloading", percent: Math.round(progress.percent || 0) }));
    updater.on("update-downloaded", (info) => this.#set({ state: "ready", version: info.version, percent: 100, checkedAt: Date.now() }));
    updater.on("error", (error) => {
      this.log.error("Update check failed:", error?.message || error);
      // Keep a finished download installable even if a later check fails.
      if (this.state.state !== "ready") this.#set({ state: "error", error: "Couldn't check for updates. Ember will try again later." });
    });
    setTimeout(() => void this.check(), FIRST_CHECK_MS).unref?.();
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  async check() {
    if (!this.state.supported) {
      this.#set({ state: "error", error: "Updates only work in the installed app." });
      return this.state;
    }
    if (["checking", "downloading", "ready"].includes(this.state.state)) return this.state;
    try {
      await this.autoUpdater.checkForUpdates();
    } catch (error) {
      this.log.error("Update check failed:", error?.message || error);
      this.#set({ state: "error", error: "Couldn't check for updates. Ember will try again later." });
    }
    return this.state;
  }

  install() {
    if (this.state.state !== "ready") return false;
    // quitAndInstall closes every window; the app relaunches on the new version.
    setImmediate(() => this.autoUpdater.quitAndInstall(false, true));
    return true;
  }
}

module.exports = { Updater };
