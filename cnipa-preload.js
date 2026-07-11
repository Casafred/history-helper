/*!
 * PatentLens CNIPA 预加载脚本
 * Copyright (c) 2026 Alfred Shi. All rights reserved.
 * 本软件仅供内部使用，未经授权不得对外传播、复制或分发。
 * @author Alfred Shi
 * @version 260710
 */
// Preload script: spoof Chrome browser fingerprint for CNIPA WAF bypass
// Runs BEFORE page scripts in the same world (contextIsolation: false)
// __PATENTLENS_WATERMARK__: Alfred Shi @ 2026

// Helper: make a function whose toString() reports [native code]
function _nativeFn(name, body) {
  const fn = function() { return body ? body.apply(this, arguments) : undefined; };
  Object.defineProperty(fn, 'name', { value: name });
  Object.defineProperty(fn, 'toString', {
    value: function() { return `function ${name}() { [native code] }`; },
    configurable: true, enumerable: false, writable: true,
  });
  return fn;
}

// navigator.vendor is "" in Electron but "Google Inc." in Chrome
if (navigator.vendor !== 'Google Inc.') {
  Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.', configurable: true });
}
// navigator.webdriver must be false
Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
// navigator.languages
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en-US', 'en'], configurable: true });
// navigator.platform
Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
// navigator.plugins must look like Chrome's (PDF viewer plugins)
Object.defineProperty(navigator, 'plugins', {
  get: () => {
    const arr = [];
    const items = [
      ['Chrome PDF Plugin', 'internal-pdf-viewer', 'Portable Document Format'],
      ['Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', ''],
      ['Native Client', 'internal-nacl-plugin', ''],
    ];
    items.forEach(([name, filename, desc]) => {
      const p = {
        name, filename, description: desc, length: 0,
        item: _nativeFn('item'), namedItem: _nativeFn('namedItem'),
      };
      arr.push(p);
      arr[name] = p;
    });
    arr.refresh = _nativeFn('refresh');
    Object.defineProperty(arr, 'length', { value: items.length, configurable: true });
    return arr;
  },
  configurable: true,
});
// mimeTypes
Object.defineProperty(navigator, 'mimeTypes', {
  get: () => { const m = []; m.refresh = _nativeFn('refresh'); return m; },
  configurable: true,
});

// window.chrome namespace — comprehensive
if (!window.chrome) window.chrome = {};
window.chrome.app = {
  isInstalled: false,
  InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
  RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
  getDetails: _nativeFn('getDetails', () => null),
  getIsInstalled: _nativeFn('getIsInstalled', () => false),
  installState: _nativeFn('installState', () => 'not_installed'),
  runningState: _nativeFn('runningState', () => 'cannot_run'),
};
window.chrome.webstore = {
  install: _nativeFn('install'),
  onDownloadProgress: { addListener: _nativeFn('addListener'), removeListener: _nativeFn('removeListener') },
  onInstallStageChanged: { addListener: _nativeFn('addListener'), removeListener: _nativeFn('removeListener') },
};
if (!window.chrome.csi || !/native code/.test(String(window.chrome.csi))) {
  window.chrome.csi = _nativeFn('csi', function() {
    const navStart = (performance.timing && performance.timing.navigationStart) || (Date.now() - 100);
    return { onloadT: navStart + 100, pageT: 100, startT: navStart };
  });
}
if (!window.chrome.loadTimes || !/native code/.test(String(window.chrome.loadTimes))) {
  window.chrome.loadTimes = _nativeFn('loadTimes', function() {
    const now = Date.now() / 1000;
    return {
      commitLoadTime: now - 0.05, connectionInfo: 'h2',
      finishDocumentLoadTime: now, finishLoadTime: now,
      firstPaintAfterLoadTime: 0, firstPaintTime: now - 0.01,
      navigationType: 'Other', npnNegotiatedProtocol: 'h2',
      requestTime: now - 0.2, startLoadTime: now - 0.2,
      wasAlternateProtocolAvailable: false,
      wasFetchedViaSpdy: true, wasNpnNegotiated: true,
    };
  });
}
if (!window.chrome.runtime) {
  window.chrome.runtime = {
    OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update', SHARED_MODULE_UPDATE: 'shared_module_update' },
    OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
    PlatformArch: { ARM: 'arm', ARM64: 'arm64', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
    PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
    PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
    RequestUpdateCheckStatus: { THROTTLED: 'throttled', NO_UPDATE: 'no_update', UPDATE_AVAILABLE: 'update_available' },
    connect: _nativeFn('connect'),
    getManifest: _nativeFn('getManifest', () => ({})),
    getURL: _nativeFn('getURL', (p) => `chrome-extension://invalid/${p}`),
    id: undefined,
    getPlatformInfo: _nativeFn('getPlatformInfo', (cb) => cb && cb({ os: 'win', arch: 'x86-64', nacl_arch: 'x86-64' })),
    onMessage: { addListener: _nativeFn('addListener'), removeListener: _nativeFn('removeListener'), hasListener: _nativeFn('hasListener', () => false) },
    onConnect: { addListener: _nativeFn('addListener'), removeListener: _nativeFn('removeListener'), hasListener: _nativeFn('hasListener', () => false) },
    sendMessage: _nativeFn('sendMessage'),
  };
}

// Permission API
if (window.navigator.permissions && window.navigator.permissions.query) {
  const _oq = window.navigator.permissions.query.bind(window.navigator.permissions);
  window.navigator.permissions.query = function(params) {
    if (params && (params.name === 'notifications')) return Promise.resolve({ state: 'default', onchange: null });
    if (params && (params.name === 'clipboard-read' || params.name === 'clipboard-write'))
      return Promise.resolve({ state: 'granted', onchange: null });
    return _oq(params);
  };
}

// Hide Electron/Node globals with descriptor that looks like a normal undefined property
const _hide = { configurable: true, enumerable: false, get: () => undefined, set: () => {} };
['require', 'exports', 'module', 'process', 'Buffer', 'global', '__filename', '__dirname', 'setImmediate', 'electron', 'ipcRenderer'].forEach(k => {
  try {
    if (k in window) Object.defineProperty(window, k, _hide);
  } catch (e) {}
});
try {
  ['require', 'process', 'Buffer', 'global', 'setImmediate'].forEach(k => {
    if (k in globalThis) Object.defineProperty(globalThis, k, _hide);
  });
} catch (e) {}
