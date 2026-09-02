import { app, BrowserWindow, dialog, ipcMain, safeStorage, session } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createBackup, ensureDataLayout, hadUncleanShutdown, markSession, migrateLegacyLayout, restoreBackup } from "./dataLifecycle";
import { evaluateUpdatePolicy } from "./updatePolicy";
import { getPlatformCapabilities } from "../src/lib/platform/capabilities";

let backend: ChildProcess | undefined;
let agent: ChildProcess | undefined;
let mainWindow: BrowserWindow | undefined;
const port = Number(process.env.LOHZ_DESKTOP_PORT) || 3210;

function spawnNode(entry: string, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [entry], { env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit", windowsHide: true });
}

function credentialKey(dataRoot: string): string | undefined {
  const file = path.join(dataRoot, "credentials.key");
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    if (fs.existsSync(file)) return safeStorage.decryptString(fs.readFileSync(file));
    const key = crypto.randomBytes(32).toString("base64");
    fs.writeFileSync(file, safeStorage.encryptString(key), { mode: 0o600 });
    return key;
  } catch { return undefined; }
}

async function start(): Promise<void> {
  const appRoot = app.getAppPath();
  const dataRoot = app.getPath("userData");
  ensureDataLayout(dataRoot);
  const unclean = hadUncleanShutdown(dataRoot);
  migrateLegacyLayout(appRoot, dataRoot);
  if (unclean) { try { createBackup(dataRoot); } catch { /* preserve startup */ } }
  markSession(dataRoot, false);
  const key = credentialKey(dataRoot);
  const env = { NODE_ENV: "production", PORT: String(port), LOHZ_BIND_HOST: "127.0.0.1", LOHZ_APP_ROOT: appRoot, LOHZ_DATA_DIR: dataRoot, ...(key ? { LOHZ_CREDENTIAL_KEY_B64: key } : {}) };
  backend = spawnNode(path.join(appRoot, "dist/server.cjs"), env);
  if (process.platform === "win32") agent = spawnNode(path.join(appRoot, "dist/windows-agent.cjs"), env);
  mainWindow = new BrowserWindow({ width: 1440, height: 920, minWidth: 1024, minHeight: 700, backgroundColor: "#070b14", show: false, webPreferences: { preload: path.join(appRoot, "dist-desktop/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false } });
  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
  mainWindow.once("ready-to-show", () => mainWindow?.show());
}

function stop(): void {
  backend?.kill(); agent?.kill();
  markSession(app.getPath("userData"), true);
}

app.enableSandbox();
app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(permission === "media"));
  ipcMain.handle("desktop:capabilities", () => getPlatformCapabilities());
  ipcMain.handle("desktop:backup", () => createBackup(app.getPath("userData")));
  ipcMain.handle("desktop:restore", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return { restored: false };
    const root = app.getPath("userData"); createBackup(root); restoreBackup(root, result.filePaths[0]); return { restored: true };
  });
  ipcMain.handle("desktop:update-status", () => evaluateUpdatePolicy({ packaged: app.isPackaged, signedRelease: process.env.LOHZ_SIGNED_RELEASE === "true", updateUrl: process.env.LOHZ_UPDATE_URL, platform: process.platform }));
  await start();
}).catch((error) => { dialog.showErrorBox("LOHZ could not start", String(error)); app.quit(); });

app.on("before-quit", stop);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
