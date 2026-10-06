const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("windowsCapture", {
  desktopFrame: () => ipcRenderer.invoke("windows-capture:desktop-frame"),
  config: () => ipcRenderer.invoke("windows-capture:config"),
  chunk: (kind, bytes) => ipcRenderer.invoke("windows-capture:chunk", { kind, bytes }),
  event: (message) => ipcRenderer.send("windows-capture:event", message),
  command: (handler) => ipcRenderer.on("windows-capture:command", (_event, command) => handler(command)),
});
