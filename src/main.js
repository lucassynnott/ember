const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
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
const { DictationController, splitForTranscription } = require("./dictation");
const { DictationOverlay } = require("./dictation-overlay");
const { VoiceAskController } = require("./voice-ask");
const { AskCard } = require("./ask-card");
const { CommandModeController, rewriteSelection } = require("./command-mode");
const { CalendarReader, attendeeNames, calendarHelperPath, matchEvent } = require("./calendar");
const { pastMeetingsWith, prepMessages, seriesMeetings, upcomingEvents } = require("./prep");
const { joinTarget } = require("./join-link");
const { KnowledgeBase, knowledgeBlock } = require("./knowledge");
const { liveHelpMessages } = require("./live-help");
const { DigestStore, digestMessages, weekFromId, weekOf } = require("./digest");
const { UsageStats, meetingStats } = require("./stats");
const { cleanDictation } = require("./dictation-cleanup");
const { applyDictionary, vocabularyHint } = require("./dictionary");
const { styleFor } = require("./dictation-style");
const { HotkeyHelper, hotkeyHelperPath, hotkeyLabel, normalizeHotkey } = require("./hotkey");
const { transcribeLocally } = require("./transcription");
const { NotionSync } = require("./notion-sync");
const { ModelManager, SUPPORT_DIR, downloadVerified } = require("./model-manager");
const { MODEL: VOICE_MODEL, SpeakerTracker, VoiceBank, VoiceEmbedder, normalize } = require("./speakers");
const { NotionConnect } = require("./notion-connect");
const { processMeeting } = require("./process-meeting");
const { MeetingLibrary } = require("./library");
const { buildMessages, streamCompletion } = require("./ask");
const { FOLLOW_UP_KINDS, followUpMessages } = require("./follow-up");
const { SettingsStore } = require("./settings-store");
const { summarizeTranscript } = require("./summary");
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
  askCard.on("closed", () => hotkeyHelper?.setDictating(false, "prep"));
  askCard.on("join", (link) => void joinCall(link));
  askCard.on("open-source", (file) => void openKnowledgeFile(file).catch((error) => console.error(error.message)));
  return askCard;
}

// Prep cards: a brief before a calendar call, from earlier calls with the same people.
const prepShown = new Set();
let prepTimer = null;
let prepAbort = null;

async function showPrep(event, { force = false } = {}) {
  const key = `${event.start}|${event.title}`;
  if (!settings.prepEnabled || !settings.openRouterKey || (!force && prepShown.has(key))) return false;
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
      key: settings.openRouterKey,
      model: settings.openRouterModel,
      messages: prepMessages({
        event,
        meetings,
        series,
        speakerName: settings.speakerName,
        vocabulary: settings.vocabulary,
        knowledge: (prepKnowledge = knowledgeFor(`${event.title || ""} ${(event.attendees || []).join(" ")}`, 3)).text,
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
let digestTimer = null;
let digestWriting = null;

async function writeDigest(weekId, { onDelta = () => {}, signal } = {}) {
  if (!settings.openRouterKey) throw new Error("Digests use your OpenRouter model. Add a key in Settings → AI notes.");
  const week = weekFromId(weekId);
  const meetings = (await library.corpus())
    .filter((meeting) => meeting.startedAt >= week.start && meeting.startedAt < week.end)
    .sort((a, b) => a.startedAt - b.startedAt);
  if (!meetings.length) throw new Error("There were no calls with notes that week.");
  const text = await streamCompletion({
    key: settings.openRouterKey,
    model: settings.openRouterModel,
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
  if (!settings?.weeklyDigest || !settings.openRouterKey || now.getDay() !== 5 || now.getHours() < 16 || digestWriting) return;
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
  backgroundColor: "#18181b",
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

function showControlsWindow() {
  if (!recorderWindow || recorderWindow.isDestroyed()) return;
  recorderWindow.show();
  recorderWindow.focus();
}

async function showSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
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
  await settingsWindow.loadFile(path.join(RENDERER_DIR, "settings.html"));
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
    }
    if (Object.keys(labels).length) {
      recorderWindow?.webContents.send("meeting:relabel", { startedAt: recording.startedAt.getTime(), labels });
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
  }, 20000);
}

async function updateLiveSummary() {
  if (liveSummaryInFlight || !currentRecording || !settings.openRouterKey) return;
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

async function startRecording({ origin = "manual" } = {}) {
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
      speakerTracker: settings.speakerSeparation && (await ensureVoiceModel()) ? new SpeakerTracker() : null,
      zoomVoices: new Map(),
    };
    currentRecording = recording;
    recorderWindow.webContents.send("meeting:reset", recording.startedAt.getTime());
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

// Everything after the recording itself: speaker names, the AI notes, the note file and Notion.
async function finishMeeting(recording, onProgress) {
  const startedAt = recording.startedAt.getTime();
  try {
    await finishSpeakers(recording);
    recording.calendar ||= await lookUpCalendarEvent(recording);
    onProgress("Writing notes…");
    const notionOnly = settings.notesDestination === "notion";
    const attendees = recording.calendar?.attendees || [];
    const result = await processMeeting({
      ...recording,
      title: recording.calendar?.title || "",
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
    // Calls that only go to Notion still get a copy on this Mac, so the Meetings page can show them.
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
  writeText: (text) => clipboard.writeText(text),
  readText: () => clipboard.readText(),
  restore(snapshot) {
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

async function transcribeDictation(samples) {
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
      if (!settings.openRouterKey) return "Editing by voice needs an OpenRouter key in Settings";
      return null;
    },
  });
  hotkeyHelper.on("escape", () => {
    if (askCard?.visible && !voiceAsk?.capturing && voiceAsk?.state === "idle") {
      prepAbort?.abort();
      askCard.hide();
    }
  });
  commandMode.on("result", ({ instruction, app }) => console.log(`Command mode in ${app || "unknown app"}: ${instruction}`));
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
      if (!settings.openRouterKey) return "Ask needs an OpenRouter key in Settings";
      return null;
    },
  });
  dictation.on("result", ({ text }) => {
    rebuildMenu();
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
  if (!settings.dictationEnabled && !settings.voiceAskEnabled && !settings.commandModeEnabled) {
    hotkeyHelper?.setHotkey(null);
    hotkeyHelper?.setHotkey(null, "ask");
    hotkeyHelper?.setHotkey(null, "command");
    await transcribers.keepWarm(null).catch((error) => console.error(error));
    publishDictationStatus();
    return;
  }
  const helper = ensureHotkeyHelper();
  helper.setHotkey(settings.dictationEnabled ? settings.dictationHotkey : null);
  helper.setHotkey(settings.voiceAskEnabled ? settings.askHotkey : null, "ask");
  helper.setHotkey(settings.commandModeEnabled ? settings.commandHotkey : null, "command");
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
      const wantsVoice = source === "system" && voiceEmbedder && recording.speakerTracker && seconds >= 1;
      const [rawText, embedding] = await Promise.all([
        liveTranscriber.transcribe(samples),
        wantsVoice ? voiceEmbedder.embed(samples).catch(() => null) : null,
      ]);
      const text = applyDictionary(rawText.trim(), settings.dictionaryEntries);
      if (!text) return;
      const zoomSpeaker =
        source === "system" ? zoomObserver?.resolveSpeaker({ startedAt, endedAt }) : null;
      let voiceLabel = null;
      if (embedding && zoomSpeaker) {
        const voice = recording.zoomVoices.get(zoomSpeaker) || { sum: new Array(embedding.length).fill(0), seconds: 0 };
        const print = normalize(embedding);
        voice.sum = voice.sum.map((value, index) => value + print[index] * seconds);
        voice.seconds += seconds;
        recording.zoomVoices.set(zoomSpeaker, voice);
      } else if (embedding) {
        voiceLabel = recording.speakerTracker.add(embedding, seconds);
      }
      const segment = {
        text,
        source,
        speaker:
          voiceLabel ||
          segmentSpeaker({
            source,
            configuredSpeakerName: recording.speakerName,
            zoomSpeaker,
          }),
        voiceLabel,
        timestamp: formatElapsed(recording.startedAt, startedAt),
      };
      recording.transcriptSegments.push(segment);
      recorderWindow?.webContents.send("meeting:transcript", segment);
      scheduleLiveSummary();
    });
    await recording.transcriptionQueue;
    return true;
  },
);

// What you type in "Your notes" during a call; expanded with the transcript when it ends.
ipcMain.handle("meeting:user-notes", async (_event, text) => {
  if (!currentRecording) return false;
  currentRecording.userNotes = String(text || "").slice(0, 20000);
  return true;
});

ipcMain.handle("app:start-recording", async () => {
  zoomAutoRecording?.manualStartRequested();
  return startRecording({ origin: "manual" });
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
ipcMain.handle("onboarding:finish", async () => {
  await settingsStore.save({ onboardingCompleted: true });
  await refreshRuntimeSettings();
  onboardingWindow?.close();
  showControlsWindow();
  return true;
});
ipcMain.handle("settings:open", async () => showSettingsWindow());
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
    ...publicSettings
  } = settings;
  return {
    ...settingsStore.publicState(),
    ...publicSettings,
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
      return { ...settingsStore.publicState(), launchAtLogin: app.getLoginItemSettings().openAtLogin, transcriptionModels };
    }
  }
  if (phase !== "idle") throw new Error("Stop the current recording before changing settings.");
  const sameKey = (left, right) =>
    left && right && left.keyCode === right.keyCode && [...left.modifiers].sort().join() === [...right.modifiers].sort().join();
  const shortcuts = { dictationHotkey: settings.dictationHotkey, askHotkey: settings.askHotkey, commandHotkey: settings.commandHotkey };
  for (const name of Object.keys(shortcuts)) {
    if (!update[name]) continue;
    const next = normalizeHotkey(update[name]);
    if (Object.entries(shortcuts).some(([other, current]) => other !== name && sameKey(next, current))) {
      throw new Error("Dictation, Ask and editing by voice each need their own shortcut.");
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
  return { ...state, launchAtLogin: app.getLoginItemSettings().openAtLogin, transcriptionModels };
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
  libraryChanged();
  return true;
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
function knowledgeFor(query, limit = 6) {
  if (!settings.knowledgeEnabled || !settings.knowledgeFolders?.length || !knowledgeBase) return { text: "", sources: {} };
  return knowledgeBlock(knowledgeBase.search(query, { limit }));
}

// Answers a question about past meetings, streaming the reply through onDelta.
async function answerQuestion({ question, history = [], scope = { kind: "all" }, signal, onDelta }) {
  const text = String(question || "").trim().slice(0, 2000);
  if (!text) throw new Error("Type a question first.");
  if (!settings.openRouterKey) throw new Error("Ask uses your OpenRouter model. Add a key in Settings → AI notes.");
  const meetings = await library.corpus(await askScopeIds(scope));
  const knowledge = knowledgeFor(text);
  if (!meetings.length && !knowledge.text) {
    throw new Error(scope?.kind === "meeting" ? "This meeting has no notes on this Mac to ask about." : "There are no meeting notes here to ask about yet.");
  }
  const answer = await streamCompletion({
    key: settings.openRouterKey,
    model: settings.openRouterModel,
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
  if (!settings.openRouterKey) throw new Error("Live help uses your OpenRouter model. Add a key in Settings → AI notes.");
  const transcript = transcriptText(recording);
  const knowledge = knowledgeFor(`${text}\n${transcript.slice(-800)}`);
  const corpus = await library.corpus();
  const attendees = recording.calendar?.attendees || [];
  const series = recording.calendar?.recurring ? seriesMeetings(corpus, { ...recording.calendar, start: recording.startedAt.getTime() }) : [];
  const withPeople = attendees.length ? pastMeetingsWith(corpus, attendees, { before: recording.startedAt.getTime(), limit: 3 }) : [];
  const earlier = [...series, ...withPeople.filter((meeting) => !series.includes(meeting))].slice(0, 4);
  const answer = await streamCompletion({
    key: settings.openRouterKey,
    model: settings.openRouterModel,
    messages: liveHelpMessages({
      question: text,
      transcript,
      notes: recording.liveAnalysis || null,
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
  if (!settings.openRouterKey) throw new Error("Drafts use your OpenRouter model. Add a key in Settings → AI notes.");
  const meeting = await library.get(String(id));
  if (!meeting.hasNote) throw new Error("This call has no notes on this Mac to draft from.");
  const controller = new AbortController();
  askRequests.set(requestId, controller);
  try {
    const text = await streamCompletion({
      key: settings.openRouterKey,
      model: settings.openRouterModel,
      messages: followUpMessages({
        meeting,
        kind: FOLLOW_UP_KINDS.includes(kind) ? kind : "email",
        speakerName: settings.speakerName,
        vocabulary: settings.vocabulary,
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
// Opens a cited document, only from your knowledge base folders.
async function openKnowledgeFile(file) {
  const resolved = path.resolve(String(file || ""));
  const inside = (settings.knowledgeFolders || []).some((folder) => resolved.startsWith(path.resolve(folder) + path.sep));
  if (!inside) throw new Error("That file isn't in your knowledge base.");
  await shell.openPath(resolved);
}
ipcMain.handle("knowledge:open", async (_event, file) => openKnowledgeFile(file));
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
ipcMain.handle("notion:status", async () =>
  notionConnect.status(settings.notionDataSourceId, settings.notionDatabaseName),
);
ipcMain.handle("notion:connect", async (_event, method) => {
  const chosen = method === "composio" ? "composio" : "cli";
  const account = await notionConnect.connect(chosen);
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
    },
  });
  zoomObserver.start();
  voiceBank = new VoiceBank(path.join(app.getPath("userData"), "voices.json"));
  calendarReader = new CalendarReader(calendarHelperPath(app));
  knowledgeBase = new KnowledgeBase({ indexPath: path.join(app.getPath("userData"), "knowledge", "index.json"), pdfHelper: extractHelperPath() });
  await knowledgeBase.load();
  digestStore = new DigestStore(path.join(app.getPath("userData"), "digests"));
  usageStats = new UsageStats(path.join(app.getPath("userData"), "stats.json"));
  await refreshRuntimeSettings();
  retryPendingNotionSaves();
  app.dock?.hide();
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
});

app.on("before-quit", () => {
  zoomAutoRecording?.destroy();
  zoomObserver?.stop();
  isQuitting = true;
  clearTimeout(liveSummaryTimer);
  hotkeyHelper?.stop();
  void voiceEmbedder?.stop();
  dictationOverlay?.destroy();
  askCard?.destroy();
  void transcribers.stopAll();
});
app.on("window-all-closed", () => {});
app.on("activate", () => {
  rebuildMenu();
  showControlsWindow();
});
