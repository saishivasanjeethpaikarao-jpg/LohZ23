import { app, BrowserWindow, dialog, ipcMain, safeStorage, session } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
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

async function waitForBackend(child: ChildProcess, timeoutMs = 15000): Promise<void> {
  const startedAt = Date.now();
  let lastError = "not responding";
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`Bundled backend exited with code ${child.exitCode}: ${lastError}`);
    try {
      await new Promise<void>((resolve, reject) => {
        const request = http.get(`http://127.0.0.1:${port}/`, (response) => {
          response.resume();
          response.once("end", resolve);
        });
        request.once("error", reject);
        request.setTimeout(1000, () => request.destroy(new Error("backend request timed out")));
      });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Bundled backend did not become ready on port ${port} within ${timeoutMs}ms: ${lastError}`);
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

/**
 * Poll the backend for a completed desktop-auth exchange.
 * Returns the uid when auth completes, or null on timeout/error.
 * The correlator is passed to the page and used as the polling key.
 */
async function pollAuthResult(correlator: string, timeoutMs = 180_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await new Promise<{ ready: boolean; uid?: string }>((resolve, reject) => {
        const req = http.get(
          `http://127.0.0.1:${port}/auth/callback-result?state=${encodeURIComponent(correlator)}`,
          (res) => {
            let body = "";
            res.on("data", (chunk) => { body += chunk; });
            res.on("end", () => {
              try { resolve(JSON.parse(body)); } catch { reject(new Error("Bad JSON")); }
            });
          }
        );
        req.on("error", reject);
        req.setTimeout(3000, () => req.destroy(new Error("poll timeout")));
      });
      if (result.ready && result.uid) return result.uid;
    } catch { /* network blip — keep polling */ }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return null;
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
  const env = { NODE_ENV: "production", PORT: String(port), LOHZ_BIND_HOST: "127.0.0.1", LOHZ_APP_ROOT: appRoot, LOHZ_DATA_DIR: dataRoot, FIREBASE_SERVICE_ACCOUNT_PATH: path.join(dataRoot, "firebase-service-account.json"), ...(key ? { LOHZ_CREDENTIAL_KEY_B64: key } : {}) };
  backend = spawnNode(path.join(appRoot, "dist/server.cjs"), env);
  backend.once("exit", (code, signal) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    void dialog.showErrorBox("LOHZ backend stopped", `The bundled backend stopped before the app was closed (code ${code ?? "unknown"}, signal ${signal ?? "none"}).`);
  });
  if (process.platform === "win32") agent = spawnNode(path.join(appRoot, "dist/windows-agent.cjs"), env);
  mainWindow = new BrowserWindow({ width: 1440, height: 920, minWidth: 1024, minHeight: 700, backgroundColor: "#070b14", show: false, webPreferences: { preload: path.join(appRoot, "dist-desktop/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, webviewTag: false } });

  // Deny all renderer-initiated window opens. Auth uses the system browser
  // via desktop:open-auth IPC — no Google popup inside Electron.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  await waitForBackend(backend);
  
  // Load local backend with retry mechanism
  let loaded = false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await mainWindow.loadURL(`http://127.0.0.1:${port}`);
      loaded = true;
      break;
    } catch (err) {
      if (attempt === 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }

  mainWindow.once("ready-to-show", () => mainWindow?.show());
}

function stop(): void {
  backend?.kill(); agent?.kill();
  markSession(app.getPath("userData"), true);
}

// Register lohz:// custom protocol client
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("lohz", process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient("lohz");
}

function handleDeepLinkUrl(urlStr: string) {
  if (!urlStr || !urlStr.startsWith("lohz://")) return;
  try {
    const parsed = new URL(urlStr);
    if (parsed.hostname === "auth" && parsed.pathname === "/callback") {
      const token = parsed.searchParams.get("token") || undefined;
      const uid = parsed.searchParams.get("uid") || undefined;
      const guest = parsed.searchParams.get("guest") === "true";
      const displayName = parsed.searchParams.get("displayName") || undefined;
      const email = parsed.searchParams.get("email") || undefined;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("desktop:auth-protocol-callback", { token, uid, guest, displayName, email });
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    }
  } catch (err) {
    console.error("[Desktop] Failed to parse lohz:// callback URL:", err);
  }
}

// Ensure single instance lock for deep-linking callbacks on Windows/Linux
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    // Find lohz:// url in command line arguments on Windows
    const deepLink = commandLine.find((arg) => arg.startsWith("lohz://"));
    if (deepLink) {
      handleDeepLinkUrl(deepLink);
    }
  });
}

// macOS open-url event
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDeepLinkUrl(url);
});

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

  /**
   * desktop:open-auth
   * Opens the system browser to the LOHZ sign-in page on Netlify / Central Hub,
   * with a fallback to local server. Returns immediately once launched.
   */
  ipcMain.handle("desktop:open-auth", async () => {
    const { shell } = await import("electron");
    const correlator = crypto.randomBytes(16).toString("hex");
    // Priority: Netlify Auth Hub (or local /auth/desktop fallback)
    const netlifyHub = process.env.LOHZ_AUTH_HUB_URL || "https://lohz23.netlify.app/auth.html";
    const authUrl = `${netlifyHub}?state=${correlator}&redirect_uri=${encodeURIComponent("lohz://auth/callback")}`;
    await shell.openExternal(authUrl);
    return { ok: true };
  });

  await start();

  // Check if launched directly with a deep-link url on Windows
  const initialUrl = process.argv.find((arg) => arg.startsWith("lohz://"));
  if (initialUrl) {
    handleDeepLinkUrl(initialUrl);
  }
}).catch((error) => { dialog.showErrorBox("LOHZ could not start", String(error)); app.quit(); });

app.on("before-quit", stop);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
