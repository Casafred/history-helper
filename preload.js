const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  openExternal: (url) => ipcRenderer.send("open-external", url),
  // 通知主进程当前是否存在未导出的 PDF 标注（用于关闭确认）
  setHasAnnotations: (val) => ipcRenderer.send("set-has-annotations", !!val),
});
