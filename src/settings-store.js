const fs = require("node:fs/promises");
const path = require("node:path");
const { hotkeyLabel, normalizeHotkey } = require("./hotkey");

const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.6-luna";
const NOTES_DESTINATIONS = ["folder", "notion", "both"];

class SettingsStore {
  constructor({ filePath, safeStorage, defaults = {} }) {
    this.filePath = filePath;
    this.safeStorage = safeStorage;
    this.defaults = defaults;
    this.data = {};
  }

  async load() {
    try {
      this.data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.data = {};
    }
    return this;
  }

  decryptKey() {
    if (this.data.openRouterKey && this.safeStorage.isEncryptionAvailable()) {
      try {
        return this.safeStorage.decryptString(Buffer.from(this.data.openRouterKey, "base64"));
      } catch {
        return "";
      }
    }
    return this.defaults.openRouterKey || "";
  }

  // Where each call's notes go. Older settings only had a Notion switch: on meant folder and Notion.
  destination() {
    const legacyNotion = this.data.notionSyncEnabled ?? this.defaults.notionSyncEnabled ?? true;
    const notesDestination = NOTES_DESTINATIONS.includes(this.data.notesDestination)
      ? this.data.notesDestination
      : legacyNotion
        ? "both"
        : "folder";
    return { notesDestination, notionSyncEnabled: notesDestination !== "folder" };
  }

  runtime() {
    return {
      notesDir: this.data.notesDir || this.defaults.notesDir,
      speakerName: this.data.speakerName || this.defaults.speakerName || "Me",
      autoRecordZoomMeetings:
        this.data.autoRecordZoomMeetings ??
        this.defaults.autoRecordZoomMeetings ??
        false,
      transcriptionModelId:
        this.data.transcriptionModelId || this.defaults.transcriptionModelId || "",
      ...this.destination(),
      dictationEnabled: this.data.dictationEnabled ?? false,
      dictationHotkey: normalizeHotkey(this.data.dictationHotkey),
      dictationMode: this.data.dictationMode === "toggle" ? "toggle" : "hold",
      dictationKeepOnClipboard: this.data.dictationKeepOnClipboard ?? false,
      notionDataSourceId: this.data.notionDataSourceId || this.defaults.notionDataSourceId || "",
      openRouterKey: this.decryptKey(),
      openRouterModel:
        this.data.openRouterModel || this.defaults.openRouterModel || DEFAULT_OPENROUTER_MODEL,
    };
  }

  publicState() {
    const runtime = this.runtime();
    return {
      notesDir: runtime.notesDir,
      speakerName: runtime.speakerName,
      autoRecordZoomMeetings: runtime.autoRecordZoomMeetings,
      transcriptionModelId: runtime.transcriptionModelId,
      notionSyncEnabled: runtime.notionSyncEnabled,
      notesDestination: runtime.notesDestination,
      dictationEnabled: runtime.dictationEnabled,
      dictationHotkey: runtime.dictationHotkey,
      dictationHotkeyLabel: hotkeyLabel(runtime.dictationHotkey),
      dictationMode: runtime.dictationMode,
      dictationKeepOnClipboard: runtime.dictationKeepOnClipboard,
      notionDataSourceId: runtime.notionDataSourceId,
      openRouterModel: runtime.openRouterModel,
      hasOpenRouterKey: Boolean(runtime.openRouterKey),
    };
  }

  async save(update) {
    if (update.notesDir) this.data.notesDir = path.resolve(update.notesDir);
    if (update.speakerName?.trim()) this.data.speakerName = update.speakerName.trim();
    if (typeof update.transcriptionModelId === "string") {
      this.data.transcriptionModelId = update.transcriptionModelId;
    }
    if (typeof update.autoRecordZoomMeetings === "boolean") {
      this.data.autoRecordZoomMeetings = update.autoRecordZoomMeetings;
    }
    if (update.openRouterModel) this.data.openRouterModel = update.openRouterModel;
    if (typeof update.notionSyncEnabled === "boolean") {
      this.data.notionSyncEnabled = update.notionSyncEnabled;
    }
    if (NOTES_DESTINATIONS.includes(update.notesDestination)) {
      this.data.notesDestination = update.notesDestination;
      this.data.notionSyncEnabled = update.notesDestination !== "folder";
    }
    if (typeof update.dictationEnabled === "boolean") this.data.dictationEnabled = update.dictationEnabled;
    if (update.dictationHotkey) this.data.dictationHotkey = normalizeHotkey(update.dictationHotkey);
    if (update.dictationMode === "hold" || update.dictationMode === "toggle") {
      this.data.dictationMode = update.dictationMode;
    }
    if (typeof update.dictationKeepOnClipboard === "boolean") {
      this.data.dictationKeepOnClipboard = update.dictationKeepOnClipboard;
    }
    if (typeof update.notionSyncEnabled === "boolean" && !update.notesDestination) {
      this.data.notesDestination = update.notionSyncEnabled ? "both" : "folder";
      this.data.notionSyncEnabled = update.notionSyncEnabled;
    }
    if (typeof update.notionDataSourceId === "string") {
      this.data.notionDataSourceId = update.notionDataSourceId.trim();
    }

    if (update.clearOpenRouterKey) {
      delete this.data.openRouterKey;
      this.defaults.openRouterKey = "";
    } else if (update.openRouterKey) {
      if (!this.safeStorage.isEncryptionAvailable()) {
        throw new Error("macOS secure storage is unavailable; the API key was not saved.");
      }
      this.data.openRouterKey = this.safeStorage
        .encryptString(update.openRouterKey.trim())
        .toString("base64");
      this.defaults.openRouterKey = "";
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(this.data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(temporaryPath, this.filePath);
    return this.publicState();
  }
}

module.exports = { DEFAULT_OPENROUTER_MODEL, NOTES_DESTINATIONS, SettingsStore };
