/*!
 * PatentLens Electron preload
 * Copyright (c) 2026 Alfred Shi. All rights reserved.
 * 本软件仅供内部使用，未经授权不得对外传播。
 * @author Alfred Shi
 * @version 260710
 */
const { contextBridge, ipcRenderer, clipboard } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  openExternal: (url) => ipcRenderer.send("open-external", url),
  copyToClipboard: (text) => {
    try { clipboard.writeText(String(text || "")); return true; } catch (e) { return false; }
  },
  setHasAnnotations: (val, summary) => ipcRenderer.send("set-has-annotations", !!val, Array.isArray(summary) ? summary : []),
  openPopoutWindow: (url, title, opts) => ipcRenderer.send("open-popout-window", url, title, opts || null),
  exportPdfWithAnnotations: (data) => ipcRenderer.invoke("export-pdf-annotations", data),
  getImmersiveTranslateScript: () => ipcRenderer.invoke("get-immersive-translate-script"),
  getImmersiveTranslateStatus: () => ipcRenderer.invoke("get-immersive-translate-status"),
  openExtensionsFolder: () => ipcRenderer.invoke("open-extensions-folder"),
});
