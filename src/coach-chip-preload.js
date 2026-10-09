const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("coachChip", {
  state: () => ipcRenderer.invoke("coach-chip:state"),
  onState: (handler) => ipcRenderer.on("coach-chip:state", (_event, state) => handler(state)),
  resize: (height) => ipcRenderer.send("coach-chip:resize", height),
  action: (name, value) => ipcRenderer.send("coach-chip:action", name, value),
});
