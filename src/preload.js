const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("meetingRecorder", {
  appendChunk: (chunk) => ipcRenderer.invoke("recording:append-chunk", chunk),
  appendLivePcm: (chunk) => ipcRenderer.invoke("transcription:append-pcm", chunk),
  startAppRecording: (options) => ipcRenderer.invoke("app:start-recording", options),
  stopAppRecording: () => ipcRenderer.invoke("app:stop-recording"),
  hideControls: () => ipcRenderer.invoke("app:hide-controls"),
  requestPermissions: () => ipcRenderer.invoke("permissions:request"),
  openSettings: (section) => ipcRenderer.invoke("settings:open", section),
  onSettingsSection: (handler) => {
    ipcRenderer.on("settings:section", (_event, section) => handler(section));
  },
  openNotesFolder: () => ipcRenderer.invoke("notes:open-folder"),
  openNote: (notePath) => ipcRenderer.invoke("notes:open-note", notePath),
  listMeetings: () => ipcRenderer.invoke("library:list"),
  searchMeetings: (query) => ipcRenderer.invoke("library:search", query),
  getMeeting: (id) => ipcRenderer.invoke("library:get", id),
  actionItems: () => ipcRenderer.invoke("actions:list"),
  setActionDone: (id, index, done) => ipcRenderer.invoke("actions:set", id, index, done),
  coachStats: (id) => ipcRenderer.invoke("coach:get", id),
  coachWeek: () => ipcRenderer.invoke("coach:week"),
  updateMeeting: (id, changes) => ipcRenderer.invoke("library:update", id, changes),
  removeMeeting: (id) => ipcRenderer.invoke("library:remove", id),
  createFolder: (name) => ipcRenderer.invoke("library:create-folder", name),
  renameFolder: (id, name) => ipcRenderer.invoke("library:rename-folder", id, name),
  deleteFolder: (id) => ipcRenderer.invoke("library:delete-folder", id),
  openMeetingNote: (id) => ipcRenderer.invoke("library:open-note", id),
  revealMeeting: (id, kind) => ipcRenderer.invoke("library:reveal", id, kind),
  askMeetings: (requestId, request) => ipcRenderer.invoke("ask:start", requestId, request),
  cancelAsk: (requestId) => ipcRenderer.invoke("ask:cancel", requestId),
  draftFollowUp: (requestId, id, kind) => ipcRenderer.invoke("follow-up:draft", requestId, id, kind),
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
  onSlides: (handler) => {
    ipcRenderer.on("meeting:slides", (_event, slides) => handler(slides));
  },
  onJobs: (handler) => {
    ipcRenderer.on("meeting:jobs", (_event, jobs) => handler(jobs));
  },
  onRelabel: (handler) => {
    ipcRenderer.on("meeting:relabel", (_event, labels) => handler(labels));
  },
  setUserNotes: (text) => ipcRenderer.invoke("meeting:user-notes", text),
  installedApps: () => ipcRenderer.invoke("apps:installed"),
  dictationHistory: (query) => ipcRenderer.invoke("history:list", query),
  copyDictation: (id) => ipcRenderer.invoke("history:copy", id),
  removeDictation: (id) => ipcRenderer.invoke("history:remove", id),
  clearDictationHistory: () => ipcRenderer.invoke("history:clear"),
  onHistoryChanged: (handler) => {
    ipcRenderer.on("history:changed", () => handler());
  },
  liveHelp: (requestId, request) => ipcRenderer.invoke("live:ask", requestId, request),
  knowledgeState: () => ipcRenderer.invoke("knowledge:state"),
  addKnowledgeFolder: () => ipcRenderer.invoke("knowledge:add-folder"),
  removeKnowledgeFolder: (folder) => ipcRenderer.invoke("knowledge:remove-folder", folder),
  reindexKnowledge: () => ipcRenderer.invoke("knowledge:reindex"),
  knowledgeSources: () => ipcRenderer.invoke("knowledge:sources"),
  addKnowledgeSource: (source) => ipcRenderer.invoke("knowledge:add-source", source),
  updateKnowledgeSource: (id, changes) => ipcRenderer.invoke("knowledge:update-source", id, changes),
  removeKnowledgeSource: (id) => ipcRenderer.invoke("knowledge:remove-source", id),
  signInKnowledgeSource: (id) => ipcRenderer.invoke("knowledge:sign-in-source", id),
  testKnowledgeSources: (query) => ipcRenderer.invoke("knowledge:test-source", query),
  startPractice: () => ipcRenderer.invoke("practice:start"),
  stopPractice: () => ipcRenderer.invoke("practice:stop"),
  cancelPractice: () => ipcRenderer.invoke("practice:cancel"),
  integrations: () => ipcRenderer.invoke("integrations:state"),
  setIntegrationMode: (mode) => ipcRenderer.invoke("integrations:set-mode", mode),
  connectIntegration: (toolkit) => ipcRenderer.invoke("integrations:connect", toolkit),
  cancelIntegration: () => ipcRenderer.invoke("integrations:cancel"),
  disconnectIntegration: (toolkit) => ipcRenderer.invoke("integrations:disconnect", toolkit),
  integrationOptions: (kind, query) => ipcRenderer.invoke("integrations:options", kind, query),
  chooseIntegration: (kind, choice) => ipcRenderer.invoke("integrations:choose", kind, choice),
  setAutoSend: (options) => ipcRenderer.invoke("integrations:auto-send", options),
  sentActions: () => ipcRenderer.invoke("integrations:sent"),
  openSentLink: (url) => ipcRenderer.invoke("integrations:open", url),
  sendAction: (meetingId, index, destination) => ipcRenderer.invoke("integrations:send", meetingId, index, destination),
  onIntegrationProgress: (handler) => {
    ipcRenderer.on("integrations:progress", (_event, progress) => handler(progress));
  },
  onIntegrationsChanged: (handler) => {
    ipcRenderer.on("integrations:changed", () => handler());
  },
  aiModels: () => ipcRenderer.invoke("ai-models:list"),
  installAiModel: (id) => ipcRenderer.invoke("ai-models:install", id),
  cancelAiModel: (id) => ipcRenderer.invoke("ai-models:cancel", id),
  removeAiModel: (id) => ipcRenderer.invoke("ai-models:remove", id),
  onAiModelProgress: (handler) => {
    ipcRenderer.on("ai-models:progress", (_event, progress) => handler(progress));
  },
  onAiModelsChanged: (handler) => {
    ipcRenderer.on("ai-models:changed", (_event, state) => handler(state));
  },
  connectState: () => ipcRenderer.invoke("connect:state"),
  installCli: () => ipcRenderer.invoke("connect:install-cli"),
  connectClient: (id, connect) => ipcRenderer.invoke("connect:client", id, connect),
  copyText: (text) => ipcRenderer.invoke("connect:copy", text),
  openKnowledgeFile: (file) => ipcRenderer.invoke("knowledge:open", file),
  onKnowledgeState: (handler) => {
    ipcRenderer.on("knowledge:state", (_event, state) => handler(state));
  },
  dashboard: () => ipcRenderer.invoke("dashboard:get"),
  calendarToday: () => ipcRenderer.invoke("calendar:today"),
  openCalendarLink: (link) => ipcRenderer.invoke("calendar:open-link", link),
  onDashboardChanged: (handler) => {
    ipcRenderer.on("dashboard:changed", () => handler());
  },
  listDigests: () => ipcRenderer.invoke("digests:list"),
  getDigest: (id) => ipcRenderer.invoke("digests:get", id),
  writeDigest: (requestId, id) => ipcRenderer.invoke("digests:write", requestId, id),
  onDigestsChanged: (handler) => {
    ipcRenderer.on("digests:changed", () => handler());
  },
  calendarStatus: () => ipcRenderer.invoke("calendar:status"),
  connectCalendar: () => ipcRenderer.invoke("calendar:connect"),
  openCalendarPrivacy: () => ipcRenderer.invoke("calendar:open-privacy"),
  onCalendar: (handler) => {
    ipcRenderer.on("meeting:calendar", (_event, event) => handler(event));
  },
  onNavigate: (handler) => {
    ipcRenderer.on("app:navigate", (_event, page) => handler(page));
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
