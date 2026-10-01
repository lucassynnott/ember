const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("meetingRecorder", {
  appendChunk: (chunk) => ipcRenderer.invoke("recording:append-chunk", chunk),
  appendLivePcm: (chunk) => ipcRenderer.invoke("transcription:append-pcm", chunk),
  startAppRecording: () => ipcRenderer.invoke("app:start-recording"),
  stopAppRecording: () => ipcRenderer.invoke("app:stop-recording"),
  hideControls: () => ipcRenderer.invoke("app:hide-controls"),
  requestPermissions: () => ipcRenderer.invoke("permissions:request"),
  openSettings: () => ipcRenderer.invoke("settings:open"),
  openNotesFolder: () => ipcRenderer.invoke("notes:open-folder"),
  openNote: (notePath) => ipcRenderer.invoke("notes:open-note", notePath),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  chooseNotesFolder: () => ipcRenderer.invoke("settings:choose-notes-folder"),
  getOpenRouterModels: () => ipcRenderer.invoke("openrouter:list-models"),
  listModels: () => ipcRenderer.invoke("models:list"),
  notionStatus: () => ipcRenderer.invoke("notion:status"),
  notionConnect: (method) => ipcRenderer.invoke("notion:connect", method),
  notionCancel: () => ipcRenderer.invoke("notion:cancel"),
  notionSearch: (query) => ipcRenderer.invoke("notion:search", query),
  notionUseDatabase: (database) => ipcRenderer.invoke("notion:use-database", database),
  notionCreateDatabase: (parentPageId) => ipcRenderer.invoke("notion:create-database", parentPageId),
  notionDisconnect: () => ipcRenderer.invoke("notion:disconnect"),
  onNotionProgress: (handler) => {
    ipcRenderer.on("notion:progress", (_event, progress) => handler(progress));
  },
  updateStatus: () => ipcRenderer.invoke("updates:status"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  onUpdateState: (handler) => {
    ipcRenderer.on("updates:state", (_event, state) => handler(state));
  },
  getDictationStatus: () => ipcRenderer.invoke("dictation:status"),
  captureHotkey: () => ipcRenderer.invoke("dictation:capture-hotkey"),
  cancelHotkeyCapture: () => ipcRenderer.invoke("dictation:cancel-capture"),
  onDictationStatus: (handler) => {
    ipcRenderer.on("dictation:status", (_event, status) => handler(status));
  },
  installModel: (id) => ipcRenderer.invoke("models:install", id),
  cancelModelInstall: (id) => ipcRenderer.invoke("models:cancel", id),
  removeModel: (id) => ipcRenderer.invoke("models:remove", id),
  selectModel: (id) => ipcRenderer.invoke("models:select", id),
  onModelProgress: (handler) => {
    ipcRenderer.on("models:progress", (_event, progress) => handler(progress));
  },
  onModelsChanged: (handler) => {
    ipcRenderer.on("models:changed", (_event, state) => handler(state));
  },
  onPermissionState: (handler) => {
    ipcRenderer.on("permissions:state", (_event, state) => handler(state));
  },
  onZoomState: (handler) => {
    ipcRenderer.on("zoom:state", (_event, state) => handler(state));
  },
  onZoomAutoRecordingState: (handler) => {
    ipcRenderer.on("zoom:auto-recording-state", (_event, state) => handler(state));
  },
  onState: (handler) => {
    ipcRenderer.on("app:state", (_event, state) => handler(state));
  },
  onMeetingReset: (handler) => {
    ipcRenderer.on("meeting:reset", () => handler());
  },
  onTranscript: (handler) => {
    ipcRenderer.on("meeting:transcript", (_event, segment) => handler(segment));
  },
  onMeetingSaved: (handler) => {
    ipcRenderer.on("meeting:saved", (_event, saved) => handler(saved));
  },
  onAnalysis: (handler) => {
    ipcRenderer.on("meeting:analysis", (_event, analysis) => handler(analysis));
  },
  completeCommand: (id, result) => ipcRenderer.send("recorder:command-result", { id, result }),
  failCommand: (id, error) =>
    ipcRenderer.send("recorder:command-result", {
      id,
      error: error instanceof Error ? error.message : String(error),
    }),
  onCommand: (handler) => {
    ipcRenderer.on("recorder:command", (_event, command) => handler(command));
  },
});
