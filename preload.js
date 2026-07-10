const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('localllm', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
});
