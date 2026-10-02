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
  listMeetings: () => ipcRenderer.invoke("library:list"),
  searchMeetings: (query) => ipcRenderer.invoke("library:search", query),
  getMeeting: (id) => ipcRenderer.invoke("library:get", id),
  updateMeeting: (id, changes) => ipcRenderer.invoke("library:update", id, changes),
  removeMeeting: (id) => ipcRenderer.invoke("library:remove", id),
  createFolder: (name) => ipcRenderer.invoke("library:create-folder", name),
  renameFolder: (id, name) => ipcRenderer.invoke("library:rename-folder", id, name),
  deleteFolder: (id) => ipcRenderer.invoke("library:delete-folder", id),
  openMeetingNote: (id) => ipcRenderer.invoke("library:open-note", id),
  revealMeeting: (id, kind) => ipcRenderer.invoke("library:reveal", id, kind),
  askMeetings: (requestId, request) => ipcRenderer.invoke("ask:start", requestId, request),
  cancelAsk: (requestId) => ipcRenderer.invoke("ask:cancel", requestId),
  onAskDelta: (handler) => {
    ipcRenderer.on("ask:delta", (_event, delta) => handler(delta));
  },
  renameSpeaker: (id, from, to) => ipcRenderer.invoke("library:rename-speaker", id, from, to),
  speakerNames: () => ipcRenderer.invoke("voices:names"),
  voicesState: () => ipcRenderer.invoke("voices:state"),
  retryVoiceModel: () => ipcRenderer.invoke("voices:retry"),
  forgetVoice: (id) => ipcRenderer.invoke("voices:forget", id),
  onVoicesState: (handler) => {
    ipcRenderer.on("voices:state", (_event, state) => handler(state));
  },
  onRelabel: (handler) => {
    ipcRenderer.on("meeting:relabel", (_event, labels) => handler(labels));
  },
  onOpenMeeting: (handler) => {
    ipcRenderer.on("app:open-meeting", (_event, id) => handler(id));
  },
  onLibraryChanged: (handler) => {
    ipcRenderer.on("library:changed", () => handler());
  },
  getSettings: () => ipcRenderer.invoke("settings:get"),
  onboardingPermissions: () => ipcRenderer.invoke("onboarding:permissions"),
  requestPermission: (kind) => ipcRenderer.invoke("onboarding:request-permission", kind),
  suggestedName: () => ipcRenderer.invoke("onboarding:suggested-name"),
  finishOnboarding: () => ipcRenderer.invoke("onboarding:finish"),
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
