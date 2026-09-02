import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("lohzDesktop", {
  platform: process.platform,
  version: process.env.npm_package_version || "0.0.0",
  capabilities: () => ipcRenderer.invoke("desktop:capabilities"),
  backupData: () => ipcRenderer.invoke("desktop:backup"),
  restoreData: () => ipcRenderer.invoke("desktop:restore"),
  updateStatus: () => ipcRenderer.invoke("desktop:update-status"),
});
