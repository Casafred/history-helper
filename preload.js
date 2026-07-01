const { contextBridge, ipcRenderer } = require("electron");

// fontkit：主进程 require 的 @pdf-lib/fontkit 实例，供渲染进程 pdf-lib embedFont 使用
let _fontkit = null;
try { _fontkit = require("@pdf-lib/fontkit"); } catch (e) { console.warn("[preload] fontkit require failed:", e.message); }

contextBridge.exposeInMainWorld("electronAPI", {
  openExternal: (url) => ipcRenderer.send("open-external", url),
  // 通知主进程当前是否存在未导出的 PDF 标注（用于关闭确认）
  setHasAnnotations: (val) => ipcRenderer.send("set-has-annotations", !!val),
  // 请求主进程创建弹出窗口（IPC 直连，不依赖 window.open → setWindowOpenHandler 链路）
  openPopoutWindow: (url, title) => ipcRenderer.send("open-popout-window", url, title),
  // 暴露 fontkit 实例给渲染进程（UMD 脚本在 Electron sandbox 下可能无法正确挂载 window.fontkit）
  getFontkit: () => _fontkit,
});
