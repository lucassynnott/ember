const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dictation", {
  onState: (handler) => ipcRenderer.on("overlay:state", (_event, state) => handler(state)),
  onCaptureStart: (handler) => ipcRenderer.on("capture:start", (_event, request) => handler(request)),
  onCaptureStop: (handler) => ipcRenderer.on("capture:stop", (_event, request) => handler(request)),
  onCaptureCancel: (handler) => ipcRenderer.on("capture:cancel", () => handler()),
  captureStarted: (id, error) => ipcRenderer.send("capture:started", { id, error }),
  captureStopped: (id, samples, error) => ipcRenderer.send("capture:stopped", { id, samples, error }),
});
