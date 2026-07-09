// Preload script: spoof Chrome browser fingerprint for CNIPA WAF bypass
// This script runs BEFORE any page scripts to masquerade as real Chrome

// Delete Electron/Node.js specific objects that leak on window
delete window.require;
delete window.exports;
delete window.module;
delete window.process;
delete window.Buffer;
delete window.global;
if (window.__filename) delete window.__filename;
if (window.__dirname) delete window.__dirname;

// Spoof navigator.webdriver to false (not controlled by automation)
Object.defineProperty(navigator, 'webdriver', {
  get: () => false,
  configurable: true,
});

// Spoof navigator.languages
Object.defineProperty(navigator, 'languages', {
  get: () => ['zh-CN', 'zh', 'en-US', 'en'],
  configurable: true,
});

// Spoof navigator.plugins (Chrome has plugins like PDF Viewer, Native Client etc.)
Object.defineProperty(navigator, 'plugins', {
  get: () => {
    const pluginData = [
      { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
      { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
      { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
    ];
    const plugins = [];
    plugins.refresh = () => {};
    pluginData.forEach((p, i) => {
      const plugin = {
        name: p.name,
        filename: p.filename,
        description: p.description,
        length: 0,
        item: () => null,
        namedItem: () => null,
      };
      plugins[i] = plugin;
      plugins[p.name] = plugin;
    });
    Object.defineProperty(plugins, 'length', { value: pluginData.length });
    return plugins;
  },
  configurable: true,
});

// Spoof navigator.mimeTypes to go along with plugins
Object.defineProperty(navigator, 'mimeTypes', {
  get: () => {
    const mimeTypes = [];
    mimeTypes.refresh = () => {};
    return mimeTypes;
  },
  configurable: true,
});

// Spoof navigator.connection if needed (standard values)
if (!navigator.connection) {
  Object.defineProperty(navigator, 'connection', {
    get: () => ({
      effectiveType: '4g',
      rtt: 50,
      downlink: 10,
      saveData: false,
    }),
    configurable: true,
  });
}

// Spoof window.chrome object (Chrome-specific namespace)
if (!window.chrome) {
  window.chrome = {};
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
if (!window.chrome.csi) {
  window.chrome.csi = () => ({
    onloadT: Date.now(),
    pageT: Date.now() - performance.timing.navigationStart,
    startT: performance.timing.navigationStart,
  });
}
if (!window.chrome.loadTimes) {
  window.chrome.loadTimes = () => ({
    commitLoadTime: Date.now() / 1000,
    connectionInfo: 'h2',
    finishDocumentLoadTime: Date.now() / 1000,
    finishLoadTime: Date.now() / 1000,
    firstPaintAfterLoadTime: 0,
    firstPaintTime: Date.now() / 1000,
    navigationType: 'Other',
    npnNegotiatedProtocol: 'h2',
    requestTime: (Date.now() - 100) / 1000,
    startLoadTime: (Date.now() - 200) / 1000,
    wasAlternateProtocolAvailable: false,
    wasFetchedViaSpdy: true,
    wasNpnNegotiated: true,
  });
}

// Spoof Notification permission (Chrome defaults to 'default')
if (!window.Notification) {
  window.Notification = { permission: 'default', requestPermission: (cb) => { if (cb) cb('default'); return Promise.resolve('default'); } };
}

// Spoof Permissions API
const originalQuery = window.navigator.permissions ? window.navigator.permissions.query : null;
if (originalQuery) {
  window.navigator.permissions.query = (parameters) => (
    parameters.name === 'notifications' ?
      Promise.resolve({ state: Notification.permission }) :
      parameters.name === 'clipboard-read' || parameters.name === 'clipboard-write' ?
        Promise.resolve({ state: 'granted', onchange: null }) :
        originalQuery(parameters)
  );
}

// Spoof screen resolution to common Windows values
Object.defineProperty(window.screen, 'width', { get: () => 1920, configurable: true });
Object.defineProperty(window.screen, 'height', { get: () => 1080, configurable: true });
Object.defineProperty(window.screen, 'availWidth', { get: () => 1920, configurable: true });
Object.defineProperty(window.screen, 'availHeight', { get: () => 1040, configurable: true });
Object.defineProperty(window.screen, 'colorDepth', { get: () => 24, configurable: true });
Object.defineProperty(window.screen, 'pixelDepth', { get: () => 24, configurable: true });
