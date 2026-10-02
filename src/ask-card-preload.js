const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("askCard", {
  onState: (handler) => ipcRenderer.on("ask-card:state", (_event, state) => handler(state)),
  close: () => ipcRenderer.send("ask-card:close"),
  openMeeting: (id) => ipcRenderer.send("ask-card:open-meeting", id),
  join: () => ipcRenderer.send("ask-card:join"),
  openSource: (id) => ipcRenderer.send("ask-card:open-source", id),
  resize: (height) => ipcRenderer.send("ask-card:resize", height),
});
