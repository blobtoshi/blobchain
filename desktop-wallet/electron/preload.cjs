const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vaultBridge", {
  read: () => ipcRenderer.invoke("vault:read"),
  write: (json) => ipcRenderer.invoke("vault:write", json),
  clear: () => ipcRenderer.invoke("vault:clear"),
});

contextBridge.exposeInMainWorld("nodeConfigBridge", {
  read: () => ipcRenderer.invoke("nodes:read"),
  write: (json) => ipcRenderer.invoke("nodes:write", json),
});
