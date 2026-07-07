const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  openExternal: (url) => ipcRenderer.send("open-external", url),
  setHasAnnotations: (val) => ipcRenderer.send("set-has-annotations", !!val),
  openPopoutWindow: (url, title, opts) => ipcRenderer.send("open-popout-window", url, title, opts || null),
  exportPdfWithAnnotations: (data) => ipcRenderer.invoke("export-pdf-annotations", data),
  getImmersiveTranslateScript: () => ipcRenderer.invoke("get-immersive-translate-script"),
  getImmersiveTranslateStatus: () => ipcRenderer.invoke("get-immersive-translate-status"),
  openExtensionsFolder: () => ipcRenderer.invoke("open-extensions-folder"),
});
