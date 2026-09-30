const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  session,
  shell,
  systemPreferences,
  Tray,
} = require("electron");
const { allocateMeetingPaths } = require("./note");
const { getSettings, loadEnvironment, modelCandidates } = require("./config");
const { LiveParakeetTranscriber } = require("./live-transcription");
const { LivePhononTranscriber } = require("./phonon-transcription");
const { NotionSync } = require("./notion-sync");
const { processMeeting } = require("./process-meeting");
const { SettingsStore } = require("./settings-store");
const { summarizeTranscript } = require("./summary");
const { detectTranscriptionModels } = require("./transcription-models");
const { segmentSpeaker, ZoomAccessibilityObserver } = require("./zoom-accessibility");
const { ZoomAutoRecordingController } = require("./zoom-auto-recording");
const { createTrayImage } = require("./tray-icon");

const commandWaiters = new Map();
let tray;
let recorderWindow;
let settingsWindow;
let settingsStore;
let settings;
let transcriptionModels = [];
let phase = "idle";
let statusMessage = "Ready";
let currentRecording = null;
let liveTranscriber = null;
let notionSync = null;
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

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
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
    width: 700,
    height: 760,
    minWidth: 620,
    minHeight: 650,
    show: false,
    title: "Meeting Notes Settings",
    backgroundColor: "#171717",
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
  await settingsWindow.loadFile(path.join(__dirname, "settings.html"));
}

function publishPermissionState() {
  recorderWindow?.webContents.send("permissions:state", permissionState);
}

function publishZoomState() {
  recorderWindow?.webContents.send("zoom:state", zoomState);
}
function publishZoomAutomationState(state = zoomAutoRecording?.snapshot()) {
  if (state) recorderWindow?.webContents.send("zoom:auto-recording-state", state);
}

function accessibilityStatus(prompt = false) {
  return systemPreferences.isTrustedAccessibilityClient(prompt) ? "granted" : "not-granted";
}

function syncZoomObserver(accessibility) {
  if (accessibility === "granted") zoomObserver?.start();
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
  tray.setTitle(phase === "recording" ? " REC" : " MN");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: statusMessage, enabled: false },
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
      { label: "Show Live Notes", click: () => showControlsWindow() },
      { label: "Settings…", click: () => void showSettingsWindow() },
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
        enabled: phase !== "processing",
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

function saveMeetingToNotion(recording, result) {
  if (!notionSync?.enabled()) return;
  notionSync
    .saveMeeting({
      startedAt: recording.startedAt,
      endedAt: recording.endedAt,
      origin: recording.origin,
      transcript: result.transcript,
      analysis: result.analysis,
      notePath: result.notePath,
      audioPath: result.audioPath,
    })
    .then((page) => {
      if (!page.skipped && !page.duplicate) notify("Saved to Notion", "Call Transcripts");
      retryPendingNotionSaves();
    })
    .catch((error) => {
      console.error("Notion sync failed:", error);
      notify("Notion save failed — will retry", error.message);
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
    if (transcriptionModel.type === "phonon") {
      setStatus("starting", "Loading Phonon-2…");
      liveTranscriber = new LivePhononTranscriber({ binaryPath: transcriptionModel.path });
      await liveTranscriber.start();
    } else if (transcriptionModel.type === "parakeet") {
      setStatus("starting", "Loading Parakeet v3…");
      liveTranscriber = new LiveParakeetTranscriber({ app, modelPath: transcriptionModel.path });
      await liveTranscriber.start();
    }

    const startedAt = new Date();
    const paths = await allocateMeetingPaths(settings.notesDir, startedAt);
    const stream = fs.createWriteStream(paths.audioPath, { flags: "wx", mode: 0o600 });
    await waitForStreamOpen(stream);
    recording = {
      origin,
      ...paths,
      startedAt,
      stream,
      transcriptionModel,
      speakerName: settings.speakerName,
      transcriptSegments: [],
      transcriptionQueue: Promise.resolve(),
    };
    currentRecording = recording;
    recorderWindow.webContents.send("meeting:reset");

    await sendRecorderCommand("start", {
      microphoneLabel: settings.microphoneLabel,
      mappedSystemOutputLabel: settings.mappedSystemOutputLabel,
    });
    setStatus("recording", `Recording with ${transcriptionModel.label}`);
    notify(
      origin === "zoom-auto" ? "Zoom meeting detected" : "Meeting Notes",
      origin === "zoom-auto"
        ? "Recording and live transcription started automatically."
        : "Recording and live transcription started.",
    );
    return true;
  } catch (error) {
    if (recording?.stream) recording.stream.destroy();
    if (recording?.audioPath) await fsp.rm(recording.audioPath, { force: true });
    await liveTranscriber?.stop();
    liveTranscriber = null;
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

async function stopRecording({ reason = "manual" } = {}) {
  if (phase !== "recording" || !currentRecording) return false;
  if (reason === "manual") zoomAutoRecording?.manualStopRequested();
  const recording = currentRecording;
  setStatus("stopping", "Finishing live transcript…");
  if (reason === "zoom-auto") {
    notify("Zoom meeting ended", "Recording stopped automatically. Finalizing notes…");
  }
  clearTimeout(liveSummaryTimer);
  liveSummaryTimer = null;

  try {
    await sendRecorderCommand("stop");
    await recording.transcriptionQueue;
    await liveTranscriber?.stop();
    liveTranscriber = null;
    await closeStream(recording.stream);
    recording.endedAt = new Date();

    setStatus("processing", "Generating final notes…");
    const result = await processMeeting({
      ...recording,
      transcript: transcriptText(recording),
      transcriptionProvider:
        recording.transcriptionModel.realtime
          ? recording.transcriptionModel.label
          : undefined,
      settings,
      onProgress: (message) => setStatus("processing", message),
    });
    recorderWindow.webContents.send("meeting:analysis", result.analysis);
    currentRecording = null;
    setStatus("idle", "Ready");
    notify("Meeting notes saved", result.notePath);
    saveMeetingToNotion(recording, result);
    return true;
  } catch (error) {
    if (!recording.stream.closed) recording.stream.destroy();
    await liveTranscriber?.stop();
    liveTranscriber = null;
    currentRecording = null;
    setStatus("idle", "Ready — processing failed; audio was kept");
    await dialog.showMessageBox({
      type: "error",
      title: "Meeting processing failed",
      message: error.message,
      detail: `The source audio is safe at:\n${recording.audioPath}`,
    });
    return false;
  } finally {
    if (quitAfterProcessing) {
      isQuitting = true;
      app.quit();
    }
  }
}

async function quitGracefully() {
  if (phase === "recording") {
    quitAfterProcessing = true;
    await stopRecording({ reason: "quit" });
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
    width: 1120,
    height: 780,
    minWidth: 760,
    minHeight: 620,
    show: false,
    resizable: true,
    backgroundColor: "#171717",
    title: "Meeting Notes",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await recorderWindow.loadFile(path.join(__dirname, "recorder.html"));
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
  transcriptionModels = await detectTranscriptionModels(modelCandidates());
  const persisted = settingsStore.runtime();
  if (!persisted.transcriptionModelId && transcriptionModels.length) {
    persisted.transcriptionModelId =
      transcriptionModels.find((model) => model.realtime)?.id || transcriptionModels[0].id;
  }
  settings = getSettings(persisted);
  await fsp.mkdir(settings.notesDir, { recursive: true, mode: 0o700 });
  rebuildMenu();
  zoomAutoRecording?.settingsChanged();
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
    recording.transcriptionQueue = recording.transcriptionQueue.then(async () => {
      const text = (await liveTranscriber.transcribe(samples)).trim();
      if (!text) return;
      const zoomSpeaker =
        source === "system" ? zoomObserver?.resolveSpeaker({ startedAt, endedAt }) : null;
      const segment = {
        text,
        source,
        speaker: segmentSpeaker({
          source,
          configuredSpeakerName: recording.speakerName,
          zoomSpeaker,
        }),
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

ipcMain.handle("app:start-recording", async () => {
  zoomAutoRecording?.manualStartRequested();
  return startRecording({ origin: "manual" });
});
ipcMain.handle("app:stop-recording", async () => stopRecording({ reason: "manual" }));
ipcMain.handle("app:hide-controls", () => recorderWindow?.hide());
ipcMain.handle("permissions:request", async () => requestRequiredPermissions({ showResult: true }));
ipcMain.handle("settings:open", async () => showSettingsWindow());
ipcMain.handle("notes:open-folder", async () => shell.openPath(settings.notesDir));
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
    transcriptionModels,
  };
});
ipcMain.handle("settings:choose-notes-folder", async () => {
  const result = await dialog.showOpenDialog(settingsWindow || recorderWindow, {
    title: "Choose where Meeting Notes are saved",
    defaultPath: settings.notesDir,
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle("settings:save", async (_event, update) => {
  if (phase !== "idle") throw new Error("Stop the current recording before changing settings.");
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
  const state = await settingsStore.save(update);
  await refreshRuntimeSettings();
  return { ...state, transcriptionModels };
});
ipcMain.handle("openrouter:list-models", async () => listOpenRouterModels());

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
  loadEnvironment(app.getAppPath());
  const environmentSettings = getSettings();
  settingsStore = new SettingsStore({
    filePath: path.join(app.getPath("userData"), "settings.json"),
    safeStorage,
    defaults: environmentSettings,
  });
  await settingsStore.load();
  notionSync = new NotionSync({
    ledgerPath: path.join(app.getPath("userData"), "notion-sync.json"),
    getSettings: () => settings || {},
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
  });
  await refreshRuntimeSettings();
  retryPendingNotionSaves();
  app.dock?.hide();
  await createRecorderWindow();
  tray = new Tray(createTrayImage(nativeImage));
  tray.setToolTip("Meeting Notes");
  rebuildMenu();
  showControlsWindow();
  setTimeout(() => void requestRequiredPermissions({ showResult: false }), 600);
  console.log(
    `Meeting Notes ready: microphone=${settings.microphoneLabel}, system=${settings.mappedSystemOutputLabel}`,
  );
});

app.on("before-quit", () => {
  zoomAutoRecording?.destroy();
  zoomObserver?.stop();
  isQuitting = true;
  clearTimeout(liveSummaryTimer);
  liveTranscriber?.stop();
});
app.on("window-all-closed", () => {});
app.on("activate", () => {
  rebuildMenu();
  showControlsWindow();
});
