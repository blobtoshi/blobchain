// Electron main process — CJS because root package.json sets "type": "module".
const { app, BrowserWindow, ipcMain, Menu, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const DEV_URL = process.env.VITE_DEV_SERVER_URL || "";
let mainWindow = null;

function send(event) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("menu-event", event);
  }
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Lock Wallet", accelerator: "Cmd+L", click: () => send("lock") },
        { type: "separator" },
        { role: "services" }, { type: "separator" },
        { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
        { type: "separator" }, { role: "quit" },
      ],
    }] : []),
    {
      label: "Wallet",
      submenu: [
        { label: "Wallet", accelerator: "CmdOrCtrl+1", click: () => send("tab:wallet") },
        { label: "Send", accelerator: "CmdOrCtrl+2", click: () => send("tab:send") },
        { label: "Node", accelerator: "CmdOrCtrl+3", click: () => send("tab:node") },
        { type: "separator" },
        { label: "Lock", accelerator: "CmdOrCtrl+L", click: () => send("lock") },
        ...(isMac ? [] : [{ type: "separator" }, { role: "quit" }]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
        { type: "separator" }, { role: "togglefullscreen" },
      ],
    },
    {
      role: "help",
      submenu: [
        {
          label: "BlobChain Website",
          click: () => shell.openExternal("https://blobchain.network"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
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
    mainWindow.loadURL(DEV_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.on("closed", () => { mainWindow = null; });
}

// ── Vault file IPC ──────────────────────────────────────────────────────
function vaultPath() { return path.join(app.getPath("userData"), "wallet-vault.json"); }
function nodesPath() { return path.join(app.getPath("userData"), "node-config.json"); }

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

app.whenReady().then(() => {
  buildMenu();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
