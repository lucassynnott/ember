const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("meetingRecorder", {
  platform: process.platform,
  appendChunk: (chunk) => ipcRenderer.invoke("recording:append-chunk", chunk),
  appendLivePcm: (chunk) => ipcRenderer.invoke("transcription:append-pcm", chunk),
  startAppRecording: (options) => ipcRenderer.invoke("app:start-recording", options),
  stopAppRecording: () => ipcRenderer.invoke("app:stop-recording"),
  hideControls: () => ipcRenderer.invoke("app:hide-controls"),
  requestPermissions: () => ipcRenderer.invoke("permissions:request"),
  openSettings: (section) => ipcRenderer.invoke("settings:open", section),
  onSettingsChanged: (handler) => {
    ipcRenderer.on("settings:changed", (_event, state) => handler(state));
  },
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
  dictionarySuggestions: () => ipcRenderer.invoke("dictionary:suggestions"),
  answerDictionarySuggestion: (term, accepted) => ipcRenderer.invoke("dictionary:suggestion", term, accepted),
  onDictionarySuggestions: (handler) => {
    const listener = () => handler();
    ipcRenderer.on("dictionary:suggestions-changed", listener);
    return () => ipcRenderer.removeListener("dictionary:suggestions-changed", listener);
  },
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
  onVoiceNote: (handler) => {
    ipcRenderer.on("meeting:voice-note", (_event, note) => handler(note));
  },
  onRelabel: (handler) => {
    ipcRenderer.on("meeting:relabel", (_event, labels) => handler(labels));
  },
  setUserNotes: (text) => ipcRenderer.invoke("meeting:user-notes", text),
  installedApps: () => ipcRenderer.invoke("apps:installed"),
  dictationHistory: (query) => ipcRenderer.invoke("history:list", query),
  clipboardList: (query, kind) => ipcRenderer.invoke("clipboard:list", query, kind),
  clipboardPin: (id, pinned) => ipcRenderer.invoke("clipboard:pin", id, pinned),
  clipboardRemove: (id) => ipcRenderer.invoke("clipboard:remove", id),
  clipboardClear: (includePinned) => ipcRenderer.invoke("clipboard:clear", includePinned),
  clipboardCopy: (id) => ipcRenderer.invoke("clipboard:copy", id),
  grabText: (fromClipboard) => ipcRenderer.invoke("clipboard:grab", fromClipboard),
  onClipboardChanged: (handler) => {
    const listener = () => handler();
    ipcRenderer.on("clipboard:changed", listener);
    return () => ipcRenderer.removeListener("clipboard:changed", listener);
  },
  savedList: (filter) => ipcRenderer.invoke("saved:list", filter),
  savedBoards: () => ipcRenderer.invoke("saved:boards"),
  savedTags: () => ipcRenderer.invoke("saved:tags"),
  saveLink: (input, board) => ipcRenderer.invoke("saved:add", input, board),
  savedRetry: (id) => ipcRenderer.invoke("saved:retry", id),
  savedRemove: (id) => ipcRenderer.invoke("saved:remove", id),
  savedSetBoard: (id, board, included) => ipcRenderer.invoke("saved:set-board", id, board, included),
  savedSetTags: (id, tags) => ipcRenderer.invoke("saved:set-tags", id, tags),
  createBoard: (name) => ipcRenderer.invoke("saved:create-board", name),
  renameBoard: (id, name) => ipcRenderer.invoke("saved:rename-board", id, name),
  removeBoard: (id) => ipcRenderer.invoke("saved:remove-board", id),
  openSaved: (id) => ipcRenderer.invoke("saved:open", id),
  onSavedChanged: (handler) => {
    const listener = () => handler();
    ipcRenderer.on("saved:changed", listener);
    return () => ipcRenderer.removeListener("saved:changed", listener);
  },
  onOpenPage: (handler) => {
    ipcRenderer.on("app:open-page", (_event, page) => handler(page));
  },
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
  noteTemplates: () => ipcRenderer.invoke("templates:list"),
  setMeetingTemplate: (id) => ipcRenderer.invoke("meeting:template", id),
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
  connectWindowsTasks: () => ipcRenderer.invoke("tasks:connect-windows"),
  connectCalendar: (provider) => ipcRenderer.invoke("calendar:connect", provider),
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
  recordingsList: (query) => ipcRenderer.invoke("recordings:list", query),
  recordingGet: (id) => ipcRenderer.invoke("recordings:get", id),
  newScreenRecording: () => ipcRenderer.invoke("recordings:new"),
  importRecording: () => ipcRenderer.invoke("recordings:import"),
  openRecordingsFolder: () => ipcRenderer.invoke("recordings:open-folder"),
  recordingFolders: () => ipcRenderer.invoke("recordings:folders"),
  createRecordingFolder: (name, color) => ipcRenderer.invoke("recordings:folder-create", name, color),
  updateRecordingFolder: (id, changes) => ipcRenderer.invoke("recordings:folder-update", id, changes),
  deleteRecordingFolder: (id) => ipcRenderer.invoke("recordings:folder-delete", id),
  setRecordingFolder: (ids, folder) => ipcRenderer.invoke("recordings:set-folder", ids, folder),
  renameRecording: (id, title) => ipcRenderer.invoke("recordings:rename", id, title),
  removeRecording: (id) => ipcRenderer.invoke("recordings:remove", id),
  retryRecording: (id) => ipcRenderer.invoke("recordings:retry", id),
  revealRecording: (id) => ipcRenderer.invoke("recordings:reveal", id),
  copyRecordingFile: (id) => ipcRenderer.invoke("recordings:copy-file", id),
  exportRecording: (id) => ipcRenderer.invoke("recordings:export", id),
  loadRecordingEdit: (id) => ipcRenderer.invoke("recordings:edit-load", id),
  saveRecordingEdit: (id, project) => ipcRenderer.invoke("recordings:edit-save", id, project),
  exportRecordingEdit: (id, spec, extra) => ipcRenderer.invoke("recordings:edit-export", id, spec, extra),
  editorCursors: () => ipcRenderer.invoke("editor:cursors"),
  editorWallpapers: () => ipcRenderer.invoke("editor:wallpapers"),
  editorPick: (kind) => ipcRenderer.invoke("editor:pick", kind),
  editorPresets: () => ipcRenderer.invoke("editor:presets"),
  editorFonts: () => ipcRenderer.invoke("editor:fonts"),
  editorAddFont: (link, name) => ipcRenderer.invoke("editor:add-font", link, name),
  editorPeaks: (url) => ipcRenderer.invoke("editor:peaks", url),
  editorSavePreset: (name, style) => ipcRenderer.invoke("editor:save-preset", name, style),
  editorDeletePreset: (id) => ipcRenderer.invoke("editor:delete-preset", id),
  editorSaveDefaults: (style) => ipcRenderer.invoke("editor:save-defaults", style),
  editorSetAutoZooms: (on) => ipcRenderer.invoke("editor:set-auto-zooms", on),
  cancelRecordingExport: (id) => ipcRenderer.invoke("recordings:edit-cancel", id),
  discardRecordingEdit: (id) => ipcRenderer.invoke("recordings:edit-discard", id),
  showExportedFile: (file) => ipcRenderer.invoke("recordings:show-file", file),
  shareState: () => ipcRenderer.invoke("share:state"),
  shareConnect: () => ipcRenderer.invoke("share:connect"),
  shareCancel: () => ipcRenderer.invoke("share:cancel"),
  shareSetup: () => ipcRenderer.invoke("share:setup"),
  shareDisconnect: () => ipcRenderer.invoke("share:disconnect"),
  shareOpenCloudflare: (url) => ipcRenderer.invoke("share:open-cloudflare", url),
  onShareProgress: (handler) => {
    const listener = (_event, progress) => handler(progress);
    ipcRenderer.on("share:progress", listener);
    return () => ipcRenderer.removeListener("share:progress", listener);
  },
  shareRecording: (id, options) => ipcRenderer.invoke("recordings:share", id, options),
  cancelRecordingShare: (id) => ipcRenderer.invoke("recordings:share-cancel", id),
  updateRecordingShare: (id, options) => ipcRenderer.invoke("recordings:share-update", id, options),
  unshareRecording: (id) => ipcRenderer.invoke("recordings:unshare", id),
  openRecordingShare: (id) => ipcRenderer.invoke("recordings:open-share", id),
  onRecordingShare: (handler) => {
    const listener = (_event, progress) => handler(progress);
    ipcRenderer.on("recordings:share-progress", listener);
    return () => ipcRenderer.removeListener("recordings:share-progress", listener);
  },
  onRecordingExport: (handler) => {
    const listener = (_event, progress) => handler(progress);
    ipcRenderer.on("recordings:export-progress", listener);
    return () => ipcRenderer.removeListener("recordings:export-progress", listener);
  },
  onRecordingsChanged: (handler) => {
    const listener = () => handler();
    ipcRenderer.on("recordings:changed", listener);
    return () => ipcRenderer.removeListener("recordings:changed", listener);
  },
  onOpenRecording: (handler) => {
    ipcRenderer.on("app:open-recording", (_event, id, edit, share) => handler(id, Boolean(edit), Boolean(share)));
  },
  // Ember Drive
  driveStatus: () => ipcRenderer.invoke("drive:status"),
  driveRequest: (cmd, args) => ipcRenderer.invoke("drive:request", cmd, args),
  driveSetupCloudflare: (options) => ipcRenderer.invoke("drive:setup-cloudflare", options),
  driveCloudflareAccounts: () => ipcRenderer.invoke("drive:cloudflare-accounts"),
  driveBackupNow: () => ipcRenderer.invoke("drive:backup-now"),
  driveCopyLink: (key) => ipcRenderer.invoke("drive:copy-link", key),
  driveShareVideo: (key) => ipcRenderer.invoke("drive:share-video", key),
  driveHideSearch: () => ipcRenderer.invoke("drive:hide-search"),
  driveOpenSearch: () => ipcRenderer.invoke("drive:open-search"),
  driveOpenExtensionSettings: () => ipcRenderer.invoke("drive:open-extension-settings"),
  driveRemoveGhost: () => ipcRenderer.invoke("drive:remove-ghost"),
  driveOpenGuide: (url) => ipcRenderer.invoke("drive:open-guide", url),
  onDriveStatus: (handler) => {
    const listener = (_event, status) => handler(status);
    ipcRenderer.on("drive:status", listener);
    return () => ipcRenderer.removeListener("drive:status", listener);
  },
  onDriveTest: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on("drive:test", listener);
    return () => ipcRenderer.removeListener("drive:test", listener);
  },
  onDriveSetupProgress: (handler) => {
    const listener = (_event, message) => handler(message);
    ipcRenderer.on("drive:setup-progress", listener);
    return () => ipcRenderer.removeListener("drive:setup-progress", listener);
  },
  onDriveSearchOpen: (handler) => {
    const listener = () => handler();
    ipcRenderer.on("drive:search-open", listener);
    return () => ipcRenderer.removeListener("drive:search-open", listener);
  },
  getSettings: () => ipcRenderer.invoke("settings:get"),
  onboardingPermissions: () => ipcRenderer.invoke("onboarding:permissions"),
  requestPermission: (kind) => ipcRenderer.invoke("onboarding:request-permission", kind),
  suggestedName: () => ipcRenderer.invoke("onboarding:suggested-name"),
  finishOnboarding: () => ipcRenderer.invoke("onboarding:finish"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  chooseNotesFolder: () => ipcRenderer.invoke("settings:choose-notes-folder"),
  openLoginItems: () => ipcRenderer.invoke("settings:open-login-items"),
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
