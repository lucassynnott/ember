const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clipboardPicker", {
  platform: process.platform,
  onOpen: (handler) => ipcRenderer.on("clipboard-picker:open", (_event, state) => handler(state)),
  onChanged: (handler) => {
    const listener = () => handler();
    ipcRenderer.on("clipboard:changed", listener);
    return () => ipcRenderer.removeListener("clipboard:changed", listener);
  },
  list: (query, kind) => ipcRenderer.invoke("clipboard:list", query, kind),
  pin: (id, pinned) => ipcRenderer.invoke("clipboard:pin", id, pinned),
  remove: (id) => ipcRenderer.invoke("clipboard:remove", id),
  choose: (id, how) => ipcRenderer.send("clipboard-picker:choose", id, how),
  openPage: () => ipcRenderer.send("clipboard-picker:open-page"),
  close: () => ipcRenderer.send("clipboard-picker:close"),
});
