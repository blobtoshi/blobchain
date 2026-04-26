// Electron main process — CJS because root package.json sets "type": "module".
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const DEV_URL = process.env.VITE_DEV_SERVER_URL || "";

function createWindow() {
  const win = new BrowserWindow({
    width: 480,
    height: 760,
    minWidth: 380,
    minHeight: 600,
    backgroundColor: "#0b0d12",
    title: "BLOB Wallet",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  if (DEV_URL) {
    win.loadURL(DEV_URL);
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

// ── Vault file IPC ──────────────────────────────────────────────────────
function vaultPath() {
  return path.join(app.getPath("userData"), "wallet-vault.json");
}
function nodesPath() {
  return path.join(app.getPath("userData"), "node-config.json");
}

ipcMain.handle("vault:read", () => {
  try {
    if (!fs.existsSync(vaultPath())) return null;
    return fs.readFileSync(vaultPath(), "utf8");
  } catch { return null; }
});
ipcMain.handle("vault:write", (_e, json) => {
  try { fs.writeFileSync(vaultPath(), String(json), "utf8"); return true; }
  catch { return false; }
});
ipcMain.handle("vault:clear", () => {
  try { if (fs.existsSync(vaultPath())) fs.unlinkSync(vaultPath()); return true; }
  catch { return false; }
});

ipcMain.handle("nodes:read", () => {
  try {
    if (!fs.existsSync(nodesPath())) return null;
    return fs.readFileSync(nodesPath(), "utf8");
  } catch { return null; }
});
ipcMain.handle("nodes:write", (_e, json) => {
  try { fs.writeFileSync(nodesPath(), String(json), "utf8"); return true; }
  catch { return false; }
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
