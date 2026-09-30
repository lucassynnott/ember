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
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  chooseNotesFolder: () => ipcRenderer.invoke("settings:choose-notes-folder"),
  getOpenRouterModels: () => ipcRenderer.invoke("openrouter:list-models"),
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
