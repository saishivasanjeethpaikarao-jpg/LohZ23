import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("lohzDesktop", {
  platform: process.platform,
  version: process.env.npm_package_version || "0.0.0",
  capabilities: () => ipcRenderer.invoke("desktop:capabilities"),
  backupData: () => ipcRenderer.invoke("desktop:backup"),
  restoreData: () => ipcRenderer.invoke("desktop:restore"),
  updateStatus: () => ipcRenderer.invoke("desktop:update-status"),
  /** Opens the system browser to the LOHZ sign-in page and returns the result. */
  openAuth: (): Promise<{ ok: boolean; uid?: string; error?: string }> =>
    ipcRenderer.invoke("desktop:open-auth"),
  /** Subscribe to lohz://auth/callback events captured by Electron */
  onAuthProtocolCallback: (callback: (payload: { token?: string; uid?: string; guest?: boolean; displayName?: string; email?: string }) => void) => {
    const handler = (_event: unknown, data: any) => callback(data);
    ipcRenderer.on("desktop:auth-protocol-callback", handler);
    return () => { ipcRenderer.removeListener("desktop:auth-protocol-callback", handler); };
  },
});

