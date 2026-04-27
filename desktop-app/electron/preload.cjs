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

contextBridge.exposeInMainWorld("menuBridge", {
  // Subscribe to menu/shortcut events from the main process. Returns an
  // unsubscribe function.
  onMenuEvent: (cb) => {
    const handler = (_e, evt) => { try { cb(evt); } catch { /* ignore */ } };
    ipcRenderer.on("menu-event", handler);
    return () => ipcRenderer.removeListener("menu-event", handler);
  },
});

contextBridge.exposeInMainWorld("shellBridge", {
  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
});
