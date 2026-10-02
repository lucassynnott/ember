const fs = require("node:fs/promises");
const path = require("node:path");
const { hotkeyLabel, normalizeHotkey } = require("./hotkey");
const { normalizeDictionary } = require("./dictionary");
const { PRESETS: STYLE_PRESETS, normalizeStyleRules } = require("./dictation-style");

const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.6-luna";
const NOTES_DESTINATIONS = ["folder", "notion", "both"];
// Right ⌘ on its own is rarely used, so it's a safe default for asking out loud.
const DEFAULT_ASK_HOTKEY = Object.freeze({ keyCode: null, modifiers: ["rightCommand"] });
// Both right-hand keys together: doesn't clash with dictation (Right ⌥) or Ask (Right ⌘).
const DEFAULT_COMMAND_HOTKEY = Object.freeze({ keyCode: null, modifiers: ["rightOption", "rightCommand"] });
// Right ⌘ + Right ⇧: live help suggestions during a call.
const DEFAULT_LIVE_HELP_HOTKEY = Object.freeze({ keyCode: null, modifiers: ["rightCommand", "rightShift"] });

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
      // People who set the app up before the welcome window existed don't need to see it.
      if (this.data.onboardingCompleted === undefined && Object.keys(this.data).length) this.data.onboardingCompleted = true;
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

  onboardingCompleted() {
    return this.data.onboardingCompleted === true;
  }

  // Where each call's notes go. Older settings only had a Notion switch: on meant folder and Notion.
  destination() {
    const legacyNotion = this.data.notionSyncEnabled ?? this.defaults.notionSyncEnabled ?? false;
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
      notionDatabaseName: this.data.notionDatabaseName || "",
      notionAuth: this.data.notionAuth === "composio" ? "composio" : "cli",
      notionComposioAccount: this.data.notionComposioAccount || "",
      dictationEnabled: this.data.dictationEnabled ?? false,
      dictationHotkey: normalizeHotkey(this.data.dictationHotkey),
      dictationMode: this.data.dictationMode === "toggle" ? "toggle" : "hold",
      voiceAskEnabled: this.data.voiceAskEnabled ?? true,
      askHotkey: normalizeHotkey(this.data.askHotkey || DEFAULT_ASK_HOTKEY),
      commandModeEnabled: this.data.commandModeEnabled ?? true,
      commandHotkey: normalizeHotkey(this.data.commandHotkey || DEFAULT_COMMAND_HOTKEY),
      liveHelpEnabled: this.data.liveHelpEnabled ?? true,
      liveHelpHotkey: normalizeHotkey(this.data.liveHelpHotkey || DEFAULT_LIVE_HELP_HOTKEY),
      dictationKeepOnClipboard: this.data.dictationKeepOnClipboard ?? false,
      dictionary: normalizeDictionary(this.data.dictionary),
      dictationStyleRules: normalizeStyleRules(this.data.dictationStyleRules),
      dictationStylePresets: this.data.dictationStylePresets || {},
      calendarEnabled: this.data.calendarEnabled ?? false,
      prepEnabled: this.data.prepEnabled ?? true,
      weeklyDigest: this.data.weeklyDigest ?? true,
      knowledgeFolders: Array.isArray(this.data.knowledgeFolders) ? this.data.knowledgeFolders : [],
      knowledgeEnabled: this.data.knowledgeEnabled ?? true,
      captureSharedScreens: this.data.captureSharedScreens ?? true,
      speakerSeparation: this.data.speakerSeparation ?? true,
      learnZoomVoices: this.data.learnZoomVoices ?? true,
      microphoneLabel: this.data.microphoneLabel || this.defaults.microphoneLabel || "",
      dictationCleanup: ["off", "light", "ai"].includes(this.data.dictationCleanup) ? this.data.dictationCleanup : "light",
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
      notionDatabaseName: runtime.notionDatabaseName,
      notionAuth: runtime.notionAuth,
      onboardingCompleted: this.onboardingCompleted(),
      dictationEnabled: runtime.dictationEnabled,
      dictationHotkey: runtime.dictationHotkey,
      dictationHotkeyLabel: hotkeyLabel(runtime.dictationHotkey),
      dictationMode: runtime.dictationMode,
      voiceAskEnabled: runtime.voiceAskEnabled,
      askHotkey: runtime.askHotkey,
      askHotkeyLabel: hotkeyLabel(runtime.askHotkey),
      commandModeEnabled: runtime.commandModeEnabled,
      commandHotkey: runtime.commandHotkey,
      commandHotkeyLabel: hotkeyLabel(runtime.commandHotkey),
      liveHelpEnabled: runtime.liveHelpEnabled,
      liveHelpHotkey: runtime.liveHelpHotkey,
      liveHelpHotkeyLabel: hotkeyLabel(runtime.liveHelpHotkey),
      dictationKeepOnClipboard: runtime.dictationKeepOnClipboard,
      dictationCleanup: runtime.dictationCleanup,
      speakerSeparation: runtime.speakerSeparation,
      dictionary: runtime.dictionary,
      dictationStyleRules: runtime.dictationStyleRules,
      dictationStylePresets: runtime.dictationStylePresets,
      calendarEnabled: runtime.calendarEnabled,
      prepEnabled: runtime.prepEnabled,
      weeklyDigest: runtime.weeklyDigest,
      knowledgeFolders: runtime.knowledgeFolders,
      knowledgeEnabled: runtime.knowledgeEnabled,
      captureSharedScreens: runtime.captureSharedScreens,
      learnZoomVoices: runtime.learnZoomVoices,
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
    if (update.askHotkey) this.data.askHotkey = normalizeHotkey(update.askHotkey);
    if (typeof update.voiceAskEnabled === "boolean") this.data.voiceAskEnabled = update.voiceAskEnabled;
    if (update.commandHotkey) this.data.commandHotkey = normalizeHotkey(update.commandHotkey);
    if (typeof update.commandModeEnabled === "boolean") this.data.commandModeEnabled = update.commandModeEnabled;
    if (update.liveHelpHotkey) this.data.liveHelpHotkey = normalizeHotkey(update.liveHelpHotkey);
    if (typeof update.liveHelpEnabled === "boolean") this.data.liveHelpEnabled = update.liveHelpEnabled;
    if (update.dictationMode === "hold" || update.dictationMode === "toggle") {
      this.data.dictationMode = update.dictationMode;
    }
    if (typeof update.dictationKeepOnClipboard === "boolean") {
      this.data.dictationKeepOnClipboard = update.dictationKeepOnClipboard;
    }
    if (typeof update.microphoneLabel === "string" && update.microphoneLabel.trim()) {
      this.data.microphoneLabel = update.microphoneLabel.trim().slice(0, 200);
    }
    if (typeof update.calendarEnabled === "boolean") this.data.calendarEnabled = update.calendarEnabled;
    if (typeof update.prepEnabled === "boolean") this.data.prepEnabled = update.prepEnabled;
    if (typeof update.weeklyDigest === "boolean") this.data.weeklyDigest = update.weeklyDigest;
    if (Array.isArray(update.knowledgeFolders)) {
      this.data.knowledgeFolders = [...new Set(update.knowledgeFolders.map((folder) => path.resolve(String(folder))))].slice(0, 20);
    }
    if (typeof update.knowledgeEnabled === "boolean") this.data.knowledgeEnabled = update.knowledgeEnabled;
    if (typeof update.captureSharedScreens === "boolean") this.data.captureSharedScreens = update.captureSharedScreens;
    if (Array.isArray(update.dictationStyleRules)) this.data.dictationStyleRules = normalizeStyleRules(update.dictationStyleRules);
    if (update.dictationStylePresets && typeof update.dictationStylePresets === "object") {
      const presets = {};
      for (const preset of STYLE_PRESETS) {
        const value = update.dictationStylePresets[preset.id];
        if (["casual", "formal", "plain", "off"].includes(value)) presets[preset.id] = value;
      }
      this.data.dictationStylePresets = { ...(this.data.dictationStylePresets || {}), ...presets };
    }
    if (Array.isArray(update.dictionary)) this.data.dictionary = normalizeDictionary(update.dictionary);
    if (typeof update.speakerSeparation === "boolean") this.data.speakerSeparation = update.speakerSeparation;
    if (typeof update.learnZoomVoices === "boolean") this.data.learnZoomVoices = update.learnZoomVoices;
    if (["off", "light", "ai"].includes(update.dictationCleanup)) this.data.dictationCleanup = update.dictationCleanup;
    if (typeof update.notionSyncEnabled === "boolean" && !update.notesDestination) {
      this.data.notesDestination = update.notionSyncEnabled ? "both" : "folder";
      this.data.notionSyncEnabled = update.notionSyncEnabled;
    }
    if (typeof update.onboardingCompleted === "boolean") this.data.onboardingCompleted = update.onboardingCompleted;
    if (update.notionAuth === "cli" || update.notionAuth === "composio") this.data.notionAuth = update.notionAuth;
    if (typeof update.notionComposioAccount === "string") this.data.notionComposioAccount = update.notionComposioAccount;
    if (typeof update.notionDatabaseName === "string") this.data.notionDatabaseName = update.notionDatabaseName.trim();
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
