const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  openExternal: (url) => ipcRenderer.send("open-external", url),
  // 通知主进程当前是否存在未导出的 PDF 标注（用于关闭确认）
  setHasAnnotations: (val) => ipcRenderer.send("set-has-annotations", !!val),
  // 请求主进程创建弹出窗口（IPC 直连，不依赖 window.open → setWindowOpenHandler 链路）
  openPopoutWindow: (url, title) => ipcRenderer.send("open-popout-window", url, title),
  // 请求主进程导出含标注的 PDF（主进程有 fontkit，渲染进程 sandbox 下无法加载）
  exportPdfWithAnnotations: (data) => ipcRenderer.invoke("export-pdf-annotations", data),
});
