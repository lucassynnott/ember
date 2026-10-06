const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("shareGuide", {
  state: () => ipcRenderer.invoke("guide:state"),
  action: (action) => ipcRenderer.send("guide:action", action),
  resize: (height) => ipcRenderer.send("guide:resize", height),
  onState: (handler) => {
    const listener = (_event, state) => handler(state);
    ipcRenderer.on("guide:state", listener);
    return () => ipcRenderer.removeListener("guide:state", listener);
  },
});
