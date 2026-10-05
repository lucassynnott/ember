const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { fileURLToPath } = require("node:url");
const { execFile } = require("node:child_process");
const {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  safeStorage,
  session,
  shell,
  systemPreferences,
  Tray,
} = require("electron");
const { allocateMeetingPaths, writeMeetingNote } = require("./note");
const { getSettings, loadEnvironment, modelCandidates } = require("./config");
const { LiveParakeetTranscriber } = require("./live-transcription");
const { LivePhononTranscriber, encodeWav } = require("./phonon-transcription");
const { TranscriberService } = require("./transcriber-service");
const { DictationController, boostQuietSpeech, splitForTranscription } = require("./dictation");
const { DictationOverlay } = require("./dictation-overlay");
const { VoiceAskController } = require("./voice-ask");
const { AskCard } = require("./ask-card");
const { CommandModeController, rewriteSelection } = require("./command-mode");
const { CalendarReader, attendeeNames, calendarHelperPath, matchEvent } = require("./calendar");
const { pastMeetingsWith, prepMessages, seriesMeetings, upcomingEvents } = require("./prep");
const { joinTarget } = require("./join-link");
const { KnowledgeBase, knowledgeBlock } = require("./knowledge");
const aiConnect = require("./ai-connect");
const { KnowledgeSources } = require("./knowledge-sources");
const mcpOAuth = require("./mcp-oauth");
const { NudgeScheduler, nudgeMessages, parseNudge } = require("./live-nudges");
const { SUGGEST_QUESTION, liveHelpMessages } = require("./live-help");
const { ScreenWatcher, placeSlides, screenTarget, screensHelperPath } = require("./shared-screens");
const { DigestStore, digestMessages, weekFromId, weekOf } = require("./digest");
const { UsageStats, meetingStats, isMe } = require("./stats");
const { DictationHistory } = require("./dictation-history");
const { CoachStore, combineStats, practiceStats } = require("./coach");
const { cleanDictation } = require("./dictation-cleanup");
const { applyDictionary, vocabularyHint } = require("./dictionary");
const { styleFor } = require("./dictation-style");
const { HotkeyHelper, hotkeyHelperPath, hotkeyLabel, normalizeHotkey } = require("./hotkey");
const { transcribeLocally } = require("./transcription");
const { NotionSync } = require("./notion-sync");
const { AI_CATALOG, AI_MODELS_DIR, ModelManager, SUPPORT_DIR, catalogTargetPath, downloadVerified } = require("./model-manager");
const { LocalAI } = require("./local-ai");
const { TEMPLATES, templateFor } = require("./note-templates");
const { callNoteCommand } = require("./call-notes");
const { DictionarySuggestions } = require("./dictionary-suggestions");
const { ClipboardHistory } = require("./clipboard-history");
const { ClipboardPicker } = require("./clipboard-picker");
const { ScreenText } = require("./screen-text");
const { SavedLibrary } = require("./saved-library");
const { findUrl, readImage, readPage } = require("./page-fetch");
const { tagSavedItem } = require("./save-tagger");
const { HostedComposio, InstallSecret, PersonalComposio } = require("./composio-apps");
const { ActionSender, Integrations } = require("./action-destinations");
const { MODEL: VOICE_MODEL, SAME_SPEAKER_IN_ROOM, SpeakerTracker, VoiceBank, VoiceEmbedder, normalize } = require("./speakers");
const { NotionConnect } = require("./notion-connect");
const { processMeeting } = require("./process-meeting");
const { MeetingLibrary } = require("./library");
const { buildMessages, streamCompletion } = require("./ask");
const { FOLLOW_UP_KINDS, followUpMessages, voiceSamples } = require("./follow-up");
const { SettingsStore } = require("./settings-store");
const { aiTarget, summarizeTranscript, callOpenAiCompatible } = require("./summary");
const { detectTranscriptionModels } = require("./transcription-models");
const { segmentSpeaker, ZoomAccessibilityObserver } = require("./zoom-accessibility");
const { ZoomAutoRecordingController } = require("./zoom-auto-recording");
const { CallTracker } = require("./call-detection");
const { TrayIcon } = require("./tray-icon");
const { Updater } = require("./updater");

const commandWaiters = new Map();
let tray;
let trayIcon;
let recorderWindow;
let settingsWindow;
let onboardingWindow;
let settingsStore;
// Offline mode: on-device AI models, and the local relay their requests go through.
let aiModels = null;
let localAI = null;
// Action items to Linear, Notion and Reminders, and notes to Google Drive.
let actionSender = null;
let settings;
let transcriptionModels = [];
let phase = "idle";
let statusMessage = "Ready";
let currentRecording = null;
let liveTranscriber = null;
let liveTranscriberModel = null;
let hotkeyHelper = null;
let dictationOverlay = null;
let dictation = null;
let voiceAsk = null;
let askCard = null;
let commandMode = null;
let calendarReader = null;
let knowledgeBase = null;
let knowledgeWatchers = [];
let knowledgeTimer = null;
let knowledgeFoldersKey = null;

function extractHelperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "bin", "meeting-notes-extract")
    : path.join(app.getAppPath(), "native", "extract", "meeting-notes-extract");
}

function publishKnowledge(extra = {}) {
  sendToPanels("knowledge:state", { ...knowledgeBase?.status(), ...extra });
}

function reindexKnowledge() {
  if (!knowledgeBase) return Promise.resolve(null);
  const folders = settings.knowledgeFolders || [];
  publishKnowledge({ indexing: true, done: 0, total: 0 });
  return knowledgeBase
    .index(folders, { onProgress: ({ done, total }) => publishKnowledge({ indexing: true, done, total }) })
    .then((status) => {
      publishKnowledge();
      return status;
    })
    .catch((error) => {
      console.error("Knowledge base indexing failed:", error.message);
      publishKnowledge({ error: error.message });
      return null;
    });
}

// Re-indexes when the folders change, and a few seconds after anything inside them changes.
function syncKnowledge() {
  const folders = settings.knowledgeFolders || [];
  const key = JSON.stringify(folders);
  if (key === knowledgeFoldersKey) return;
  knowledgeFoldersKey = key;
  for (const watcher of knowledgeWatchers) watcher.close();
  knowledgeWatchers = [];
  for (const folder of folders) {
    try {
      knowledgeWatchers.push(
        fs.watch(folder, { recursive: true }, () => {
          clearTimeout(knowledgeTimer);
          knowledgeTimer = setTimeout(() => void reindexKnowledge(), 5000);
        }),
      );
    } catch (error) {
      console.error(`Can't watch ${folder}:`, error.message);
    }
  }
  void reindexKnowledge();
}

// The floating answer card, shared by voice-ask and the prep card.
function ensureAskCard() {
  if (askCard) return askCard;
  askCard = new AskCard({
    getMeetings: async () => (await library.list()).meetings,
    onOpenMeeting: (id) => {
      showControlsWindow();
      recorderWindow?.webContents.send("app:open-meeting", id);
    },
  });
  askCard.on("closed", () => {
    hotkeyHelper?.setDictating(false, "prep");
    hotkeyHelper?.setDictating(false, "live");
    suggestAbort?.abort();
  });
  askCard.on("join", (link) => void joinCall(link));
  askCard.on("action", (name) => void nudgeAction(name));
  askCard.on("open-source", (file) => void openKnowledgeFile(file).catch((error) => console.error(error.message)));
  return askCard;
}

// Prep cards: a brief before a calendar call, from earlier calls with the same people.
const prepShown = new Set();
let prepTimer = null;
let prepAbort = null;

async function showPrep(event, { force = false } = {}) {
  const key = `${event.start}|${event.title}`;
  if (!settings.prepEnabled || !settings.aiKey || (!force && prepShown.has(key))) return false;
  prepShown.add(key);
  const names = event.attendees?.length ? event.attendees : [];
  const corpus = await library.corpus();
  // A repeating call is briefed from its last two occurrences, plus other calls with the same people.
  const series = event.recurring ? seriesMeetings(corpus, event) : [];
  const withPeople = names.length ? pastMeetingsWith(corpus, names, { before: Number(event.start) || Date.now() }) : [];
  const meetings = [...series, ...withPeople.filter((meeting) => !series.includes(meeting))].slice(0, 5);
  // Nothing to brief on for a first call, so stay quiet.
  if (!meetings.length) return false;
  if (dictation?.state !== "idle" || voiceAsk?.capturing || commandMode?.busy) return false;
  const card = ensureAskCard();
  const minutes = Math.round((Number(event.start) - Date.now()) / 60000);
  const when = minutes > 0 ? ` · starts in ${minutes} min` : "";
  await card.show({
    kind: "prep",
    question: `Before ${event.title || "your call"}${when}`,
    join: event.link ? joinTarget(event.link) : null,
    text: "",
    status: "answering",
  });
  hotkeyHelper?.setDictating(true, "prep");
  prepAbort?.abort();
  const controller = new AbortController();
  prepAbort = controller;
  let text = "";
  let prepKnowledge = { text: "", sources: {} };
  try {
    await streamCompletion({
      ...aiTarget(settings),
      messages: prepMessages({
        event,
        meetings,
        series,
        speakerName: settings.speakerName,
        vocabulary: settings.vocabulary,
        knowledge: (prepKnowledge = await knowledgeFor(`${event.title || ""} ${(event.attendees || []).join(" ")}`, 3)).text,
      }),
      signal: controller.signal,
      onDelta: (delta) => {
        text += delta;
        card.update({ text });
      },
    });
    card.update({ text, status: "done", sources: prepKnowledge.sources });
  } catch (error) {
    if (!controller.signal.aborted) card.update({ status: "error", error: error.message });
  }
  return true;
}

async function checkUpcomingCalls() {
  if (!settings?.calendarEnabled || !settings.prepEnabled || !calendarReader || phase !== "idle") return;
  try {
    const now = Date.now();
    const events = await calendarReader.events(now - 60_000, now + 5 * 60_000);
    for (const event of upcomingEvents(events, now)) {
      const attendees = attendeeNames(event, settings.speakerName);
      if (await showPrep({ ...event, attendees })) break;
    }
  } catch (error) {
    console.error("Prep check failed:", error.message);
  }
}

// Weekly digests: written on Fridays from 4 pm, or whenever you ask.
let digestStore = null;
let usageStats = null;
let dictationHistory = null;
let dictionarySuggestions = null;
let clipboardHistory = null;
let clipboardPicker = null;
let screenText = null;
let savedLibrary = null;
// Copies the app makes itself (dictation's paste, a grab, a paste from history) aren't recorded twice.
let clipboardMuteUntil = 0;
const muteClipboard = (ms = 1500) => {
  clipboardMuteUntil = Date.now() + ms;
};
// Password managers and the like: their copies are never kept, even unmarked ones.
const CLIPBOARD_SECRET_APPS = new Set([
  "com.1password.1password", "com.agilebits.onepassword7", "com.agilebits.onepassword-osx", "com.bitwarden.desktop",
  "com.apple.keychainaccess", "com.apple.Passwords", "com.lastpass.LastPass", "com.dashlane.dashlanephonefinal",
  "in.sinew.Enpass-Desktop", "org.keepassxc.keepassxc", "com.keepassxc.keepassxc", "com.nordpass.macos.NordPass",
  "com.proton.pass.desktop", "com.apple.systempreferences",
]);
let coachStore = null;
let knowledgeSources = null;
// Bump when Home's "New in…" tile has something new to show people who are upgrading.
const WHATS_NEW_VERSION = "1.10";

function remember(entry) {
  if (!settings.dictationHistory || !dictationHistory) return;
  void dictationHistory.add(entry).then(() => recorderWindow?.webContents.send("history:changed"));
}
let digestTimer = null;
let digestWriting = null;

async function writeDigest(weekId, { onDelta = () => {}, signal } = {}) {
  if (!settings.aiKey) throw new Error("Digests need AI. Add an OpenRouter key or download an on-device model in Settings → AI notes.");
  const week = weekFromId(weekId);
  const meetings = (await library.corpus())
    .filter((meeting) => meeting.startedAt >= week.start && meeting.startedAt < week.end)
    .sort((a, b) => a.startedAt - b.startedAt);
  if (!meetings.length) throw new Error("There were no calls with notes that week.");
  const text = await streamCompletion({
    ...aiTarget(settings),
    messages: digestMessages({ meetings, week, speakerName: settings.speakerName, vocabulary: settings.vocabulary }),
    signal,
    onDelta,
  });
  const markdown = `# ${week.label}\n\n${text.trim()}\n`;
  await digestStore.save(week.id, markdown);
  // A copy beside your notes, where [[call]] links open the call's note in Obsidian.
  if (settings.notesDestination !== "notion") {
    const folder = path.join(settings.notesDir, "Weekly digests");
    await fsp.mkdir(folder, { recursive: true });
    await fsp.writeFile(path.join(folder, `${week.id}.md`), markdown, { mode: 0o600 });
  }
  recorderWindow?.webContents.send("digests:changed");
  return { ...week, markdown };
}

async function checkWeeklyDigest() {
  const now = new Date();
  if (!settings?.weeklyDigest || !settings.aiKey || now.getDay() !== 5 || now.getHours() < 16 || digestWriting) return;
  const week = weekOf(now);
  if (await digestStore.get(week.id)) return;
  const calls = (await library.list()).meetings.filter((meeting) => meeting.hasNote && meeting.startedAt >= week.start && meeting.startedAt < week.end);
  if (!calls.length) return;
  digestWriting = writeDigest(week.id)
    .then(() => notify("Your weekly digest is ready", `${calls.length} ${calls.length === 1 ? "call" : "calls"} this week. Open Meeting Notes → Weekly digest.`))
    .catch((error) => console.error("Weekly digest failed:", error.message))
    .finally(() => {
      digestWriting = null;
    });
}

function syncDigest() {
  clearInterval(digestTimer);
  digestTimer = settings?.weeklyDigest ? setInterval(() => void checkWeeklyDigest(), 10 * 60_000) : null;
  if (settings?.weeklyDigest) setTimeout(() => void checkWeeklyDigest(), 30_000);
}

function syncPrep() {
  clearInterval(prepTimer);
  prepTimer = settings?.calendarEnabled && settings.prepEnabled ? setInterval(() => void checkUpcomingCalls(), 60_000) : null;
}

// Finds the calendar event a recording belongs to, when calendar naming is on.
async function lookUpCalendarEvent(recording) {
  if (!settings.calendarEnabled || !calendarReader) return null;
  try {
    const from = recording.startedAt.getTime();
    const to = recording.endedAt?.getTime() || Date.now();
    const events = await calendarReader.events(from - 3 * 3_600_000, to + 3_600_000);
    return matchEvent(events, { startedAt: from, endedAt: to, callApp: recording.callApp, selfName: settings.speakerName });
  } catch (error) {
    console.error("Calendar lookup failed:", error.message);
    return null;
  }
}
const transcribers = new TranscriberService({
  createTranscriber: (model) =>
    model.type === "phonon"
      ? new LivePhononTranscriber({ binaryPath: model.path })
      : new LiveParakeetTranscriber({ app, modelPath: model.path }),
});
let notionSync = null;
let library = null;
const modelManager = new ModelManager();
const notionConnect = new NotionConnect({
  openExternal: (url) => shell.openExternal(url),
  getAuth: () => ({ method: settings?.notionAuth, composioAccount: settings?.notionComposioAccount }),
});
notionConnect.on("progress", (progress) => {
  sendToPanels("notion:progress", progress);
});
let updater = null;
let liveSummaryTimer = null;
let zoomObserver = null;
let zoomAutoRecording = null;
let zoomState = {
  accessibility: "not-granted",
  meetingOpen: false,
  participants: [],
  activeSpeakers: [],
};
let liveSummaryInFlight = false;
let openRouterModelsCache = null;
let quitAfterProcessing = false;
let isQuitting = false;
let permissionState = { microphone: "unknown", screen: "unknown", accessibility: "unknown" };

function installFinderPath() {
  const additions = ["/opt/homebrew/bin", "/usr/local/bin"];
  const current = (process.env.PATH || "").split(path.delimiter);
  process.env.PATH = [...new Set([...additions, ...current])].join(path.delimiter);
}

const RENDERER_DIR = path.join(__dirname, "..", "renderer", "dist");
const WINDOW_CHROME = {
  titleBarStyle: "hiddenInset",
  trafficLightPosition: { x: 18, y: 17 },
  backgroundColor: "#161616",
};

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
}

// Brings the main window forward on a page: "home" (the dashboard), "now" (the live call, or Home
// when there isn't one) or "meetings".
function openMainWindow(page = "now") {
  showControlsWindow();
  recorderWindow?.webContents.send("app:navigate", page);
}

// Brings the app to the front too, since it's often opened from the menu bar or a shortcut while
// another app is active.
function showControlsWindow() {
  if (!recorderWindow || recorderWindow.isDestroyed()) return;
  if (recorderWindow.isMinimized()) recorderWindow.restore();
  recorderWindow.show();
  app.focus({ steal: true });
  recorderWindow.focus();
}

// After signing in in the browser, come back to the window the sign-in started from.
function bringBack(window = settingsWindow && !settingsWindow.isDestroyed() ? settingsWindow : recorderWindow) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  app.focus({ steal: true });
  window.focus();
}

async function showSettingsWindow(section = "") {
  const page = /^[a-z]{2,20}$/.test(String(section)) ? String(section) : "";
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (page) settingsWindow.webContents.send("settings:section", page);
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    app.focus({ steal: true });
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 880,
    height: 680,
    minWidth: 760,
    minHeight: 520,
    show: false,
    title: "Meeting Notes Settings",
    ...WINDOW_CHROME,
    // Inside the floating sidebar panel.
    trafficLightPosition: { x: 26, y: 27 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWindow.once("ready-to-show", () => settingsWindow?.show());
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
  await settingsWindow.loadFile(path.join(RENDERER_DIR, "settings.html"), page ? { hash: page } : undefined);
}

// Settings and the welcome window share the same live events.
function sendToPanels(channel, payload) {
  for (const window of [settingsWindow, onboardingWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

async function showOnboardingWindow() {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.show();
    onboardingWindow.focus();
    return;
  }
  onboardingWindow = new BrowserWindow({
    width: 920,
    height: 640,
    minWidth: 820,
    minHeight: 600,
    show: false,
    resizable: true,
    fullscreenable: false,
    title: "Welcome to Meeting Notes",
    ...WINDOW_CHROME,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  onboardingWindow.once("ready-to-show", () => {
    onboardingWindow?.show();
    app.focus({ steal: true });
  });
  onboardingWindow.on("closed", () => {
    onboardingWindow = null;
    // Closed before finishing: fall back to the main window, which shows what's still missing.
    if (!isQuitting && !settingsStore.onboardingCompleted()) showControlsWindow();
  });
  await onboardingWindow.loadFile(path.join(RENDERER_DIR, "onboarding.html"));
}

// Current permission state without showing any macOS prompt.
function currentPermissions() {
  const screen = systemPreferences.getMediaAccessStatus("screen");
  return {
    microphone: systemPreferences.getMediaAccessStatus("microphone"),
    screen: permissionState.screen === "granted" ? "granted" : screen,
    accessibility: accessibilityStatus(false),
  };
}

const PRIVACY_PANES = {
  microphone: "Privacy_Microphone",
  screen: "Privacy_ScreenCapture",
  accessibility: "Privacy_Accessibility",
};

async function requestPermission(kind) {
  if (kind === "microphone") {
    if (systemPreferences.getMediaAccessStatus("microphone") === "not-determined") {
      await systemPreferences.askForMediaAccess("microphone");
    } else if (systemPreferences.getMediaAccessStatus("microphone") !== "granted") {
      await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PRIVACY_PANES.microphone}`);
    }
  } else if (kind === "screen") {
    // Starting a capture is what makes macOS ask; if it's been refused before, open the pane instead.
    const granted = await sendRecorderCommand("request-screen-permission", {
      mappedSystemOutputLabel: settings.mappedSystemOutputLabel,
    })
      .then(() => true)
      .catch(() => false);
    if (granted) permissionState = { ...permissionState, screen: "granted" };
    else await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PRIVACY_PANES.screen}`);
  } else if (kind === "accessibility") {
    if (!systemPreferences.isTrustedAccessibilityClient(true)) {
      await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PRIVACY_PANES.accessibility}`);
    }
  }
  const state = currentPermissions();
  permissionState = { ...permissionState, ...state };
  syncZoomObserver(state.accessibility);
  publishPermissionState();
  return state;
}

function suggestedName() {
  try {
    return require("node:child_process").execFileSync("/usr/bin/id", ["-F"], { encoding: "utf8", timeout: 2000 }).trim();
  } catch {
    return "";
  }
}

function publishPermissionState() {
  recorderWindow?.webContents.send("permissions:state", permissionState);
}

// Telling other speakers apart: the voice model, the worker that runs it and the voices you've named.
const VOICE_MODEL_PATH = path.join(SUPPORT_DIR, "models", "voices", VOICE_MODEL.fileName);
let voiceEmbedder = null;
let voiceBank = null;
let voiceModel = { state: "missing" };
let voiceDownload = null;

function publishVoiceModel(state) {
  voiceModel = state;
  sendToPanels("voices:state", voiceModel);
}

async function ensureVoiceModel() {
  if (!settings?.speakerSeparation) return false;
  if (voiceModel.state === "ready") return true;
  if (voiceDownload) return voiceDownload;
  voiceDownload = (async () => {
    try {
      await fsp.access(VOICE_MODEL_PATH);
    } catch {
      const partial = `${VOICE_MODEL_PATH}.partial`;
      await fsp.mkdir(path.dirname(VOICE_MODEL_PATH), { recursive: true });
      let last = 0;
      publishVoiceModel({ state: "downloading", received: 0, total: VOICE_MODEL.size });
      await downloadVerified({
        url: VOICE_MODEL.url,
        destination: partial,
        expectedSize: VOICE_MODEL.size,
        sha256: VOICE_MODEL.sha256,
        onBytes: (received) => {
          if (Date.now() - last < 150 && received < VOICE_MODEL.size) return;
          last = Date.now();
          publishVoiceModel({ state: "downloading", received, total: VOICE_MODEL.size });
        },
      });
      await fsp.rename(partial, VOICE_MODEL_PATH);
    }
    voiceEmbedder ||= new VoiceEmbedder(VOICE_MODEL_PATH);
    publishVoiceModel({ state: "ready" });
    return true;
  })()
    .catch((error) => {
      console.error("Voice model unavailable:", error.message);
      publishVoiceModel({ state: "failed", error: error.message });
      return false;
    })
    .finally(() => {
      voiceDownload = null;
    });
  return voiceDownload;
}

function speakersFile(stem) {
  return path.join(app.getPath("userData"), "speakers", `${path.basename(stem)}.json`);
}

// Tidies the call's speaker groups, names known voices, learns Zoom voices and relabels the transcript.
async function finishSpeakers(recording) {
  const tracker = recording.speakerTracker;
  if (!tracker || !voiceBank) return;
  try {
    const { labels, speakers } = tracker.finalize(await voiceBank.list());
    for (const segment of recording.transcriptSegments) {
      if (segment.voiceLabel && labels[segment.voiceLabel]) segment.speaker = labels[segment.voiceLabel];
      // In a room, your lines are the ones in your voice (for the speaking coach).
      if (recording.inPerson && segment.source === "microphone") segment.you = segment.speaker === settings.speakerName;
    }
    if (Object.keys(labels).length) {
      recorderWindow?.webContents.send("meeting:relabel", { startedAt: recording.startedAt.getTime(), labels });
    }
    // On a normal call the microphone is you: keep your voice so in-person meetings can name you.
    const self = recording.selfVoice;
    const yourName = String(settings.speakerName || "").trim();
    if (!recording.inPerson && self?.sum && self.seconds >= 30 && yourName && yourName !== "Me") {
      await voiceBank.learn(yourName, normalize(self.sum), self.seconds);
    }
    if (settings.learnZoomVoices) {
      for (const [name, voice] of recording.zoomVoices) {
        await voiceBank.learn(name, normalize(voice.sum), voice.seconds);
      }
    }
    await refreshDictionary();
    const saved = { ...speakers };
    for (const [name, voice] of recording.zoomVoices) {
      saved[name] = { embedding: normalize(voice.sum), seconds: Math.round(voice.seconds), known: true };
    }
    await fsp.mkdir(path.dirname(speakersFile(recording.stem)), { recursive: true, mode: 0o700 });
    await fsp.writeFile(speakersFile(recording.stem), `${JSON.stringify({ speakers: saved })}\n`, { mode: 0o600 });
  } catch (error) {
    console.error("Couldn't finish speaker labels:", error.message);
  }
}

// Your dictionary plus names the app already knows: yours and the voices you've named.
async function refreshDictionary() {
  const names = [settings.speakerName, ...(voiceBank ? (await voiceBank.summary()).map((voice) => voice.name) : [])]
    .filter((name) => name && !/^Me$/i.test(name));
  const entries = [...(settings.dictionary || [])];
  for (const name of names) {
    if (!entries.some((entry) => entry.term.toLowerCase() === name.toLowerCase())) entries.push({ term: name, heardAs: [] });
  }
  settings.dictionaryEntries = entries;
  settings.vocabulary = vocabularyHint(entries.map((entry) => entry.term));
}

// Shared screens: while a call records, its window is watched and new slides are saved.
function startScreenWatcher(recording) {
  if (!settings.captureSharedScreens || recording.screenWatcher || currentRecording !== recording) return;
  const target = screenTarget({ zoom: zoomState, call: callState });
  if (!target) return;
  const watcher = new ScreenWatcher({
    binaryPath: screensHelperPath(app),
    outDir: path.join(app.getPath("userData"), "shared", path.basename(recording.stem)),
    target,
    onSlide: (slide) => {
      const seconds = Math.max(0, Math.round((slide.at - recording.startedAt.getTime()) / 1000));
      const time = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
      recording.slides.push({ file: slide.file, text: slide.text, at: slide.at, time });
      recorderWindow?.webContents.send("meeting:slides", {
        startedAt: recording.startedAt.getTime(),
        count: recording.slides.length,
        latest: slide.text.split("\n").find((line) => line.trim().length > 3) || "",
      });
    },
  });
  recording.screenWatcher = watcher;
  watcher.start().catch((error) => console.error("Shared screen capture couldn't start:", error.message));
}

let callState = null;
const callTracker = new CallTracker();
function publishZoomState() {
  recorderWindow?.webContents.send("zoom:state", { ...zoomState, call: callState });
}
function publishZoomAutomationState(state = zoomAutoRecording?.snapshot()) {
  if (state) recorderWindow?.webContents.send("zoom:auto-recording-state", state);
}

function accessibilityStatus(prompt = false) {
  return systemPreferences.isTrustedAccessibilityClient(prompt) ? "granted" : "not-granted";
}

// The observer also reports which apps use the microphone, which works without Accessibility.
function syncZoomObserver() {
  zoomObserver?.start();
  publishZoomState();
}

async function requestRequiredPermissions({ showResult = true } = {}) {
  showControlsWindow();
  let microphone = systemPreferences.getMediaAccessStatus("microphone");
  let screen = systemPreferences.getMediaAccessStatus("screen");

  if (microphone !== "granted") {
    const granted = await systemPreferences.askForMediaAccess("microphone");
    microphone = granted ? "granted" : systemPreferences.getMediaAccessStatus("microphone");
  }

  let screenRequestSucceeded = false;
  try {
    await sendRecorderCommand("request-screen-permission", {
      mappedSystemOutputLabel: settings.mappedSystemOutputLabel,
    });
    screenRequestSucceeded = true;
  } catch {
    screenRequestSucceeded = false;
  }

  const reportedScreenStatus = systemPreferences.getMediaAccessStatus("screen");
  screen = screenRequestSucceeded
    ? "granted"
    : reportedScreenStatus === "granted"
      ? "system-audio-unavailable"
      : reportedScreenStatus;
  const accessibility = accessibilityStatus(showResult);
  permissionState = { microphone, screen, accessibility };
  syncZoomObserver(accessibility);
  publishPermissionState();
  recorderWindow?.webContents.send("app:state", { phase, message: statusMessage });

  if (showResult) {
    const missingMicrophone = microphone !== "granted";
    const missingScreen = screen !== "granted";
    const missingAccessibility = accessibility !== "granted";
    if (missingMicrophone || missingScreen || missingAccessibility) {
      const { response } = await dialog.showMessageBox({
        type: "warning",
        title: "Permissions required",
        message: "Meeting Notes still needs macOS permission",
        detail: [
          `Microphone: ${microphone}`,
          `Screen & System Audio Recording: ${screen}`,
          `Accessibility for Zoom names: ${accessibility}`,
          "",
          "Accessibility is optional for recording, but required for Zoom participant names.",
        ].join("\n"),
        buttons: ["Open System Settings", "Later"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) {
        const pane = missingMicrophone
          ? "Privacy_Microphone"
          : missingScreen
            ? "Privacy_ScreenCapture"
            : "Privacy_Accessibility";
        await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
      }
    } else {
      await dialog.showMessageBox({
        type: "info",
        title: "Permissions granted",
        message: "Microphone, Screen Recording, and Accessibility access are ready.",
      });
    }
  }
  return permissionState;
}

function setStatus(nextPhase, message) {
  phase = nextPhase;
  statusMessage = message;
  rebuildMenu();
  recorderWindow?.webContents.send("app:state", { phase, message });
  zoomAutoRecording?.recordingStateChanged();
}

function rebuildMenu() {
  if (app.isReady()) Menu.setApplicationMenu(buildAppMenu());
  if (!tray) return;
  trayIcon?.setRecording(phase === "recording");
  tray.setToolTip(phase === "recording" ? "Meeting Notes: recording" : "Meeting Notes");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: statusMessage, enabled: false },
      ...(finishingCalls.size
        ? [{ label: `Writing notes for ${finishingCalls.size} ${finishingCalls.size === 1 ? "call" : "calls"}…`, enabled: false }]
        : []),
      { type: "separator" },
      { label: "Open Meeting Notes", click: () => openMainWindow("home") },
      ...(phase === "idle" ? [] : [{ label: "Show Live Notes", click: () => openMainWindow("now") }]),
      { type: "separator" },
      {
        label: "Start Recording",
        enabled: phase === "idle",
        click: () => {
          zoomAutoRecording?.manualStartRequested();
          void startRecording({ origin: "manual" });
        },
      },
      {
        label: "Start In-Person Meeting",
        enabled: phase === "idle",
        click: () => {
          zoomAutoRecording?.manualStartRequested();
          void startRecording({ origin: "manual", inPerson: true });
        },
      },
      {
        label: "Stop Recording",
        enabled: phase === "recording",
        click: () => void stopRecording({ reason: "manual" }),
      },
      { type: "separator" },
      {
        label: settings?.dictationEnabled
          ? hotkeyHelper && hotkeyHelper.status.tap === false
            ? "Dictation needs Accessibility access"
            : `Dictation: ${hotkeyLabel(settings.dictationHotkey)} (${settings.dictationMode === "toggle" ? "press" : "hold"})`
          : "Dictation off",
        enabled: false,
      },
      {
        label: settings?.grabTextEnabled ? `Grab Text from Screen (${hotkeyLabel(settings.grabHotkey)})` : "Grab Text from Screen",
        click: () => void grabScreenText(),
      },
      {
        label: "Read Text in Copied Image",
        click: () => void grabScreenText({ fromClipboard: true }),
      },
      {
        label: settings?.clipboardHistoryEnabled ? `Clipboard History (${hotkeyLabel(settings.clipboardHotkey)})` : "Clipboard History",
        click: () => {
          showControlsWindow();
          recorderWindow?.webContents.send("app:open-page", "clipboard");
        },
      },
      {
        label: "Copy Last Dictation",
        enabled: Boolean(dictation?.lastText),
        click: () => clipboard.writeText(dictation.lastText),
      },
      { type: "separator" },
      {
        label: "Transcription Model",
        submenu: [
          ...transcriptionModels.map((model) => ({
            label: model.realtime ? model.label : `${model.label} (after recording)`,
            type: "radio",
            checked: activeTranscriptionModel()?.id === model.id,
            enabled: phase === "idle",
            click: () => void selectTranscriptionModel(model.id),
          })),
          ...(transcriptionModels.length ? [{ type: "separator" }] : []),
          { label: "Download Models…", click: () => void showSettingsWindow() },
        ],
      },
      { label: "Settings…", click: () => void showSettingsWindow() },
      { label: "Welcome & Setup…", click: () => void showOnboardingWindow() },
      ...updateMenuItems(),
      { label: "Open Notes Folder", click: () => void shell.openPath(settings.notesDir) },
      { type: "separator" },
      {
        label: "Request Microphone + Screen Access…",
        enabled: phase === "idle",
        click: () => void requestRequiredPermissions({ showResult: true }),
      },
      { type: "separator" },
      {
        label: "Quit Meeting Notes",
        enabled: true,
        click: () => void quitGracefully(),
      },
    ]),
  );
}

function sendRecorderCommand(action, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timeout = setTimeout(() => {
      commandWaiters.delete(id);
      reject(new Error(`Recorder ${action} command timed out.`));
    }, 120000);
    commandWaiters.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    recorderWindow.webContents.send("recorder:command", { id, action, payload });
  });
}

function waitForStreamOpen(stream) {
  return new Promise((resolve, reject) => {
    stream.once("open", resolve);
    stream.once("error", reject);
  });
}

function closeStream(stream) {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.end(resolve);
  });
}

function activeTranscriptionModel() {
  return (
    transcriptionModels.find((model) => model.id === settings.transcriptionModelId) ||
    transcriptionModels.find((model) => model.realtime) ||
    transcriptionModels[0] ||
    null
  );
}

function libraryChanged() {
  recorderWindow?.webContents.send("library:changed");
}

function notionReady() {
  return Boolean(notionSync?.enabled());
}

// Writes the local note when Notion was the only destination but couldn't take it.
async function saveNoteLocallyInstead(result, reason, startedAt) {
  try {
    await writeMeetingNote(result.notePath, result.markdown);
    recorderWindow?.webContents.send("meeting:saved", { notePath: result.notePath, notion: false, startedAt });
    libraryChanged();
    notify("Meeting notes saved to your folder", reason);
  } catch (error) {
    console.error("Could not write the fallback note:", error);
    notify("Couldn't save the meeting note", error.message);
  }
}

function saveMeetingToNotion(recording, result) {
  if (!notionReady()) return;
  notionSync
    .saveMeeting({
      startedAt: recording.startedAt,
      endedAt: recording.endedAt,
      origin: recording.origin,
      callApp: recording.callApp,
      transcript: result.transcript,
      analysis: result.analysis,
      notePath: result.notePath,
      audioPath: result.audioPath,
      slideFiles: recording.slideFiles,
    })
    .then((page) => {
      if (!page.skipped && !page.duplicate) notify("Saved to Notion", "Call Transcripts");
      libraryChanged();
      if (!page.skipped) {
        recorderWindow?.webContents.send("meeting:saved", {
          startedAt: recording.startedAt.getTime(),
          notePath: result.noteWritten ? result.notePath : null,
          notion: true,
          notionUrl: page.url || null,
        });
      }
      retryPendingNotionSaves();
    })
    .catch((error) => {
      console.error("Notion sync failed:", error);
      if (!result.noteWritten) {
        void saveNoteLocallyInstead(result, `Notion couldn't be reached (${error.message}). It will retry later.`, recording.startedAt.getTime());
      } else {
        notify("Notion save failed. It will retry", error.message);
      }
    });
}

function retryPendingNotionSaves() {
  if (!notionSync?.enabled()) return;
  notionSync
    .retryPending()
    .then(({ saved }) => {
      if (saved.length) {
        notify("Saved to Notion", `${saved.length} earlier call${saved.length === 1 ? "" : "s"} synced`);
      }
    })
    .catch((error) => console.error("Notion retry failed:", error));
}

function modelListState() {
  const active = activeTranscriptionModel();
  return {
    selectedId: active?.id || "",
    installed: transcriptionModels,
    catalog: modelManager.catalog().map((entry) => {
      const installed = transcriptionModels.find((model) => model.catalogId === entry.id);
      return {
        id: entry.id,
        label: entry.label,
        source: entry.source,
        languages: entry.languages,
        realtime: entry.realtime,
        sizeLabel: entry.sizeLabel,
        detail: entry.detail,
        installedModelId: installed?.id || null,
        progress: modelManager.status(entry.id),
      };
    }),
  };
}

async function selectTranscriptionModel(modelId) {
  if (phase !== "idle") throw new Error("Stop the current recording before switching models.");
  if (!transcriptionModels.some((model) => model.id === modelId)) {
    throw new Error("That transcription model is not installed.");
  }
  await settingsStore.save({ transcriptionModelId: modelId });
  await refreshRuntimeSettings();
  const state = modelListState();
  sendToPanels("models:changed", state);
  return state;
}

function transcriptText(recording = currentRecording) {
  return (
    recording?.transcriptSegments
      ?.map((segment) => `${segment.speaker}: ${segment.text}`)
      .join("\n")
      .trim() || ""
  );
}

function formatElapsed(startedAt, observedAt = Date.now()) {
  const timestamp = Number(observedAt);
  const elapsedAt = Number.isFinite(timestamp) ? timestamp : Date.now();
  const seconds = Math.max(0, Math.floor((elapsedAt - startedAt.getTime()) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function scheduleLiveSummary() {
  if (liveSummaryTimer || liveSummaryInFlight || phase !== "recording") return;
  if (transcriptText().split(/\s+/).filter(Boolean).length < 40) return;
  liveSummaryTimer = setTimeout(() => {
    liveSummaryTimer = null;
    void updateLiveSummary();
    // The on-device model shares this Mac with live transcription, so it refreshes less often.
  }, settings.aiLocal ? 90000 : 20000);
}

async function updateLiveSummary() {
  if (liveSummaryInFlight || !currentRecording || !settings.aiKey) return;
  const recording = currentRecording;
  const transcript = transcriptText(recording);
  if (!transcript) return;
  liveSummaryInFlight = true;
  try {
    const analysis = await summarizeTranscript(transcript, settings);
    recording.liveAnalysis = analysis;
    if (currentRecording === recording) recorderWindow?.webContents.send("meeting:analysis", analysis);
  } catch (error) {
    console.error("Live notes update failed:", error.message);
  } finally {
    liveSummaryInFlight = false;
  }
}

// inPerson: everyone is in the room, so the microphone's speech is told apart by voice too.
async function startRecording({ origin = "manual", inPerson = false } = {}) {
  if (phase !== "idle") return false;
  setStatus("starting", "Requesting permissions…");
  let recording;
  try {
    const permissions = await requestRequiredPermissions({ showResult: false });
    if (permissions.microphone !== "granted") throw new Error("Microphone permission was denied.");
    if (permissions.screen !== "granted") throw new Error("Screen Recording permission was denied.");

    const transcriptionModel = activeTranscriptionModel();
    if (!transcriptionModel) {
      throw new Error("No local transcription model was found. Open Settings to select a model.");
    }
    if (transcriptionModel.realtime) {
      setStatus("starting", `Loading ${transcriptionModel.label}…`);
      liveTranscriber = await transcribers.acquire(transcriptionModel);
      liveTranscriberModel = transcriptionModel;
    }

    const startedAt = new Date();
    const paths = await allocateMeetingPaths(settings.notesDir, startedAt);
    const stream = fs.createWriteStream(paths.audioPath, { flags: "wx", mode: 0o600 });
    await waitForStreamOpen(stream);
    if (inPerson) origin = "in-person";
    const callApp = origin === "zoom-auto" ? zoomAutoRecording?.source() || "Zoom" : null;
    recording = {
      origin,
      callApp,
      ...paths,
      startedAt,
      stream,
      transcriptionModel,
      speakerName: settings.speakerName,
      transcriptSegments: [],
      transcriptionQueue: Promise.resolve(),
      userNotes: "",
      privateSpeech: [],
      slides: [],
      screenWatcher: null,
      inPerson,
      speakerTracker: settings.speakerSeparation && (await ensureVoiceModel()) ? new SpeakerTracker({ known: voiceBank ? await voiceBank.list() : [], ...(inPerson ? { threshold: SAME_SPEAKER_IN_ROOM } : {}) }) : null,
      // Your own voice, learned from the microphone on normal calls so in-person meetings can name you.
      selfVoice: { sum: null, seconds: 0 },
      // Lines dictated into the call ("action item …"), kept apart from what's typed in Your notes.
      voiceNotes: [],
      zoomVoices: new Map(),
      nudges: new NudgeScheduler({ frequency: settings.liveNudgeFrequency, startedAt: startedAt.getTime() }),
    };
    currentRecording = recording;
    if (settings.aiLocal && settings.aiKey) void localAI?.warm();
    recorderWindow.webContents.send("meeting:reset", recording.startedAt.getTime());
    startScreenWatcher(recording);
    void lookUpCalendarEvent(recording).then((event) => {
      if (!event || currentRecording !== recording) return;
      recording.calendar = event;
      recorderWindow?.webContents.send("meeting:calendar", { ...event, startedAt: recording.startedAt.getTime() });
      // If the brief didn't show before the call (it started early, or the app just opened), show it now.
      void showPrep(event);
    });

    await sendRecorderCommand("start", {
      microphoneLabel: settings.microphoneLabel,
      mappedSystemOutputLabel: settings.mappedSystemOutputLabel,
    });
    setStatus("recording", `Recording with ${transcriptionModel.label}`);
    notify(
      origin === "zoom-auto" ? `${callApp} call detected` : "Meeting Notes",
      origin === "zoom-auto"
        ? "Recording and live transcription started automatically."
        : inPerson
          ? recording.speakerTracker
            ? "In-person meeting started. Everyone in the room is told apart by voice."
            : "In-person meeting started. Turn on speaker separation in Settings → Meetings to tell people apart."
          : "Recording and live transcription started.",
    );
    return true;
  } catch (error) {
    if (recording?.stream) recording.stream.destroy();
    if (recording?.audioPath) await fsp.rm(recording.audioPath, { force: true });
    await releaseLiveTranscriber();
    currentRecording = null;
    setStatus("idle", "Ready");
    await dialog.showMessageBox({
      type: "error",
      title: "Could not start recording",
      message: error.message,
      detail: "Check permissions and choose an installed transcription model in Settings.",
    });
    return false;
  }
}

// Calls whose notes are still being written. Recording is free again as soon as the live transcript
// is final, so the next call can start while OpenRouter writes the last one's notes.
const finishingCalls = new Map();

function publishFinishing() {
  const jobs = [...finishingCalls.values()].map(({ startedAt, title, message }) => ({ startedAt, title, message }));
  recorderWindow?.webContents.send("meeting:jobs", jobs);
  rebuildMenu();
}

function quitWhenFinished() {
  if (quitAfterProcessing && !finishingCalls.size && phase === "idle") {
    isQuitting = true;
    app.quit();
  }
}

async function stopRecording({ reason = "manual" } = {}) {
  if (phase !== "recording" || !currentRecording) return false;
  if (reason === "manual") zoomAutoRecording?.manualStopRequested();
  const recording = currentRecording;
  setStatus("stopping", "Finishing live transcript…");
  if (reason === "zoom-auto") {
    notify(`${recording.callApp || "Zoom"} call ended`, "Recording stopped automatically. Finalizing notes…");
  }
  clearTimeout(liveSummaryTimer);
  liveSummaryTimer = null;

  recording.screenWatcher?.stop();
  try {
    await sendRecorderCommand("stop");
    await recording.transcriptionQueue;
    await releaseLiveTranscriber();
    await closeStream(recording.stream);
    recording.endedAt = new Date();
  } catch (error) {
    if (!recording.stream.closed) recording.stream.destroy();
    await releaseLiveTranscriber();
    currentRecording = null;
    setStatus("idle", "Ready — the recording didn't finish cleanly; audio was kept");
    void dialog.showMessageBox({
      type: "error",
      title: "Recording didn't finish cleanly",
      message: error.message,
      detail: `The source audio is safe at:\n${recording.audioPath}`,
    });
    quitWhenFinished();
    return false;
  }

  // The microphone, system audio and live transcriber are free: ready for the next call.
  currentRecording = null;
  setStatus("idle", "Ready");
  const startedAt = recording.startedAt.getTime();
  const job = { startedAt, title: recording.calendar?.title || null, message: "Writing notes…" };
  finishingCalls.set(startedAt, job);
  publishFinishing();
  void finishMeeting(recording, (message) => {
    job.message = message;
    publishFinishing();
  }).finally(() => {
    finishingCalls.delete(startedAt);
    publishFinishing();
    quitWhenFinished();
  });
  return true;
}

// After a call: send its action items (if auto-send is on) and save its notes to Google Drive (if chosen).
async function afterCallIntegrations(meetingId, markdown, title) {
  if (!actionSender) return;
  // The note has to be readable on the Meetings page first.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const failures = [];
  const sent = await actionSender.autoSend(meetingId).catch((error) => [{ error: error.message }]);
  for (const result of sent) if (result?.error) failures.push(result.error);
  const state = await actionSender.state().catch(() => null);
  if (state?.driveFolder && state.connected.googledrive && markdown) {
    await actionSender.saveNotesToDrive(meetingId, markdown, title).catch((error) => failures.push(`Google Drive: ${error.message}`));
  }
  if (sent.some((result) => result && !result.error) || state?.driveFolder) {
    recorderWindow?.webContents.send("integrations:changed");
    sendToPanels("integrations:changed");
  }
  if (failures.length) notify("Couldn't send everything", failures[0].slice(0, 180));
}

// Everything after the recording itself: speaker names, the AI notes, the note file and Notion.
async function finishMeeting(recording, onProgress) {
  const startedAt = recording.startedAt.getTime();
  try {
    await finishSpeakers(recording);
    await coachStore?.save(path.basename(recording.stem), recording.transcriptSegments).catch((error) => {
      console.error("Couldn't keep the call's timing for the speaking coach:", error.message);
    });
    recording.calendar ||= await lookUpCalendarEvent(recording);
    onProgress("Writing notes…");
    const attendees = recording.calendar?.attendees || [];
    // Slides go beside the note (folder, or the app's own copy for Notion-only calls).
    const stem = path.basename(recording.stem);
    const notionOnly = settings.notesDestination === "notion";
    const noteDirectory = !notionOnly || !notionReady() ? settings.notesDir : path.join(app.getPath("userData"), "library");
    const placed = await placeSlides(recording.slides, noteDirectory, stem).catch((error) => {
      console.error("Couldn't keep the shared slides:", error.message);
      return [];
    });
    const slides = recording.slides.slice(0, placed.length).map((slide, index) => ({ ...slide, image: placed[index] }));
    recording.slideFiles = placed.map((relative) => path.join(noteDirectory, relative));
    const result = await processMeeting({
      ...recording,
      slides,
      title: recording.calendar?.title || "",
      template: templateFor({ chosen: recording.template, setting: settings.noteTemplate, title: recording.calendar?.title || "" }),
      userNotes: [recording.userNotes, ...(recording.voiceNotes || [])].filter((line) => String(line || "").trim()).join("\n"),
      attendees,
      writeNote: !notionOnly || !notionReady(),
      transcript: transcriptText(recording),
      transcriptionProvider:
        recording.transcriptionModel.realtime
          ? recording.transcriptionModel.label
          : undefined,
      // Attendees' names help the notes spell them right.
      settings: attendees.length
        ? { ...settings, vocabulary: vocabularyHint([...settings.dictionaryEntries.map((entry) => entry.term), ...attendees]) }
        : settings,
      onProgress,
    });
    recorderWindow?.webContents.send("meeting:analysis", { ...result.analysis, startedAt });
    if (result.analysis.misheard?.length && dictionarySuggestions) {
      void dictionarySuggestions
        .add(result.analysis.misheard, { meeting: recording.calendar?.title || result.analysis.title || "", dictionary: settings.dictionaryEntries || [] })
        .then((added) => added && settingsWindow && !settingsWindow.isDestroyed() && settingsWindow.webContents.send("dictionary:suggestions-changed"))
        .catch(() => {});
    }
    // Calls that only go to Notion still get a copy on this Mac, so the Meetings page can show them.
    void afterCallIntegrations(stem, result.markdown, recording.calendar?.title || result.analysis?.title || "Meeting notes");
    if (!result.noteWritten) {
      await library.saveCopy(path.basename(recording.stem), result.markdown).catch((error) => {
        console.error("Could not keep a local copy of the meeting:", error);
      });
    }
    libraryChanged();
    if (result.noteWritten) {
      notify(
        "Meeting notes saved",
        notionOnly ? "Notion isn't set up yet, so the note was saved to your folder." : result.notePath,
      );
      recorderWindow?.webContents.send("meeting:saved", { notePath: result.notePath, notion: false, startedAt });
    }
    saveMeetingToNotion(recording, result);
    return true;
  } catch (error) {
    void dialog.showMessageBox({
      type: "error",
      title: "Meeting processing failed",
      message: error.message,
      detail: `The source audio is safe at:\n${recording.audioPath}`,
    });
    return false;
  }
}

async function releaseLiveTranscriber() {
  const model = liveTranscriberModel;
  liveTranscriber = null;
  liveTranscriberModel = null;
  if (model) await transcribers.release(model);
}

const clipboardAccess = {
  snapshot() {
    const formats = clipboard.availableFormats();
    return {
      empty: formats.length === 0,
      text: clipboard.readText(),
      html: clipboard.readHTML(),
      rtf: clipboard.readRTF(),
      image: formats.some((format) => format.startsWith("image/")) ? clipboard.readImage() : null,
    };
  },
  writeText: (text) => {
    muteClipboard();
    clipboard.writeText(text);
  },
  readText: () => clipboard.readText(),
  restore(snapshot) {
    muteClipboard();
    if (snapshot.empty) {
      clipboard.clear();
      return;
    }
    const data = {};
    if (snapshot.text) data.text = snapshot.text;
    if (snapshot.html) data.html = snapshot.html;
    if (snapshot.rtf) data.rtf = snapshot.rtf;
    if (snapshot.image && !snapshot.image.isEmpty()) data.image = snapshot.image;
    clipboard.write(data);
  },
};

async function transcribeDictation(input) {
  const samples = settings.dictationWhisper ? boostQuietSpeech(input) : input;
  const model = activeTranscriptionModel();
  if (!model) throw new Error("No transcription model is installed. Open Settings to download one.");
  if (!model.realtime) {
    const wavPath = path.join(app.getPath("temp"), `meeting-notes-dictation-${Date.now()}.wav`);
    await fsp.writeFile(wavPath, encodeWav(samples), { mode: 0o600 });
    try {
      return await transcribeLocally(wavPath, { ...settings, whisperModel: model.path });
    } finally {
      await fsp.rm(wavPath, { force: true });
    }
  }
  const transcriber = await transcribers.acquire(model);
  try {
    // Phonon-2 splits long audio itself; the Parakeet worker takes at most 30 s at a time.
    const pieces = model.type === "parakeet" ? splitForTranscription(samples) : [samples];
    const parts = [];
    for (const piece of pieces) parts.push((await transcriber.transcribe(piece)).trim());
    return parts.filter(Boolean).join(" ");
  } finally {
    await transcribers.release(model);
  }
}

function ensureHotkeyHelper() {
  if (hotkeyHelper) return hotkeyHelper;
  hotkeyHelper = new HotkeyHelper({ binaryPath: hotkeyHelperPath(app) });
  hotkeyHelper.on("error", (error) => console.error("Hotkey helper:", error.message));
  // Offline mode: start loading the model while you're still speaking.
  const warmAi = (needed) => () => settings.aiLocal && settings.aiKey && needed() && void localAI?.warm();
  hotkeyHelper.on("down", warmAi(() => settings.dictationCleanup === "ai"));
  hotkeyHelper.on("ask:down", warmAi(() => true));
  hotkeyHelper.on("command:down", warmAi(() => true));
  hotkeyHelper.on("status", () => {
    rebuildMenu();
    publishDictationStatus();
  });
  hotkeyHelper.start();
  dictationOverlay = new DictationOverlay({
    getMicrophoneLabel: () => settings.microphoneLabel,
    // Speech to dictation, Ask or Edit during a call is kept out of the meeting's transcript.
    onCaptureStart: () => {
      if (currentRecording) currentRecording.privateSpeech.push({ start: Date.now() - 300, end: Infinity });
    },
    onCaptureEnd: () => {
      const window = currentRecording?.privateSpeech.at(-1);
      if (window && window.end === Infinity) window.end = Date.now() + 500;
    },
  });
  dictation = new DictationController({
    helper: hotkeyHelper,
    overlay: dictationOverlay,
    transcribe: transcribeDictation,
    // During a call, "action item …", "note …" or "decision …" goes into the call's notes.
    intercept: async (text) => {
      const recording = currentRecording;
      if (!recording || phase !== "recording") return null;
      const command = callNoteCommand(text);
      if (!command) return null;
      recording.voiceNotes.push(command.line);
      recorderWindow?.webContents.send("meeting:voice-note", { startedAt: recording.startedAt.getTime(), line: command.line });
      return command.kind === "action" ? "Action item added to the call" : command.kind === "decision" ? "Decision added to the call" : "Added to the call's notes";
    },
    clean: async (text, focus) => {
      const style = styleFor(focus, { rules: settings.dictationStyleRules, presets: settings.dictationStylePresets });
      const result = await cleanDictation(text, settings, { style: style.instruction, styleName: style.name });
      if (result.fallback) console.warn(`Dictation cleanup fell back to on-device: ${result.fallback}`);
      return result.text;
    },
    clipboard: clipboardAccess,
    getSettings: () => settings,
    preflight: () =>
      voiceAsk?.capturing || commandMode?.busy
        ? "Finish what you're saying first"
        : activeTranscriptionModel()
          ? null
          : "Download a model in Settings first",
  });
  commandMode = new CommandModeController({
    helper: hotkeyHelper,
    overlay: dictationOverlay,
    clipboard: clipboardAccess,
    transcribe: transcribeDictation,
    clean: async (text) => (await cleanDictation(text, { ...settings, dictationCleanup: "light" })).text,
    rewrite: ({ selection, instruction }) => rewriteSelection({ selection, instruction, settings }),
    getSettings: () => settings,
    isBusy: () => dictation?.state !== "idle" || Boolean(voiceAsk?.capturing),
    preflight: () => {
      if (!activeTranscriptionModel()) return "Download a model in Settings first";
      if (!settings.aiKey) return "Editing by voice needs AI: add a key or on-device model in Settings";
      return null;
    },
  });
  hotkeyHelper.on("escape", () => {
    if (askCard?.visible && !voiceAsk?.capturing && voiceAsk?.state === "idle") {
      prepAbort?.abort();
      askCard.hide();
    }
  });
  hotkeyHelper.on("grab:down", () => void grabScreenText());
  hotkeyHelper.on("clipboard:down", () => void toggleClipboardPicker());
  hotkeyHelper.on("save:down", () => void saveFromShortcut());
  hotkeyHelper.on("pasteboard", (message) => void recordCopy(message));
  hotkeyHelper.on("suggest:down", () => {
    if (dictation?.state !== "idle" || voiceAsk?.capturing || commandMode?.busy) return;
    void suggestNow();
  });
  commandMode.on("result", ({ instruction, after, app }) => {
    console.log(`Command mode in ${app || "unknown app"}: ${instruction}`);
    remember({ text: after, app, kind: "edit", instruction });
  });
  commandMode.on("error", (error) => console.error("Command mode failed:", error.message));
  ensureAskCard();
  voiceAsk = new VoiceAskController({
    helper: hotkeyHelper,
    overlay: dictationOverlay,
    card: askCard,
    transcribe: transcribeDictation,
    clean: async (text) => (await cleanDictation(text, { ...settings, dictationCleanup: "light" })).text,
    // During a call, a spoken question gets live help; otherwise it asks your meetings.
    answer: (request) => (currentRecording && phase === "recording" ? liveHelp(request) : answerQuestion(request)),
    isLive: () => Boolean(currentRecording && phase === "recording"),
    getSettings: () => settings,
    isBusy: () => dictation?.state !== "idle" || Boolean(commandMode?.busy),
    preflight: () => {
      if (!activeTranscriptionModel()) return "Download a model in Settings first";
      if (!settings.aiKey) return "Ask needs AI: add a key or on-device model in Settings";
      return null;
    },
  });
  dictation.on("result", ({ text, app, secure }) => {
    rebuildMenu();
    // Never keep what was dictated into a password field.
    if (!secure) remember({ text, app, kind: "dictation" });
    void usageStats?.recordDictation(text).then(() => recorderWindow?.webContents.send("dashboard:changed"));
  });
  dictation.on("delivery", ({ delivery, focus }) =>
    console.log(
      `Dictation ${delivery} → ${focus?.app || "unknown app"} (${focus?.bundleId || "?"}) role=${focus?.role || "none"} editable=${focus?.editable} chromium=${focus?.chromium} focusFound=${focus?.focusFound}`,
    ),
  );
  dictation.on("error", (error) => console.error("Dictation failed:", error.message));
  return hotkeyHelper;
}

function dictationStatus() {
  return {
    enabled: Boolean(settings?.dictationEnabled),
    running: Boolean(hotkeyHelper?.child),
    accessibility: hotkeyHelper?.status.accessibility ?? null,
    tap: hotkeyHelper?.status.tap ?? null,
    hotkeyLabel: hotkeyLabel(settings?.dictationHotkey),
  };
}

function publishDictationStatus() {
  sendToPanels("dictation:status", dictationStatus());
}

async function syncDictation() {
  syncClipboardTools();
  if (!settings.dictationEnabled && !settings.voiceAskEnabled && !settings.commandModeEnabled && !settings.liveHelpEnabled) {
    hotkeyHelper?.setHotkey(null);
    hotkeyHelper?.setHotkey(null, "ask");
    hotkeyHelper?.setHotkey(null, "command");
    hotkeyHelper?.setHotkey(null, "suggest");
    await transcribers.keepWarm(null).catch((error) => console.error(error));
    publishDictationStatus();
    return;
  }
  const helper = ensureHotkeyHelper();
  helper.setHotkey(settings.dictationEnabled ? settings.dictationHotkey : null);
  helper.setHotkey(settings.voiceAskEnabled ? settings.askHotkey : null, "ask");
  helper.setHotkey(settings.commandModeEnabled ? settings.commandHotkey : null, "command");
  helper.setHotkey(settings.liveHelpEnabled ? settings.liveHelpHotkey : null, "suggest");
  void dictationOverlay.preload();
  const model = activeTranscriptionModel();
  transcribers
    .keepWarm(model?.realtime ? model : null)
    .catch((error) => console.error("Could not preload the dictation model:", error.message));
  publishDictationStatus();
}

function updateMenuItems() {
  const state = updater?.state;
  if (!state?.supported) return [];
  if (state.state === "ready") {
    return [
      {
        label: phase === "idle" ? `Restart to Update to ${state.version}` : `Update ${state.version} installs after this call`,
        enabled: phase === "idle",
        click: () => installUpdate(),
      },
    ];
  }
  if (state.state === "downloading") return [{ label: `Downloading update ${state.version || ""}… ${state.percent || 0}%`, enabled: false }];
  return [{ label: "Check for Updates…", enabled: state.state !== "checking", click: () => void updater.check() }];
}

function installUpdate() {
  if (phase !== "idle") return false;
  isQuitting = true;
  return updater.install();
}

// The menu bar at the top of the screen while the app is in front. No Reload or developer tools, so
// nothing can interrupt a recording.
function buildAppMenu() {
  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Settings…", accelerator: "Command+,", click: () => void showSettingsWindow() },
        { label: "Check for Updates…", click: () => void updater?.check?.() },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { label: "Quit Meeting Notes", accelerator: "Command+Q", click: () => void quitGracefully() },
      ],
    },
    { role: "editMenu" },
    {
      label: "Meeting",
      submenu: [
        {
          label: "Start Recording",
          enabled: phase === "idle",
          click: () => {
            zoomAutoRecording?.manualStartRequested();
            void startRecording({ origin: "manual" });
          },
        },
        {
          label: "Start In-Person Meeting",
          enabled: phase === "idle",
          click: () => {
            zoomAutoRecording?.manualStartRequested();
            void startRecording({ origin: "manual", inPerson: true });
          },
        },
        { label: "Stop Recording", enabled: phase === "recording", click: () => void stopRecording({ reason: "manual" }) },
        { type: "separator" },
        { label: "Grab Text from Screen", click: () => void grabScreenText() },
        { label: "Save Link from Browser or Clipboard", click: () => void saveFromShortcut() },
        {
          label: "Saved",
          click: () => {
            showControlsWindow();
            recorderWindow?.webContents.send("app:open-page", "saved");
          },
        },
        {
          label: "Clipboard History",
          click: () => {
            showControlsWindow();
            recorderWindow?.webContents.send("app:open-page", "clipboard");
          },
        },
      ],
    },
    {
      role: "windowMenu",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { label: "Meeting Notes", accelerator: "Command+0", click: () => showControlsWindow() },
        { role: "front" },
      ],
    },
  ]);
}

async function quitGracefully() {
  quitAfterProcessing = true;
  if (phase === "recording") {
    await stopRecording({ reason: "quit" });
    return;
  }
  // Notes still being written finish first.
  if (finishingCalls.size) {
    notify("Quitting after your notes are written", `${finishingCalls.size} ${finishingCalls.size === 1 ? "call is" : "calls are"} still being finished.`);
    return;
  }
  isQuitting = true;
  app.quit();
}

async function createRecorderWindow() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      if (!sources[0]) throw new Error("No macOS display was available for audio capture.");
      callback({ video: sources[0], audio: "loopback" });
    } catch (error) {
      console.error("Display media request failed:", error.message);
      callback({});
    }
  });

  recorderWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 940,
    minHeight: 620,
    show: false,
    resizable: true,
    title: "Meeting Notes",
    ...WINDOW_CHROME,
    // Inside the floating sidebar panel.
    trafficLightPosition: { x: 26, y: 27 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await recorderWindow.loadFile(path.join(RENDERER_DIR, "index.html"));
  recorderWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    recorderWindow.hide();
  });
  recorderWindow.webContents.send("app:state", { phase, message: statusMessage });
  publishPermissionState();
  publishZoomAutomationState();
}

async function refreshRuntimeSettings() {
  transcriptionModels = await detectTranscriptionModels(modelCandidates(), {
    isInstalling: (id) => modelManager.isBusy(id),
  });
  const persisted = settingsStore.runtime();
  if (!persisted.transcriptionModelId && transcriptionModels.length) {
    persisted.transcriptionModelId =
      transcriptionModels.find((model) => model.realtime)?.id || transcriptionModels[0].id;
  }
  settings = getSettings(persisted);
  await applyAiTarget();
  await refreshDictionary();
  const activeModel = activeTranscriptionModel();
  if (activeModel?.type === "whisper") settings.whisperModel = activeModel.path;
  await fsp.mkdir(settings.notesDir, { recursive: true, mode: 0o700 });
  rebuildMenu();
  zoomAutoRecording?.settingsChanged();
  if (settings.speakerSeparation) void ensureVoiceModel();
  syncPrep();
  syncDigest();
  syncKnowledge();
  void syncDictation();
}

// The installed on-device model the user picked, or null while it's missing or still downloading.
async function localModelPath() {
  const entry = AI_CATALOG.find((candidate) => candidate.id === settings?.localAiModelId);
  if (!entry || !aiModels || aiModels.isBusy(entry.id)) return null;
  const target = catalogTargetPath(entry, AI_MODELS_DIR);
  return fs.existsSync(path.join(target, "config.json")) && fs.existsSync(path.join(target, "model.safetensors")) ? target : null;
}

// Where the AI features send requests. Offline mode never falls back to OpenRouter.
async function applyAiTarget() {
  if (settings.aiProvider === "local") {
    const ready = Boolean(localAI && (await localModelPath()) && (await aiModels.mlxPython()));
    settings.aiLocal = true;
    settings.aiEndpoint = ready ? await localAI.endpoint() : null;
    settings.aiKey = ready ? localAI.token : "";
  } else {
    settings.aiLocal = false;
    settings.aiEndpoint = null;
    settings.aiKey = settings.openRouterKey;
    localAI?.stop();
  }
}

async function aiModelState() {
  const python = aiModels ? await aiModels.mlxPython() : null;
  return {
    selectedId: settings?.localAiModelId,
    runtime: Boolean(python),
    runtimeShared: Boolean(python && python.includes("phonon-venv")),
    models: await Promise.all(
      AI_CATALOG.map(async (entry) => {
        const target = catalogTargetPath(entry, AI_MODELS_DIR);
        return {
          id: entry.id,
          label: entry.label,
          source: entry.source,
          sizeLabel: entry.sizeLabel,
          detail: entry.detail,
          installed: !aiModels?.isBusy(entry.id) && fs.existsSync(path.join(target, "model.safetensors")),
          progress: aiModels?.status(entry.id) || null,
        };
      }),
    ),
  };
}

async function listOpenRouterModels() {
  if (openRouterModelsCache && Date.now() - openRouterModelsCache.loadedAt < 10 * 60 * 1000) {
    return openRouterModelsCache.models;
  }
  const response = await fetch("https://openrouter.ai/api/v1/models", {
    headers: settings.openRouterKey
      ? { Authorization: `Bearer ${settings.openRouterKey}` }
      : undefined,
  });
  if (!response.ok) throw new Error(`OpenRouter model list failed (${response.status}).`);
  const payload = await response.json();
  const models = (payload.data || [])
    .filter((model) => model.id && model.name)
    .map((model) => ({
      id: model.id,
      name: model.name,
      provider: model.id.split("/")[0],
      contextLength: model.context_length || null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  openRouterModelsCache = { loadedAt: Date.now(), models };
  return models;
}

ipcMain.handle("recording:append-chunk", async (_event, chunk) => {
  if (!["starting", "recording", "stopping"].includes(phase)) {
    throw new Error("No writable recording is active.");
  }
  const stream = currentRecording?.stream;
  if (!stream || stream.destroyed) throw new Error("The audio file stream is not available.");
  await new Promise((resolve, reject) => {
    stream.write(Buffer.from(chunk), (error) => (error ? reject(error) : resolve()));
  });
  return true;
});

ipcMain.handle(
  "transcription:append-pcm",
  async (_event, { source, samples: chunk, startedAt, endedAt }) => {
    const recording = currentRecording;
    if (
      !recording ||
      !liveTranscriber ||
      !["starting", "recording", "stopping"].includes(phase)
    ) {
      return false;
    }
    if (source !== "microphone" && source !== "system") {
      throw new Error("Unknown live transcription audio source.");
    }
    const samples = new Float32Array(chunk);
    // Your microphone while you were dictating or asking privately isn't part of the call.
    if (source === "microphone" && recording.privateSpeech.some((window) => endedAt > window.start && startedAt < window.end)) return false;
    recording.transcriptionQueue = recording.transcriptionQueue.then(async () => {
      const seconds = samples.length / 16000;
      // The other side's voice print is taken alongside transcription, to tell people apart.
      // In a room the microphone hears everyone; on a call it's you, and that's how your voice is learned.
      const roomVoice = recording.inPerson && source === "microphone";
      const learnSelf = source === "microphone" && !recording.inPerson && voiceEmbedder && recording.speakerTracker && seconds >= 2;
      const wantsVoice = (source === "system" || roomVoice || learnSelf) && voiceEmbedder && recording.speakerTracker && seconds >= 1;
      const [rawText, embedding] = await Promise.all([
        liveTranscriber.transcribe(samples),
        wantsVoice ? voiceEmbedder.embed(samples).catch(() => null) : null,
      ]);
      const text = applyDictionary(rawText.trim(), settings.dictionaryEntries);
      if (!text) return;
      const zoomSpeaker =
        source === "system" ? zoomObserver?.resolveSpeaker({ startedAt, endedAt }) : null;
      let voiceLabel = null;
      if (embedding && learnSelf) {
        const print = normalize(embedding);
        const self = recording.selfVoice;
        self.sum = self.sum ? self.sum.map((value, index) => value + print[index] * seconds) : print.map((value) => value * seconds);
        self.seconds += seconds;
      } else if (embedding && roomVoice) {
        voiceLabel = recording.speakerTracker.add(embedding, seconds);
      } else if (embedding && zoomSpeaker) {
        const voice = recording.zoomVoices.get(zoomSpeaker) || { sum: new Array(embedding.length).fill(0), seconds: 0 };
        const print = normalize(embedding);
        voice.sum = voice.sum.map((value, index) => value + print[index] * seconds);
        voice.seconds += seconds;
        recording.zoomVoices.set(zoomSpeaker, voice);
      } else if (embedding) {
        voiceLabel = recording.speakerTracker.add(embedding, seconds);
      }
      // A stretch too short to judge in a room continues with whoever spoke last.
      if (recording.inPerson && source === "microphone" && !voiceLabel) voiceLabel = recording.lastRoomVoice || null;
      if (recording.inPerson && source === "microphone" && voiceLabel) recording.lastRoomVoice = voiceLabel;
      const segment = {
        text,
        source,
        speaker:
          (voiceLabel && recording.speakerTracker.displayName(voiceLabel)) ||
          segmentSpeaker({
            source,
            configuredSpeakerName: recording.speakerName,
            zoomSpeaker,
          }),
        voiceLabel,
        timestamp: formatElapsed(recording.startedAt, startedAt),
        // For the speaking coach: seconds from the start of the call, and whether it was you.
        you: source === "microphone" && !recording.inPerson,
        start: startedAt ? Math.max(0, (Number(startedAt) - recording.startedAt.getTime()) / 1000) : undefined,
        end: endedAt ? Math.max(0, (Number(endedAt) - recording.startedAt.getTime()) / 1000) : undefined,
      };
      recording.transcriptSegments.push(segment);
      recorderWindow?.webContents.send("meeting:transcript", segment);
      scheduleLiveSummary();
      void maybeNudge();
    });
    await recording.transcriptionQueue;
    return true;
  },
);

// The notes template for the call in progress ("auto" follows the setting and the calendar title).
ipcMain.handle("meeting:template", async (_event, id) => {
  if (!currentRecording) return null;
  currentRecording.template = TEMPLATES.some((template) => template.id === id) ? id : "auto";
  return currentRecording.template;
});
ipcMain.handle("templates:list", () => TEMPLATES.map(({ id, label, sections }) => ({ id, label, sections })));

// What you type in "Your notes" during a call; expanded with the transcript when it ends.
ipcMain.handle("meeting:user-notes", async (_event, text) => {
  if (!currentRecording) return false;
  currentRecording.userNotes = String(text || "").slice(0, 20000);
  return true;
});

ipcMain.handle("app:start-recording", async (_event, options) => {
  zoomAutoRecording?.manualStartRequested();
  return startRecording({ origin: "manual", inPerson: Boolean(options?.inPerson) });
});
ipcMain.handle("app:stop-recording", async () => stopRecording({ reason: "manual" }));
ipcMain.handle("app:hide-controls", () => recorderWindow?.hide());
ipcMain.handle("permissions:request", async () => requestRequiredPermissions({ showResult: true }));
ipcMain.handle("onboarding:permissions", async () => currentPermissions());
ipcMain.handle("onboarding:request-permission", async (_event, kind) => {
  if (!PRIVACY_PANES[kind]) throw new Error("Unknown permission.");
  return requestPermission(kind);
});
ipcMain.handle("onboarding:suggested-name", async () => suggestedName());
// Onboarding's coach practice: a short talk, transcribed on this Mac and scored like a call.
let practicing = false;
ipcMain.handle("practice:start", async () => {
  if (!activeTranscriptionModel()) throw new Error("Install a transcription model first; it's on the Transcription step.");
  if (practicing || (dictation && dictation.state !== "idle") || voiceAsk?.capturing || commandMode?.busy) throw new Error("Finish what you're saying first.");
  ensureHotkeyHelper();
  practicing = true;
  try {
    await dictationOverlay.startCapture();
  } catch (error) {
    practicing = false;
    throw error;
  }
  return true;
});
ipcMain.handle("practice:stop", async () => {
  if (!practicing) return null;
  practicing = false;
  const samples = await dictationOverlay.stopCapture({ tailMs: 200 });
  const text = (await transcribeDictation(samples)).replace(/\s+/g, " ").trim();
  return practiceStats(applyDictionary(text, settings.dictionaryEntries), samples);
});
ipcMain.handle("practice:cancel", () => {
  if (!practicing) return false;
  practicing = false;
  dictationOverlay?.cancelCapture();
  return true;
});

ipcMain.handle("onboarding:finish", async () => {
  await settingsStore.save({ onboardingCompleted: true, whatsNewSeen: WHATS_NEW_VERSION });
  await refreshRuntimeSettings();
  onboardingWindow?.close();
  showControlsWindow();
  return true;
});
ipcMain.handle("settings:open", async (_event, section) => showSettingsWindow(section));
ipcMain.handle("notes:open-folder", async () => shell.openPath(settings.notesDir));
ipcMain.handle("notes:open-note", async (_event, notePath) => {
  // Links the windows may open: Notion pages, the Notion and Composio sign-in pages, and OpenRouter keys.
  if (/^https:\/\/((www\.)?notion\.so|app\.notion\.com|(dashboard|connect)\.composio\.dev|openrouter\.ai)\//.test(String(notePath || ""))) {
    return shell.openExternal(String(notePath));
  }
  const resolved = path.resolve(String(notePath || ""));
  if (!resolved.startsWith(path.resolve(settings.notesDir) + path.sep) || !resolved.endsWith(".md")) {
    throw new Error("That note isn't in your notes folder.");
  }
  return shell.openPath(resolved);
});
ipcMain.handle("settings:get", async () => {
  const {
    openRouterKey: _openRouterKey,
    openAiKey: _openAiKey,
    groqKey: _groqKey,
    aiKey: _aiKey,
    aiEndpoint: _aiEndpoint,
    ...publicSettings
  } = settings;
  return {
    ...settingsStore.publicState(),
    ...publicSettings,
    aiReady: Boolean(settings.aiKey),
    launchAtLogin: app.getLoginItemSettings().openAtLogin,
    transcriptionModels,
  };
});
ipcMain.handle("settings:choose-notes-folder", async () => {
  const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow() || settingsWindow || recorderWindow, {
    title: "Choose where Meeting Notes are saved",
    defaultPath: settings.notesDir,
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle("settings:save", async (_event, update) => {
  if (typeof update.launchAtLogin === "boolean") {
    app.setLoginItemSettings({ openAtLogin: update.launchAtLogin });
    const { launchAtLogin: _launchAtLogin, ...rest } = update;
    update = rest;
    if (!Object.keys(update).length) {
      return { ...settingsStore.publicState(), aiReady: Boolean(settings.aiKey), aiLocal: settings.aiLocal, launchAtLogin: app.getLoginItemSettings().openAtLogin, transcriptionModels };
    }
  }
  if (phase !== "idle") throw new Error("Stop the current recording before changing settings.");
  const sameKey = (left, right) =>
    left && right && left.keyCode === right.keyCode && [...left.modifiers].sort().join() === [...right.modifiers].sort().join();
  const shortcuts = {
    dictationHotkey: settings.dictationHotkey,
    askHotkey: settings.askHotkey,
    commandHotkey: settings.commandHotkey,
    liveHelpHotkey: settings.liveHelpHotkey,
    grabHotkey: settings.grabHotkey,
    clipboardHotkey: settings.clipboardHotkey,
    saveHotkey: settings.saveHotkey,
  };
  for (const name of Object.keys(shortcuts)) {
    if (!update[name]) continue;
    const next = normalizeHotkey(update[name]);
    if (Object.entries(shortcuts).some(([other, current]) => other !== name && sameKey(next, current))) {
      throw new Error("Dictation, Ask, Edit, Live help, Grab text, Clipboard history and Save link each need their own shortcut.");
    }
  }
  if (
    update.transcriptionModelId &&
    !transcriptionModels.some((model) => model.id === update.transcriptionModelId)
  ) {
    throw new Error("The selected transcription model is no longer available.");
  }
  if (
    update.notionDataSourceId?.trim() &&
    !/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(update.notionDataSourceId.trim())
  ) {
    throw new Error("The Notion data source ID should be a 32-character ID such as 1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d.");
  }
  const notesDirBefore = settings.notesDir;
  const state = await settingsStore.save(update);
  await refreshRuntimeSettings();
  if (settings.notesDir !== notesDirBefore) libraryChanged();
  return { ...state, aiReady: Boolean(settings.aiKey), aiLocal: settings.aiLocal, launchAtLogin: app.getLoginItemSettings().openAtLogin, transcriptionModels };
});
function recordingStem() {
  return currentRecording ? path.basename(currentRecording.stem) : null;
}
ipcMain.handle("library:list", async () => library.list());
ipcMain.handle("library:search", async (_event, query) => library.search(query));
ipcMain.handle("library:get", async (_event, id) => library.get(id));
ipcMain.handle("library:update", async (_event, id, changes) => {
  const meta = await library.update(id, changes);
  libraryChanged();
  return meta;
});
ipcMain.handle("library:remove", async (_event, id) => {
  if (id === recordingStem()) throw new Error("That call is still recording.");
  await library.remove(id);
  await coachStore?.remove(id).catch(() => {});
  libraryChanged();
  return true;
});
// Action items across your meetings, and ticking them off in the note.
ipcMain.handle("actions:list", async () =>
  (await library.actionItems()).map((item) => ({ ...item, mine: isMe(item.owner, settings.speakerName) })),
);
ipcMain.handle("actions:set", async (_event, id, index, done) => {
  await library.setActionDone(String(id), Number(index), Boolean(done));
  // Same in Linear, Notion or Reminders, if the item was sent there.
  void actionSender?.syncDone(String(id), Number(index), Boolean(done)).catch((error) => notify("Couldn't update it everywhere", error.message.slice(0, 180)));
  libraryChanged();
  recorderWindow?.webContents.send("dashboard:changed");
  return true;
});
// The speaking coach for one call, and for this week's calls together.
ipcMain.handle("coach:get", async (_event, id) => {
  const meeting = await library.get(id);
  return meeting ? coachStore.statsFor(meeting, { you: settings.speakerName }) : null;
});
ipcMain.handle("coach:week", async () => {
  const weekAgo = Date.now() - 7 * 86_400_000;
  const recent = (await library.list()).meetings.filter((meeting) => meeting.startedAt >= weekAgo).slice(0, 40);
  const stats = [];
  for (const summary of recent) {
    const meeting = await library.get(summary.id).catch(() => null);
    if (meeting) stats.push(await coachStore.statsFor(meeting, { you: settings.speakerName }));
  }
  return combineStats(stats);
});
ipcMain.handle("library:create-folder", async (_event, name) => {
  const folder = await library.createFolder(name);
  libraryChanged();
  return folder;
});
ipcMain.handle("library:rename-folder", async (_event, id, name) => {
  const folder = await library.renameFolder(id, name);
  libraryChanged();
  return folder;
});
ipcMain.handle("library:delete-folder", async (_event, id) => {
  await library.deleteFolder(id);
  libraryChanged();
  return true;
});
const askRequests = new Map();
async function askScopeIds(scope = {}) {
  if (scope.kind === "meeting") return [String(scope.id)];
  if (scope.kind !== "folder" && scope.kind !== "unfiled") return null;
  const { meetings, folders } = await library.list();
  const known = new Set(folders.map((folder) => folder.id));
  return meetings
    .filter((meeting) => (scope.kind === "folder" ? meeting.folderId === scope.id : !meeting.folderId || !known.has(meeting.folderId)))
    .map((meeting) => meeting.id);
}
// Knowledge base passages for a question, numbered for citing, or nothing when it's off or empty.
// Passages from your knowledge base folders and connected MCP sources. Sources only ever receive
// sourceQuery (your own question), never call transcript.
async function knowledgeFor(query, limit = 6, sourceQuery = query) {
  if (!settings.knowledgeEnabled) return { text: "", sources: {} };
  const local = settings.knowledgeFolders?.length && knowledgeBase ? knowledgeBase.search(query, { limit }) : [];
  const external = knowledgeSources ? await knowledgeSources.search(sourceQuery).catch(() => []) : [];
  return knowledgeBlock([...local, ...external]);
}

// Answers a question about past meetings, streaming the reply through onDelta.
async function answerQuestion({ question, history = [], scope = { kind: "all" }, signal, onDelta }) {
  const text = String(question || "").trim().slice(0, 2000);
  if (!text) throw new Error("Type a question first.");
  if (!settings.aiKey) throw new Error("Ask needs AI. Add an OpenRouter key or download an on-device model in Settings → AI notes.");
  const meetings = await library.corpus(await askScopeIds(scope));
  const knowledge = await knowledgeFor(text);
  if (!meetings.length && !knowledge.text) {
    throw new Error(scope?.kind === "meeting" ? "This meeting has no notes on this Mac to ask about." : "There are no meeting notes here to ask about yet.");
  }
  const answer = await streamCompletion({
    ...aiTarget(settings),
    messages: buildMessages({
      meetings,
      question: text,
      history: Array.isArray(history) ? history : [],
      speakerName: settings.speakerName,
      knowledge: knowledge.text,
    }),
    signal,
    onDelta,
  });
  return { text: answer, meetingCount: meetings.length, sources: knowledge.sources };
}

// Live help during a call: the call so far, your knowledge base and earlier calls with these people.
async function liveHelp({ question, history = [], signal, onDelta }) {
  const recording = currentRecording;
  if (!recording) return answerQuestion({ question, history, signal, onDelta });
  const text = String(question || "").trim().slice(0, 2000);
  if (!text) throw new Error("Type a question first.");
  if (!settings.aiKey) throw new Error("Live help needs AI. Add an OpenRouter key or download an on-device model in Settings → AI notes.");
  const transcript = transcriptText(recording);
  const knowledge = await knowledgeFor(`${text}\n${transcript.slice(-800)}`, 6, text);
  const earlier = await earlierCallsFor(recording);
  const answer = await streamCompletion({
    ...aiTarget(settings),
    messages: liveHelpMessages({
      question: text,
      transcript,
      notes: recording.liveAnalysis || null,
      onScreen: recording.slides.at(-1)?.text || "",
      knowledge: knowledge.text,
      earlier,
      speakerName: settings.speakerName,
      vocabulary: settings.vocabulary,
      history: Array.isArray(history) ? history : [],
    }),
    signal,
    onDelta,
  });
  return { text: answer, sources: knowledge.sources, live: true };
}

// Earlier calls in the same series, or with the same people, for live help and tips.
async function earlierCallsFor(recording) {
  const corpus = await library.corpus();
  const attendees = recording.calendar?.attendees || [];
  const series = recording.calendar?.recurring ? seriesMeetings(corpus, { ...recording.calendar, start: recording.startedAt.getTime() }) : [];
  const withPeople = attendees.length ? pastMeetingsWith(corpus, attendees, { before: recording.startedAt.getTime(), limit: 3 }) : [];
  return [...series, ...withPeople.filter((meeting) => !series.includes(meeting))].slice(0, 4);
}

// Tips during calls: a check now and then, and a card only when there's something worth saying.
let nudgeInFlight = false;
let nudgeHideTimer = null;
let currentNudge = null;
const NUDGE_VISIBLE_MS = 30_000;

async function maybeNudge() {
  const recording = currentRecording;
  if (!recording?.nudges || nudgeInFlight || phase !== "recording") return;
  if (settings.liveNudges === false || !settings.aiKey) return;
  recording.nudges.setFrequency(settings.liveNudgeFrequency);
  const transcript = transcriptText(recording);
  const words = transcript.split(/\s+/).filter(Boolean).length;
  if (!recording.nudges.due(words)) return;
  // Never over something you're using, and never while you're sharing your screen in Zoom.
  if (askCard?.visible || zoomState?.screenSharing) return;
  if ((dictation && dictation.state !== "idle") || voiceAsk?.capturing || commandMode?.busy) return;
  recording.nudges.checked(words);
  nudgeInFlight = true;
  try {
    // Only this Mac's knowledge base folders: connected MCP sources are only ever sent your own questions.
    const local = settings.knowledgeEnabled && settings.knowledgeFolders?.length && knowledgeBase ? knowledgeBase.search(transcript.slice(-1500), { limit: 4 }) : [];
    const knowledge = knowledgeBlock(local);
    const [system, user] = nudgeMessages({
      transcript,
      notes: recording.liveAnalysis || null,
      onScreen: recording.slides.at(-1)?.text || "",
      knowledge: knowledge.text,
      earlier: await earlierCallsFor(recording),
      speakerName: settings.speakerName,
      vocabulary: settings.vocabulary,
      shown: recording.nudges.shown,
    });
    const raw = await callOpenAiCompatible({
      ...aiTarget(settings),
      system: system.content,
      user: user.content,
      headers: { "HTTP-Referer": "https://local.meetingnotes", "X-Title": "Meeting Notes" },
      signal: AbortSignal.timeout(20_000),
      extraBody: { provider: { sort: "latency" } },
    });
    const tip = parseNudge(raw);
    // The call may have ended, or you may have opened the card, while the model was thinking.
    if (!tip || currentRecording !== recording || askCard?.visible || recording.nudges.isRepeat(tip.text)) return;
    recording.nudges.record(tip.text);
    const sources = Object.fromEntries(Object.entries(knowledge.sources).filter(([id]) => tip.cite.includes(id)));
    const cited = tip.cite.filter((id) => !id.startsWith("kb:")).map((id) => `[[${id}]]`).join(" ");
    currentNudge = tip;
    const card = ensureAskCard();
    await card.show({ kind: "nudge", question: tip.title, text: [tip.text, cited].filter(Boolean).join(" "), status: "done", sources });
    clearTimeout(nudgeHideTimer);
    nudgeHideTimer = setTimeout(() => {
      if (askCard?.state.kind === "nudge" && askCard.visible) askCard.hide();
    }, NUDGE_VISIBLE_MS);
  } catch (error) {
    console.error("Call tip check failed:", error.message);
  } finally {
    nudgeInFlight = false;
  }
}

// The buttons on a tip: More (live help on that tip), or no more tips this call.
async function nudgeAction(name) {
  clearTimeout(nudgeHideTimer);
  if (name === "nudge:off") {
    if (currentRecording?.nudges) currentRecording.nudges.off = true;
    askCard?.hide();
    return;
  }
  if (name === "nudge:more" && currentNudge && currentRecording) {
    const tip = currentNudge;
    const card = ensureAskCard();
    suggestAbort?.abort();
    const controller = new AbortController();
    suggestAbort = controller;
    await card.show({ kind: "live", question: tip.title, text: "", status: "answering" });
    hotkeyHelper?.setDictating(true, "live");
    let text = "";
    try {
      const result = await liveHelp({
        question: `You showed me this tip: "${tip.text}". Tell me more: why it matters now and exactly what I could say.`,
        signal: controller.signal,
        onDelta: (delta) => {
          if (suggestAbort !== controller) return;
          text += delta;
          card.update({ text });
        },
      });
      if (suggestAbort === controller) card.update({ text: result.text || text, status: "done", sources: result.sources || {} });
    } catch (error) {
      if (!controller.signal.aborted && suggestAbort === controller) card.update({ status: "error", error: error.message });
    }
  }
}

// The live help shortcut: suggestions for the call as it stands, shown in the floating card.
let suggestAbort = null;
async function suggestNow() {
  if (!currentRecording || phase !== "recording") {
    dictationOverlay?.show("error", "Live help works during a call");
    return;
  }
  if (!settings.aiKey) {
    dictationOverlay?.show("error", "Live help needs AI: add a key or on-device model in Settings");
    return;
  }
  const recording = currentRecording;
  const card = ensureAskCard();
  suggestAbort?.abort();
  const controller = new AbortController();
  suggestAbort = controller;
  await card.show({ kind: "live", question: recording.calendar?.title ? `Suggestions for ${recording.calendar.title}` : "Suggestions for this call", text: "", status: "answering" });
  hotkeyHelper?.setDictating(true, "live");
  let text = "";
  try {
    const result = await liveHelp({
      question: SUGGEST_QUESTION,
      signal: controller.signal,
      onDelta: (delta) => {
        if (suggestAbort !== controller) return;
        text += delta;
        card.update({ text });
      },
    });
    if (suggestAbort === controller) card.update({ text: result.text || text, status: "done", sources: result.sources || {} });
  } catch (error) {
    if (!controller.signal.aborted && suggestAbort === controller) card.update({ status: "error", error: error.message });
  }
}

ipcMain.handle("live:ask", async (event, requestId, { question, history } = {}) => {
  const controller = new AbortController();
  askRequests.set(requestId, controller);
  try {
    return await liveHelp({
      question,
      history,
      signal: controller.signal,
      onDelta: (delta) => {
        if (!event.sender.isDestroyed()) event.sender.send("ask:delta", { requestId, delta });
      },
    });
  } catch (error) {
    if (controller.signal.aborted) return { text: "", cancelled: true };
    throw error;
  } finally {
    askRequests.delete(requestId);
  }
});

ipcMain.handle("ask:start", async (event, requestId, { question, history, scope } = {}) => {
  const controller = new AbortController();
  askRequests.set(requestId, controller);
  try {
    return await answerQuestion({
      question,
      history,
      scope,
      signal: controller.signal,
      onDelta: (delta) => {
        if (!event.sender.isDestroyed()) event.sender.send("ask:delta", { requestId, delta });
      },
    });
  } catch (error) {
    if (controller.signal.aborted) return { text: "", cancelled: true };
    throw error;
  } finally {
    askRequests.delete(requestId);
  }
});
// Drafts a follow-up email or Slack message for a meeting, streaming it like Ask.
ipcMain.handle("follow-up:draft", async (event, requestId, id, kind) => {
  if (!settings.aiKey) throw new Error("Drafts need AI. Add an OpenRouter key or download an on-device model in Settings → AI notes.");
  const meeting = await library.get(String(id));
  if (!meeting.hasNote) throw new Error("This call has no notes on this Mac to draft from.");
  const controller = new AbortController();
  askRequests.set(requestId, controller);
  const draftKind = FOLLOW_UP_KINDS.includes(kind) ? kind : "email";
  // Past dictations, so the draft sounds like the user. Only when they keep dictation history.
  const history = settings.dictationHistory && dictationHistory ? await dictationHistory.list({ limit: 200 }).catch(() => null) : null;
  try {
    const text = await streamCompletion({
      ...aiTarget(settings),
      messages: followUpMessages({
        meeting,
        kind: draftKind,
        speakerName: settings.speakerName,
        vocabulary: settings.vocabulary,
        samples: voiceSamples(history?.entries, draftKind),
      }),
      signal: controller.signal,
      onDelta: (delta) => {
        if (!event.sender.isDestroyed()) event.sender.send("ask:delta", { requestId, delta });
      },
    });
    return { text };
  } catch (error) {
    if (controller.signal.aborted) return { text: "", cancelled: true };
    throw error;
  } finally {
    askRequests.delete(requestId);
  }
});

ipcMain.handle("ask:cancel", async (_event, requestId) => {
  askRequests.get(requestId)?.abort();
  return true;
});
// App names for the dictation style rules' suggestions.
ipcMain.handle("apps:installed", async () => {
  const folders = ["/Applications", "/System/Applications", path.join(app.getPath("home"), "Applications")];
  const names = new Set();
  for (const folder of folders) {
    const entries = await fsp.readdir(folder).catch(() => []);
    for (const entry of entries) if (entry.endsWith(".app")) names.add(entry.slice(0, -4));
  }
  return [...names].sort((a, b) => a.localeCompare(b));
});
// The Now page's numbers.
ipcMain.handle("dashboard:get", async () => {
  const now = new Date();
  const meetings = await library.corpus();
  return {
    ...meetingStats(meetings, { now, speakerName: settings.speakerName }),
    dictation: await usageStats.dictation(weekOf(now), now),
    dictationEnabled: Boolean(settings.dictationEnabled),
  };
});
// Today's events for the Now page, only when calendar access is on.
ipcMain.handle("calendar:today", async () => {
  if (!settings.calendarEnabled || !calendarReader) return { enabled: false, events: [] };
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const events = await calendarReader.events(start.getTime(), start.getTime() + 86_400_000).catch(() => []);
  return {
    enabled: true,
    events: events
      .sort((a, b) => a.start - b.start)
      .map((event) => ({
        title: event.title || "Busy",
        start: event.start,
        end: event.end,
        link: event.link || null,
        attendees: attendeeNames(event, settings.speakerName),
        calendar: event.calendar || "",
      })),
  };
});
// Joins a call from its calendar link: Zoom links open the Zoom app straight into the meeting.
async function joinCall(link) {
  const target = joinTarget(link);
  if (target) await shell.openExternal(target.url);
}
ipcMain.handle("calendar:open-link", async (_event, link) => joinCall(link));
ipcMain.handle("knowledge:state", async () => ({ ...knowledgeBase?.status(), folders: settings.knowledgeFolders || [] }));
ipcMain.handle("knowledge:add-folder", async () => {
  const result = await dialog.showOpenDialog(settingsWindow || BrowserWindow.getFocusedWindow(), {
    title: "Choose a folder for your knowledge base",
    properties: ["openDirectory", "multiSelections"],
  });
  if (result.canceled) return settings.knowledgeFolders || [];
  const folders = [...new Set([...(settings.knowledgeFolders || []), ...result.filePaths])];
  await settingsStore.save({ knowledgeFolders: folders });
  await refreshRuntimeSettings();
  return folders;
});
ipcMain.handle("knowledge:remove-folder", async (_event, folder) => {
  const folders = (settings.knowledgeFolders || []).filter((entry) => entry !== folder);
  await settingsStore.save({ knowledgeFolders: folders });
  await refreshRuntimeSettings();
  return folders;
});
ipcMain.handle("knowledge:reindex", async () => reindexKnowledge());
// MCP servers as knowledge sources.
ipcMain.handle("knowledge:sources", async () => knowledgeSources.list());
ipcMain.handle("knowledge:add-source", async (_event, source) => {
  const list = await knowledgeSources.add(source || {});
  void knowledgeSources.warm();
  return list;
});
ipcMain.handle("knowledge:update-source", async (_event, id, changes) => knowledgeSources.update(String(id), changes || {}));
ipcMain.handle("knowledge:remove-source", async (_event, id) => knowledgeSources.remove(String(id)));
ipcMain.handle("knowledge:sign-in-source", async (_event, id) => knowledgeSources.signInAgain(String(id)));
ipcMain.handle("knowledge:test-source", async (_event, query) => knowledgeSources.search(String(query || "")));

// Connect AI apps: the meeting-notes command and the MCP server for Claude, Claude Code and Cursor.
function connectSpec() {
  return aiConnect.launchSpec({ execPath: process.execPath, appPath: app.getAppPath() });
}
async function connectState() {
  const spec = connectSpec();
  const cliPath = aiConnect.cliPath();
  // Login shells add ~/.local/bin on most setups; check the shell's real PATH rather than ours.
  const shellPath = await new Promise((resolve) => {
    require("node:child_process").execFile(process.env.SHELL || "/bin/zsh", ["-ilc", 'printf "<<%s>>" "$PATH"'], { timeout: 4000 }, (error, stdout) =>
      resolve(/<<(.*)>>/.exec(String(stdout || ""))?.[1] || ""),
    );
  });
  const onPath = shellPath.split(":").includes(path.dirname(cliPath));
  return {
    cli: { installed: await aiConnect.cliInstalled(spec), path: cliPath, onPath },
    clients: await Promise.all(Object.keys(aiConnect.CLIENTS).map((id) => aiConnect.clientStatus(id, spec))),
    snippets: aiConnect.snippets(spec, { cliOnPath: onPath && (await aiConnect.cliInstalled(spec)) }),
  };
}
ipcMain.handle("connect:state", async () => connectState());
ipcMain.handle("connect:install-cli", async () => {
  await aiConnect.installCli(connectSpec());
  return connectState();
});
ipcMain.handle("connect:client", async (_event, id, connect) => {
  if (connect) await aiConnect.connectClient(id, connectSpec());
  else await aiConnect.disconnectClient(id, connectSpec());
  return connectState();
});
ipcMain.handle("connect:copy", (_event, text) => {
  clipboard.writeText(String(text || ""));
  return true;
});
// Opens a cited document, only from your knowledge base folders.
async function openKnowledgeFile(file) {
  // Passages from MCP sources have no file to open.
  if (String(file || "").startsWith("mcp:")) return;
  const resolved = path.resolve(String(file || ""));
  const inside = (settings.knowledgeFolders || []).some((folder) => resolved.startsWith(path.resolve(folder) + path.sep));
  if (!inside) throw new Error("That file isn't in your knowledge base.");
  await shell.openPath(resolved);
}
ipcMain.handle("knowledge:open", async (_event, file) => openKnowledgeFile(file));
// Clipboard history and "Grab text from screen".
function clipboardChanged() {
  recorderWindow?.webContents.send("clipboard:changed");
  if (clipboardPicker?.window && !clipboardPicker.window.isDestroyed()) clipboardPicker.window.webContents.send("clipboard:changed");
}

let lastClipboardPrune = 0;
function syncClipboardTools() {
  if (!settings.grabTextEnabled && !settings.clipboardHistoryEnabled && settings.savedEnabled === false && !hotkeyHelper) return;
  // The shortcuts need Accessibility; until setup has asked for it, wait rather than prompt.
  if (!hotkeyHelper && accessibilityStatus(false) !== "granted") return;
  const helper = ensureHotkeyHelper();
  helper.setHotkey(settings.grabTextEnabled ? settings.grabHotkey : null, "grab");
  helper.setHotkey(settings.clipboardHistoryEnabled ? settings.clipboardHotkey : null, "clipboard");
  helper.setHotkey(settings.savedEnabled !== false ? settings.saveHotkey : null, "save");
  helper.watchPasteboard(settings.clipboardHistoryEnabled);
  if (!settings.clipboardHistoryEnabled) clipboardPicker?.hide({ restoreFocus: true });
  lastClipboardPrune = 0;
}

function ignoredCopy(message) {
  if (message.hidden || CLIPBOARD_SECRET_APPS.has(message.bundleId)) return true;
  const names = (settings.clipboardIgnoreApps || []).map((name) => name.toLowerCase());
  return names.includes(String(message.app || "").toLowerCase()) || names.includes(String(message.bundleId || "").toLowerCase());
}

async function recordCopy(message) {
  if (!settings.clipboardHistoryEnabled || !clipboardHistory) return;
  if (Date.now() < clipboardMuteUntil || ignoredCopy(message)) return;
  try {
    const source = { app: message.app, bundleId: message.bundleId };
    let added = null;
    const fileUrl = message.file ? clipboard.read("public.file-url") : "";
    const text = clipboard.readText();
    if (fileUrl.startsWith("file://")) {
      added = await clipboardHistory.add({ ...source, kind: "file", text: fileURLToPath(fileUrl) });
    } else if (text.trim()) {
      added = await clipboardHistory.add({ ...source, text });
    } else if (message.image) {
      const image = clipboard.readImage();
      if (image.isEmpty()) return;
      const png = image.toPNG();
      if (png.length > 25 * 1024 * 1024) return;
      added = await clipboardHistory.addImage({ ...source, png, ...image.getSize() });
    }
    if (Date.now() - lastClipboardPrune > 60 * 60 * 1000) {
      lastClipboardPrune = Date.now();
      await clipboardHistory.prune(settings.clipboardKeepDays);
    }
    if (added) clipboardChanged();
  } catch (error) {
    console.error("Couldn't keep a copy in the clipboard history:", error.message);
  }
}

function writeClipboardEntry(entry) {
  muteClipboard();
  if (entry.kind === "image") {
    const image = nativeImage.createFromPath(clipboardHistory.imagePath(entry));
    if (image.isEmpty()) throw new Error("That image is no longer on this Mac.");
    clipboard.writeImage(image);
  } else {
    clipboard.writeText(entry.text);
  }
}

// Pastes a history item into the app that was in front when the picker opened.
async function chooseFromHistory({ id, how, target }) {
  const entry = await clipboardHistory?.get(id);
  if (!entry) return;
  writeClipboardEntry(entry);
  void clipboardHistory.touch(id).then(clipboardChanged);
  if (!target?.pid || !hotkeyHelper) return;
  await hotkeyHelper.activate(target.pid).catch(() => {});
  if (how === "copy") return;
  await new Promise((resolve) => setTimeout(resolve, 140));
  await hotkeyHelper.paste().catch((error) => console.error("Couldn't paste from the clipboard history:", error.message));
}

async function toggleClipboardPicker() {
  if (!settings.clipboardHistoryEnabled || !clipboardHistory) return;
  if (!clipboardPicker) {
    clipboardPicker = new ClipboardPicker();
    clipboardPicker.on("choose", (choice) => void chooseFromHistory(choice));
    clipboardPicker.on("restore-focus", (target) => void hotkeyHelper?.activate(target.pid).catch(() => {}));
    clipboardPicker.on("open-page", () => {
      showControlsWindow();
      recorderWindow?.webContents.send("app:open-page", "clipboard");
    });
  }
  if (clipboardPicker.visible) {
    clipboardPicker.hide({ restoreFocus: true });
    return;
  }
  const focus = await hotkeyHelper?.focus().catch(() => null);
  await clipboardPicker.show(focus?.pid ? { pid: focus.pid, app: focus.app || "", bundleId: focus.bundleId || "" } : null);
}

// Pick an area of the screen (or use the copied image) and put the text in it on the clipboard.
async function grabScreenText({ fromClipboard = false } = {}) {
  if (!screenText || screenText.busy) return;
  ensureHotkeyHelper();
  await dictationOverlay.preload().catch(() => {});
  if (!fromClipboard && currentPermissions().screen !== "granted") {
    dictationOverlay.show("error", "Grab text needs Screen Recording. Turn on Meeting Notes in System Settings.");
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PRIVACY_PANES.screen}`);
    return;
  }
  try {
    const options = { keepLineBreaks: settings.grabKeepLineBreaks };
    const read = fromClipboard ? await screenText.fromClipboard(options) : await screenText.capture(options);
    if (!read) return;
    const result = read.result;
    if (!result) {
      dictationOverlay.show("empty", fromClipboard ? "No text in the copied image" : "No text found there");
      return;
    }
    muteClipboard();
    clipboard.writeText(result.text);
    if (settings.clipboardHistoryEnabled && clipboardHistory) {
      await clipboardHistory.add({ text: result.text, kind: result.kind, app: fromClipboard ? "Copied image" : "Screen", source: "screen" });
      clipboardChanged();
    }
    const words = result.text.split(/\s+/).filter(Boolean).length;
    const message =
      result.kind === "link" ? "Link copied" : result.kind === "qr" ? "QR code copied" : result.kind === "barcode" ? "Barcode copied" : `Copied ${words} ${words === 1 ? "word" : "words"}`;
    dictationOverlay.show("copied", message);
  } catch (error) {
    console.error("Grab text failed:", error.message);
    dictationOverlay.show("error", fromClipboard ? error.message : "Couldn't read the text there");
  }
}

const clipboardEntryView = (() => {
  const thumbnails = new Map();
  return (entry) => {
    if (entry.kind !== "image") return entry;
    if (!thumbnails.has(entry.id)) {
      const image = nativeImage.createFromPath(clipboardHistory.imagePath(entry));
      thumbnails.set(entry.id, image.isEmpty() ? "" : image.resize({ width: Math.min(480, image.getSize().width || 480) }).toDataURL());
    }
    return { ...entry, thumbnail: thumbnails.get(entry.id) };
  };
})();

ipcMain.handle("clipboard:list", async (_event, query, kind) => {
  if (!clipboardHistory) return { entries: [], total: 0 };
  const result = await clipboardHistory.list({ query: String(query || ""), kind: String(kind || ""), limit: 200 });
  return { ...result, entries: result.entries.map(clipboardEntryView) };
});
ipcMain.handle("clipboard:pin", async (_event, id, pinned) => {
  await clipboardHistory?.pin(String(id), Boolean(pinned));
  clipboardChanged();
  return true;
});
ipcMain.handle("clipboard:remove", async (_event, id) => {
  await clipboardHistory?.remove(String(id));
  clipboardChanged();
  return true;
});
ipcMain.handle("clipboard:clear", async (_event, includePinned) => {
  await clipboardHistory?.clear({ includePinned: Boolean(includePinned) });
  clipboardChanged();
  return true;
});
ipcMain.handle("clipboard:copy", async (_event, id) => {
  const entry = await clipboardHistory?.get(String(id));
  if (!entry) throw new Error("That item is no longer in the history.");
  writeClipboardEntry(entry);
  await clipboardHistory.touch(entry.id);
  clipboardChanged();
  return true;
});
ipcMain.handle("clipboard:grab", async (_event, fromClipboard) => {
  // The window would otherwise sit over what you want to read.
  if (!fromClipboard) recorderWindow?.hide();
  await grabScreenText({ fromClipboard: Boolean(fromClipboard) });
  return true;
});

// Saved: posts, articles and pages from across the web, sorted into boards.
function savedChanged() {
  recorderWindow?.webContents.send("saved:changed");
}

// Browsers whose current page can be read with AppleScript. Others (Firefox) use a copied link.
const BROWSER_SCRIPTS = {
  "com.apple.Safari": "URL of front document",
  "com.apple.SafariTechnologyPreview": "URL of front document",
  "com.google.Chrome": "URL of active tab of front window",
  "com.google.Chrome.beta": "URL of active tab of front window",
  "com.brave.Browser": "URL of active tab of front window",
  "com.microsoft.edgemac": "URL of active tab of front window",
  "company.thebrowser.Browser": "URL of active tab of front window",
  "com.vivaldi.Vivaldi": "URL of active tab of front window",
  "org.chromium.Chromium": "URL of active tab of front window",
  "net.imput.helium": "URL of active tab of front window",
};

function browserUrl(bundleId) {
  const script = BROWSER_SCRIPTS[bundleId];
  if (!script) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-e", `tell application id "${bundleId}" to return ${script}`], { timeout: 3000 }, (error, stdout) =>
      resolve(error ? null : findUrl(stdout.trim())),
    );
  });
}

let savedQueue = Promise.resolve();

// Reads the page, keeps a small copy of its image, then asks the AI for a summary and tags.
function readSavedItem(id) {
  savedQueue = savedQueue.then(async () => {
    let item = await savedLibrary.get(id);
    if (!item) return;
    try {
      const page = await readPage(item.url);
      item = await savedLibrary.update(id, { ...page, imageUrl: page.image, status: settings.savedAi !== false && settings.aiKey ? "tagging" : "ready", error: "" });
      if (item?.mergedFrom) {
        savedChanged();
        return;
      }
      savedChanged();
      const bytes = await readImage(page.image).catch(() => null);
      const image = bytes ? nativeImage.createFromBuffer(bytes) : null;
      if (image && !image.isEmpty()) {
        const { width } = image.getSize();
        await savedLibrary.setImage(id, (width > 900 ? image.resize({ width: 900 }) : image).toJPEG(82), "jpg");
        savedChanged();
      }
      if (settings.savedAi !== false && settings.aiKey) {
        if (settings.aiLocal) void localAI?.warm();
        const tags = (await savedLibrary.tags()).map((entry) => entry.tag);
        const tagged = await tagSavedItem(await savedLibrary.get(id), settings, tags).catch((error) => {
          console.error("Couldn't tag a saved page:", error.message);
          return null;
        });
        await savedLibrary.update(id, { ...(tagged || {}), status: "ready" });
        savedChanged();
      }
    } catch (error) {
      await savedLibrary.update(id, { status: "failed", error: error.message });
      savedChanged();
    }
  });
  return savedQueue;
}

async function saveLink(input, { board = null, source = "paste" } = {}) {
  const url = findUrl(input);
  if (!url) throw new Error("That isn't a web link.");
  const { item, existing } = await savedLibrary.add(url, { board, source });
  savedChanged();
  if (!existing || item.status === "failed") void readSavedItem(item.id);
  return { id: item.id, existing };
}

// The save shortcut: the page open in your browser, or else a link you've just copied.
async function saveFromShortcut() {
  if (!savedLibrary) return;
  ensureHotkeyHelper();
  await dictationOverlay.preload().catch(() => {});
  const focus = await hotkeyHelper?.focus().catch(() => null);
  const url = (await browserUrl(focus?.bundleId)) || findUrl(clipboard.readText());
  if (!url) {
    dictationOverlay.show("error", "Copy a link, or open the page in your browser, then press it again");
    return;
  }
  try {
    const { existing } = await saveLink(url, { source: "shortcut" });
    dictationOverlay.show("copied", existing ? "Already saved, moved to the top" : "Saved");
  } catch (error) {
    dictationOverlay.show("error", error.message);
  }
}

const savedThumbnails = new Map();
function savedItemView(item) {
  const { text: _text, ...rest } = item;
  const file = savedLibrary.imagePath(item);
  if (file && !savedThumbnails.has(item.image)) {
    const image = nativeImage.createFromPath(file);
    savedThumbnails.set(item.image, image.isEmpty() ? "" : image.toDataURL());
  }
  return { ...rest, excerpt: String(item.text || item.description || "").slice(0, 400), thumbnail: file ? savedThumbnails.get(item.image) : "" };
}

ipcMain.handle("saved:list", async (_event, filter = {}) => {
  if (!savedLibrary) return { items: [], total: 0 };
  const result = await savedLibrary.list({
    query: String(filter.query || ""),
    board: String(filter.board || ""),
    tag: String(filter.tag || ""),
    kind: String(filter.kind || ""),
  });
  return { ...result, items: result.items.map(savedItemView) };
});
ipcMain.handle("saved:boards", async () => (savedLibrary ? savedLibrary.boards() : []));
ipcMain.handle("saved:tags", async () => (savedLibrary ? savedLibrary.tags() : []));
ipcMain.handle("saved:add", async (_event, input, board) => saveLink(String(input || ""), { board: board ? String(board) : null, source: "paste" }));
ipcMain.handle("saved:retry", async (_event, id) => {
  await savedLibrary.update(String(id), { status: "reading", error: "" });
  savedChanged();
  void readSavedItem(String(id));
  return true;
});
ipcMain.handle("saved:remove", async (_event, id) => {
  await savedLibrary.remove(String(id));
  savedChanged();
  return true;
});
ipcMain.handle("saved:set-board", async (_event, id, board, included) => {
  await savedLibrary.setBoard(String(id), String(board), Boolean(included));
  savedChanged();
  return true;
});
ipcMain.handle("saved:set-tags", async (_event, id, tags) => {
  await savedLibrary.setTags(String(id), Array.isArray(tags) ? tags : []);
  savedChanged();
  return true;
});
ipcMain.handle("saved:create-board", async (_event, name) => {
  const board = await savedLibrary.createBoard(String(name || ""));
  savedChanged();
  return board;
});
ipcMain.handle("saved:rename-board", async (_event, id, name) => {
  await savedLibrary.renameBoard(String(id), String(name || ""));
  savedChanged();
  return true;
});
ipcMain.handle("saved:remove-board", async (_event, id) => {
  await savedLibrary.removeBoard(String(id));
  savedChanged();
  return true;
});
ipcMain.handle("saved:open", async (_event, id) => {
  const item = await savedLibrary.get(String(id));
  if (!item || !/^https?:\/\//.test(item.url)) throw new Error("That link can't be opened.");
  await shell.openExternal(item.url);
  return true;
});

// Words the notes AI thinks were misheard on calls, offered in Settings → Dictionary.
ipcMain.handle("dictionary:suggestions", async () => (dictionarySuggestions ? dictionarySuggestions.list() : []));
// Added ones are saved through settings:save by the page; dismissed ones aren't suggested again.
ipcMain.handle("dictionary:suggestion", async (_event, term, accepted) => {
  await dictionarySuggestions?.take(String(term || ""), { dismiss: !accepted });
  return true;
});
ipcMain.handle("history:list", async (_event, query) => dictationHistory.list({ query: String(query || "") }));
ipcMain.handle("history:copy", async (_event, id) => {
  const entry = await dictationHistory.get(String(id));
  if (entry) clipboard.writeText(entry.text);
  return Boolean(entry);
});
ipcMain.handle("history:remove", async (_event, id) => {
  await dictationHistory.remove(String(id));
  return true;
});
ipcMain.handle("history:clear", async () => {
  await dictationHistory.clear();
  return true;
});
ipcMain.handle("digests:list", async () => digestStore.list());
ipcMain.handle("digests:get", async (_event, id) => digestStore.get(String(id)));
ipcMain.handle("digests:write", async (event, requestId, id) => {
  const controller = new AbortController();
  askRequests.set(requestId, controller);
  try {
    return await writeDigest(String(id), {
      signal: controller.signal,
      onDelta: (delta) => {
        if (!event.sender.isDestroyed()) event.sender.send("ask:delta", { requestId, delta });
      },
    });
  } finally {
    askRequests.delete(requestId);
  }
});
ipcMain.handle("calendar:status", async () => (calendarReader ? calendarReader.status().catch(() => "unknown") : "unknown"));
ipcMain.handle("calendar:connect", async () => {
  const status = await calendarReader.request();
  if (status === "granted") await settingsStore.save({ calendarEnabled: true });
  await refreshRuntimeSettings();
  return status;
});
ipcMain.handle("calendar:open-privacy", async () =>
  shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars"),
);
ipcMain.handle("voices:state", async () => ({ ...voiceModel, voices: voiceBank ? await voiceBank.summary() : [] }));
ipcMain.handle("voices:retry", async () => ensureVoiceModel());
ipcMain.handle("voices:forget", async (_event, id) => {
  await voiceBank.forget(String(id));
  await refreshDictionary();
  return voiceBank.summary();
});
ipcMain.handle("voices:names", async () => (voiceBank ? (await voiceBank.summary()).map((voice) => voice.name) : []));
// Renames a speaker in one meeting and remembers their voice for later calls.
ipcMain.handle("library:rename-speaker", async (_event, id, from, to) => {
  await library.renameSpeaker(id, from, to);
  const name = String(to).replace(/\s+/g, " ").trim();
  let learned = false;
  try {
    const file = speakersFile(String(id));
    const data = JSON.parse(await fsp.readFile(file, "utf8"));
    const voice = data.speakers?.[from];
    if (voice) {
      learned = Boolean(await voiceBank.learn(name, voice.embedding, voice.seconds));
      await refreshDictionary();
      delete data.speakers[from];
      data.speakers[name] = { ...voice, known: true };
      await fsp.writeFile(file, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    }
  } catch {
    // Older calls have no voice prints, so only the note changes.
  }
  libraryChanged();
  return { learned };
});
ipcMain.handle("library:open-note", async (_event, id) => shell.openPath(await library.filePath(id, "note")));
ipcMain.handle("library:reveal", async (_event, id, kind) => {
  shell.showItemInFolder(await library.filePath(id, kind === "audio" ? "audio" : "note"));
  return true;
});
ipcMain.handle("openrouter:list-models", async () => listOpenRouterModels());
ipcMain.handle("models:list", async () => modelListState());
ipcMain.handle("ai-models:list", async () => aiModelState());
// Connections: Linear, Notion, Google Drive (through Composio) and Apple Reminders.
let integrationJob = null;
ipcMain.handle("integrations:state", async () => actionSender.state());
ipcMain.handle("integrations:set-mode", async (_event, mode) => actionSender.setMode(String(mode)));
ipcMain.handle("integrations:connect", async (event, toolkit) => {
  if (!["linear", "notion", "googledrive"].includes(toolkit)) throw new Error("That app isn't supported.");
  integrationJob?.controller.abort();
  const job = { controller: new AbortController() };
  integrationJob = job;
  try {
    const result = await actionSender.connect(toolkit, {
      job,
      signal: job.controller.signal,
      progress: (update) => sendToPanels("integrations:progress", { toolkit, ...update }),
      onWaiting: () => sendToPanels("integrations:progress", { toolkit, state: "waiting", message: "Finish signing in in your browser." }),
    });
    bringBack(BrowserWindow.fromWebContents(event.sender));
    return result;
  } finally {
    if (integrationJob === job) integrationJob = null;
  }
});
ipcMain.handle("integrations:cancel", () => integrationJob?.controller.abort());
ipcMain.handle("integrations:disconnect", async (_event, toolkit) => actionSender.disconnect(String(toolkit)));
ipcMain.handle("integrations:options", async (_event, kind, query) => actionSender.options(String(kind), String(query || "")));
ipcMain.handle("integrations:choose", async (_event, kind, choice) => actionSender.choose(String(kind), choice || null));
ipcMain.handle("integrations:auto-send", async (_event, options) => actionSender.setAutoSend(options || {}));
ipcMain.handle("integrations:sent", async () => actionSender.sent());
// Opens a sent item or a saved Doc: only Linear, Notion and Google Docs links.
ipcMain.handle("integrations:open", async (_event, url) => {
  const target = new URL(String(url));
  if (target.protocol !== "https:" || !/(^|\.)(linear\.app|notion\.so|docs\.google\.com)$/.test(target.hostname)) throw new Error("That link can't be opened.");
  await shell.openExternal(target.href);
});
ipcMain.handle("integrations:send", async (_event, meetingId, index, destination) => {
  const result = await actionSender.send(String(meetingId), Number(index), String(destination));
  recorderWindow?.webContents.send("integrations:changed");
  return result;
});
ipcMain.handle("ai-models:install", async (_event, id) => {
  void aiModels.install(String(id)).catch((error) => console.error("On-device model install failed:", error.message));
  return aiModelState();
});
ipcMain.handle("ai-models:cancel", async (_event, id) => {
  aiModels.cancel(String(id));
  return aiModelState();
});
ipcMain.handle("ai-models:remove", async (_event, id) => {
  if (String(id) === settings.localAiModelId) localAI?.stop();
  await aiModels.remove(String(id));
  return aiModelState();
});
ipcMain.handle("notion:status", async () =>
  notionConnect.status(settings.notionDataSourceId, settings.notionDatabaseName),
);
ipcMain.handle("notion:connect", async (event, method) => {
  const chosen = method === "composio" ? "composio" : "cli";
  const account = await notionConnect.connect(chosen);
  bringBack(BrowserWindow.fromWebContents(event.sender));
  if (account) {
    const switched = chosen !== settings.notionAuth;
    await settingsStore.save({ notionAuth: chosen, notionComposioAccount: account.accountId || "" });
    await refreshRuntimeSettings();
    // A different sign-in may not see the saved database; if not, pick one again.
    if (switched && settings.notionDataSourceId) {
      const reachable = await notionConnect
        .request("GET", `v1/data_sources/${settings.notionDataSourceId}`, undefined, 30000)
        .then(() => true)
        .catch(() => false);
      if (!reachable) {
        await settingsStore.save({ notionDataSourceId: "", notionDatabaseName: "" });
        await refreshRuntimeSettings();
      }
    }
  }
  settingsWindow?.focus();
  return { account, status: await notionConnect.status(settings.notionDataSourceId, settings.notionDatabaseName) };
});
ipcMain.handle("notion:cancel", async () => notionConnect.cancel());
ipcMain.handle("notion:search", async (_event, query) => notionConnect.search(String(query || "")));
ipcMain.handle("notion:use-database", async (_event, { id, name }) => {
  if (!/^[0-9a-f-]{32,36}$/i.test(String(id || ""))) throw new Error("That isn't a Notion database.");
  const state = await settingsStore.save({ notionDataSourceId: id, notionDatabaseName: name || "" });
  await refreshRuntimeSettings();
  retryPendingNotionSaves();
  return state;
});
ipcMain.handle("notion:create-database", async (_event, parentPageId) => {
  const database = await notionConnect.createDatabase(String(parentPageId || ""));
  const state = await settingsStore.save({ notionDataSourceId: database.id, notionDatabaseName: database.name });
  await refreshRuntimeSettings();
  return { database, state };
});
ipcMain.handle("notion:disconnect", async () => {
  const state = await settingsStore.save({ notionDataSourceId: "", notionDatabaseName: "", notesDestination: "folder" });
  await refreshRuntimeSettings();
  return state;
});
ipcMain.handle("updates:status", async () => updater?.state || { state: "idle", supported: false, currentVersion: app.getVersion() });
ipcMain.handle("updates:check", async () => updater?.check());
ipcMain.handle("updates:install", async () => {
  if (phase !== "idle") throw new Error("Finish the current call first; the update installs right after.");
  return installUpdate();
});
ipcMain.handle("dictation:status", async () => dictationStatus());
ipcMain.handle("dictation:capture-hotkey", async () => {
  const hotkey = await ensureHotkeyHelper().capture();
  return hotkey ? { hotkey, label: hotkeyLabel(hotkey) } : null;
});
ipcMain.handle("dictation:cancel-capture", async () => hotkeyHelper?.cancelCapture());
ipcMain.handle("models:install", async (_event, id) => {
  modelManager.install(id).catch((error) => console.error(`Model install failed (${id}):`, error));
  return true;
});
ipcMain.handle("models:cancel", async (_event, id) => modelManager.cancel(id));
ipcMain.handle("models:remove", async (_event, id) => {
  if (phase !== "idle") throw new Error("Stop the current recording before removing a model.");
  const selected = activeTranscriptionModel();
  await modelManager.remove(id);
  if (selected?.catalogId === id) await settingsStore.save({ transcriptionModelId: "" });
  await refreshRuntimeSettings();
  return modelListState();
});
ipcMain.handle("models:select", async (_event, modelId) => selectTranscriptionModel(modelId));

ipcMain.on("recorder:command-result", (_event, { id, result, error }) => {
  const waiter = commandWaiters.get(id);
  if (!waiter) return;
  commandWaiters.delete(id);
  if (error) waiter.reject(new Error(error));
  else waiter.resolve(result);
});

if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => showControlsWindow());

app.whenReady().then(async () => {
  installFinderPath();
  updater = new Updater({ app, autoUpdater: app.isPackaged ? require("electron-updater").autoUpdater : null });
  let lastUpdateState = "";
  updater.on("state", (state) => {
    sendToPanels("updates:state", state);
    if (state.state === "ready" && lastUpdateState !== "ready") {
      notify("Update ready", `Meeting Notes ${state.version} installs when you restart it.`);
    }
    if (state.state !== lastUpdateState || state.state !== "downloading") rebuildMenu();
    lastUpdateState = state.state;
  });
  updater.start();
  loadEnvironment(app.getAppPath());
  const environmentSettings = getSettings();
  settingsStore = new SettingsStore({
    filePath: path.join(app.getPath("userData"), "settings.json"),
    safeStorage,
    defaults: environmentSettings,
  });
  await settingsStore.load();
  modelManager.on("progress", (progress) => {
    sendToPanels("models:progress", progress);
  });
  modelManager.on("changed", async (id) => {
    await refreshRuntimeSettings();
    if (!modelManager.isBusy(id) && transcriptionModels.some((model) => model.catalogId === id)) {
      const entry = modelManager.catalog().find((candidate) => candidate.id === id);
      notify("Model ready", `${entry.label} is installed.`);
    }
    sendToPanels("models:changed", modelListState());
  });
  notionSync = new NotionSync({
    ledgerPath: path.join(app.getPath("userData"), "notion-sync.json"),
    getSettings: () => settings || {},
    request: (method, apiPath, body) => notionConnect.request(method, apiPath, body),
    uploadImage: (file) => notionConnect.uploadImage(file),
  });
  library = new MeetingLibrary({
    metadataPath: path.join(app.getPath("userData"), "library.json"),
    copiesDir: path.join(app.getPath("userData"), "library"),
    getNotesDir: () => settings.notesDir,
    notionLedgerPath: path.join(app.getPath("userData"), "notion-sync.json"),
    trashItem: (filePath) => shell.trashItem(filePath),
  });
  zoomAutoRecording = new ZoomAutoRecordingController({
    getEnabled: () => settings?.autoRecordZoomMeetings,
    getPhase: () => phase,
    getRecordingOrigin: () => currentRecording?.origin,
    onStart: () => startRecording({ origin: "zoom-auto" }),
    onStop: () => stopRecording({ reason: "zoom-auto" }),
    onState: publishZoomAutomationState,
  });
  zoomObserver = new ZoomAccessibilityObserver({
    app,
    onState: (state) => {
      zoomState = state;
      if (state.accessibility !== permissionState.accessibility) {
        permissionState = { ...permissionState, accessibility: state.accessibility };
        publishPermissionState();
      }
      publishZoomState();
      zoomAutoRecording.updateZoomState(state);
      if (currentRecording) startScreenWatcher(currentRecording);
    },
    onAudioApps: (apps) => {
      const call = callTracker.update(apps);
      const changed = JSON.stringify(call) !== JSON.stringify(callState);
      callState = call;
      if (changed) {
        console.log(call ? `Call detected: ${call.app}${call.via ? ` in ${call.via}` : ""} (mic ${call.active ? "on" : "off"})` : "No call");
        publishZoomState();
      }
      zoomAutoRecording.updateCallState(call);
      // A call noticed after recording started still gets its screen watched.
      if (currentRecording) startScreenWatcher(currentRecording);
    },
  });
  zoomObserver.start();
  voiceBank = new VoiceBank(path.join(app.getPath("userData"), "voices.json"));
  calendarReader = new CalendarReader(calendarHelperPath(app));
  actionSender = new ActionSender({
    integrations: new Integrations(path.join(app.getPath("userData"), "integrations.json")),
    hosted: new HostedComposio({
      secret: new InstallSecret({
        filePath: path.join(app.getPath("userData"), "relay.json"),
        encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
        decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
      }),
      openExternal: (url) => shell.openExternal(url),
    }),
    personal: new PersonalComposio({ cli: notionConnect.composio }),
    calendar: calendarReader,
    library,
    speakerName: () => settings.speakerName,
  });
  knowledgeBase = new KnowledgeBase({ indexPath: path.join(app.getPath("userData"), "knowledge", "index.json"), pdfHelper: extractHelperPath() });
  await knowledgeBase.load();
  knowledgeSources = new KnowledgeSources({
    filePath: path.join(app.getPath("userData"), "knowledge", "sources.json"),
    encrypt: (value) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error("macOS secure storage is unavailable, so the token wasn't saved.");
      return safeStorage.encryptString(value).toString("base64");
    },
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
    // OAuth servers: sign in in your default browser.
    signIn: async (url, options) => {
      const result = await mcpOAuth.signIn(url, {
        ...options,
        openBrowser: async (link) => {
          if (!/^https?:\/\//.test(link)) throw new Error("The sign-in address isn't a web page.");
          await shell.openExternal(link);
        },
      });
      bringBack();
      return result;
    },
  });
  digestStore = new DigestStore(path.join(app.getPath("userData"), "digests"));
  usageStats = new UsageStats(path.join(app.getPath("userData"), "stats.json"));
  dictationHistory = new DictationHistory(path.join(app.getPath("userData"), "dictation-history.json"));
  dictionarySuggestions = new DictionarySuggestions(path.join(app.getPath("userData"), "dictionary-suggestions.json"));
  clipboardHistory = new ClipboardHistory(path.join(app.getPath("userData"), "clipboard-history.json"));
  savedLibrary = new SavedLibrary(path.join(app.getPath("userData"), "saved"));
  screenText = new ScreenText({
    binary: app.isPackaged ? path.join(process.resourcesPath, "bin", "meeting-notes-grab") : path.join(app.getAppPath(), "native", "grab", "meeting-notes-grab"),
    tempDir: path.join(app.getPath("userData"), "tmp"),
  });
  coachStore = new CoachStore(path.join(app.getPath("userData"), "coach"));
  aiModels = new ModelManager({ catalog: AI_CATALOG, modelsDir: AI_MODELS_DIR });
  aiModels.on("progress", (progress) => sendToPanels("ai-models:progress", progress));
  aiModels.on("changed", async () => {
    await refreshRuntimeSettings();
    sendToPanels("ai-models:changed", await aiModelState());
  });
  localAI = new LocalAI({ getPython: () => aiModels.mlxPython(), getModelPath: () => localModelPath() });
  await refreshRuntimeSettings();
  // Settings exist from here on.
  if (settings.knowledgeEnabled) void knowledgeSources.warm();
  retryPendingNotionSaves();
  // A normal Dock app. Set explicitly: macOS can remember older versions' menu-bar-only setting.
  void app.dock?.show();
  Menu.setApplicationMenu(buildAppMenu());
  await createRecorderWindow();
  tray = new Tray(nativeImage.createEmpty());
  trayIcon = new TrayIcon({ tray, nativeImage, nativeTheme });
  tray.setToolTip("Meeting Notes");
  rebuildMenu();
  if (settingsStore.onboardingCompleted() && !process.env.MEETING_NOTES_SHOW_WELCOME) {
    // Started by macOS at login: wait quietly in the menu bar.
    if (!app.getLoginItemSettings().wasOpenedAtLogin) showControlsWindow();
    setTimeout(() => void requestRequiredPermissions({ showResult: false }), 600);
  } else {
    // First run: the welcome window asks for each permission when it explains why.
    permissionState = { ...permissionState, ...currentPermissions() };
    publishPermissionState();
    await showOnboardingWindow();
  }
  console.log(
    `Meeting Notes ready: microphone=${settings.microphoneLabel}, system=${settings.mappedSystemOutputLabel}`,
  );
}).catch((error) => {
  // A failure while starting must never leave the app running with no window and no menu bar icon.
  console.error("Meeting Notes couldn't start:", error);
  dialog.showErrorBox("Meeting Notes couldn't start", `${error?.stack || error}\n\nPlease report this at github.com/lucassynnott/meeting-notes/issues.`);
  app.exit(1);
});

app.on("before-quit", (event) => {
  // ⌘Q and Dock → Quit wait for a recording and its notes, like Quit in the menu bar.
  if (!isQuitting && (phase !== "idle" || finishingCalls.size)) {
    event.preventDefault();
    void quitGracefully();
    return;
  }
  knowledgeSources?.closeAll();
  localAI?.close();
  zoomAutoRecording?.destroy();
  zoomObserver?.stop();
  isQuitting = true;
  clearTimeout(liveSummaryTimer);
  hotkeyHelper?.stop();
  void voiceEmbedder?.stop();
  dictationOverlay?.destroy();
  askCard?.destroy();
  clipboardPicker?.destroy();
  void transcribers.stopAll();
});
app.on("window-all-closed", () => {});
app.on("activate", () => {
  rebuildMenu();
  showControlsWindow();
});
