// Preload script: spoof Chrome browser fingerprint for CNIPA WAF bypass
// Runs BEFORE page scripts in the same world (contextIsolation: false)

// Spoof navigator vendor to Google Inc.
Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.', configurable: true });
Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'], configurable: true });
Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });

// Spoof window.chrome namespace
if (!window.chrome) window.chrome = {};
window.chrome.app = {
  isInstalled: false,
  InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
  RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
  getDetails: () => null,
  getIsInstalled: () => false,
  installState: () => 'not_installed',
  runningState: () => 'cannot_run',
};
window.chrome.webstore = {
  install: () => {},
  onDownloadProgress: { addListener: () => {}, removeListener: () => {} },
  onInstallStageChanged: { addListener: () => {}, removeListener: () => {} },
};
if (!window.chrome.csi) {
  window.chrome.csi = function() {
    return { onloadT: Date.now(), pageT: 50, startT: Date.now() - 50 };
  };
}
if (!window.chrome.loadTimes) {
  window.chrome.loadTimes = function() {
    return {
      commitLoadTime: Date.now() / 1000,
      connectionInfo: 'h2',
      finishDocumentLoadTime: Date.now() / 1000,
      finishLoadTime: Date.now() / 1000,
      firstPaintAfterLoadTime: 0,
      firstPaintTime: Date.now() / 1000,
      navigationType: 'Other',
      npnNegotiatedProtocol: 'h2',
      requestTime: Date.now() / 1000,
      startLoadTime: Date.now() / 1000,
      wasAlternateProtocolAvailable: false,
      wasFetchedViaSpdy: true,
      wasNpnNegotiated: true,
    };
  };
}
if (!window.chrome.runtime) {
  window.chrome.runtime = {
    OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
    OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
    PlatformArch: { ARM: 'arm', ARM64: 'arm64', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
    PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
    PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
    RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
    connect: () => {},
    getManifest: () => ({}),
    getURL: (path) => `chrome-extension://invalid/${path}`,
    id: undefined,
    getPlatformInfo: (cb) => cb && cb({ os: 'win', arch: 'x86-64', nacl_arch: 'x86-64' }),
    onMessage: { addListener: () => {}, removeListener: () => {}, hasListener: () => false },
    onConnect: { addListener: () => {}, removeListener: () => {}, hasListener: () => false },
    sendMessage: () => {},
  };
}

// Hide Electron/Node globals with undefined getters
const _hide = { configurable: true, get: () => undefined, set: () => {} };
['require', 'exports', 'module', 'process', 'Buffer', 'global', '__filename', '__dirname', 'setImmediate'].forEach(k => {
  try {
    if (k in window) Object.defineProperty(window, k, _hide);
  } catch (e) {}
});
try {
  if ('require' in globalThis) Object.defineProperty(globalThis, 'require', _hide);
  if ('process' in globalThis) Object.defineProperty(globalThis, 'process', _hide);
  if ('Buffer' in globalThis) Object.defineProperty(globalThis, 'Buffer', _hide);
} catch (e) {}
