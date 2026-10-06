const { contextBridge, ipcRenderer } = require("electron");

const listen = (channel) => (handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("record", {
  sources: () => ipcRenderer.invoke("record:sources"),
  status: () => ipcRenderer.invoke("record:status"),
  start: (options) => ipcRenderer.invoke("record:start", options),
  camera: (options) => ipcRenderer.invoke("record:camera", options),
  cameraSize: (size) => ipcRenderer.send("record:camera-size", size),
  area: (rect) => ipcRenderer.send("record:area", rect),
  control: (command) => ipcRenderer.send("record:control", command),
  skipCount: () => ipcRenderer.send("record:skip-count"),
  close: () => ipcRenderer.send("record:close"),
  highlight: (windowId) => ipcRenderer.send("record:highlight", windowId),
  onState: listen("record:state"),
  onLevel: listen("record:level"),
  onCount: listen("record:count"),
  onCamera: listen("record:camera"),
  onStartNow: listen("record:start-now"),
  onError: listen("record:error"),
});
