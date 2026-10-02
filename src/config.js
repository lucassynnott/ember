const fs = require("node:fs");
const { normalizeHotkey } = require("./hotkey");
const os = require("node:os");
const path = require("node:path");
const dotenv = require("dotenv");
const { CAPTURE_PREFERENCES } = require("./capture-config");

function expandHome(value) {
  if (!value) return value;
  return value === "~" ? os.homedir() : value.replace(/^~(?=\/)/, os.homedir());
}

function loadEnvironment(appPath) {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.join(appPath, ".env"),
    path.join(path.dirname(process.execPath), ".env"),
    path.join(os.homedir(), "MeetingNotes", ".env"),
  ];

  for (const candidate of [...new Set(candidates)]) {
    if (fs.existsSync(candidate)) dotenv.config({ path: candidate, override: false, quiet: true });
  }
}

function modelCandidates() {
  return [
    process.env.WHISPER_MODEL,
    path.join(os.homedir(), "Library", "Application Support", "MeetingNotes", "models", "ggml-medium.bin"),
    path.join(os.homedir(), "whisper.cpp", "models", "ggml-medium.bin"),
    "/opt/homebrew/share/whisper-cpp/models/ggml-medium.bin",
    "/usr/local/share/whisper-cpp/models/ggml-medium.bin",
  ].filter(Boolean);
}

function findWhisperModel() {
  return modelCandidates().find((candidate) => fs.existsSync(expandHome(candidate))) || null;
}

function getSettings(overrides = {}) {
  return {
    notesDir: expandHome(overrides.notesDir || process.env.MEETING_NOTES_DIR || "~/MeetingNotes"),
    speakerName: overrides.speakerName || process.env.SPEAKER_NAME || "Me",
    autoRecordZoomMeetings: overrides.autoRecordZoomMeetings ?? false,
    microphoneLabel: overrides.microphoneLabel || process.env.MICROPHONE_LABEL || CAPTURE_PREFERENCES.microphoneLabel,
    mappedSystemOutputLabel:
      process.env.SYSTEM_AUDIO_LABEL || CAPTURE_PREFERENCES.mappedSystemOutputLabel,
    whisperBinary: expandHome(process.env.WHISPER_CPP_BIN || "whisper-cli"),
    whisperModel: findWhisperModel(),
    transcriptionModelId: overrides.transcriptionModelId || "",
    notionSyncEnabled: overrides.notionSyncEnabled ?? false,
    notesDestination: overrides.notesDestination || (overrides.notionSyncEnabled ? "both" : "folder"),
    dictationEnabled: overrides.dictationEnabled ?? false,
    dictationHotkey: normalizeHotkey(overrides.dictationHotkey),
    dictationMode: overrides.dictationMode === "toggle" ? "toggle" : "hold",
    voiceAskEnabled: overrides.voiceAskEnabled ?? true,
    commandModeEnabled: overrides.commandModeEnabled ?? true,
    liveHelpEnabled: overrides.liveHelpEnabled ?? true,
    liveHelpHotkey: overrides.liveHelpHotkey
      ? normalizeHotkey(overrides.liveHelpHotkey)
      : { keyCode: null, modifiers: ["rightCommand", "rightShift"] },
    commandHotkey: overrides.commandHotkey
      ? normalizeHotkey(overrides.commandHotkey)
      : { keyCode: null, modifiers: ["rightOption", "rightCommand"] },
    askHotkey: overrides.askHotkey ? normalizeHotkey(overrides.askHotkey) : { keyCode: null, modifiers: ["rightCommand"] },
    dictationKeepOnClipboard: overrides.dictationKeepOnClipboard ?? false,
    dictationCleanup: overrides.dictationCleanup || "light",
    speakerSeparation: overrides.speakerSeparation ?? true,
    dictionary: overrides.dictionary || [],
    dictationStyleRules: overrides.dictationStyleRules || [],
    dictationSnippets: overrides.dictationSnippets || [],
    dictationWhisper: overrides.dictationWhisper ?? false,
    dictationHistory: overrides.dictationHistory ?? true,
    dictationStylePresets: overrides.dictationStylePresets || {},
    calendarEnabled: overrides.calendarEnabled ?? false,
    prepEnabled: overrides.prepEnabled ?? true,
    weeklyDigest: overrides.weeklyDigest ?? true,
    knowledgeFolders: overrides.knowledgeFolders || [],
    knowledgeEnabled: overrides.knowledgeEnabled ?? true,
    captureSharedScreens: overrides.captureSharedScreens ?? true,
    learnZoomVoices: overrides.learnZoomVoices ?? true,
    notionDataSourceId: overrides.notionDataSourceId || process.env.NOTION_DATA_SOURCE_ID || "",
    notionDatabaseName: overrides.notionDatabaseName || "",
    notionAuth: overrides.notionAuth === "composio" ? "composio" : "cli",
    notionComposioAccount: overrides.notionComposioAccount || "",
    transcriptionProvider: (process.env.TRANSCRIPTION_PROVIDER || "auto").toLowerCase(),
    openAiKey: process.env.OPENAI_API_KEY || "",
    groqKey: process.env.GROQ_API_KEY || "",
    openRouterKey: overrides.openRouterKey || process.env.OPENROUTER_API_KEY || "",
    openRouterModel:
      overrides.openRouterModel || process.env.OPENROUTER_MODEL || "openai/gpt-5.6-luna",
    ffmpegBinary: expandHome(process.env.FFMPEG_BIN || "ffmpeg"),
  };
}

module.exports = {
  expandHome,
  getSettings,
  loadEnvironment,
  modelCandidates,
};
