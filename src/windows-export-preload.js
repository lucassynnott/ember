const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('windowsExport', {
  config: () => ipcRenderer.invoke('windows-export:config'),
  frame: (index, bytes) => ipcRenderer.invoke('windows-export:frame', { index, bytes }),
  finish: () => ipcRenderer.invoke('windows-export:finish'),
  error: message => ipcRenderer.send('windows-export:error', String(message)),
});
