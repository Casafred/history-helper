const GD_API_BASE = "/api/gd";

const OFFICE_NAMES = {
  US: "美国 (USPTO)",
  EP: "欧洲 (EPO)",
  JP: "日本 (JPO)",
  DE: "德国 (DPMA)",
  KR: "韩国 (KIPO)",
  WO: "WIPO (PCT)",
  WIPO: "WIPO (PCT)",
  CN: "中国 (CNIPA)",
};

let currentData = null;
let kanbanAutoAbortController = null;
let citedRefsAbortController = null;

// Process management: allows new process to interrupt existing one
let activeAnalysisProcess = null; // "review" | "citedRefs" | null
function abortActiveProcess() {
  if (kanbanAutoAbortController) {
    kanbanAutoAbortController.abort();
    kanbanAutoAbortController = null;
  }
  if (citedRefsAbortController) {
    citedRefsAbortController.abort();
    citedRefsAbortController = null;
  }
  const btns = ["kanban-manual-select-btn", "cited-refs-manual-btn"];
  btns.forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.disabled = false; el.classList.remove("hidden"); }
  });
  const abortBtns = ["cited-refs-abort-btn"];
  abortBtns.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  });
  activeAnalysisProcess = null;
}

// Save/load manual selection state
function getManualSelectKey(prefix) {
  if (!currentData) return null;
  const office = currentData.office || "";
  const appNum = currentData.applicationNumber || currentData.docNumber || "";
  return `patentlens_${prefix}_${office}_${appNum}`;
}

function saveManualSelection(prefix, items, checkboxSelector, panelEl) {
  const key = getManualSelectKey(prefix);
  if (!key) return;
  const checkedIdxs = [];
  panelEl.querySelectorAll(checkboxSelector + ":checked").forEach(cb => {
    checkedIdxs.push(parseInt(cb.dataset.idx));
  });
  try { localStorage.setItem(key, JSON.stringify(checkedIdxs)); } catch {}
}

function loadManualSelection(prefix, items, checkboxSelector, panelEl, defaultCheckFn) {
  const key = getManualSelectKey(prefix);
  if (!key) return false;
  try {
    const saved = localStorage.getItem(key);
    if (!saved) return false;
    const checkedIdxs = JSON.parse(saved);
    if (!Array.isArray(checkedIdxs)) return false;
    panelEl.querySelectorAll(checkboxSelector).forEach(cb => {
      const idx = parseInt(cb.dataset.idx);
      cb.checked = checkedIdxs.includes(idx);
    });
    return true;
  } catch { return false; }
}

// Map JP document codes to JPO API doc type endpoints
function mapJpDocType(docCode, type) {
  if (!docCode) return null;
  const code = docCode.toUpperCase();
  if (code.includes("KY") || code.includes("REFUSAL") || type === "office_action") {
    return "refusal_reason";
  }
  if (code.includes("SA") || code.includes("DISPATCH") || type === "allowance") {
    return "dispatch";
  }
  if (code.includes("IK") || code.includes("HO") || code.includes("SUBMISSION") || type === "response") {
    return "submission";
  }
  if (code.includes("SH") || code.includes("TRIAL")) {
    return "trial";
  }
  return "dispatch";
}

const isTauri = !!(window.__TAURI_INTERNALS__);

async function tauriInvoke(cmd, args) {
  if (!isTauri) return null;
  try {
    return await window.__TAURI_INTERNALS__.invoke(cmd, args);
  } catch (e) {
    console.error("Tauri invoke error:", cmd, e);
    throw e;
  }
}

const patentInput = document.getElementById("patent-input");
const searchBtn = document.getElementById("search-btn");
const queryTypeSelect = document.getElementById("query-type");
const officeBadge = document.getElementById("office-badge");
const resultSection = document.getElementById("result-section");
const patentDetailSection = document.getElementById("patent-detail-section");
const patentDetailContent = document.getElementById("patent-detail-content");
const loading = document.getElementById("loading");
const loadingText = document.getElementById("loading-text");
const loadingGpLink = document.getElementById("loading-gp-link");
const loadingEspacenetLink = document.getElementById("loading-espacenet-link");
const errorToast = document.getElementById("error-toast");

let searchMode = "dossier"; // "dossier" | "patent"

// ── Google Patents 代理设置 ──
function getGpProxySettings() {
  try {
    return JSON.parse(localStorage.getItem("patentlens_gp_proxy") || "{}");
  } catch { return {}; }
}
function saveGpProxySettings(enabled, proxyUrl) {
  localStorage.setItem("patentlens_gp_proxy", JSON.stringify({ enabled: !!enabled, proxyUrl: proxyUrl || "" }));
}
function gpApiUrl(patentNumber) {
  const s = getGpProxySettings();
  let url = "/api/gp/" + encodeURIComponent(patentNumber);
  const params = [];
  if (s.enabled) {
    params.push("proxy=1");
    if (s.proxyUrl) params.push("proxyUrl=" + encodeURIComponent(s.proxyUrl));
  }
  // 附加 EPO OPS 降级查询凭证（当 Google Patents 查询失败时自动降级）
  const opsConfig = getOpsSettings();
  if (opsConfig.enabled && opsConfig.consumerKey && opsConfig.consumerSecret) {
    params.push("opsKey=" + encodeURIComponent(opsConfig.consumerKey));
    params.push("opsSecret=" + encodeURIComponent(opsConfig.consumerSecret));
  }
  if (params.length > 0) url += "?" + params.join("&");
  return url;
}

// ── J-PlatPat URL construction for JP patents ──
function isJPPatent(patentNo) {
  return /^JP\d+/i.test(patentNo);
}

function parseJPPatentNo(patentNo) {
  const m = patentNo.toUpperCase().match(/^JP(\d{2,4})(\d+)([A-Z]?\d*)?$/);
  if (!m) return null;
  let yearPart = m[1];
  const serial = m[2];
  const kind = m[3] || "";

  let gregorianYear;
  if (yearPart.length === 2) {
    const n = parseInt(yearPart, 10);
    if (n <= 26) {
      gregorianYear = 2000 + n;
    } else {
      gregorianYear = 1900 + n;
    }
  } else if (yearPart.length === 4) {
    gregorianYear = parseInt(yearPart, 10);
  } else {
    return null;
  }

  const serialPadded = serial.padStart(6, "0");
  const numFormatted = gregorianYear + "-" + serialPadded;

  return {
    year: String(gregorianYear),
    serial: serialPadded,
    kind: kind,
    numFormatted: numFormatted,
    docdbFormat: "JP," + numFormatted + (kind ? "," + kind : ",A"),
  };
}

function jplatpatDocUrl(patentNo) {
  const parsed = parseJPPatentNo(patentNo);
  if (!parsed) return "https://www.j-platpat.inpit.go.jp/p0000";
  const kind = parsed.kind.toUpperCase();
  let docType;
  if (kind.startsWith("B") || kind.startsWith("C")) {
    docType = "PB";
  } else {
    docType = "PU";
  }
  const jpNum = "JP-" + parsed.numFormatted;
  return "https://www.j-platpat.inpit.go.jp/c1801/" + docType + "/" + encodeURIComponent(jpNum) + "/01/ja";
}

function jplatpatSimpleSearchUrl() {
  return "https://www.j-platpat.inpit.go.jp/s0100";
}

function jplatpatSearchNumber(patentNo) {
  const raw = (patentNo || "").trim().toUpperCase().replace(/[\s\/-]/g, "");
  const m = raw.match(/^JP(\d+)[A-Z]?\d*$/);
  if (!m) {
    const m2 = raw.match(/^JP(\d+)/);
    return m2 ? m2[1] : "";
  }
  return m[1];
}

function openJPlatPat(patentNo, title) {
  const searchNum = jplatpatSearchNumber(patentNo);
  const url = jplatpatSimpleSearchUrl();
  const fullTitle = title || ("J-PlatPat: " + patentNo);
  openInAppWebview(url, fullTitle, { jpn: searchNum });
}

function patentLinkButtons(patentNo) {
  let btns = '<button class="pd-gp-link" onclick="openInAppWebview(\'https://patents.google.com/patent/' + encodeURIComponent(patentNo) + '\', \'Google Patents: ' + escapeHtml(patentNo) + '\')" title="在应用内打开 Google Patents">GP</button>';
  if (isJPPatent(patentNo)) {
    btns += '<button class="pd-gp-link" onclick="openJPlatPat(\'' + escapeHtml(patentNo) + '\', \'J-PlatPat: ' + escapeHtml(patentNo) + '\')" title="在 J-PlatPat（日本专利局）查看" style="background:#e74c3c;color:#fff;border-color:#c0392b;font-size:10px;padding:1px 5px;">JP</button>';
  }
  return btns;
}

// EPO OPS 配置读取（从 AI 配置中获取 ops 字段）
function getOpsSettings() {
  const config = window.AI.loadAIConfig();
  const ops = window.AI.getOpsConfig(config);
  const enabled = localStorage.getItem("patentlens_ops_enabled") !== "false"; // 默认启用
  return { enabled: enabled, consumerKey: ops.consumerKey || "", consumerSecret: ops.consumerSecret || "" };
}

const aiSettingsBtn = document.getElementById("ai-settings-btn");
const aiSettingsModal = document.getElementById("ai-settings-modal");
const modalCloseBtn = document.getElementById("modal-close-btn");
const modalOverlay = document.querySelector("#ai-settings-modal .modal-overlay");
const aiProviderSelect = document.getElementById("ai-provider-select");
const aiApiKeyInput = document.getElementById("ai-api-key-input");
const aiBaseUrlInput = document.getElementById("ai-base-url-input");
const aiModelSelect = document.getElementById("ai-model-select");
const ocrEngineSelect = document.getElementById("ocr-engine-select");
const ocrGlmKeyGroup = document.getElementById("ocr-glm-key-group");
const ocrGlmKeyInput = document.getElementById("ocr-glm-key-input");
const aiTestBtn = document.getElementById("ai-test-btn");
const aiSaveBtn = document.getElementById("ai-save-btn");
const aiTestResult = document.getElementById("ai-test-result");
const aiSummarizeBtn = null;
const aiStatus = null;
const aiSummaryResult = null;
const readerBtn = document.getElementById("reader-btn");
const readerModal = document.getElementById("reader-modal");
const readerCloseBtn = document.getElementById("reader-close-btn");
const readerMinimizeBtn = null;
const readerFloatingBall = document.getElementById("reader-floating-ball");
const readerDocList = document.getElementById("reader-doc-list");
const readerContent = document.getElementById("reader-content");
const readerExportBtn = document.getElementById("reader-export-btn");
const exportWordBtn = document.getElementById("export-word-btn");
const readerPdfToggle = null;
const readerDockBtn = null;
const readerFullscreenBtn = null;
const readerPdfView = document.getElementById("reader-pdf-view");
const readerPdfContainer = document.getElementById("reader-pdf-container");
const pdfPageInfo = document.getElementById("pdf-page-info");
const pdfPageInput = document.getElementById("pdf-page-input");
const pdfZoomLevel = document.getElementById("pdf-zoom-level");
const pdfPrevPage = document.getElementById("pdf-prev-page");
const pdfNextPage = document.getElementById("pdf-next-page");
const pdfZoomIn = document.getElementById("pdf-zoom-in");
const pdfZoomOut = document.getElementById("pdf-zoom-out");
const pdfZoomFit = document.getElementById("pdf-zoom-fit");
const pdfTranslateBtn = document.getElementById("pdf-translate-btn");
const pdfTranslatePanel = document.getElementById("pdf-translate-panel");
const pdfTranslateLang = document.getElementById("pdf-translate-lang");
const pdfTranslateContent = document.getElementById("pdf-translate-content");

const readerChatPanel = document.getElementById("reader-chat-panel");
const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const chatSendBtn = document.getElementById("chat-send-btn");
const readerChatToggle = document.getElementById("reader-chat-toggle");

let pdfViewState = {
  active: false,
  currentDocIdx: null,
  currentDocKey: null,
  pdfDoc: null,
  currentPage: 1,
  totalPages: 0,
  scale: 1.0,
  baseScale: 1.0,
  renderedPages: {},
  pendingHighlight: null,
  pendingHighlightRange: null,
  searchMatches: [],
  searchCurrentIdx: -1,
  selectedBlockIds: [],
  selecting: false,
  selectStart: null,
  selectEnd: null,
  traceJumpPending: false,
  renderVersion: 0,
  // PDF 标注功能
  annotTool: null,        // "highlight" | "underline" | "arrow" | "note" | null
  annotList: {},          // { docKey: [annotation, ...] }
  annotDragging: false,
  annotDragStart: null,
  annotDragEnd: null,
  annotDragPage: null,
  annotDragViewport: null,
  annotUndoStack: {},     // { docKey: [snapshot, ...] }
  annotRedoStack: {},     // { docKey: [snapshot, ...] }
  annotMoving: null,      // 拖动标注换位置
  annotResizing: null,    // 拖动线条端点调整角度/长度
  ocrHidden: false,       // OCR 文本框是否隐藏
  annotTextColor: "#e53935",   // 注释文字默认颜色
  annotFontSize: 14,      // 注释文字默认字号
  annotLineColor: "#e53935",   // 划线/箭头/高亮默认颜色
  annotLineWidth: 2,      // 划线/箭头默认粗细
  annotDash: false,       // 划线/箭头是否虚线
};

let _pdfDocCache = {}; // Cache loaded PDF documents by key (idx_url)

let chatHistory = [];
let chatAbortController = null;
let analysisChatHistory = [];
let analysisChatAbortController = null;
let translateAbortController = null;
let translatePageCache = {};

function showError(msg) {
  errorToast.textContent = msg;
  errorToast.classList.remove("hidden");
  setTimeout(() => { errorToast.classList.add("hidden"); }, 5000);
}

function hideError() {
  errorToast.classList.add("hidden");
}

function detectOffice(number) {
  const upper = number.trim().toUpperCase();
  if (upper.startsWith("US") || (upper.startsWith("1") && upper.length === 8)) return "US";
  if (upper.startsWith("EP")) return "EP";
  if (upper.startsWith("JP")) return "JP";
  if (upper.startsWith("KR")) return "KR";
  if (upper.startsWith("WO") || upper.startsWith("PCT")) return "WO";
  if (upper.startsWith("CN")) return "CN";
  if (upper.startsWith("DE")) return "DE";
  return null;
}

function parsePatentNumber(input) {
  const trimmed = input.trim();
  const office = detectOffice(trimmed);
  if (!office) return null;

  let stripped = trimmed;
  let queryType = "application";

  const kindCodeMatch = stripped.match(/^(.*?[0-9])([A-Z]\d*)$/i);
  let kindCode = null;
  if (kindCodeMatch) {
    stripped = kindCodeMatch[1];
    kindCode = kindCodeMatch[2].toUpperCase();
  }

  let appNum = stripped;
  // 根据后缀自动识别查询类型：
  //   B1/B2 → patent（授权专利号）
  //   A1/A2/A3 等 → publication（公开号）
  //   无后缀 → application（申请号）
  if (kindCode) {
    const kc = kindCode.toUpperCase();
    if (/^B\d*$/.test(kc)) {
      queryType = "patent";
    } else {
      queryType = "publication";
    }
  }
  switch (office) {
    case "US":
      appNum = stripped.replace(/^US/i, "").replace(/[^0-9]/g, "");
      // 无后缀的11位且以20开头 → 也是公开号(如 20220301610)
      if (!kindCode && appNum.length === 11 && /^20\d{9}$/.test(appNum)) {
        queryType = "publication";
      }
      break;
    case "EP":
      appNum = stripped.replace(/^EP/i, "").replace(/[\s.]/g, "");
      // EP patents: Global Dossier "patent" query type often returns null corrAppNum,
      // causing wrong application number to be selected from family list.
      // Always use "publication" which reliably returns corrAppNum.
      if (kindCode) {
        queryType = "publication";
      }
      break;
    case "JP":
      appNum = stripped.replace(/^JP/i, "").replace(/[\s-]/g, "");
      break;
    case "KR":
      appNum = stripped.replace(/^KR/i, "").replace(/[\s-]/g, "");
      break;
    case "WO":
      appNum = stripped.replace(/^(WO|PCT)/i, "").replace(/[\s\/]/g, "");
      break;
    case "CN":
      appNum = stripped.replace(/^CN/i, "").replace(/[\s.]/g, "");
      if (kindCode) queryType = "publication";
      else queryType = "publication";
      break;
    case "DE":
      appNum = stripped.replace(/^DE/i, "").replace(/[\s.]/g, "");
      if (kindCode) queryType = "publication";
      else queryType = "publication";
      break;
  }

  return { office, raw: trimmed, applicationNumber: appNum, kindCode: kindCode, queryType };
}

async function gdFetch(urlPath) {
  if (isTauri) {
    const familyMatch = urlPath.match(/\/patent-family\/svc\/family\/([^/]+)\/([^/]+)\/([^/]+)/);
    const docListMatch = urlPath.match(/\/doc-list\/svc\/doclist\/([^/]+)\/([^/]+)\/([^/]+)/);

    if (familyMatch) {
      const result = await tauriInvoke("fetch_family", {
        input: familyMatch[3],
        queryType: familyMatch[1],
      });
      if (result && result.success && result.data) return result.data;
      throw new Error(result?.error || "Tauri family fetch failed");
    }

    if (docListMatch) {
      const result = await tauriInvoke("fetch_documents", {
        input: docListMatch[2].startsWith("US") ? docListMatch[3] : docListMatch[3],
      });
      if (result && result.success && result.data) return result.data;
      throw new Error(result?.error || "Tauri documents fetch failed");
    }
  }

  const url = GD_API_BASE + urlPath;
  const resp = await fetch(url);
  if (!resp.ok) {
    if (resp.status === 404) throw new Error("未找到该专利的记录 (404)");
    throw new Error(`API 请求失败: HTTP ${resp.status}`);
  }
  return resp.json();
}

patentInput.addEventListener("input", () => {
  const val = patentInput.value.trim();
  if (!val) { officeBadge.classList.add("hidden"); return; }
  const office = detectOffice(val);
  if (office) {
    officeBadge.textContent = (OFFICE_NAMES[office] || office) + " 专利";
    officeBadge.classList.remove("hidden");
  } else {
    officeBadge.classList.add("hidden");
  }
});

patentInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") searchBtn.click();
});

searchBtn.addEventListener("click", async () => {
  const input = patentInput.value.trim();
  if (!input) return;

  // Patent detail mode - use tab system
  if (searchMode === "patent") {
    _openPdPatent(input);
    return;
  }

  // Check for unsaved work before starting a new search
  if (kanbanState.hasUnsavedWork && currentData) {
    const currentPatent = currentData.raw || (currentData.office + currentData.applicationNumber);
    const newPn = parsePatentNumber(input);
    const newPatent = newPn ? (newPn.raw || input) : input;
    if (currentPatent !== newPatent) {
      promptSaveCache(() => { doSearch(input); });
      return;
    }
  }
  doSearch(input);
});

// ── 悬浮球可见性 ──
// 三个悬浮球（阅读器/专利原文弹窗/AI 对话）仅在「审查文档」界面显示；
// 主页（首页搜索状态）和「专利原文」模式下全部隐藏。
function updateFloatingBallsVisibility() {
  const appEl = document.getElementById("app");
  const isHomeMode = appEl && appEl.classList.contains("home-mode");
  const isPatentMode = searchMode === "patent";
  const shouldShow = !isHomeMode && !isPatentMode && currentData && kanbanState.documents && kanbanState.documents.length > 0;

  // 阅读器悬浮球：只要在审查模式有文档就显示
  const readerBall = document.getElementById("reader-floating-ball");
  if (readerBall) {
    if (shouldShow) {
      readerBall.classList.remove("hidden");
    } else {
      readerBall.classList.add("hidden");
    }
  }

  // 专利原文悬浮球：审查模式下且弹窗未打开时显示
  const ppvBall = document.getElementById("patent-popup-ball");
  const ppvViewer = document.getElementById("patent-popup-viewer");
  if (ppvBall) {
    if (shouldShow && (!ppvViewer || ppvViewer.classList.contains("hidden"))) {
      ppvBall.classList.remove("hidden");
    } else {
      ppvBall.classList.add("hidden");
    }
  }

  // AI对话悬浮球：审查模式下且有分析结果时显示
  const chatBall = document.getElementById("analysis-chat-float-ball");
  if (chatBall) {
    if (shouldShow && kanbanState.analysis) {
      chatBall.classList.remove("hidden");
    } else {
      chatBall.classList.add("hidden");
    }
  }
}

// ── 搜索模式切换 ──
document.querySelectorAll(".search-mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".search-mode-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    searchMode = btn.dataset.mode;
    if (searchMode === "patent") {
      patentInput.placeholder = "输入专利号查询原文信息（如 US12030161B2, EP4252965A3）";
      resultSection.classList.add("hidden");
      if (batchSearchToggleBtn) batchSearchToggleBtn.style.display = "";
      if (_pdOpenPatents.length > 0 && _pdActivePatent && _pdPatentCache[_pdActivePatent]) {
        patentDetailSection.classList.remove("hidden");
        _renderPdTabs();
        renderPatentDetail(_pdPatentCache[_pdActivePatent]);
        window._currentPatentData = _pdPatentCache[_pdActivePatent];
        if (patentInput) patentInput.value = _pdActivePatent;
      } else if (window._currentPatentData) {
        patentDetailSection.classList.remove("hidden");
      }
    } else {
      patentInput.placeholder = "输入专利号（如 US12030161B2, US17204063, EP4252965A3）系统自动识别类型";
      patentDetailSection.classList.add("hidden");
      if (batchSearchToggleBtn) batchSearchToggleBtn.style.display = "none";
      if (batchSearchPanel) batchSearchPanel.classList.add("hidden");
      if (batchResultsSection) batchResultsSection.classList.add("hidden");
      if (pdFindBar) pdFindBar.classList.add("hidden");
      _clearFindHighlights();
      // Restore result section if there's cached data
      if (currentData) resultSection.classList.remove("hidden");
    }
    updateFloatingBallsVisibility();
  });
});

// ── 专利原文查询（Google Patents） ──
async function searchPatentDetail(input) {
  // Clear prefetch cache when starting a new search
  clearPrefetchCache();

  const appEl = document.getElementById("app");
  if (appEl && appEl.classList.contains("home-mode")) appEl.classList.remove("home-mode");

  // Exit batch mode when doing a regular search
  _pdBatchMode = false;
  if (batchResultsSection) batchResultsSection.classList.add("hidden");
  if (batchSearchPanel) batchSearchPanel.classList.add("hidden");
  // Clear any batch-mode tabs
  _pdOpenPatents.length = 0;
  _pdActivePatent = null;
  Object.keys(_pdPatentCache).forEach(k => delete _pdPatentCache[k]);
  _renderPdTabs();

  const raw = input.trim().toUpperCase().replace(/[\s\/]/g, "");
  if (!raw) { showError("请输入专利号"); return; }

  // JP专利在专利原文模式下和其他国家一样走GP流程
  // (移除了直接打开J-PlatPat的跳转，J-PlatPat仅用于审查文档模式)

  // 审查文档模式下的缓存恢复（专利原文模式不应恢复 kanbanState 缓存，否则拦截了 GP 查询）
  const cachedEntry = PatentCache.get(raw);
  if (cachedEntry && cachedEntry.kanbanState && searchMode === "dossier") {
    // Restore from cache instead of re-fetching from API
    if (currentData) {
      const currentPatent = currentData.raw || (currentData.office + currentData.applicationNumber);
      if (currentPatent !== raw && kanbanState.hasUnsavedWork) {
        promptSaveCache(() => doRestoreFromCache(raw));
        return;
      }
    }
    const success = PatentCache.restoreState(cachedEntry);
    if (success) {
      if (patentInput) patentInput.value = raw;
      patentDetailSection.classList.remove("hidden");
      refreshHistoryList();
      showDataSourceBadge("本地缓存", "从缓存恢复，无需重新查询");
      return;
    }
  }

  searchBtn.disabled = true;
  loadingText.textContent = "正在从 Google Patents 获取专利信息...";
  // Show Google Patents + Espacenet links immediately so user can jump if loading takes too long
  if (loadingGpLink) {
    const gpUrl = "https://patents.google.com/patent/" + encodeURIComponent(raw);
    loadingGpLink.href = gpUrl;
    loadingGpLink.onclick = function(e) { e.preventDefault(); openInAppWebview(gpUrl, "Google Patents: " + raw); };
    loadingGpLink.classList.remove("hidden");
  }
  if (loadingEspacenetLink) {
    const espUrl = "https://worldwide.espacenet.com/patent/search?q=" + encodeURIComponent(raw);
    loadingEspacenetLink.onclick = function(e) { e.preventDefault(); openInAppWebview(espUrl, "Espacenet: " + raw); };
    loadingEspacenetLink.classList.remove("hidden");
  }
  loading.classList.remove("hidden");
  resultSection.classList.add("hidden");
  patentDetailSection.classList.add("hidden");
  hideError();

  try {
    const resp = await fetch(gpApiUrl(raw));
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const ct = resp.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      await resp.text();
      throw new Error("服务器返回了非JSON响应");
    }
    const json = await resp.json();

    // 调试信息输出到开发者工具 console
    console.group("%c[PatentLens 调试] " + raw, "color: #4CAF50; font-weight: bold;");
    console.log("API 响应:", json);
    if (json.data) {
      const d = json.data;
      console.log("数据来源:", json.data_source || d.data_source || "Google Patents");
      console.log("标题:", d.title || "(空)");
      console.log("权利要求数量:", (d.claims || []).length);
      if (d.claims && d.claims.length > 0) {
        console.table(d.claims.map(c => ({ 序号: c.num, 类型: c.type, 文本预览: c.text.substring(0, 60) + "..." })));
      }
      console.log("引证专利数量:", (d.patent_citations || []).length);
      if (d.patent_citations && d.patent_citations.length > 0) {
        console.table(d.patent_citations.slice(0, 5).map(c => ({
          专利号: c.patent_number, 标题: (c.title||'').substring(0, 30),
          优先权日: c.priority_date||'(空)', 公开日: c.publication_date||'(空)', 申请人: (c.assignee||'').substring(0, 20),
        })));
      }
      console.log("被引专利数量:", (d.cited_by || []).length);
      if (d.cited_by && d.cited_by.length > 0) {
        console.table(d.cited_by.slice(0, 5).map(c => ({
          专利号: c.patent_number, 标题: (c.title||'').substring(0, 30),
          优先权日: c.priority_date||'(空)', 公开日: c.publication_date||'(空)', 申请人: (c.assignee||'').substring(0, 20),
        })));
      }
      console.log("说明书长度:", (d.description || "").length);
      if (d.description) {
        const headings = d.description.split('\n').filter(l => l.startsWith('## '));
        console.log("说明书标题:", headings.length > 0 ? headings : "(未识别到标题)");
      }
      console.log("完整数据对象:", d);
    }
    console.groupEnd();

    if (!json.success) {
      showError(json.error || "未找到该专利");
      patentDetailSection.classList.add("hidden");
      searchBtn.disabled = false;
      if (loadingGpLink) loadingGpLink.classList.add("hidden");
      if (loadingEspacenetLink) loadingEspacenetLink.classList.add("hidden");
      loading.classList.add("hidden");
      return;
    }

    // Espacenet 降级：在应用内 webview 中打开 Espacenet 页面
    if (json.data_source === "Espacenet" || (json.data && json.data.data_source === "Espacenet")) {
      const espacenetUrl = json.espacenet_url || (json.data && json.data.espacenet_url) || "";
      const pn = json.patent_number || raw;
      searchBtn.disabled = false;
      if (loadingGpLink) loadingGpLink.classList.add("hidden");
      if (loadingEspacenetLink) loadingEspacenetLink.classList.add("hidden");
      loading.classList.add("hidden");
      openInAppWebview(espacenetUrl, "Espacenet: " + pn);
      return;
    }

    renderPatentDetail(json.data);
    window._currentPatentData = json.data;
    _pdPatentCache[raw] = json.data;
    GPCache.set(raw, json.data);
    patentDetailSection.classList.remove("hidden");

    // 显示数据来源标识
    if (json.data_source === "EPO OPS" || (json.data && json.data.data_source === "EPO OPS")) {
      showDataSourceBadge("EPO OPS", "Google Patents 未找到该专利，数据来自 EPO OPS 降级查询");
    } else {
      showDataSourceBadge("Google Patents", null);
    }

    // Record to patent history only (NOT dossier history, to avoid duplicate entries)
    PatentCache.addPatentHistory(raw, {
      applicantName: (json.data.assignees || []).join(", "),
      title: json.data.title || "",
    });
    refreshHistoryList();
  } catch (e) {
    showError("查询失败: " + e.message);
  }

  searchBtn.disabled = false;
  if (loadingGpLink) loadingGpLink.classList.add("hidden");
  if (loadingEspacenetLink) loadingEspacenetLink.classList.add("hidden");
  loading.classList.add("hidden");
}

// ── 应用内 Webview 弹窗（Google Patents / Espacenet 等） ──
function openInAppWebview(url, title, opts) {
  const isElectron = !!(window.electronAPI);
  opts = opts || null;

  // Electron 环境：直接打开独立弹出窗口（popout），支持拖拽到外部、翻译、刷新、外部浏览器打开
  if (isElectron && window.electronAPI && typeof window.electronAPI.openPopoutWindow === "function") {
    window.electronAPI.openPopoutWindow(url, title, opts);
    return;
  }

  // 浏览器环境（非 Electron）：保留原有的 iframe overlay 模式
  const overlayId = "pd-inapp-webview-overlay";
  let overlay = document.getElementById(overlayId);

  let _currentWebviewUrl = url;
  let _isTranslated = false;

  function translateWebview() {
    const container = document.getElementById("pd-inapp-webview-container");
    if (!container) return;
    if (_isTranslated) {
      _isTranslated = false;
      loadUrl(_currentWebviewUrl);
      return;
    }
    _isTranslated = true;
    const translateUrl = "https://translate.google.com/translate?sl=auto&tl=zh-CN&u=" + encodeURIComponent(_currentWebviewUrl);
    loadUrl(translateUrl);
  }

  function loadUrl(targetUrl) {
    _currentWebviewUrl = targetUrl;
    const ifr = document.getElementById("pd-wv-iframe");
    if (ifr) ifr.src = targetUrl;
  }

  function refreshWebview() {
    const ifr = document.getElementById("pd-wv-iframe");
    if (ifr) ifr.src = ifr.src;
  }

  const btnStyle = "cursor:pointer;border:1px solid #bbb;background:#fff;color:#333;font-size:12px;padding:2px 10px;border-radius:4px;transition:all 0.2s;";
  const findBtnStyle = "cursor:pointer;border:1px solid #bbb;background:#fff;color:#333;font-size:12px;padding:2px 8px;border-radius:4px;transition:all 0.2s;width:28px;height:26px;display:inline-flex;align-items:center;justify-content:center;";
  
  const isJplatpat = url.includes("j-platpat.inpit.go.jp");
  let jpInfoBar = "";
  if (isJplatpat) {
    const jpMatch = url.match(/JP-(\d{4})-(\d+)/);
    const jpYear = jpMatch ? jpMatch[1] : "";
    const jpNum = jpMatch ? jpMatch[2] : "";
    const jpDisplayNum = jpYear && jpNum ? jpYear + "-" + jpNum : "";
    const opdUrl = "https://www.j-platpat.inpit.go.jp/p0000";
    jpInfoBar = '<div id="pd-wv-jp-bar" style="display:flex;align-items:center;gap:8px;background:#fff3cd;border-bottom:1px solid #ffc107;padding:6px 14px;font-size:12px;color:#856404;flex-shrink:0;">' +
      '<span style="font-weight:bold;">🇯🇵 J-PlatPat</span>' +
      (jpDisplayNum ? '<span>番号: ' + escapeHtml(jpDisplayNum) + '</span>' : '') +
      '<span style="flex:1;color:#a08030;">如果页面未自动加载文献，请点击「番号照会」或使用下方链接手动查找</span>' +
      '<button id="pd-wv-jp-opd-btn" style="' + btnStyle + '" title="打开番号照会页面">番号照会(OPD)</button>' +
      '<button id="pd-wv-jp-ext-btn" style="' + btnStyle + '" title="外部打开">外部打开</button>' +
      '<button id="pd-wv-jp-close" style="' + findBtnStyle + '" title="关闭提示">✕</button>' +
      '</div>';
  }
  let webviewHtml = `
    <div class="pd-header" style="position:relative;">
      <div class="pd-title" style="font-size:14px;">${escapeHtml(title || url)}</div>
      <div class="pd-links" style="position:absolute;right:0;top:50%;transform:translateY(-50%);display:flex;gap:6px;align-items:center;">
        <button id="pd-wv-find-toggle-btn" style="${btnStyle}" title="在页面内查找 (Ctrl+F)">查找</button>
        <button id="pd-wv-translate-btn" style="${btnStyle}" title="通过 Google 翻译翻译此页面内容">翻译</button>
        <button id="pd-wv-refresh-btn" style="${btnStyle}" title="刷新当前页面">刷新</button>
        <button id="pd-wv-external-btn" style="${btnStyle}" title="在外部浏览器打开">外部浏览器打开</button>
        <button id="pd-wv-close-btn" style="${btnStyle}" title="关闭">✕ 关闭</button>
      </div>
    </div>
    ${jpInfoBar}
    <div id="pd-wv-find-bar" style="display:none;align-items:center;gap:6px;background:#f5f5f5;border-bottom:1px solid #ddd;padding:6px 12px;flex-shrink:0;">
      <input type="text" id="pd-wv-find-input" placeholder="在页面内查找..." style="flex:1;max-width:240px;background:#fff;border:1px solid #ccc;border-radius:4px;padding:4px 8px;font-size:12px;outline:none;">
      <button id="pd-wv-find-prev" style="${findBtnStyle}" title="上一个匹配 (Shift+Enter)">▲</button>
      <button id="pd-wv-find-next" style="${findBtnStyle}" title="下一个匹配 (Enter)">▼</button>
      <span id="pd-wv-find-count" style="font-size:11px;color:#888;min-width:50px;text-align:center;"></span>
      <button id="pd-wv-find-close" style="${findBtnStyle}" title="关闭查找 (Esc)">✕</button>
    </div>
    <div id="pd-inapp-webview-container" style="width:100%;height:calc(100vh - 120px);border:none;position:relative;">
      <iframe id="pd-wv-iframe" src="${escapeHtml(url)}" style="width:100%;height:100%;border:1px solid #ddd;border-radius:8px;"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              allow="clipboard-read; clipboard-write"
              referrerpolicy="no-referrer">
      </iframe>
    </div>`;

  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = overlayId;
    overlay.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;z-index:100000;background:#fff;overflow:auto;";
    document.body.appendChild(overlay);
  }
  overlay.innerHTML = webviewHtml;
  overlay.style.display = "block";

  const gtBar = document.getElementById("google_translate_element");
  if (gtBar) gtBar.style.display = "none";
  document.querySelectorAll(".skiptranslate").forEach(el => { el.dataset.wasVisible = el.style.display; el.style.display = "none"; });

  function bindBtnHover(btn) {
    if (!btn) return;
    btn.addEventListener("mouseenter", function() { this.style.background = "var(--accent, #4f8ff7)"; this.style.color = "#fff"; });
    btn.addEventListener("mouseleave", function() { this.style.background = "#fff"; this.style.color = "#333"; });
  }
  const closeBtn = document.getElementById("pd-wv-close-btn");
  const translateBtn = document.getElementById("pd-wv-translate-btn");
  const refreshBtn = document.getElementById("pd-wv-refresh-btn");
  const externalBtn = document.getElementById("pd-wv-external-btn");
  if (closeBtn) { closeBtn.addEventListener("click", closeInAppWebview); bindBtnHover(closeBtn); }
  if (translateBtn) {
    translateBtn.addEventListener("click", function() {
      translateWebview();
      if (_isTranslated) { this.textContent = "原文"; this.title = "切换回原始页面"; }
      else { this.textContent = "翻译"; this.title = "通过 Google 翻译翻译此页面内容"; }
    });
    bindBtnHover(translateBtn);
  }
  if (refreshBtn) { refreshBtn.addEventListener("click", refreshWebview); bindBtnHover(refreshBtn); }
  if (externalBtn) {
    externalBtn.addEventListener("click", function() {
      window.open(_currentWebviewUrl, "_blank");
    });
    bindBtnHover(externalBtn);
  }

  // ── Webview find-in-page ──
  const wvFindToggleBtn = document.getElementById("pd-wv-find-toggle-btn");
  const wvFindBar = document.getElementById("pd-wv-find-bar");
  const wvFindInput = document.getElementById("pd-wv-find-input");
  const wvFindPrevBtn = document.getElementById("pd-wv-find-prev");
  const wvFindNextBtn = document.getElementById("pd-wv-find-next");
  const wvFindCount = document.getElementById("pd-wv-find-count");
  const wvFindCloseBtn = document.getElementById("pd-wv-find-close");
  const wvIframe = document.getElementById("pd-wv-iframe");
  let wvFindDebounce = null;
  let wvFindCleared = true;

  function wvAdjustContainerHeight() {
    const container = document.getElementById("pd-inapp-webview-container");
    if (!container) return;
    const findBarH = wvFindBar && wvFindBar.style.display !== "none" ? 38 : 0;
    const jpBar = document.getElementById("pd-wv-jp-bar");
    const jpBarH = jpBar && jpBar.style.display !== "none" ? 36 : 0;
    const offset = 120 + findBarH + jpBarH;
    container.style.height = "calc(100vh - " + offset + "px)";
  }

  function wvClearSelection() {
    try {
      if (wvIframe && wvIframe.contentWindow) wvIframe.contentWindow.find("", false, false, false);
    } catch (e) {}
    wvFindCleared = true;
  }

  function doWvFindNext() {
    if (!wvFindInput) return;
    const term = wvFindInput.value;
    if (!term || term.length < 1) return;
    if (wvFindDebounce) { clearTimeout(wvFindDebounce); wvFindDebounce = null; }
    try {
      const win = wvIframe.contentWindow;
      const found = win.find(term, false, false, false, false, true);
      wvFindCount.textContent = found ? "" : "无匹配";
      wvFindCleared = false;
    } catch (e) {
      wvFindCount.textContent = "受限";
    }
  }

  function doWvFindPrev() {
    if (!wvFindInput) return;
    const term = wvFindInput.value;
    if (!term || term.length < 1) return;
    if (wvFindDebounce) { clearTimeout(wvFindDebounce); wvFindDebounce = null; }
    try {
      const win = wvIframe.contentWindow;
      win.find(term, false, true, false, false, true);
      wvFindCleared = false;
    } catch (e) {}
  }

  function doWvNewSearch() {
    const term = wvFindInput.value;
    if (!term || term.length < 1) {
      if (wvFindCount) wvFindCount.textContent = "";
      wvClearSelection();
      return;
    }
    wvClearSelection();
    setTimeout(function() {
      try {
        const win = wvIframe.contentWindow;
        const found = win.find(term, false, false, false, false, true);
        wvFindCount.textContent = found ? "" : "无匹配";
        wvFindCleared = false;
      } catch (e) {
        wvFindCount.textContent = "受限";
      }
    }, 30);
  }

  function wvDebouncedFind() {
    if (wvFindDebounce) clearTimeout(wvFindDebounce);
    wvFindDebounce = setTimeout(function() {
      wvFindDebounce = null;
      doWvNewSearch();
    }, 300);
  }

  if (wvFindToggleBtn) {
    bindBtnHover(wvFindToggleBtn);
    wvFindToggleBtn.addEventListener("click", function() {
      if (!wvFindBar) return;
      const showing = wvFindBar.style.display !== "none";
      wvFindBar.style.display = showing ? "none" : "flex";
      wvAdjustContainerHeight();
      if (!showing && wvFindInput) {
        wvFindInput.focus();
        wvClearSelection();
      } else {
        wvClearSelection();
      }
    });
  }
  if (wvFindInput) {
    wvFindInput.addEventListener("input", function() {
      if (wvFindInput.value.length < 1) {
        if (wvFindDebounce) { clearTimeout(wvFindDebounce); wvFindDebounce = null; }
        wvFindCount.textContent = "";
        wvClearSelection();
        return;
      }
      wvDebouncedFind();
    });
    wvFindInput.addEventListener("keydown", function(e) {
      if (e.key === "Enter") {
        e.preventDefault();
        if (wvFindDebounce) { clearTimeout(wvFindDebounce); wvFindDebounce = null; }
        if (e.shiftKey) doWvFindPrev(); else doWvFindNext();
      } else if (e.key === "Escape") {
        if (wvFindBar) wvFindBar.style.display = "none";
        wvClearSelection();
        wvAdjustContainerHeight();
      }
    });
  }
  if (wvFindPrevBtn) {
    bindBtnHover(wvFindPrevBtn);
    wvFindPrevBtn.addEventListener("click", doWvFindPrev);
  }
  if (wvFindNextBtn) {
    bindBtnHover(wvFindNextBtn);
    wvFindNextBtn.addEventListener("click", doWvFindNext);
  }
  if (wvFindCloseBtn) {
    bindBtnHover(wvFindCloseBtn);
    wvFindCloseBtn.addEventListener("click", function() {
      if (wvFindBar) wvFindBar.style.display = "none";
      wvClearSelection();
      wvAdjustContainerHeight();
    });
  }

  // J-PlatPat info bar buttons
  const wvJpOpdBtn = document.getElementById("pd-wv-jp-opd-btn");
  const wvJpExtBtn = document.getElementById("pd-wv-jp-ext-btn");
  const wvJpCloseBtn = document.getElementById("pd-wv-jp-close");
  if (wvJpOpdBtn) {
    bindBtnHover(wvJpOpdBtn);
    wvJpOpdBtn.addEventListener("click", function() {
      loadUrl("https://www.j-platpat.inpit.go.jp/p0000");
    });
  }
  if (wvJpExtBtn) {
    bindBtnHover(wvJpExtBtn);
    wvJpExtBtn.addEventListener("click", function() {
      window.open(_currentWebviewUrl, "_blank");
    });
  }
  if (wvJpCloseBtn) {
    bindBtnHover(wvJpCloseBtn);
    wvJpCloseBtn.addEventListener("click", function() {
      const jpBar = document.getElementById("pd-wv-jp-bar");
      if (jpBar) {
        jpBar.style.display = "none";
        wvAdjustContainerHeight();
      }
    });
  }

  wvAdjustContainerHeight();

  // Ctrl+F within the webview overlay
  if (overlay) {
    overlay.addEventListener("keydown", function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        if (wvFindBar) {
          wvFindBar.style.display = "flex";
          wvAdjustContainerHeight();
          if (wvFindInput) wvFindInput.focus();
        }
      }
      if (e.key === "Escape" && wvFindBar && wvFindBar.style.display !== "none") {
        e.preventDefault();
        wvFindBar.style.display = "none";
        wvClearSelection();
        wvAdjustContainerHeight();
      }
      if (e.key === "F3") {
        e.preventDefault();
        if (wvFindBar && wvFindBar.style.display === "none") {
          wvFindBar.style.display = "flex";
          wvAdjustContainerHeight();
        }
        if (wvFindDebounce) { clearTimeout(wvFindDebounce); wvFindDebounce = null; }
        if (e.shiftKey) doWvFindPrev(); else doWvFindNext();
      }
    });
  }
}

function closeInAppWebview() {
  const overlay = document.getElementById("pd-inapp-webview-overlay");
  if (overlay) overlay.style.display = "none";

  // 恢复主应用的 Google Translate 悬浮栏及相关元素
  const gtBar = document.getElementById("google_translate_element");
  if (gtBar) gtBar.style.display = "";
  document.querySelectorAll(".skiptranslate").forEach(el => { el.style.display = el.dataset.wasVisible || ""; delete el.dataset.wasVisible; });
}

// 显示数据来源徽章（在专利详情头部显示数据来源）
function showDataSourceBadge(source, tooltip) {
  // 移除旧的徽章
  const oldBadge = document.getElementById("pd-data-source-badge");
  if (oldBadge) oldBadge.remove();

  const header = document.querySelector(".pd-header");
  if (!header) return;

  const badge = document.createElement("div");
  badge.id = "pd-data-source-badge";
  badge.className = "pd-data-source-badge" + (source === "EPO OPS" ? " pd-data-source-ops" : "");
  badge.textContent = "数据来源: " + source;
  if (tooltip) {
    badge.title = tooltip;
    badge.style.cursor = "help";
  }
  header.appendChild(badge);
}

function renderPatentDetail(data) {
  if (!patentDetailContent || !data) return;

  let html = "";

  // Header (always visible)
  html += '<div class="pd-header">';
  html += '<div class="pd-patent-number">' + escapeHtml(data.patent_number) + '</div>';
  html += '<div class="pd-title">' + escapeHtml(data.title || "无标题") + '</div>';
  html += '<div class="pd-links">';
  html += '<button class="pd-ai-ask-btn" onclick="openPatentAsk(\'detail\')" title="针对本篇专利向 AI 提问">AI 问一问</button>';
  html += '<button class="pd-gp-link" onclick="toggleGoogleTranslate()" title="使用 Google 翻译翻译整个页面">网页翻译</button>';
  html += '<button class="pd-gp-link" onclick="openInAppWebview(\'' + escapeHtml(data.url) + '\', \'Google Patents: ' + escapeHtml(data.patent_number) + '\')" title="在应用内打开 Google Patents 页面">Google Patents</button>';
  if (isJPPatent(data.patent_number)) {
    html += '<button class="pd-gp-link" onclick="openJPlatPat(\'' + escapeHtml(data.patent_number) + '\', \'J-PlatPat: ' + escapeHtml(data.patent_number) + '\')" title="在 J-PlatPat（日本专利局）查看" style="background:#e74c3c;color:#fff;border-color:#c0392b;">J-PlatPat</button>';
  }
  html += '<button class="pd-gp-link" onclick="openInAppWebview(\'https://worldwide.espacenet.com/patent/search?q=' + encodeURIComponent(data.patent_number) + '\', \'Espacenet: ' + escapeHtml(data.patent_number) + '\')" title="在应用内打开 Espacenet 页面">Espacenet</button>';
  if (data.pdf_link) {
    html += '<a href="' + escapeHtml(data.pdf_link) + '" target="_blank" rel="noopener" class="pd-pdf-link">PDF原文</a>';
  }
  if (data.external_links && Object.keys(data.external_links).length > 0) {
    html += '<span class="pd-external-links-sep">|</span>';
    for (const [key, link] of Object.entries(data.external_links)) {
      if (link.url) {
        html += '<a href="' + escapeHtml(link.url) + '" target="_blank" rel="noopener" class="pd-external-link">' + escapeHtml(link.text || key) + '</a>';
      }
    }
  }
  html += '</div>';
  html += '</div>';

  // Tab layout container
  html += '<div class="pd-tab-layout">';

  // Left: bookmark tabs (SVG icons)
  html += '<div class="pd-bookmark-tabs">';
  html += '<div class="pd-bookmark-tab active" data-tab="overview" onclick="switchPatentTab(\'overview\')" title="概要"><span class="pd-bm-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></span><span class="pd-bm-label">概要</span></div>';
  html += '<div class="pd-bookmark-tab" data-tab="claims" onclick="switchPatentTab(\'claims\')" title="权利要求"><span class="pd-bm-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg></span><span class="pd-bm-label">权利要求</span></div>';
  html += '<div class="pd-bookmark-tab" data-tab="description" onclick="switchPatentTab(\'description\')" title="说明书"><span class="pd-bm-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="14" y2="11"/></svg></span><span class="pd-bm-label">说明书</span></div>';
  html += '<div class="pd-bookmark-tab" data-tab="references" onclick="switchPatentTab(\'references\')" title="引用文献"><span class="pd-bm-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></span><span class="pd-bm-label">引用</span></div>';
  html += '</div>';

  // Right: tab content panels
  html += '<div class="pd-tab-panels">';

  // ─── Tab 1: Overview ───
  html += '<div class="pd-tab-panel active" data-panel="overview">';

  // Two-column: info left, drawings right
  html += '<div class="pd-overview-layout">';

  // Left column: info
  html += '<div class="pd-overview-info">';

  // AI 解读（位于摘要之前的小区域）
  html += '<div class="pd-section pd-ai-interpret" data-source="detail">';
  html += '<div class="pd-section-title">AI 解读 <button class="pd-ai-interpret-btn" onclick="runPatentInterpretation(\'detail\')">AI 解读</button></div>';
  html += '<div class="pd-ai-interpret-content"><p class="pd-ai-interpret-hint">点击「AI 解读」，基于本篇摘要与权利要求，自动梳理技术问题 / 技术手段 / 技术效果。</p></div>';
  html += '</div>';

  // Abstract
  if (data.abstract) {
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title">摘要</div>';
    html += '<div class="pd-abstract">' + escapeHtml(data.abstract) + '</div>';
    html += '</div>';
  }

  // Basic info grid
  html += '<div class="pd-section">';
  html += '<div class="pd-section-title">基本信息</div>';
  html += '<div class="pd-info-grid">';
  if (data.inventors && data.inventors.length > 0) {
    html += '<div class="pd-info-item"><span class="pd-info-label">发明人</span><span class="pd-info-value">' + escapeHtml(data.inventors.join("; ")) + '</span></div>';
  }
  if (data.assignees && data.assignees.length > 0) {
    html += '<div class="pd-info-item"><span class="pd-info-label">申请人</span><span class="pd-info-value">' + escapeHtml(data.assignees.join("; ")) + '</span></div>';
  }
  if (data.application_date) {
    html += '<div class="pd-info-item"><span class="pd-info-label">申请日期</span><span class="pd-info-value">' + escapeHtml(data.application_date) + '</span></div>';
  }
  if (data.publication_date) {
    html += '<div class="pd-info-item"><span class="pd-info-label">公开日期</span><span class="pd-info-value">' + escapeHtml(data.publication_date) + '</span></div>';
  }
  if (data.priority_date) {
    html += '<div class="pd-info-item"><span class="pd-info-label">优先权日期</span><span class="pd-info-value">' + escapeHtml(data.priority_date) + '</span></div>';
  }
  html += '</div></div>';

  // CPC Classifications
  if (data.classifications && data.classifications.length > 0) {
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title">CPC 分类</div>';
    html += '<div class="pd-classifications">';
    data.classifications.forEach(c => {
      html += '<div class="pd-class-item"><span class="pd-class-code">' + escapeHtml(c.code) + '</span>';
      if (c.description) html += '<span class="pd-class-desc">' + escapeHtml(c.description) + '</span>';
      html += '</div>';
    });
    html += '</div></div>';
  }

  // Landscapes
  if (data.landscapes && data.landscapes.length > 0) {
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title">技术领域</div>';
    html += '<div class="pd-landscapes">';
    data.landscapes.forEach(l => {
      html += '<span class="pd-landscape-tag">' + escapeHtml(l.name) + '</span>';
    });
    html += '</div></div>';
  }

  // Family information
  if (data.family_id || (data.family_applications && data.family_applications.length > 0) || (data.country_status && data.country_status.length > 0)) {
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title">同族信息' + (data.family_id ? ' <span class="pd-family-id">ID: ' + escapeHtml(data.family_id) + '</span>' : '') + '</div>';
    if (data.family_applications && data.family_applications.length > 0) {
      html += '<table class="pd-legal-table"><thead><tr><th>公开号</th><th>标题</th><th>状态</th></tr></thead><tbody>';
      data.family_applications.forEach(fa => {
        html += '<tr>';
        html += '<td><a class="pd-patent-link" data-patent="' + escapeHtml(fa.publication_number) + '">' + escapeHtml(fa.publication_number) + '</a></td>';
        html += '<td>' + escapeHtml(fa.title || "") + '</td>';
        html += '<td>' + escapeHtml(fa.status || "") + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table>';
    }
    if (data.country_status && data.country_status.length > 0) {
      html += '<div class="pd-country-status">';
      data.country_status.forEach(cs => {
        html += '<span class="pd-country-badge">' + escapeHtml(cs.country_code) + '</span>';
      });
      html += '</div>';
    }
    html += '</div>';
  }

  // Legal events
  if (data.legal_events && data.legal_events.length > 0) {
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title">法律事件 (' + data.legal_events.length + ')</div>';
    html += '<table class="pd-legal-table"><thead><tr><th>日期</th><th>代码</th><th>描述</th></tr></thead><tbody>';
    data.legal_events.forEach(le => {
      html += '<tr><td>' + escapeHtml(le.date) + '</td><td>' + escapeHtml(le.code) + '</td><td>' + escapeHtml(le.description) + '</td></tr>';
    });
    html += '</tbody></table></div>';
  }

  // Events timeline
  if (data.events_timeline && data.events_timeline.length > 0) {
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title">事件时间轴</div>';
    html += '<div class="pd-timeline">';
    data.events_timeline.forEach(ev => {
      html += '<div class="pd-timeline-item">';
      html += '<div class="pd-timeline-date">' + escapeHtml(ev.date) + '</div>';
      html += '<div class="pd-timeline-title">' + escapeHtml(ev.title) + '</div>';
      html += '</div>';
    });
    html += '</div></div>';
  }

  html += '</div>'; // pd-overview-info

  // Right column: drawings
  if (data.drawings && data.drawings.length > 0) {
    html += '<div class="pd-overview-drawings">';
    html += '<div class="pd-section-title">附图</div>';
    html += '<div class="pd-drawings-grid">';
    const maxShow = 6;
    data.drawings.slice(0, maxShow).forEach((url, i) => {
      html += '<div class="pd-drawing-item" data-index="' + i + '">';
      html += '<img src="' + escapeHtml(url) + '" alt="Figure ' + (i + 1) + '" loading="lazy">';
      html += '</div>';
    });
    if (data.drawings.length > maxShow) {
      html += '<div class="pd-drawing-more">+' + (data.drawings.length - maxShow) + '</div>';
    }
    html += '</div></div>';
  }

  html += '</div>'; // pd-overview-layout
  html += '</div>'; // panel overview

  // ─── Tab 2: Claims ───
  html += '<div class="pd-tab-panel" data-panel="claims">';
  if (data.claims && data.claims.length > 0) {
    html += '<div class="pd-panel-header">';
    html += '<span class="pd-panel-title">权利要求 (' + data.claims.length + ')</span>';
    html += '<div class="pd-panel-actions">';
    html += '<button class="pd-copy-btn" onclick="copyPatentSectionText(\'claims\')">复制</button>';
    html += '</div></div>';
    html += '<div class="pd-claims-list" data-section-type="claims">';
    // Group claims: each independent claim starts a new group, dependent claims follow
    let currentGroup = null;
    data.claims.forEach((c, i) => {
      const claimType = c.type === 'independent' ? 'independent' : 'dependent';
      const claimClass = c.type === 'independent' ? 'claim-independent' : 'claim-dependent';
      // Start a new group for independent claims
      if (c.type === 'independent') {
        if (currentGroup !== null) {
          html += '</div>'; // close previous group
        }
        currentGroup = i;
        html += '<div class="pd-claim-group">';
        html += '<div class="pd-claim-group-header">独立权利要求 ' + escapeHtml(String(c.num || (i + 1))) + '</div>';
      }
      html += '<div class="pd-claim-item ' + claimClass + '" data-claim-index="' + i + '">';
      html += '<div class="pd-claim-main" style="display:flex;align-items:flex-start;gap:4px;">';
      html += '<span class="pd-claim-num">' + escapeHtml(String(c.num || (i + 1))) + '.</span>';
      html += '<span class="pd-claim-type ' + claimType + '">' + (c.type === 'independent' ? '独立' : '从属') + '</span>';
      html += '<span class="pd-claim-text">' + escapeHtml(c.text) + '</span>';
      html += '<button class="pd-claim-translate-btn" data-claim-index="' + i + '" title="AI 翻译此条权利要求">译</button>';
      html += '</div>';
      html += '<div class="pd-claim-translation" data-claim-translation="' + i + '" style="display:none;margin-top:4px;padding:4px 8px;background:#f0f7ff;border-radius:4px;font-size:13px;color:#333;border-left:3px solid var(--accent);"></div>';
      html += '</div>';
    });
    if (currentGroup !== null) {
      html += '</div>'; // close last group
    }
    html += '</div>';
  } else {
    html += '<div class="pd-empty">暂无权利要求数据</div>';
  }
  html += '</div>'; // panel claims

  // ─── Tab 3: Description ───
  html += '<div class="pd-tab-panel" data-panel="description">';
  if (data.description) {
    html += '<div class="pd-panel-header">';
    html += '<span class="pd-panel-title">说明书</span>';
    html += '<div class="pd-panel-actions">';
    html += '<button class="pd-copy-btn" onclick="copyPatentSectionText(\'description\')">复制</button>';
    html += '</div></div>';
    html += '<div class="pd-description-text" data-section-type="description">' + renderDescriptionHtml(data.description) + '</div>';
  } else {
    html += '<div class="pd-empty">暂无说明书数据</div>';
  }
  html += '</div>'; // panel description

  // ─── Tab 4: References ───
  html += '<div class="pd-tab-panel" data-panel="references">';

  // Patent citations
  if (data.patent_citations && data.patent_citations.length > 0) {
    const _citeNums = data.patent_citations.map(c => c.patent_number).filter(Boolean);
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title pd-section-title-with-action"><span>引用专利 (' + data.patent_citations.length + ')</span>' + _makeCopyNumsBtn(_citeNums) + '</div>';
    html += '<div class="pd-citation-table-wrap"><table class="pd-citation-table"><thead><tr>';
    html += '<th></th><th>专利号</th><th>标题</th><th>优先权日</th><th>公开日</th><th>权利人</th>';
    html += '</tr></thead><tbody>';
    data.patent_citations.forEach(c => {
      html += '<tr>';
      html += '<td class="pd-ct-marker">';
      if (c.citation_type) {
        html += '<span class="pd-citation-marker ' + escapeHtml(c.citation_type) + '" title="' + (c.citation_type === 'examiner' ? '审查员引用' : '申请人引用') + '">' + (c.citation_type === 'examiner' ? '*' : '†') + '</span>';
      }
      html += '</td>';
      html += '<td class="pd-ct-num"><a class="pd-patent-link" data-patent="' + escapeHtml(c.patent_number) + '">' + escapeHtml(c.patent_number) + '</a>';
      html += patentLinkButtons(c.patent_number);
      html += '</td>';
      html += '<td class="pd-ct-title">' + (c.title ? escapeHtml(c.title) : '') + '</td>';
      html += '<td class="pd-ct-date">' + (c.priority_date ? escapeHtml(c.priority_date) : '') + '</td>';
      html += '<td class="pd-ct-date">' + (c.publication_date ? escapeHtml(c.publication_date) : '') + '</td>';
      html += '<td class="pd-ct-assignee">' + (c.assignee ? escapeHtml(c.assignee) : '') + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    html += '<div class="pd-citation-legend"><span class="pd-citation-marker examiner">*</span> 审查员引用 &nbsp; <span class="pd-citation-marker applicant">†</span> 申请人引用</div>';
    html += '</div>';
  }

  // Cited by
  if (data.cited_by && data.cited_by.length > 0) {
    const _citedNums = data.cited_by.map(c => c.patent_number).filter(Boolean);
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title pd-section-title-with-action"><span>被引用专利 (' + data.cited_by.length + ')</span>' + _makeCopyNumsBtn(_citedNums) + '</div>';
    html += '<div class="pd-citation-table-wrap"><table class="pd-citation-table"><thead><tr>';
    html += '<th>专利号</th><th>标题</th><th>优先权日</th><th>公开日</th><th>权利人</th>';
    html += '</tr></thead><tbody>';
    data.cited_by.forEach(c => {
      html += '<tr>';
      html += '<td class="pd-ct-num"><a class="pd-patent-link" data-patent="' + escapeHtml(c.patent_number) + '">' + escapeHtml(c.patent_number) + '</a>';
      html += patentLinkButtons(c.patent_number);
      html += '</td>';
      html += '<td class="pd-ct-title">' + (c.title ? escapeHtml(c.title) : '') + '</td>';
      html += '<td class="pd-ct-date">' + (c.priority_date ? escapeHtml(c.priority_date) : '') + '</td>';
      html += '<td class="pd-ct-date">' + (c.publication_date ? escapeHtml(c.publication_date) : '') + '</td>';
      html += '<td class="pd-ct-assignee">' + (c.assignee ? escapeHtml(c.assignee) : '') + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table></div></div>';
  }

  // Similar documents
  if (data.similar_documents && data.similar_documents.length > 0) {
    const _simNums = data.similar_documents.map(c => c.patent_number).filter(Boolean);
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title pd-section-title-with-action"><span>相似文档 (' + data.similar_documents.length + ')</span>' + _makeCopyNumsBtn(_simNums) + '</div>';
    html += '<div class="pd-citation-table-wrap"><table class="pd-citation-table"><thead><tr>';
    html += '<th>专利号</th><th>标题</th><th>公开日</th>';
    html += '</tr></thead><tbody>';
    data.similar_documents.forEach(c => {
      html += '<tr>';
      html += '<td class="pd-ct-num"><a class="pd-patent-link" data-patent="' + escapeHtml(c.patent_number) + '">' + escapeHtml(c.patent_number) + '</a>';
      html += patentLinkButtons(c.patent_number);
      html += '</td>';
      html += '<td class="pd-ct-title">' + (c.title ? escapeHtml(c.title) : '') + '</td>';
      html += '<td class="pd-ct-date">' + (c.publication_date ? escapeHtml(c.publication_date) : '') + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table></div></div>';
  }

  if ((!data.patent_citations || data.patent_citations.length === 0) && (!data.cited_by || data.cited_by.length === 0) && (!data.similar_documents || data.similar_documents.length === 0)) {
    html += '<div class="pd-empty">暂无引用文献数据</div>';
  }

  html += '</div>'; // panel references

  html += '</div>'; // pd-tab-panels
  html += '</div>'; // pd-tab-layout

  patentDetailContent.innerHTML = html;

  // Bind patent link clicks
  patentDetailContent.querySelectorAll(".pd-patent-link").forEach(link => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const pn = link.dataset.patent;
      if (pn) {
        _openPdPatent(pn);
      }
    });
  });

  // Bind drawing clicks
  patentDetailContent.querySelectorAll(".pd-drawing-item").forEach(item => {
    item.addEventListener("click", () => {
      const idx = parseInt(item.dataset.index);
      openPatentImageViewer(data.drawings, idx);
    });
  });

  // Bind claim translate buttons
  patentDetailContent.querySelectorAll(".pd-claim-translate-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.claimIndex);
      const claimItem = btn.closest('.pd-claim-item');
      if (!isNaN(idx)) translateClaimByIndex(idx, claimItem);
    });
  });
}

// Switch patent detail tab
function switchPatentTab(tabName) {
  const layout = document.querySelector('.pd-tab-layout');
  if (!layout) return;
  layout.querySelectorAll('.pd-bookmark-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  layout.querySelectorAll('.pd-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === tabName));
}

// ── 复制到剪贴板 ──
function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => {
      return _fallbackCopy(text);
    });
  }
  return Promise.resolve(_fallbackCopy(text));
}
function _fallbackCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch(e) {}
  document.body.removeChild(ta);
  return ok;
}

// ── 引用文献复制按钮点击处理 ──
function _handleCopyCitationNums(btn) {
  const numsStr = btn.dataset.nums || "";
  if (!numsStr) return;
  const nums = numsStr.split(",").filter(n => n.trim());
  if (nums.length === 0) return;
  const text = nums.join("\n");
  copyToClipboard(text).then(ok => {
    if (ok) {
      const orig = btn.textContent;
      btn.textContent = "✓ 已复制";
      btn.classList.add("copied");
      setTimeout(() => { btn.textContent = orig; btn.classList.remove("copied"); }, 1500);
    }
  });
}

// ── 生成"复制全部公开号"按钮HTML ──
function _makeCopyNumsBtn(nums) {
  const numsStr = nums.map(n => escapeHtml(n)).join(",");
  return '<button class="pd-copy-nums-btn" onclick="_handleCopyCitationNums(this)" data-nums="' + numsStr + '" title="复制列表中所有专利公开号">复制全部公开号</button>';
}

// Switch patent popup viewer tab (scoped to ppv-content)
function switchPpvTab(tabName) {
  const ppvContent = document.getElementById('ppv-content');
  if (!ppvContent) return;
  const layout = ppvContent.querySelector('.pd-tab-layout');
  if (!layout) return;
  layout.querySelectorAll('.pd-bookmark-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  layout.querySelectorAll('.pd-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === tabName));
}

// Translate patent section using AI
async function translatePatentSection(sectionType) {
  // Find the section container — prefer popup context if active, else main page
  const popupContent = document.getElementById('ppv-content');
  const isPopupActive = popupContent && !popupContent.closest('.hidden');
  let sectionEl;
  if (isPopupActive) {
    sectionEl = popupContent.querySelector('[data-section-type="' + sectionType + '"]');
  }
  if (!sectionEl) {
    sectionEl = document.querySelector('[data-section-type="' + sectionType + '"]');
  }
  if (!sectionEl) return;

  // Check if translation already exists - toggle: restore original text and remove
  const existingResult = sectionEl.querySelector('.pd-translation-result');
  if (existingResult) {
    existingResult.remove();
    // Restore original text
    if (sectionType === 'claims') {
      sectionEl.querySelectorAll('.pd-claim-text[data-original-text]').forEach(el => {
        el.textContent = el.dataset.originalText;
        delete el.dataset.translated;
      });
    } else if (sectionType === 'description') {
      const descEl = sectionEl.querySelector('.pd-description-text[data-original-text]');
      if (descEl) {
        descEl.innerHTML = renderDescriptionHtml(descEl.dataset.originalText);
        delete descEl.dataset.translated;
      }
    }
    return;
  }

  // Show loading spinner in the section
  const loadingEl = document.createElement('div');
  loadingEl.className = 'pd-translation-result';
  loadingEl.id = 'pd-translation-loading-' + sectionType;
  loadingEl.innerHTML = '<div class="pd-translation-header"><span>AI 翻译中...</span></div><div class="pd-translation-body" style="display:flex;align-items:center;gap:8px;"><div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0;"></div><span>正在翻译' + (sectionType === 'claims' ? '权利要求' : '说明书') + '...</span></div>';
  sectionEl.appendChild(loadingEl);

  try {
    // Use the configured translation provider from settings
    const config = window.AI.loadAIConfig();
    const translateProvider = window.AI.getTranslateProvider(config);
    if (!translateProvider || !translateProvider.apiKey) {
      showError("请先在 AI 设置中配置 API Key");
      return;
    }

    let textToTranslate = "";
    const patentData = window._currentPatentData || window._patentPopupData;
    if (sectionType === "claims" && patentData && patentData.claims) {
      textToTranslate = patentData.claims.map((c, i) =>
        "Claim " + (c.num || (i + 1)) + ": " + c.text
      ).join('\n\n');
    } else if (sectionType === "description" && patentData && patentData.description) {
      textToTranslate = patentData.description.substring(0, 6000);
    }

    if (!textToTranslate) {
      showError("没有可翻译的内容");
      return;
    }

    const prompt = sectionType === "claims"
      ? "你是一位专业的专利文献翻译专家。请将以下英文专利权利要求翻译为中文。保持专利术语的准确性，保留所有数字标记，翻译要流畅自然。保持权利要求的编号。只返回翻译结果。"
      : "你是一位专业的专利文献翻译专家。请将以下英文专利说明书翻译为中文。保持专利术语的准确性，保留所有数字标记，翻译要流畅自然。只返回翻译结果。";

    const apiBase = window.AI.buildUrl(translateProvider.type, translateProvider.baseUrl);
    const resp = await fetch(apiBase + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + translateProvider.apiKey,
      },
      body: JSON.stringify({
        model: translateProvider.model,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: textToTranslate }
        ],
        temperature: 0.3,
        max_tokens: 4096,
      }),
    });

    if (!resp.ok) throw new Error("API 请求失败: " + resp.status);
    const json = await resp.json();
    const translated = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content || "翻译失败";

    // Remove loading spinner
    const loadingEl2 = document.getElementById('pd-translation-loading-' + sectionType);
    if (loadingEl2) loadingEl2.remove();

    // Show translation result
    const resultDiv = document.createElement('div');
    resultDiv.className = 'pd-translation-result';
    resultDiv.innerHTML = '<div class="pd-translation-header"><span>AI 翻译结果</span><button class="pd-translation-close" onclick="this.parentElement.parentElement.remove();">&times;</button></div><div class="pd-translation-body">' + escapeHtml(translated).replace(/\n/g, '<br>') + '</div>';

    // Append to the section element (works for both tab and collapsible layouts)
    sectionEl.appendChild(resultDiv);

    // Replace original text with translated version in-place
    if (sectionType === 'claims') {
      const claimItems = sectionEl.querySelectorAll('.pd-claim-item');
      if (claimItems.length > 0) {
        // Parse translated claims and replace each claim text
        const translatedLines = translated.split('\n').filter(l => l.trim());
        let claimIdx = 0;
        claimItems.forEach(item => {
          const claimTextEl = item.querySelector('.pd-claim-text');
          if (claimTextEl && claimIdx < translatedLines.length) {
            // Store original text for restoration
            if (!claimTextEl.dataset.originalText) {
              claimTextEl.dataset.originalText = claimTextEl.textContent;
            }
            claimTextEl.textContent = translatedLines[claimIdx].replace(/^Claim\s*\d+\s*[:：]\s*/i, '');
            claimTextEl.dataset.translated = 'true';
            claimIdx++;
          }
        });
      }
    } else if (sectionType === 'description') {
      const descEl = sectionEl.querySelector('.pd-description-text');
      if (descEl) {
        if (!descEl.dataset.originalText) {
          descEl.dataset.originalText = patentData.description;
        }
        descEl.innerHTML = renderDescriptionHtml(translated);
        descEl.dataset.translated = 'true';
      }
    }
  } catch (e) {
    showError("翻译失败: " + e.message);
    const loadingEl3 = document.getElementById('pd-translation-loading-' + sectionType);
    if (loadingEl3) loadingEl3.remove();
  }
}

// ── Patent Detail Right-Click Context Menu ──
let _patentDetailCtxMenu = null;

function showPatentDetailContextMenu(clientX, clientY, targetSection) {
  hidePatentDetailContextMenu();
  const menu = document.createElement("div");
  menu.className = "pdf-block-context-menu";
  menu.style.left = clientX + "px";
  menu.style.top = clientY + "px";

  const sel = window.getSelection();
  const selectedText = sel ? sel.toString().trim() : "";

  if (selectedText) {
    const translateSelItem = document.createElement("div");
    translateSelItem.className = "pdf-ctx-menu-item";
    translateSelItem.textContent = "翻译选中文本";
    translateSelItem.addEventListener("click", () => {
      hidePatentDetailContextMenu();
      translateSelectedPatentText(selectedText, targetSection);
    });
    menu.appendChild(translateSelItem);
  }

  if (targetSection === "claims" || targetSection === "description") {
    const translateSectionItem = document.createElement("div");
    translateSectionItem.className = "pdf-ctx-menu-item";
    translateSectionItem.textContent = targetSection === "claims" ? "翻译全部权利要求" : "翻译全部说明书";
    translateSectionItem.addEventListener("click", () => {
      hidePatentDetailContextMenu();
      translatePatentSection(targetSection);
    });
    menu.appendChild(translateSectionItem);
  }

  const googleTranslateItem = document.createElement("div");
  googleTranslateItem.className = "pdf-ctx-menu-item";
  googleTranslateItem.textContent = "Google 翻译此页面";
  googleTranslateItem.addEventListener("click", () => {
    hidePatentDetailContextMenu();
    toggleGoogleTranslate();
  });
  menu.appendChild(googleTranslateItem);

  document.body.appendChild(menu);
  _patentDetailCtxMenu = menu;

  // Adjust position if menu overflows viewport
  const r = menu.getBoundingClientRect();
  const maxX = window.innerWidth - 16;
  const maxY = window.innerHeight - 16;
  if (r.right > maxX) menu.style.left = (maxX - r.width) + "px";
  if (r.bottom > maxY) menu.style.top = (maxY - r.height) + "px";
}

function hidePatentDetailContextMenu() {
  if (_patentDetailCtxMenu && _patentDetailCtxMenu.parentNode) {
    _patentDetailCtxMenu.parentNode.removeChild(_patentDetailCtxMenu);
  }
  _patentDetailCtxMenu = null;
}

async function translateSelectedPatentText(text, targetSection) {
  const config = window.AI.loadAIConfig();
  const translateProvider = window.AI.getTranslateProvider(config);
  if (!translateProvider || !translateProvider.apiKey) {
    showError("请先在 AI 设置中配置 API Key");
    return;
  }

  // Get selection position for the floating popup
  let posX = 100, posY = 100;
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    posX = rect.left;
    posY = rect.bottom + 8;
  }

  // Remove existing translation popup if any
  const existingPopup = document.getElementById("pd-selected-translation-popup");
  if (existingPopup) existingPopup.remove();

  // Create floating popup
  const popup = document.createElement('div');
  popup.id = "pd-selected-translation-popup";
  popup.style.cssText = 'position:fixed;left:' + posX + 'px;top:' + posY + 'px;z-index:100010;max-width:420px;min-width:180px;padding:10px 14px;background:#fff;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.18);border:1px solid #e0e0e0;font-size:13px;color:#333;line-height:1.6;';
  popup.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><span style="font-size:11px;color:#888;">AI 翻译</span><button id="pd-selected-translation-close" style="border:none;background:transparent;cursor:pointer;font-size:16px;color:#999;padding:0 4px;line-height:1;">&times;</button></div><div id="pd-selected-translation-body"><div style="display:flex;align-items:center;gap:8px;"><div class="spinner" style="width:14px;height:14px;border-width:2px;margin:0;"></div><span style="font-size:12px;color:#888;">翻译中...</span></div></div>';
  document.body.appendChild(popup);

  // Close button
  const closeBtn = document.getElementById("pd-selected-translation-close");
  if (closeBtn) closeBtn.addEventListener("click", () => popup.remove());

  // Adjust position if popup overflows viewport
  requestAnimationFrame(() => {
    const r = popup.getBoundingClientRect();
    if (r.right > window.innerWidth - 10) popup.style.left = Math.max(10, window.innerWidth - r.width - 10) + 'px';
    if (r.bottom > window.innerHeight - 10) popup.style.top = Math.max(10, posY - r.height - 16) + 'px';
  });

  const bodyEl = document.getElementById("pd-selected-translation-body");

  try {
    let fullResponse = "";
    let _rafPending = false;
    const stream = window.AI.streamChat(translateProvider.type, translateProvider.apiKey, translateProvider.baseUrl, {
      model: translateProvider.model,
      messages: [
        { role: "system", content: "你是一位专业的专利文献翻译专家。请将以下文本翻译为中文。保持专利术语的准确性，保留所有数字标记，翻译要流畅自然。只返回翻译结果。" },
        { role: "user", content: text }
      ],
      temperature: 0.3,
      maxTokens: 4096,
    });

    for await (const chunk of stream) {
      if (chunk.content) {
        fullResponse += chunk.content;
        if (!_rafPending) {
          _rafPending = true;
          requestAnimationFrame(() => {
            if (bodyEl) bodyEl.innerHTML = escapeHtml(fullResponse).replace(/\n/g, '<br>');
            _rafPending = false;
          });
        }
      }
    }
    if (bodyEl) bodyEl.innerHTML = escapeHtml(fullResponse).replace(/\n/g, '<br>');
  } catch (e) {
    if (bodyEl) bodyEl.innerHTML = '<span style="color:var(--danger);">翻译失败: ' + escapeHtml(e.message) + '</span>';
  }
}

// Translate a single claim by index
async function translateClaimByIndex(claimIndex, containerEl) {
  const patentData = window._currentPatentData || window._patentPopupData;
  if (!patentData || !patentData.claims || !patentData.claims[claimIndex]) return;

  const claim = patentData.claims[claimIndex];
  const root = containerEl || document;
  const translationEl = root.querySelector('[data-claim-translation="' + claimIndex + '"]');
  const btn = root.querySelector('.pd-claim-translate-btn[data-claim-index="' + claimIndex + '"]');
  if (!translationEl) return;

  // If already showing translation, toggle off
  if (translationEl.style.display !== 'none' && translationEl.dataset.translated === '1') {
    translationEl.style.display = 'none';
    translationEl.dataset.translated = '0';
    if (btn) btn.textContent = '译';
    return;
  }

  // Show loading
  translationEl.style.display = 'block';
  translationEl.dataset.translated = '0';
  translationEl.innerHTML = '<span style="color:#888;">翻译中...</span>';
  if (btn) { btn.textContent = '...'; btn.disabled = true; }

  try {
    const config = window.AI.loadAIConfig();
    const translateProvider = window.AI.getTranslateProvider(config);
    if (!translateProvider || !translateProvider.apiKey) {
      translationEl.innerHTML = '<span style="color:var(--danger);">请先配置 AI API Key</span>';
      if (btn) { btn.textContent = '译'; btn.disabled = false; }
      return;
    }

    const textToTranslate = (claim.num ? 'Claim ' + claim.num + ': ' : '') + claim.text;
    let fullResponse = "";
    let _rafPending = false;
    const stream = window.AI.streamChat(translateProvider.type, translateProvider.apiKey, translateProvider.baseUrl, {
      model: translateProvider.model,
      messages: [
        { role: "system", content: "你是一位专业的专利文献翻译专家。请将以下英文专利权利要求翻译为中文。保持专利术语的准确性，保留所有数字标记，翻译要流畅自然。只返回翻译结果，不要添加解释。" },
        { role: "user", content: textToTranslate }
      ],
      temperature: 0.3,
      maxTokens: 2048,
    });

    for await (const chunk of stream) {
      if (chunk.content) {
        fullResponse += chunk.content;
        if (!_rafPending) {
          _rafPending = true;
          requestAnimationFrame(() => {
            translationEl.innerHTML = escapeHtml(fullResponse).replace(/\n/g, '<br>');
            _rafPending = false;
          });
        }
      }
    }
    translationEl.innerHTML = escapeHtml(fullResponse).replace(/\n/g, '<br>');
    translationEl.dataset.translated = '1';
    if (btn) { btn.textContent = '✓'; btn.disabled = false; }
  } catch (e) {
    translationEl.innerHTML = '<span style="color:var(--danger);">翻译失败: ' + escapeHtml(e.message) + '</span>';
    if (btn) { btn.textContent = '译'; btn.disabled = false; }
  }
}

// Copy patent section text to clipboard
function copyPatentSectionText(sectionType) {
  let text = "";
  const patentData = window._currentPatentData || window._patentPopupData;
  if (sectionType === "claims" && patentData && patentData.claims) {
    text = patentData.claims.map((c, i) => c.text).join('\n\n');
  } else if (sectionType === "description" && patentData && patentData.description) {
    text = patentData.description;
  }

  if (!text) {
    showError("没有可复制的内容");
    return;
  }

  navigator.clipboard.writeText(text).then(() => {
    const sectionEl = document.querySelector('[data-section-type="' + sectionType + '"]');
    if (!sectionEl) return;
    const copyBtn = sectionEl.querySelector('.pd-copy-btn');
    if (!copyBtn) return;
    const origText = copyBtn.textContent;
    copyBtn.textContent = '已复制';
    setTimeout(() => { copyBtn.textContent = origText; }, 1500);
  }).catch(() => {
    showError("复制失败");
  });
}

// ── Google Translate Widget Injection ──
let _googleTranslateInjected = false;
let _googleTranslateActive = false;

function toggleGoogleTranslate() {
  // If translation is already active, toggle off
  if (_googleTranslateActive) {
    const gtEls = document.querySelectorAll("#goog-gt-tt, .goog-te-spinner-pos");
    gtEls.forEach(el => el.remove());
    document.body.style.top = "";
    // Reset the Google Translate combo to original language
    const combo = document.querySelector(".goog-te-combo");
    if (combo) {
      combo.value = "";
      combo.dispatchEvent(new Event("change", { bubbles: true }));
    }
    _googleTranslateActive = false;
    return;
  }

  // If the Google Translate widget is already injected, auto-select Chinese
  const combo = document.querySelector(".goog-te-combo");
  if (combo) {
    combo.value = "zh-CN";
    combo.dispatchEvent(new Event("change", { bubbles: true }));
    _googleTranslateActive = true;
    return;
  }

  // Inject Google Translate widget
  _googleTranslateInjected = true;
  const container = document.createElement("div");
  container.id = "google_translate_element";
  container.style.cssText = "position:fixed;top:0;left:0;z-index:999999;";
  document.body.prepend(container);

  window.googleTranslateElementInit = function() {
    new google.translate.TranslateElement({
      pageLanguage: "auto",
      includedLanguages: "zh-CN,zh-TW,en,ja,ko,de,fr",
      layout: google.translate.TranslateElement.InlineLayout.SIMPLE,
      autoDisplay: true
    }, "google_translate_element");
    // 自动选择中文翻译
    setTimeout(() => {
      const combo = document.querySelector(".goog-te-combo");
      if (combo) {
        combo.value = "zh-CN";
        combo.dispatchEvent(new Event("change", { bubbles: true }));
        _googleTranslateActive = true;
      }
    }, 1500);
  };

  const script = document.createElement("script");
  script.id = "google-translate-script";
  script.type = "text/javascript";
  script.src = "https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit";
  script.onerror = function() {
    showError("无法加载 Google 翻译组件，请检查网络连接（可能需要代理）");
    _googleTranslateInjected = false;
    container.remove();
  };
  document.head.appendChild(script);
}

// Simple fullscreen image viewer for patent drawings
function openPatentImageViewer(images, startIndex) {
  let viewer = document.getElementById("patent-image-viewer");
  if (!viewer) {
    viewer = document.createElement("div");
    viewer.id = "patent-image-viewer";
    viewer.className = "patent-image-viewer";
    document.body.appendChild(viewer);
  }
  let currentIdx = startIndex || 0;

  function render() {
    viewer.innerHTML = '';
    viewer.style.display = 'flex';
    const img = document.createElement("img");
    img.src = images[currentIdx];
    img.className = "piv-image";
    img.alt = "Figure " + (currentIdx + 1);
    viewer.appendChild(img);

    const controls = document.createElement("div");
    controls.className = "piv-controls";
    controls.innerHTML = '<button class="piv-btn piv-prev"' + (currentIdx <= 0 ? ' disabled' : '') + '>&#9664; 上一张</button>'
      + '<span class="piv-counter">' + (currentIdx + 1) + ' / ' + images.length + '</span>'
      + '<button class="piv-btn piv-next"' + (currentIdx >= images.length - 1 ? ' disabled' : '') + '>下一张 &#9654;</button>'
      + '<button class="piv-btn piv-close">✕ 关闭</button>';
    viewer.appendChild(controls);

    controls.querySelector(".piv-prev").addEventListener("click", (e) => { e.stopPropagation(); if (currentIdx > 0) { currentIdx--; render(); } });
    controls.querySelector(".piv-next").addEventListener("click", (e) => { e.stopPropagation(); if (currentIdx < images.length - 1) { currentIdx++; render(); } });
    controls.querySelector(".piv-close").addEventListener("click", (e) => { e.stopPropagation(); viewer.style.display = 'none'; });
  }

  render();
  viewer.addEventListener("click", (e) => { if (e.target === viewer) viewer.style.display = 'none'; });
}

// ── 在文本中识别专利号并转为可跳转链接 ──
function linkifyPatentNumbers(text) {
  // Match patent numbers in two formats:
  // 1. Compact: US12345678B2, EP4252965A3, CN119052083A, WO2024123456A1
  // 2. Spaced: US 2019/0009398, US 2019/0308309, EP 4252965 A3
  // Only replace in text nodes, not inside HTML tags
  const parts = text.split(/(<[^>]+>)/);
  return parts.map((part, i) => {
    if (i % 2 === 1) return part; // HTML tag, skip
    // First handle spaced format: "US 2019/0009398" → "US20190009398"
    let result = part.replace(/\b([A-Z]{2})\s+(\d{4})\s*\/\s*(\d{4,7})\s*([A-Z]\d?)?\b/g, (match, country, year, num, kind) => {
      const pn = country + year + num + (kind || '');
      return '<a class="pd-patent-link-inline" data-patent="' + pn + '" title="点击查询 ' + pn + ' 专利原文（Ctrl+点击跳转 Google Patents）">' + match + '</a>';
    });
    // Then handle spaced format without slash: "US 20190308309" or "EP 4252965 A3"
    result = result.replace(/\b([A-Z]{2})\s+(\d{5,})\s*([A-Z]\d?)?\b/g, (match, country, num, kind) => {
      // Skip if already wrapped in a link
      if (match.length < 7) return match;
      const pn = country + num + (kind || '');
      return '<a class="pd-patent-link-inline" data-patent="' + pn + '" title="点击查询 ' + pn + ' 专利原文（Ctrl+点击跳转 Google Patents）">' + match + '</a>';
    });
    // Finally handle compact format: US12345678B2
    // Track positions already inside links to avoid double-wrapping
    const linkRanges = [];
    const linkRegex = /<a[^>]*class="pd-patent-link-inline"[^>]*>/g;
    let lr;
    while ((lr = linkRegex.exec(result)) !== null) {
      const linkStart = lr.index;
      const linkEnd = result.indexOf('</a>', linkStart);
      if (linkEnd !== -1) linkRanges.push([linkStart, linkEnd + 4]);
    }
    result = result.replace(/\b([A-Z]{2}\d{5,}[A-Z]?\d?)\b/g, (match, pn, offset) => {
      if (match.length < 7) return match;
      // Skip if this position is already inside a link
      for (const [s, e] of linkRanges) {
        if (offset >= s && offset < e) return match;
      }
      return '<a class="pd-patent-link-inline" data-patent="' + pn + '" title="点击查询 ' + pn + ' 专利原文（Ctrl+点击跳转 Google Patents）">' + pn + '</a>';
    });
    return result;
  }).join("");
}

// Auto-prefetch patent data for inline links after AI analysis
let _prefetchCache = {}; // short-lived cache, cleared when leaving analysis

function prefetchPatentLinks() {
  const links = document.querySelectorAll("#analysis-content .pd-patent-link-inline, .kanban-analysis-content .pd-patent-link-inline");
  if (links.length === 0) return;

  let fetched = 0;
  const MAX_PREFETCH = 10; // limit to avoid overwhelming the server

  links.forEach(link => {
    if (fetched >= MAX_PREFETCH) return;
    const pn = link.dataset.patent;
    if (!pn || _prefetchCache[pn]) return;

    fetched++;
    fetch(gpApiUrl(pn))
      .then(r => r.json())
      .then(json => {
        if (json.success) {
          _prefetchCache[pn] = json.data;
        }
      })
      .catch(() => {}); // silently fail
  });
}

function clearPrefetchCache() {
  _prefetchCache = {};
  // Also clear PDF doc cache when starting a new search
  if (typeof _pdfDocCache !== 'undefined') _pdfDocCache = {};
}

// Global handler for inline patent links (delegated)
document.addEventListener("click", (e) => {
  const link = e.target.closest(".pd-patent-link-inline");
  if (link) {
    e.preventDefault();
    const pn = link.dataset.patent;
    if (pn) {
      // Ctrl/Cmd+Click: open in app webview (Google Patents for all, JP button available separately)
      if (e.ctrlKey || e.metaKey) {
        openInAppWebview("https://patents.google.com/patent/" + encodeURIComponent(pn), "Google Patents: " + pn);
        return;
      }
      // Normal click: open patent popup viewer
      openPatentPopup(pn);
    }
  }
});

// ── Patent Popup Viewer ──
let _patentPopupData = null; // cached patent data for the popup
let _ppvOpenPatents = []; // [{patentNumber, data, html}] - all opened patents in this session
let _ppvActivePatent = ""; // currently active patent number
let _patentPopupCache = {}; // { patentNumber: { data: ..., html: ..., timestamp: ... } }
const PATENT_POPUP_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Clean expired popup cache entries every 30 minutes
setInterval(() => {
  const now = Date.now();
  Object.keys(_patentPopupCache).forEach(key => {
    if (now - _patentPopupCache[key].timestamp >= PATENT_POPUP_CACHE_TTL) {
      delete _patentPopupCache[key];
    }
  });
}, 30 * 60 * 1000);

function _bindPpvContentEvents(content, data) {
  // Bind drawing clicks
  content.querySelectorAll(".pd-drawing-item").forEach(item => {
    item.addEventListener("click", () => {
      const idx = parseInt(item.dataset.index);
      openPatentImageViewer(data.drawings, idx);
    });
  });
  // Bind patent link clicks (for references tab)
  content.querySelectorAll(".pd-patent-link").forEach(link => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      const pn = link.dataset.patent;
      if (pn) openPatentPopup(pn);
    });
  });
  // Bind claim translate buttons
  content.querySelectorAll(".pd-claim-translate-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.claimIndex);
      const claimItem = btn.closest('.pd-claim-item');
      if (!isNaN(idx)) translateClaimByIndex(idx, claimItem);
    });
  });

  // Right-click context menu for popup patent content
  content.addEventListener("contextmenu", (ev) => {
    let targetSection = "";
    const claimsEl = ev.target.closest('[data-section-type="claims"]');
    const descEl = ev.target.closest('[data-section-type="description"]');
    if (claimsEl) targetSection = "claims";
    else if (descEl) targetSection = "description";

    if (targetSection || window.getSelection().toString().trim()) {
      ev.preventDefault();
      showPatentDetailContextMenu(ev.clientX, ev.clientY, targetSection);
    }
  });
}

function _renderPpvPatentTabs() {
  const tabsBar = document.getElementById("ppv-patent-tabs");
  if (!tabsBar) return;
  let html = "";
  _ppvOpenPatents.forEach(entry => {
    const isActive = entry.patentNumber === _ppvActivePatent;
    html += '<div class="ppv-patent-tab' + (isActive ? ' active' : '') + '" data-pn="' + escapeHtml(entry.patentNumber) + '" onclick="switchPpvPatent(\'' + escapeHtml(entry.patentNumber) + '\')">';
    html += '<span class="ppv-patent-tab-label">' + escapeHtml(entry.patentNumber) + '</span>';
    html += '<span class="ppv-patent-tab-close" onclick="event.stopPropagation(); closePpvPatentTab(\'' + escapeHtml(entry.patentNumber) + '\')">&times;</span>';
    html += '</div>';
  });
  tabsBar.innerHTML = html;
}

function renderPatentPopupContent(data) {
  let html = "";

  // Tab layout container
  html += '<div class="pd-tab-layout">';

  // Left: bookmark tabs (SVG icons)
  html += '<div class="pd-bookmark-tabs">';
  html += '<div class="pd-bookmark-tab active" data-tab="overview" onclick="switchPpvTab(\'overview\')" title="概要"><span class="pd-bm-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></span><span class="pd-bm-label">概要</span></div>';
  html += '<div class="pd-bookmark-tab" data-tab="claims" onclick="switchPpvTab(\'claims\')" title="权利要求"><span class="pd-bm-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg></span><span class="pd-bm-label">权利要求</span></div>';
  html += '<div class="pd-bookmark-tab" data-tab="description" onclick="switchPpvTab(\'description\')" title="说明书"><span class="pd-bm-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="14" y2="11"/></svg></span><span class="pd-bm-label">说明书</span></div>';
  html += '<div class="pd-bookmark-tab" data-tab="references" onclick="switchPpvTab(\'references\')" title="引用文献"><span class="pd-bm-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg></span><span class="pd-bm-label">引用</span></div>';
  html += '</div>';

  // Right: tab content panels
  html += '<div class="pd-tab-panels">';

  // ─── Tab 1: Overview ───
  html += '<div class="pd-tab-panel active" data-panel="overview">';

  // AI 解读（位于摘要之前的小区域）
  html += '<div class="pd-section pd-ai-interpret" data-source="popup">';
  html += '<div class="pd-section-title">AI 解读 <button class="pd-ai-interpret-btn" onclick="runPatentInterpretation(\'popup\')">AI 解读</button></div>';
  html += '<div class="pd-ai-interpret-content"><p class="pd-ai-interpret-hint">点击「AI 解读」，基于本篇摘要与权利要求，自动梳理技术问题 / 技术手段 / 技术效果。</p></div>';
  html += '</div>';

  // Abstract
  if (data.abstract) {
    html += '<div class="pd-section"><div class="pd-section-title">摘要</div><div class="pd-abstract">' + escapeHtml(data.abstract) + '</div></div>';
  }

  // Basic info grid
  html += '<div class="pd-section"><div class="pd-section-title">基本信息</div><div class="pd-info-grid">';
  if (data.inventors && data.inventors.length > 0) {
    html += '<div class="pd-info-item"><span class="pd-info-label">发明人</span><span class="pd-info-value">' + escapeHtml(data.inventors.join("; ")) + '</span></div>';
  }
  if (data.assignees && data.assignees.length > 0) {
    html += '<div class="pd-info-item"><span class="pd-info-label">申请人</span><span class="pd-info-value">' + escapeHtml(data.assignees.join("; ")) + '</span></div>';
  }
  if (data.application_date) {
    html += '<div class="pd-info-item"><span class="pd-info-label">申请日期</span><span class="pd-info-value">' + escapeHtml(data.application_date) + '</span></div>';
  }
  if (data.publication_date) {
    html += '<div class="pd-info-item"><span class="pd-info-label">公开日期</span><span class="pd-info-value">' + escapeHtml(data.publication_date) + '</span></div>';
  }
  if (data.priority_date) {
    html += '<div class="pd-info-item"><span class="pd-info-label">优先权日期</span><span class="pd-info-value">' + escapeHtml(data.priority_date) + '</span></div>';
  }
  html += '</div></div>';

  // CPC Classifications
  if (data.classifications && data.classifications.length > 0) {
    html += '<div class="pd-section"><div class="pd-section-title">CPC 分类</div><div class="pd-classifications">';
    data.classifications.forEach(c => {
      html += '<div class="pd-class-item"><span class="pd-class-code">' + escapeHtml(c.code) + '</span>';
      if (c.description) html += '<span class="pd-class-desc">' + escapeHtml(c.description) + '</span>';
      html += '</div>';
    });
    html += '</div></div>';
  }

  // Landscapes (技术领域)
  if (data.landscapes && data.landscapes.length > 0) {
    html += '<div class="pd-section"><div class="pd-section-title">技术领域</div><div class="pd-landscapes">';
    data.landscapes.forEach(l => {
      html += '<span class="pd-landscape-tag">' + escapeHtml(l.name) + '</span>';
    });
    html += '</div></div>';
  }

  // Family information (同族信息)
  if (data.family_id || (data.family_applications && data.family_applications.length > 0) || (data.country_status && data.country_status.length > 0)) {
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title">同族信息' + (data.family_id ? ' <span class="pd-family-id">ID: ' + escapeHtml(data.family_id) + '</span>' : '') + '</div>';
    if (data.family_applications && data.family_applications.length > 0) {
      html += '<table class="pd-legal-table"><thead><tr><th>公开号</th><th>标题</th><th>状态</th></tr></thead><tbody>';
      data.family_applications.forEach(fa => {
        html += '<tr>';
        html += '<td><a class="pd-patent-link" data-patent="' + escapeHtml(fa.publication_number) + '">' + escapeHtml(fa.publication_number) + '</a></td>';
        html += '<td>' + escapeHtml(fa.title || "") + '</td>';
        html += '<td>' + escapeHtml(fa.status || "") + '</td>';
        html += '</tr>';
      });
      html += '</tbody></table>';
    }
    if (data.country_status && data.country_status.length > 0) {
      html += '<div class="pd-country-status">';
      data.country_status.forEach(cs => {
        html += '<span class="pd-country-badge">' + escapeHtml(cs.country_code) + '</span>';
      });
      html += '</div>';
    }
    html += '</div>';
  }

  // Drawings
  if (data.drawings && data.drawings.length > 0) {
    html += '<div class="pd-section"><div class="pd-section-title">附图</div><div class="pd-drawings-grid">';
    const maxShow = 6;
    data.drawings.slice(0, maxShow).forEach((url, i) => {
      html += '<div class="pd-drawing-item" data-index="' + i + '">';
      html += '<img src="' + escapeHtml(url) + '" alt="Figure ' + (i + 1) + '" loading="lazy">';
      html += '</div>';
    });
    if (data.drawings.length > maxShow) {
      html += '<div class="pd-drawing-more" onclick="openPatentImageViewer(window._patentPopupData.drawings, ' + maxShow + ')">+' + (data.drawings.length - maxShow) + '</div>';
    }
    html += '</div></div>';
  }

  // Events timeline
  if (data.events_timeline && data.events_timeline.length > 0) {
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title">事件时间轴</div>';
    html += '<div class="pd-timeline">';
    [...data.events_timeline].reverse().forEach(ev => {
      html += '<div class="pd-timeline-item"><div class="pd-timeline-date">' + escapeHtml(ev.date) + '</div><div class="pd-timeline-title">' + escapeHtml(ev.title) + '</div></div>';
    });
    html += '</div></div>';
  }

  // Legal events
  if (data.legal_events && data.legal_events.length > 0) {
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title">法律事件 (' + data.legal_events.length + ')</div>';
    html += '<table class="pd-legal-table"><thead><tr><th>日期</th><th>代码</th><th>描述</th></tr></thead><tbody>';
    [...data.legal_events].reverse().forEach(ev => {
      html += '<tr><td>' + escapeHtml(ev.date) + '</td><td>' + escapeHtml(ev.code || "-") + '</td><td>' + escapeHtml(ev.description || ev.title || "-") + '</td></tr>';
    });
    html += '</tbody></table></div>';
  }

  html += '</div>'; // panel overview

  // ─── Tab 2: Claims ───
  html += '<div class="pd-tab-panel" data-panel="claims">';
  if (data.claims && data.claims.length > 0) {
    html += '<div class="pd-panel-header">';
    html += '<span class="pd-panel-title">权利要求 (' + data.claims.length + ')</span>';
    html += '<div class="pd-panel-actions">';
    html += '<button class="pd-copy-btn" onclick="copyPatentSectionText(\'claims\')">复制</button>';
    html += '</div></div>';
    html += '<div class="pd-claims-list" data-section-type="claims">';
    // Group claims: each independent claim starts a new group, dependent claims follow
    let currentGroup = null;
    data.claims.forEach((c, i) => {
      const claimType = c.type === 'independent' ? 'independent' : 'dependent';
      const claimClass = c.type === 'independent' ? 'claim-independent' : 'claim-dependent';
      // Start a new group for independent claims
      if (c.type === 'independent') {
        if (currentGroup !== null) {
          html += '</div>'; // close previous group
        }
        currentGroup = i;
        html += '<div class="pd-claim-group">';
        html += '<div class="pd-claim-group-header">独立权利要求 ' + escapeHtml(String(c.num || (i + 1))) + '</div>';
      }
      html += '<div class="pd-claim-item ' + claimClass + '" data-claim-index="' + i + '">';
      html += '<div class="pd-claim-main" style="display:flex;align-items:flex-start;gap:4px;">';
      html += '<span class="pd-claim-num">' + escapeHtml(String(c.num || (i + 1))) + '.</span>';
      html += '<span class="pd-claim-type ' + claimType + '">' + (c.type === 'independent' ? '独立' : '从属') + '</span>';
      html += '<span class="pd-claim-text">' + escapeHtml(c.text) + '</span>';
      html += '<button class="pd-claim-translate-btn" data-claim-index="' + i + '" title="AI 翻译此条权利要求">译</button>';
      html += '</div>';
      html += '<div class="pd-claim-translation" data-claim-translation="' + i + '" style="display:none;margin-top:4px;padding:4px 8px;background:#f0f7ff;border-radius:4px;font-size:13px;color:#333;border-left:3px solid var(--accent);"></div>';
      html += '</div>';
    });
    if (currentGroup !== null) {
      html += '</div>'; // close last group
    }
    html += '</div>';
  } else {
    html += '<div class="pd-empty">暂无权利要求数据</div>';
  }
  html += '</div>'; // panel claims

  // ─── Tab 3: Description ───
  html += '<div class="pd-tab-panel" data-panel="description">';
  if (data.description) {
    html += '<div class="pd-panel-header">';
    html += '<span class="pd-panel-title">说明书</span>';
    html += '<div class="pd-panel-actions">';
    html += '<button class="pd-copy-btn" onclick="copyPatentSectionText(\'description\')">复制</button>';
    html += '</div></div>';
    html += '<div class="pd-description-text" data-section-type="description">' + renderDescriptionHtml(data.description) + '</div>';
  } else {
    html += '<div class="pd-empty">暂无说明书数据</div>';
  }
  html += '</div>'; // panel description

  // ─── Tab 4: References ───
  html += '<div class="pd-tab-panel" data-panel="references">';

  // Patent citations
  if (data.patent_citations && data.patent_citations.length > 0) {
    const _citeNums = data.patent_citations.map(c => c.patent_number).filter(Boolean);
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title pd-section-title-with-action"><span>引用专利 (' + data.patent_citations.length + ')</span>' + _makeCopyNumsBtn(_citeNums) + '</div>';
    html += '<div class="pd-citation-table-wrap"><table class="pd-citation-table"><thead><tr>';
    html += '<th></th><th>专利号</th><th>标题</th><th>优先权日</th><th>公开日</th><th>权利人</th>';
    html += '</tr></thead><tbody>';
    data.patent_citations.forEach(c => {
      html += '<tr>';
      html += '<td class="pd-ct-marker">';
      if (c.citation_type) {
        html += '<span class="pd-citation-marker ' + escapeHtml(c.citation_type) + '" title="' + (c.citation_type === 'examiner' ? '审查员引用' : '申请人引用') + '">' + (c.citation_type === 'examiner' ? '*' : '†') + '</span>';
      }
      html += '</td>';
      html += '<td class="pd-ct-num"><a class="pd-patent-link" data-patent="' + escapeHtml(c.patent_number) + '">' + escapeHtml(c.patent_number) + '</a>';
      html += patentLinkButtons(c.patent_number);
      html += '</td>';
      html += '<td class="pd-ct-title">' + (c.title ? escapeHtml(c.title) : '') + '</td>';
      html += '<td class="pd-ct-date">' + (c.priority_date ? escapeHtml(c.priority_date) : '') + '</td>';
      html += '<td class="pd-ct-date">' + (c.publication_date ? escapeHtml(c.publication_date) : '') + '</td>';
      html += '<td class="pd-ct-assignee">' + (c.assignee ? escapeHtml(c.assignee) : '') + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    html += '<div class="pd-citation-legend"><span class="pd-citation-marker examiner">*</span> 审查员引用 &nbsp; <span class="pd-citation-marker applicant">†</span> 申请人引用</div>';
    html += '</div>';
  }

  // Cited by
  if (data.cited_by && data.cited_by.length > 0) {
    const _citedNums = data.cited_by.map(c => c.patent_number).filter(Boolean);
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title pd-section-title-with-action"><span>被引用专利 (' + data.cited_by.length + ')</span>' + _makeCopyNumsBtn(_citedNums) + '</div>';
    html += '<div class="pd-citation-table-wrap"><table class="pd-citation-table"><thead><tr>';
    html += '<th>专利号</th><th>标题</th><th>优先权日</th><th>公开日</th><th>权利人</th>';
    html += '</tr></thead><tbody>';
    data.cited_by.forEach(c => {
      html += '<tr>';
      html += '<td class="pd-ct-num"><a class="pd-patent-link" data-patent="' + escapeHtml(c.patent_number) + '">' + escapeHtml(c.patent_number) + '</a>';
      html += patentLinkButtons(c.patent_number);
      html += '</td>';
      html += '<td class="pd-ct-title">' + (c.title ? escapeHtml(c.title) : '') + '</td>';
      html += '<td class="pd-ct-date">' + (c.priority_date ? escapeHtml(c.priority_date) : '') + '</td>';
      html += '<td class="pd-ct-date">' + (c.publication_date ? escapeHtml(c.publication_date) : '') + '</td>';
      html += '<td class="pd-ct-assignee">' + (c.assignee ? escapeHtml(c.assignee) : '') + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table></div></div>';
  }

  // Similar documents
  if (data.similar_documents && data.similar_documents.length > 0) {
    const _simNums = data.similar_documents.map(c => c.patent_number).filter(Boolean);
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title pd-section-title-with-action"><span>相似文档 (' + data.similar_documents.length + ')</span>' + _makeCopyNumsBtn(_simNums) + '</div>';
    html += '<div class="pd-citation-table-wrap"><table class="pd-citation-table"><thead><tr>';
    html += '<th>专利号</th><th>标题</th><th>公开日</th>';
    html += '</tr></thead><tbody>';
    data.similar_documents.forEach(c => {
      html += '<tr>';
      html += '<td class="pd-ct-num"><a class="pd-patent-link" data-patent="' + escapeHtml(c.patent_number) + '">' + escapeHtml(c.patent_number) + '</a>';
      html += patentLinkButtons(c.patent_number);
      html += '</td>';
      html += '<td class="pd-ct-title">' + (c.title ? escapeHtml(c.title) : '') + '</td>';
      html += '<td class="pd-ct-date">' + (c.publication_date ? escapeHtml(c.publication_date) : '') + '</td>';
      html += '</tr>';
    });
    html += '</tbody></table></div></div>';
  }

  if ((!data.patent_citations || data.patent_citations.length === 0) && (!data.cited_by || data.cited_by.length === 0) && (!data.similar_documents || data.similar_documents.length === 0)) {
    html += '<div class="pd-empty">暂无引用文献数据</div>';
  }

  html += '</div>'; // panel references

  html += '</div>'; // pd-tab-panels
  html += '</div>'; // pd-tab-layout

  return html;
}

async function openPatentPopup(patentNumber) {
  const viewer = document.getElementById("patent-popup-viewer");
  const ball = document.getElementById("patent-popup-ball");
  const content = document.getElementById("ppv-content");
  const loading = document.getElementById("ppv-loading");
  const pnEl = document.getElementById("ppv-patent-number");
  const titleEl = document.getElementById("ppv-patent-title");
  const gpLink = document.getElementById("ppv-gp-link");
  const espacenetBtn = document.getElementById("ppv-espacenet-btn");
  const pdfLink = document.getElementById("ppv-pdf-link");

  if (!viewer) return;

  const raw = patentNumber.trim().toUpperCase().replace(/[\s\/]/g, "");

  // JP专利在专利原文模式(patent mode)下和其他国家一样走GP弹窗
  // 仅在审查文档模式(dossier mode)下由doSearch特殊处理
  // (此处移除了强制openJPlatPat的跳转)

  // If already open, just switch to it
  const existing = _ppvOpenPatents.find(e => e.patentNumber === raw);
  if (existing) {
    _ppvActivePatent = raw;
    _patentPopupData = existing.data;
    window._patentPopupData = existing.data;
    content.innerHTML = existing.html;
    _bindPpvContentEvents(content, existing.data);
    _renderPpvPatentTabs();
    loading.classList.add("hidden");
    viewer.classList.remove("hidden");
    ball.classList.add("hidden");
    pnEl.textContent = raw;
    titleEl.textContent = existing.data.title || "无标题";
    gpLink.href = "https://patents.google.com/patent/" + encodeURIComponent(raw);
    gpLink.onclick = function(e) { e.preventDefault(); openInAppWebview(this.href, "Google Patents: " + encodeURIComponent(raw)); };
    if (espacenetBtn) { espacenetBtn.onclick = function() { openInAppWebview("https://worldwide.espacenet.com/patent/search?q=" + encodeURIComponent(raw), "Espacenet: " + raw); }; }
    if (existing.data.pdf_link) {
      pdfLink.href = existing.data.pdf_link;
      pdfLink.classList.remove("hidden");
    } else {
      pdfLink.classList.add("hidden");
    }
    return;
  }

  // Show viewer with loading state
  viewer.classList.remove("hidden");
  ball.classList.add("hidden");
  content.innerHTML = "";
  loading.classList.remove("hidden");
  pnEl.textContent = raw;
  titleEl.textContent = "加载中...";
  gpLink.href = "https://patents.google.com/patent/" + encodeURIComponent(raw);
  gpLink.onclick = function(e) { e.preventDefault(); openInAppWebview(this.href, "Google Patents: " + encodeURIComponent(raw)); };
  if (espacenetBtn) { espacenetBtn.onclick = function() { openInAppWebview("https://worldwide.espacenet.com/patent/search?q=" + encodeURIComponent(raw), "Espacenet: " + raw); }; }
  pdfLink.classList.add("hidden");

  // Check prefetch cache first
  if (_prefetchCache[raw]) {
    const data = _prefetchCache[raw];
    _patentPopupData = data;
    window._patentPopupData = data;
    loading.classList.add("hidden");
    titleEl.textContent = data.title || "无标题";
    if (data.pdf_link) {
      pdfLink.href = data.pdf_link;
      pdfLink.classList.remove("hidden");
    }
    const html = renderPatentPopupContent(data);
    content.innerHTML = html;
    _bindPpvContentEvents(content, data);
    _ppvOpenPatents.push({ patentNumber: raw, data, html });
    _ppvActivePatent = raw;
    _renderPpvPatentTabs();
    _patentPopupCache[raw] = { data, html, timestamp: Date.now() };
    return;
  }

  // Check TTL-based popup cache (1 hour)
  const cachedEntry = _patentPopupCache[raw];
  if (cachedEntry && Date.now() - cachedEntry.timestamp < PATENT_POPUP_CACHE_TTL) {
    const data = cachedEntry.data;
    const html = cachedEntry.html;
    _patentPopupData = data;
    window._patentPopupData = data;
    loading.classList.add("hidden");
    titleEl.textContent = data.title || "无标题";
    if (data.pdf_link) {
      pdfLink.href = data.pdf_link;
      pdfLink.classList.remove("hidden");
    }
    content.innerHTML = html;
    _bindPpvContentEvents(content, data);
    _ppvOpenPatents.push({ patentNumber: raw, data, html });
    _ppvActivePatent = raw;
    _renderPpvPatentTabs();
    return;
  }

  try {
    const resp = await fetch(gpApiUrl(raw));
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const ct = resp.headers.get("content-type") || "";
    if (!ct.includes("application/json")) {
      await resp.text();
      throw new Error("服务器返回了非JSON响应");
    }
    const json = await resp.json();

    if (!json.success) {
      content.innerHTML = '<div class="ppv-error">' + escapeHtml(json.error || "未找到该专利") + '</div>';
      loading.classList.add("hidden");
      titleEl.textContent = "查询失败";
      return;
    }

    const data = json.data;
    _patentPopupData = data;
    window._patentPopupData = data;
    loading.classList.add("hidden");
    titleEl.textContent = data.title || "无标题";

    // PDF link
    if (data.pdf_link) {
      pdfLink.href = data.pdf_link;
      pdfLink.classList.remove("hidden");
    }

    const html = renderPatentPopupContent(data);
    content.innerHTML = html;
    _bindPpvContentEvents(content, data);
    _ppvOpenPatents.push({ patentNumber: raw, data, html });
    _ppvActivePatent = raw;
    _renderPpvPatentTabs();
    _patentPopupCache[raw] = { data, html, timestamp: Date.now() };

  } catch (e) {
    content.innerHTML = '<div class="ppv-error">查询失败: ' + escapeHtml(e.message) + '</div>';
    loading.classList.add("hidden");
    titleEl.textContent = "查询失败";
  }
}

function switchPpvPatent(patentNumber) {
  const entry = _ppvOpenPatents.find(e => e.patentNumber === patentNumber);
  if (!entry) return;
  _ppvActivePatent = patentNumber;
  _patentPopupData = entry.data;
  window._patentPopupData = entry.data;

  const content = document.getElementById("ppv-content");
  const pnEl = document.getElementById("ppv-patent-number");
  const titleEl = document.getElementById("ppv-patent-title");
  const gpLink = document.getElementById("ppv-gp-link");
  const espacenetBtn = document.getElementById("ppv-espacenet-btn");
  const pdfLink = document.getElementById("ppv-pdf-link");

  content.innerHTML = entry.html;
  _bindPpvContentEvents(content, entry.data);
  _renderPpvPatentTabs();

  if (pnEl) pnEl.textContent = patentNumber;
  if (titleEl) titleEl.textContent = entry.data.title || "无标题";
  if (gpLink) {
    gpLink.href = "https://patents.google.com/patent/" + encodeURIComponent(patentNumber);
    gpLink.onclick = function(e) { e.preventDefault(); openInAppWebview(this.href, "Google Patents: " + encodeURIComponent(patentNumber)); };
  }
  if (espacenetBtn) {
    espacenetBtn.onclick = function() { openInAppWebview("https://worldwide.espacenet.com/patent/search?q=" + encodeURIComponent(patentNumber), "Espacenet: " + patentNumber); };
  }
  if (pdfLink) {
    if (entry.data.pdf_link) {
      pdfLink.href = entry.data.pdf_link;
      pdfLink.classList.remove("hidden");
    } else {
      pdfLink.classList.add("hidden");
    }
  }
}

function closePpvPatentTab(patentNumber) {
  const idx = _ppvOpenPatents.findIndex(e => e.patentNumber === patentNumber);
  if (idx === -1) return;
  _ppvOpenPatents.splice(idx, 1);

  if (_ppvOpenPatents.length === 0) {
    // No more tabs, close the viewer
    closePatentPopup();
    return;
  }

  if (_ppvActivePatent === patentNumber) {
    // Switch to the nearest tab
    const newIdx = Math.min(idx, _ppvOpenPatents.length - 1);
    switchPpvPatent(_ppvOpenPatents[newIdx].patentNumber);
  } else {
    _renderPpvPatentTabs();
  }
}

function closePatentPopup() {
  const viewer = document.getElementById("patent-popup-viewer");
  const ball = document.getElementById("patent-popup-ball");
  if (viewer) viewer.classList.add("hidden");
  _ppvOpenPatents = [];
  _ppvActivePatent = "";
  const tabsBar = document.getElementById("ppv-patent-tabs");
  if (tabsBar) tabsBar.innerHTML = "";
  updateFloatingBallsVisibility();
}

function showPatentPopup() {
  const viewer = document.getElementById("patent-popup-viewer");
  const ball = document.getElementById("patent-popup-ball");
  if (viewer) viewer.classList.remove("hidden");
  if (ball) ball.classList.add("hidden");
}

async function doSearch(input) {
  // Clear prefetch cache when starting a new search
  clearPrefetchCache();

  // 退出首页居中模式，平滑过渡到紧凑布局
  const appEl = document.getElementById("app");
  if (appEl && appEl.classList.contains("home-mode")) {
    appEl.classList.remove("home-mode");
  }

  const pn = parsePatentNumber(input);
  if (!pn) { showError("无法识别专利号格式: " + input); return; }

  // JP专利: 审查文档模式也直接打开J-PlatPat（Global Dossier对JP支持有限）
  const rawPn = pn.raw || input.trim().toUpperCase().replace(/[\s\/]/g, "");
  if (isJPPatent(rawPn)) {
    searchBtn.disabled = false;
    loading.classList.add("hidden");
    if (patentInput) patentInput.value = rawPn;
    const parsed = parseJPPatentNo(rawPn);
    const title = "J-PlatPat: " + rawPn + (parsed ? " (" + parsed.docdbFormat + ")" : "");
    openJPlatPat(rawPn, title);
    PatentCache.addPatentHistory(rawPn, { title: "J-PlatPat: " + (parsed ? parsed.docdbFormat : rawPn), source: "jplatpat" });
    refreshHistoryList();
    return;
  }

  searchBtn.disabled = true;
  loadingText.textContent = "正在查询专利信息...";
  loading.classList.remove("hidden");
  resultSection.classList.add("hidden");
  hideError();

  const office = pn.office;
  const docNum = pn.applicationNumber;
  const selectedQueryType = queryTypeSelect ? queryTypeSelect.value : null;
  const queryType = selectedQueryType || pn.queryType || "application";
  const result = { office, raw: pn.raw, applicationNumber: docNum, queryType };
  const warnings = [];

  try {
    const familyData = await gdFetch(`/patent-family/svc/family/${queryType}/${office}/${docNum}`);
    result.family = familyData;
    // 当通过 publication/patent 类型查询时，family 返回 corrAppNum 是真正的申请号
    // 后续的文档列表查询必须使用申请号
    if (familyData && familyData.corrAppNum) {
      result.applicationNumber = familyData.corrAppNum;
    } else if (familyData && familyData.list && Array.isArray(familyData.list)) {
      // corrAppNum 为 null 时，从 family.list 中查找当前局的申请号
      // EP 专利通过公开号/专利号查询时，corrAppNum 经常为 null
      const ownEntry = familyData.list.find(item => item.countryCode === office);
      if (ownEntry && ownEntry.appNum) {
        result.applicationNumber = ownEntry.appNum;
      } else if (ownEntry && ownEntry.docNum && ownEntry.docNum.docNumber) {
        result.applicationNumber = ownEntry.docNum.docNumber;
      }
    }
  } catch (e) {
    warnings.push("同族查询失败: " + e.message);
  }

  // 使用修正后的申请号查询文档列表
  const appNumForDocs = result.applicationNumber;

  loadingText.textContent = "正在查询审查文档...";
  await new Promise(r => setTimeout(r, 1500));

  try {
    const docData = await gdFetch(`/doc-list/svc/doclist/${office}/${appNumForDocs}/A`);
    result.documents = docData;
    if (docData && docData.docNumber) {
      result.docNumber = docData.docNumber;
    }
  } catch (e) {
    warnings.push("文档列表查询失败: " + e.message);
  }

  if (warnings.length > 0) result.warnings = warnings;

  currentData = result;

  try { renderKanban(result); } catch (e) { console.error("renderKanban:", e); }
  try { renderOverview(result); } catch (e) { console.error("renderOverview:", e); }
  try { renderFamily(result); } catch (e) { console.error("renderFamily:", e); }
  try { renderTimeline(result); } catch (e) { console.error("renderTimeline:", e); }

  if (warnings.length > 0) {
    warnings.forEach(w => showError("警告: " + w));
  }

  if (aiSummarizeBtn) aiSummarizeBtn.disabled = false;
  const citedRefsManualBtn = document.getElementById("cited-refs-manual-btn");
  if (citedRefsManualBtn) citedRefsManualBtn.disabled = false;
  const manualSelectBtn = document.getElementById("kanban-manual-select-btn");
  if (manualSelectBtn) manualSelectBtn.disabled = false;
  // Auto-expand review manual selection panel when documents are loaded
  if (typeof buildReviewManualSelectPanel === "function") {
    try { buildReviewManualSelectPanel(); } catch (e) { console.error("auto-expand review panel:", e); }
  }
  resultSection.classList.remove("hidden");
  searchBtn.disabled = false;
  loading.classList.add("hidden");

  // Auto-record lightweight history entry (even without OCR/AI)
  let patentTitle = "";
  if (result.documents && result.documents.title) {
    patentTitle = result.documents.title;
  } else if (result.family && result.family.list && result.family.list.length > 0) {
    patentTitle = result.family.list[0].title || "";
  }
  PatentCache.addHistory(result.raw || (result.office + result.applicationNumber), result.office, {
    applicantName: result.applicantName || "",
    title: patentTitle,
  });
  // Refresh history list after new search
  refreshHistoryList();
}

let kanbanState = {
  documents: [],
  extractions: {},
  analysis: "",
  traceIndex: {},
  hasUnsavedWork: false,
};

// ── PatentCache - manages cached patent query states ──
const PatentCache = {
  STORAGE_KEY: "patentlens-cache",
  HISTORY_KEY: "patentlens-history",  // Lightweight history entries (no cache data)
  PATENT_HISTORY_KEY: "patentlens_patent_history",

  getAll() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  },

  get(patentNumber) {
    const all = this.getAll();
    return all[patentNumber] || null;
  },

  save(patentNumber, data) {
    const all = this.getAll();
    all[patentNumber] = data;
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(all));
    } catch (e) {
      // Quota exceeded - try removing oldest entries
      if (e.name === "QuotaExceededError" || e.code === 22 || e.message.includes("quota")) {
        const entries = Object.entries(all);
        entries.sort((a, b) => (a[1].timestamp || 0) - (b[1].timestamp || 0));
        // Remove oldest entries until we can save
        while (entries.length > 0) {
          const oldest = entries.shift();
          delete all[oldest[0]];
          try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(all));
            // Try saving again with the new entry
            all[patentNumber] = data;
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(all));
            return true;
          } catch {
            continue;
          }
        }
      }
      console.error("PatentCache save failed:", e);
      return false;
    }
    return true;
  },

  remove(patentNumber) {
    const all = this.getAll();
    delete all[patentNumber];
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(all));
    } catch {}
  },

  clearAll() {
    try {
      localStorage.removeItem(this.STORAGE_KEY);
    } catch {}
  },

  // ── Lightweight history (always recorded, no cache data) ──
  getHistoryAll() {
    try {
      const raw = localStorage.getItem(this.HISTORY_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  },

  addHistory(patentNumber, office, extra) {
    const all = this.getHistoryAll();
    all[patentNumber] = {
      patentNumber,
      office: office || "",
      timestamp: Date.now(),
      applicantName: (extra && extra.applicantName) || "",
      title: (extra && extra.title) || "",
    };
    try {
      localStorage.setItem(this.HISTORY_KEY, JSON.stringify(all));
    } catch {}
  },

  addPatentHistory(patentNumber, extra) {
    const all = this.getPatentHistoryAll();
    all[patentNumber] = {
      patentNumber,
      type: "patent",
      timestamp: Date.now(),
      applicantName: (extra && extra.applicantName) || "",
      title: (extra && extra.title) || "",
      source: (extra && extra.source) || "gp",
    };
    try {
      localStorage.setItem(this.PATENT_HISTORY_KEY, JSON.stringify(all));
    } catch {}
  },

  getPatentHistoryAll() {
    try {
      const raw = localStorage.getItem(this.PATENT_HISTORY_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  },

  removePatentHistory(patentNumber) {
    const all = this.getPatentHistoryAll();
    delete all[patentNumber];
    try {
      localStorage.setItem(this.PATENT_HISTORY_KEY, JSON.stringify(all));
    } catch {}
  },

  removeHistory(patentNumber) {
    const all = this.getHistoryAll();
    delete all[patentNumber];
    try {
      localStorage.setItem(this.HISTORY_KEY, JSON.stringify(all));
    } catch {}
  },

  clearAllHistory() {
    try {
      localStorage.removeItem(this.HISTORY_KEY);
      localStorage.removeItem(this.PATENT_HISTORY_KEY);
    } catch {}
  },

  getSize() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      return raw ? new Blob([raw]).size : 0;
    } catch { return 0; }
  },

  formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  },

  hasUnsavedWork() {
    return kanbanState.hasUnsavedWork && currentData;
  },

  captureCurrentState() {
    if (!currentData) return null;
    const patentNumber = currentData.raw || (currentData.office + currentData.applicationNumber);
    if (!patentNumber) return null;

    // Deep-clone kanbanState (include pageDimensions - they are needed for correct OCR bbox mapping)
    const traceIndexClone = {};
    for (const [key, val] of Object.entries(kanbanState.traceIndex)) {
      traceIndexClone[key] = JSON.parse(JSON.stringify(val));
    }

    // Deep-clone extractions including pageDimensions (critical for OCR coordinate mapping)
    const extractionsClone = {};
    for (const [idx, ext] of Object.entries(kanbanState.extractions)) {
      extractionsClone[idx] = JSON.parse(JSON.stringify(ext));
    }

    const hasOCR = Object.keys(kanbanState.extractions).length > 0;
    const hasAnalysis = !!(kanbanState.analysis);
    const hasCitedRefs = !!(kanbanState.citedRefsAnalysis);

    return {
      patentNumber,
      office: currentData.office || "",
      timestamp: Date.now(),
      currentData: JSON.parse(JSON.stringify(currentData)),
      kanbanState: {
        documents: JSON.parse(JSON.stringify(kanbanState.documents)),
        extractions: extractionsClone,
        analysis: kanbanState.analysis || "",
        analysisSystemPrompt: kanbanState.analysisSystemPrompt || "",
        analysisUserMessage: kanbanState.analysisUserMessage || "",
        traceIndex: traceIndexClone,
        citedRefsAnalysis: kanbanState.citedRefsAnalysis || "",
      },
      hasOCR,
      hasAnalysis,
      hasCitedRefs,
    };
  },

  restoreState(cacheEntry) {
    if (!cacheEntry) return false;
    try {
      currentData = cacheEntry.currentData;

      // Re-render everything first (renderKanban will reset kanbanState)
      try { renderKanban(currentData); } catch (e) { console.error("renderKanban:", e); }
      try { renderOverview(currentData); } catch (e) { console.error("renderOverview:", e); }
      try { renderFamily(currentData); } catch (e) { console.error("renderFamily:", e); }
      try { renderTimeline(currentData); } catch (e) { console.error("renderTimeline:", e); }

      // Now restore kanbanState AFTER renderKanban (which resets it)
      kanbanState.documents = cacheEntry.kanbanState.documents || [];
      kanbanState.analysis = cacheEntry.kanbanState.analysis || "";
      kanbanState.analysisSystemPrompt = cacheEntry.kanbanState.analysisSystemPrompt || "";
      kanbanState.analysisUserMessage = cacheEntry.kanbanState.analysisUserMessage || "";
      kanbanState.citedRefsAnalysis = cacheEntry.kanbanState.citedRefsAnalysis || "";
      kanbanState.hasUnsavedWork = false;

      // Restore extractions - use saved pageDimensions directly for correct OCR bbox mapping
      kanbanState.extractions = {};
      if (cacheEntry.kanbanState.extractions) {
        for (const [idx, ext] of Object.entries(cacheEntry.kanbanState.extractions)) {
          // Use saved pageDimensions if available; fall back to reconstructing from blocks for old caches
          let pageDims = ext.pageDimensions || {};
          const hasValidPageDims = Object.keys(pageDims).length > 0;
          if (!hasValidPageDims && ext.blocks && Array.isArray(ext.blocks)) {
            // Legacy cache: reconstruct pageDimensions from max bbox extents (approximation)
            const pageMax = {};
            for (const b of ext.blocks) {
              if (b.page != null && b.bbox) {
                const [x1, y1, x2, y2] = b.bbox;
                if (!pageMax[b.page]) pageMax[b.page] = { maxX2: 0, maxY2: 0 };
                if (x2 > pageMax[b.page].maxX2) pageMax[b.page].maxX2 = x2;
                if (y2 > pageMax[b.page].maxY2) pageMax[b.page].maxY2 = y2;
              }
            }
            pageDims = {};
            for (const [p, m] of Object.entries(pageMax)) {
              pageDims[p] = { width: m.maxX2 + 10, height: m.maxY2 + 10 };
            }
          }
          kanbanState.extractions[idx] = { ...ext, pageDimensions: pageDims };
        }
      }

      // Restore traceIndex - re-populate pageDimensions from extractions
      // Also migrate old format keys (B_p1_0) to new format (D0_B_p1_0)
      kanbanState.traceIndex = {};
      if (cacheEntry.kanbanState.traceIndex) {
        for (const [key, val] of Object.entries(cacheEntry.kanbanState.traceIndex)) {
          const ext = kanbanState.extractions[val.docIdx];
          const pd = ext && ext.pageDimensions ? (ext.pageDimensions[val.page] || null) : null;
          // Migrate old format key: if key doesn't start with D, prefix with D{docIdx}_
          const newKey = /^D\d+_B_/.test(key) ? key : ("D" + val.docIdx + "_" + key);
          // Ensure originalBlockId exists
          const entryVal = { ...val, pageDimensions: pd };
          if (!entryVal.originalBlockId) {
            // Extract original block_id from old format key or from the key itself
            const blockMatch = key.match(/B_p\d+_\d+/);
            entryVal.originalBlockId = blockMatch ? blockMatch[0] : key;
          }
          kanbanState.traceIndex[newKey] = entryVal;
        }
      }

      // Migrate old format references in analysis text (【来源: B_p1_0】 → 【来源: D0_B_p1_0】)
      if (kanbanState.analysis && /【来源:\s*B_p/.test(kanbanState.analysis)) {
        kanbanState.analysis = kanbanState.analysis.replace(
          /【来源:\s*([^\】]+)】/g,
          (match, refsStr) => {
            const newRefs = refsStr.split(",").map(r => {
              r = r.trim();
              if (/^B_p/.test(r) && !/^D\d+_B_/.test(r)) {
                // Find which docIdx this old-format block_id belongs to
                for (const [key, val] of Object.entries(kanbanState.traceIndex)) {
                  if (val.originalBlockId === r) {
                    return key; // Return the new format key
                  }
                }
              }
              return r;
            });
            return "【来源: " + newRefs.join(", ") + "】";
          }
        );
      }

      // Restore analysis content
      const analysisContentEl = document.getElementById("kanban-analysis-content");
      const analysisSection = document.getElementById("kanban-analysis");
      if (kanbanState.analysis) {
        if (analysisContentEl) analysisContentEl.innerHTML = renderAnalysisModules(kanbanState.analysis);
        if (analysisSection) analysisSection.classList.remove("hidden");
      } else {
        if (analysisContentEl) analysisContentEl.innerHTML = "";
        if (analysisSection) analysisSection.classList.add("hidden");
      }

      // Restore extraction display in kanban cards
      for (const [idx, ext] of Object.entries(kanbanState.extractions)) {
        const container = document.getElementById("kanban-extracted-" + idx);
        if (container && ext && (ext.text || ext.markdown)) {
          const displayText = ext.markdown || ext.text;
          const blocksInfo = ext.blocks && ext.blocks.length > 0 ? ` · ${ext.blocks.length} blocks` : "";
          container.classList.remove("hidden");
          container.innerHTML = `
            <div class="extracted-header">
              <span class="extracted-engine">引擎: ${escapeHtml(ext.engine || "")}</span>
              <span class="extracted-chars">字符数: ${displayText.length}${blocksInfo}</span>
            </div>
            <pre class="extracted-text">${escapeHtml(displayText.length > 6000 ? displayText.substring(0, 6000) + "\n\n[...已截断...]" : displayText)}</pre>
          `;
        }
      }

      // Update input field
      if (patentInput) patentInput.value = cacheEntry.patentNumber || "";

      // Show result section
      const appEl = document.getElementById("app");
      if (appEl && appEl.classList.contains("home-mode")) {
        appEl.classList.remove("home-mode");
      }
      resultSection.classList.remove("hidden");

      updateFloatingBallsVisibility();

      // Show analysis chat toggle if analysis exists
      if (kanbanState.analysis) {
        showAnalysisChatToggle();
        prefetchPatentLinks();
      }

      return true;
    } catch (e) {
      console.error("PatentCache restoreState failed:", e);
      return false;
    }
  },
};

// ── GPCache - localStorage cache for Google Patents (专利原文) data ──
const GPCache = {
  STORAGE_KEY: "patentlens-gp-cache",
  MAX_ENTRIES: 50,

  getAll() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  },

  get(patentNumber) {
    const all = this.getAll();
    const entry = all[patentNumber];
    if (!entry || !entry.data) return null;
    return entry.data;
  },

  set(patentNumber, data) {
    if (!data) return;
    const all = this.getAll();
    all[patentNumber] = { data, timestamp: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > this.MAX_ENTRIES) {
      keys.sort((a, b) => (all[a].timestamp || 0) - (all[b].timestamp || 0));
      const toRemove = keys.slice(0, keys.length - this.MAX_ENTRIES);
      toRemove.forEach(k => delete all[k]);
    }
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(all));
    } catch (e) {
      console.warn("GPCache save failed:", e);
    }
  },
};

// ── Time ago helper ──
function timeAgo(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "分钟前";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "小时前";
  const days = Math.floor(hours / 24);
  if (days < 30) return days + "天前";
  const months = Math.floor(days / 30);
  if (months < 12) return months + "个月前";
  const years = Math.floor(months / 12);
  return years + "年前";
}

// ── Cache confirm dialog ──
function showCacheConfirmDialog(callback) {
  const dialog = document.getElementById("cache-confirm-dialog");
  if (!dialog) { callback(); return; }
  dialog.classList.remove("hidden");

  const saveBtn = document.getElementById("cache-dialog-save-btn");
  const skipBtn = document.getElementById("cache-dialog-skip-btn");
  const cancelBtn = document.getElementById("cache-dialog-cancel-btn");

  function cleanup() {
    dialog.classList.add("hidden");
    saveBtn.removeEventListener("click", onSave);
    skipBtn.removeEventListener("click", onSkip);
    cancelBtn.removeEventListener("click", onCancel);
  }

  function onSave() {
    cleanup();
    // Save current state then continue
    const entry = PatentCache.captureCurrentState();
    if (entry) {
      PatentCache.save(entry.patentNumber, entry);
      kanbanState.hasUnsavedWork = false;
      refreshHistoryList();
    }
    callback();
  }

  function onSkip() {
    cleanup();
    kanbanState.hasUnsavedWork = false;
    callback();
  }

  function onCancel() {
    cleanup();
    // Abort the action - don't call callback
  }

  saveBtn.addEventListener("click", onSave);
  skipBtn.addEventListener("click", onSkip);
  cancelBtn.addEventListener("click", onCancel);
}

function promptSaveCache(callback) {
  if (!kanbanState.hasUnsavedWork || !currentData) {
    callback();
    return;
  }
  showCacheConfirmDialog(callback);
}

// Auto-save cache silently after OCR/AI operations complete.
// This ensures work is preserved even if the user closes the app without
// explicitly saving or switching to another patent.
function autoSaveCache() {
  if (!kanbanState.hasUnsavedWork || !currentData) return;
  const entry = PatentCache.captureCurrentState();
  if (entry) {
    PatentCache.save(entry.patentNumber, entry);
    kanbanState.hasUnsavedWork = false;
    refreshHistoryList();
  }
}

// Auto-save on page hide/close to prevent data loss
window.addEventListener("beforeunload", () => {
  if (kanbanState.hasUnsavedWork && currentData) {
    autoSaveCache();
  }
});
// Also handle visibilitychange for mobile/Electron scenarios
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && kanbanState.hasUnsavedWork && currentData) {
    autoSaveCache();
  }
});

// ── Refresh history sidebar & settings cache tab ──
function refreshHistoryList() {
  const cachedAll = PatentCache.getAll();
  const historyAll = PatentCache.getHistoryAll();

  // Merge: cached entries + lightweight-only entries
  const mergedMap = {};
  // Lightweight history entries first
  Object.entries(historyAll).forEach(([pn, h]) => {
    mergedMap[pn] = {
      patentNumber: pn,
      office: h.office || "",
      timestamp: h.timestamp || 0,
      isCached: !!cachedAll[pn],
      hasOCR: false,
      hasAnalysis: false,
      hasCitedRefs: false,
      applicantName: h.applicantName || "",
      title: h.title || "",
    };
  });
  // Overlay cached entries (they have richer data)
  Object.entries(cachedAll).forEach(([pn, c]) => {
    if (mergedMap[pn]) {
      mergedMap[pn].isCached = true;
      mergedMap[pn].hasOCR = !!c.hasOCR;
      mergedMap[pn].hasAnalysis = !!c.hasAnalysis;
      mergedMap[pn].hasCitedRefs = !!c.hasCitedRefs;
      // Use the more recent timestamp
      if ((c.timestamp || 0) > mergedMap[pn].timestamp) {
        mergedMap[pn].timestamp = c.timestamp;
        mergedMap[pn].office = c.office || mergedMap[pn].office;
      }
      // Also get applicantName/title from cached currentData if available
      if (c.currentData) {
        if (!mergedMap[pn].applicantName && c.currentData.applicantName) {
          mergedMap[pn].applicantName = c.currentData.applicantName;
        }
        if (!mergedMap[pn].title) {
          if (c.currentData.documents && c.currentData.documents.title) {
            mergedMap[pn].title = c.currentData.documents.title;
          } else if (c.currentData.family && c.currentData.family.list && c.currentData.family.list.length > 0) {
            mergedMap[pn].title = c.currentData.family.list[0].title || "";
          }
        }
      }
    } else {
      mergedMap[pn] = {
        patentNumber: pn,
        office: c.office || "",
        timestamp: c.timestamp || 0,
        isCached: true,
        hasOCR: !!c.hasOCR,
        hasAnalysis: !!c.hasAnalysis,
        hasCitedRefs: !!c.hasCitedRefs,
        applicantName: (c.currentData && c.currentData.applicantName) || "",
        title: (c.currentData && c.currentData.documents && c.currentData.documents.title) || (c.currentData && c.currentData.family && c.currentData.family.list && c.currentData.family.list[0] && c.currentData.family.list[0].title) || "",
      };
    }
  });

  const entries = Object.values(mergedMap).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  // Update history sidebar
  const historyList = document.getElementById("history-list");
  if (historyList) {
    // Merge dossier entries and patent entries into a unified sorted list
    const patentHistory = PatentCache.getPatentHistoryAll();
    const unifiedEntries = entries.map(e => ({ ...e, _type: "dossier" }));
    Object.entries(patentHistory).forEach(([pn, item]) => {
      if (item.timestamp) {
        // Skip if already shown as dossier entry (avoid duplicate display)
        if (!unifiedEntries.find(e => e.patentNumber === pn)) {
          unifiedEntries.push({
            patentNumber: pn,
            office: item.source === "jplatpat" ? "JP" : "GP",
            timestamp: item.timestamp,
            isCached: false,
            hasOCR: false,
            hasAnalysis: false,
            hasCitedRefs: false,
            applicantName: item.applicantName || "",
            title: item.title || "",
            source: item.source || "gp",
            _type: "patent",
          });
        }
      }
    });
    unifiedEntries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    if (unifiedEntries.length === 0) {
      historyList.innerHTML = '<div style="color:var(--text-muted);font-size:12px;text-align:center;padding:16px 4px;">暂无历史记录</div>';
    } else {
      const isSelectMode = historyList.classList.contains("select-mode");
      historyList.innerHTML = unifiedEntries.map(e => {
        const currentPatent = currentData ? (currentData.raw || (currentData.office + currentData.applicationNumber)) : "";
        const isActive = e.patentNumber === currentPatent;
        let badges = "";
        if (e._type === "patent") {
          if (e.source === "jplatpat") {
            badges += '<span class="history-badge" style="background:#c0392b;color:#fff;">J-PlatPat</span>';
          } else {
            badges += '<span class="history-badge" style="background:var(--accent);color:#fff;">GP原文</span>';
          }
        } else {
          if (!e.isCached) badges += '<span class="history-badge" style="background:var(--bg-hover);color:var(--text-muted);">仅记录</span>';
          if (e.hasOCR) badges += '<span class="history-badge badge-ocr">OCR</span>';
          if (e.hasAnalysis) badges += '<span class="history-badge badge-analysis">分析</span>';
          if (e.hasCitedRefs) badges += '<span class="history-badge badge-cited">引用</span>';
        }
        const titleHtml = e.title ? '<div class="history-item-title">' + escapeHtml(e.title.length > 30 ? e.title.substring(0, 30) + '...' : e.title) + '</div>' : '';
        const applicantHtml = e.applicantName ? '<div class="history-item-applicant">申请人: ' + escapeHtml(e.applicantName.length > 20 ? e.applicantName.substring(0, 20) + '...' : e.applicantName) + '</div>' : '';
        const officeBadge = e._type === "patent"
          ? (e.source === "jplatpat" ? '<span style="color:#c0392b;margin-right:4px;">JP</span>' : '<span style="color:var(--accent);margin-right:4px;">GP</span>')
          : (e.office ? '<span style="color:var(--accent);margin-right:4px;">' + escapeHtml(e.office) + '</span>' : '');
        const checkboxHtml = isSelectMode ? '<input type="checkbox" class="history-item-checkbox" data-patent="' + escapeHtml(e.patentNumber) + '" data-type="' + e._type + '" style="margin-right:6px;flex-shrink:0;">' : '';
        const deleteBtnHtml = isSelectMode ? '' : '<button class="history-item-delete-btn" data-patent="' + escapeHtml(e.patentNumber) + '" data-type="' + e._type + '" title="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>';
        return `<div class="history-item${isActive ? ' active' : ''}${isSelectMode ? ' select-mode' : ''}" data-patent="${escapeHtml(e.patentNumber)}" data-type="${e._type}" data-source="${e.source || ''}" data-cached="${e.isCached ? '1' : '0'}" data-timestamp="${e.timestamp || 0}">
          <div class="history-item-row" style="display:flex;align-items:center;">
            ${checkboxHtml}
            <div class="history-item-main" style="flex:1;min-width:0;">
              <div class="history-item-patent">${officeBadge}${escapeHtml(e.patentNumber)}</div>
              ${titleHtml}
              ${applicantHtml}
              <div class="history-item-time">${timeAgo(e.timestamp)}</div>
              ${badges ? '<div class="history-item-badges">' + badges + '</div>' : ''}
            </div>
            ${deleteBtnHtml}
          </div>
        </div>`;
      }).join("");

      // Add click handlers
      historyList.querySelectorAll(".history-item").forEach(item => {
        if (isSelectMode) {
          // In select mode, clicking toggles the checkbox
          item.addEventListener("click", (ev) => {
            if (ev.target.tagName === 'INPUT' || ev.target.closest('.history-item-checkbox')) return;
            const cb = item.querySelector('.history-item-checkbox');
            if (cb) { cb.checked = !cb.checked; updateHistoryBatchCount(); }
          });
        } else {
          // Normal mode: click to restore, delete button to remove
          const deleteBtn = item.querySelector('.history-item-delete-btn');
          if (deleteBtn) {
            deleteBtn.addEventListener("click", (ev) => {
              ev.stopPropagation();
              const pn = deleteBtn.dataset.patent;
              const type = deleteBtn.dataset.type;
              if (!confirm("确认删除 " + pn + " 的历史记录？")) return;
              if (type === "patent") {
                PatentCache.removePatentHistory(pn);
              } else {
                PatentCache.removeHistory(pn);
                PatentCache.remove(pn);
              }
              refreshHistoryList();
            });
          }
          item.addEventListener("click", () => {
            const patentNumber = item.dataset.patent;
            const type = item.dataset.type;
            const source = item.dataset.source;
            if (type === "patent") {
              if (source === "jplatpat") {
                if (patentInput) patentInput.value = patentNumber;
                openJPlatPat(patentNumber);
                return;
              }
              searchMode = "patent";
              document.querySelectorAll(".search-mode-btn").forEach(b => {
                b.classList.toggle("active", b.dataset.mode === "patent");
              });
              if (batchSearchToggleBtn) batchSearchToggleBtn.style.display = "";
              _openPdPatent(patentNumber);
            } else {
              const isCached = item.dataset.cached === "1";
              if (isCached) {
                restoreFromCache(patentNumber);
              } else {
                restoreFromHistory(patentNumber);
              }
            }
          });
        }
      });

      // Update batch count when checkboxes change
      historyList.querySelectorAll('.history-item-checkbox').forEach(cb => {
        cb.addEventListener('change', updateHistoryBatchCount);
      });
    }
  }

  // Update settings cache tab (only show cached entries)
  const cachedEntries = Object.values(cachedAll).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const cacheOverview = document.getElementById("cache-overview");
  const cachePatentList = document.getElementById("cache-patent-list");
  if (cacheOverview) {
    const size = PatentCache.getSize();
    cacheOverview.textContent = `${cachedEntries.length} 条缓存，共 ${PatentCache.formatSize(size)}`;
  }
  if (cachePatentList) {
    if (cachedEntries.length === 0) {
      cachePatentList.innerHTML = '<div style="color:var(--text-muted);font-size:12px;text-align:center;padding:12px;">暂无缓存</div>';
    } else {
      cachePatentList.innerHTML = cachedEntries.map(e => {
        let badges = "";
        if (e.hasOCR) badges += '<span class="history-badge badge-ocr">OCR</span>';
        if (e.hasAnalysis) badges += '<span class="history-badge badge-analysis">分析</span>';
        if (e.hasCitedRefs) badges += '<span class="history-badge badge-cited">引用</span>';
        return `<div class="cache-patent-item" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;color:var(--text-primary);">${escapeHtml(e.patentNumber)}</div>
            <div style="font-size:11px;color:var(--text-muted);">${e.office ? escapeHtml(e.office) + ' · ' : ''}${timeAgo(e.timestamp)}</div>
            ${badges ? '<div class="history-item-badges" style="margin-top:2px;">' + badges + '</div>' : ''}
          </div>
          <button class="btn-small cache-delete-btn" data-patent="${escapeHtml(e.patentNumber)}" style="background:var(--bg-hover);color:var(--danger);border:1px solid var(--border);">删除</button>
        </div>`;
      }).join("");

      cachePatentList.querySelectorAll(".cache-delete-btn").forEach(btn => {
        btn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const pn = btn.dataset.patent;
          PatentCache.remove(pn);
          PatentCache.removeHistory(pn);
          PatentCache.removePatentHistory(pn);
          refreshHistoryList();
        });
      });
    }
  }
}

function restoreFromCache(patentNumber) {
  const entry = PatentCache.get(patentNumber);
  if (!entry) { showError("缓存记录不存在"); return; }

  // Confirm if switching away from current query
  if (currentData) {
    const currentPatent = currentData.raw || (currentData.office + currentData.applicationNumber);
    if (currentPatent !== patentNumber) {
      if (kanbanState.hasUnsavedWork) {
        promptSaveCache(() => doRestoreFromCache(patentNumber));
        return;
      }
      if (!confirm("当前查询结果尚未保存，确认切换到其他专利？")) return;
    }
  }
  doRestoreFromCache(patentNumber);
}

function restoreFromHistory(patentNumber) {
  // Lightweight history entry: confirm and re-trigger search
  if (currentData) {
    const currentPatent = currentData.raw || (currentData.office + currentData.applicationNumber);
    if (currentPatent !== patentNumber) {
      if (kanbanState.hasUnsavedWork) {
        promptSaveCache(() => doRestoreFromHistory(patentNumber));
        return;
      }
      if (!confirm("当前查询结果尚未保存，确认切换到其他专利？")) return;
    }
  }
  doRestoreFromHistory(patentNumber);
}

function doRestoreFromHistory(patentNumber) {
  // Re-trigger search for this patent
  const historyAll = PatentCache.getHistoryAll();
  const h = historyAll[patentNumber];
  const office = h ? h.office : "";
  if (patentInput) patentInput.value = patentNumber;
  doSearch(patentNumber);
}

function doRestoreFromCache(patentNumber) {
  const entry = PatentCache.get(patentNumber);
  if (!entry) return;
  const success = PatentCache.restoreState(entry);
  if (success) {
    refreshHistoryList();
  } else {
    showError("恢复缓存状态失败");
  }
}

function renderKanban(data) {
  const board = document.getElementById("kanban-board");
  const statusEl = document.getElementById("kanban-status");
  if (!board) return;

  const docs = data.documents ? extractDocuments(data.documents) : [];
  if (!docs || docs.length === 0) {
    board.innerHTML = '<p class="placeholder">未查询到审查文档</p>';
    if (statusEl) statusEl.textContent = "";
    kanbanState.documents = [];
    return;
  }

  const office = data.office;
  const items = docs.map((d, idx) => {
    const docCode = d.docCode || d.documentType || d.kindCode || d.type || "";
    const desc = d.docDesc || d.documentDescription || d.description || d.docId || "";
    const date = d.legalDateStr || d.documentDate || d.date || "";
    const docId = d.documentId || d.docId || "";
    const numberOfPages = d.numberOfPages != null ? d.numberOfPages : 1;
    const docFormat = d.docFormat || "PDF";
    const status = getStatusInfo(office, docCode, desc);

    return {
      idx: idx,
      docCode,
      desc,
      date,
      docId,
      numberOfPages,
      docFormat,
      name: status.name,
      type: status.type,
      stage: status.stage,
    };
  });

  kanbanState.documents = items;
  kanbanState.extractions = {};
  kanbanState.analysis = "";
  kanbanState.analysisSystemPrompt = "";
  kanbanState.analysisUserMessage = "";
  kanbanState.traceIndex = {};
  kanbanState.hasUnsavedWork = false;

  // Clear previous analysis content from DOM
  const analysisContentEl = document.getElementById("kanban-analysis-content");
  if (analysisContentEl) analysisContentEl.innerHTML = "";

  // Show merge export button if there are documents with download URLs
  const mergeExportBtn = document.getElementById("merge-export-btn");
  if (mergeExportBtn) {
    const hasDownloadable = items.some(it => it.docId && data.office !== "DE");
    mergeExportBtn.style.display = hasDownloadable ? "" : "none";
  }
  analysisChatHistory = [];
  const analysisChatPanel = document.getElementById("analysis-chat-panel");
  if (analysisChatPanel) analysisChatPanel.classList.add("hidden");

  // Update reader floating ball icon state
  if (readerFloatingBall && items.length > 0) {
    const iconOpen = readerFloatingBall.querySelector(".reader-fb-icon-open");
    const iconBack = readerFloatingBall.querySelector(".reader-fb-icon-back");
    readerFloatingBall.title = "点击打开阅读器";
    if (iconOpen) iconOpen.classList.remove("hidden");
    if (iconBack) iconBack.classList.add("hidden");
  }
  updateFloatingBallsVisibility();

  // Build filter bar
  const filterBar = document.getElementById("kanban-filter-bar");
  if (filterBar) {
    const typeCounts = {};
    items.forEach(it => { typeCounts[it.type] = (typeCounts[it.type] || 0) + 1; });
    const typeNames = (typeof PATENT_STATUS !== 'undefined' && PATENT_STATUS[office] && PATENT_STATUS[office].typeNames) || {
      "office_action": "审查意见", "response": "答复", "request": "请求",
      "allowance": "授权", "notification": "通知", "misc": "其他"
    };
    let filterHtml = '<input type="text" id="kanban-filter-input" class="doc-filter-input" placeholder="搜索文档名称、代码...">';
    filterHtml += '<button class="doc-filter-chip active" data-filter-type="all">全部 <span class="chip-count">' + items.length + '</span></button>';
    Object.keys(typeNames).forEach(t => {
      if (typeCounts[t]) {
        filterHtml += '<button class="doc-filter-chip" data-filter-type="' + t + '">' + typeNames[t] + ' <span class="chip-count">' + typeCounts[t] + '</span></button>';
      }
    });
    filterBar.innerHTML = filterHtml;

    // Bind filter events
    const filterInput = document.getElementById("kanban-filter-input");
    const filterChips = filterBar.querySelectorAll(".doc-filter-chip");
    let activeFilter = "all";

    function applyKanbanFilter() {
      const keyword = filterInput ? filterInput.value.trim().toLowerCase() : "";
      document.querySelectorAll(".kanban-card").forEach(card => {
        const idx = parseInt(card.dataset.idx);
        const it = items.find(d => d.idx === idx);
        if (!it) return;
        const matchType = activeFilter === "all" || it.type === activeFilter;
        const searchText = (it.docCode + ' ' + it.name + ' ' + it.desc + ' ' + it.date).toLowerCase();
        const matchKeyword = !keyword || searchText.includes(keyword);
        card.style.display = (matchType && matchKeyword) ? "" : "none";
        // Also show/hide extracted content
        const extracted = document.getElementById("kanban-extracted-" + idx);
        if (extracted) extracted.style.display = (matchType && matchKeyword) ? "" : "none";
      });
    }

    filterChips.forEach(chip => {
      chip.addEventListener("click", () => {
        filterChips.forEach(c => c.classList.remove("active"));
        chip.classList.add("active");
        activeFilter = chip.dataset.filterType;
        applyKanbanFilter();
      });
    });

    if (filterInput) {
      filterInput.addEventListener("input", applyKanbanFilter);
    }
  }

  const columns = [
    { key: "office_action", title: "审查意见", icon: '<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/></svg>', color: "kanban-col-oa" },
    { key: "response", title: "申请人答复", icon: '<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>', color: "kanban-col-response" },
    { key: "request", title: "申请人请求", icon: '<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>', color: "kanban-col-request" },
    { key: "allowance", title: "授权通知", icon: '<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>', color: "kanban-col-allowance" },
    { key: "notification", title: "通知", icon: '<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>', color: "kanban-col-notification" },
    { key: "misc", title: "其他文件", icon: '<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>', color: "kanban-col-misc" },
  ];

  let html = '<div class="kanban-columns">';
  columns.forEach(col => {
    const colItems = items.filter(it => it.type === col.key);
    const count = colItems.length;
    html += `
      <div class="kanban-column ${col.color}">
        <div class="kanban-column-header">
          <span class="kanban-column-title">${col.icon}${col.title}</span>
          <span class="kanban-column-count">${count}</span>
        </div>
        <div class="kanban-column-body">
    `;
    if (count === 0) {
      html += '<p class="kanban-empty">无</p>';
    } else {
      colItems.forEach(it => {
        const isUS = data.office === "US";
        const isJP = data.office === "JP";
        const isDE = data.office === "DE";
        const urlDocNum = isUS ? data.applicationNumber : encodeURIComponent(data.docNumber || data.applicationNumber);
        const encodedDocId = encodeURIComponent(it.docId);
        let extractUrl = null;
        let downloadUrl = null;

        if (it.docId) {
          if (isJP) {
            const jpDocType = mapJpDocType(it.docCode, it.type);
            if (jpDocType) {
              extractUrl = `/api/jpo/doc/${jpDocType}/${urlDocNum}`;
              downloadUrl = extractUrl;
            }
          } else if (isDE) {
            // DE: 案卷查阅需CAPTCHA，无法程序化获取文档，仅提供注册信息查询
            extractUrl = null;
            downloadUrl = null;
          } else {
            extractUrl = `/api/gd/extract-text/${data.office}/${urlDocNum}/${encodedDocId}/${it.numberOfPages}/${it.docFormat}`;
            downloadUrl = `/api/gd/doc-content/svc/doccontent/${data.office}/${urlDocNum}/${encodedDocId}/${it.numberOfPages}/${it.docFormat}`;
          }
        }
        html += `
          <div class="kanban-card" data-idx="${it.idx}">
            <div class="kanban-card-header">
              <span class="kanban-card-code">${escapeHtml(it.docCode)}</span>
              ${it.date ? '<span class="kanban-card-date">' + escapeHtml(it.date) + '</span>' : ''}
            </div>
            <div class="kanban-card-name">${escapeHtml(it.name)}</div>
            ${it.desc && it.desc !== it.name ? '<div class="kanban-card-desc">' + escapeHtml(it.desc) + '</div>' : ''}
            <div class="kanban-card-stage">阶段: ${escapeHtml(it.stage)}</div>
            <div class="kanban-card-actions">
              ${extractUrl ? '<button class="btn-small btn-extract" data-action="kanban-extract" data-url="' + extractUrl + '" data-idx="' + it.idx + '" data-doctype="' + escapeHtml(it.docCode) + '">提取内容</button>' : ''}
              ${downloadUrl ? '<button class="btn-small btn-download" data-action="kanban-download" data-url="' + downloadUrl + '" data-filename="' + escapeHtml(it.docCode) + '_' + escapeHtml(it.date.replace(/\//g, '-')) + '.pdf">下载</button>' : ''}
              ${downloadUrl ? '<button class="btn-small btn-view-pdf" data-action="kanban-view-pdf" data-idx="' + it.idx + '">查看PDF</button>' : ''}
            </div>
            <div id="kanban-extracted-${it.idx}" class="kanban-extracted hidden"></div>
          </div>
        `;
      });
    }
    html += `
        </div>
      </div>
    `;
  });
  html += '</div>';

  board.innerHTML = html;
  if (statusEl) {
    const oaCount = items.filter(it => it.type === "office_action").length;
    const respCount = items.filter(it => it.type === "response").length;
    statusEl.textContent = "共 " + items.length + " 份审查文档（审查意见 " + oaCount + " 份，答复 " + respCount + " 份）";
  }
}

function renderOverview(data) {
  const appInfo = document.getElementById("app-info");
  const appStatus = document.getElementById("app-status");
  const office = OFFICE_NAMES[data.office] || data.office;

  let title = "";
  let inventors = "";
  let applicants = "";
  let filingDate = "";
  let publicationDate = "";
  let priorityDate = "";
  let ipcClasses = "";
  let cpcClasses = "";
  let legalStatus = "";

  if (data.family) {
    const members = extractFamilyMembers(data.family);
    if (members.length > 0) {
      // Find the member matching the queried office, fall back to first member
      let m = members.find(mem => mem.countryCode === data.office) || members[0];
      // Also check docList for richer data (US members store title/applicants in docList)
      const dl = m.docList || {};
      title = m.title || dl.title || m.inventionTitle || "";
      // applicantNames in GD API actually contains inventor names for US patents
      // The field is misleadingly named - it returns first/last name format which is inventors
      const applicantNamesArr = m.applicantNames || dl.applicantNames || [];
      const namesStr = Array.isArray(applicantNamesArr) ? applicantNamesArr.join(", ") : (applicantNamesArr || "");
      // For US patents, applicantNames = inventors; for EP/CN/JP it may be actual applicants
      if (data.office === "US") {
        inventors = namesStr || m.inventors || m.inventorName || "";
      } else {
        applicants = namesStr || m.applicants || m.applicantName || "";
        inventors = m.inventors || m.inventorName || "";
      }
      // filing date: appDateStr or appDate (epoch ms)
      filingDate = m.appDateStr || m.filingDate || m.applicationDate || "";
      if (!filingDate && m.appDate) {
        try { filingDate = new Date(m.appDate).toLocaleDateString("en-US"); } catch(e) {}
      }
      // publication date: from pubList
      if (m.pubList && Array.isArray(m.pubList) && m.pubList.length > 0) {
        publicationDate = m.pubList[0].pubDateStr || "";
        if (!publicationDate && m.pubList[0].pubDate) {
          try { publicationDate = new Date(m.pubList[0].pubDate).toLocaleDateString("en-US"); } catch(e2) {}
        }
      }
      publicationDate = publicationDate || m.publicationDate || m.pubDate || "";
      // priority date: from docNum.date or priorityClaimList
      if (m.docNum && m.docNum.date) {
        priorityDate = m.docNum.date;
      }
      if (!priorityDate && m.priorityClaimList && Array.isArray(m.priorityClaimList) && m.priorityClaimList.length > 0) {
        priorityDate = m.priorityClaimList[0].date || "";
      }
      // IPC/CPC not available in GD family API
      ipcClasses = m.ipc || m.ipcClass || m.classification || "";
      if (Array.isArray(ipcClasses)) ipcClasses = ipcClasses.join(", ");
      cpcClasses = m.cpcClass || m.cpc || "";
      if (Array.isArray(cpcClasses)) cpcClasses = cpcClasses.join(", ");
      // Infer legal status from document types
      const docItems = kanbanState.documents || [];
      const hasAllowance = docItems.some(it => it.type === "allowance");
      const hasOA = docItems.some(it => it.type === "office_action");
      const hasResponse = docItems.some(it => it.type === "response");
      if (hasAllowance) {
        legalStatus = "已授权 (Granted)";
      } else if (hasOA && !hasResponse) {
        legalStatus = "待答复 (Pending Response)";
      } else if (hasOA && hasResponse) {
        legalStatus = "审查中 (Under Examination)";
      } else {
        legalStatus = m.legalStatus || m.status || "";
      }
    }
  }
  if (data.documents && data.documents.title && !title) {
    title = data.documents.title;
  }

  const queryTypeLabel = data.queryType === "publication" ? "公开号/专利号" : "申请号";

  appInfo.innerHTML = `
    <div class="info-row"><span class="info-label">申请局</span><span class="info-value">${office}</span></div>
    <div class="info-row"><span class="info-label">${queryTypeLabel}</span><span class="info-value">${data.applicationNumber || "-"}</span></div>
    ${data.documents && data.documents.docNumber ? '<div class="info-row"><span class="info-label">文档编号</span><span class="info-value">' + escapeHtml(data.documents.docNumber) + '</span></div>' : ''}
    ${title ? '<div class="info-row"><span class="info-label">标题</span><span class="info-value">' + escapeHtml(title) + '</span></div>' : ''}
    ${inventors ? '<div class="info-row"><span class="info-label">发明人</span><span class="info-value">' + escapeHtml(inventors) + '</span></div>' : ''}
    ${applicants ? '<div class="info-row"><span class="info-label">申请人</span><span class="info-value">' + escapeHtml(applicants) + '</span></div>' : ''}
    ${filingDate ? '<div class="info-row"><span class="info-label">申请日</span><span class="info-value">' + escapeHtml(filingDate) + '</span></div>' : ''}
    ${publicationDate ? '<div class="info-row"><span class="info-label">公开日</span><span class="info-value">' + escapeHtml(publicationDate) + '</span></div>' : ''}
    ${priorityDate ? '<div class="info-row"><span class="info-label">优先权日</span><span class="info-value">' + escapeHtml(priorityDate) + '</span></div>' : ''}
    ${ipcClasses ? '<div class="info-row"><span class="info-label">IPC分类</span><span class="info-value">' + escapeHtml(ipcClasses) + '</span></div>' : ''}
    ${cpcClasses ? '<div class="info-row"><span class="info-label">CPC分类</span><span class="info-value">' + escapeHtml(cpcClasses) + '</span></div>' : ''}
  `;

  const family = data.family;
  const items = kanbanState.documents;
  const famCount = family ? countFamilyMembers(family) : 0;
  // Only count substantive documents (exclude misc like descriptions, drawings, receipts)
  const substantiveItems = items.filter(it => it.type !== "misc");
  const docCount = substantiveItems.length;
  const oaCount = substantiveItems.filter(it => it.type === "office_action").length;
  const respCount = substantiveItems.filter(it => it.type === "response").length;
  const allowCount = substantiveItems.filter(it => it.type === "allowance").length;
  const notifCount = substantiveItems.filter(it => it.type === "notification").length;
  const reqCount = substantiveItems.filter(it => it.type === "request").length;

  let statusHtml = '';
  if (legalStatus) {
    statusHtml += '<div class="info-row"><span class="info-label">法律状态</span><span class="info-value">' + escapeHtml(legalStatus) + '</span></div>';
  }
  if (famCount > 0) {
    statusHtml += '<div class="info-row"><span class="info-label">同族成员</span><span class="info-value">' + famCount + ' 个</span></div>';
  }
  if (docCount > 0) {
    statusHtml += '<div class="info-row"><span class="info-label">审查文档</span><span class="info-value">' + docCount + ' 份</span></div>';
  }
  if (items.length > 0) {
    statusHtml += '<div class="info-row"><span class="info-label">审查意见</span><span class="info-value">' + oaCount + ' 份</span></div>';
    statusHtml += '<div class="info-row"><span class="info-label">申请人答复</span><span class="info-value">' + respCount + ' 份</span></div>';
    if (allowCount > 0) {
      statusHtml += '<div class="info-row"><span class="info-label">授权通知</span><span class="info-value">' + allowCount + ' 份</span></div>';
    }
    if (notifCount > 0) {
      statusHtml += '<div class="info-row"><span class="info-label">通知文件</span><span class="info-value">' + notifCount + ' 份</span></div>';
    }
    if (reqCount > 0) {
      statusHtml += '<div class="info-row"><span class="info-label">请求文件</span><span class="info-value">' + reqCount + ' 份</span></div>';
    }
  }
  if (!statusHtml) {
    statusHtml = '<p class="placeholder">暂无状态信息</p>';
  }
  appStatus.innerHTML = statusHtml;
}

function countFamilyMembers(family) {
  if (!family) return 0;
  if (Array.isArray(family)) return family.length;
  if (family.list) return Array.isArray(family.list) ? family.list.length : 1;
  if (family.familyMemberList) {
    const list = family.familyMemberList;
    if (Array.isArray(list)) return list.length;
    if (list.familyMember) return Array.isArray(list.familyMember) ? list.familyMember.length : 1;
  }
  if (family.patentFamily) return countFamilyMembers(family.patentFamily);
  return 1;
}

function countDocuments(docs) {
  if (!docs) return 0;
  if (Array.isArray(docs)) return docs.length;
  if (docs.docs) return Array.isArray(docs.docs) ? docs.docs.length : 1;
  if (docs.documentList) {
    const list = docs.documentList;
    if (Array.isArray(list)) return list.length;
    if (list.document) return Array.isArray(list.document) ? list.document.length : 1;
  }
  return 1;
}

function renderFamily(data) {
  const container = document.getElementById("family-content");
  const family = data.family;
  if (!family) {
    container.innerHTML = '<p class="placeholder">未查询到同族信息</p>';
    return;
  }

  const members = extractFamilyMembers(family);
  if (members.length === 0) {
    container.innerHTML = '<pre class="json-preview">' + JSON.stringify(family, null, 2) + '</pre>';
    return;
  }

  let html = '<div class="family-list">';
  members.forEach(m => {
    const officeCode = m.countryCode || m.office || "";
    const officeName = OFFICE_NAMES[officeCode] || officeCode;
    const appNum = m.appNum || m.applicationNumber || m.docNumber || "";
    const title = m.inventionTitle || m.title || "";
    let pubNum = m.publicationNumber || "";
    if (!pubNum && m.pubList && Array.isArray(m.pubList) && m.pubList.length > 0) {
      const pub = m.pubList[0];
      pubNum = (pub.pubCountry || "") + (pub.pubNum || "");
    }

    html += `
      <div class="family-member">
        <div class="family-member-header">
          <span class="family-member-office">${officeName}</span>
          <span class="family-member-num">${appNum}</span>
        </div>
        ${title ? '<div class="family-member-title">' + escapeHtml(title) + '</div>' : ''}
        <div class="family-member-info">
          ${pubNum ? '<span>公开号: ' + pubNum + '</span>' : ''}
        </div>
      </div>
    `;
  });
  html += '</div>';
  container.innerHTML = html;
}

function extractFamilyMembers(family) {
  if (!family) return [];
  if (Array.isArray(family)) return family;
  if (family.list) return Array.isArray(family.list) ? family.list : [family.list];
  if (family.familyMemberList) {
    const list = family.familyMemberList;
    if (Array.isArray(list)) return list;
    if (list.familyMember) {
      return Array.isArray(list.familyMember) ? list.familyMember : [list.familyMember];
    }
  }
  if (family.patentFamily) return extractFamilyMembers(family.patentFamily);
  return [family];
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderDescriptionHtml(text) {
  if (!text) return '';
  // Known section heading patterns for Chinese and English patents
  const headingPatterns = [
    /^技术领域$/,
    /^背景技术$/,
    /^发明内容$/,
    /^附图说明$/,
    /^具体实施方式$/,
    /^具体实施例$/,
    /^实施方式$/,
    /^实施例$/,
    /^工业应用性$/,
    /^TECHNICAL FIELD$/i,
    /^BACKGROUND$/i,
    /^BACKGROUND OF THE INVENTION$/i,
    /^BACKGROUND ART$/i,
    /^SUMMARY$/i,
    /^SUMMARY OF THE INVENTION$/i,
    /^DETAILED DESCRIPTION$/i,
    /^DETAILED DESCRIPTION OF(?: THE)? (?:PREFERRED)?(?: EMBODIMENTS?)?$/i,
    /^DRAWINGS$/i,
    /^BRIEF DESCRIPTION OF (?:THE )?DRAWINGS$/i,
    /^EMBODIMENTS?$/i,
    /^DESCRIPTION OF EMBODIMENTS?$/i,
    /^DISCLOSURE OF THE INVENTION$/i,
    /^PROBLEMS TO BE SOLVED BY THE INVENTION$/i,
    /^MEANS FOR SOLVING THE PROBLEMS$/i,
    /^PRIOR ART REFERENCE$/i,
    /^PATENT DOCUMENT$/i,
    /^ADVANTAGEOUS EFFECTS?$/i,
  ];
  // Normalize: ensure ## section headers are preceded by a newline
  let normalized = text.replace(/\s*## /g, '\n## ');
  // Additionally, detect heading patterns in lines that don't have ## markers
  const lines = normalized.split('\n');
  const processedLines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ')) return line;
    for (const pattern of headingPatterns) {
      if (pattern.test(trimmed)) {
        return '## ' + trimmed;
      }
    }
    return line;
  });
  normalized = processedLines.join('\n');
  // Split by ## section headers
  const sections = normalized.split(/\n## /);
  let html = '';
  sections.forEach((section, idx) => {
    let sectionText;
    if (idx === 0 && normalized.startsWith('## ')) {
      sectionText = sections[0].substring(3);
    } else {
      sectionText = section;
    }
    if (!sectionText.trim()) return;
    const secLines = sectionText.split('\n');
    const header = secLines[0].trim();
    const body = secLines.slice(1).join('\n');
    if (header) {
      html += '<div class="pd-desc-section-title">' + escapeHtml(header) + '</div>';
    }
    if (body.trim()) {
      // Split body by empty lines into paragraphs
      const paragraphs = body.trim().split(/\n\s*\n/);
      paragraphs.forEach(para => {
        const trimmed = para.trim();
        if (trimmed) {
          // Detect paragraph number prefix like [0001]
          const paraNumMatch = trimmed.match(/^(\[\d+\])\s*(.*)$/);
          if (paraNumMatch) {
            html += '<p><span class="pd-para-num">' + escapeHtml(paraNumMatch[1]) + '</span> ' + escapeHtml(paraNumMatch[2]).replace(/\n/g, '<br>') + '</p>';
          } else {
            html += '<p>' + escapeHtml(trimmed).replace(/\n/g, '<br>') + '</p>';
          }
        }
      });
    }
  });
  return html;
}

// ===== AI 解读 / AI 问一问（专利原文详情 & 右侧弹窗共用） =====

function _getPatentDataSource(source) {
  return source === "popup" ? window._patentPopupData : window._currentPatentData;
}

function _buildClaimsText(data) {
  if (!data || !data.claims || !data.claims.length) return "";
  return data.claims.map(c => (c.num ? c.num + ". " : "") + (c.text || "")).join("\n");
}

// AI 解读：基于摘要 + 权利要求，梳理 技术问题 / 技术手段 / 技术效果
async function runPatentInterpretation(source) {
  const data = _getPatentDataSource(source);
  if (!data) { alert("暂无专利数据"); return; }
  const container = document.querySelector(
    source === "popup"
      ? '#ppv-content .pd-ai-interpret[data-source="popup"]'
      : '#patent-detail-content .pd-ai-interpret[data-source="detail"]'
  );
  if (!container) return;
  const contentEl = container.querySelector(".pd-ai-interpret-content");
  const btn = container.querySelector(".pd-ai-interpret-btn");
  if (!contentEl) return;

  const config = window.AI.loadAIConfig();
  const provider = window.AI.getCurrentProvider(config);
  if (!provider) { alert("请先在「设置」中配置 AI 服务"); return; }

  const abstract = data.abstract || "（无摘要）";
  const claimsText = _buildClaimsText(data) || "（无权利要求）";
  const prompt = window.AI.getCustomPrompt(config, "patentInterpretation");

  if (btn) { btn.disabled = true; btn.textContent = "解读中…"; }
  contentEl.innerHTML = '<p class="pd-ai-interpret-hint">AI 正在解读…</p>';

  const userMessage = "【专利号】" + (data.patent_number || "") + "\n\n【摘要】\n" + abstract + "\n\n【权利要求】\n" + claimsText;

  let acc = "";
  try {
    const stream = window.AI.streamChat(provider.type, provider.apiKey, provider.baseUrl, {
      model: provider.model,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.3,
      maxTokens: 2048,
    });
    // 准备思考区 + 回答区（contentEl 整体作为 host）
    contentEl.innerHTML = "";
    const answerEl = document.createElement("div");
    answerEl.className = "markdown-body";
    contentEl.appendChild(answerEl);
    const thinkingHost = _createThinkingHost(contentEl);
    let contentStarted = false;
    let renderRaf = null;
    for await (const chunk of stream) {
      if (chunk.reasoningContent && thinkingHost) {
        thinkingHost.appendReasoning(chunk.reasoningContent);
      }
      if (chunk.content) {
        if (!contentStarted) {
          contentStarted = true;
          if (thinkingHost) thinkingHost.startContent();
          // 移除占位提示
          const hint = contentEl.querySelector(".pd-ai-interpret-hint");
          if (hint) hint.remove();
        }
        acc += chunk.content;
        if (!renderRaf) {
          renderRaf = requestAnimationFrame(() => {
            renderRaf = null;
            answerEl.innerHTML = renderMarkdown(acc) || '<p class="pd-ai-interpret-hint">…</p>';
          });
        }
      }
    }
    if (thinkingHost) thinkingHost.finish();
    if (!contentStarted) {
      // 全程只有 reasoning 没有 content（罕见），保留思考区，给出提示
      answerEl.innerHTML = '<p class="pd-ai-interpret-hint">未返回内容</p>';
    } else {
      answerEl.innerHTML = renderMarkdown(acc) || '<p class="pd-ai-interpret-hint">未返回内容</p>';
    }
  } catch (e) {
    contentEl.innerHTML = '<p class="pd-ai-interpret-hint">解读失败：' + escapeHtml(e && e.message ? e.message : String(e)) + '</p>';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "AI 解读"; }
  }
}

// ===== AI 问一问 悬浮窗 =====
let _patentAskSource = "detail";
let _patentAskMessages = []; // [{role, content}]
let _patentAskStreaming = false;
const _PATENT_ASK_CACHE_PREFIX = "patentlens_ask_";
const _PATENT_ASK_CACHE_TTL = 60 * 60 * 1000; // 1 小时

function _patentAskCacheKey(pn) {
  return _PATENT_ASK_CACHE_PREFIX + (pn || "unknown");
}

function _savePatentAskCache() {
  const data = _getPatentDataSource(_patentAskSource);
  const pn = data && data.patent_number ? data.patent_number : "";
  if (!pn) return;
  try {
    localStorage.setItem(_patentAskCacheKey(pn), JSON.stringify({
      messages: _patentAskMessages,
      ts: Date.now(),
    }));
  } catch (e) { /* 忽略配额错误 */ }
}

function _loadPatentAskCache(pn) {
  if (!pn) return null;
  try {
    const raw = localStorage.getItem(_patentAskCacheKey(pn));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.messages)) return null;
    if (Date.now() - (obj.ts || 0) > _PATENT_ASK_CACHE_TTL) {
      localStorage.removeItem(_patentAskCacheKey(pn));
      return null;
    }
    return obj.messages;
  } catch (e) { return null; }
}

function _renderPatentAskMessages() {
  const msgEl = document.getElementById("patent-ask-messages");
  if (!msgEl) return;
  msgEl.innerHTML = "";
  if (_patentAskMessages.length === 0) {
    msgEl.innerHTML = '<p class="patent-ask-placeholder">勾选下方上下文，输入问题后发送。AI 将基于本篇专利内容回答。</p>';
    return;
  }
  // 跳过系统消息（系统提示词不展示）
  _patentAskMessages.forEach(m => {
    if (m.role === "system") return;
    _appendPatentAskMessage(m.role, m.content);
  });
  msgEl.scrollTop = msgEl.scrollHeight;
}

function openPatentAsk(source) {
  const modal = document.getElementById("patent-ask-modal");
  if (!modal) return;
  _patentAskSource = source || "detail";
  const data = _getPatentDataSource(_patentAskSource);
  const pn = data && data.patent_number ? data.patent_number : "";
  const pnEl = document.getElementById("patent-ask-pn");
  if (pnEl) pnEl.textContent = pn;
  // 恢复 1 小时内的历史对话（按专利号缓存）
  const cached = _loadPatentAskCache(pn);
  _patentAskMessages = cached ? cached.slice() : [];
  _renderPatentAskMessages();
  const inputEl = document.getElementById("patent-ask-input");
  if (inputEl) inputEl.value = "";
  modal.classList.remove("hidden");
  if (inputEl) setTimeout(() => inputEl.focus(), 50);
}

function closePatentAsk() {
  // 关闭时保留对话：仅隐藏，不清空内存与缓存
  _savePatentAskCache();
  const modal = document.getElementById("patent-ask-modal");
  if (modal) modal.classList.add("hidden");
}

function clearPatentAsk() {
  const data = _getPatentDataSource(_patentAskSource);
  const pn = data && data.patent_number ? data.patent_number : "";
  _patentAskMessages = [];
  if (pn) {
    try { localStorage.removeItem(_patentAskCacheKey(pn)); } catch (e) {}
  }
  _renderPatentAskMessages();
}

function _buildPatentAskContext() {
  const data = _getPatentDataSource(_patentAskSource);
  if (!data) return "";
  const parts = [];
  const absCb = document.getElementById("patent-ask-ctx-abstract");
  const clmCb = document.getElementById("patent-ask-ctx-claims");
  const descCb = document.getElementById("patent-ask-ctx-description");
  if (absCb && absCb.checked && data.abstract) parts.push("【摘要】\n" + data.abstract);
  if (clmCb && clmCb.checked && data.claims && data.claims.length) parts.push("【权利要求】\n" + _buildClaimsText(data));
  if (descCb && descCb.checked && data.description) parts.push("【说明书】\n" + data.description);
  return parts.join("\n\n");
}

function _appendPatentAskMessage(role, content) {
  const msgEl = document.getElementById("patent-ask-messages");
  if (!msgEl) return null;
  const ph = msgEl.querySelector(".patent-ask-placeholder");
  if (ph) ph.remove();
  const el = document.createElement("div");
  el.className = "patent-ask-msg " + role;
  if (role === "assistant") {
    el.innerHTML = '<div class="patent-ask-msg-content markdown-body">' + renderMarkdown(content) + '</div>';
  } else {
    el.textContent = content;
  }
  msgEl.appendChild(el);
  msgEl.scrollTop = msgEl.scrollHeight;
  return el;
}

async function sendPatentAsk() {
  if (_patentAskStreaming) return;
  const inputEl = document.getElementById("patent-ask-input");
  if (!inputEl) return;
  const question = inputEl.value.trim();
  if (!question) return;
  const config = window.AI.loadAIConfig();
  const provider = window.AI.getCurrentProvider(config);
  if (!provider) { alert("请先在「设置」中配置 AI 服务"); return; }

  _appendPatentAskMessage("user", question);
  inputEl.value = "";
  _patentAskStreaming = true;
  const sendBtn = document.getElementById("patent-ask-send-btn");
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = "回答中…"; }

  // 首轮：注入系统提示词 + 勾选的上下文
  if (_patentAskMessages.length === 0) {
    const context = _buildPatentAskContext();
    const sys = "你是一位资深专利分析工程师。请根据用户提供的专利内容回答用户关于该专利细节的问题。"
      + "如果问题超出提供内容范围，请明确说明。请用中文回答，使用 Markdown 格式。\n\n" + (context || "（未纳入任何上下文）");
    _patentAskMessages.push({ role: "system", content: sys });
  }
  _patentAskMessages.push({ role: "user", content: question });

  const assistantEl = _appendPatentAskMessage("assistant", "");
  const contentEl = assistantEl.querySelector(".patent-ask-msg-content");

  let acc = "";
  try {
    const stream = window.AI.streamChat(provider.type, provider.apiKey, provider.baseUrl, {
      model: provider.model,
      messages: _patentAskMessages.map(m => ({ role: m.role, content: m.content })),
      temperature: 0.3,
      maxTokens: 4096,
    });
    // 思考区挂在消息气泡内（contentEl 作为 host）
    const thinkingHost = _createThinkingHost(contentEl);
    let contentStarted = false;
    let renderRaf = null;
    for await (const chunk of stream) {
      if (chunk.reasoningContent && thinkingHost) {
        thinkingHost.appendReasoning(chunk.reasoningContent);
      }
      if (chunk.content) {
        if (!contentStarted) {
          contentStarted = true;
          if (thinkingHost) thinkingHost.startContent();
        }
        acc += chunk.content;
        if (!renderRaf) {
          renderRaf = requestAnimationFrame(() => {
            renderRaf = null;
            // 保留思考区，只更新回答文本节点
            if (contentEl) {
              // 把回答放到一个独立的 .patent-ask-answer 里
              let answerEl = contentEl.querySelector(":scope > .patent-ask-answer");
              if (!answerEl) {
                answerEl = document.createElement("div");
                answerEl.className = "patent-ask-answer markdown-body";
                contentEl.appendChild(answerEl);
              }
              answerEl.innerHTML = renderMarkdown(acc);
            }
          });
        }
      }
    }
    if (thinkingHost) thinkingHost.finish();
    if (contentEl) {
      let answerEl = contentEl.querySelector(":scope > .patent-ask-answer");
      if (!answerEl) {
        answerEl = document.createElement("div");
        answerEl.className = "patent-ask-answer markdown-body";
        contentEl.appendChild(answerEl);
      }
      answerEl.innerHTML = renderMarkdown(acc) || "（未返回内容）";
    }
    _patentAskMessages.push({ role: "assistant", content: acc });
    _savePatentAskCache(); // 流式完成后持久化对话
  } catch (e) {
    if (contentEl) contentEl.textContent = "回答失败：" + (e && e.message ? e.message : String(e));
    _savePatentAskCache();
  } finally {
    _patentAskStreaming = false;
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = "发送"; }
    const msgEl = document.getElementById("patent-ask-messages");
    if (msgEl) msgEl.scrollTop = msgEl.scrollHeight;
  }
}

function _initPatentAskBindings() {
  const closeBtn = document.getElementById("patent-ask-close-btn");
  if (closeBtn) closeBtn.addEventListener("click", closePatentAsk);
  const clearBtn = document.getElementById("patent-ask-clear-btn");
  if (clearBtn) clearBtn.addEventListener("click", () => {
    if (_patentAskMessages.length === 0) return;
    if (window.confirm("确定清空当前专利的对话记录吗？")) clearPatentAsk();
  });
  const sendBtn = document.getElementById("patent-ask-send-btn");
  if (sendBtn) sendBtn.addEventListener("click", sendPatentAsk);
  const inputEl = document.getElementById("patent-ask-input");
  if (inputEl) {
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPatentAsk(); }
    });
  }
  // 弹窗头部 AI 问一问按钮（数据来自 window._patentPopupData，由 openPatentPopup/switchPpvPatent 同步）
  const ppvAskBtn = document.getElementById("ppv-ai-ask-btn");
  if (ppvAskBtn) ppvAskBtn.addEventListener("click", () => openPatentAsk("popup"));
  // 弹窗头部网页翻译按钮
  const ppvTranslateBtn = document.getElementById("ppv-translate-btn");
  if (ppvTranslateBtn) ppvTranslateBtn.addEventListener("click", () => toggleGoogleTranslate());
}
_initPatentAskBindings();

function renderDocuments(data) {
  const container = document.getElementById("documents-content");
  const docs = data.documents;
  if (!docs) {
    container.innerHTML = '<p class="placeholder">未查询到文档信息</p>';
    return;
  }

  const docList = extractDocuments(docs);
  if (docList.length === 0) {
    container.innerHTML = '<pre class="json-preview">' + JSON.stringify(docs, null, 2) + '</pre>';
    return;
  }

  const office = data.office;
  const docNumber = docs.docNumber || data.applicationNumber;
  const isUS = data.office === "US";
  const isEP = data.office === "EP";
  const canDownload = isUS || isEP;
  const urlDocNum = isUS ? data.applicationNumber : encodeURIComponent(docNumber);

  // Build type counts for filter chips
  const typeCounts = {};
  docList.forEach(d => {
    const docCode = d.docCode || d.documentType || d.kindCode || d.type || "";
    const desc = d.docDesc || d.documentDescription || d.description || d.docId || "";
    const status = getStatusInfo(office, docCode, desc);
    const t = status.type;
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  });

  const typeNames = (PATENT_STATUS[office] && PATENT_STATUS[office].typeNames) || {
    "office_action": "审查意见", "response": "答复", "request": "请求",
    "allowance": "授权", "notification": "通知", "misc": "其他"
  };

  let filterHtml = '<div class="doc-filter-bar">';
  filterHtml += '<input type="text" id="doc-filter-input" class="doc-filter-input" placeholder="搜索文档名称、代码、描述...">';
  filterHtml += '<button class="doc-filter-chip active" data-filter-type="all">全部 <span class="chip-count">' + docList.length + '</span></button>';
  Object.keys(typeNames).forEach(t => {
    if (typeCounts[t]) {
      filterHtml += '<button class="doc-filter-chip" data-filter-type="' + t + '">' + typeNames[t] + ' <span class="chip-count">' + typeCounts[t] + '</span></button>';
    }
  });
  filterHtml += '</div>';

  let html = filterHtml;
  docList.forEach((d, idx) => {
    const docType = d.docCode || d.documentType || d.kindCode || d.type || "文档";
    const desc = d.docDesc || d.documentDescription || d.description || d.docId || "";
    const date = d.legalDateStr || d.documentDate || d.date || "";
    const docId = d.documentId || d.docId || "";
    const numberOfPages = d.numberOfPages != null ? d.numberOfPages : 1;
    const docFormat = d.docFormat || "PDF";

    const status = getStatusInfo(office, docType, desc);
    const filterType = status.type;

    let typeClass = "doc-type";
    const lowerDesc = desc.toLowerCase();
    if (lowerDesc.includes("rejection") || lowerDesc.includes("拒绝") || lowerDesc.includes("驳回")) {
      typeClass += " rejection";
    } else if (lowerDesc.includes("allowance") || lowerDesc.includes("准予") || lowerDesc.includes("授权")) {
      typeClass += " allowance";
    }

    const encodedDocId = encodeURIComponent(docId);
    const downloadUrl = (docId && canDownload) ? `/api/gd/doc-content/svc/doccontent/${data.office}/${urlDocNum}/${encodedDocId}/${numberOfPages}/${docFormat}` : null;
    const extractUrl = (docId && canDownload) ? `/api/gd/extract-text/${data.office}/${urlDocNum}/${encodedDocId}/${numberOfPages}/${docFormat}` : null;

    html += `
      <div class="doc-item" data-filter-type="${filterType}" data-search-text="${escapeHtml((docType + ' ' + desc + ' ' + date + ' ' + status.name).toLowerCase())}">
        <span class="${typeClass}">${escapeHtml(docType)}</span>
        <div class="doc-info">
          <div class="doc-desc">${escapeHtml(desc)}</div>
          ${date ? '<div class="doc-date">' + escapeHtml(date) + '</div>' : ''}
        </div>
        <div class="doc-actions">
          ${extractUrl ? `<select class="engine-select" data-idx="${idx}"><option value="auto">自动</option><option value="paddle_ocr_vl">PaddleOCR</option><option value="glm_ocr">GLM OCR</option></select>` : ''}
          ${extractUrl ? `<button class="btn-small btn-extract" data-action="extract" data-url="${extractUrl}" data-idx="${idx}" data-doctype="${escapeHtml(docType)}">提取内容</button>` : ''}
          ${downloadUrl ? `<button class="btn-small btn-download" data-action="download" data-url="${downloadUrl}" data-filename="${escapeHtml(docType)}_${escapeHtml(date.replace(/\//g, '-'))}.pdf">下载</button>` : ''}
          ${!canDownload ? '<span class="doc-readonly-hint">仅提供状态信息，暂不支持下载原文</span>' : ''}
        </div>
      </div>
      <div id="doc-extracted-${idx}" class="doc-extracted hidden"></div>
    `;
  });
  container.innerHTML = html;

  // Bind filter events
  const filterInput = document.getElementById("doc-filter-input");
  const filterChips = container.querySelectorAll(".doc-filter-chip");
  let activeFilter = "all";

  function applyDocFilter() {
    const keyword = filterInput ? filterInput.value.trim().toLowerCase() : "";
    container.querySelectorAll(".doc-item").forEach(el => {
      const matchType = activeFilter === "all" || el.dataset.filterType === activeFilter;
      const matchKeyword = !keyword || el.dataset.searchText.includes(keyword);
      el.style.display = (matchType && matchKeyword) ? "" : "none";
      // Also show/hide the following extracted div
      const next = el.nextElementSibling;
      if (next && next.classList.contains("doc-extracted")) {
        next.style.display = (matchType && matchKeyword) ? "" : "none";
      }
    });
  }

  filterChips.forEach(chip => {
    chip.addEventListener("click", () => {
      filterChips.forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      activeFilter = chip.dataset.filterType;
      applyDocFilter();
    });
  });

  if (filterInput) {
    filterInput.addEventListener("input", applyDocFilter);
  }
}

async function extractDocumentText(url, idx, docType) {
  const container = document.getElementById("doc-extracted-" + idx);
  if (!container) return;
  container.classList.remove("hidden");

  const engineSelect = document.querySelector(`.engine-select[data-idx="${idx}"]`);
  const selectedEngine = engineSelect ? engineSelect.value : "auto";
  const engine = selectedEngine === "auto" ? (ocrEngineSelect ? ocrEngineSelect.value : "paddle_ocr_vl") : selectedEngine;

  const config = window.AI.loadAIConfig();
  const glmApiKey = window.AI.getGlmOcrApiKey(config);

  container.innerHTML = '<p class="extracting">正在提取文档内容（引擎: ' + escapeHtml(engine === "auto" ? "自动" : engine) + '）...</p>';

  try {
    let data;
    if (isTauri && currentData) {
      const isUS = currentData.office === "US";
      const urlDocNum = isUS ? currentData.applicationNumber : encodeURIComponent(currentData.docNumber || currentData.applicationNumber);
      const it = kanbanState.documents.find(d => d.idx === idx) || currentData._allDocs?.[idx];
      if (!it) throw new Error("找不到文档信息");
      data = await doExtractText(currentData.office, urlDocNum, it.docId, it.numberOfPages, it.docFormat, engine, engine === "glm_ocr" ? glmApiKey : "");
    } else {
      const sep = url.includes("?") ? "&" : "?";
      let extractUrl = url + sep + "engine=" + encodeURIComponent(engine);
      if (engine === "glm_ocr" && glmApiKey) {
        extractUrl += "&api_key=" + encodeURIComponent(glmApiKey);
      }
      const resp = await fetch(extractUrl);
      if (!resp.ok) throw new Error("提取失败: HTTP " + resp.status);
      data = await resp.json();
    }

    if (data.error) {
      container.innerHTML = '<p class="extract-error">提取失败: ' + escapeHtml(data.error) + '</p>';
      return;
    }

    const text = data.text || "";
    const markdown = data.markdown || "";
    const usedEngine = data.engine || "unknown";
    const blocks = data.blocks || [];
    const pageDimensions = data.page_dimensions || {};

    if (!text && !markdown) {
      container.innerHTML = '<p class="extract-empty">未能提取到文本内容。可尝试切换 OCR 引擎（PaddleOCR 或 GLM OCR）后重新提取。</p>';
      return;
    }

    const displayText = markdown || text;
    const charCount = displayText.length;
    const blocksInfo = blocks.length > 0 ? ` · ${blocks.length} blocks` : "";

    container.innerHTML = `
      <div class="extracted-header">
        <span class="extracted-engine">引擎: ${escapeHtml(usedEngine)}</span>
        <span class="extracted-chars">字符数: ${charCount}${blocksInfo}</span>
        <button class="btn-small btn-ai-analyze" data-action="ai-analyze-doc" data-idx="${idx}" data-doctype="${escapeHtml(docType)}">AI 分析此文档</button>
      </div>
      <pre class="extracted-text">${escapeHtml(displayText)}</pre>
    `;

    container._extractedText = text;
    container._extractedMarkdown = markdown;
    container._docType = docType;

    kanbanState.extractions[idx] = { text, markdown, engine: usedEngine, blocks, pageDimensions };
    kanbanState.hasUnsavedWork = true;
    if (blocks.length > 0) {
      blocks.forEach(b => {
        const traceKey = "D" + idx + "_" + b.block_id;
        kanbanState.traceIndex[traceKey] = {
          docIdx: idx,
          page: b.page,
          bbox: b.bbox,
          content: b.content,
          label: b.label,
          originalBlockId: b.block_id,
          pageDimensions: pageDimensions[b.page] || null,
        };
      });
    }
    autoSaveCache();
  } catch (e) {
    container.innerHTML = '<p class="extract-error">提取失败: ' + escapeHtml(e.message) + '</p>';
  }
}

async function aiAnalyzeDocument(idx, docType) {
  let container = document.getElementById("doc-extracted-" + idx);
  if (!container) container = document.getElementById("kanban-extracted-" + idx);
  if (!container) return;

  let extractedText = container._extractedText || "";
  let extractedMarkdown = container._extractedMarkdown || "";
  if (!extractedText && !extractedMarkdown && kanbanState.extractions[idx]) {
    extractedText = kanbanState.extractions[idx].text || "";
    extractedMarkdown = kanbanState.extractions[idx].markdown || "";
  }
  const content = extractedMarkdown || extractedText;

  if (!content) {
    showError("请先提取文档内容");
    return;
  }

  const config = window.AI.loadAIConfig();
  const provider = window.AI.getCurrentProvider(config);
  if (!provider) {
    showError("请先在 AI 设置中配置并选择一个 AI 服务商");
    return;
  }

  const resultSection = document.getElementById("result-section");
  const aiTab = resultSection.querySelector('[data-tab="ai-summary"]');
  if (aiTab) aiTab.click();

  if (aiSummarizeBtn) aiSummarizeBtn.disabled = true;
  if (aiStatus) {
    aiStatus.textContent = "正在分析文档: " + docType + "...";
    aiStatus.className = "ai-status ai-status-processing";
  }
  if (aiSummaryResult) aiSummaryResult.classList.remove("hidden");

  const truncatedContent = content.length > 30000 ? content.substring(0, 30000) + "\n\n[...内容过长已截断...]" : content;

  const systemPrompt = window.AI.getCustomPrompt(window.AI.loadAIConfig(), "docAnalysis");

  try {
    let fullText = "";
    let _rafPending = false;
    // Create stable container once
    if (aiSummaryResult) aiSummaryResult.innerHTML = '<div class="ai-summary-content markdown-body"></div>';
    const streamContainer = aiSummaryResult ? aiSummaryResult.querySelector(".ai-summary-content") : null;
    for await (const chunk of window.AI.streamChat(
      provider.type, provider.apiKey, provider.baseUrl,
      {
        model: provider.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: "文档类型: " + docType + "\n\n文档内容:\n" + truncatedContent },
        ],
        temperature: 0.3,
        maxTokens: 32768,
      }
    )) {
      if (chunk.content) {
        fullText += chunk.content;
        if (!_rafPending) {
          _rafPending = true;
          requestAnimationFrame(() => {
            if (streamContainer) streamContainer.innerHTML = renderMarkdown(fullText);
            _rafPending = false;
          });
        }
      }
    }
    // Final render
    if (streamContainer) streamContainer.innerHTML = renderMarkdown(fullText);
    if (aiStatus) {
      aiStatus.textContent = "分析完成 ✓";
      aiStatus.className = "ai-status ai-status-success";
    }
  } catch (e) {
    if (aiSummaryResult) aiSummaryResult.innerHTML = '<p class="placeholder" style="color:var(--danger)">' + escapeHtml(e.toString()) + "</p>";
    if (aiStatus) {
      aiStatus.textContent = "分析失败 ✗";
      aiStatus.className = "ai-status ai-status-error";
    }
  } finally {
    if (aiSummarizeBtn) aiSummarizeBtn.disabled = false;
  }
}

async function downloadDocument(url, filename) {
  try {
    if (isTauri && currentData) {
      const docContentMatch = url.match(/doc-content\/svc\/doccontent\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)/);
      if (docContentMatch) {
        const result = await tauriInvoke("download_document", {
          country: docContentMatch[1],
          docNumber: docContentMatch[2],
          docId: docContentMatch[3],
          pages: docContentMatch[4],
          format: docContentMatch[5],
        });
        if (result && result.success && result.data) {
          const binaryStr = atob(result.data.data);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
          const blob = new Blob([bytes], { type: "application/pdf" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = filename || "document.pdf";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(a.href);
          return;
        }
      }
    }

    const resp = await fetch(url, { headers: { "Accept": "application/pdf,*/*" } });
    if (!resp.ok) throw new Error("下载失败: HTTP " + resp.status);
    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("text/plain") || contentType.includes("text/html")) {
      const text = await resp.text();
      if (text.includes("Attachment Not Found") || text.includes("Not Found")) {
        throw new Error("文档暂不可下载（Attachment Not Found），该文档可能尚未上传至 Global Dossier");
      }
    }
    const blob = await resp.blob();
    if (blob.size < 100) {
      throw new Error("下载的文件过小，文档可能暂不可用");
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename || "document.pdf";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  } catch (e) {
    showError("下载失败: " + e.message);
  }
}

function extractDocuments(docs) {
  if (!docs) return [];
  if (Array.isArray(docs)) return docs;
  if (docs.docs) return Array.isArray(docs.docs) ? docs.docs : [docs.docs];
  if (docs.documentList) {
    const list = docs.documentList;
    if (Array.isArray(list)) return list;
    if (list.document) {
      return Array.isArray(list.document) ? list.document : [list.document];
    }
  }
  return [docs];
}

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    const app = document.getElementById("app");
    const wideTabs = ["kanban", "ai-analysis"];
    if (wideTabs.includes(btn.dataset.tab)) {
      app.classList.add("wide-layout");
    } else {
      app.classList.remove("wide-layout");
    }
  });
});

aiSettingsBtn.addEventListener("click", () => {
  loadAISettingsToForm();
  aiSettingsModal.classList.remove("hidden");
});

if (modalCloseBtn) modalCloseBtn.addEventListener("click", () => { if (aiSettingsModal) aiSettingsModal.classList.add("hidden"); });
if (modalOverlay) modalOverlay.addEventListener("click", () => { if (aiSettingsModal) aiSettingsModal.classList.add("hidden"); });

if (aiProviderSelect) aiProviderSelect.addEventListener("change", () => {
  const type = aiProviderSelect.value;
  aiBaseUrlInput.value = window.AI.getDefaultBaseUrl(type);
  updateModelOptions(type);
});

if (ocrEngineSelect) {
  ocrEngineSelect.addEventListener("change", toggleOcrGlmKeyVisibility);
}

if (aiTestBtn) aiTestBtn.addEventListener("click", async () => {
  const type = aiProviderSelect.value;
  const apiKey = aiApiKeyInput.value.trim();
  const baseUrl = aiBaseUrlInput.value.trim();
  const model = aiModelSelect.value;
  if (!apiKey) { showTestResult(false, "请输入 API Key"); return; }
  aiTestBtn.disabled = true;
  try {
    const result = await window.AI.testConnection(type, apiKey, baseUrl, model);
    showTestResult(result.success, result.message);
  } catch (e) {
    showTestResult(false, e.toString());
  } finally {
    aiTestBtn.disabled = false;
  }
});

if (aiSaveBtn) aiSaveBtn.addEventListener("click", () => {
  const type = aiProviderSelect.value;
  const config = window.AI.loadAIConfig();
  if (config[type]) {
    config[type].apiKey = aiApiKeyInput.value.trim();
    config[type].baseUrl = aiBaseUrlInput.value.trim();
    config[type].model = aiModelSelect.value;
  }
  window.AI.saveAIConfig(config);
  aiTestResult.classList.add("hidden");
  aiSettingsModal.classList.add("hidden");
});

// OCR save button
const ocrSaveBtn = document.getElementById("ocr-save-btn");
if (ocrSaveBtn) {
  ocrSaveBtn.addEventListener("click", () => {
    const config = window.AI.loadAIConfig();
    const ocrConfig = window.AI.getOCRConfig(config);
    ocrConfig.engine = ocrEngineSelect.value;
    ocrConfig.glmKey = ocrGlmKeyInput.value.trim();
    const autoCheckbox = document.getElementById("ocr-auto-checkbox");
    ocrConfig.autoOcr = autoCheckbox ? autoCheckbox.checked : true;
    window.AI.saveAIConfig(config);
    aiSettingsModal.classList.add("hidden");
  });
}

// Translate save button
const translateSaveBtn = document.getElementById("translate-save-btn");
if (translateSaveBtn) {
  translateSaveBtn.addEventListener("click", () => {
    const config = window.AI.loadAIConfig();
    const translateProviderSelect = document.getElementById("translate-provider-select");
    const translateApiKeyInput = document.getElementById("translate-api-key-input");
    const translateModelSelect = document.getElementById("translate-model-select");
    const translateDefaultLang = document.getElementById("translate-default-lang");

    if (!config.translate) config.translate = {};
    config.translate.provider = translateProviderSelect ? translateProviderSelect.value : "";
    config.translate.apiKey = translateApiKeyInput ? translateApiKeyInput.value.trim() : "";
    config.translate.model = translateModelSelect ? translateModelSelect.value : "";
    config.translate.defaultLang = translateDefaultLang ? translateDefaultLang.value : "en";
    window.AI.saveAIConfig(config);
    aiSettingsModal.classList.add("hidden");
  });
}

// Prompts save button
const promptsSaveBtn = document.getElementById("prompts-save-btn");
if (promptsSaveBtn) {
  promptsSaveBtn.addEventListener("click", () => {
    const config = window.AI.loadAIConfig();
    const promptKeys = [
      { id: "prompt-kanban-analysis", key: "kanbanAnalysis" },
      { id: "prompt-kanban-simple", key: "kanbanAnalysisSimple" },
      { id: "prompt-doc-analysis", key: "docAnalysis" },
      { id: "prompt-cited-refs-analysis", key: "citedRefsAnalysis" },
    ];
    promptKeys.forEach(p => {
      const el = document.getElementById(p.id);
      if (el) {
        const val = el.value.trim();
        const defaultVal = window.AI.getDefaultPrompt(p.key);
        if (val && val !== defaultVal) {
          window.AI.saveCustomPrompt(config, p.key, val);
        } else {
          window.AI.resetPrompt(config, p.key);
        }
      }
    });
    window.AI.saveAIConfig(config);
    aiSettingsModal.classList.add("hidden");
  });
}

// Prompt group expand/collapse
document.querySelectorAll(".prompt-toggle-btn").forEach(btn => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const group = btn.closest(".prompt-group");
    if (!group) return;
    const body = group.querySelector(".prompt-group-body");
    if (body) body.classList.toggle("collapsed");
  });
});
// Also allow clicking the header to toggle
document.querySelectorAll(".prompt-group-header").forEach(header => {
  header.addEventListener("click", () => {
    const group = header.closest(".prompt-group");
    if (!group) return;
    const body = group.querySelector(".prompt-group-body");
    if (body) body.classList.toggle("collapsed");
  });
});

// Settings tab switching
document.querySelectorAll(".settings-tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const tabId = btn.dataset.settingsTab;
    document.querySelectorAll(".settings-tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".settings-tab-content").forEach(c => c.classList.remove("active"));
    btn.classList.add("active");
    const tabContent = document.getElementById("settings-tab-" + tabId);
    if (tabContent) tabContent.classList.add("active");
    // Refresh cache tab data when selected
    if (tabId === "cache") {
      refreshHistoryList();
    }
  });
});

// Translate provider select change
const translateProviderSelectEl = document.getElementById("translate-provider-select");
if (translateProviderSelectEl) {
  translateProviderSelectEl.addEventListener("change", () => {
    const type = translateProviderSelectEl.value;
    const translateApiKeyGroup = document.getElementById("translate-api-key-group");
    const translateModelSelect = document.getElementById("translate-model-select");

    if (type) {
      if (translateApiKeyGroup) translateApiKeyGroup.style.display = "";
      updateTranslateModelOptions(type);
    } else {
      if (translateApiKeyGroup) translateApiKeyGroup.style.display = "none";
      if (translateModelSelect) translateModelSelect.innerHTML = '<option value="">跟随 AI 服务模型</option>';
    }
  });
}

function updateTranslateModelOptions(type) {
  const translateModelSelect = document.getElementById("translate-model-select");
  if (!translateModelSelect) return;
  const models = window.AI.getAvailableModels(type);
  const defaultModel = window.AI.getDefaultTranslateModel(type);
  translateModelSelect.innerHTML = "";
  models.forEach(model => {
    const option = document.createElement("option");
    option.value = model.value;
    option.textContent = model.label + (model.value === defaultModel ? " (推荐)" : "");
    translateModelSelect.appendChild(option);
  });
  // Set default
  translateModelSelect.value = defaultModel;
}

function loadAISettingsToForm() {
  const config = window.AI.loadAIConfig();
  let type = aiProviderSelect.value;
  if (!config[type]) type = Object.keys(config).find(k => k !== "ocr" && k !== "prompts" && k !== "translate") || "zhipu";
  if (config[type]) {
    aiApiKeyInput.value = config[type].apiKey || "";
    aiBaseUrlInput.value = config[type].baseUrl || "";
    updateModelOptions(type);
    if (config[type].model) aiModelSelect.value = config[type].model;
  } else {
    aiBaseUrlInput.value = window.AI.getDefaultBaseUrl(type);
    updateModelOptions(type);
  }
  const ocrConfig = window.AI.getOCRConfig(config);
  if (ocrEngineSelect) ocrEngineSelect.value = ocrConfig.engine || "paddle_ocr_vl";
  if (ocrGlmKeyInput) ocrGlmKeyInput.value = ocrConfig.glmKey || "";
  const autoCheckbox = document.getElementById("ocr-auto-checkbox");
  if (autoCheckbox) autoCheckbox.checked = ocrConfig.autoOcr !== false;
  toggleOcrGlmKeyVisibility();

  // Load translate settings
  const translateProviderSelect = document.getElementById("translate-provider-select");
  const translateApiKeyInput = document.getElementById("translate-api-key-input");
  const translateDefaultLang = document.getElementById("translate-default-lang");
  const translateApiKeyGroup = document.getElementById("translate-api-key-group");
  const translate = config.translate || {};
  if (translateProviderSelect) {
    translateProviderSelect.value = translate.provider || "";
    if (translate.provider) {
      if (translateApiKeyGroup) translateApiKeyGroup.style.display = "";
      updateTranslateModelOptions(translate.provider);
      const translateModelSelect = document.getElementById("translate-model-select");
      if (translateModelSelect && translate.model) translateModelSelect.value = translate.model;
    } else {
      if (translateApiKeyGroup) translateApiKeyGroup.style.display = "none";
      const translateModelSelect = document.getElementById("translate-model-select");
      if (translateModelSelect) translateModelSelect.innerHTML = '<option value="">跟随 AI 服务模型</option>';
    }
  }
  if (translateApiKeyInput) translateApiKeyInput.value = translate.apiKey || "";
  if (translateDefaultLang) translateDefaultLang.value = translate.defaultLang || "en";

  // Load custom prompts
  const promptKeys = [
    { id: "prompt-kanban-analysis", key: "kanbanAnalysis" },
    { id: "prompt-kanban-simple", key: "kanbanAnalysisSimple" },
    { id: "prompt-doc-analysis", key: "docAnalysis" },
    { id: "prompt-cited-refs-analysis", key: "citedRefsAnalysis" },
  ];
  promptKeys.forEach(p => {
    const el = document.getElementById(p.id);
    if (el) el.value = window.AI.getCustomPrompt(config, p.key);
  });

  // Load OPS settings (EPO OPS 降级查询配置)
  if (typeof loadOpsSettingsToForm === "function") loadOpsSettingsToForm();
}

function toggleOcrGlmKeyVisibility() {
  if (!ocrGlmKeyGroup) return;
  ocrGlmKeyGroup.style.display = (ocrEngineSelect && ocrEngineSelect.value === "glm_ocr") ? "" : "none";
}

// Reset prompt buttons
document.querySelectorAll("[id^='reset-prompt-']").forEach(btn => {
  btn.addEventListener("click", () => {
    const promptId = btn.id.replace("reset-prompt-", "");
    const keyMap = {
      "kanban-analysis": "kanbanAnalysis",
      "kanban-simple": "kanbanAnalysisSimple",
      "doc-analysis": "docAnalysis",
      "cited-refs-analysis": "citedRefsAnalysis",
    };
    const key = keyMap[promptId];
    if (!key) return;
    const textarea = document.getElementById("prompt-" + promptId);
    if (textarea) {
      textarea.value = window.AI.getDefaultPrompt(key);
    }
  });
});

function updateModelOptions(type) {
  const models = window.AI.getAvailableModels(type);
  aiModelSelect.innerHTML = "";
  models.forEach(model => {
    const option = document.createElement("option");
    option.value = model.value;
    option.textContent = model.label;
    aiModelSelect.appendChild(option);
  });
}

function showTestResult(success, message) {
  aiTestResult.className = "test-result " + (success ? "test-success" : "test-error");
  aiTestResult.textContent = (success ? "✓ " : "✗ ") + message;
  aiTestResult.classList.remove("hidden");
}

async function doExtractText(office, docNum, docId, pages, docFormat, engine, apiKey) {
  // JP documents: use JPO API via Tauri command
  if (office === "JP" && isTauri) {
    const jpDocType = mapJpDocType(docId, null) || "dispatch";
    const result = await tauriInvoke("jpo_fetch_doc", {
      appNumber: docNum,
      docType: jpDocType,
    });
    if (result && result.success && result.data) {
      const docs = result.data.documents || [];
      const allText = docs.map(d => d.content).join("\n\n");
      return {
        text: allText,
        markdown: allText,
        engine: "jpo_api",
        blocks: [],
        page_dimensions: {},
        error: null,
      };
    }
    throw new Error(result?.error || "JPO 文档获取失败");
  }

  // DE: 案卷查阅需CAPTCHA，无法程序化获取文档原文
  if (office === "DE") {
    // 尝试获取注册信息作为替代
    if (isTauri) {
      const result = await tauriInvoke("dpma_register_info", {
        number: docNum,
      });
      if (result && result.success && result.data) {
        const info = result.data;
        const lines = [];
        if (info.status) lines.push(`程序状态: ${info.status}`);
        if (info.bescheideCount != null) lines.push(`审查通知数: ${info.bescheideCount}`);
        if (info.erwiderungenCount != null) lines.push(`答复数: ${info.erwiderungenCount}`);
        if (info.applicant) lines.push(`申请人: ${info.applicant}`);
        if (info.filingDate) lines.push(`申请日: ${info.filingDate}`);
        if (info.title) lines.push(`标题: ${info.title}`);
        lines.push("");
        lines.push("⚠ DPMAregister 案卷查阅(Akteneinsicht)需图形验证码，无法程序化获取审查文档原文。");
        lines.push("请访问 https://register.dpma.de 手动查阅。");
        const text = lines.join("\n");
        return {
          text,
          markdown: text,
          engine: "dpma_register",
          blocks: [],
          page_dimensions: {},
          error: null,
        };
      }
    }
    throw new Error("DE 专利审查文档需通过 DPMAregister 网站手动查阅（需验证码），暂不支持程序化获取");
  }

  if (isTauri) {
    const result = await tauriInvoke("extract_text", {
      country: office,
      docNumber: docNum,
      docId: docId,
      pages: pages,
      format: docFormat,
      engine: engine,
      apiKey: apiKey || "",
    });
    if (result && result.success && result.data) {
      const d = result.data;
      return {
        text: d.text || "",
        markdown: d.markdown || "",
        engine: d.engine || "none",
        blocks: d.blocks || [],
        page_dimensions: d.page_dimensions || {},
        error: d.error || null,
      };
    }
    throw new Error(result?.error || "Tauri extract_text failed");
  }

  let extractUrl = `/api/gd/extract-text/${office}/${docNum}/${encodeURIComponent(docId)}/${pages}/${docFormat}?engine=${encodeURIComponent(engine)}`;
  if (engine === "glm_ocr" && apiKey) {
    extractUrl += "&api_key=" + encodeURIComponent(apiKey);
  }
  const resp = await fetch(extractUrl);
  if (!resp.ok) throw new Error("HTTP " + resp.status);
  return await resp.json();
}

function buildTimelineSummary(office, documents) {
  if (!documents || documents.length === 0) return "";

  const officeNames = { US: "USPTO (美国)", EP: "EPO (欧洲)", CN: "CNIPA (中国)", DE: "DPMA (德国)", JP: "JPO (日本)" };
  const officeLabel = officeNames[office] || office;

  const typeLabels = {
    office_action: "审查意见", response: "答复", allowance: "授权",
    request: "请求", notification: "通知", misc: "其他",
  };

  // Sort documents by date for timeline
  const sorted = [...documents].sort((a, b) => {
    const da = parseDate(a.date);
    const db = parseDate(b.date);
    return da - db;
  });

  // Determine current status from the latest document
  const latest = sorted[sorted.length - 1];
  let currentStatus = "未知";
  if (latest) {
    if (latest.type === "allowance") {
      currentStatus = "已授权";
    } else if (latest.type === "office_action") {
      currentStatus = "审查中（待答复）";
    } else if (latest.type === "response") {
      currentStatus = "审查中（已答复，等待审查员回应）";
    } else if (latest.type === "request") {
      currentStatus = "审查中（已提交请求）";
    } else if (latest.type === "notification") {
      currentStatus = "审查中（有通知）";
    } else {
      currentStatus = latest.stage || "审查中";
    }
  }

  let lines = [];
  lines.push("## 审查时间线概要");
  lines.push("专利局: " + officeLabel);
  lines.push("当前状态: " + currentStatus);
  lines.push("");
  lines.push("| 序号 | 日期 | 文档代码 | 文档名称 | 类型 | 阶段 |");
  lines.push("|------|------|---------|---------|------|------|");

  sorted.forEach((doc, i) => {
    const typeLabel = typeLabels[doc.type] || doc.type || "其他";
    lines.push("| " + (i + 1) + " | " + (doc.date || "—") + " | " + (doc.docCode || "—") + " | " + (doc.name || "—") + " | " + typeLabel + " | " + (doc.stage || "—") + " |");
  });

  lines.push("");
  lines.push("--- 以下为各文档的详细提取内容 ---");
  lines.push("");

  return lines.join("\n");
}

async function runCitedRefsAnalysis(selectedIdxs) {
  if (!currentData || !kanbanState.documents.length) return;

  const config = window.AI.loadAIConfig();
  const provider = window.AI.getCurrentProvider(config);
  if (!provider) {
    showError("请先在 AI 设置中配置并选择一个 AI 服务商");
    return;
  }

  const citedRefsManualBtn = document.getElementById("cited-refs-manual-btn");
  if (citedRefsManualBtn) citedRefsManualBtn.disabled = true;
  // Interrupt any existing process
  if (activeAnalysisProcess) {
    abortActiveProcess();
  }
  activeAnalysisProcess = "citedRefs";
  citedRefsAbortController = new AbortController();
  const citedRefsAbortBtn = document.getElementById("cited-refs-abort-btn");
  // Hide all action buttons, show abort
  ["kanban-manual-select-btn", "cited-refs-manual-btn"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add("hidden");
  });
  if (citedRefsAbortBtn) citedRefsAbortBtn.classList.remove("hidden");

  try {
    const citedDocs = kanbanState.documents.filter(d => selectedIdxs.includes(d.idx));

    const analysisSection = document.getElementById("kanban-analysis");
    const analysisContent = document.getElementById("kanban-analysis-content");
    if (!analysisSection || !analysisContent) {
      showError("分析区域未找到");
      return;
    }
    analysisSection.classList.remove("hidden");
    analysisContent.innerHTML = renderAiProgressUI("extract", "正在提取引用文献内容...", -1);

    // 先提取引用文献文档内容（如果尚未提取）— 断点续OCR
    const ocrConfig = window.AI.getOCRConfig(config);
    const primaryEngine = ocrConfig.engine || "paddle_ocr_vl";
    const glmApiKey = window.AI.getGlmOcrApiKey(config);
    const isUS = currentData.office === "US";
    const urlDocNum = isUS ? currentData.applicationNumber : encodeURIComponent(currentData.docNumber || currentData.applicationNumber);

    const CITED_MAX_RETRIES = 5;
    const CITED_RETRY_BASE_DELAY = 8000;
    const citedMissing = citedDocs.filter(doc => !kanbanState.extractions[doc.idx] || (!kanbanState.extractions[doc.idx].text && !kanbanState.extractions[doc.idx].markdown));

    for (let i = 0; i < citedMissing.length; i++) {
      const doc = citedMissing[i];
      // Double-check: may have been filled
      if (kanbanState.extractions[doc.idx] && (kanbanState.extractions[doc.idx].text || kanbanState.extractions[doc.idx].markdown)) continue;
      if (citedRefsAbortController && citedRefsAbortController.signal.aborted) break;

      const citedExtractProgress = Math.round(((i + 1) / citedMissing.length) * 60);
      analysisContent.innerHTML = renderAiProgressUI("extract", "提取引用文献 (" + (i + 1) + "/" + citedMissing.length + "): " + doc.docCode + " - " + doc.name, citedExtractProgress);

      // Retry loop with exponential backoff
      let extracted = false;
      for (let attempt = 0; attempt < CITED_MAX_RETRIES && !extracted; attempt++) {
        try {
          const useApiKey = primaryEngine === "glm_ocr" ? glmApiKey : "";
          const result = await doExtractText(currentData.office, urlDocNum, doc.docId, doc.numberOfPages, doc.docFormat, primaryEngine, useApiKey);

          if (result.error) {
            const isRateLimit = result.error.includes("429") || result.error.includes("rate") || result.error.includes("limit");
            // Try fallback engine
            const fallbackEngine = primaryEngine === "paddle_ocr_vl" ? "glm_ocr" : "paddle_ocr_vl";
            if (glmApiKey && fallbackEngine === "glm_ocr") {
              const fbResult = await doExtractText(currentData.office, urlDocNum, doc.docId, doc.numberOfPages, doc.docFormat, "glm_ocr", glmApiKey);
              if (!fbResult.error && (fbResult.text || fbResult.markdown)) {
                kanbanState.extractions[doc.idx] = {
                  markdown: fbResult.markdown || "", text: fbResult.text || "",
                  blocks: fbResult.blocks || [], pageDimensions: fbResult.page_dimensions || {},
                  engine: "glm_ocr",
                };
                kanbanState.hasUnsavedWork = true;
                extracted = true;
                break;
              }
            }
            // Retry with delay
            if (attempt < CITED_MAX_RETRIES - 1) {
              const delay = isRateLimit
                ? CITED_RETRY_BASE_DELAY * Math.pow(2, attempt) + Math.random() * 3000
                : CITED_RETRY_BASE_DELAY * Math.pow(1.5, attempt);
              analysisContent.innerHTML = `<p class="extracting" style="color:var(--warning)">${doc.name} ${isRateLimit ? '因限速等待重试' : '提取出错'} (${attempt + 1}/${CITED_MAX_RETRIES})，约${Math.round(delay/1000)}秒后重试...</p>`;
              await new Promise(r => setTimeout(r, delay));
              continue;
            }
            kanbanState.extractions[doc.idx] = { text: "", error: result.error };
          } else if (result.text || result.markdown) {
            kanbanState.extractions[doc.idx] = {
              markdown: result.markdown || "", text: result.text || "",
              blocks: result.blocks || [], pageDimensions: result.page_dimensions || {},
              engine: result.engine || primaryEngine,
            };
            kanbanState.hasUnsavedWork = true;
            extracted = true;
          } else {
            // Empty result, retry
            if (attempt < CITED_MAX_RETRIES - 1) {
              const delay = CITED_RETRY_BASE_DELAY * Math.pow(1.5, attempt);
              analysisContent.innerHTML = `<p class="extracting" style="color:var(--warning)">${doc.name} 提取结果为空，重试中 (${attempt + 1}/${CITED_MAX_RETRIES})...</p>`;
              await new Promise(r => setTimeout(r, delay));
              continue;
            }
            kanbanState.extractions[doc.idx] = { text: "", error: "提取结果为空" };
          }
        } catch (e) {
          if (attempt < CITED_MAX_RETRIES - 1) {
            const delay = CITED_RETRY_BASE_DELAY * Math.pow(1.5, attempt);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          kanbanState.extractions[doc.idx] = { text: "", error: e.message };
        }
      }
    }
    autoSaveCache();

    // 构建分析内容
    const lines = [];
    lines.push(`# 引用文献梳理\n\n专利号: ${currentData.applicationNumber}\n\n`);
    lines.push("## 引用文献相关文档\n");

    let hasContent = false;
    for (const doc of citedDocs) {
      const extraction = kanbanState.extractions[doc.idx];
      if (extraction && extraction.text) {
        lines.push(`### ${doc.docCode} - ${doc.name}（${doc.date}）\n${extraction.text}\n`);
        hasContent = true;
      } else {
        lines.push(`### ${doc.docCode} - ${doc.name}（${doc.date}）\n[未能提取内容]\n`);
      }
    }

    if (!hasContent) {
      analysisContent.innerHTML = '<p class="placeholder" style="color:var(--danger)">所有引用文献文档均未能提取到内容</p>';
      return;
    }

    // 使用自定义提示词
    const citedRefsPrompt = window.AI.getCustomPrompt(config, "citedRefsAnalysis");

    lines.push("\n## 分析要求\n");
    lines.push(citedRefsPrompt || "请对以上引用文献相关文档进行分析，包括：\n1. 审查员引用了哪些文献？列出每篇引用文献的编号、类型和相关性说明\n2. 申请人引用了哪些文献？与审查员引用有何异同\n3. 引用文献的技术领域分布，是否涉及竞争对手专利\n4. 引用文献对本专利权利要求的影响评估\n5. 建议关注的引用文献和潜在风险");

    const prompt = `你是一位资深专利分析师，专注于引用文献分析。请根据以下引用文献相关文档，进行系统梳理和分析。\n\n${lines.join("\n")}`;

    analysisContent.innerHTML = '<div class="kanban-analysis-content markdown-body"></div>';
    const streamContainer = analysisContent.querySelector(".kanban-analysis-content");
    // 思考区 + 回答区分层，避免 innerHTML 覆盖思考区
    const answerContainer = document.createElement("div");
    answerContainer.className = "kanban-analysis-answer";
    streamContainer.appendChild(answerContainer);
    const thinkingHost = _createThinkingHost(streamContainer);
    let _citedContentStarted = false;
    let fullText = "";
    let _streamRafPending = false;
    let _lastRenderLen = 0;
    for await (const chunk of window.AI.streamChat(
      provider.type, provider.apiKey, provider.baseUrl,
      {
        model: provider.model,
        messages: [
          { role: "system", content: "你是一位资深专利分析师，专注于引用文献分析。" },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        maxTokens: 32768,
      },
      citedRefsAbortController ? citedRefsAbortController.signal : undefined
    )) {
      if (chunk.reasoningContent && thinkingHost) {
        thinkingHost.appendReasoning(chunk.reasoningContent);
      }
      if (chunk.content) {
        if (!_citedContentStarted) {
          _citedContentStarted = true;
          if (thinkingHost) thinkingHost.startContent();
        }
        fullText += chunk.content;
        if (!_streamRafPending && (fullText.length - _lastRenderLen > 20 || fullText.length < 200)) {
          _streamRafPending = true;
          requestAnimationFrame(() => {
            if (answerContainer) {
              answerContainer.innerHTML = marked.parse(fullText);
            }
            _lastRenderLen = fullText.length;
            _streamRafPending = false;
          });
        }
      }
    }
    if (thinkingHost) thinkingHost.finish();
    // Final render
    if (answerContainer) answerContainer.innerHTML = marked.parse(fullText);

    kanbanState.citedRefsAnalysis = fullText;
    kanbanState.hasUnsavedWork = true;
    autoSaveCache();
    prefetchPatentLinks();
  } catch (e) {
    const analysisContent = document.getElementById("kanban-analysis-content");
    if (analysisContent) analysisContent.innerHTML = '<p class="placeholder" style="color:var(--danger)">' + escapeHtml(e.toString()) + '</p>';
    showError("引用文献梳理失败: " + e.message);
  } finally {
    activeAnalysisProcess = null;
    ["kanban-manual-select-btn", "cited-refs-manual-btn"].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.disabled = false; el.classList.remove("hidden"); }
    });
    const citedRefsAbortBtn = document.getElementById("cited-refs-abort-btn");
    if (citedRefsAbortBtn) citedRefsAbortBtn.classList.add("hidden");
    citedRefsAbortController = null;
  }
}

// Cited refs abort button handler
const citedRefsAbortBtn = document.getElementById("cited-refs-abort-btn");
if (citedRefsAbortBtn) {
  citedRefsAbortBtn.addEventListener("click", () => {
    abortActiveProcess();
    const statusEl = document.getElementById("ai-analysis-status");
    if (statusEl) statusEl.textContent = "引用文献梳理已中止";
  });
}

// Manual select button - now in HTML
const manualSelectBtn = document.getElementById("kanban-manual-select-btn");
if (manualSelectBtn) {
  manualSelectBtn.addEventListener("click", () => {
    buildReviewManualSelectPanel();
  });
}

// Cited refs manual select button - now in HTML
const citedRefsManualBtn = document.getElementById("cited-refs-manual-btn");

if (citedRefsManualBtn) {
  citedRefsManualBtn.addEventListener("click", () => {
    const manualSelectPanel = document.getElementById("ai-manual-select");
    if (!manualSelectPanel) return;

    // Interrupt any existing process
    if (activeAnalysisProcess) {
      abortActiveProcess();
    }

    const items = kanbanState.documents;
    const CITED_DOC_CODES = ["FOR", "892", "1449", "IDS", "SRNT", "SRFW"];

    let html = '<div class="ai-manual-header"><span class="ai-manual-title">选择引用文献文件范围</span></div>';
    html += '<div class="ai-manual-toolbar">';
    html += '<input type="text" id="cited-manual-search-input" class="merge-search-input" placeholder="搜索文档名称、代码、日期...">';
    html += '<div class="ai-manual-select-all"><button id="cited-manual-select-all" class="btn-small btn-extract">全选</button><button id="cited-manual-select-none" class="btn-small btn-extract">全不选</button><button id="cited-manual-select-default" class="btn-small btn-extract">默认选择</button></div>';
    html += '</div>';
    html += '<div class="ai-manual-docs">';
    items.forEach(it => {
      const searchText = ((it.name || '') + ' ' + (it.docCode || '') + ' ' + (it.date || '')).toLowerCase();
      html += `
        <label class="ai-manual-doc-item" data-search-text="${escapeHtml(searchText)}">
          <input type="checkbox" class="cited-manual-select-checkbox" data-idx="${it.idx}" ${CITED_DOC_CODES.includes(it.docCode) ? 'checked' : ''}>
          <div class="ai-manual-doc-info">
            <span class="ai-manual-doc-code">${escapeHtml(it.docCode)}</span>
            <span class="ai-manual-doc-name">${escapeHtml(it.name)}</span>
            <span class="ai-manual-doc-date">${escapeHtml(it.date)}</span>
          </div>
        </label>
      `;
    });
    html += '</div>';
    html += '<div id="cited-manual-selected-summary" class="manual-selected-summary"></div>';
    html += '<div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">';
    html += '<button id="cited-manual-select-cancel" class="btn-secondary">取消</button>';
    html += '<button id="cited-manual-select-merge-btn" class="btn-secondary">合并导出选中文档</button>';
    html += '<button id="cited-manual-select-confirm" class="btn-primary">确认并开始AI梳理</button>';
    html += '</div>';

    manualSelectPanel.innerHTML = html;
    manualSelectPanel.classList.remove("hidden");

    // Try to load saved selections, fall back to defaults
    if (!loadManualSelection("cited", items, ".cited-manual-select-checkbox", manualSelectPanel, null)) {
      // Apply default checks (already set in HTML via CITED_DOC_CODES)
    }

    // Update selected summary
    function updateCitedSummary() {
      const summaryEl = document.getElementById("cited-manual-selected-summary");
      if (!summaryEl) return;
      const checkedIdxs = [];
      manualSelectPanel.querySelectorAll(".cited-manual-select-checkbox:checked").forEach(cb => {
        checkedIdxs.push(parseInt(cb.dataset.idx));
      });
      if (checkedIdxs.length === 0) {
        summaryEl.innerHTML = '<span class="summary-empty">未选择任何文档</span>';
      } else {
        const names = checkedIdxs.map(idx => {
          const it = items.find(d => d.idx === idx);
          return it ? escapeHtml(it.docCode + ' - ' + (it.name || '')) : '';
        }).filter(Boolean);
        summaryEl.innerHTML = '<span class="summary-label">已选 ' + checkedIdxs.length + ' 份：</span>' + names.join('<span class="summary-sep">、</span>');
      }
    }
    updateCitedSummary();

    // Auto-save on every checkbox change
    function onCitedCheckboxChange() {
      saveManualSelection("cited", items, ".cited-manual-select-checkbox", manualSelectPanel);
      updateCitedSummary();
    }
    manualSelectPanel.querySelectorAll(".cited-manual-select-checkbox").forEach(cb => {
      cb.addEventListener("change", onCitedCheckboxChange);
    });

    // Search filter
    const searchInput = document.getElementById("cited-manual-search-input");
    if (searchInput) {
      searchInput.oninput = () => {
        const keyword = searchInput.value.trim().toLowerCase();
        manualSelectPanel.querySelectorAll(".ai-manual-doc-item").forEach(item => {
          if (!keyword) { item.style.display = ""; return; }
          const st = item.dataset.searchText || "";
          item.style.display = st.includes(keyword) ? "" : "none";
        });
      };
    }

    document.getElementById("cited-manual-select-all").addEventListener("click", () => {
      manualSelectPanel.querySelectorAll(".cited-manual-select-checkbox").forEach(cb => cb.checked = true);
      onCitedCheckboxChange();
    });
    document.getElementById("cited-manual-select-none").addEventListener("click", () => {
      manualSelectPanel.querySelectorAll(".cited-manual-select-checkbox").forEach(cb => cb.checked = false);
      onCitedCheckboxChange();
    });
    document.getElementById("cited-manual-select-default").addEventListener("click", () => {
      manualSelectPanel.querySelectorAll(".cited-manual-select-checkbox").forEach(cb => {
        const idx = parseInt(cb.dataset.idx);
        const it = items.find(d => d.idx === idx);
        cb.checked = it && CITED_DOC_CODES.includes(it.docCode);
      });
      onCitedCheckboxChange();
    });
    document.getElementById("cited-manual-select-cancel").addEventListener("click", () => {
      manualSelectPanel.classList.add("hidden");
    });
    document.getElementById("cited-manual-select-merge-btn").addEventListener("click", async () => {
      const selectedIdxs = [];
      manualSelectPanel.querySelectorAll(".cited-manual-select-checkbox:checked").forEach(cb => {
        selectedIdxs.push(parseInt(cb.dataset.idx));
      });
      if (selectedIdxs.length === 0) {
        showError("请至少选择一个文档");
        return;
      }
      const mergeBtn = document.getElementById("cited-manual-select-merge-btn");
      if (mergeBtn) { mergeBtn.disabled = true; mergeBtn.textContent = "导出中..."; }
      await doMergeExportWithItems(selectedIdxs);
      if (mergeBtn) { mergeBtn.disabled = false; mergeBtn.textContent = "合并导出选中文档"; }
    });
    document.getElementById("cited-manual-select-confirm").addEventListener("click", async () => {
      const selectedIdxs = [];
      manualSelectPanel.querySelectorAll(".cited-manual-select-checkbox:checked").forEach(cb => {
        selectedIdxs.push(parseInt(cb.dataset.idx));
      });
      if (selectedIdxs.length === 0) {
        showError("请至少选择一个文档");
        return;
      }
      saveManualSelection("cited", items, ".cited-manual-select-checkbox", manualSelectPanel);
      manualSelectPanel.classList.add("hidden");

      // Run cited refs analysis with selected documents
      await runCitedRefsAnalysis(selectedIdxs);
    });
  });
}

// ── AI 思考过程（reasoning_content）流式渲染助手 ──
// 在 hostEl 内创建/复用一个 .ai-thinking-block，并把 reasoning 实时写进去；
// 当首个 content token 到达时，把思考区折叠为"已思考 Ns"，并调用 onContent(text) 渲染主回答。
// 返回 { appendReasoning(txt), startContent(), finish() } 用于驱动流循环。
function _createThinkingHost(hostEl) {
  if (!hostEl) return null;
  // 复用已存在的思考区（例如模块重新生成场景下容器已含思考区）
  let block = hostEl.querySelector(":scope > .ai-thinking-block");
  if (!block) {
    block = document.createElement("div");
    block.className = "ai-thinking-block thinking";
    block.innerHTML =
      '<div class="ai-thinking-header">' +
        '<span class="ai-thinking-icon">🧠</span>' +
        '<span class="ai-thinking-title">思考中…</span>' +
        '<span class="ai-thinking-meta"></span>' +
        '<span class="ai-thinking-toggle">▼</span>' +
      '</div>' +
      '<div class="ai-thinking-body"></div>';
    hostEl.insertBefore(block, hostEl.firstChild);
    const header = block.querySelector(".ai-thinking-header");
    header.addEventListener("click", () => block.classList.toggle("collapsed"));
  }
  const body = block.querySelector(".ai-thinking-body");
  const titleEl = block.querySelector(".ai-thinking-title");
  const metaEl = block.querySelector(".ai-thinking-meta");
  block.classList.add("thinking");
  block.classList.remove("collapsed");
  titleEl.textContent = "思考中…";
  metaEl.textContent = "";
  body.textContent = "";
  const startTime = performance.now();
  let _rafPending = false;
  let _pendingText = "";
  return {
    block: block,
    appendReasoning(txt) {
      if (!txt) return;
      _pendingText += txt;
      if (!_rafPending) {
        _rafPending = true;
        requestAnimationFrame(() => {
          _rafPending = false;
          // 用 textContent + 末尾追加，避免 reasoning 内 markdown 标记被打断渲染
          body.textContent = body.textContent + _pendingText;
          _pendingText = "";
          // 自动滚到底
          body.scrollTop = body.scrollHeight;
        });
      }
    },
    startContent() {
      // 第一个正式 token 到达：折叠思考区，显示已思考时长
      const elapsed = Math.max(1, Math.round((performance.now() - startTime) / 1000));
      block.classList.remove("thinking");
      block.classList.add("collapsed");
      titleEl.textContent = "已思考";
      metaEl.textContent = elapsed + "s · 点击展开";
    },
    finish() {
      // 流结束：若全程无 reasoning（普通模型），移除思考区
      if (!body.textContent) {
        if (block.parentNode) block.parentNode.removeChild(block);
      } else {
        block.classList.remove("thinking");
      }
    },
  };
}

// ── AI Analysis Progress Bar UI ──
function renderAiProgressUI(step, detail, progress) {
  // step: "extract" | "analyzing" | "done"
  // detail: string detail text
  // progress: 0-100 or -1 for indeterminate
  const steps = [
    { id: "extract", label: "提取文档内容" },
    { id: "analyzing", label: "AI 梳理中" },
  ];

  let html = '<div class="ai-progress-container">';
  html += '<div class="ai-progress-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>';

  html += '<div class="ai-progress-steps">';
  steps.forEach((s, i) => {
    const isActive = s.id === step;
    const isDone = steps.findIndex(st => st.id === step) > i;
    const cls = isDone ? 'done' : (isActive ? 'active' : '');
    const icon = isDone ? '✓' : (isActive ? '⟳' : (i + 1));
    html += '<div class="ai-progress-step ' + cls + '">';
    html += '<span class="ai-progress-step-icon">' + icon + '</span>';
    html += '<span>' + s.label + '</span>';
    html += '</div>';
  });
  html += '</div>';

  html += '<div class="ai-progress-bar-track"><div class="ai-progress-bar-fill' + (progress < 0 ? ' indeterminate' : '') + '" style="width:' + (progress < 0 ? '' : progress + '%') + '"></div></div>';

  if (detail) {
    html += '<div class="ai-progress-detail">' + escapeHtml(detail) + '</div>';
  }

  html += '</div>';
  return html;
}

// ── Build review manual selection panel ──
function buildReviewManualSelectPanel() {
  const items = kanbanState.documents;
  if (!items || items.length === 0) return;

  const manualSelectPanel = document.getElementById("ai-manual-select");
  if (!manualSelectPanel) return;

  const canDownload = currentData && (currentData.office === "US" || currentData.office === "EP");
  if (!canDownload) return;

  // Build checkbox list
  const typeLabels = { office_action: "审查意见", response: "答复", request: "请求", allowance: "授权", notification: "通知", misc: "其他" };
  let html = '<div class="ai-manual-header"><span class="ai-manual-title">选择分析文件范围</span></div>';
  html += '<div class="ai-manual-toolbar">';
  html += '<input type="text" id="manual-search-input" class="merge-search-input" placeholder="搜索文档名称、代码、日期...">';
  html += '<div class="ai-manual-select-all"><button id="manual-select-all" class="btn-small btn-extract">全选</button><button id="manual-select-none" class="btn-small btn-extract">全不选</button><button id="manual-select-default" class="btn-small btn-extract">默认选择</button></div>';
  html += '</div>';
  html += '<div class="ai-manual-docs">';
  items.forEach(it => {
    const typeLabel = typeLabels[it.type] || it.type;
    const searchText = ((it.name || '') + ' ' + (it.docCode || '') + ' ' + (it.date || '') + ' ' + typeLabel).toLowerCase();
    html += `
      <label class="ai-manual-doc-item" data-search-text="${escapeHtml(searchText)}">
        <input type="checkbox" class="manual-select-checkbox" data-idx="${it.idx}" ${shouldIncludeInAIAnalysis(currentData.office, it.type) ? 'checked' : ''}>
        <div class="ai-manual-doc-info">
          <span class="ai-manual-doc-code">${escapeHtml(it.docCode)}</span>
          <span class="ai-manual-doc-name">${escapeHtml(it.name)}</span>
          <span class="ai-manual-doc-date">${escapeHtml(it.date)}</span>
        </div>
        <span class="ai-manual-doc-type">${typeLabel}</span>
      </label>
    `;
  });
  html += '</div>';
  html += '<div id="manual-selected-summary" class="manual-selected-summary"></div>';
  html += '<div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">';
  html += '<button id="manual-select-cancel" class="btn-secondary">取消</button>';
  html += '<button id="manual-select-merge-btn" class="btn-secondary">合并导出选中文档</button>';
  html += '<button id="manual-select-confirm" class="btn-primary">确认并开始AI梳理</button>';
  html += '</div>';

  manualSelectPanel.innerHTML = html;
  manualSelectPanel.classList.remove("hidden");

  // Try to load saved selections, fall back to defaults
  if (!loadManualSelection("review", items, ".manual-select-checkbox", manualSelectPanel, null)) {
    // Apply default checks (already set in HTML via shouldIncludeInAIAnalysis)
  }

  // Update selected summary
  function updateReviewSummary() {
    const summaryEl = document.getElementById("manual-selected-summary");
    if (!summaryEl) return;
    const checkedIdxs = [];
    manualSelectPanel.querySelectorAll(".manual-select-checkbox:checked").forEach(cb => {
      checkedIdxs.push(parseInt(cb.dataset.idx));
    });
    if (checkedIdxs.length === 0) {
      summaryEl.innerHTML = '<span class="summary-empty">未选择任何文档</span>';
    } else {
      const names = checkedIdxs.map(idx => {
        const it = items.find(d => d.idx === idx);
        return it ? escapeHtml(it.docCode + ' - ' + (it.name || '')) : '';
      }).filter(Boolean);
      summaryEl.innerHTML = '<span class="summary-label">已选 ' + checkedIdxs.length + ' 份：</span>' + names.join('<span class="summary-sep">、</span>');
    }
  }
  updateReviewSummary();

  // Auto-save on every checkbox change
  function onCheckboxChange() {
    saveManualSelection("review", items, ".manual-select-checkbox", manualSelectPanel);
    updateReviewSummary();
  }
  manualSelectPanel.querySelectorAll(".manual-select-checkbox").forEach(cb => {
    cb.addEventListener("change", onCheckboxChange);
  });

  // Search filter
  const searchInput = document.getElementById("manual-search-input");
  if (searchInput) {
    searchInput.oninput = () => {
      const keyword = searchInput.value.trim().toLowerCase();
      manualSelectPanel.querySelectorAll(".ai-manual-doc-item").forEach(item => {
        if (!keyword) { item.style.display = ""; return; }
        const st = item.dataset.searchText || "";
        item.style.display = st.includes(keyword) ? "" : "none";
      });
    };
  }

  document.getElementById("manual-select-all").addEventListener("click", () => {
    manualSelectPanel.querySelectorAll(".manual-select-checkbox").forEach(cb => cb.checked = true);
    onCheckboxChange();
  });
  document.getElementById("manual-select-none").addEventListener("click", () => {
    manualSelectPanel.querySelectorAll(".manual-select-checkbox").forEach(cb => cb.checked = false);
    onCheckboxChange();
  });
  document.getElementById("manual-select-default").addEventListener("click", () => {
    manualSelectPanel.querySelectorAll(".manual-select-checkbox").forEach(cb => {
      const idx = parseInt(cb.dataset.idx);
      const it = items.find(d => d.idx === idx);
      cb.checked = it && shouldIncludeInAIAnalysis(currentData.office, it.type);
    });
    onCheckboxChange();
  });

  document.getElementById("manual-select-cancel").addEventListener("click", () => {
    manualSelectPanel.classList.add("hidden");
  });

  document.getElementById("manual-select-merge-btn").addEventListener("click", async () => {
    const selectedIdxs = [];
    manualSelectPanel.querySelectorAll(".manual-select-checkbox:checked").forEach(cb => {
      selectedIdxs.push(parseInt(cb.dataset.idx));
    });
    if (selectedIdxs.length === 0) {
      showError("请至少选择一个文档");
      return;
    }
    const mergeBtn = document.getElementById("manual-select-merge-btn");
    if (mergeBtn) { mergeBtn.disabled = true; mergeBtn.textContent = "导出中..."; }
    await doMergeExportWithItems(selectedIdxs);
    if (mergeBtn) { mergeBtn.disabled = false; mergeBtn.textContent = "合并导出选中文档"; }
  });

  document.getElementById("manual-select-confirm").addEventListener("click", async () => {
    const selectedIdxs = [];
    manualSelectPanel.querySelectorAll(".manual-select-checkbox:checked").forEach(cb => {
      selectedIdxs.push(parseInt(cb.dataset.idx));
    });
    if (selectedIdxs.length === 0) {
      showError("请至少选择一个文档");
      return;
    }
    saveManualSelection("review", items, ".manual-select-checkbox", manualSelectPanel);
    manualSelectPanel.classList.add("hidden");

    // Trigger AI analysis with selected documents only
    const config = window.AI.loadAIConfig();
    const provider = window.AI.getCurrentProvider(config);
    if (!provider) {
      showError("请先在 AI 设置中配置并选择一个 AI 服务商");
      aiSettingsBtn.click();
      return;
    }

    const manualSelectBtnEl = document.getElementById("kanban-manual-select-btn");
    if (manualSelectBtnEl) manualSelectBtnEl.disabled = true;
    // Interrupt any existing process
    if (activeAnalysisProcess) {
      abortActiveProcess();
    }
    activeAnalysisProcess = "review";
    kanbanAutoAbortController = new AbortController();
    // Hide all action buttons, show abort
    ["kanban-manual-select-btn", "cited-refs-manual-btn"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add("hidden");
    });

    const analysisSection = document.getElementById("kanban-analysis");
    const analysisContent = document.getElementById("kanban-analysis-content");
    analysisSection.classList.remove("hidden");
    analysisContent.innerHTML = renderAiProgressUI("extract", "正在准备文档提取...", -1);

    const selectedItems = items.filter(it => selectedIdxs.includes(it.idx));
    const CLAIMS_CODES_MANUAL = ["CLM", "FWCLM"];
    const oaItems = selectedItems;

    const ocrConfig = window.AI.getOCRConfig(config);
    const primaryEngine = ocrConfig.engine || "paddle_ocr_vl";
    const glmApiKey = window.AI.getGlmOcrApiKey(config);
    const statusEl = document.getElementById("ai-analysis-status");
    const isUS = currentData.office === "US";
    const urlDocNum = isUS ? currentData.applicationNumber : encodeURIComponent(currentData.docNumber || currentData.applicationNumber);

    const MAX_RETRIES = 5;
    const RETRY_BASE_DELAY = 8000; // 8s base, exponential backoff
    const extractReport = { success: [], empty: [], failed: [], retrying: [] };

    async function extractWithRetry(it, engine, retriesLeft) {
      const container = document.getElementById("kanban-extracted-" + it.idx);
      const attemptNum = MAX_RETRIES - retriesLeft + 1;
      if (container) {
        container.classList.remove("hidden");
        container.innerHTML = '<p class="extracting">正在提取（' + escapeHtml(engine) + '）' + (attemptNum > 1 ? '第' + attemptNum + '次尝试' : '') + '...</p>';
      }
      try {
        const useApiKey = engine === "glm_ocr" ? glmApiKey : "";
        const result = await doExtractText(currentData.office, urlDocNum, it.docId, it.numberOfPages, it.docFormat, engine, useApiKey);
        if (result.error) {
          const isRateLimit = result.error.includes("429") || result.error.includes("rate") || result.error.includes("limit") || result.error.includes("Too Many");
          if (retriesLeft > 0) {
            const delay = isRateLimit
              ? RETRY_BASE_DELAY * Math.pow(2, attemptNum - 1) + Math.random() * 3000  // longer for rate-limit
              : RETRY_BASE_DELAY * Math.pow(1.5, attemptNum - 1);
            if (statusEl) statusEl.textContent = `${it.name} 遇到${isRateLimit ? '限速' : '提取错误'}，${Math.round(delay/1000)}秒后重试 (${attemptNum}/${MAX_RETRIES})...`;
            if (container) container.innerHTML = `<p class="extracting" style="color:var(--warning)">${isRateLimit ? '因限速正在等待重试' : '提取出错，正在重试'} (${attemptNum}/${MAX_RETRIES})，约${Math.round(delay/1000)}秒后重试...</p>`;
            extractReport.retrying.push({ name: it.name, docCode: it.docCode, attempt: attemptNum, reason: result.error });
            await new Promise(r => setTimeout(r, delay));
            // On rate-limit, try same engine first; on other errors, try fallback
            if (isRateLimit) {
              return await extractWithRetry(it, engine, retriesLeft - 1);
            }
            const fallbackEngine = engine === "paddle_ocr_vl" ? "glm_ocr" : "paddle_ocr_vl";
            if (fallbackEngine === "glm_ocr" && !glmApiKey) {
              return await extractWithRetry(it, engine, retriesLeft - 1);
            }
            return await extractWithRetry(it, fallbackEngine, retriesLeft - 1);
          }
          extractReport.failed.push({ name: it.name, docCode: it.docCode, reason: result.error });
          if (container) container.innerHTML = '<p class="extract-error">' + escapeHtml(result.error) + '</p>';
          return false;
        }
        const text = result.text || "";
        const markdown = result.markdown || "";
        if (!text && !markdown) {
          if (retriesLeft > 0) {
            const delay = RETRY_BASE_DELAY * Math.pow(1.5, attemptNum - 1);
            if (statusEl) statusEl.textContent = `${it.name} 提取结果为空，${Math.round(delay/1000)}秒后重试...`;
            if (container) container.innerHTML = `<p class="extracting" style="color:var(--warning)">提取结果为空，正在重试 (${attemptNum}/${MAX_RETRIES})...</p>`;
            const fallbackEngine = engine === "paddle_ocr_vl" ? "glm_ocr" : "paddle_ocr_vl";
            if (fallbackEngine === "glm_ocr" && !glmApiKey) {
              return await extractWithRetry(it, engine, retriesLeft - 1);
            }
            return await extractWithRetry(it, fallbackEngine, retriesLeft - 1);
          }
          extractReport.empty.push({ name: it.name, docCode: it.docCode });
          if (container) container.innerHTML = '<p class="extract-empty">未能提取到文本（已尝试 ' + MAX_RETRIES + ' 次）</p>';
          return false;
        }
        const blocks = result.blocks || [];
        const pageDimensions = result.page_dimensions || {};
        kanbanState.extractions[it.idx] = { text, markdown, engine: result.engine, blocks, pageDimensions };
        kanbanState.hasUnsavedWork = true;
        if (blocks.length > 0) {
          blocks.forEach(b => {
            const traceKey = "D" + it.idx + "_" + b.block_id;
            kanbanState.traceIndex[traceKey] = {
              docIdx: it.idx, page: b.page, bbox: b.bbox,
              content: b.content, label: b.label, originalBlockId: b.block_id,
              pageDimensions: pageDimensions[b.page] || null,
            };
          });
        }
        extractReport.success.push({ name: it.name, docCode: it.docCode, chars: (markdown || text).length, engine: result.engine });
        if (container) {
          const displayText = markdown || text;
          const blocksInfo = blocks.length > 0 ? ` · ${blocks.length} blocks` : "";
          container.innerHTML = `
            <div class="extracted-header">
              <span class="extracted-engine">引擎: ${escapeHtml(result.engine)}</span>
              <span class="extracted-chars">字符数: ${displayText.length}${blocksInfo}</span>
            </div>
            <pre class="extracted-text">${escapeHtml(displayText.length > 6000 ? displayText.substring(0, 6000) + "\n\n[...已截断...]" : displayText)}</pre>
          `;
        }
        return true;
      } catch (e) {
        const isRateLimit = e.message && (e.message.includes("429") || e.message.includes("rate") || e.message.includes("limit"));
        if (retriesLeft > 0) {
          const delay = isRateLimit
            ? RETRY_BASE_DELAY * Math.pow(2, attemptNum - 1) + Math.random() * 3000
            : 2000 * attemptNum;
          if (statusEl) statusEl.textContent = `${it.name} ${isRateLimit ? '限速等待重试' : '提取异常重试中'} (${attemptNum}/${MAX_RETRIES})...`;
          if (container) container.innerHTML = `<p class="extracting" style="color:var(--warning)">${isRateLimit ? '因限速正在等待重试' : '提取异常，正在重试'} (${attemptNum}/${MAX_RETRIES})...</p>`;
          await new Promise(r => setTimeout(r, delay));
          return await extractWithRetry(it, engine, retriesLeft - 1);
        }
        extractReport.failed.push({ name: it.name, docCode: it.docCode, reason: e.message });
        const container2 = document.getElementById("kanban-extracted-" + it.idx);
        if (container2) container2.innerHTML = '<p class="extract-error">' + escapeHtml(e.message) + '</p>';
        return false;
      }
    }

    // 断点续OCR：已有缓存（kanbanState.extractions）的跳过，只提取缺失的
    const missing = oaItems.filter(it => !kanbanState.extractions[it.idx] || (!kanbanState.extractions[it.idx].text && !kanbanState.extractions[it.idx].markdown));
    if (missing.length > 0) {
      for (let i = 0; i < missing.length; i++) {
        const it = missing[i];
        // Double-check: another parallel flow may have filled it
        if (kanbanState.extractions[it.idx] && (kanbanState.extractions[it.idx].text || kanbanState.extractions[it.idx].markdown)) continue;
        if (statusEl) statusEl.textContent = "提取中 (" + (i + 1) + "/" + missing.length + "): " + it.name;
        // Update progress bar
        const extractProgress = Math.round(((i + 1) / missing.length) * 60);
        analysisContent.innerHTML = renderAiProgressUI("extract", "提取中 (" + (i + 1) + "/" + missing.length + "): " + it.name, extractProgress);
        await extractWithRetry(it, primaryEngine, MAX_RETRIES);
        if (kanbanAutoAbortController && kanbanAutoAbortController.signal.aborted) break;
      }
    }
    autoSaveCache();

    // 务必等所有文档提取完毕再进入AI梳理
    const successCount = extractReport.success.length;
    const failedCount = extractReport.failed.length + extractReport.empty.length;

    if (successCount === 0) {
      analysisContent.innerHTML = '<p class="placeholder" style="color:var(--danger)">所有文档提取均失败，无法进行 AI 分析。</p>';
      const manualSelectBtnEl2 = document.getElementById("kanban-manual-select-btn");
      if (manualSelectBtnEl2) { manualSelectBtnEl2.disabled = false; manualSelectBtnEl2.classList.remove("hidden"); }
      kanbanAutoAbortController = null;
      return;
    }

    // 如果有部分失败，提示用户但仍继续AI分析
    if (failedCount > 0) {
      const failedNames = [...extractReport.failed, ...extractReport.empty].map(f => f.docCode || f.name).join(", ");
      if (statusEl) statusEl.textContent = `${successCount} 个文档提取成功，${failedCount} 个失败（${failedNames}），正在用 AI 整理...`;
      analysisContent.innerHTML = renderAiProgressUI("analyzing", successCount + " 个文档提取成功，" + failedCount + " 个失败，AI 梳理中...", -1);
    } else {
      if (statusEl) statusEl.textContent = "全部文档提取完成，正在用 AI 整理审查历史...";
      analysisContent.innerHTML = renderAiProgressUI("analyzing", "全部文档提取完成，AI 梳理中...", -1);
    }
    analysisContent.innerHTML = renderAiProgressUI("analyzing", "AI 正在梳理审查历史...", -1);

    const hasBlocks = oaItems.some(it => {
      const ext = kanbanState.extractions[it.idx];
      return ext && ext.blocks && ext.blocks.length > 0;
    });

    const annotatedLines = [];
    const timelineSummary = buildTimelineSummary(currentData.office, kanbanState.documents);

    // Sort oaItems by date for consistent timeline in AI context
    const sortedOaItems = [...oaItems].sort((a, b) => {
      const da = parseDate(a.date);
      const db = parseDate(b.date);
      return da - db;
    });

    sortedOaItems.forEach((it) => {
      const ext = kanbanState.extractions[it.idx];
      if (!ext) {
        const isClaimsDoc = CLAIMS_CODES_MANUAL.includes(it.docCode);
        const missingHeader = isClaimsDoc
          ? `【${it.idx}】${it.docCode} - ${it.name}（${it.date}）[权利要求参考]`
          : `【${it.idx}】${it.docCode} - ${it.name}（${it.date}）`;
        annotatedLines.push(missingHeader + "\n[未能提取内容]");
        return;
      }
      const isClaimsDoc = CLAIMS_CODES_MANUAL.includes(it.docCode);
      const header = isClaimsDoc
        ? `【${it.idx}】${it.docCode} - ${it.name}（${it.date}）[权利要求参考]`
        : `【${it.idx}】${it.docCode} - ${it.name}（${it.date}）`;
      if (hasBlocks && ext.blocks && ext.blocks.length > 0) {
        const blockParts = ext.blocks
          .filter(b => b.content && b.content.trim())
          .map(b => `[ref:D${it.idx}_${b.block_id}]${b.content}[/ref:D${it.idx}_${b.block_id}]`)
          .join("\n\n");
        annotatedLines.push(header + "\n" + blockParts);
      } else {
        const content = (ext.markdown || ext.text || "").substring(0, 12000);
        annotatedLines.push(header + "\n" + content);
      }
    });

    const promptConfig = window.AI.loadAIConfig();
    const systemPrompt = hasBlocks
      ? window.AI.getCustomPrompt(promptConfig, "kanbanAnalysis")
      : window.AI.getCustomPrompt(promptConfig, "kanbanAnalysisSimple");

    const userMessage = timelineSummary + annotatedLines.join("\n\n---\n\n");

    try {
      let fullText = "";
      // Clear previous content (including any previous progress UI)
      analysisContent.innerHTML = "";
      // Create a stable container once to avoid full DOM replacement on each chunk
      // Keep the progress bar visible initially; it will be replaced when first content arrives
      const progressPlaceholder = document.createElement("div");
      progressPlaceholder.innerHTML = renderAiProgressUI("analyzing", "AI 正在梳理审查历史，等待响应...", -1);
      analysisContent.appendChild(progressPlaceholder);
      const streamContainer = document.createElement("div");
      streamContainer.className = "kanban-analysis-content markdown-body";
      analysisContent.appendChild(streamContainer);
      // 思考区挂在 streamContainer 内（renderMarkdownWithTrace 只会改 innerHTML，需保留思考区）
      // 为避免被覆盖，把回答放到内层 .kanban-analysis-answer
      const answerContainer = document.createElement("div");
      answerContainer.className = "kanban-analysis-answer";
      streamContainer.appendChild(answerContainer);
      const thinkingHost = _createThinkingHost(streamContainer);
      let _streamContentStarted = false;
      let _streamRafPending = false;
      let _lastRenderLen = 0;
      for await (const chunk of window.AI.streamChat(
        provider.type, provider.apiKey, provider.baseUrl,
        {
          model: provider.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          temperature: 0.3,
          maxTokens: 32768,
        },
        kanbanAutoAbortController ? kanbanAutoAbortController.signal : undefined
      )) {
        if (chunk.reasoningContent && thinkingHost) {
          if (progressPlaceholder.parentNode) progressPlaceholder.remove();
          thinkingHost.appendReasoning(chunk.reasoningContent);
        }
        if (chunk.content) {
          if (!_streamContentStarted) {
            _streamContentStarted = true;
            if (progressPlaceholder.parentNode) progressPlaceholder.remove();
            if (thinkingHost) thinkingHost.startContent();
          }
          fullText += chunk.content;
          // Throttle rendering: only render if enough new content or enough time passed
          if (!_streamRafPending && (fullText.length - _lastRenderLen > 20 || fullText.length < 200)) {
            _streamRafPending = true;
            requestAnimationFrame(() => {
              if (answerContainer) {
                answerContainer.innerHTML = renderMarkdownWithTrace(fullText);
              }
              _lastRenderLen = fullText.length;
              _streamRafPending = false;
            });
          }
        }
      }
      if (thinkingHost) thinkingHost.finish();
      // Final render to ensure all content is displayed (with module sections)
      if (answerContainer) answerContainer.innerHTML = renderAnalysisModules(fullText);
      kanbanState.analysis = fullText;
      kanbanState.hasUnsavedWork = true;
      // Save context for continued chat
      kanbanState.analysisSystemPrompt = systemPrompt;
      kanbanState.analysisUserMessage = userMessage;
      analysisChatHistory = [];
      showAnalysisChatToggle();
      autoSaveCache();
      prefetchPatentLinks();
      if (statusEl) statusEl.textContent = "AI 整理完成 ✓ 共 " + oaItems.length + " 份文档" + (hasBlocks ? "（含溯源标记）" : "");

      let reportHtml = "";
      if (extractReport.empty.length > 0 || extractReport.failed.length > 0) {
        reportHtml = '<div class="extract-report"><h4>提取完整性报告</h4>';
        if (extractReport.success.length > 0) {
          reportHtml += '<div class="report-success">✓ 成功: ' + extractReport.success.map(s => escapeHtml(s.name) + ' (' + s.chars + '字/' + s.engine + ')').join('、') + '</div>';
        }
        if (extractReport.empty.length > 0) {
          reportHtml += '<div class="report-warning">内容为空: ' + extractReport.empty.map(s => escapeHtml(s.name)).join('、') + '</div>';
        }
        if (extractReport.failed.length > 0) {
          reportHtml += '<div class="report-error">✗ 提取失败: ' + extractReport.failed.map(s => escapeHtml(s.name) + ' (' + escapeHtml(s.reason) + ')').join('、') + '</div>';
        }
        reportHtml += '</div>';
        // Prepend report before the stable stream container
        const reportDiv = document.createElement("div");
        reportDiv.innerHTML = reportHtml;
        analysisContent.insertBefore(reportDiv.firstChild, streamContainer);
      }
    } catch (e) {
      analysisContent.innerHTML = '<p class="placeholder" style="color:var(--danger)">' + escapeHtml(e.toString()) + "</p>";
      if (statusEl) statusEl.textContent = "AI 整理失败 ✗";
    } finally {
      activeAnalysisProcess = null;
      ["kanban-manual-select-btn", "cited-refs-manual-btn"].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.disabled = false; el.classList.remove("hidden"); }
      });
      kanbanAutoAbortController = null;
    }
  });
}

function renderMarkdown(text) {
  if (!text) return "";
  if (typeof marked !== "undefined" && marked.parse) {
    try {
      return marked.parse(text);
    } catch (e) {
      return escapeHtml(text).replace(/\n/g, "<br>");
    }
  }
  return escapeHtml(text).replace(/\n/g, "<br>");
}

function renderMarkdownWithTrace(text) {
  if (!text) return "";
  const processed = text.replace(/【来源:\s*([^\】]+)】/g, (match, refsStr) => {
    const refs = refsStr.split(",").map(r => r.trim()).filter(r => /^D\d+_B_/.test(r));
    if (refs.length === 0) return "";
    const validRefs = refs.filter(r => kanbanState.traceIndex[r]);
    if (validRefs.length === 0) {
      return '<span class="trace-links"><span class="trace-label">溯源:</span> <span class="trace-unavailable">引用块未找到</span></span>';
    }
    // Group valid refs by document and page, then merge consecutive block indices into ranges
    const refLinks = [];
    const grouped = {};
    validRefs.forEach(ref => {
      const info = kanbanState.traceIndex[ref];
      if (!info) return;
      const doc = kanbanState.documents.find(d => d.idx === info.docIdx);
      const docLabel = doc ? `${doc.name} (${doc.docCode})` : `文档${info.docIdx}`;
      const key = `${info.docIdx}|${info.page}|${docLabel}`;
      if (!grouped[key]) grouped[key] = [];
      // Extract docIdx, page, blockIdx from traceIndex key like "D0_B_p2_5" -> docIdx=0, page=2, blockIdx=5
      const blockMatch = ref.match(/^D(\d+)_B_p(\d+)_(\d+)$/);
      if (blockMatch) {
        grouped[key].push({ ref, blockIdx: parseInt(blockMatch[3]), page: parseInt(blockMatch[2]) });
      } else {
        grouped[key].push({ ref, blockIdx: -1, page: info.page });
      }
    });

    Object.keys(grouped).forEach(key => {
      const [docIdxStr, pageStr, docLabel] = key.split("|");
      const page = parseInt(pageStr);
      const docIdx = parseInt(docIdxStr);
      const entries = grouped[key].sort((a, b) => a.blockIdx - b.blockIdx);

      // Merge consecutive block indices into ranges
      const ranges = [];
      let rangeStart = entries[0];
      let rangeEnd = entries[0];
      for (let i = 1; i < entries.length; i++) {
        if (entries[i].blockIdx === rangeEnd.blockIdx + 1) {
          rangeEnd = entries[i];
        } else {
          ranges.push({ start: rangeStart, end: rangeEnd });
          rangeStart = entries[i];
          rangeEnd = entries[i];
        }
      }
      ranges.push({ start: rangeStart, end: rangeEnd });

      ranges.forEach(range => {
        const allRefs = [];
        for (let bi = range.start.blockIdx; bi <= range.end.blockIdx; bi++) {
          const refId = `D${docIdx}_B_p${page}_${bi}`;
          if (kanbanState.traceIndex[refId]) allRefs.push(refId);
        }
        const dataBlockIds = allRefs.map(r => escapeHtml(r)).join(",");
        let label, hoverTitle;
        if (range.start.blockIdx === range.end.blockIdx) {
          label = `第${page}页 §${range.start.blockIdx}`;
          hoverTitle = `${docLabel} · 第${page}页 第${range.start.blockIdx}段`;
        } else {
          label = `第${page}页 §${range.start.blockIdx}-${range.end.blockIdx}`;
          hoverTitle = `${docLabel} · 第${page}页 第${range.start.blockIdx}-${range.end.blockIdx}段`;
        }
        refLinks.push(`<a class="trace-link" data-block-id="${dataBlockIds}" title="${escapeHtml(hoverTitle)}">${escapeHtml(label)}</a>`);
      });
    });
    return `<span class="trace-links"><span class="trace-label">溯源:</span> ${refLinks.join(" ")}</span>`;
  });
  if (typeof marked !== "undefined" && marked.parse) {
    try {
      return linkifyPatentNumbers(marked.parse(processed));
    } catch (e) {
      return linkifyPatentNumbers(escapeHtml(processed).replace(/\n/g, "<br>"));
    }
  }
  return linkifyPatentNumbers(escapeHtml(processed).replace(/\n/g, "<br>"));
}

// ===== Analysis Module Parsing & Rendering =====

// Clean heading text for display: strip leading numbering like "一、" "1." "1、" etc.
function cleanModuleHeading(heading) {
  return heading
    .replace(/^[一二三四五六七八九十]+[、.]\s*/, "")
    .replace(/^\d+[、.]\s*/, "")
    .trim();
}

// Parse the analysis markdown text into an array of module segments.
// Any ### heading creates a new module — fully dynamic, no hardcoded module list.
function parseAnalysisModules(text) {
  if (!text || !text.trim()) return [];

  const lines = text.split("\n");
  const segments = [];
  let currentHeading = null;
  let currentLabel = "";
  let currentId = "";
  let currentLines = [];
  let preModuleLines = [];
  let moduleIdx = 0;

  for (const line of lines) {
    const h3Match = line.match(/^###\s+(.+)/);
    if (h3Match) {
      // Flush previous segment
      if (currentHeading !== null) {
        segments.push({ heading: currentHeading, label: currentLabel, id: currentId, content: currentLines.join("\n") });
      } else if (currentLines.length > 0) {
        preModuleLines = currentLines;
      }
      currentHeading = h3Match[1].trim();
      currentLabel = cleanModuleHeading(currentHeading);
      currentId = "mod-" + moduleIdx;
      moduleIdx++;
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }
  // Flush last segment
  if (currentHeading !== null) {
    segments.push({ heading: currentHeading, label: currentLabel, id: currentId, content: currentLines.join("\n") });
  } else if (currentLines.length > 0) {
    preModuleLines = currentLines;
  }

  // If there's pre-module content, prepend as an unclassified segment
  if (preModuleLines.length > 0) {
    segments.unshift({ heading: null, label: null, id: null, content: preModuleLines.join("\n") });
  }

  return segments;
}

// Render analysis content with module sections, sticky tab bar, and regenerate buttons
function renderAnalysisModules(text) {
  if (!text || !text.trim()) return renderMarkdownWithTrace(text);

  const segments = parseAnalysisModules(text);
  if (segments.length === 0) return renderMarkdownWithTrace(text);

  // Count named modules (with heading) for the tab bar
  const namedSegments = segments.filter(s => s.heading);

  let html = "";

  // Sticky module navigation tabs
  if (namedSegments.length > 1) {
    html += '<div class="analysis-module-tabs">';
    namedSegments.forEach(seg => {
      html += '<button class="analysis-module-tab" data-module-id="' + seg.id + '">' + escapeHtml(seg.label) + '</button>';
    });
    html += '</div>';
  }

  segments.forEach((seg) => {
    if (seg.heading) {
      // Named module section with header bar and regenerate button
      html += '<div class="analysis-module" data-module-id="' + seg.id + '">';
      html += '<div class="analysis-module-header">';
      html += '<span class="analysis-module-title">' + escapeHtml(seg.label) + '</span>';
      html += '<button class="analysis-module-regen-btn" data-module-id="' + seg.id + '" data-module-label="' + escapeHtml(seg.label) + '" title="重新生成此模块">⟳ 重新生成</button>';
      html += '</div>';
      // Strip the leading ### heading from content to avoid duplication with the header bar
      const contentWithoutHeading = seg.content.replace(/^###\s+[^\n]*\n?/, "");
      html += '<div class="analysis-module-content">' + renderMarkdownWithTrace(contentWithoutHeading) + '</div>';
      html += '</div>';
    } else {
      // Unclassified content (before first ### heading)
      html += '<div class="analysis-module analysis-module-unclassified">';
      html += '<div class="analysis-module-content">' + renderMarkdownWithTrace(seg.content) + '</div>';
      html += '</div>';
    }
  });

  // Schedule IntersectionObserver setup after DOM update
  requestAnimationFrame(() => {
    const container = document.getElementById("kanban-analysis-content");
    if (container && window._analysisScrollObserver) {
      container.querySelectorAll(".analysis-module[data-module-id]").forEach(mod => {
        window._analysisScrollObserver.observe(mod);
      });
    }
  });

  return html;
}

// Extract a single module's raw markdown text from the full analysis
function extractModuleText(fullText, moduleId) {
  const segments = parseAnalysisModules(fullText);
  const seg = segments.find(s => s.id === moduleId);
  return seg ? seg.content : null;
}

// Replace a single module's text in the full analysis and return the new full text
function replaceModuleText(fullText, moduleId, newModuleText) {
  const segments = parseAnalysisModules(fullText);
  let result = "";
  let replaced = false;
  segments.forEach((seg, idx) => {
    if (idx > 0) result += "\n";
    if (seg.id === moduleId && !replaced) {
      result += newModuleText;
      replaced = true;
    } else {
      result += seg.content;
    }
  });
  return result;
}

// Regenerate a single analysis module via AI
async function regenerateAnalysisModule(moduleId, moduleLabel, customNote) {
  const fullText = kanbanState.analysis;
  if (!fullText) return;

  const provider = window.AI.getCurrentProvider(window.AI.loadAIConfig());
  if (!provider) {
    showError("请先配置 AI 服务");
    return;
  }

  const moduleEl = document.querySelector('.analysis-module[data-module-id="' + moduleId + '"]');
  const contentEl = moduleEl ? moduleEl.querySelector('.analysis-module-content') : null;
  if (!contentEl) return;

  // Show loading state in the module content area
  contentEl.innerHTML = '<div class="analysis-module-loading"><div class="analysis-module-spinner"></div><span>正在重新生成「' + escapeHtml(moduleLabel) + '」...</span></div>';

  // Disable the regenerate button
  const regenBtn = moduleEl.querySelector('.analysis-module-regen-btn');
  if (regenBtn) regenBtn.disabled = true;

  const originalModuleText = extractModuleText(fullText, moduleId) || "";

  // Build prompt for regeneration
  const systemPrompt = kanbanState.analysisSystemPrompt || "";
  const userMessage = kanbanState.analysisUserMessage || "";

  const regenInstruction = `请仅重新生成报告中的「${moduleLabel}」部分。` +
    (customNote ? `\n\n用户补充要求：${customNote}` : "") +
    `\n\n请保持 Markdown 格式，以 ### 开头的标题开头。不要生成其他模块的内容，只生成「${moduleLabel}」这一个模块。` +
    `\n\n以下是该模块的当前内容，供参考改进：\n${originalModuleText}`;

  const fullUserMsg = userMessage + "\n\n---\n\n" + regenInstruction;

  try {
    let newModuleText = "";
    const stream = window.AI.streamChat(
      provider.type, provider.apiKey, provider.baseUrl,
      {
        model: provider.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: fullUserMsg },
        ],
        temperature: 0.3,
        maxTokens: 8192,
      }
    );

    // 准备思考区 + 回答区
    contentEl.innerHTML = "";
    const answerEl = document.createElement("div");
    answerEl.className = "analysis-module-answer";
    contentEl.appendChild(answerEl);
    const thinkingHost = _createThinkingHost(contentEl);
    let _moduleContentStarted = false;
    let _streamRafPending = false;
    let _lastRenderLen = 0;
    for await (const chunk of stream) {
      if (chunk.reasoningContent && thinkingHost) {
        thinkingHost.appendReasoning(chunk.reasoningContent);
      }
      if (chunk.content) {
        if (!_moduleContentStarted) {
          _moduleContentStarted = true;
          if (thinkingHost) thinkingHost.startContent();
        }
        newModuleText += chunk.content;
        if (!_streamRafPending && (newModuleText.length - _lastRenderLen > 20 || newModuleText.length < 200)) {
          _streamRafPending = true;
          requestAnimationFrame(() => {
            if (answerEl) {
              answerEl.innerHTML = renderMarkdownWithTrace(newModuleText);
            }
            _lastRenderLen = newModuleText.length;
            _streamRafPending = false;
          });
        }
      }
    }
    if (thinkingHost) thinkingHost.finish();
    // Final render (strip leading ### heading to avoid duplication with module header bar)
    if (answerEl) {
      const displayText = newModuleText.replace(/^###\s+[^\n]*\n?/, "");
      answerEl.innerHTML = renderMarkdownWithTrace(displayText);
    }

    // Update the full analysis text
    kanbanState.analysis = replaceModuleText(fullText, moduleId, newModuleText);
    kanbanState.hasUnsavedWork = true;
    autoSaveCache();
    prefetchPatentLinks();
  } catch (e) {
    // Restore original content on error
    if (contentEl) contentEl.innerHTML = renderMarkdownWithTrace(originalModuleText);
    showError("重新生成失败: " + e.message);
  } finally {
    if (regenBtn) regenBtn.disabled = false;
  }
}

// Show a mini popup for custom note input before regenerating
function showModuleRegenPopup(btnEl, moduleId, moduleLabel) {
  // Remove any existing popup
  const existing = document.getElementById("analysis-regen-popup");
  if (existing) existing.remove();

  const popup = document.createElement("div");
  popup.id = "analysis-regen-popup";
  popup.className = "analysis-regen-popup";

  popup.innerHTML =
    '<div class="analysis-regen-popup-title">重新生成「' + escapeHtml(moduleLabel) + '」</div>' +
    '<textarea class="analysis-regen-popup-note" placeholder="可选：输入补充要求或修改方向..." rows="2"></textarea>' +
    '<div class="analysis-regen-popup-actions">' +
    '<button class="btn-secondary btn-small analysis-regen-cancel">取消</button>' +
    '<button class="btn-primary btn-small analysis-regen-confirm">开始生成</button>' +
    '</div>';

  // Position the popup near the button
  const rect = btnEl.getBoundingClientRect();
  popup.style.position = "fixed";
  popup.style.right = (window.innerWidth - rect.right) + "px";
  popup.style.top = (rect.bottom + 6) + "px";

  document.body.appendChild(popup);

  // Focus the textarea
  const noteInput = popup.querySelector(".analysis-regen-popup-note");
  setTimeout(() => noteInput.focus(), 50);

  // Cancel
  popup.querySelector(".analysis-regen-cancel").addEventListener("click", () => popup.remove());
  // Click outside to close
  const closeOnOutside = (ev) => {
    if (!popup.contains(ev.target) && ev.target !== btnEl) {
      popup.remove();
      document.removeEventListener("mousedown", closeOnOutside);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", closeOnOutside), 100);

  // Confirm
  popup.querySelector(".analysis-regen-confirm").addEventListener("click", () => {
    const customNote = noteInput.value.trim();
    popup.remove();
    document.removeEventListener("mousedown", closeOnOutside);
    regenerateAnalysisModule(moduleId, moduleLabel, customNote);
  });

  // Enter key in textarea (Ctrl+Enter to confirm)
  noteInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      popup.querySelector(".analysis-regen-confirm").click();
    }
  });
}

function onTraceClick(blockIdStr) {
  const blockIds = blockIdStr.split(",").filter(id => kanbanState.traceIndex[id]);
  if (blockIds.length === 0) {
    showError("溯源信息不存在: " + blockIdStr);
    return;
  }
  const primaryBlockId = blockIds[0];
  const info = kanbanState.traceIndex[primaryBlockId];
  if (!info) {
    showError("溯源信息不存在: " + primaryBlockId);
    return;
  }

  // Use originalBlockId for PDF overlay and text view block queries,
  // since overlay data-block-id uses the original format (e.g., "B_p1_0")
  const originalId = info.originalBlockId || primaryBlockId;
  const rangeOriginalIds = blockIds.map(id => {
    const entry = kanbanState.traceIndex[id];
    return entry ? (entry.originalBlockId || id) : id;
  });

  // Set pending highlight using originalBlockId for overlay matching
  pdfViewState.pendingHighlight = originalId;
  pdfViewState.pendingHighlightRange = rangeOriginalIds;
  pdfViewState.traceJumpPending = true;

  // Set the correct doc index BEFORE toggling PDF view,
  // so togglePdfView renders the right document if it triggers renderPdfView
  pdfViewState.currentDocIdx = info.docIdx;

  if (readerModal.classList.contains("hidden")) {
    openReader(true, true); // skipRender=true — selectReaderDoc will handle the render
  }
  // Auto-switch to PDF view (skipRender=true to avoid double render — selectReaderDoc will handle it)
  if (!pdfViewState.active) {
    togglePdfView(true);
  }

  selectReaderDoc(info.docIdx);

  // Fallback: try to highlight after a delay if PDF was already rendered
  // (covers the case where renderPdfView already completed before we get here)
  setTimeout(() => {
    if (pdfViewState.active && !pdfViewState.pendingHighlight) {
      // pendingHighlight was already consumed by renderPdfView, highlight is done
      return;
    }
    // If pendingHighlight is still set, try direct highlight using originalBlockId
    if (pdfViewState.active) {
      const overlay = readerPdfContainer.querySelector(`.pdf-block-overlay[data-block-id="${originalId}"]`);
      if (overlay) {
        highlightPdfBlock(originalId);
        rangeOriginalIds.forEach(id => {
          if (id !== originalId) {
            const el = readerPdfContainer.querySelector(`.pdf-block-overlay[data-block-id="${id}"]`);
            if (el) el.classList.add("highlight-range");
          }
        });
        pdfViewState.pendingHighlight = null;
        pdfViewState.pendingHighlightRange = null;
        pdfViewState.traceJumpPending = false;
      }
    }

    // Text view fallback — use originalBlockId for data-block-id matching
    if (!pdfViewState.active) {
      const md = kanbanState.extractions[info.docIdx];
      if (!md) return;
      const content = md.markdown || md.text || "";
      const blocks = md.blocks || [];
      const targetBlock = blocks.find(b => b.block_id === originalId);
      if (targetBlock && targetBlock.content) {
        const el = readerContent.querySelector(`[data-block-id="${originalId}"]`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("trace-highlight");
          setTimeout(() => el.classList.remove("trace-highlight"), 3000);
          return;
        }
      }
      const traceEl = document.createElement("div");
      traceEl.className = "trace-locator";
      traceEl.innerHTML = `
        <div class="trace-locator-header">
          <span class="trace-locator-id">${escapeHtml(originalId)}</span>
          <span class="trace-locator-page">第 ${info.page} 页</span>
          <button class="trace-locator-close" onclick="this.parentElement.parentElement.remove()">×</button>
        </div>
        <div class="trace-locator-content">${escapeHtml((info.content || "").substring(0, 300))}${info.content && info.content.length > 300 ? "..." : ""}</div>
        ${info.bbox ? '<div class="trace-locator-bbox">区域坐标: [' + info.bbox.join(", ") + "]</div>" : ""}
      `;
      readerContent.insertBefore(traceEl, readerContent.firstChild);
      traceEl.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, 800);
}

function renderTimeline(data) {
  const board = document.getElementById("timeline-board");
  const statusEl = document.getElementById("timeline-status");
  if (!board) return;

  const items = kanbanState.documents;
  if (!items || items.length === 0) {
    board.innerHTML = '<p class="placeholder">未查询到审查文档</p>';
    if (statusEl) statusEl.textContent = "";
    return;
  }

  const importantTypes = ["office_action", "response", "allowance", "request", "notification"];
  const importantDocCodes = ["IDS", "WDR", "ETCL", "DAFP", "AFCP", "BRAP", "EXBR", "REBR", "CTNF", "CTFR", "CTRA", "CTAL"];
  // Exclude receipt and payment types from timeline
  const excludeDocCodes = ["N417", "N417.PYMT", "APP.FILE.REC", "WFEE", "PTO.FEE", "IFEE", "RCFR", "RECEIPT-OLF", "FEES-RO", "PAYREJ"];
  const excludeNamePatterns = /回执|缴费|receipt|payment|fee/i;
  const timelineItems = items.filter(it => {
    if (excludeDocCodes.includes(it.docCode)) return false;
    if (excludeNamePatterns.test(it.name || "")) return false;
    return importantTypes.indexOf(it.type) !== -1 || importantDocCodes.includes(it.docCode);
  });

  const sorted = [...timelineItems].sort((a, b) => {
    const da = parseDate(a.date);
    const db = parseDate(b.date);
    return da - db;
  });

  if (sorted.length === 0) {
    board.innerHTML = '<p class="placeholder">未找到关键审查节点</p>';
    return;
  }

  const dotClassMap = {
    office_action: "dot-oa",
    response: "dot-response",
    request: "dot-request",
    allowance: "dot-allowance",
    notification: "dot-notification",
    misc: "dot-misc",
  };

  const badgeClassMap = {
    office_action: "badge-oa",
    response: "badge-response",
    request: "badge-request",
    allowance: "badge-allowance",
    notification: "badge-notification",
    misc: "badge-misc",
  };

  const typeLabelMap = {
    office_action: "审查意见",
    response: "申请人答复",
    request: "申请人请求",
    allowance: "授权通知",
    notification: "通知",
    misc: "其他",
  };

  let html = '<div class="timeline-line"></div><div class="timeline-items">';
  sorted.forEach(it => {
    const dotClass = dotClassMap[it.type] || "dot-misc";
    const badgeClass = badgeClassMap[it.type] || "badge-misc";
    const typeLabel = typeLabelMap[it.type] || "其他";
    html += `
      <div class="timeline-item">
        <div class="timeline-dot ${dotClass}"></div>
        <div class="timeline-card">
          <div class="timeline-card-date">${escapeHtml(it.date)}</div>
          <div class="timeline-card-title">${escapeHtml(it.name)}</div>
          <div class="timeline-card-desc">${escapeHtml(it.docCode)} · ${escapeHtml(it.stage)}</div>
          <span class="timeline-card-badge ${badgeClass}">${typeLabel}</span>
        </div>
      </div>
    `;
  });
  html += '</div>';
  board.innerHTML = html;

  if (statusEl) {
    statusEl.textContent = "共 " + sorted.length + " 个关键审查节点";
  }
}

function parseDate(dateStr) {
  if (!dateStr) return 0;
  const parts = dateStr.split("/");
  if (parts.length === 3) {
    return new Date(parts[2], parts[0] - 1, parts[1]).getTime();
  }
  return new Date(dateStr).getTime();
}

function openReader(defaultToPdf = true, skipRender = false) {
  if (!readerModal) return;
  const items = kanbanState.documents;
  if (!items || items.length === 0) {
    showError("请先查询专利并加载审查文档");
    return;
  }

  readerModal.classList.remove("hidden");
  // Update floating ball state: reader is visible
  if (readerFloatingBall) {
    readerFloatingBall.classList.remove("hidden");
    const iconOpen = readerFloatingBall.querySelector(".reader-fb-icon-open");
    const iconBack = readerFloatingBall.querySelector(".reader-fb-icon-back");
    readerFloatingBall.title = "点击回到报告";
    if (iconOpen) iconOpen.classList.add("hidden");
    if (iconBack) iconBack.classList.remove("hidden");
  }
  // Always open in PDF view mode
  if (!pdfViewState.active) {
    togglePdfView(skipRender);
  }

  const readerItems = items;

  let listHtml = "";
  readerItems.forEach((it, idx) => {
    const globalIdx = it.idx;
    listHtml += `
      <div class="reader-doc-item" data-idx="${globalIdx}" data-action="reader-select">
        <div class="doc-item-code">${escapeHtml(it.docCode)} <span class="doc-item-date">${escapeHtml(it.date)}</span></div>
        <div class="doc-item-name">${escapeHtml(it.name)}</div>
      </div>
    `;
  });

  if (kanbanState.analysis) {
    listHtml += `
      <div class="reader-doc-item" data-action="reader-select-analysis">
        <div class="doc-item-code"><svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg> AI 分析报告</div>
        <div class="doc-item-name">审查历史综合分析</div>
      </div>
    `;
  }

  readerDocList.innerHTML = listHtml;
  readerContent.innerHTML = '<p class="placeholder">请从左侧选择文档查看内容</p>';
}

function selectReaderDoc(idx) {
  // Reset chat for new document
  chatHistory = [];
  if (chatMessages) chatMessages.innerHTML = "";

  const items = kanbanState.documents;
  const it = items.find(d => d.idx === idx);
  if (!it) return;

  document.querySelectorAll(".reader-doc-item").forEach(el => el.classList.remove("active"));
  const activeEl = document.querySelector(`.reader-doc-item[data-idx="${idx}"]`);
  if (activeEl) {
    activeEl.classList.add("active");
    activeEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // Track the currently selected document for PDF view
  pdfViewState.currentDocIdx = idx;

  // Reset search state
  pdfViewState.searchMatches = [];
  pdfViewState.searchCurrentIdx = -1;
  const searchInfo = document.getElementById("pdf-search-info");
  if (searchInfo) searchInfo.textContent = "";

  // 切换文档时：如果上一个文档正在OCR，后台默默继续；显示当前文档的OCR进度
  restoreOcrProgressForDoc(idx);

  // Reset OCR/search state for new document
  const ext = kanbanState.extractions[idx];
  const searchInput = document.getElementById("pdf-search-input");
  const searchBtn = document.getElementById("pdf-search-btn");
  if (ext && ext.blocks && ext.blocks.length > 0) {
    if (searchInput) { searchInput.disabled = false; searchInput.placeholder = "搜索关键词..."; }
    if (searchBtn) searchBtn.disabled = false;
  } else {
    if (searchInput) { searchInput.disabled = true; searchInput.placeholder = "请先OCR提取..."; }
    if (searchBtn) searchBtn.disabled = true;
  }
  // Translate button always enabled (auto-OCR if needed)
  // Reset translate panel
  if (pdfTranslatePanel) pdfTranslatePanel.classList.add("hidden");
  if (pdfTranslateContent) pdfTranslateContent.innerHTML = '<p class="placeholder">点击"翻译全文档"按钮翻译当前文档</p>';

  // Update extract panel for new document
  updateExtractPanel();

  // Render PDF view if active
  if (pdfViewState.active) {
    renderPdfView(idx);
  }

  if (ext) {
    const md = ext.markdown || ext.text || "";
    const blocks = ext.blocks || [];
    if (md) {
      if (blocks.length > 0) {
        const blocksHtml = blocks
          .filter(b => b.content && b.content.trim())
          .map(b => {
            const pageLabel = `第${b.page}页`;
            const bboxLabel = b.bbox ? ` [${b.bbox.join(",")}]` : "";
            return `<div class="reader-block" data-block-id="${escapeHtml(b.block_id)}">
              <div class="reader-block-header">
                <span class="reader-block-id">${escapeHtml(b.block_id)}</span>
                <span class="reader-block-label">${escapeHtml(b.label)}</span>
                <span class="reader-block-page">${pageLabel}${bboxLabel}</span>
              </div>
              <div class="reader-block-content">${renderMarkdown(b.content)}</div>
            </div>`;
          }).join("\n");
        readerContent.innerHTML = '<div class="markdown-body reader-blocks-view">' + blocksHtml + '</div>';
      } else {
        readerContent.innerHTML = '<div class="markdown-body">' + renderMarkdown(md) + '</div>';
      }
    } else {
      readerContent.innerHTML = '<p class="placeholder">该文档未提取到内容</p>';
    }
  } else {
    readerContent.innerHTML = '<p class="placeholder">该文档尚未提取内容，请先在看板中点击"提取内容"</p>';
  }
}

function selectReaderAnalysis() {
  document.querySelectorAll(".reader-doc-item").forEach(el => el.classList.remove("active"));
  const activeEl = document.querySelector('.reader-doc-item[data-action="reader-select-analysis"]');
  if (activeEl) activeEl.classList.add("active");

  if (kanbanState.analysis) {
    readerContent.innerHTML = '<div class="markdown-body">' + renderAnalysisModules(kanbanState.analysis) + '</div>';
  } else {
    readerContent.innerHTML = '<p class="placeholder">尚未生成 AI 分析报告</p>';
  }
}

// ============ PDF Viewer with Overlay Blocks ============

function togglePdfView(skipRender) {
  if (pdfViewState.active) {
    pdfViewState.active = false;
    readerPdfView.classList.add("hidden");
    readerContent.classList.remove("hidden");
    if (readerPdfToggle) {
      readerPdfToggle.classList.remove("active");
      readerPdfToggle.textContent = "PDF 视图";
    }
  } else {
    pdfViewState.active = true;
    readerPdfView.classList.remove("hidden");
    readerContent.classList.add("hidden");
    if (readerPdfToggle) {
      readerPdfToggle.classList.add("active");
      readerPdfToggle.textContent = "文本视图";
    }
    if (!skipRender && pdfViewState.currentDocIdx !== null) {
      renderPdfView(pdfViewState.currentDocIdx);
    }
  }
}

// ── 每个文档独立的 OCR 任务状态，切换文档时后台继续但不干扰当前视图 ──
// ocrJobs[idx] = { status: 'running'|'done'|'error', progress: 0-100, statusText: '...' }
const ocrJobs = {};
let _currentOcrJobIdx = null; // 当前正在显示进度的文档 idx

function showOcrProgressOverlay(statusText, progress, forIdx) {
  // 如果指定了文档idx且不是当前显示的文档，只更新后台状态，不显示UI
  const targetIdx = (forIdx != null) ? forIdx : _currentOcrJobIdx;
  if (targetIdx != null) {
    if (!ocrJobs[targetIdx]) ocrJobs[targetIdx] = {};
    ocrJobs[targetIdx].status = 'running';
    ocrJobs[targetIdx].progress = (typeof progress === 'number') ? progress : ocrJobs[targetIdx].progress || 0;
    ocrJobs[targetIdx].statusText = statusText || ocrJobs[targetIdx].statusText || '';
    // 如果不是当前正在查看的文档，不更新UI进度条（后台默默进行）
    if (targetIdx !== pdfViewState.currentDocIdx) return;
  }

  const existing = document.getElementById("ocr-progress-overlay");
  if (existing) {
    const textEl = existing.querySelector(".ocr-progress-label");
    const fillEl = existing.querySelector(".ocr-progress-fill");
    const pctEl = existing.querySelector(".ocr-progress-pct");
    if (textEl && statusText) textEl.textContent = statusText;
    if (fillEl && typeof progress === "number") {
      fillEl.style.width = progress + "%";
      fillEl.classList.remove("ocr-progress-indeterminate");
    }
    if (pctEl && typeof progress === "number") pctEl.textContent = Math.round(progress) + "%";
    return;
  }
  // 只有在查看对应文档时才创建UI进度条
  if (targetIdx != null && targetIdx !== pdfViewState.currentDocIdx) return;

  const overlay = document.createElement("div");
  overlay.id = "ocr-progress-overlay";
  overlay.style.cssText = "position:sticky;top:0;z-index:50;padding:10px 16px 12px;background:var(--accent-dim);border-bottom:2px solid var(--accent);font-size:13px;color:var(--accent);";
  const isIndeterminate = typeof progress !== "number";
  overlay.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
      <div class="ocr-progress-spinner" style="width:14px;height:14px;border:2px solid var(--accent);border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite;flex-shrink:0;"></div>
      <span class="ocr-progress-label" style="flex:1;">${statusText || "正在 OCR 识别中..."}</span>
      <span class="ocr-progress-pct" style="font-size:12px;font-weight:600;min-width:36px;text-align:right;">${typeof progress === "number" ? Math.round(progress) + "%" : ""}</span>
    </div>
    <div class="ocr-progress-bar" style="width:100%;height:4px;background:rgba(79,143,247,0.15);border-radius:2px;overflow:hidden;">
      <div class="ocr-progress-fill ${isIndeterminate ? "ocr-progress-indeterminate" : ""}" style="height:100%;background:var(--accent);border-radius:2px;transition:width 0.3s ease;${typeof progress === "number" ? "width:" + progress + "%;" : ""}"></div>
    </div>`;
  if (readerPdfContainer) {
    readerPdfContainer.prepend(overlay);
  }
}

function hideOcrProgressOverlay(forIdx) {
  const targetIdx = (forIdx != null) ? forIdx : _currentOcrJobIdx;
  if (targetIdx != null) {
    if (ocrJobs[targetIdx]) {
      ocrJobs[targetIdx].status = 'done';
    }
    if (targetIdx !== pdfViewState.currentDocIdx) return; // 后台完成不影响UI
  }
  const existing = document.getElementById("ocr-progress-overlay");
  if (existing) existing.remove();
  _currentOcrJobIdx = null;
}

// 切换到某个文档时，恢复该文档的OCR进度显示（如果正在进行）
function restoreOcrProgressForDoc(idx) {
  hideOcrProgressOverlay();
  if (idx != null && ocrJobs[idx] && ocrJobs[idx].status === 'running') {
    _currentOcrJobIdx = idx;
    showOcrProgressOverlay(ocrJobs[idx].statusText, ocrJobs[idx].progress, idx);
  }
}

async function renderPdfView(idx) {
  if (!pdfViewState.active) return;

  const items = kanbanState.documents;
  const it = items.find(d => d.idx === idx);
  if (!it) {
    readerPdfContainer.innerHTML = '<p class="pdf-error">未找到文档信息</p>';
    return;
  }

  pdfViewState.currentDocIdx = idx;
  // Increment render version to cancel any stale render
  const thisVersion = ++pdfViewState.renderVersion;

  if (typeof pdfjsLib === "undefined") {
    readerPdfContainer.innerHTML = '<p class="pdf-error">PDF.js 库未加载，无法显示 PDF 视图。请检查网络连接后刷新页面。</p>';
    return;
  }

  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const ext = kanbanState.extractions[idx];
  const blocks = ext ? (ext.blocks || []) : [];
  const pageDimensions = ext ? (ext.pageDimensions || {}) : {};

  const isUS = currentData.office === "US";
  const urlDocNum = isUS ? currentData.applicationNumber : encodeURIComponent(currentData.docNumber || currentData.applicationNumber);
  const encodedDocId = encodeURIComponent(it.docId);
  const pdfUrl = `/api/gd/doc-content/svc/doccontent/${currentData.office}/${urlDocNum}/${encodedDocId}/${it.numberOfPages}/${it.docFormat}`;

  // Check if the same document is already cached
  if (typeof _pdfDocCache === 'undefined') window._pdfDocCache = {};
  const cacheKey = idx + '_' + pdfUrl;
  // 加载该文档的标注（临时保存于 sessionStorage）
  pdfViewState.currentDocKey = cacheKey;
  if (!pdfViewState.annotList[cacheKey]) {
    pdfViewState.annotList[cacheKey] = loadPdfAnnotations(cacheKey);
  }
  _updateAnnotUndoRedoBtns(cacheKey);
  // 同步工具栏默认值
  const fontSizeSel = document.getElementById("pdf-annot-font-size");
  if (fontSizeSel) fontSizeSel.value = String(pdfViewState.annotFontSize);
  const lineWidthSel = document.getElementById("pdf-annot-line-width");
  if (lineWidthSel) lineWidthSel.value = String(pdfViewState.annotLineWidth);
  const dashBtn = document.getElementById("pdf-annot-dash");
  if (dashBtn) dashBtn.classList.toggle("active", pdfViewState.annotDash);
  const textColorInput = document.getElementById("pdf-annot-text-color");
  if (textColorInput) textColorInput.value = pdfViewState.annotTextColor;
  const lineColorInput = document.getElementById("pdf-annot-line-color");
  if (lineColorInput) lineColorInput.value = pdfViewState.annotLineColor;
  if (_pdfDocCache[cacheKey]) {
    // Use cached pdfDoc - skip re-fetching
    const pdfDoc = _pdfDocCache[cacheKey];
    pdfViewState.pdfDoc = pdfDoc;
    pdfViewState.totalPages = pdfDoc.numPages;
    pdfViewState.currentPage = 1;
    pdfViewState.renderedPages = {};

    readerPdfContainer.innerHTML = "";

    let containerWidth = readerPdfContainer.clientWidth - 32;
    if (containerWidth <= 0) {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      containerWidth = readerPdfContainer.clientWidth - 32;
    }
    const firstPage = await pdfDoc.getPage(1);
    const viewport = firstPage.getViewport({ scale: 1.0 });
    pdfViewState.baseScale = containerWidth > 0 ? Math.min(containerWidth / viewport.width, 1.0) : 1.0;
    pdfViewState.scale = 1.0;

    updatePdfToolbar();
    await renderAllPdfPages(pdfDoc, blocks, pageDimensions, pdfViewState.scale);
    if (pdfViewState.renderVersion !== thisVersion) return;

    // Apply pending highlight from onTraceClick if set
    if (pdfViewState.pendingHighlight && blocks.length > 0) {
      const blockId = pdfViewState.pendingHighlight;
      const rangeIds = pdfViewState.pendingHighlightRange || [];
      applyPdfHighlight(blockId, rangeIds);
      pdfViewState.pendingHighlight = null;
      pdfViewState.pendingHighlightRange = null;
    }
    return;
  }

  readerPdfContainer.innerHTML = '<p class="pdf-loading">正在加载 PDF 文件...</p>';

  // Clear stale pdfDoc while loading to prevent rerenderPdfPages from using wrong doc
  pdfViewState.pdfDoc = null;

  try {
    const resp = await fetch(pdfUrl, { headers: { "Accept": "application/pdf,*/*" } });
    // Check if a newer render has started — abort this one
    if (pdfViewState.renderVersion !== thisVersion) return;
    if (!resp.ok) throw new Error("PDF 下载失败: HTTP " + resp.status);

    const contentType = resp.headers.get("content-type") || "";
    if (contentType.includes("text/plain") || contentType.includes("text/html")) {
      const text = await resp.text();
      if (text.includes("Attachment Not Found") || text.includes("Not Found")) {
        throw new Error("文档暂不可下载（Attachment Not Found）");
      }
    }

    const arrayBuffer = await resp.arrayBuffer();
    if (pdfViewState.renderVersion !== thisVersion) return;
    if (arrayBuffer.byteLength < 100) {
      throw new Error("下载的文件过小，文档可能暂不可用");
    }

    const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    if (pdfViewState.renderVersion !== thisVersion) return;
    pdfViewState.pdfDoc = pdfDoc;
    pdfViewState.totalPages = pdfDoc.numPages;
    pdfViewState.currentPage = 1;
    pdfViewState.renderedPages = {};

    // Cache the pdfDoc for future use
    _pdfDocCache[cacheKey] = pdfDoc;

    readerPdfContainer.innerHTML = "";

    // Wait for layout to stabilize if container is not yet visible
    let containerWidth = readerPdfContainer.clientWidth - 32;
    if (containerWidth <= 0) {
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      containerWidth = readerPdfContainer.clientWidth - 32;
    }
    const firstPage = await pdfDoc.getPage(1);
    const viewport = firstPage.getViewport({ scale: 1.0 });
    pdfViewState.baseScale = containerWidth > 0 ? Math.min(containerWidth / viewport.width, 1.0) : 1.0;
    pdfViewState.scale = 1.0;

    updatePdfToolbar();
    await renderAllPdfPages(pdfDoc, blocks, pageDimensions, pdfViewState.scale);
    if (pdfViewState.renderVersion !== thisVersion) return;

    // Apply pending highlight from onTraceClick if set
    // Only consume pendingHighlight if blocks are available (overlay elements exist)
    if (pdfViewState.pendingHighlight && blocks.length > 0) {
      const blockId = pdfViewState.pendingHighlight;
      const rangeIds = pdfViewState.pendingHighlightRange || [];
      pdfViewState.pendingHighlight = null;
      pdfViewState.pendingHighlightRange = null;
      pdfViewState.traceJumpPending = false;
      highlightPdfBlock(blockId);
      rangeIds.forEach(id => {
        if (id !== blockId) {
          const overlay = readerPdfContainer.querySelector(`.pdf-block-overlay[data-block-id="${id}"]`);
          if (overlay) overlay.classList.add("highlight-range");
        }
      });
    }

    // Auto-OCR: if no extraction exists and autoOcr is enabled, trigger OCR
    // But skip if this is a trace jump (document should already have OCR data from analysis)
    if (blocks.length === 0 && !pdfViewState.traceJumpPending) {
      const config = window.AI.loadAIConfig();
      const ocrConfig = window.AI.getOCRConfig(config);
      if (ocrConfig.autoOcr !== false) {
        // Show OCR progress overlay on top of the already-rendered PDF
        _currentOcrJobIdx = idx;
        ocrJobs[idx] = { status: 'running', progress: 0, statusText: "正在自动 OCR 识别中，PDF 已可浏览..." };
        showOcrProgressOverlay("正在自动 OCR 识别中，PDF 已可浏览...", null, idx);
        ocrPdf(); // fire-and-forget, will re-render on completion
      }
    } else if (ocrJobs[idx] && ocrJobs[idx].status === 'running') {
      // 该文档正在后台 OCR，恢复显示进度条
      _currentOcrJobIdx = idx;
      showOcrProgressOverlay(ocrJobs[idx].statusText, ocrJobs[idx].progress, idx);
    }
    // Clear trace jump flag after renderPdfView has processed it
    if (pdfViewState.traceJumpPending && blocks.length > 0) {
      pdfViewState.traceJumpPending = false;
    }
  } catch (e) {
    if (pdfViewState.renderVersion !== thisVersion) return;
    pdfViewState.pendingHighlight = null;
    pdfViewState.pendingHighlightRange = null;
    readerPdfContainer.innerHTML = '<p class="pdf-error">' + escapeHtml(e.message) + '<br><small>请切换到文本视图查看提取的内容</small></p>';
  }
}

async function renderAllPdfPages(pdfDoc, blocks, pageDimensions, scale) {
  readerPdfContainer.innerHTML = "";

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: scale });

    const wrapper = document.createElement("div");
    wrapper.className = "pdf-page-wrapper";
    wrapper.dataset.page = pageNum;

    const pageLabel = document.createElement("div");
    pageLabel.className = "pdf-page-label";
    pageLabel.textContent = "第 " + pageNum + " 页";
    wrapper.appendChild(pageLabel);

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    wrapper.appendChild(canvas);

    const pageBlocks = blocks.filter(b => b.page === pageNum);
    const pageDim = pageDimensions[pageNum];

    // 添加框选矩形层
    const selectionRect = document.createElement("div");
    selectionRect.className = "pdf-selection-rect";
    wrapper.appendChild(selectionRect);

    // 标注层（承载高亮/划线/注释元素）
    const annotLayer = document.createElement("div");
    annotLayer.className = "pdf-annot-layer";
    annotLayer.dataset.page = pageNum;
    wrapper.appendChild(annotLayer);

    if (pageBlocks.length > 0) {
      // OCR bbox 坐标系：基于 OCR 引擎内部像素分辨率，与 PDF 点(72DPI)坐标系不同。
      // 优先使用保存的 pageDimensions（来自OCR API返回的图像尺寸）- 这是最可靠的数据源；
      // 只有当pageDimensions缺失或bbox明显超出范围时，才通过bbox范围+PDF宽高比推导。
      const pd = pageDimensions[pageNum] || {};
      let ocrW = Number(pd.width) || 0;
      let ocrH = Number(pd.height) || 0;

      // 计算当前页所有bbox的最大坐标范围
      let maxBboxX = 0, maxBboxY = 0;
      let minBboxX = Infinity, minBboxY = Infinity;
      for (const b of pageBlocks) {
        if (!b.bbox) continue;
        const [bx1, by1, bx2, by2] = b.bbox;
        if (bx1 < minBboxX) minBboxX = bx1;
        if (by1 < minBboxY) minBboxY = by1;
        if (bx2 > maxBboxX) maxBboxX = bx2;
        if (by2 > maxBboxY) maxBboxY = by2;
      }

      // PDF页面在scale=1下的点尺寸（宽高比基准）
      const pdfPageView = page.getViewport({ scale: 1.0 });
      const pdfAspect = pdfPageView.width / pdfPageView.height;

      // 验证保存的pageDimensions是否可靠：
      // 1. 宽高都大于0
      // 2. bbox最大值不超过图像尺寸（允许10%余量，以应对可能的坐标精度问题）
      let dimsValid = ocrW > 0 && ocrH > 0;
      if (dimsValid) {
        const bboxOk = maxBboxX <= ocrW * 1.1 && maxBboxY <= ocrH * 1.1;
        if (!bboxOk) {
          console.warn(`[PDF渲染] 页${pageNum} pageDimensions中bbox超出范围: ocrW=${ocrW},ocrH=${ocrH},maxBboxX=${maxBboxX},maxBboxY=${maxBboxY}`);
          dimsValid = false;
        } else {
          console.log(`[PDF渲染] 页${pageNum} 使用保存的pageDimensions: ocrW=${ocrW},ocrH=${ocrH}`);
        }
      }

      if (!dimsValid) {
        // 从bbox范围+PDF宽高比推导OCR图像尺寸：
        // 策略：
        // 1. 计算bbox内容区域的宽高比
        // 2. 如果内容区域比PDF页面更"宽"，说明左右有边距，以X范围为准推导
        // 3. 如果内容区域比PDF页面更"高"，说明上下有边距，以Y范围为准推导
        // 4. 注意：推导假设内容区域是居中或均匀分布的，无法完美处理边距不均匀的情况
        // 5. 推导结果仅作为最后手段，保存的pageDimensions始终更可靠
        if (maxBboxX > 0 && maxBboxY > 0 && minBboxX < Infinity && minBboxY < Infinity) {
          const bboxContentW = maxBboxX - minBboxX;
          const bboxContentH = maxBboxY - minBboxY;
          const bboxAspect = bboxContentW / bboxContentH;
          
          // 假设bbox内容区域按照PDF比例居中放置，推导完整图片尺寸
          if (bboxAspect > pdfAspect) {
            // 内容偏宽 - 宽度占满图片宽度方向（含左右边距）
            ocrW = maxBboxX * 1.01; // 右边距1%
            ocrH = ocrW / pdfAspect;
            // 如果maxBboxY超出了推导高度，说明我们的假设不对，改用高度推导
            if (maxBboxY > ocrH) {
              ocrH = maxBboxY * 1.01;
              ocrW = ocrH * pdfAspect;
            }
          } else {
            // 内容偏高或比例匹配 - 高度占满图片高度方向（含上下边距）
            ocrH = maxBboxY * 1.01;
            ocrW = ocrH * pdfAspect;
            // 如果maxBboxX超出了推导宽度，说明我们的假设不对，改用宽度推导
            if (maxBboxX > ocrW) {
              ocrW = maxBboxX * 1.01;
              ocrH = ocrW / pdfAspect;
            }
          }
          console.log(`[PDF渲染] 页${pageNum} 从bbox推导尺寸: ocrW=${Math.round(ocrW)},ocrH=${Math.round(ocrH)} (注意：推导结果可能有边距误差，重新OCR可获得精确尺寸)`);
        } else {
          ocrW = 0; ocrH = 0;
        }
      }

      const useOcrDims = ocrW > 0 && ocrH > 0;

      pageBlocks.forEach(b => {
        if (!b.bbox || !useOcrDims) return;
        const [x1, y1, x2, y2] = b.bbox;
        // 将 OCR 像素坐标归一化到 [0,1]，再映射到 viewport CSS 像素
        const cx1 = (x1 / ocrW) * viewport.width;
        const cy1 = (y1 / ocrH) * viewport.height;
        const cw = ((x2 - x1) / ocrW) * viewport.width;
        const ch = ((y2 - y1) / ocrH) * viewport.height;
        const overlay = document.createElement("div");
        overlay.className = "pdf-block-overlay";
        overlay.dataset.blockId = b.block_id;
        overlay.dataset.label = b.label || "text";
        overlay.style.left = cx1 + "px";
        overlay.style.top = cy1 + "px";
        overlay.style.width = cw + "px";
        overlay.style.height = ch + "px";

        const tooltip = document.createElement("div");
        tooltip.className = "pdf-block-tooltip";
        tooltip.textContent = b.block_id + " [" + (b.label || "text") + "]";
        overlay.appendChild(tooltip);

        overlay.addEventListener("click", (ev) => {
          ev.stopPropagation();
          // 标注模式下不触发块选择
          if (pdfViewState.annotTool) return;
          // 单击切换选中状态（选中后保持持久，用于翻译范围选择）
          const blockId = b.block_id;
          const idx = pdfViewState.selectedBlockIds.indexOf(blockId);
          if (idx >= 0) {
            pdfViewState.selectedBlockIds.splice(idx, 1);
            overlay.classList.remove("block-selected");
          } else {
            pdfViewState.selectedBlockIds.push(blockId);
            overlay.classList.add("block-selected");
          }
          updatePdfSelectionInfo();
          // Navigate extract panel to the corresponding page
          navigateExtractPanelToBlock(b);
        });

        overlay.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          // 标注模式下禁用块右键菜单
          if (pdfViewState.annotTool) return;
          // 右键：如果此框已在选中集合中，翻译整个范围；否则先选中此框再翻译
          const blockId = b.block_id;
          const isInSelection = pdfViewState.selectedBlockIds.includes(blockId);
          if (!isInSelection) {
            if (!ev.shiftKey) {
              clearPdfBlockSelection();
            }
            pdfViewState.selectedBlockIds.push(blockId);
            refreshPdfBlockSelectionVisual();
            updatePdfSelectionInfo();
          }
          showPdfBlockContextMenu(ev.clientX, ev.clientY, blockId);
        });

        wrapper.appendChild(overlay);
      });
    }

    // 框选：在 wrapper 内按住鼠标左键拖动
    wrapper.addEventListener("mousedown", (ev) => {
      if (ev.button !== 0) return;
      // 标注工具激活时，优先进入标注拖拽流程
      if (pdfViewState.annotTool) {
        ev.preventDefault();
        ev.stopPropagation();
        startPdfAnnotDrag(ev, wrapper, pageNum, viewport);
        return;
      }
      if (ev.target.classList && ev.target.classList.contains("pdf-block-overlay")) return;
      ev.preventDefault();
      const rect = wrapper.getBoundingClientRect();
      const startX = ev.clientX - rect.left;
      const startY = ev.clientY - rect.top;
      pdfViewState.selecting = true;
      pdfViewState.selectStart = { x: startX, y: startY, page: pageNum };
      pdfViewState.selectEnd = { x: startX, y: startY, page: pageNum };
      // 如果不按 Shift，先清除之前的选择
      if (!ev.shiftKey) {
        clearPdfBlockSelection();
      }
      selectionRect.style.display = "block";
      selectionRect.style.left = startX + "px";
      selectionRect.style.top = startY + "px";
      selectionRect.style.width = "0px";
      selectionRect.style.height = "0px";
    });

    readerPdfContainer.appendChild(wrapper);
    pdfViewState.renderedPages[pageNum] = wrapper;
  }

  // PDF scroll → extract panel page sync (install once)
  if (!readerPdfContainer._extractScrollSyncInstalled) {
    readerPdfContainer._extractScrollSyncInstalled = true;
    let _extractScrollRaf = false;
    readerPdfContainer.addEventListener("scroll", () => {
      if (_extractScrollRaf) return;
      _extractScrollRaf = true;
      requestAnimationFrame(() => {
        _extractScrollRaf = false;
        syncExtractPanelToPdfPage();
      });
    });
  }

  // 全局 mousemove / mouseup 用于框选
  if (!readerPdfContainer._selectionHandlersInstalled) {
    readerPdfContainer._selectionHandlersInstalled = true;

    document.addEventListener("mousemove", (ev) => {
      if (!pdfViewState.selecting || !pdfViewState.selectStart) return;
      const page = pdfViewState.selectStart.page;
      const wrapper = pdfViewState.renderedPages[page];
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const x = Math.max(0, Math.min(ev.clientX - rect.left, rect.width));
      const y = Math.max(0, Math.min(ev.clientY - rect.top, rect.height));
      pdfViewState.selectEnd = { x, y, page };
      const left = Math.min(pdfViewState.selectStart.x, x);
      const top = Math.min(pdfViewState.selectStart.y, y);
      const width = Math.abs(x - pdfViewState.selectStart.x);
      const height = Math.abs(y - pdfViewState.selectStart.y);
      const selectionRect = wrapper.querySelector(".pdf-selection-rect");
      if (selectionRect) {
        selectionRect.style.left = left + "px";
        selectionRect.style.top = top + "px";
        selectionRect.style.width = width + "px";
        selectionRect.style.height = height + "px";
      }
      // 实时高亮被框中的 blocks（仅视觉预览）
      refreshPdfBoxSelectionVisual(left, top, width, height, page);
    });

    document.addEventListener("mouseup", (ev) => {
      if (!pdfViewState.selecting) return;
      pdfViewState.selecting = false;
      const page = pdfViewState.selectStart ? pdfViewState.selectStart.page : null;
      if (page) {
        const wrapper = pdfViewState.renderedPages[page];
        if (wrapper) {
          const selectionRect = wrapper.querySelector(".pdf-selection-rect");
          if (selectionRect) selectionRect.style.display = "none";
        }
        const s = pdfViewState.selectStart;
        const e = pdfViewState.selectEnd;
        if (s && e) {
          const left = Math.min(s.x, e.x);
          const top = Math.min(s.y, e.y);
          const width = Math.abs(e.x - s.x);
          const height = Math.abs(e.y - s.y);
          if (width > 5 && height > 5) {
            // 真正的框选，将框中的 blocks 加入选中集合
            selectBlocksInRect(left, top, width, height, page);
          } else {
            // 过小的拖动视为点击空白，清除选择
            clearPdfBlockSelection();
          }
        }
      }
      pdfViewState.selectStart = null;
      pdfViewState.selectEnd = null;
      refreshPdfBlockSelectionVisual();
      updatePdfSelectionInfo();
    });
  }

  // 全局 mousemove / mouseup 用于标注拖拽 + 移动 + 端点旋转
  if (!readerPdfContainer._annotHandlersInstalled) {
    readerPdfContainer._annotHandlersInstalled = true;

    document.addEventListener("mousemove", (ev) => {
      // —— 标注端点拖拽（旋转/调整长度）——
      if (pdfViewState.annotResizing) {
        const r = pdfViewState.annotResizing;
        const wrapper = pdfViewState.renderedPages[r.pageNum];
        if (!wrapper) return;
        const rect = wrapper.getBoundingClientRect();
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;
        const [px, py] = r.viewport.convertToPdfPoint(mx, my);
        // 实时更新内存中的标注数据（undo 已在 mousedown 时推入）
        const docKey = _getCurrentPdfAnnotKey();
        if (docKey) {
          const list = pdfViewState.annotList[docKey] || [];
          const target = list.find(a => a.id === r.id);
          if (target) {
            target.x2 = px;
            target.y2 = py;
            r.moved = true;
            renderPdfAnnotsForPage(r.pageNum);
          }
        }
        return;
      }
      // —— 标注移动（拖动整体位置）——
      if (pdfViewState.annotMoving) {
        const m = pdfViewState.annotMoving;
        const dx = ev.clientX - m.startMouseX;
        const dy = ev.clientY - m.startMouseY;
        if (m.el) {
          m.el.style.left = (m.origCssLeft + dx) + "px";
          m.el.style.top = (m.origCssTop + dy) + "px";
        }
        m.moved = true;
        return;
      }
      // —— 标注绘制拖拽 ——
      if (!pdfViewState.annotDragging || !pdfViewState.annotDragStart) return;
      const page = pdfViewState.annotDragPage;
      const wrapper = pdfViewState.renderedPages[page];
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const x = Math.max(0, Math.min(ev.clientX - rect.left, rect.width));
      const y = Math.max(0, Math.min(ev.clientY - rect.top, rect.height));
      pdfViewState.annotDragEnd = { x, y };
      const tool = pdfViewState.annotTool;
      const s = pdfViewState.annotDragStart;
      if (tool === "underline" || tool === "arrow") {
        // 直线预览
        const lineEl = wrapper.querySelector(".pdf-annot-drag-line");
        if (lineEl) {
          const dx = x - s.x, dy = y - s.y;
          const length = Math.sqrt(dx * dx + dy * dy);
          const angle = Math.atan2(dy, dx) * 180 / Math.PI;
          lineEl.style.left = s.x + "px";
          lineEl.style.top = s.y + "px";
          lineEl.style.width = length + "px";
          lineEl.style.transform = "rotate(" + angle + "deg)";
        }
      } else {
        const left = Math.min(s.x, x);
        const top = Math.min(s.y, y);
        const width = Math.abs(x - s.x);
        const height = Math.abs(y - s.y);
        const dragRect = wrapper.querySelector(".pdf-annot-drag-rect");
        if (dragRect) {
          dragRect.style.left = left + "px";
          dragRect.style.top = top + "px";
          dragRect.style.width = width + "px";
          dragRect.style.height = height + "px";
        }
      }
    });

    document.addEventListener("mouseup", (ev) => {
      // —— 完成端点拖拽（旋转/调整）——
      if (pdfViewState.annotResizing) {
        const r = pdfViewState.annotResizing;
        if (r.moved) {
          const docKey = _getCurrentPdfAnnotKey();
          if (docKey) savePdfAnnotations(docKey);
        }
        pdfViewState.annotResizing = null;
        return;
      }
      // —— 完成标注移动 ——
      if (pdfViewState.annotMoving) {
        const m = pdfViewState.annotMoving;
        const docKey = _getCurrentPdfAnnotKey();
        if (m.moved && docKey && m.viewport && m.el) {
          const list = pdfViewState.annotList[docKey] || [];
          const target = list.find(a => a.id === m.id);
          if (target) {
            const cssDx = (parseFloat(m.el.style.left) || 0) - m.origCssLeft;
            const cssDy = (parseFloat(m.el.style.top) || 0) - m.origCssTop;
            const [ox0, oy0] = m.viewport.convertToPdfPoint(0, 0);
            const [ox1, oy1] = m.viewport.convertToPdfPoint(cssDx, cssDy);
            const dpx = ox1 - ox0, dpy = oy1 - oy0;
            _pushAnnotUndo(docKey);
            target.x1 += dpx; target.y1 += dpy;
            target.x2 += dpx; target.y2 += dpy;
            savePdfAnnotations(docKey);
            renderPdfAnnotsForPage(m.pageNum);
          }
        }
        pdfViewState.annotMoving = null;
        return;
      }
      // —— 完成标注绘制 ——
      if (!pdfViewState.annotDragging) return;
      pdfViewState.annotDragging = false;
      const page = pdfViewState.annotDragPage;
      const viewport = pdfViewState.annotDragViewport;
      const wrapper = page ? pdfViewState.renderedPages[page] : null;
      const tool = pdfViewState.annotTool;
      // 隐藏预览元素
      if (wrapper) {
        const dr = wrapper.querySelector(".pdf-annot-drag-rect");
        if (dr) dr.style.display = "none";
        const dl = wrapper.querySelector(".pdf-annot-drag-line");
        if (dl) dl.style.display = "none";
      }
      const s = pdfViewState.annotDragStart;
      const e = pdfViewState.annotDragEnd;
      pdfViewState.annotDragStart = null;
      pdfViewState.annotDragEnd = null;
      pdfViewState.annotDragPage = null;
      pdfViewState.annotDragViewport = null;
      if (!wrapper || !viewport || !s || !e || !tool) return;
      if (tool === "note") {
        // 注释：点击放置时使用默认尺寸
        let ex = e.x, ey = e.y;
        if (Math.abs(e.x - s.x) < 10 || Math.abs(e.y - s.y) < 10) {
          ex = s.x + 120; ey = s.y + 24; // 默认文字框大小
        }
        _finalizePdfAnnotation(tool, page, viewport, s.x, s.y, ex, ey);
      } else if (tool === "underline" || tool === "arrow") {
        // 划线/箭头：起点到终点
        if (Math.abs(e.x - s.x) < 5 && Math.abs(e.y - s.y) < 5) return;
        _finalizePdfAnnotation(tool, page, viewport, s.x, s.y, e.x, e.y);
      } else {
        // 高亮
        if (Math.abs(e.x - s.x) < 5 || Math.abs(e.y - s.y) < 5) return;
        _finalizePdfAnnotation(tool, page, viewport, s.x, s.y, e.x, e.y);
      }
    });
  }

  // 渲染已存在的标注
  await renderAllPdfAnnots();
}

async function rerenderPdfPages() {
  if (!pdfViewState.pdfDoc) return;
  const idx = pdfViewState.currentDocIdx;
  const ext = kanbanState.extractions[idx];
  const blocks = ext ? (ext.blocks || []) : [];
  const pageDimensions = ext ? (ext.pageDimensions || {}) : {};
  await renderAllPdfPages(pdfViewState.pdfDoc, blocks, pageDimensions, pdfViewState.scale);
  updatePdfToolbar();
  // Restore selection visual after re-render
  refreshPdfBlockSelectionVisual();
  updatePdfSelectionInfo();
}

function updatePdfToolbar() {
  if (pdfPageInfo) {
    pdfPageInfo.textContent = pdfViewState.totalPages;
  }
  if (pdfPageInput) {
    pdfPageInput.max = pdfViewState.totalPages;
    if (document.activeElement !== pdfPageInput) {
      pdfPageInput.value = pdfViewState.currentPage;
    }
  }
  if (pdfZoomLevel) {
    pdfZoomLevel.textContent = Math.round(pdfViewState.scale * 100) + "%";
  }
}

function pdfGoToPage(pageNum) {
  if (pageNum < 1 || pageNum > pdfViewState.totalPages) return;
  pdfViewState.currentPage = pageNum;
  updatePdfToolbar();
  const wrapper = pdfViewState.renderedPages[pageNum];
  if (wrapper) {
    wrapper.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function pdfZoomInAction() {
  pdfViewState.scale = Math.min(pdfViewState.scale * 1.25, 5.0);
  rerenderPdfPages();
}

function pdfZoomOutAction() {
  pdfViewState.scale = Math.max(pdfViewState.scale / 1.25, 0.25);
  rerenderPdfPages();
}

function pdfZoomFitAction() {
  pdfViewState.scale = pdfViewState.baseScale;
  rerenderPdfPages();
}

/* ════════════════════════════════════════════════════════════════
 * PDF 标注功能（高亮 / 划线 / 箭头 / 文字注释 / 导出带标注 PDF）
 * 标注以 PDF 原生坐标（点为单位，Y 轴自下而上）存储，与缩放无关。
 * 临时保存于 sessionStorage（应用关闭即清除），关闭前提醒导出。
 * 支持撤回/重做、拖动移动、线条端点拖拽旋转。
 * ════════════════════════════════════════════════════════════════ */

const _PDF_ANNOT_STORAGE_PREFIX = "patentlens_pdf_annot_";

function _buildPdfDocKey(idx) {
  const it = kanbanState.documents.find(d => d.idx === idx);
  if (!it) return null;
  const isUS = currentData.office === "US";
  const urlDocNum = isUS ? currentData.applicationNumber : encodeURIComponent(currentData.docNumber || currentData.applicationNumber);
  const encodedDocId = encodeURIComponent(it.docId);
  const pdfUrl = `/api/gd/doc-content/svc/doccontent/${currentData.office}/${urlDocNum}/${encodedDocId}/${it.numberOfPages}/${it.docFormat}`;
  return idx + '_' + pdfUrl;
}

function _getCurrentPdfAnnotKey() {
  return pdfViewState.currentDocKey || _buildPdfDocKey(pdfViewState.currentDocIdx);
}

function loadPdfAnnotations(docKey) {
  if (!docKey) return [];
  try {
    const raw = sessionStorage.getItem(_PDF_ANNOT_STORAGE_PREFIX + docKey);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function savePdfAnnotations(docKey) {
  if (!docKey) return;
  try {
    const list = pdfViewState.annotList[docKey] || [];
    sessionStorage.setItem(_PDF_ANNOT_STORAGE_PREFIX + docKey, JSON.stringify(list));
  } catch (e) { /* sessionStorage 配额超限等，忽略 */ }
  // 所有标注变更都会经过此处，统一同步关闭确认标志位到主进程
  _updateAnnotCloseFlag();
}

function _hasAnyPdfAnnotations() {
  return Object.values(pdfViewState.annotList).some(list => list && list.length > 0);
}

// 同步标注状态到 Electron 主进程（用于关闭前原生确认框）
function _updateAnnotCloseFlag() {
  if (window.electronAPI && typeof window.electronAPI.setHasAnnotations === "function") {
    window.electronAPI.setHasAnnotations(_hasAnyPdfAnnotations());
  }
}

function setPdfAnnotTool(tool) {
  if (pdfViewState.annotTool === tool) {
    pdfViewState.annotTool = null;
  } else {
    pdfViewState.annotTool = tool;
  }
  ["highlight", "underline", "arrow", "note"].forEach(t => {
    const btn = document.getElementById("pdf-annot-" + t);
    if (btn) btn.classList.toggle("active", pdfViewState.annotTool === t);
  });
  if (readerPdfContainer) {
    readerPdfContainer.classList.toggle("pdf-annot-mode", !!pdfViewState.annotTool);
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    // Close any open context menus first
    if (_pdfAnnotCtxMenu) { hidePdfAnnotContextMenu(); }
    if (_pdfCtxMenu) { hidePdfBlockContextMenu(); }
    if (_patentDetailCtxMenu) { hidePatentDetailContextMenu(); }
    if (pdfViewState.annotTool) {
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === "INPUT" || activeEl.tagName === "TEXTAREA" || activeEl.isContentEditable)) {
        return;
      }
      e.preventDefault();
      setPdfAnnotTool(null);
    }
  }
});

function togglePdfOcrHide() {
  pdfViewState.ocrHidden = !pdfViewState.ocrHidden;
  if (readerPdfContainer) {
    readerPdfContainer.classList.toggle("pdf-ocr-hidden", pdfViewState.ocrHidden);
  }
  const btn = document.getElementById("pdf-annot-hide-ocr");
  if (btn) {
    const span = btn.querySelector("span");
    if (span) span.textContent = pdfViewState.ocrHidden ? "显示OCR" : "隐藏OCR";
    btn.classList.toggle("active", pdfViewState.ocrHidden);
  }
}

// 撤回/重做（快照式）
function _pushAnnotUndo(docKey) {
  if (!docKey) return;
  if (!pdfViewState.annotUndoStack[docKey]) pdfViewState.annotUndoStack[docKey] = [];
  pdfViewState.annotUndoStack[docKey].push(JSON.parse(JSON.stringify(pdfViewState.annotList[docKey] || [])));
  pdfViewState.annotRedoStack[docKey] = [];
  _updateAnnotUndoRedoBtns(docKey);
}

function _updateAnnotUndoRedoBtns(docKey) {
  const key = docKey || _getCurrentPdfAnnotKey();
  const undoBtn = document.getElementById("pdf-annot-undo");
  const redoBtn = document.getElementById("pdf-annot-redo");
  const undoStack = key ? (pdfViewState.annotUndoStack[key] || []) : [];
  const redoStack = key ? (pdfViewState.annotRedoStack[key] || []) : [];
  if (undoBtn) undoBtn.disabled = undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

function undoPdfAnnotation() {
  const docKey = _getCurrentPdfAnnotKey();
  if (!docKey) return;
  const undoStack = pdfViewState.annotUndoStack[docKey] || [];
  if (undoStack.length === 0) return;
  if (!pdfViewState.annotRedoStack[docKey]) pdfViewState.annotRedoStack[docKey] = [];
  pdfViewState.annotRedoStack[docKey].push(JSON.parse(JSON.stringify(pdfViewState.annotList[docKey] || [])));
  pdfViewState.annotList[docKey] = undoStack.pop();
  savePdfAnnotations(docKey);
  renderAllPdfAnnots();
  _updateAnnotUndoRedoBtns(docKey);
}

function redoPdfAnnotation() {
  const docKey = _getCurrentPdfAnnotKey();
  if (!docKey) return;
  const redoStack = pdfViewState.annotRedoStack[docKey] || [];
  if (redoStack.length === 0) return;
  if (!pdfViewState.annotUndoStack[docKey]) pdfViewState.annotUndoStack[docKey] = [];
  pdfViewState.annotUndoStack[docKey].push(JSON.parse(JSON.stringify(pdfViewState.annotList[docKey] || [])));
  pdfViewState.annotList[docKey] = redoStack.pop();
  savePdfAnnotations(docKey);
  renderAllPdfAnnots();
  _updateAnnotUndoRedoBtns(docKey);
}

function _hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
  return m
    ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
    : { r: 229, g: 57, b: 53 };
}

// 自定义注释输入弹窗（Electron 不支持 window.prompt）
function _showAnnotNotePrompt(defaultText) {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.className = "pdf-annot-note-modal";
    modal.innerHTML =
      '<div class="pdf-annot-note-modal-title">请输入注释内容</div>' +
      '<textarea></textarea>' +
      '<div class="pdf-annot-note-modal-actions">' +
      '<button class="pdf-annot-note-cancel">取消</button>' +
      '<button class="pdf-annot-note-ok">确定</button>' +
      '</div>';
    document.body.appendChild(modal);
    modal.style.left = "50%";
    modal.style.top = "50%";
    modal.style.transform = "translate(-50%, -50%)";
    const ta = modal.querySelector("textarea");
    ta.value = defaultText || "";
    setTimeout(() => { ta.focus(); }, 0);
    const finish = (val) => { modal.remove(); resolve(val); };
    modal.querySelector(".pdf-annot-note-ok").addEventListener("click", () => finish(ta.value.trim()));
    modal.querySelector(".pdf-annot-note-cancel").addEventListener("click", () => finish(null));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(ta.value.trim()); }
      else if (e.key === "Escape") { e.preventDefault(); finish(null); }
    });
  });
}

// 角度自动水平/竖直校正：接近 0/90/180/270 度时吸附
function _snapAngle(x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  const tolerance = 10;
  const snapPoints = [0, 90, 180, -90, -180, 270, -270];
  for (const sp of snapPoints) {
    if (Math.abs(angle - sp) <= tolerance) {
      const rad = sp * Math.PI / 180;
      const length = Math.sqrt(dx * dx + dy * dy);
      return { x2: x1 + length * Math.cos(rad), y2: y1 + length * Math.sin(rad) };
    }
  }
  return { x2: x2, y2: y2 };
}

function _createAnnotElement(annot, viewport) {
  const [ax1, ay1] = viewport.convertToViewportPoint(annot.x1, annot.y1);
  const [ax2, ay2] = viewport.convertToViewportPoint(annot.x2, annot.y2);

  const el = document.createElement("div");
  el.className = "pdf-annot pdf-annot-" + annot.type;
  el.dataset.annotId = annot.id;

  if (annot.type === "underline" || annot.type === "arrow") {
    // 划线/箭头：SVG 直线（支持任意角度），容器定位在线条外接矩形
    const left = Math.min(ax1, ax2);
    const top = Math.min(ay1, ay2);
    const w = Math.abs(ax2 - ax1);
    const h = Math.abs(ay2 - ay1);
    const lineW = annot.lineWidth || 2;
    el.style.left = left + "px";
    el.style.top = top + "px";
    el.style.width = Math.max(w, lineW + 2) + "px";
    el.style.height = Math.max(h, lineW + 2) + "px";
    // SVG 内坐标相对于外接矩形左上角
    const sx1 = ax1 - left, sy1 = ay1 - top;
    const sx2 = ax2 - left, sy2 = ay2 - top;
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("width", Math.max(w, 12));
    svg.setAttribute("height", Math.max(h, 12));
    const line = document.createElementNS(svgNS, "line");
    line.setAttribute("x1", sx1);
    line.setAttribute("y1", sy1);
    line.setAttribute("x2", sx2);
    line.setAttribute("y2", sy2);
    line.setAttribute("stroke", annot.color || "#e53935");
    line.setAttribute("stroke-width", lineW);
    line.setAttribute("stroke-linecap", "round");
    if (annot.dash) {
      line.setAttribute("stroke-dasharray", (lineW * 3) + " " + (lineW * 2));
    }
    svg.appendChild(line);
    if (annot.type === "arrow") {
      // 箭头头部（三角形）
      const angle = Math.atan2(sy2 - sy1, sx2 - sx1);
      const headLen = 8 + lineW * 2;
      const headAngle = 0.4; // ~23°
      const p2x = sx2 - headLen * Math.cos(angle - headAngle);
      const p2y = sy2 - headLen * Math.sin(angle - headAngle);
      const p3x = sx2 - headLen * Math.cos(angle + headAngle);
      const p3y = sy2 - headLen * Math.sin(angle + headAngle);
      const poly = document.createElementNS(svgNS, "polygon");
      poly.setAttribute("points", sx2 + "," + sy2 + " " + p2x + "," + p2y + " " + p3x + "," + p3y);
      poly.setAttribute("fill", annot.color || "#e53935");
      svg.appendChild(poly);
    }
    el.appendChild(svg);

    // 端点手柄（非标注模式下拖拽可旋转/调整长度）
    const handle = document.createElement("div");
    handle.className = "pdf-annot-handle";
    handle.style.left = sx2 + "px";
    handle.style.top = sy2 + "px";
    handle.addEventListener("mousedown", (ev) => {
      if (pdfViewState.annotTool) return;
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const wrapper = el.closest(".pdf-page-wrapper");
      const pageNum = parseInt(wrapper.dataset.page, 10);
      // 提前推入 undo 快照（保存修改前状态）
      const docKey = _getCurrentPdfAnnotKey();
      if (docKey) _pushAnnotUndo(docKey);
      pdfViewState.annotResizing = {
        id: annot.id,
        pageNum: pageNum,
        viewport: viewport,
      };
    });
    el.appendChild(handle);

  } else if (annot.type === "highlight") {
    // 高亮：红色边框 + 低透明度填充
    const left = Math.min(ax1, ax2);
    const top = Math.min(ay1, ay2);
    const width = Math.abs(ax2 - ax1);
    const height = Math.abs(ay2 - ay1);
    const borderW = annot.lineWidth || 2;
    el.style.left = left + "px";
    el.style.top = top + "px";
    el.style.width = width + "px";
    el.style.height = height + "px";
    el.style.border = borderW + "px solid " + (annot.color || "#e53935");
    el.style.backgroundColor = annot.color || "#e53935";
    el.style.opacity = "0.15";

  } else if (annot.type === "note") {
    // 注释：无背景、无边框，仅显示文字
    const left = Math.min(ax1, ax2);
    const top = Math.min(ay1, ay2);
    const width = Math.abs(ax2 - ax1);
    const height = Math.abs(ay2 - ay1);
    const fSize = annot.fontSize || 14;
    el.style.left = left + "px";
    el.style.top = top + "px";
    el.style.width = Math.max(width, 40) + "px";
    el.style.minHeight = Math.max(height, fSize + 4) + "px";
    el.style.height = "auto";
    el.style.color = annot.color || "#e53935";
    el.style.fontSize = fSize + "px";
    el.style.fontWeight = "500";
    el.style.textShadow = "0 0 3px rgba(255,255,255,0.9), 0 0 3px rgba(255,255,255,0.9)"; // 白色描边确保深色背景上可读
    const span = document.createElement("span");
    span.textContent = annot.text || "";
    el.appendChild(span);
  }

  // 右键菜单
  el.addEventListener("contextmenu", (ev) => {
    if (pdfViewState.annotTool) return;
    ev.preventDefault();
    ev.stopPropagation();
    showPdfAnnotContextMenu(ev.clientX, ev.clientY, annot.id);
  });

  // 双击编辑文字注释
  if (annot.type === "note") {
    el.addEventListener("dblclick", async (ev) => {
      if (pdfViewState.annotTool) return;
      ev.preventDefault();
      ev.stopPropagation();
      const newText = await _showAnnotNotePrompt(annot.text || "");
      if (newText !== null && newText.trim()) {
        _updatePdfAnnotation(annot.id, { text: newText.trim() });
      }
    });
  }

  // 删除按钮
  const del = document.createElement("span");
  del.className = "pdf-annot-delete";
  del.textContent = "×";
  del.title = "删除此标注";
  del.addEventListener("mousedown", (e) => { e.stopPropagation(); });
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    removePdfAnnotation(annot.id);
  });
  el.appendChild(del);

  // 拖动移动（非标注模式；删除按钮和手柄已 stopPropagation）
  el.addEventListener("mousedown", (ev) => {
    if (pdfViewState.annotTool) return;
    if (ev.button !== 0) return;
    // 点击在手柄或删除按钮上时不触发移动（它们已 stopPropagation）
    if (ev.target.classList.contains("pdf-annot-handle") || ev.target.classList.contains("pdf-annot-delete")) return;
    ev.preventDefault();
    ev.stopPropagation();
    const wrapper = el.closest(".pdf-page-wrapper");
    if (!wrapper) return;
    const pageNum = parseInt(wrapper.dataset.page, 10);
    pdfViewState.annotMoving = {
      id: annot.id,
      startMouseX: ev.clientX,
      startMouseY: ev.clientY,
      origCssLeft: parseFloat(el.style.left) || 0,
      origCssTop: parseFloat(el.style.top) || 0,
      el: el,
      pageNum: pageNum,
    };
    // 获取当前 viewport（缩放可能变化）
    if (pdfViewState.pdfDoc) {
      pdfViewState.pdfDoc.getPage(pageNum).then(page => {
        if (pdfViewState.annotMoving && pdfViewState.annotMoving.id === annot.id) {
          pdfViewState.annotMoving.viewport = page.getViewport({ scale: pdfViewState.scale });
        }
      });
    }
  });
  return el;
}

async function renderPdfAnnotsForPage(pageNum) {
  const wrapper = pdfViewState.renderedPages[pageNum];
  if (!wrapper) return;
  const layer = wrapper.querySelector(".pdf-annot-layer");
  if (!layer) return;
  layer.innerHTML = "";
  const docKey = _getCurrentPdfAnnotKey();
  if (!docKey) return;
  const annots = pdfViewState.annotList[docKey] || [];
  const pageAnnots = annots.filter(a => a.page === pageNum);
  if (pageAnnots.length === 0) return;
  if (!pdfViewState.pdfDoc) return;
  const page = await pdfViewState.pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: pdfViewState.scale });
  pageAnnots.forEach(annot => {
    layer.appendChild(_createAnnotElement(annot, viewport));
  });
}

async function renderAllPdfAnnots() {
  if (!pdfViewState.pdfDoc) return;
  const tasks = [];
  for (let p = 1; p <= pdfViewState.totalPages; p++) {
    tasks.push(renderPdfAnnotsForPage(p));
  }
  await Promise.all(tasks);
}

function startPdfAnnotDrag(ev, wrapper, pageNum, viewport) {
  const rect = wrapper.getBoundingClientRect();
  const startX = ev.clientX - rect.left;
  const startY = ev.clientY - rect.top;
  pdfViewState.annotDragging = true;
  pdfViewState.annotDragPage = pageNum;
  pdfViewState.annotDragViewport = viewport;
  pdfViewState.annotDragStart = { x: startX, y: startY };
  pdfViewState.annotDragEnd = { x: startX, y: startY };
  const tool = pdfViewState.annotTool;
  // 划线/箭头用直线预览，高亮/注释用矩形预览
  const previewClass = (tool === "underline" || tool === "arrow") ? "pdf-annot-drag-line" : "pdf-annot-drag-rect";
  let preview = wrapper.querySelector("." + previewClass);
  if (!preview) {
    preview = document.createElement("div");
    preview.className = previewClass;
    wrapper.appendChild(preview);
  }
  preview.style.display = "block";
  preview.style.left = startX + "px";
  preview.style.top = startY + "px";
  preview.style.width = "0px";
  if (tool === "underline" || tool === "arrow") {
    const lineW = pdfViewState.annotLineWidth || 2;
    preview.style.height = lineW + "px";
    preview.style.background = pdfViewState.annotLineColor;
    preview.style.transform = "rotate(0deg)";
    preview.style.transformOrigin = "0 0";
    if (pdfViewState.annotDash) {
      preview.style.backgroundImage = `linear-gradient(to right, ${pdfViewState.annotLineColor} 0%, ${pdfViewState.annotLineColor} ${lineW * 3}px, transparent ${lineW * 3}px, transparent ${lineW * 5}px)`;
      preview.style.backgroundSize = `${lineW * 5}px ${lineW}px`;
      preview.style.backgroundColor = "transparent";
    } else {
      preview.style.backgroundImage = "none";
      preview.style.backgroundColor = pdfViewState.annotLineColor;
    }
  } else {
    const borderW = (tool === "highlight") ? (pdfViewState.annotLineWidth || 2) : 2;
    preview.style.borderWidth = borderW + "px";
    preview.style.borderColor = pdfViewState.annotLineColor;
    preview.style.height = "0px";
  }
}

async function _finalizePdfAnnotation(tool, page, viewport, startX, startY, endX, endY) {
  // 将 CSS 像素两个端点转为 PDF 原生坐标（点，Y 自下而上）
  const [x1, y1] = viewport.convertToPdfPoint(startX, startY);
  let x2, y2;
  [x2, y2] = viewport.convertToPdfPoint(endX, endY);

  // 划线/箭头：自动水平/竖直校正
  if (tool === "underline" || tool === "arrow") {
    const snapped = _snapAngle(x1, y1, x2, y2);
    x2 = snapped.x2;
    y2 = snapped.y2;
  }

  let text = "";
  let fontSize = pdfViewState.annotFontSize;
  let textColor = pdfViewState.annotTextColor;
  if (tool === "note") {
    text = await _showAnnotNotePrompt("");
    if (text === null) return; // 用户取消
    if (!text) return;
  }

  const docKey = _getCurrentPdfAnnotKey();
  if (!docKey) return;
  if (!pdfViewState.annotList[docKey]) pdfViewState.annotList[docKey] = [];

  // 颜色：注释用文字色，其余用线条色
  const color = (tool === "note") ? textColor : pdfViewState.annotLineColor;

  const annot = {
    id: "annot_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
    type: tool,
    page: page,
    x1: x1, y1: y1, x2: x2, y2: y2,
    text: text,
    color: color,
    fontSize: fontSize,
    lineWidth: (tool === "underline" || tool === "arrow") ? pdfViewState.annotLineWidth : 2,
    dash: (tool === "underline" || tool === "arrow") ? pdfViewState.annotDash : false,
    createdAt: Date.now(),
  };
  _pushAnnotUndo(docKey);
  pdfViewState.annotList[docKey].push(annot);
  savePdfAnnotations(docKey);
  renderPdfAnnotsForPage(page);
}

function removePdfAnnotation(annotId) {
  const docKey = _getCurrentPdfAnnotKey();
  if (!docKey) return;
  const list = pdfViewState.annotList[docKey];
  if (!list) return;
  const idx = list.findIndex(a => a.id === annotId);
  if (idx < 0) return;
  const annot = list[idx];
  _pushAnnotUndo(docKey);
  list.splice(idx, 1);
  savePdfAnnotations(docKey);
  renderPdfAnnotsForPage(annot.page);
}

function clearPdfAnnotations() {
  const docKey = _getCurrentPdfAnnotKey();
  if (!docKey) return;
  const list = pdfViewState.annotList[docKey];
  if (!list || list.length === 0) {
    showError("当前文档暂无标注");
    return;
  }
  if (!window.confirm("确定清空当前文档的全部标注吗？可通过「撤回」恢复。")) return;
  _pushAnnotUndo(docKey);
  pdfViewState.annotList[docKey] = [];
  savePdfAnnotations(docKey);
  Object.values(pdfViewState.renderedPages).forEach(wrapper => {
    const layer = wrapper.querySelector(".pdf-annot-layer");
    if (layer) layer.innerHTML = "";
  });
  _updateAnnotUndoRedoBtns(docKey);
}

async function exportPdfWithAnnotations() {
  if (!pdfViewState.pdfDoc) {
    showError("请先打开一个 PDF 文档");
    return;
  }
  const docKey = _getCurrentPdfAnnotKey();
  const annots = (docKey && pdfViewState.annotList[docKey]) || [];
  if (annots.length === 0) {
    showError("当前文档尚无标注，无需导出");
    return;
  }
  const exportBtn = document.getElementById("pdf-annot-export");
  const exportSpan = exportBtn ? exportBtn.querySelector("span") : null;
  const origText = exportSpan ? exportSpan.textContent : "";
  if (exportBtn) { exportBtn.disabled = true; if (exportSpan) exportSpan.textContent = "导出中..."; }
  try {
    const idx = pdfViewState.currentDocIdx;
    const it = kanbanState.documents.find(d => d.idx === idx);
    if (!it) throw new Error("未找到文档信息");
    const isUS = currentData.office === "US";
    const urlDocNum = isUS ? currentData.applicationNumber : encodeURIComponent(currentData.docNumber || currentData.applicationNumber);
    const encodedDocId = encodeURIComponent(it.docId);
    const pdfUrl = `/api/gd/doc-content/svc/doccontent/${currentData.office}/${urlDocNum}/${encodedDocId}/${it.numberOfPages}/${it.docFormat}`;
    const resp = await fetch(pdfUrl, { headers: { "Accept": "application/pdf,*/*" } });
    if (!resp.ok) throw new Error("PDF 下载失败: HTTP " + resp.status);
    const pdfBytes = await resp.arrayBuffer();
    const patentNum = (currentData && (currentData.raw || currentData.applicationNumber || currentData.docNumber)) || "patent";
    const docTitle = (it.name || it.docDesc || it.documentDescription || it.description || it.docId || ("doc_" + idx));

    // Electron 环境：通过 IPC 委托主进程导出（主进程有 fontkit，可靠）
    if (window.electronAPI && typeof window.electronAPI.exportPdfWithAnnotations === "function") {
      const result = await window.electronAPI.exportPdfWithAnnotations({
        pdfBytes: pdfBytes,
        annots: annots,
        patentNum: patentNum,
        docTitle: docTitle,
      });
      if (!result || !result.success) throw new Error(result.error || "主进程导出失败");
      const out = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
      const blob = new Blob([out], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const safeName = (patentNum + "_" + docTitle).replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
      a.download = safeName + ".pdf";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      if (exportBtn) { exportBtn.disabled = false; if (exportSpan) exportSpan.textContent = origText; }
      return;
    }

    // 浏览器环境：客户端导出（依赖 window.fontkit UMD）
    if (typeof window.PDFLib === "undefined") {
      throw new Error("PDF 导出库（pdf-lib）未加载");
    }
    const { PDFDocument, rgb } = window.PDFLib;
    const pdfDoc = await PDFDocument.load(pdfBytes);

    if (window.fontkit) {
      pdfDoc.registerFontkit(window.fontkit);
    } else {
      console.warn("[PDF导出] fontkit 未加载，中文注释文字将无法导出");
    }
    const pages = pdfDoc.getPages();

    let cjkFont = null;
    const hasNoteText = annots.some(a => a.type === "note" && a.text);
    if (hasNoteText) {
      try {
        const fontResp = await fetch("/fonts/NotoSansSC-Regular.ttf");
        if (fontResp.ok) {
          const fontBytes = await fontResp.arrayBuffer();
          cjkFont = await pdfDoc.embedFont(fontBytes, { subset: true });
        } else {
          console.warn("[PDF导出] 字体加载失败 HTTP " + fontResp.status + "，注释文字将无法导出");
        }
      } catch (e) { console.warn("[PDF导出] 字体加载异常:", e); }
    }

    annots.forEach(annot => {
      const page = pages[annot.page - 1];
      if (!page) return;
      const c = _hexToRgb(annot.color);
      const col = rgb(c.r / 255, c.g / 255, c.b / 255);
      const lineW = annot.lineWidth || 2;

      // Helper: draw a line (supports dash)
      const drawStyledLine = (x1, y1, x2, y2, thickness, isDash) => {
        if (!isDash) {
          page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: thickness, color: col });
          return;
        }
        // Draw dashed line as segments
        const dx = x2 - x1;
        const dy = y2 - y1;
        const totalLen = Math.sqrt(dx * dx + dy * dy);
        const dashLen = thickness * 3;
        const gapLen = thickness * 2;
        const cycleLen = dashLen + gapLen;
        if (totalLen < 1) return;
        const ux = dx / totalLen;
        const uy = dy / totalLen;
        let pos = 0;
        while (pos < totalLen) {
          const segStart = pos;
          const segEnd = Math.min(pos + dashLen, totalLen);
          page.drawLine({
            start: { x: x1 + ux * segStart, y: y1 + uy * segStart },
            end: { x: x1 + ux * segEnd, y: y1 + uy * segEnd },
            thickness: thickness, color: col,
          });
          pos += cycleLen;
        }
      };

      if (annot.type === "highlight") {
        const x1 = Math.min(annot.x1, annot.x2);
        const x2 = Math.max(annot.x1, annot.x2);
        const y1 = Math.min(annot.y1, annot.y2);
        const y2 = Math.max(annot.y1, annot.y2);
        page.drawRectangle({
          x: x1, y: y1, width: x2 - x1, height: y2 - y1,
          borderColor: col, borderWidth: lineW,
          color: col, opacity: 0.12,
        });
      } else if (annot.type === "underline") {
        drawStyledLine(annot.x1, annot.y1, annot.x2, annot.y2, lineW, annot.dash);
      } else if (annot.type === "arrow") {
        drawStyledLine(annot.x1, annot.y1, annot.x2, annot.y2, lineW, annot.dash);
        const angle = Math.atan2(annot.y2 - annot.y1, annot.x2 - annot.x1);
        const headLen = 6 + lineW * 2;
        const headAngle = 0.4;
        const hx1 = annot.x2 - headLen * Math.cos(angle - headAngle);
        const hy1 = annot.y2 - headLen * Math.sin(angle - headAngle);
        const hx2 = annot.x2 - headLen * Math.cos(angle + headAngle);
        const hy2 = annot.y2 - headLen * Math.sin(angle + headAngle);
        // Arrow head is always solid
        page.drawLine({ start: { x: annot.x2, y: annot.y2 }, end: { x: hx1, y: hy1 }, thickness: lineW, color: col });
        page.drawLine({ start: { x: annot.x2, y: annot.y2 }, end: { x: hx2, y: hy2 }, thickness: lineW, color: col });
      } else if (annot.type === "note") {
        if (annot.text && cjkFont) {
          const fontSize = annot.fontSize || 14;
          const pdfLeft = Math.min(annot.x1, annot.x2);
          const pdfRight = Math.max(annot.x1, annot.x2);
          const pdfBottom = Math.min(annot.y1, annot.y2);
          const pdfTop = Math.max(annot.y1, annot.y2);
          const maxWidth = Math.max(40, pdfRight - pdfLeft);
          const lines = annot.text.split("\n");
          const lineHeight = fontSize * 1.3;
          let curY = pdfTop - fontSize * 0.85;
          for (let li = 0; li < lines.length; li++) {
            if (curY < pdfBottom) break;
            try {
              page.drawText(lines[li], {
                x: pdfLeft, y: curY,
                size: fontSize, font: cjkFont,
                color: col, maxWidth: maxWidth,
              });
            } catch (e) { /* 无法编码的字符跳过 */ }
            curY -= lineHeight;
          }
        }
      }
    });

    const out = await pdfDoc.save();
    const blob = new Blob([out], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safeName = (patentNum + "_" + docTitle).replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
    a.download = safeName + ".pdf";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    showError("导出失败: " + (e.message || e));
  } finally {
    if (exportBtn) { exportBtn.disabled = false; if (exportSpan) exportSpan.textContent = origText; }
  }
}

function highlightPdfBlock(blockId) {
  document.querySelectorAll(".pdf-block-overlay.highlight").forEach(el => el.classList.remove("highlight"));
  const overlay = readerPdfContainer.querySelector(`.pdf-block-overlay[data-block-id="${blockId}"]`);
  if (overlay) {
    overlay.classList.add("highlight");
    overlay.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => overlay.classList.remove("highlight"), 3000);
  }
}

function clearPdfBlockSelection() {
  pdfViewState.selectedBlockIds = [];
  document.querySelectorAll(".pdf-block-overlay.block-selected").forEach(el => el.classList.remove("block-selected"));
  document.querySelectorAll(".pdf-block-overlay.block-preview").forEach(el => el.classList.remove("block-preview"));
  updatePdfSelectionInfo();
}

function refreshPdfBlockSelectionVisual() {
  document.querySelectorAll(".pdf-block-overlay").forEach(el => {
    const bid = el.dataset.blockId;
    if (pdfViewState.selectedBlockIds.includes(bid)) {
      el.classList.add("block-selected");
    } else {
      el.classList.remove("block-selected");
    }
    el.classList.remove("block-preview");
  });
}

function refreshPdfBoxSelectionVisual(left, top, width, height, page) {
  const wrapper = pdfViewState.renderedPages[page];
  if (!wrapper) return;
  const overlays = wrapper.querySelectorAll(".pdf-block-overlay");
  overlays.forEach(el => {
    const bx = parseFloat(el.style.left);
    const by = parseFloat(el.style.top);
    const bw = parseFloat(el.style.width);
    const bh = parseFloat(el.style.height);
    const cx = bx + bw / 2;
    const cy = by + bh / 2;
    const inside = cx >= left && cx <= left + width && cy >= top && cy <= top + height;
    if (inside) {
      el.classList.add("block-preview");
    } else {
      el.classList.remove("block-preview");
    }
  });
}

function selectBlocksInRect(left, top, width, height, page) {
  const wrapper = pdfViewState.renderedPages[page];
  if (!wrapper) return;
  const overlays = wrapper.querySelectorAll(".pdf-block-overlay");
  overlays.forEach(el => {
    const bx = parseFloat(el.style.left);
    const by = parseFloat(el.style.top);
    const bw = parseFloat(el.style.width);
    const bh = parseFloat(el.style.height);
    const cx = bx + bw / 2;
    const cy = by + bh / 2;
    const inside = cx >= left && cx <= left + width && cy >= top && cy <= top + height;
    if (inside) {
      const bid = el.dataset.blockId;
      if (!pdfViewState.selectedBlockIds.includes(bid)) {
        pdfViewState.selectedBlockIds.push(bid);
      }
    }
  });
  refreshPdfBlockSelectionVisual();
  updatePdfSelectionInfo();
}

function updatePdfSelectionInfo() {
  const info = document.getElementById("pdf-selection-info");
  if (!info) return;
  const n = pdfViewState.selectedBlockIds.length;
  info.textContent = n > 0 ? `已选 ${n} 块` : "";
  info.classList.toggle("hidden", n === 0);
  const clearBtn = document.getElementById("pdf-clear-selection-btn");
  if (clearBtn) {
    clearBtn.style.display = n > 0 ? "" : "none";
  }
  const translateSelBtn = document.getElementById("pdf-translate-selection-btn");
  if (translateSelBtn) {
    translateSelBtn.style.display = n > 0 ? "" : "none";
  }
}

// 右键菜单
let _pdfCtxMenu = null;

function showPdfBlockContextMenu(clientX, clientY, blockId) {
  hidePdfBlockContextMenu();
  const menu = document.createElement("div");
  menu.className = "pdf-block-context-menu";
  menu.style.left = clientX + "px";
  menu.style.top = clientY + "px";

  const n = pdfViewState.selectedBlockIds.length;
  const translateAllItem = document.createElement("div");
  translateAllItem.className = "pdf-ctx-menu-item";
  translateAllItem.textContent = n > 1 ? `翻译已选 ${n} 块` : "翻译此文本块";
  translateAllItem.addEventListener("click", () => {
    hidePdfBlockContextMenu();
    translateSelectedBlocks();
  });
  menu.appendChild(translateAllItem);

  if (n > 0) {
    const clearItem = document.createElement("div");
    clearItem.className = "pdf-ctx-menu-item";
    clearItem.textContent = "清除选择";
    clearItem.addEventListener("click", () => {
      hidePdfBlockContextMenu();
      clearPdfBlockSelection();
    });
    menu.appendChild(clearItem);
  }

  document.body.appendChild(menu);
  _pdfCtxMenu = menu;

  // 菜单显示后如果超出视口，向左/上调整
  const r = menu.getBoundingClientRect();
  const maxX = window.innerWidth - 16;
  const maxY = window.innerHeight - 16;
  if (r.right > maxX) menu.style.left = (maxX - r.width) + "px";
  if (r.bottom > maxY) menu.style.top = (maxY - r.height) + "px";
}

function hidePdfBlockContextMenu() {
  if (_pdfCtxMenu && _pdfCtxMenu.parentNode) {
    _pdfCtxMenu.parentNode.removeChild(_pdfCtxMenu);
  }
  _pdfCtxMenu = null;
}

let _pdfAnnotCtxMenu = null;

function _findPdfAnnotationById(annotId) {
  const docKey = _getCurrentPdfAnnotKey();
  if (!docKey) return null;
  const list = pdfViewState.annotList[docKey] || [];
  return list.find(a => a.id === annotId) || null;
}

function _updatePdfAnnotation(annotId, updates) {
  const docKey = _getCurrentPdfAnnotKey();
  if (!docKey) return;
  const list = pdfViewState.annotList[docKey] || [];
  const annot = list.find(a => a.id === annotId);
  if (!annot) return;
  _pushAnnotUndo(docKey);
  Object.assign(annot, updates);
  savePdfAnnotations(docKey);
  renderPdfAnnotsForPage(annot.page);
}

function showPdfAnnotContextMenu(clientX, clientY, annotId) {
  hidePdfAnnotContextMenu();
  hidePdfBlockContextMenu();

  const annot = _findPdfAnnotationById(annotId);
  if (!annot) return;

  const menu = document.createElement("div");
  menu.className = "pdf-block-context-menu";
  menu.style.left = clientX + "px";
  menu.style.top = clientY + "px";

  // 颜色选择
  const colorItem = document.createElement("div");
  colorItem.className = "pdf-ctx-menu-item";
  colorItem.style.display = "flex";
  colorItem.style.alignItems = "center";
  colorItem.style.gap = "8px";
  colorItem.innerHTML = '<span>颜色</span>';
  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.value = annot.color || "#e53935";
  colorInput.style.width = "28px";
  colorInput.style.height = "22px";
  colorInput.style.border = "none";
  colorInput.style.padding = "0";
  colorInput.style.cursor = "pointer";
  colorInput.addEventListener("click", (e) => e.stopPropagation());
  colorInput.addEventListener("input", (e) => {
    _updatePdfAnnotation(annotId, { color: e.target.value });
  });
  colorItem.appendChild(colorInput);
  menu.appendChild(colorItem);

  // 字号（仅注释类型）
  if (annot.type === "note") {
    // 编辑文字
    const editTextItem = document.createElement("div");
    editTextItem.className = "pdf-ctx-menu-item";
    editTextItem.textContent = "编辑文字...";
    editTextItem.addEventListener("click", async () => {
      hidePdfAnnotContextMenu();
      const newText = await _showAnnotNotePrompt(annot.text || "");
      if (newText !== null && newText.trim()) {
        _updatePdfAnnotation(annotId, { text: newText.trim() });
      }
    });
    menu.appendChild(editTextItem);

    const fontSizeItem = document.createElement("div");
    fontSizeItem.className = "pdf-ctx-menu-item";
    fontSizeItem.style.display = "flex";
    fontSizeItem.style.alignItems = "center";
    fontSizeItem.style.gap = "8px";
    fontSizeItem.innerHTML = '<span>字号</span>';
    const fontSizeSel = document.createElement("select");
    fontSizeSel.className = "pdf-select-sm";
    [10, 12, 14, 16, 18, 20, 24].forEach(s => {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s + "px";
      if ((annot.fontSize || 14) === s) opt.selected = true;
      fontSizeSel.appendChild(opt);
    });
    fontSizeSel.addEventListener("click", (e) => e.stopPropagation());
    fontSizeSel.addEventListener("change", (e) => {
      _updatePdfAnnotation(annotId, { fontSize: parseInt(e.target.value, 10) || 14 });
    });
    fontSizeItem.appendChild(fontSizeSel);
    menu.appendChild(fontSizeItem);
  }

  // 线条粗细（划线/箭头/高亮）
  if (annot.type === "underline" || annot.type === "arrow" || annot.type === "highlight") {
    const lineWidthItem = document.createElement("div");
    lineWidthItem.className = "pdf-ctx-menu-item";
    lineWidthItem.style.display = "flex";
    lineWidthItem.style.alignItems = "center";
    lineWidthItem.style.gap = "8px";
    lineWidthItem.innerHTML = '<span>粗细</span>';
    const lineWidthSel = document.createElement("select");
    lineWidthSel.className = "pdf-select-sm";
    [1, 1.5, 2, 3, 4].forEach(w => {
      const opt = document.createElement("option");
      opt.value = w;
      opt.textContent = w + "px";
      if ((annot.lineWidth || 2) === w) opt.selected = true;
      lineWidthSel.appendChild(opt);
    });
    lineWidthSel.addEventListener("click", (e) => e.stopPropagation());
    lineWidthSel.addEventListener("change", (e) => {
      _updatePdfAnnotation(annotId, { lineWidth: parseFloat(e.target.value) || 2 });
    });
    lineWidthItem.appendChild(lineWidthSel);
    menu.appendChild(lineWidthItem);
  }

  // 虚线切换（仅划线/箭头）
  if (annot.type === "underline" || annot.type === "arrow") {
    const dashItem = document.createElement("div");
    dashItem.className = "pdf-ctx-menu-item";
    dashItem.style.display = "flex";
    dashItem.style.alignItems = "center";
    dashItem.style.gap = "8px";
    const dashCheck = document.createElement("input");
    dashCheck.type = "checkbox";
    dashCheck.id = "ctx-annot-dash-" + annotId;
    dashCheck.checked = !!annot.dash;
    dashCheck.addEventListener("click", (e) => e.stopPropagation());
    dashCheck.addEventListener("change", (e) => {
      _updatePdfAnnotation(annotId, { dash: e.target.checked });
    });
    const dashLabel = document.createElement("label");
    dashLabel.htmlFor = dashCheck.id;
    dashLabel.textContent = "虚线";
    dashLabel.style.cursor = "pointer";
    dashItem.appendChild(dashCheck);
    dashItem.appendChild(dashLabel);
    menu.appendChild(dashItem);
  }

  // 分隔线
  const sep = document.createElement("div");
  sep.style.height = "1px";
  sep.style.background = "rgba(0,0,0,0.1)";
  sep.style.margin = "4px 0";
  menu.appendChild(sep);

  // 删除标注
  const delItem = document.createElement("div");
  delItem.className = "pdf-ctx-menu-item";
  delItem.style.color = "#e53935";
  delItem.textContent = "删除此标注";
  delItem.addEventListener("click", () => {
    hidePdfAnnotContextMenu();
    removePdfAnnotation(annotId);
  });
  menu.appendChild(delItem);

  document.body.appendChild(menu);
  _pdfAnnotCtxMenu = menu;

  // 调整菜单位置避免超出视口
  const r = menu.getBoundingClientRect();
  const maxX = window.innerWidth - 16;
  const maxY = window.innerHeight - 16;
  if (r.right > maxX) menu.style.left = (maxX - r.width) + "px";
  if (r.bottom > maxY) menu.style.top = (maxY - r.height) + "px";
}

function hidePdfAnnotContextMenu() {
  if (_pdfAnnotCtxMenu && _pdfAnnotCtxMenu.parentNode) {
    _pdfAnnotCtxMenu.parentNode.removeChild(_pdfAnnotCtxMenu);
  }
  _pdfAnnotCtxMenu = null;
}

document.addEventListener("mousedown", (ev) => {
  if (_pdfAnnotCtxMenu && !_pdfAnnotCtxMenu.contains(ev.target)) {
    hidePdfAnnotContextMenu();
  }
});
document.addEventListener("scroll", () => hidePdfAnnotContextMenu(), true);
window.addEventListener("resize", () => hidePdfAnnotContextMenu());

document.addEventListener("mousedown", (ev) => {
  if (_pdfCtxMenu && !_pdfCtxMenu.contains(ev.target)) {
    hidePdfBlockContextMenu();
  }
});
document.addEventListener("scroll", () => hidePdfBlockContextMenu(), true);
window.addEventListener("resize", () => hidePdfBlockContextMenu());

// Right-click context menu for patent detail view
if (patentDetailContent) {
  patentDetailContent.addEventListener("contextmenu", (ev) => {
    // Determine which section was right-clicked
    let targetSection = "";
    const claimsEl = ev.target.closest('[data-section-type="claims"]');
    const descEl = ev.target.closest('[data-section-type="description"]');
    if (claimsEl) {
      targetSection = "claims";
    } else if (descEl) {
      targetSection = "description";
    }

    // Only show context menu if we're in a translatable area
    if (targetSection || window.getSelection().toString().trim()) {
      ev.preventDefault();
      showPatentDetailContextMenu(ev.clientX, ev.clientY, targetSection);
    }
  });
}

// Close patent detail context menu on click outside or scroll
document.addEventListener("mousedown", (ev) => {
  if (_patentDetailCtxMenu && !_patentDetailCtxMenu.contains(ev.target)) {
    hidePatentDetailContextMenu();
  }
});
document.addEventListener("scroll", () => hidePatentDetailContextMenu(), true);

// ===== PDF keyword search =====

function searchPdfKeyword() {
  const input = document.getElementById("pdf-search-input");
  if (!input) return;
  const keyword = input.value.trim().toLowerCase();
  if (!keyword) return;

  const idx = pdfViewState.currentDocIdx;
  if (idx == null) return;
  const ext = kanbanState.extractions[idx];
  if (!ext || !ext.blocks || ext.blocks.length === 0) {
    showError("请先提取文档内容（OCR提取）");
    return;
  }

  // Clear previous search highlights
  document.querySelectorAll(".pdf-block-overlay.pdf-search-match").forEach(el => el.classList.remove("pdf-search-match", "pdf-search-current"));
  pdfViewState.searchMatches = [];
  pdfViewState.searchCurrentIdx = -1;

  // Find matching blocks
  ext.blocks.forEach(b => {
    if (b.content && b.content.toLowerCase().includes(keyword)) {
      pdfViewState.searchMatches.push(b.block_id);
    }
  });

  const searchInfo = document.getElementById("pdf-search-info");
  if (pdfViewState.searchMatches.length === 0) {
    if (searchInfo) searchInfo.textContent = "0/0";
    return;
  }

  // Highlight all matches
  pdfViewState.searchMatches.forEach(id => {
    const overlay = readerPdfContainer.querySelector(`.pdf-block-overlay[data-block-id="${id}"]`);
    if (overlay) overlay.classList.add("pdf-search-match");
  });

  // Jump to first match
  pdfViewState.searchCurrentIdx = 0;
  const firstId = pdfViewState.searchMatches[0];
  const firstOverlay = readerPdfContainer.querySelector(`.pdf-block-overlay[data-block-id="${firstId}"]`);
  if (firstOverlay) {
    firstOverlay.classList.add("pdf-search-current");
    firstOverlay.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  updateSearchInfo();
}

function searchPdfNext() {
  if (pdfViewState.searchMatches.length === 0) {
    searchPdfKeyword();
    return;
  }

  // Remove current highlight
  document.querySelectorAll(".pdf-block-overlay.pdf-search-current").forEach(el => el.classList.remove("pdf-search-current"));

  pdfViewState.searchCurrentIdx = (pdfViewState.searchCurrentIdx + 1) % pdfViewState.searchMatches.length;
  const id = pdfViewState.searchMatches[pdfViewState.searchCurrentIdx];
  const overlay = readerPdfContainer.querySelector(`.pdf-block-overlay[data-block-id="${id}"]`);
  if (overlay) {
    overlay.classList.add("pdf-search-current");
    overlay.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  updateSearchInfo();
}

function searchPdfPrev() {
  if (pdfViewState.searchMatches.length === 0) return;

  // Remove current highlight
  document.querySelectorAll(".pdf-block-overlay.pdf-search-current").forEach(el => el.classList.remove("pdf-search-current"));

  pdfViewState.searchCurrentIdx = (pdfViewState.searchCurrentIdx - 1 + pdfViewState.searchMatches.length) % pdfViewState.searchMatches.length;
  const id = pdfViewState.searchMatches[pdfViewState.searchCurrentIdx];
  const overlay = readerPdfContainer.querySelector(`.pdf-block-overlay[data-block-id="${id}"]`);
  if (overlay) {
    overlay.classList.add("pdf-search-current");
    overlay.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  updateSearchInfo();
}

function updateSearchInfo() {
  const searchInfo = document.getElementById("pdf-search-info");
  if (searchInfo) searchInfo.textContent = `${pdfViewState.searchCurrentIdx + 1}/${pdfViewState.searchMatches.length}`;
  const prevBtn = document.getElementById("pdf-search-prev-btn");
  const nextBtn = document.getElementById("pdf-search-next-btn");
  if (prevBtn) prevBtn.disabled = pdfViewState.searchMatches.length === 0;
  if (nextBtn) nextBtn.disabled = pdfViewState.searchMatches.length === 0;
}

// ===== OCR extract button for single document =====

async function ocrPdf() {
  const idx = pdfViewState.currentDocIdx;
  if (idx == null) {
    showError("请先选择一个文档");
    return;
  }

  const it = kanbanState.documents.find(d => d.idx === idx);
  if (!it) {
    showError("找不到文档信息");
    return;
  }

  if (!currentData) { showError("请先查询专利"); return; }

  const config = window.AI.loadAIConfig();
  const ocrConfig = window.AI.getOCRConfig(config);
  const primaryEngine = ocrConfig.engine || "paddle_ocr_vl";
  const glmApiKey = window.AI.getGlmOcrApiKey(config);

  const isUS = currentData.office === "US";
  const urlDocNum = isUS ? currentData.applicationNumber : encodeURIComponent(currentData.docNumber || currentData.applicationNumber);

  const totalPages = it.numberOfPages ? parseInt(it.numberOfPages) : 0;

  // 标记该文档正在 OCR，设置当前显示的 OCR 任务
  _currentOcrJobIdx = idx;
  ocrJobs[idx] = { status: 'running', progress: 5, statusText: "正在下载 PDF 文档..." };

  // Show progress overlay with phase indicators
  showOcrProgressOverlay("正在下载 PDF 文档...", 5, idx);

  // Simulate download phase progress
  let downloadTimer = null;
  let downloadProgress = 5;
  if (totalPages > 0) {
    downloadTimer = setInterval(() => {
      if (downloadProgress < 30) {
        downloadProgress += 3;
        showOcrProgressOverlay("正在下载 PDF 文档...", downloadProgress, idx);
      }
    }, 500);
  }

  const MAX_RETRIES = 2;
  let success = false;

  async function tryExtract(engine, retriesLeft) {
    try {
      // Update progress to OCR phase
      if (downloadTimer) clearInterval(downloadTimer);
      showOcrProgressOverlay("正在 OCR 识别 (" + (engine === "paddle_ocr_vl" ? "PaddleOCR" : "GLM OCR") + ")...", 35, idx);

      // Simulate OCR phase progress
      let ocrTimer = null;
      let ocrProgress = 35;
      if (totalPages > 0) {
        ocrTimer = setInterval(() => {
          if (ocrProgress < 85) {
            ocrProgress += Math.max(1, Math.floor((85 - ocrProgress) * 0.08));
            showOcrProgressOverlay("正在 OCR 识别 (" + (engine === "paddle_ocr_vl" ? "PaddleOCR" : "GLM OCR") + ")... " + Math.round(ocrProgress * totalPages / 85) + "/" + totalPages + " 页", ocrProgress, idx);
          }
        }, 800);
      }

      const useApiKey = engine === "glm_ocr" ? glmApiKey : "";
      const result = await doExtractText(currentData.office, urlDocNum, it.docId, it.numberOfPages, it.docFormat, engine, useApiKey);

      if (ocrTimer) clearInterval(ocrTimer);

      if (result.error) {
        if (retriesLeft > 0) {
          const fallbackEngine = engine === "paddle_ocr_vl" ? "glm_ocr" : "paddle_ocr_vl";
          if (fallbackEngine === "glm_ocr" && !glmApiKey) return false;
          return await tryExtract(fallbackEngine, retriesLeft - 1);
        }
        showError("OCR 提取失败: " + result.error);
        return false;
      }
      const text = result.text || "";
      const markdown = result.markdown || "";
      if (!text && !markdown) {
        if (retriesLeft > 0) {
          const fallbackEngine = engine === "paddle_ocr_vl" ? "glm_ocr" : "paddle_ocr_vl";
          if (fallbackEngine === "glm_ocr" && !glmApiKey) return false;
          return await tryExtract(fallbackEngine, retriesLeft - 1);
        }
        showError("OCR 提取内容为空");
        return false;
      }
      showOcrProgressOverlay("正在解析 OCR 结果...", 90, idx);
      const blocks = result.blocks || [];
      const pageDimensions = result.page_dimensions || {};
      kanbanState.extractions[it.idx] = { text, markdown, engine: result.engine, blocks, pageDimensions };
      kanbanState.hasUnsavedWork = true;
      if (blocks.length > 0) {
        blocks.forEach(b => {
          const traceKey = "D" + it.idx + "_" + b.block_id;
          kanbanState.traceIndex[traceKey] = {
            docIdx: it.idx, page: b.page, bbox: b.bbox,
            content: b.content, label: b.label, originalBlockId: b.block_id,
            pageDimensions: pageDimensions[b.page] || null,
          };
        });
      }
      showOcrProgressOverlay("OCR 完成", 100, idx);
      // 如果当前仍在查看此文档，更新提取面板
      if (pdfViewState.currentDocIdx === idx) {
        updateExtractPanel();
      }
      autoSaveCache();
      return true;
    } catch (e) {
      if (retriesLeft > 0) {
        return await tryExtract(engine === "paddle_ocr_vl" ? "glm_ocr" : "paddle_ocr_vl", retriesLeft - 1);
      }
      showError("OCR 提取失败: " + e.message);
      return false;
    }
  }

  success = await tryExtract(primaryEngine, MAX_RETRIES);

  if (success) {
    const searchInput = document.getElementById("pdf-search-input");
    const searchBtn = document.getElementById("pdf-search-btn");
    if (searchInput) { searchInput.disabled = false; searchInput.placeholder = "搜索关键词..."; }
    if (searchBtn) searchBtn.disabled = false;
    // Re-render PDF with block overlays, preserving scroll position (only if current doc)
    if (pdfViewState.active && pdfViewState.currentDocIdx === idx) {
      const scrollTop = readerPdfContainer.scrollTop;
      const scrollRatio = readerPdfContainer.scrollHeight > 0 ? scrollTop / readerPdfContainer.scrollHeight : 0;
      await renderPdfView(idx);
      requestAnimationFrame(() => {
        const newScrollTop = Math.round(scrollRatio * readerPdfContainer.scrollHeight);
        readerPdfContainer.scrollTop = newScrollTop;
      });
    }
    // Hide OCR progress overlay (only affects UI if this is the current doc)
    hideOcrProgressOverlay(idx);
  } else {
    // Mark job as failed
    if (ocrJobs[idx]) ocrJobs[idx].status = 'error';
    hideOcrProgressOverlay(idx);
  }
}

// ===== PDF Translation =====

function _buildBlockText(blocks, rangeLabel) {
  const cleanOcrText = (text) => {
    return text
      .replace(/\$\s*\\Box\s*\$/g, '☐')
      .replace(/\$\s*\\surd\s*\$/g, '☑')
      .replace(/\$\s*\\§\s*(\d+)\s*\$/g, '§$1')
      .replace(/\$\s*\\[^$]+\$/g, '')
      .replace(/\$\{[^}]+\}/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  };
  const typeLabels = { title: "标题", table: "表格", formula: "公式", figure: "图注", caption: "说明" };
  const originalParts = [];
  blocks.forEach(b => {
    if (b.content && b.content.trim()) {
      const cleaned = cleanOcrText(b.content);
      if (!cleaned) return;
      const typeHint = typeLabels[b.label];
      if (typeHint) {
        originalParts.push(`[${typeHint}] ${cleaned}`);
      } else {
        originalParts.push(cleaned);
      }
    }
  });
  return originalParts.join("\n\n");
}

async function _doTranslateBlocks(idx, blocks, targetLang, langNames, cacheKey, loadingHint) {
  const config = window.AI.loadAIConfig();
  const translateProvider = window.AI.getTranslateProvider(config);
  if (!translateProvider || !translateProvider.apiKey) {
    if (pdfTranslateContent) {
      pdfTranslateContent.innerHTML = '<p class="placeholder" style="text-align:center;padding:40px 0;color:var(--danger);">请先在设置中配置 AI 服务的 API Key</p>';
    }
    return;
  }

  const text = _buildBlockText(blocks);
  if (!text.trim()) {
    if (pdfTranslateContent) {
      pdfTranslateContent.innerHTML = '<p class="placeholder">选中范围内无有效文字内容</p>';
    }
    return;
  }

  if (translatePageCache[cacheKey]) {
    renderTranslateContent(translatePageCache[cacheKey]);
    return;
  }

  if (pdfTranslateContent) {
    pdfTranslateContent.innerHTML = loadingHint || '<div class="pdf-translate-translating-hint">正在翻译，请稍候...</div>';
  }
  if (pdfTranslateBtn) { pdfTranslateBtn.textContent = "翻译中..."; pdfTranslateBtn.disabled = true; }
  translateAbortController = new AbortController();

  try {
    const systemPrompt = `你是一个专业的专利文档翻译专家。请将以下专利文档内容翻译为${langNames[targetLang] || "中文"}。

## 翻译规则

1. 原文中部分段落前标有[类型]标记，表示该段落的版面类型：
   - [标题]：文档标题、章节标题，翻译时保持简洁有力
   - [表格]：表格内容，保持行列结构，用 | 分隔各列
   - [公式]：数学公式或化学式，保留原始公式符号，仅翻译公式旁的文字说明
   - [图注]：图片说明文字，简洁翻译
   - [说明]：图表说明，准确翻译
   - 无标记的段落为正文，逐句准确翻译，保持技术术语一致性

2. 翻译时请去掉所有[类型]标记，直接输出翻译后的连续文档
3. 保持原文的段落结构，每个段落对应一段翻译
4. 只输出翻译结果，不要添加任何解释或注释
5. 如果原文已经是目标语言，则直接返回原文
6. 专利技术术语请使用该领域的标准译法
7. 原文中的☐表示空复选框，☑表示已勾选复选框，§表示条款号，请保留这些符号
8. 请将所有页面的内容整合翻译，输出完整连贯的译文`;

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ];

    let fullResponse = "";
    let _rafPending = false;
    if (pdfTranslateContent) pdfTranslateContent.innerHTML = '<div class="pdf-translate-result"></div>';
    const translateContainer = pdfTranslateContent ? pdfTranslateContent.querySelector(".pdf-translate-result") : null;
    const stream = window.AI.streamChat(translateProvider.type, translateProvider.apiKey, translateProvider.baseUrl, {
      model: translateProvider.model,
      messages: messages,
      temperature: 0.1,
      maxTokens: 16384,
    }, translateAbortController.signal);

    for await (const chunk of stream) {
      if (translateAbortController.signal.aborted) break;
      if (chunk.content) {
        fullResponse += chunk.content;
        if (!_rafPending) {
          _rafPending = true;
          requestAnimationFrame(() => {
            if (translateContainer) translateContainer.innerHTML = renderMarkdown(fullResponse);
            _rafPending = false;
          });
        }
      }
    }
    if (translateContainer) translateContainer.innerHTML = renderMarkdown(fullResponse);

    translatePageCache[cacheKey] = { translated: fullResponse };
    renderTranslateContent(translatePageCache[cacheKey]);

  } catch (e) {
    if (e.name !== "AbortError") {
      showError("翻译出错: " + e.message);
    }
  } finally {
    if (pdfTranslateBtn) { pdfTranslateBtn.textContent = "翻译全文档"; pdfTranslateBtn.disabled = false; }
    translateAbortController = null;
  }
}

async function translatePdfPage() {
  const idx = pdfViewState.currentDocIdx;
  if (idx == null) {
    showError("请先选择一个文档");
    return;
  }

  if (pdfTranslatePanel) pdfTranslatePanel.classList.remove("hidden");
  enterReadingMode("translate");
  if (pdfTranslateContent) {
    pdfTranslateContent.innerHTML = '<p class="placeholder" style="text-align:center;padding:40px 0;">准备中...</p>';
  }

  let extraction = kanbanState.extractions[idx];
  if (!extraction || !extraction.blocks || extraction.blocks.length === 0) {
    if (pdfTranslateBtn) { pdfTranslateBtn.textContent = "OCR中..."; pdfTranslateBtn.disabled = true; }
    if (pdfTranslateContent) {
      pdfTranslateContent.innerHTML = '<p class="placeholder" style="text-align:center;padding:40px 0;">正在 OCR 提取文字，请稍候...</p>';
    }
    await ocrPdf();
    extraction = kanbanState.extractions[idx];
    if (pdfTranslateBtn) { pdfTranslateBtn.textContent = "翻译中..."; pdfTranslateBtn.disabled = true; }
    if (!extraction || !extraction.blocks || extraction.blocks.length === 0) {
      if (pdfTranslateContent) {
        pdfTranslateContent.innerHTML = '<p class="placeholder" style="text-align:center;padding:40px 0;color:var(--danger);">OCR 提取失败，无法翻译</p>';
      }
      if (pdfTranslateBtn) { pdfTranslateBtn.textContent = "翻译全文档"; pdfTranslateBtn.disabled = false; }
      return;
    }
  }

  const config = window.AI.loadAIConfig();
  const translateProvider = window.AI.getTranslateProvider(config);
  if (!translateProvider || !translateProvider.apiKey) {
    if (pdfTranslateContent) {
      pdfTranslateContent.innerHTML = '<p class="placeholder" style="text-align:center;padding:40px 0;color:var(--danger);">请先在设置中配置 AI 服务的 API Key</p>';
    }
    if (pdfTranslateBtn) { pdfTranslateBtn.textContent = "翻译全文档"; pdfTranslateBtn.disabled = false; }
    return;
  }

  const targetLang = pdfTranslateLang ? pdfTranslateLang.value : (config.translate && config.translate.defaultLang) || "zh";
  const langNames = { zh: "中文", en: "English", ja: "日本語", ko: "한국어" };

  const allBlocks = extraction.blocks || [];
  if (allBlocks.length === 0) {
    if (pdfTranslateContent) {
      pdfTranslateContent.innerHTML = '<p class="placeholder">当前文档无 OCR 文字内容</p>';
    }
    return;
  }

  const cacheKey = `${idx}_${targetLang}_full`;
  await _doTranslateBlocks(idx, allBlocks, targetLang, langNames, cacheKey, '<div class="pdf-translate-translating-hint">正在翻译全文，请稍候...</div>');
}

async function translateSelectedBlocks() {
  const idx = pdfViewState.currentDocIdx;
  if (idx == null) {
    showError("请先选择一个文档");
    return;
  }

  if (pdfViewState.selectedBlockIds.length === 0) {
    showError("请先在 PDF 中选中要翻译的文本块");
    return;
  }

  if (pdfTranslatePanel) pdfTranslatePanel.classList.remove("hidden");
  enterReadingMode("translate");
  if (pdfTranslateContent) {
    pdfTranslateContent.innerHTML = '<p class="placeholder" style="text-align:center;padding:40px 0;">准备中...</p>';
  }

  let extraction = kanbanState.extractions[idx];
  if (!extraction || !extraction.blocks || extraction.blocks.length === 0) {
    if (pdfTranslateContent) {
      pdfTranslateContent.innerHTML = '<p class="placeholder" style="text-align:center;padding:40px 0;">正在 OCR 提取文字，请稍候...</p>';
    }
    await ocrPdf();
    extraction = kanbanState.extractions[idx];
    if (!extraction || !extraction.blocks || extraction.blocks.length === 0) {
      if (pdfTranslateContent) {
        pdfTranslateContent.innerHTML = '<p class="placeholder" style="text-align:center;padding:40px 0;color:var(--danger);">OCR 提取失败，无法翻译</p>';
      }
      return;
    }
  }

  const config = window.AI.loadAIConfig();
  const translateProvider = window.AI.getTranslateProvider(config);
  if (!translateProvider || !translateProvider.apiKey) {
    if (pdfTranslateContent) {
      pdfTranslateContent.innerHTML = '<p class="placeholder" style="text-align:center;padding:40px 0;color:var(--danger);">请先在设置中配置 AI 服务的 API Key</p>';
    }
    return;
  }

  const targetLang = pdfTranslateLang ? pdfTranslateLang.value : (config.translate && config.translate.defaultLang) || "zh";
  const langNames = { zh: "中文", en: "English", ja: "日本語", ko: "한국어" };

  // 按 block 出现顺序保留选中的 blocks
  const idSet = new Set(pdfViewState.selectedBlockIds);
  const selectedBlocks = (extraction.blocks || []).filter(b => idSet.has(b.block_id));
  if (selectedBlocks.length === 0) {
    if (pdfTranslateContent) {
      pdfTranslateContent.innerHTML = '<p class="placeholder">选中的文本块无有效内容</p>';
    }
    return;
  }

  const sortedIds = pdfViewState.selectedBlockIds.slice().sort().join(",");
  const cacheKey = `${idx}_${targetLang}_sel_${sortedIds}`;
  const loadingHint = `<div class="pdf-translate-translating-hint">正在翻译已选 ${selectedBlocks.length} 个文本块，请稍候...</div>`;
  await _doTranslateBlocks(idx, selectedBlocks, targetLang, langNames, cacheKey, loadingHint);
}

function renderTranslateContent(data) {
  if (!pdfTranslateContent) return;
  pdfTranslateContent.innerHTML = `<div class="pdf-translate-result">${renderMarkdown(data.translated)}</div>`;
  pdfTranslateContent.scrollTop = 0;
}

// ===== Reading Mode Management =====

function enterReadingMode(activePanel) {
  const readerBody = document.querySelector(".reader-body");
  const rightPanel = document.getElementById("reader-right-panel");
  if (readerBody) readerBody.classList.add("reading-mode");
  if (rightPanel) rightPanel.classList.remove("hidden");
  // Tuck floating ball to the right when panel is open
  if (readerFloatingBall) readerFloatingBall.classList.add("tucked");
  // Switch to the specified panel tab
  if (activePanel) {
    switchRightPanelTab(activePanel);
  }
}

function exitReadingMode() {
  const readerBody = document.querySelector(".reader-body");
  const rightPanel = document.getElementById("reader-right-panel");
  const extractPanel = document.getElementById("reader-extract-panel");
  const translatePanel = document.getElementById("pdf-translate-panel");
  const chatPanel = document.getElementById("reader-chat-panel");
  // Hide all panels
  if (extractPanel) extractPanel.classList.add("hidden");
  if (translatePanel) translatePanel.classList.add("hidden");
  if (chatPanel) chatPanel.classList.add("hidden");
  if (readerBody) readerBody.classList.remove("reading-mode");
  // Restore floating ball position
  if (readerFloatingBall) readerFloatingBall.classList.remove("tucked");
  if (rightPanel) rightPanel.classList.add("hidden");
  // Deactivate chat toggle button
  if (readerChatToggle) readerChatToggle.classList.remove("active");
}

function switchRightPanelTab(panelName) {
  const extractPanel = document.getElementById("reader-extract-panel");
  const translatePanel = document.getElementById("pdf-translate-panel");
  const chatPanel = document.getElementById("reader-chat-panel");
  const tabs = document.querySelectorAll(".right-panel-tab");

  // Update tab active states
  tabs.forEach(tab => {
    tab.classList.toggle("active", tab.dataset.panel === panelName);
  });

  // Show/hide panels
  if (extractPanel) extractPanel.classList.add("hidden");
  if (translatePanel) translatePanel.classList.add("hidden");
  if (chatPanel) chatPanel.classList.add("hidden");

  if (panelName === "extract") {
    if (extractPanel) extractPanel.classList.remove("hidden");
    updateExtractPanel();
  } else if (panelName === "translate") {
    if (translatePanel) translatePanel.classList.remove("hidden");
  } else if (panelName === "chat") {
    if (chatPanel) chatPanel.classList.remove("hidden");
  }
}

// Update the extract panel content for the current document
function updateExtractPanel() {
  const contentEl = document.getElementById("reader-extract-content");
  if (!contentEl) return;
  const idx = pdfViewState.currentDocIdx;
  const ext = kanbanState.extractions ? kanbanState.extractions[idx] : null;
  if (!ext || (!ext.text && !ext.markdown)) {
    contentEl.innerHTML = '<p class="placeholder">该文档尚未进行 OCR 提取</p>';
    return;
  }
  const text = ext.markdown || ext.text || "";
  if (!text.trim()) {
    contentEl.innerHTML = '<p class="placeholder">该文档尚未进行 OCR 提取</p>';
    return;
  }
  // Show blocks info if available
  let blocksInfo = "";
  if (ext.blocks && ext.blocks.length > 0) {
    blocksInfo = `<div class="extract-blocks-info">共 ${ext.blocks.length} 个文本块</div>`;
  }

  // Split by page separator (---) and render with page dividers
  const pages = text.split(/\n\n---\n\n/);
  let html = blocksInfo;
  pages.forEach((pageText, i) => {
    if (i > 0) {
      // Page divider - not selectable for copy
      html += '<div class="extract-page-divider" data-extract-page="' + (i + 1) + '"><span>第 ' + (i + 1) + ' 页</span></div>';
    } else {
      // First page divider (subtle)
      html += '<div class="extract-page-divider extract-page-divider-first" data-extract-page="1"><span>第 1 页</span></div>';
    }
    if (pageText.trim()) {
      html += '<div class="extract-page-content" data-extract-page="' + (i + 1) + '">' + renderMarkdown(pageText) + '</div>';
    }
  });

  contentEl.innerHTML = html;
}

// Navigate extract panel to the page containing a given OCR block
function navigateExtractPanelToBlock(block) {
  const extractPanel = document.getElementById("reader-extract-panel");
  if (!extractPanel) return;

  // Switch to extract panel if not already visible
  if (extractPanel.classList.contains("hidden")) {
    switchRightPanelTab("extract");
  }

  const contentEl = document.getElementById("reader-extract-content");
  if (!contentEl) return;

  const page = block.page;
  if (!page) return;

  // Scroll to the corresponding page divider or content
  const target = contentEl.querySelector('[data-extract-page="' + page + '"]');
  if (target) {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

// Sync extract panel scroll position to match the currently visible PDF page
function syncExtractPanelToPdfPage() {
  const extractPanel = document.getElementById("reader-extract-panel");
  if (!extractPanel || extractPanel.classList.contains("hidden")) return;

  // Determine the currently visible PDF page
  const containerRect = readerPdfContainer.getBoundingClientRect();
  const viewTop = containerRect.top + containerRect.height * 0.3; // 30% from top as reference point
  let currentPage = 1;
  let minDist = Infinity;

  for (let p = 1; p <= pdfViewState.totalPages; p++) {
    const wrapper = pdfViewState.renderedPages[p];
    if (!wrapper) continue;
    const rect = wrapper.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    const dist = Math.abs(mid - viewTop);
    if (dist < minDist) {
      minDist = dist;
      currentPage = p;
    }
  }

  pdfViewState.currentPage = currentPage;
  updatePdfToolbar();

  // Sync extract panel to the same page
  const contentEl = document.getElementById("reader-extract-content");
  if (!contentEl) return;
  const target = contentEl.querySelector('[data-extract-page="' + currentPage + '"]');
  if (target) {
    // Only scroll if the target is not already in view
    const contentRect = contentEl.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    if (targetRect.top < contentRect.top || targetRect.bottom > contentRect.bottom) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
}

// ── OCR 提取内容栏右键菜单：选中翻译 + 悬浮窗 ──
let _extractCtxMenu = null;

function showExtractContextMenu(clientX, clientY) {
  hideExtractContextMenu();
  const sel = window.getSelection();
  const selectedText = sel ? sel.toString().trim() : "";
  if (!selectedText) return;

  const menu = document.createElement("div");
  menu.className = "pdf-block-context-menu";
  menu.style.left = clientX + "px";
  menu.style.top = clientY + "px";

  const translateItem = document.createElement("div");
  translateItem.className = "pdf-ctx-menu-item";
  translateItem.textContent = "翻译选中文本";
  translateItem.addEventListener("click", () => {
    hideExtractContextMenu();
    translateSelectedPatentText(selectedText, null);
  });
  menu.appendChild(translateItem);

  document.body.appendChild(menu);
  _extractCtxMenu = menu;

  const r = menu.getBoundingClientRect();
  const maxX = window.innerWidth - 16;
  const maxY = window.innerHeight - 16;
  if (r.right > maxX) menu.style.left = (maxX - r.width) + "px";
  if (r.bottom > maxY) menu.style.top = (maxY - r.height) + "px";
}

function hideExtractContextMenu() {
  if (_extractCtxMenu && _extractCtxMenu.parentNode) {
    _extractCtxMenu.parentNode.removeChild(_extractCtxMenu);
  }
  _extractCtxMenu = null;
}

// 绑定右键菜单到提取内容栏（事件委托，兼容动态内容和动态创建的面板）
document.addEventListener("contextmenu", (ev) => {
  const extractPanel = ev.target.closest("#reader-extract-content");
  if (!extractPanel) return;
  const sel = window.getSelection();
  const selectedText = sel ? sel.toString().trim() : "";
  if (selectedText) {
    ev.preventDefault();
    ev.stopPropagation();
    showExtractContextMenu(ev.clientX, ev.clientY);
  }
});
// 点击其他地方关闭右键菜单
document.addEventListener("mousedown", (ev) => {
  if (_extractCtxMenu && !_extractCtxMenu.contains(ev.target)) {
    hideExtractContextMenu();
  }
}, true);
document.addEventListener("scroll", () => hideExtractContextMenu(), true);

// ===== Open reader for specific document from kanban =====

function openReaderForDoc(idx, defaultToPdf) {
  // Set the correct doc index before opening to avoid rendering the wrong document
  pdfViewState.currentDocIdx = idx;
  openReader(defaultToPdf, true); // skipRender=true — selectReaderDoc will handle the render
  // Select the document after reader opens
  setTimeout(() => {
    selectReaderDoc(idx);
    if (defaultToPdf && !pdfViewState.active) {
      togglePdfView();
    }
  }, 100);
}

// ============ 浏览器插件数据处理 ============

function handleExtensionData(data) {
  if (!data) return;

  // JP 审查经纬数据 — 填充到看板
  if (data.office === "JP" && data.type === "keika" && data.documents) {
    const appNumber = data.appNumber || "";
    const docs = data.documents.map((doc, idx) => ({
      docId: `jp-ext-${idx}`,
      docCode: doc.name,
      type: doc.category,
      date: doc.date,
      url: "",
      description: doc.name,
      extractUrl: null,
      downloadUrl: null,
      extractedText: null,
      aiAnalysis: null,
    }));

    // 更新看板
    const kanbanBoard = document.getElementById("kanban-board");
    if (kanbanBoard) {
      const statusColumns = kanbanBoard.querySelectorAll(".kanban-column");
      if (statusColumns.length > 0) {
        // 将文档按类别分配到看板列
        for (const doc of docs) {
          const colIdx = getKanbanColumnIndex(doc.type);
          if (colIdx < statusColumns.length) {
            const card = createKanbanCard(doc, doc.type, "JP", appNumber);
            const cardsContainer = statusColumns[colIdx].querySelector(".kanban-cards");
            if (cardsContainer) cardsContainer.appendChild(card);
          }
        }
      }
    }
    showNotification(`已导入 ${docs.length} 个 JP 审查文档（来自浏览器插件）`);
  }

  // JP 文档全文 — 直接显示
  if (data.office === "JP" && data.type === "document" && data.content) {
    const idx = currentData?.documents?.length || 0;
    const docObj = {
      docId: `jp-doc-ext`,
      docCode: data.title || "文档",
      type: "extension",
      date: "",
      url: "",
      description: data.title || "浏览器插件导入的文档",
      extractedText: {
        text: data.content,
        markdown: data.content,
        engine: "jplatpat_text",
        blocks: [],
        page_dimensions: {},
      },
    };

    // 添加到文档列表
    if (!currentData) currentData = {};
    if (!currentData.documents) currentData.documents = [];
    currentData.documents.push(docObj);

    // 显示文档内容
    showDocumentContent(data.content, data.title || "文档内容");
    showNotification(`已导入文档: ${data.title || "未知"}`);
  }

  // DE 注册信息 — 显示在结果区域
  if (data.office === "DE" && data.type === "register") {
    const info = data.data || data;
    const lines = [];
    if (info.akz) lines.push(`Aktenzeichen: ${info.akz}`);
    if (info.status) lines.push(`Status: ${info.status}`);
    if (info.title) lines.push(`Bezeichnung: ${info.title}`);
    if (info.applicant) lines.push(`Anmelder: ${info.applicant}`);
    if (info.inventor) lines.push(`Erfinder: ${info.inventor}`);
    if (info.representative) lines.push(`Vertreter: ${info.representative}`);
    if (info.filingDate) lines.push(`Anmeldetag: ${info.filingDate}`);
    if (info.publicationDate) lines.push(`Offenlegungstag: ${info.publicationDate}`);
    if (info.bescheideCount != null) lines.push(`Bescheide: ${info.bescheideCount}`);
    if (info.erwiderungenCount != null) lines.push(`Erwiderungen: ${info.erwiderungenCount}`);
    if (info.ipcClasses?.length) lines.push(`IPC: ${info.ipcClasses.join(", ")}`);

    if (info.procedures?.length) {
      lines.push("\nVerfahrensdaten:");
      for (const p of info.procedures) {
        lines.push(`  ${p.nr}. ${p.type} - ${p.status} (${p.date})`);
      }
    }

    showDocumentContent(lines.join("\n"), `DE 注册信息: ${info.akz || "未知"}`);
    showNotification("已导入 DE 注册信息（来自浏览器插件）");
  }
}

function handleExtensionAnalyze(data) {
  if (!data || !data.content) return;

  // 使用已有的 AI 分析功能
  const config = AI.loadAIConfig();
  const provider = AI.getCurrentProvider(config);
  if (!provider || !provider.apiKey) {
    showNotification("请先配置 AI API Key");
    return;
  }

  const prompt = AI.getDefaultPrompt("docAnalysis");
  const messages = [
    { role: "system", content: prompt },
    { role: "user", content: data.content },
  ];

  // 流式分析
  const readerContent = document.getElementById("reader-content");
  if (readerContent) {
    readerContent.innerHTML = '<div class="markdown-body"></div>';
    const streamContainer = readerContent.querySelector(".markdown-body");
    // 思考区 + 回答区分层
    const answerEl = document.createElement("div");
    answerEl.className = "reader-analysis-answer";
    streamContainer.appendChild(answerEl);
    const thinkingHost = _createThinkingHost(streamContainer);
    let _readerContentStarted = false;
    let fullContent = "";
    let _rafPending = false;

    AI.streamChat(provider.type, provider.apiKey, provider.baseUrl, {
      model: provider.model,
      messages,
      maxTokens: 32768,
    }).then(async (stream) => {
      for await (const chunk of stream) {
        if (chunk.reasoningContent && thinkingHost) {
          thinkingHost.appendReasoning(chunk.reasoningContent);
        }
        if (chunk.content) {
          if (!_readerContentStarted) {
            _readerContentStarted = true;
            if (thinkingHost) thinkingHost.startContent();
          }
          fullContent += chunk.content;
          if (!_rafPending) {
            _rafPending = true;
            requestAnimationFrame(() => {
              if (answerEl) answerEl.innerHTML = marked.parse(fullContent);
              _rafPending = false;
            });
          }
        }
      }
      if (thinkingHost) thinkingHost.finish();
      if (answerEl) answerEl.innerHTML = marked.parse(fullContent);
    }).catch((err) => {
      readerContent.innerHTML = `<p class="error">分析失败: ${err.message}</p>`;
    });
  }
}

function showNotification(message) {
  const existing = document.querySelector(".extension-notification");
  if (existing) existing.remove();

  const notif = document.createElement("div");
  notif.className = "extension-notification";
  notif.style.cssText = "position:fixed;top:20px;right:20px;background:#1a73e8;color:#fff;padding:12px 20px;border-radius:8px;z-index:10000;font-size:14px;box-shadow:0 4px 12px rgba(0,0,0,0.3);transition:opacity 0.3s;";
  notif.textContent = message;
  document.body.appendChild(notif);

  setTimeout(() => {
    notif.style.opacity = "0";
    setTimeout(() => notif.remove(), 300);
  }, 3000);
}

function showDocumentContent(content, title) {
  const readerContent = document.getElementById("reader-content");
  if (readerContent) {
    readerContent.innerHTML = `<h3>${title || "文档内容"}</h3><pre style="white-space:pre-wrap;word-break:break-all;">${content}</pre>`;
  }
  // 切换到阅读器标签
  const readerTab = document.querySelector('[data-tab="reader"]');
  if (readerTab) readerTab.click();
}

async function exportToWord() {
  if (typeof docx === "undefined" || typeof saveAs === "undefined") {
    showError("Word 导出库未加载，请刷新页面重试");
    return;
  }

  // Load logo image for header
  let logoBase64 = null;
  try {
    const logoResp = await fetch("PATENTLENSNEWLOGO.png");
    if (logoResp.ok) {
      const logoBlob = await logoResp.blob();
      logoBase64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(",")[1]);
        reader.readAsDataURL(logoBlob);
      });
    }
  } catch (e) {
    // Logo loading failed, continue without it
  }

  // ── Inline markdown parser (recursive) ──
  function parseInlineMarkdown(text) {
    const runs = [];
    let remaining = text;
    while (remaining.length > 0) {
      // Bold **text**
      let m = remaining.match(/^(.*?)\*\*(.+?)\*\*(.*)/s);
      if (m) {
        if (m[1]) runs.push(...parseInlineMarkdown(m[1]));
        runs.push(new docx.TextRun({ text: m[2], bold: true, size: 20, font: "Microsoft YaHei" }));
        remaining = m[3];
        continue;
      }
      // Italic *text*
      m = remaining.match(/^(.*?)\*([^*]+?)\*(.*)/s);
      if (m) {
        if (m[1]) runs.push(...parseInlineMarkdown(m[1]));
        runs.push(new docx.TextRun({ text: m[2], italics: true, size: 20, font: "Microsoft YaHei" }));
        remaining = m[3];
        continue;
      }
      // Code `text`
      m = remaining.match(/^(.*?)`([^`]+?)`(.*)/s);
      if (m) {
        if (m[1]) runs.push(...parseInlineMarkdown(m[1]));
        runs.push(new docx.TextRun({ text: m[2], size: 18, font: "Consolas", shading: { fill: "f0f0f0" } }));
        remaining = m[3];
        continue;
      }
      // Trace marks 【来源: ...】
      m = remaining.match(/^(.*?)【来源:\s*([^】]+)】(.*)/s);
      if (m) {
        if (m[1]) runs.push(...parseInlineMarkdown(m[1]));
        // Convert trace IDs to readable format
        const ids = m[2].split(",").map(s => s.trim());
        const readableIds = [];
        let currentDoc = null;
        let currentPage = null;
        let rangeStart = null;
        let rangeEnd = null;
        ids.forEach(id => {
          const trace = kanbanState.traceIndex[id];
          if (trace) {
            const doc = kanbanState.documents.find(d => d.idx === trace.docIdx);
            const docName = doc ? doc.name : "";
            if (docName !== currentDoc || trace.page !== currentPage) {
              if (currentDoc !== null && rangeStart !== null) {
                readableIds.push(`${currentDoc} 第${currentPage}页§${rangeStart}${rangeEnd !== rangeStart ? "-" + rangeEnd : ""}`);
              }
              currentDoc = docName;
              currentPage = trace.page;
              const blockMatch = id.match(/B_p\d+_(\d+)/);
              rangeStart = blockMatch ? parseInt(blockMatch[1]) : 0;
              rangeEnd = rangeStart;
            } else {
              const blockMatch = id.match(/B_p\d+_(\d+)/);
              if (blockMatch) rangeEnd = parseInt(blockMatch[1]);
            }
          }
        });
        if (currentDoc !== null && rangeStart !== null) {
          readableIds.push(`${currentDoc} 第${currentPage}页§${rangeStart}${rangeEnd !== rangeStart ? "-" + rangeEnd : ""}`);
        }
        const label = readableIds.length > 0 ? readableIds.join("; ") : m[2];
        runs.push(new docx.TextRun({ text: `[来源: ${label}]`, italics: true, size: 18, color: "4A90D9", font: "Microsoft YaHei" }));
        remaining = m[3];
        continue;
      }
      // No more patterns, push rest as plain text
      runs.push(new docx.TextRun({ text: remaining, size: 20, font: "Microsoft YaHei" }));
      remaining = "";
    }
    return runs;
  }

  // ── Parse markdown table ──
  function parseMarkdownTable(lines, startIdx) {
    const tableLines = [];
    let i = startIdx;
    while (i < lines.length && lines[i].trim().startsWith("|")) {
      tableLines.push(lines[i].trim());
      i++;
    }
    if (tableLines.length < 2) return { elements: [], nextIdx: i };

    const headerCells = tableLines[0].split("|").map(c => c.trim()).filter(c => c);
    const dataStartIdx = (tableLines.length > 1 && tableLines[1].match(/^\|[\s\-:|]+\|$/)) ? 2 : 1;

    const rows = [];
    rows.push(headerCells.map(cell => new docx.TableCell({
      children: [new docx.Paragraph({ children: [new docx.TextRun({ text: cell.replace(/\*+/g, ""), bold: true, size: 20, font: "Microsoft YaHei" })] })],
      shading: { fill: "2e3348" },
    })));

    for (let r = dataStartIdx; r < tableLines.length; r++) {
      const cells = tableLines[r].split("|").map(c => c.trim()).filter(c => c);
      rows.push(cells.map(cell => new docx.TableCell({
        children: [new docx.Paragraph({ children: parseInlineMarkdown(cell) })],
      })));
    }

    const table = new docx.Table({
      rows: rows.map(cells => new docx.TableRow({ children: cells })),
      width: { size: 100, type: docx.WidthType.PERCENTAGE },
    });
    return { elements: [table], nextIdx: i };
  }

  // ── Process markdown lines with full support ──
  function processMarkdownLines(lines) {
    const elements = [];
    let i = 0;
    while (i < lines.length) {
      const trimmed = lines[i].trim();
      if (!trimmed) {
        elements.push(new docx.Paragraph({ children: [] }));
        i++;
        continue;
      }
      // Table
      if (trimmed.startsWith("|") && trimmed.includes("|")) {
        const { elements: tableEls, nextIdx } = parseMarkdownTable(lines, i);
        tableEls.forEach(el => elements.push(el));
        i = nextIdx;
        continue;
      }
      // Headings (clean * from heading text)
      if (trimmed.startsWith("#### ")) {
        elements.push(new docx.Paragraph({
          children: [new docx.TextRun({ text: trimmed.slice(5).replace(/\*+/g, ""), bold: true, size: 21, font: "Microsoft YaHei" })],
          spacing: { before: 100, after: 50 },
        }));
      } else if (trimmed.startsWith("### ")) {
        elements.push(new docx.Paragraph({
          children: [new docx.TextRun({ text: trimmed.slice(4).replace(/\*+/g, ""), bold: true, size: 22, font: "Microsoft YaHei" })],
          spacing: { before: 120, after: 60 },
        }));
      } else if (trimmed.startsWith("## ")) {
        elements.push(new docx.Paragraph({
          children: [new docx.TextRun({ text: trimmed.slice(3).replace(/\*+/g, ""), bold: true, size: 24, font: "Microsoft YaHei" })],
          spacing: { before: 160, after: 80 },
        }));
      } else if (trimmed.startsWith("# ")) {
        elements.push(new docx.Paragraph({
          children: [new docx.TextRun({ text: trimmed.slice(2).replace(/\*+/g, ""), bold: true, size: 28, font: "Microsoft YaHei" })],
          spacing: { before: 200, after: 100 },
        }));
      } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        elements.push(new docx.Paragraph({
          children: parseInlineMarkdown(trimmed.slice(2)),
          bullet: { level: 0 },
        }));
      } else if (/^\d+\.\s/.test(trimmed)) {
        const text = trimmed.replace(/^\d+\.\s/, "");
        elements.push(new docx.Paragraph({
          children: parseInlineMarkdown(text),
          numbering: { reference: "ordered-list", level: 0 },
        }));
      } else {
        elements.push(new docx.Paragraph({
          children: parseInlineMarkdown(trimmed),
          spacing: { after: 60 },
        }));
      }
      i++;
    }
    return elements;
  }

  const children = [];

  // ── Logo + Title ──
  if (logoBase64) {
    children.push(
      new docx.Paragraph({
        children: [
          new docx.ImageRun({
            data: Uint8Array.from(atob(logoBase64), c => c.charCodeAt(0)),
            transformation: { width: 60, height: 60 },
            type: "png",
          }),
        ],
        spacing: { after: 100 },
      })
    );
  }

  children.push(
    new docx.Paragraph({
      children: [new docx.TextRun({ text: "专利审查历史分析报告", bold: true, size: 36, font: "Microsoft YaHei" })],
      spacing: { after: 200 },
    })
  );

  // ── Patent overview table ──
  if (currentData) {
    children.push(
      new docx.Paragraph({
        children: [new docx.TextRun({ text: "专利概览", bold: true, size: 26, font: "Microsoft YaHei" })],
        spacing: { before: 200, after: 100 },
      })
    );

    const overviewRows = [];
    const addRow = (label, value) => {
      overviewRows.push(new docx.TableRow({
        children: [
          new docx.TableCell({
            children: [new docx.Paragraph({ children: [new docx.TextRun({ text: label, bold: true, size: 20, font: "Microsoft YaHei" })] })],
            shading: { fill: "f0f0f0" },
            width: { size: 25, type: docx.WidthType.PERCENTAGE },
          }),
          new docx.TableCell({
            children: [new docx.Paragraph({ children: [new docx.TextRun({ text: value || "-", size: 20, font: "Microsoft YaHei" })] })],
          }),
        ],
      }));
    };

    addRow("专利号", currentData.docNumber || "");
    addRow("申请号", currentData.applicationNumber || "");
    addRow("申请局", OFFICE_NAMES[currentData.office] || currentData.office || "");

    // Get title, inventor, dates from family data (same logic as renderOverview)
    let title = "";
    let inventors = "";
    let applicants = "";
    let filingDate = "";
    let publicationDate = "";
    let priorityDate = "";
    let ipcClasses = "";
    let cpcClasses = "";
    let legalStatus = "";

    if (currentData.family) {
      const members = extractFamilyMembers(currentData.family);
      if (members.length > 0) {
        let m = members.find(mem => mem.countryCode === currentData.office) || members[0];
        const dl = m.docList || {};
        title = m.title || dl.title || m.inventionTitle || "";
        const applicantNamesArr = m.applicantNames || dl.applicantNames || [];
        const namesStr = Array.isArray(applicantNamesArr) ? applicantNamesArr.join(", ") : (applicantNamesArr || "");
        if (currentData.office === "US") {
          inventors = namesStr || m.inventors || m.inventorName || "";
        } else {
          applicants = namesStr || m.applicants || m.applicantName || "";
          inventors = m.inventors || m.inventorName || "";
        }
        filingDate = m.appDateStr || m.filingDate || m.applicationDate || "";
        if (!filingDate && m.appDate) {
          try { filingDate = new Date(m.appDate).toLocaleDateString("en-US"); } catch(e) {}
        }
        if (m.pubList && Array.isArray(m.pubList) && m.pubList.length > 0) {
          publicationDate = m.pubList[0].pubDateStr || "";
          if (!publicationDate && m.pubList[0].pubDate) {
            try { publicationDate = new Date(m.pubList[0].pubDate).toLocaleDateString("en-US"); } catch(e2) {}
          }
        }
        publicationDate = publicationDate || m.publicationDate || m.pubDate || "";
        if (m.docNum && m.docNum.date) {
          priorityDate = m.docNum.date;
        }
        if (!priorityDate && m.priorityClaimList && Array.isArray(m.priorityClaimList) && m.priorityClaimList.length > 0) {
          priorityDate = m.priorityClaimList[0].date || "";
        }
        ipcClasses = m.ipc || m.ipcClass || m.classification || "";
        if (Array.isArray(ipcClasses)) ipcClasses = ipcClasses.join(", ");
        cpcClasses = m.cpcClass || m.cpc || "";
        if (Array.isArray(cpcClasses)) cpcClasses = cpcClasses.join(", ");
        const docItems = kanbanState.documents || [];
        const hasAllowance = docItems.some(it => it.type === "allowance");
        const hasOA = docItems.some(it => it.type === "office_action");
        const hasResponse = docItems.some(it => it.type === "response");
        if (hasAllowance) {
          legalStatus = "已授权 (Granted)";
        } else if (hasOA && !hasResponse) {
          legalStatus = "待答复 (Pending Response)";
        } else if (hasOA && hasResponse) {
          legalStatus = "审查中 (Under Examination)";
        } else {
          legalStatus = m.legalStatus || m.status || "";
        }
      }
    }

    addRow("标题", title);
    addRow("发明人", inventors);
    addRow("申请人", applicants);
    addRow("申请日", filingDate);
    addRow("公开日", publicationDate);
    if (priorityDate) addRow("优先权日", priorityDate);
    if (ipcClasses) addRow("IPC分类", ipcClasses);
    if (cpcClasses) addRow("CPC分类", cpcClasses);
    if (legalStatus) addRow("法律状态", legalStatus);

    children.push(new docx.Table({
      rows: overviewRows,
      width: { size: 100, type: docx.WidthType.PERCENTAGE },
    }));
  }

  // ── Timeline table ──
  if (currentData && kanbanState.documents && kanbanState.documents.length > 0) {
    children.push(
      new docx.Paragraph({
        children: [new docx.TextRun({ text: "审查时间线", bold: true, size: 26, font: "Microsoft YaHei" })],
        spacing: { before: 300, after: 100 },
      })
    );

    const tlHeader = ["序号", "日期", "文档代码", "文档名称", "类型", "阶段"].map(h =>
      new docx.TableCell({
        children: [new docx.Paragraph({ children: [new docx.TextRun({ text: h, bold: true, size: 18, color: "FFFFFF", font: "Microsoft YaHei" })] })],
        shading: { fill: "2e3348" },
      })
    );
    const tlRows = [new docx.TableRow({ children: tlHeader })];

    const sortedDocs = [...kanbanState.documents].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    sortedDocs.forEach((it, idx) => {
      const typeNames = { "office_action": "审查意见", "response": "答复", "request": "请求", "allowance": "授权", "notification": "通知", "misc": "其他" };
      tlRows.push(new docx.TableRow({
        children: [
          new docx.TableCell({ children: [new docx.Paragraph({ children: [new docx.TextRun({ text: String(idx + 1), size: 18, font: "Microsoft YaHei" })] })] }),
          new docx.TableCell({ children: [new docx.Paragraph({ children: [new docx.TextRun({ text: it.date || "", size: 18, font: "Microsoft YaHei" })] })] }),
          new docx.TableCell({ children: [new docx.Paragraph({ children: [new docx.TextRun({ text: it.docCode || "", size: 18, font: "Microsoft YaHei" })] })] }),
          new docx.TableCell({ children: [new docx.Paragraph({ children: [new docx.TextRun({ text: it.name || "", size: 18, font: "Microsoft YaHei" })] })] }),
          new docx.TableCell({ children: [new docx.Paragraph({ children: [new docx.TextRun({ text: typeNames[it.type] || it.type || "", size: 18, font: "Microsoft YaHei" })] })] }),
          new docx.TableCell({ children: [new docx.Paragraph({ children: [new docx.TextRun({ text: it.stage || "", size: 18, font: "Microsoft YaHei" })] })] }),
        ],
      }));
    });

    children.push(new docx.Table({
      rows: tlRows,
      width: { size: 100, type: docx.WidthType.PERCENTAGE },
    }));
  }

  // ── AI Analysis content ──
  if (kanbanState.analysis) {
    children.push(
      new docx.Paragraph({
        children: [new docx.TextRun({ text: "审查历史综合分析", bold: true, size: 28, font: "Microsoft YaHei" })],
        spacing: { before: 300, after: 100 },
      })
    );

    const analysisLines = kanbanState.analysis.split("\n");
    const analysisElements = processMarkdownLines(analysisLines);
    analysisElements.forEach(el => children.push(el));
  }

  // ── Create document with header ──
  const headerChildren = [];
  if (logoBase64) {
    headerChildren.push(
      new docx.ImageRun({
        data: Uint8Array.from(atob(logoBase64), c => c.charCodeAt(0)),
        transformation: { width: 18, height: 18 },
        type: "png",
      })
    );
    headerChildren.push(new docx.TextRun({ text: "  ", size: 16 }));
  }
  headerChildren.push(new docx.TextRun({ text: "由PatentLens工具制作", italics: true, size: 16, color: "999999", font: "Microsoft YaHei" }));

  const doc = new docx.Document({
    sections: [{
      headers: {
        default: new docx.Header({
          children: [new docx.Paragraph({
            alignment: docx.AlignmentType.RIGHT,
            children: headerChildren,
          })],
        }),
      },
      children,
    }],
    numbering: {
      config: [{
        reference: "ordered-list",
        levels: [{ level: 0, format: docx.LevelFormat.DECIMAL, text: "%1.", alignment: docx.AlignmentType.START }],
      }],
    },
  });

  const blob = await docx.Packer.toBlob(doc);
  const fileName = `专利审查报告_${currentData ? (currentData.docNumber || currentData.applicationNumber || "unknown") : "export"}.docx`;
  saveAs(blob, fileName);
}

document.addEventListener("DOMContentLoaded", () => {
  // Theme toggle
  const themeToggleBtn = document.getElementById("theme-toggle-btn");
  const savedTheme = localStorage.getItem("patentlens-theme") || "dark";
  document.documentElement.setAttribute("data-theme", savedTheme);
  function updateThemeIcon(theme) {
    const darkIcon = themeToggleBtn ? themeToggleBtn.querySelector(".theme-icon-dark") : null;
    const lightIcon = themeToggleBtn ? themeToggleBtn.querySelector(".theme-icon-light") : null;
    if (darkIcon && lightIcon) {
      darkIcon.style.display = theme === "dark" ? "" : "none";
      lightIcon.style.display = theme === "light" ? "" : "none";
    }
  }
  updateThemeIcon(savedTheme);
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener("click", () => {
      const current = document.documentElement.getAttribute("data-theme") || "dark";
      const next = current === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("patentlens-theme", next);
      updateThemeIcon(next);
    });
  }

  loadAISettingsToForm();

  // ── 监听浏览器插件发送的数据（通过 Electron 主进程注入） ──
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.type === "extension-data") {
      console.log("[Extension] 收到插件数据:", event.data.payload);
      const appEl = document.getElementById("app");
      if (appEl) appEl.classList.remove("home-mode");
      handleExtensionData(event.data.payload);
    }
    if (event.data && event.data.type === "extension-analyze") {
      console.log("[Extension] 收到分析请求:", event.data.payload);
      const appEl = document.getElementById("app");
      if (appEl) appEl.classList.remove("home-mode");
      handleExtensionAnalyze(event.data.payload);
    }
  });

  const documentsContent = document.getElementById("documents-content");
  if (documentsContent) {
    documentsContent.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === "download") {
        downloadDocument(btn.dataset.url, btn.dataset.filename);
      } else if (action === "extract") {
        extractDocumentText(btn.dataset.url, parseInt(btn.dataset.idx), btn.dataset.doctype);
      } else if (action === "ai-analyze-doc") {
        aiAnalyzeDocument(parseInt(btn.dataset.idx), btn.dataset.doctype);
      }
    });
  }

  const kanbanBoard = document.getElementById("kanban-board");
  if (kanbanBoard) {
    kanbanBoard.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === "kanban-download") {
        downloadDocument(btn.dataset.url, btn.dataset.filename);
      } else if (action === "kanban-extract") {
        kanbanManualExtract(btn.dataset.url, parseInt(btn.dataset.idx), btn.dataset.doctype);
      } else if (action === "kanban-view-pdf") {
        openReaderForDoc(parseInt(btn.dataset.idx), true);
      } else if (action === "ai-analyze-doc") {
        aiAnalyzeDocument(parseInt(btn.dataset.idx), btn.dataset.doctype);
      }
    });
  }

  if (readerBtn) {
    readerBtn.addEventListener("click", openReader);
  }

  if (readerCloseBtn) {
    readerCloseBtn.addEventListener("click", () => {
      readerModal.classList.add("hidden");
      // Update floating ball: show "open reader" icon
      if (readerFloatingBall) {
        readerFloatingBall.classList.remove("hidden");
        const iconOpen = readerFloatingBall.querySelector(".reader-fb-icon-open");
        const iconBack = readerFloatingBall.querySelector(".reader-fb-icon-back");
        readerFloatingBall.title = "点击打开阅读器";
        if (iconOpen) iconOpen.classList.remove("hidden");
        if (iconBack) iconBack.classList.add("hidden");
      }
      // Reset PDF view state when closing
      if (pdfViewState.active) {
        pdfViewState.active = false;
        readerPdfView.classList.add("hidden");
        readerContent.classList.remove("hidden");
        if (readerPdfToggle) {
          readerPdfToggle.classList.remove("active");
          readerPdfToggle.textContent = "PDF 视图";
        }
      }
      pdfViewState.pdfDoc = null;
      pdfViewState.renderedPages = {};
      pdfViewState.pendingHighlight = null;
      pdfViewState.pendingHighlightRange = null;
      pdfViewState.selectedBlockIds = [];
      pdfViewState.selecting = false;
      pdfViewState.traceJumpPending = false;
      // Reset docked state
      const content = document.querySelector(".reader-modal-content");
      if (content) content.classList.remove("docked");
      if (readerFullscreenBtn) readerFullscreenBtn.classList.add("hidden");
      if (readerDockBtn) readerDockBtn.classList.remove("hidden");
      // Close chat panel
      if (readerChatPanel) readerChatPanel.classList.add("hidden");
      if (readerChatToggle) readerChatToggle.classList.remove("active");
      chatHistory = [];
      if (chatMessages) chatMessages.innerHTML = "";
      // Exit reading mode
      exitReadingMode();
    });
  }

  if (readerModal) {
    readerModal.querySelector(".modal-overlay").addEventListener("click", () => {
      const content = document.querySelector(".reader-modal-content");
      // Exit reading mode first (removes tucked, hides right panel)
      exitReadingMode();
      if (content && content.classList.contains("docked")) {
        // In docked mode, minimize to floating ball instead of closing
        readerModal.classList.add("hidden");
        // Update floating ball: show "open reader" icon
        if (readerFloatingBall) {
          readerFloatingBall.classList.remove("hidden");
          const iconOpen = readerFloatingBall.querySelector(".reader-fb-icon-open");
          const iconBack = readerFloatingBall.querySelector(".reader-fb-icon-back");
          readerFloatingBall.title = "点击打开阅读器";
          if (iconOpen) iconOpen.classList.remove("hidden");
          if (iconBack) iconBack.classList.add("hidden");
        }
      } else {
        // Full screen mode, close fully
        readerModal.classList.add("hidden");
        // Update floating ball: show "open reader" icon
        if (readerFloatingBall) {
          readerFloatingBall.classList.remove("hidden");
          const iconOpen = readerFloatingBall.querySelector(".reader-fb-icon-open");
          const iconBack = readerFloatingBall.querySelector(".reader-fb-icon-back");
          readerFloatingBall.title = "点击打开阅读器";
          if (iconOpen) iconOpen.classList.remove("hidden");
          if (iconBack) iconBack.classList.add("hidden");
        }
        if (pdfViewState.active) {
          pdfViewState.active = false;
          readerPdfView.classList.add("hidden");
          readerContent.classList.remove("hidden");
          if (readerPdfToggle) {
            readerPdfToggle.classList.remove("active");
            readerPdfToggle.textContent = "PDF 视图";
          }
        }
        pdfViewState.pdfDoc = null;
        pdfViewState.renderedPages = {};
        pdfViewState.pendingHighlight = null;
        pdfViewState.pendingHighlightRange = null;
        pdfViewState.selectedBlockIds = [];
        pdfViewState.selecting = false;
        pdfViewState.traceJumpPending = false;
        if (content) content.classList.remove("docked");
        if (readerFullscreenBtn) readerFullscreenBtn.classList.add("hidden");
        if (readerDockBtn) readerDockBtn.classList.remove("hidden");
        // Close chat panel
        if (readerChatPanel) readerChatPanel.classList.add("hidden");
        if (readerChatToggle) readerChatToggle.classList.remove("active");
        chatHistory = [];
        if (chatMessages) chatMessages.innerHTML = "";
      }
    });
  }

  if (readerDocList) {
    readerDocList.addEventListener("click", (e) => {
      const item = e.target.closest("[data-action]");
      if (!item) return;
      if (item.dataset.action === "reader-select") {
        selectReaderDoc(parseInt(item.dataset.idx));
      } else if (item.dataset.action === "reader-select-analysis") {
        selectReaderAnalysis();
      }
    });
  }

  if (exportWordBtn) {
    exportWordBtn.addEventListener("click", exportToWord);
  }

  // Event delegation for analysis module regenerate buttons and module tabs
  document.addEventListener("click", (ev) => {
    const regenBtn = ev.target.closest(".analysis-module-regen-btn");
    if (regenBtn && !regenBtn.disabled) {
      const moduleId = regenBtn.dataset.moduleId;
      const moduleLabel = regenBtn.dataset.moduleLabel;
      if (moduleId && moduleLabel) {
        showModuleRegenPopup(regenBtn, moduleId, moduleLabel);
      }
      return;
    }
    const moduleTab = ev.target.closest(".analysis-module-tab");
    if (moduleTab) {
      const moduleId = moduleTab.dataset.moduleId;
      if (moduleId) {
        const container = document.getElementById("kanban-analysis-content");
        const target = container ? container.querySelector('.analysis-module[data-module-id="' + moduleId + '"]') : null;
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "start" });
          // Briefly highlight active tab
          container.querySelectorAll(".analysis-module-tab").forEach(t => t.classList.remove("active"));
          moduleTab.classList.add("active");
        }
      }
    }
  });

  // Scroll-based active tab highlighting for analysis module tabs
  if (!window._analysisScrollObserver) {
    window._analysisScrollObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const moduleId = entry.target.dataset.moduleId;
          const container = document.getElementById("kanban-analysis-content");
          if (container && moduleId) {
            container.querySelectorAll(".analysis-module-tab").forEach(t => {
              t.classList.toggle("active", t.dataset.moduleId === moduleId);
            });
          }
        }
      });
    }, { rootMargin: "-80px 0px -60% 0px", threshold: 0 });
  }

  if (readerExportBtn) {
    readerExportBtn.addEventListener("click", exportToWord);
  }

  // Sidebar toggle
  const readerSidebarToggle = document.getElementById("reader-sidebar-toggle");
  const readerSidebar = document.getElementById("reader-sidebar");
  const readerMain = document.querySelector(".reader-main");
  if (readerSidebarToggle && readerSidebar) {
    readerSidebarToggle.addEventListener("click", () => {
      readerSidebar.classList.toggle("collapsed");
      if (readerSidebar.classList.contains("collapsed")) {
        // Add expand button
        const expandBtn = document.createElement("button");
        expandBtn.id = "reader-sidebar-expand";
        expandBtn.className = "reader-sidebar-expand-btn";
        expandBtn.innerHTML = '<svg class="svg-icon-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>';
        expandBtn.title = "展开文档列表";
        if (readerMain) readerMain.appendChild(expandBtn);
        expandBtn.addEventListener("click", () => {
          readerSidebar.classList.remove("collapsed");
          expandBtn.remove();
        });
      } else {
        const expandBtn = document.getElementById("reader-sidebar-expand");
        if (expandBtn) expandBtn.remove();
      }
    });
  }

  if (pdfPrevPage) {
    pdfPrevPage.addEventListener("click", () => pdfGoToPage(pdfViewState.currentPage - 1));
  }
  if (pdfNextPage) {
    pdfNextPage.addEventListener("click", () => pdfGoToPage(pdfViewState.currentPage + 1));
  }
  if (pdfPageInput) {
    pdfPageInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const p = parseInt(pdfPageInput.value, 10);
        if (!isNaN(p)) pdfGoToPage(p);
      }
    });
    pdfPageInput.addEventListener("blur", () => {
      pdfPageInput.value = pdfViewState.currentPage;
    });
  }
  if (pdfZoomIn) {
    pdfZoomIn.addEventListener("click", pdfZoomInAction);
  }
  if (pdfZoomOut) {
    pdfZoomOut.addEventListener("click", pdfZoomOutAction);
  }
  if (pdfZoomFit) {
    pdfZoomFit.addEventListener("click", pdfZoomFitAction);
  }

  // PDF OCR button
  const pdfOcrBtn = document.getElementById("pdf-ocr-btn");
  if (pdfOcrBtn) {
    const ocrSpan = pdfOcrBtn.querySelector("span");
    pdfOcrBtn.addEventListener("click", async () => {
      if (pdfOcrBtn.disabled) return;
      pdfOcrBtn.disabled = true;
      if (ocrSpan) ocrSpan.textContent = "OCR中...";
      await ocrPdf();
      pdfOcrBtn.disabled = false;
      if (ocrSpan) ocrSpan.textContent = "OCR";
    });
  }

  // PDF translate button
  if (pdfTranslateBtn) {
    pdfTranslateBtn.addEventListener("click", translatePdfPage);
  }

  // PDF translate selected blocks button
  const translateSelBtn = document.getElementById("pdf-translate-selection-btn");
  if (translateSelBtn) {
    translateSelBtn.addEventListener("click", translateSelectedBlocks);
  }

  // PDF clear selection button
  const clearSelBtn = document.getElementById("pdf-clear-selection-btn");
  if (clearSelBtn) {
    clearSelBtn.addEventListener("click", clearPdfBlockSelection);
  }

  // PDF 标注按钮
  const annotHighlightBtn = document.getElementById("pdf-annot-highlight");
  if (annotHighlightBtn) {
    annotHighlightBtn.addEventListener("click", () => setPdfAnnotTool("highlight"));
  }
  const annotUnderlineBtn = document.getElementById("pdf-annot-underline");
  if (annotUnderlineBtn) {
    annotUnderlineBtn.addEventListener("click", () => setPdfAnnotTool("underline"));
  }
  const annotArrowBtn = document.getElementById("pdf-annot-arrow");
  if (annotArrowBtn) {
    annotArrowBtn.addEventListener("click", () => setPdfAnnotTool("arrow"));
  }
  const annotNoteBtn = document.getElementById("pdf-annot-note");
  if (annotNoteBtn) {
    annotNoteBtn.addEventListener("click", () => setPdfAnnotTool("note"));
  }
  const annotHideOcrBtn = document.getElementById("pdf-annot-hide-ocr");
  if (annotHideOcrBtn) {
    annotHideOcrBtn.addEventListener("click", togglePdfOcrHide);
  }
  const annotUndoBtn = document.getElementById("pdf-annot-undo");
  if (annotUndoBtn) {
    annotUndoBtn.addEventListener("click", undoPdfAnnotation);
  }
  const annotRedoBtn = document.getElementById("pdf-annot-redo");
  if (annotRedoBtn) {
    annotRedoBtn.addEventListener("click", redoPdfAnnotation);
  }
  // 颜色/字号设置
  const annotTextColor = document.getElementById("pdf-annot-text-color");
  if (annotTextColor) {
    annotTextColor.addEventListener("change", (e) => { pdfViewState.annotTextColor = e.target.value; });
  }
  const annotFontSize = document.getElementById("pdf-annot-font-size");
  if (annotFontSize) {
    annotFontSize.addEventListener("change", (e) => { pdfViewState.annotFontSize = parseInt(e.target.value, 10) || 14; });
  }
  const annotLineColor = document.getElementById("pdf-annot-line-color");
  if (annotLineColor) {
    annotLineColor.addEventListener("change", (e) => { pdfViewState.annotLineColor = e.target.value; });
  }
  const annotLineWidth = document.getElementById("pdf-annot-line-width");
  if (annotLineWidth) {
    annotLineWidth.addEventListener("change", (e) => { pdfViewState.annotLineWidth = parseFloat(e.target.value) || 2; });
  }
  const annotDashBtn = document.getElementById("pdf-annot-dash");
  if (annotDashBtn) {
    annotDashBtn.addEventListener("click", () => {
      pdfViewState.annotDash = !pdfViewState.annotDash;
      annotDashBtn.classList.toggle("active", pdfViewState.annotDash);
    });
  }
  const annotExportBtn = document.getElementById("pdf-annot-export");
  if (annotExportBtn) {
    annotExportBtn.addEventListener("click", exportPdfWithAnnotations);
  }
  const annotClearBtn = document.getElementById("pdf-annot-clear");
  if (annotClearBtn) {
    annotClearBtn.addEventListener("click", clearPdfAnnotations);
  }
  // 关闭前确认：通过 IPC 同步标注状态到主进程，由主进程弹原生确认框
  // （Electron 中 beforeunload 的 preventDefault 会静默阻止关闭，不能用）
  _updateAnnotCloseFlag();

  // Extract copy button
  const extractCopyBtn = document.getElementById("extract-copy-btn");
  if (extractCopyBtn) {
    extractCopyBtn.addEventListener("click", () => {
      const idx = pdfViewState.currentDocIdx;
      const ext = kanbanState.extractions ? kanbanState.extractions[idx] : null;
      if (!ext) return;
      const text = ext.markdown || ext.text || "";
      if (!text.trim()) return;
      navigator.clipboard.writeText(text).then(() => {
        extractCopyBtn.textContent = "已复制 ✓";
        setTimeout(() => { extractCopyBtn.textContent = "复制全文"; }, 1500);
      }).catch(() => {
        // Fallback for older browsers
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        extractCopyBtn.textContent = "已复制 ✓";
        setTimeout(() => { extractCopyBtn.textContent = "复制全文"; }, 1500);
      });
    });
  }

  // Right panel close button (exits reading mode entirely)
  const rightPanelCloseBtn = document.getElementById("right-panel-close-btn");
  if (rightPanelCloseBtn) {
    rightPanelCloseBtn.addEventListener("click", () => {
      exitReadingMode();
    });
  }

  // Patent popup viewer close button and floating ball
  const ppvCloseBtn = document.getElementById("ppv-close-btn");
  const patentPopupBall = document.getElementById("patent-popup-ball");
  if (ppvCloseBtn) {
    ppvCloseBtn.addEventListener("click", closePatentPopup);
  }
  if (patentPopupBall) {
    patentPopupBall.addEventListener("click", showPatentPopup);
  }

  // PPV resize handle drag
  const ppvResizeHandle = document.querySelector(".ppv-resize-handle");
  if (ppvResizeHandle) {
    let ppvDragging = false;
    let ppvStartX = 0;
    let ppvStartWidth = 0;
    ppvResizeHandle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      ppvDragging = true;
      ppvStartX = e.clientX;
      const viewer = document.getElementById("patent-popup-viewer");
      ppvStartWidth = viewer ? viewer.offsetWidth : 520;
      ppvResizeHandle.classList.add("ppv-resizing");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    });
    document.addEventListener("mousemove", (e) => {
      if (!ppvDragging) return;
      const viewer = document.getElementById("patent-popup-viewer");
      if (!viewer) return;
      const dx = ppvStartX - e.clientX;
      const newWidth = Math.max(320, Math.min(window.innerWidth * 0.9, ppvStartWidth + dx));
      viewer.style.width = newWidth + "px";
    });
    document.addEventListener("mouseup", () => {
      if (!ppvDragging) return;
      ppvDragging = false;
      ppvResizeHandle.classList.remove("ppv-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    });
  }

  // Right panel tab switching
  document.querySelectorAll(".right-panel-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      const panelName = tab.dataset.panel;
      switchRightPanelTab(panelName);
    });
  });

  // Reader sidebar doc search filter
  const readerDocSearch = document.getElementById("reader-doc-search");
  if (readerDocSearch) {
    readerDocSearch.addEventListener("input", () => {
      const keyword = readerDocSearch.value.trim().toLowerCase();
      document.querySelectorAll(".reader-doc-item").forEach(el => {
        const text = el.textContent.toLowerCase();
        el.style.display = (!keyword || text.includes(keyword)) ? "" : "none";
      });
    });
  }

  // PDF search
  const pdfSearchBtn = document.getElementById("pdf-search-btn");
  const pdfSearchInput = document.getElementById("pdf-search-input");
  const pdfSearchPrevBtn = document.getElementById("pdf-search-prev-btn");
  const pdfSearchNextBtn = document.getElementById("pdf-search-next-btn");
  if (pdfSearchBtn) {
    pdfSearchBtn.addEventListener("click", searchPdfKeyword);
  }
  if (pdfSearchPrevBtn) {
    pdfSearchPrevBtn.addEventListener("click", searchPdfPrev);
  }
  if (pdfSearchNextBtn) {
    pdfSearchNextBtn.addEventListener("click", searchPdfNext);
  }
  if (pdfSearchInput) {
    pdfSearchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (pdfViewState.searchMatches.length > 0) {
          searchPdfNext();
        } else {
          searchPdfKeyword();
        }
      }
    });
  }

  // Floating ball click: toggle between reader and report view
  function updateFloatingBallState(readerVisible) {
    if (!readerFloatingBall) return;
    const iconOpen = readerFloatingBall.querySelector(".reader-fb-icon-open");
    const iconBack = readerFloatingBall.querySelector(".reader-fb-icon-back");
    if (readerVisible) {
      // Reader is visible → ball shows "back to report" icon
      readerFloatingBall.title = "点击回到报告";
      if (iconOpen) iconOpen.classList.add("hidden");
      if (iconBack) iconBack.classList.remove("hidden");
    } else {
      // Reader is hidden → ball shows "open reader" icon
      readerFloatingBall.title = "点击打开阅读器";
      if (iconOpen) iconOpen.classList.remove("hidden");
      if (iconBack) iconBack.classList.add("hidden");
    }
  }

  if (readerFloatingBall) {
    readerFloatingBall.addEventListener("click", () => {
      if (readerModal.classList.contains("hidden")) {
        // Reader is hidden → open it
        openReader();
      } else {
        // Reader is visible → minimize to report view
        readerModal.classList.add("hidden");
        exitReadingMode();
        updateFloatingBallState(false);
      }
    });
  }

  // 打开侧边栏（文字复制/对照翻译/AI问一问）按钮
  if (readerChatToggle) {
    readerChatToggle.addEventListener("click", () => {
      const rightPanel = document.getElementById("reader-right-panel");
      if (rightPanel) {
        const wasHidden = rightPanel.classList.contains("hidden");
        if (wasHidden) {
          readerChatToggle.classList.add("active");
          enterReadingMode("translate");
        } else {
          exitReadingMode();
        }
      }
    });
  }

  // Chat close button is now handled by the right panel close button
  // No separate chatCloseBtn needed

  // Chat send
  if (chatSendBtn) {
    chatSendBtn.addEventListener("click", sendChatMessage);
  }

  if (chatInput) {
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    });
  }

  document.addEventListener("click", (e) => {
    const traceLink = e.target.closest(".trace-link");
    if (traceLink) {
      const blockId = traceLink.dataset.blockId;
      if (blockId) onTraceClick(blockId);
    }
  });

  // ── Merge export events ──
  const mergeExportBtn = document.getElementById("merge-export-btn");
  const mergeExportCloseBtn = document.getElementById("merge-export-close-btn");
  const mergeExportCancelBtn = document.getElementById("merge-export-cancel-btn");
  const mergeExportDoBtn = document.getElementById("merge-export-do-btn");
  const mergeExportModal = document.getElementById("merge-export-modal");
  const mergeExportOverlay = mergeExportModal ? mergeExportModal.querySelector(".modal-overlay") : null;

  if (mergeExportBtn) mergeExportBtn.addEventListener("click", openMergeExportModal);
  if (mergeExportCloseBtn) mergeExportCloseBtn.addEventListener("click", () => mergeExportModal.classList.add("hidden"));
  if (mergeExportCancelBtn) mergeExportCancelBtn.addEventListener("click", () => mergeExportModal.classList.add("hidden"));
  if (mergeExportOverlay) mergeExportOverlay.addEventListener("click", () => mergeExportModal.classList.add("hidden"));
  if (mergeExportDoBtn) mergeExportDoBtn.addEventListener("click", doMergeExport);

  // Splash screen - wait for GIF animation to complete at least one loop (~4.5s)
  setTimeout(() => {
    const splash = document.getElementById("splash-screen");
    if (splash) {
      splash.style.opacity = "0";
      setTimeout(() => splash.remove(), 500);
    }
  }, 4500);
});

async function sendChatMessage() {
  const input = chatInput;
  if (!input) return;
  const question = input.value.trim();
  if (!question) return;

  // Check if document has OCR content
  const idx = pdfViewState.currentDocIdx;
  if (idx == null) {
    showError("请先选择一个文档");
    return;
  }
  const ext = kanbanState.extractions[idx];
  if (!ext || !ext.text) {
    showError("请先提取文档内容（OCR提取）");
    return;
  }

  // Get AI config
  const config = AI.loadAIConfig();
  const provider = AI.getCurrentProvider(config);
  if (!provider || !provider.apiKey) {
    showError("请先配置 AI 服务（API Key）");
    return;
  }

  // Add user message
  chatHistory.push({ role: "user", content: question });
  appendChatMessage("user", question);
  input.value = "";

  // Build context from document content
  const docContent = ext.text.slice(0, 8000); // Limit context size
  const doc = kanbanState.documents.find(d => d.idx === idx);
  const docName = doc ? `${doc.name} (${doc.docCode})` : "当前文档";

  const systemPrompt = `你是专利审查文档分析助手。用户正在查看专利审查文档「${docName}」的内容。以下是该文档的OCR提取内容，请基于此内容回答用户的问题。如果文档内容不足以回答，请如实说明。\n\n---文档内容开始---\n${docContent}\n---文档内容结束---`;

  const messages = [
    { role: "system", content: systemPrompt },
    ...chatHistory.slice(-10) // Keep last 10 messages for context
  ];

  // Add assistant placeholder
  const assistantMsgEl = appendChatMessage("assistant", "");
  chatSendBtn.disabled = true;
  chatAbortController = new AbortController();

  // 思考区挂在消息气泡内
  const _chatContentEl = assistantMsgEl.querySelector(".chat-msg-content") || assistantMsgEl;
  const thinkingHost = _createThinkingHost(_chatContentEl);
  let _chatContentStarted = false;

  try {
    let fullResponse = "";
    let _rafPending = false;
    const stream = AI.streamChat(provider.type, provider.apiKey, provider.baseUrl, {
      model: provider.model,
      messages: messages,
      maxTokens: 4096,
    }, chatAbortController.signal);

    for await (const chunk of stream) {
      if (chatAbortController.signal.aborted) break;
      if (chunk.reasoningContent && thinkingHost) {
        thinkingHost.appendReasoning(chunk.reasoningContent);
      }
      if (chunk.content) {
        if (!_chatContentStarted) {
          _chatContentStarted = true;
          if (thinkingHost) thinkingHost.startContent();
        }
        fullResponse += chunk.content;
        if (!_rafPending) {
          _rafPending = true;
          requestAnimationFrame(() => {
            if (assistantMsgEl) {
              const contentEl = assistantMsgEl.querySelector(".chat-msg-content") || assistantMsgEl;
              // 保留思考区，把回答写到独立 .chat-msg-answer
              let answerEl = contentEl.querySelector(":scope > .chat-msg-answer");
              if (!answerEl) {
                answerEl = document.createElement("div");
                answerEl.className = "chat-msg-answer markdown-body";
                contentEl.appendChild(answerEl);
              }
              answerEl.innerHTML = renderMarkdown(fullResponse);
            }
            _rafPending = false;
          });
        }
      }
    }
    if (thinkingHost) thinkingHost.finish();
    // Final render
    if (assistantMsgEl) {
      const contentEl = assistantMsgEl.querySelector(".chat-msg-content") || assistantMsgEl;
      let answerEl = contentEl.querySelector(":scope > .chat-msg-answer");
      if (!answerEl) {
        answerEl = document.createElement("div");
        answerEl.className = "chat-msg-answer markdown-body";
        contentEl.appendChild(answerEl);
      }
      answerEl.innerHTML = renderMarkdown(fullResponse);
    }

    chatHistory.push({ role: "assistant", content: fullResponse });
  } catch (e) {
    if (e.name !== "AbortError") {
      appendChatMessage("system", "AI 响应出错: " + e.message);
    }
  } finally {
    chatSendBtn.disabled = false;
    chatAbortController = null;
  }
}

function appendChatMessage(role, content) {
  if (!chatMessages) return null;
  const msgEl = document.createElement("div");
  msgEl.className = `chat-msg ${role}`;
  if (role === "assistant") {
    msgEl.innerHTML = `<div class="chat-msg-content markdown-body">${renderMarkdown(content)}</div>`;
  } else if (role === "system") {
    msgEl.textContent = content;
  } else {
    msgEl.textContent = content;
  }
  chatMessages.appendChild(msgEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return msgEl;
}

// ===== Analysis Chat (continued conversation with AI analysis report) =====

function showAnalysisChatToggle() {
  updateFloatingBallsVisibility();
}

function appendAnalysisChatMessage(role, content) {
  const messagesEl = document.getElementById("analysis-chat-messages");
  if (!messagesEl) return null;
  const msgEl = document.createElement("div");
  msgEl.className = `chat-msg ${role}`;
  if (role === "assistant") {
    msgEl.innerHTML = `<div class="chat-msg-content markdown-body">${renderMarkdown(content)}</div>`;
  } else if (role === "system") {
    msgEl.textContent = content;
  } else {
    msgEl.textContent = content;
  }
  messagesEl.appendChild(msgEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return msgEl;
}

async function sendAnalysisChatMessage() {
  const input = document.getElementById("analysis-chat-input");
  if (!input) return;
  const question = input.value.trim();
  if (!question) return;

  if (!kanbanState.analysis) {
    showError("请先生成审查分析报告");
    return;
  }

  const config = window.AI.loadAIConfig();
  const provider = window.AI.getCurrentProvider(config);
  if (!provider || !provider.apiKey) {
    showError("请先配置 AI 服务（API Key）");
    return;
  }

  // Add user message to history and UI
  analysisChatHistory.push({ role: "user", content: question });
  appendAnalysisChatMessage("user", question);
  input.value = "";

  // Build messages: system prompt + original OCR content + AI report + chat history
  const messages = [
    { role: "system", content: kanbanState.analysisSystemPrompt },
    { role: "user", content: kanbanState.analysisUserMessage },
    { role: "assistant", content: kanbanState.analysis },
    ...analysisChatHistory,
  ];

  // Add assistant placeholder
  const assistantMsgEl = appendAnalysisChatMessage("assistant", "");
  const sendBtn = document.getElementById("analysis-chat-send-btn");
  const abortBtn = document.getElementById("analysis-chat-abort-btn");
  if (sendBtn) sendBtn.disabled = true;
  if (abortBtn) abortBtn.classList.remove("hidden");
  analysisChatAbortController = new AbortController();

  try {
    let fullResponse = "";
    const stream = window.AI.streamChat(provider.type, provider.apiKey, provider.baseUrl, {
      model: provider.model,
      messages: messages,
      temperature: 0.3,
      maxTokens: 8192,
    }, analysisChatAbortController.signal);

    const messagesEl = document.getElementById("analysis-chat-messages");
    let _rafPending = false;
    let _lastRenderLen = 0;
    for await (const chunk of stream) {
      if (analysisChatAbortController.signal.aborted) break;
      if (chunk.content) {
        fullResponse += chunk.content;
        if (assistantMsgEl && !_rafPending) {
          _rafPending = true;
          requestAnimationFrame(() => {
            _rafPending = false;
            if (fullResponse.length - _lastRenderLen > 20 || fullResponse.length < 50) {
              _lastRenderLen = fullResponse.length;
              const contentEl = assistantMsgEl.querySelector(".chat-msg-content") || assistantMsgEl;
              contentEl.innerHTML = renderMarkdown(fullResponse);
            }
          });
        }
      }
    }
    // Final render to ensure complete content is displayed
    if (assistantMsgEl) {
      const contentEl = assistantMsgEl.querySelector(".chat-msg-content") || assistantMsgEl;
      contentEl.innerHTML = renderMarkdown(fullResponse);
    }

    analysisChatHistory.push({ role: "assistant", content: fullResponse });
  } catch (e) {
    if (e.name !== "AbortError") {
      appendAnalysisChatMessage("system", "AI 响应出错: " + e.message);
    }
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    if (abortBtn) abortBtn.classList.add("hidden");
    analysisChatAbortController = null;
  }
}

// Analysis chat event listeners (script loaded at end of body, DOM is ready)
(function initAnalysisChat() {
  const analysisChatFloatBall = document.getElementById("analysis-chat-float-ball");
  const analysisChatPanel = document.getElementById("analysis-chat-panel");
  const analysisChatCloseBtn = document.getElementById("analysis-chat-close-btn");
  const analysisChatClearBtn = document.getElementById("analysis-chat-clear-btn");
  const analysisChatSendBtn = document.getElementById("analysis-chat-send-btn");
  const analysisChatAbortBtnEl = document.getElementById("analysis-chat-abort-btn");
  const analysisChatInput = document.getElementById("analysis-chat-input");

  if (analysisChatFloatBall) {
    analysisChatFloatBall.addEventListener("click", () => {
      if (analysisChatPanel) {
        analysisChatPanel.classList.toggle("hidden");
        if (!analysisChatPanel.classList.contains("hidden")) {
          if (analysisChatInput) analysisChatInput.focus();
        }
      }
    });
  }

  if (analysisChatCloseBtn) {
    analysisChatCloseBtn.addEventListener("click", () => {
      if (analysisChatPanel) analysisChatPanel.classList.add("hidden");
    });
  }

  if (analysisChatClearBtn) {
    analysisChatClearBtn.addEventListener("click", () => {
      analysisChatHistory = [];
      const messagesEl = document.getElementById("analysis-chat-messages");
      if (messagesEl) messagesEl.innerHTML = "";
      appendAnalysisChatMessage("system", "对话已清空，可继续提问");
    });
  }

  if (analysisChatSendBtn) {
    analysisChatSendBtn.addEventListener("click", sendAnalysisChatMessage);
  }

  if (analysisChatInput) {
    analysisChatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendAnalysisChatMessage();
      }
    });
  }

  if (analysisChatAbortBtnEl) {
    analysisChatAbortBtnEl.addEventListener("click", () => {
      if (analysisChatAbortController) {
        analysisChatAbortController.abort();
        analysisChatAbortController = null;
      }
      analysisChatAbortBtnEl.classList.add("hidden");
      const sendBtn = document.getElementById("analysis-chat-send-btn");
      if (sendBtn) sendBtn.disabled = false;
    });
  }
})();

async function kanbanManualExtract(url, idx, docType) {
  const container = document.getElementById("kanban-extracted-" + idx);
  if (!container) return;
  container.classList.remove("hidden");

  const config = window.AI.loadAIConfig();
  const ocrConfig = window.AI.getOCRConfig(config);
  const engine = ocrConfig.engine || "paddle_ocr_vl";
  const glmApiKey = window.AI.getGlmOcrApiKey(config);

  container.innerHTML = '<p class="extracting">正在提取内容（引擎: ' + escapeHtml(engine) + '）...</p>';

  try {
    let result;
    if (isTauri && currentData) {
      const isUS = currentData.office === "US";
      const urlDocNum = isUS ? currentData.applicationNumber : encodeURIComponent(currentData.docNumber || currentData.applicationNumber);
      const it = kanbanState.documents.find(d => d.idx === idx);
      if (!it) throw new Error("找不到文档信息");
      result = await doExtractText(currentData.office, urlDocNum, it.docId, it.numberOfPages, it.docFormat, engine, engine === "glm_ocr" ? glmApiKey : "");
    } else {
      let extractUrl = url + (url.includes("?") ? "&" : "?") + "engine=" + encodeURIComponent(engine);
      if (engine === "glm_ocr" && glmApiKey) {
        extractUrl += "&api_key=" + encodeURIComponent(glmApiKey);
      }
      const resp = await fetch(extractUrl);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      result = await resp.json();
    }

    if (result.error) {
      container.innerHTML = '<p class="extract-error">' + escapeHtml(result.error) + '</p>';
      return;
    }
    const text = result.text || "";
    const markdown = result.markdown || "";
    if (!text && !markdown) {
      container.innerHTML = '<p class="extract-empty">未能提取到文本</p>';
      return;
    }
    const displayText = markdown || text;
    const blocks = result.blocks || [];
    const pageDimensions = result.page_dimensions || {};
    kanbanState.extractions[idx] = { text, markdown, engine: result.engine, blocks, pageDimensions };
    kanbanState.hasUnsavedWork = true;
    if (blocks.length > 0) {
      blocks.forEach(b => {
        const traceKey = "D" + idx + "_" + b.block_id;
        kanbanState.traceIndex[traceKey] = {
          docIdx: idx,
          page: b.page,
          bbox: b.bbox,
          content: b.content,
          label: b.label,
          originalBlockId: b.block_id,
          pageDimensions: pageDimensions[b.page] || null,
        };
      });
    }
    const blocksInfo = blocks.length > 0 ? ` · ${blocks.length} blocks` : "";
    container.innerHTML = `
      <div class="extracted-header">
        <span class="extracted-engine">引擎: ${escapeHtml(result.engine)}</span>
        <span class="extracted-chars">字符数: ${displayText.length}${blocksInfo}</span>
        <button class="btn-small btn-ai-analyze" data-action="ai-analyze-doc" data-idx="${idx}" data-doctype="${escapeHtml(docType)}">AI 分析</button>
      </div>
      <pre class="extracted-text">${escapeHtml(displayText.length > 8000 ? displayText.substring(0, 8000) + "\n\n[...已截断...]" : displayText)}</pre>
    `;
    autoSaveCache();
  } catch (e) {
    container.innerHTML = '<p class="extract-error">' + escapeHtml(e.message) + '</p>';
  }
}

// ── Merge Export ────────────────────────────────────────────────────────────

function buildMergeDownloadUrl(item) {
  if (!currentData || !item.docId) return null;
  const isJP = currentData.office === "JP";
  const isDE = currentData.office === "DE";
  if (isDE) return null;

  const isUS = currentData.office === "US";
  const urlDocNum = isUS ? currentData.applicationNumber : encodeURIComponent(currentData.docNumber || currentData.applicationNumber);
  const encodedDocId = encodeURIComponent(item.docId);

  if (isJP) {
    const jpDocType = mapJpDocType(item.docCode, item.type);
    if (!jpDocType) return null;
    return `/api/jpo/doc/${jpDocType}/${urlDocNum}`;
  }

  return `/api/gd/doc-content/svc/doccontent/${currentData.office}/${urlDocNum}/${encodedDocId}/${item.numberOfPages}/${item.docFormat}`;
}

function openMergeExportModal() {
  const modal = document.getElementById("merge-export-modal");
  const list = document.getElementById("merge-export-list");
  const selectAllCb = document.getElementById("merge-select-all-cb");
  const countEl = document.getElementById("merge-selected-count");
  const doBtn = document.getElementById("merge-export-do-btn");
  const progressEl = document.getElementById("merge-export-progress");

  if (!modal || !list) return;

  // Sort all documents by date descending (newest first)
  const items = [...(kanbanState.documents || [])].sort((a, b) => {
    const parseDate = (d) => {
      if (!d) return 0;
      // Handle formats: "2024-01-15", "01/15/2024", "2024/01/15", "20240115"
      const cleaned = d.replace(/[\/\-]/g, "-");
      const parts = cleaned.split("-");
      if (parts.length === 3) {
        const [p1, p2, p3] = parts.map(Number);
        // If first part is 4 digits, it's YYYY-MM-DD
        if (p1 > 1000) return new Date(p1, p2 - 1, p3).getTime();
        // If last part is 4 digits, it's MM-DD-YYYY
        if (p3 > 1000) return new Date(p3, p1 - 1, p2).getTime();
      }
      return new Date(d).getTime() || 0;
    };
    return parseDate(b.date) - parseDate(a.date);
  });

  // Build list
  let html = "";
  items.forEach((it, idx) => {
    const downloadUrl = buildMergeDownloadUrl(it);
    const canDownload = !!downloadUrl;
    const typeNames = {
      "office_action": "审查意见", "response": "答复", "request": "请求",
      "allowance": "授权", "notification": "通知", "misc": "其他"
    };

    html += `
      <div class="merge-export-item ${canDownload ? '' : 'disabled'}" data-idx="${it.idx}" data-date="${escapeHtml(it.date || '')}" data-url="${downloadUrl || ''}" data-search-text="${escapeHtml((it.name + ' ' + it.desc + ' ' + it.docCode + ' ' + it.date + ' ' + (typeNames[it.type] || '')).toLowerCase())}">
        <input type="checkbox" class="merge-item-cb" ${canDownload ? 'checked' : 'disabled'} data-idx="${it.idx}">
        <div class="merge-export-item-info">
          <div class="merge-export-item-title">${escapeHtml(it.name || it.desc || it.docCode)}</div>
          <div class="merge-export-item-meta">
            <span class="merge-export-item-code">${escapeHtml(it.docCode)}</span>
            ${it.date ? '<span>' + escapeHtml(it.date) + '</span>' : ''}
            <span>${typeNames[it.type] || it.type || ''}</span>
            ${!canDownload ? '<span style="color:#e74c3c">不可下载</span>' : ''}
          </div>
        </div>
      </div>
    `;
  });
  list.innerHTML = html;

  // Update select all state
  const checkboxes = list.querySelectorAll(".merge-item-cb:not(:disabled)");
  selectAllCb.checked = checkboxes.length > 0 && [...checkboxes].every(cb => cb.checked);

  // Update count
  updateMergeSelectedCount();

  // Reset progress
  if (progressEl) progressEl.classList.add("hidden");
  if (doBtn) { doBtn.disabled = false; doBtn.textContent = "合并导出 PDF"; }

  // Show modal
  modal.classList.remove("hidden");

  // Bind events
  selectAllCb.onchange = () => {
    const cbs = list.querySelectorAll(".merge-item-cb:not(:disabled)");
    cbs.forEach(cb => { cb.checked = selectAllCb.checked; });
    updateMergeSelectedCount();
  };

  list.querySelectorAll(".merge-item-cb").forEach(cb => {
    cb.onchange = () => {
      const allCbs = list.querySelectorAll(".merge-item-cb:not(:disabled)");
      selectAllCb.checked = allCbs.length > 0 && [...allCbs].every(c => c.checked);
      updateMergeSelectedCount();
    };
  });

  // Bind search filter
  const searchInput = document.getElementById("merge-search-input");
  if (searchInput) {
    searchInput.value = "";
    searchInput.oninput = () => {
      const keyword = searchInput.value.trim().toLowerCase();
      list.querySelectorAll(".merge-export-item").forEach(item => {
        if (!keyword) {
          item.style.display = "";
          return;
        }
        const searchText = item.dataset.searchText || "";
        item.style.display = searchText.includes(keyword) ? "" : "none";
      });
    };
  }
}

function updateMergeSelectedCount() {
  const list = document.getElementById("merge-export-list");
  const countEl = document.getElementById("merge-selected-count");
  const doBtn = document.getElementById("merge-export-do-btn");
  if (!list || !countEl) return;

  const checked = list.querySelectorAll(".merge-item-cb:checked").length;
  countEl.textContent = `已选 ${checked} 份`;
  if (doBtn) doBtn.disabled = checked === 0;
}

async function doMergeExportWithItems(selectedIdxs, progressCallback) {
  // Build merge items from selected document indices
  const selectedItems = [];
  const sortedDocs = [...selectedIdxs].sort((a, b) => {
    const itA = kanbanState.documents.find(d => d.idx === a);
    const itB = kanbanState.documents.find(d => d.idx === b);
    const parseDateFn = (d) => {
      if (!d) return 0;
      const cleaned = d.replace(/[\/\-]/g, "-");
      const parts = cleaned.split("-");
      if (parts.length === 3) {
        const [p1, p2, p3] = parts.map(Number);
        if (p1 > 1000) return new Date(p1, p2 - 1, p3).getTime();
        if (p3 > 1000) return new Date(p3, p1 - 1, p2).getTime();
      }
      return new Date(d).getTime() || 0;
    };
    return parseDateFn(itB ? itB.date : "") - parseDateFn(itA ? itA.date : "");
  });

  for (const idx of sortedDocs) {
    const it = kanbanState.documents.find(d => d.idx === idx);
    if (!it) continue;
    const downloadUrl = buildMergeDownloadUrl(it);
    if (!downloadUrl) continue;

    const name = it.name || it.desc || it.docCode || "";
    const hasCjk = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(name);
    let chineseTitle = "";
    let originalTitle = "";

    if (hasCjk) {
      const match = name.match(/^(.+?)\s*\((.+)\)$/);
      if (match) {
        chineseTitle = match[1];
        originalTitle = match[2];
      } else {
        chineseTitle = name;
        originalTitle = "";
      }
    } else {
      chineseTitle = it.docCode || name;
      originalTitle = name;
    }

    selectedItems.push({
      idx,
      downloadUrl,
      originalTitle,
      chineseTitle,
      date: it.date || "",
      docCode: it.docCode || "",
    });
  }

  if (selectedItems.length === 0) {
    showError("请至少选择一份可下载的文档");
    return;
  }

  // Build patent bibliographic info for cover pages
  const patentInfo = {};
  if (currentData) {
    patentInfo.patentNumber = patentInput ? patentInput.value.trim() : (currentData.applicationNumber || currentData.docNumber || "");
    patentInfo.office = currentData.office || "";
    patentInfo.applicationNumber = currentData.applicationNumber || "";
    if (currentData.family) {
      const members = extractFamilyMembers(currentData.family);
      if (members.length > 0) {
        const m = members.find(mem => mem.countryCode === currentData.office) || members[0];
        const dl = m.docList || {};
        patentInfo.title = m.title || dl.title || m.inventionTitle || "";
        const applicantNamesArr = m.applicantNames || dl.applicantNames || [];
        const namesStr = Array.isArray(applicantNamesArr) ? applicantNamesArr.join(", ") : (applicantNamesArr || "");
        if (currentData.office === "US") {
          patentInfo.inventors = namesStr || m.inventors || m.inventorName || "";
        } else {
          patentInfo.applicants = namesStr || m.applicants || m.applicantName || "";
          patentInfo.inventors = m.inventors || m.inventorName || "";
        }
        patentInfo.filingDate = m.appDateStr || m.filingDate || m.applicationDate || "";
      }
    }
  }

  if (progressCallback) progressCallback("start", selectedItems.length);

  try {
    const resp = await fetch("/api/merge-pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: selectedItems, patentInfo }),
    });

    if (progressCallback) progressCallback("merging");

    const contentType = resp.headers.get("Content-Type") || "";

    if (contentType.includes("application/pdf")) {
      const blob = await resp.blob();
      if (progressCallback) progressCallback("done");

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `merged_patent_docs_${new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else {
      const data = await resp.json();
      throw new Error(data.error || "合并导出失败");
    }
  } catch (e) {
    if (progressCallback) progressCallback("error", e.message);
    showError("合并导出失败: " + e.message);
  }
}

async function doMergeExport() {
  const list = document.getElementById("merge-export-list");
  const doBtn = document.getElementById("merge-export-do-btn");
  const progressEl = document.getElementById("merge-export-progress");
  const progressFill = document.getElementById("merge-progress-fill");
  const progressText = document.getElementById("merge-progress-text");

  if (!list) return;

  // Collect selected item indices
  const selectedIdxs = [];
  list.querySelectorAll(".merge-item-cb:checked").forEach(cb => {
    selectedIdxs.push(parseInt(cb.dataset.idx));
  });

  if (selectedIdxs.length === 0) {
    showError("请至少选择一份文档");
    return;
  }

  // Show progress
  if (doBtn) { doBtn.disabled = true; doBtn.textContent = "导出中..."; }
  if (progressEl) progressEl.classList.remove("hidden");
  if (progressFill) progressFill.style.width = "10%";
  if (progressText) progressText.textContent = `正在下载 ${selectedIdxs.length} 份文档...`;

  await doMergeExportWithItems(selectedIdxs, (stage, detail) => {
    if (stage === "start") {
      if (progressText) progressText.textContent = `正在下载 ${detail} 份文档...`;
    } else if (stage === "merging") {
      if (progressFill) progressFill.style.width = "80%";
      if (progressText) progressText.textContent = "正在合并 PDF...";
    } else if (stage === "done") {
      if (progressFill) progressFill.style.width = "100%";
      if (progressText) progressText.textContent = "导出完成！";
      setTimeout(() => {
        const modal = document.getElementById("merge-export-modal");
        if (modal) modal.classList.add("hidden");
      }, 1500);
    } else if (stage === "error") {
      if (progressText) progressText.textContent = "导出失败: " + detail;
      if (progressFill) { progressFill.style.width = "100%"; progressFill.style.background = "#e74c3c"; }
    }
  });

  if (doBtn) { doBtn.disabled = false; doBtn.textContent = "合并导出 PDF"; }
}

// ── History sidebar toggle ──
const historySidebar = document.getElementById("history-sidebar");
const historySidebarEdgeToggle = document.querySelector(".history-sidebar-edge-toggle");
if (historySidebarEdgeToggle && historySidebar) {
  historySidebarEdgeToggle.addEventListener("click", () => {
    historySidebar.classList.toggle("collapsed");
    // Refresh list when expanding
    if (!historySidebar.classList.contains("collapsed")) {
      refreshHistoryList();
    }
  });
}

// ── History delete / batch operations ──
function updateHistoryBatchCount() {
  const checked = document.querySelectorAll('.history-item-checkbox:checked');
  const countEl = document.getElementById("history-batch-count");
  const deleteBtn = document.getElementById("history-batch-delete-btn");
  const selectAllCb = document.getElementById("history-select-all-cb");
  const totalCbs = document.querySelectorAll('.history-item-checkbox');
  if (countEl) countEl.textContent = "已选 " + checked.length + " 项";
  if (deleteBtn) deleteBtn.disabled = checked.length === 0;
  if (selectAllCb) selectAllCb.checked = totalCbs.length > 0 && checked.length === totalCbs.length;
}

const historySelectBtn = document.getElementById("history-select-btn");
const historyBatchBar = document.getElementById("history-batch-bar");
const historyListEl = document.getElementById("history-list");
if (historySelectBtn && historyBatchBar && historyListEl) {
  historySelectBtn.addEventListener("click", () => {
    const entering = !historyListEl.classList.contains("select-mode");
    historyListEl.classList.toggle("select-mode", entering);
    historyBatchBar.classList.toggle("hidden", !entering);
    refreshHistoryList();
  });

  // Cancel batch mode
  const batchCancelBtn = document.getElementById("history-batch-cancel-btn");
  if (batchCancelBtn) {
    batchCancelBtn.addEventListener("click", () => {
      historyListEl.classList.remove("select-mode");
      historyBatchBar.classList.add("hidden");
      refreshHistoryList();
    });
  }

  // Select all
  const selectAllCb = document.getElementById("history-select-all-cb");
  if (selectAllCb) {
    selectAllCb.addEventListener("change", () => {
      document.querySelectorAll('.history-item-checkbox').forEach(cb => { cb.checked = selectAllCb.checked; });
      updateHistoryBatchCount();
    });
  }

  // Batch delete
  const batchDeleteBtn = document.getElementById("history-batch-delete-btn");
  if (batchDeleteBtn) {
    batchDeleteBtn.addEventListener("click", () => {
      const checked = document.querySelectorAll('.history-item-checkbox:checked');
      if (checked.length === 0) return;
      if (!confirm("确认删除选中的 " + checked.length + " 条历史记录？")) return;
      checked.forEach(cb => {
        const pn = cb.dataset.patent;
        const type = cb.dataset.type;
        if (type === "patent") {
          PatentCache.removePatentHistory(pn);
        } else {
          PatentCache.removeHistory(pn);
          PatentCache.remove(pn);
        }
      });
      historyListEl.classList.remove("select-mode");
      historyBatchBar.classList.add("hidden");
      refreshHistoryList();
    });
  }
}

// Clear all history
const historyClearBtn = document.getElementById("history-clear-btn");
if (historyClearBtn) {
  historyClearBtn.addEventListener("click", () => {
    if (!confirm("确定要清空全部历史记录吗？此操作不可撤销（缓存中的数据不会被删除）。")) return;
    PatentCache.clearAllHistory();
    refreshHistoryList();
  });
}

// ── Cache clear button in settings ──
const cacheClearBtn = document.getElementById("cache-clear-btn");
if (cacheClearBtn) {
  cacheClearBtn.addEventListener("click", () => {
    if (confirm("确定要清除全部缓存和历史记录吗？此操作不可撤销。")) {
      PatentCache.clearAll();
      PatentCache.clearAllHistory();
      refreshHistoryList();
    }
  });
}

// ── Network settings (Google Patents proxy) ──
const gpProxyCheckbox = document.getElementById("gp-proxy-checkbox");
const gpProxyUrlGroup = document.getElementById("gp-proxy-url-group");
const gpProxyUrlInput = document.getElementById("gp-proxy-url-input");
const networkSaveBtn = document.getElementById("network-save-btn");

if (gpProxyCheckbox) {
  // Load saved settings
  const savedProxy = getGpProxySettings();
  gpProxyCheckbox.checked = !!savedProxy.enabled;
  if (gpProxyUrlInput) gpProxyUrlInput.value = savedProxy.proxyUrl || "";
  if (gpProxyUrlGroup) gpProxyUrlGroup.style.display = savedProxy.enabled ? "" : "none";

  gpProxyCheckbox.addEventListener("change", () => {
    if (gpProxyUrlGroup) gpProxyUrlGroup.style.display = gpProxyCheckbox.checked ? "" : "none";
  });
}

if (networkSaveBtn) {
  networkSaveBtn.addEventListener("click", () => {
    const enabled = gpProxyCheckbox ? gpProxyCheckbox.checked : false;
    const proxyUrl = gpProxyUrlInput ? gpProxyUrlInput.value.trim() : "";
    saveGpProxySettings(enabled, proxyUrl);
    networkSaveBtn.textContent = "已保存 ✓";
    setTimeout(() => { networkSaveBtn.textContent = "保存"; }, 1500);
  });
}

// ── EPO OPS 降级查询配置 ──────────────────────────────────────────────────────
const opsEnabledCheckbox = document.getElementById("ops-enabled-checkbox");
const opsConsumerKeyInput = document.getElementById("ops-consumer-key-input");
const opsConsumerSecretInput = document.getElementById("ops-consumer-secret-input");
const opsSaveBtn = document.getElementById("ops-save-btn");
const opsTestBtn = document.getElementById("ops-test-btn");
const opsTestResult = document.getElementById("ops-test-result");
const opsQuotaDisplayGroup = document.getElementById("ops-quota-display-group");
const opsRefreshQuotaBtn = document.getElementById("ops-refresh-quota-btn");

// 回填 OPS 配置到表单（由 loadAISettingsToForm 调用）
function loadOpsSettingsToForm() {
  const ops = getOpsSettings();
  if (opsEnabledCheckbox) opsEnabledCheckbox.checked = ops.enabled;
  if (opsConsumerKeyInput) opsConsumerKeyInput.value = ops.consumerKey;
  if (opsConsumerSecretInput) opsConsumerSecretInput.value = ops.consumerSecret;
  // 显示配额区域（如果有 key）
  if (opsQuotaDisplayGroup && ops.consumerKey) {
    opsQuotaDisplayGroup.style.display = "";
    refreshOpsQuota();
  }
}

// 刷新 OPS 配额显示
async function refreshOpsQuota() {
  const ops = getOpsSettings();
  if (!ops.consumerKey || !ops.consumerSecret) return;
  try {
    const resp = await fetch("/api/ops/quota?opsKey=" + encodeURIComponent(ops.consumerKey) + "&opsSecret=" + encodeURIComponent(ops.consumerSecret));
    const data = await resp.json();
    if (data.success && data.quota) {
      const q = data.quota;
      const throttleEl = document.getElementById("ops-quota-throttle");
      const hourEl = document.getElementById("ops-quota-hour");
      const weekEl = document.getElementById("ops-quota-week");
      const updatedEl = document.getElementById("ops-quota-updated");
      if (throttleEl) {
        throttleEl.textContent = "状态: " + (q.throttle || "未知");
        // 根据 throttle 状态着色：green=绿，busy/yellow=黄，red=红
        if (q.throttle && q.throttle.includes("green")) throttleEl.style.color = "var(--success)";
        else if (q.throttle && q.throttle.includes("red")) throttleEl.style.color = "var(--danger)";
        else throttleEl.style.color = "var(--warning)";
      }
      if (hourEl) hourEl.textContent = "每小时配额已用: " + (q.hourUsed != null ? q.hourUsed : "-");
      if (weekEl) weekEl.textContent = "每周配额已用: " + (q.weekUsed != null ? q.weekUsed : "-");
      if (updatedEl && q.updatedAt) updatedEl.textContent = "最后更新: " + new Date(q.updatedAt).toLocaleString();
    }
  } catch (e) { /* ignore */ }
}

// OPS 保存按钮
if (opsSaveBtn) {
  opsSaveBtn.addEventListener("click", () => {
    const config = window.AI.loadAIConfig();
    if (!config.ops) config.ops = { consumerKey: "", consumerSecret: "" };
    config.ops.consumerKey = opsConsumerKeyInput ? opsConsumerKeyInput.value.trim() : "";
    config.ops.consumerSecret = opsConsumerSecretInput ? opsConsumerSecretInput.value.trim() : "";
    window.AI.saveAIConfig(config);
    localStorage.setItem("patentlens_ops_enabled", opsEnabledCheckbox && opsEnabledCheckbox.checked ? "true" : "false");
    opsSaveBtn.textContent = "已保存 ✓";
    setTimeout(() => { opsSaveBtn.textContent = "保存"; }, 1500);
    // 保存后显示配额区域
    if (opsQuotaDisplayGroup && config.ops.consumerKey) {
      opsQuotaDisplayGroup.style.display = "";
      refreshOpsQuota();
    }
  });
}

// OPS 测试连接按钮（通过查询一个已知存在的专利号 EP1000000 测试）
if (opsTestBtn) {
  opsTestBtn.addEventListener("click", async () => {
    const key = opsConsumerKeyInput ? opsConsumerKeyInput.value.trim() : "";
    const secret = opsConsumerSecretInput ? opsConsumerSecretInput.value.trim() : "";
    if (!key || !secret) {
      if (opsTestResult) {
        opsTestResult.classList.remove("hidden");
        opsTestResult.textContent = "请先填写 Consumer Key 和 Secret";
        opsTestResult.style.color = "var(--danger)";
      }
      return;
    }
    opsTestBtn.disabled = true;
    opsTestBtn.textContent = "测试中...";
    if (opsTestResult) {
      opsTestResult.classList.remove("hidden");
      opsTestResult.textContent = "正在查询 EP1000000 验证连接...";
      opsTestResult.style.color = "var(--text-secondary)";
    }
    try {
      // 用 EP1000000 测试（EPO 官方示例专利号）
      const resp = await fetch("/api/gp/EP1000000?opsKey=" + encodeURIComponent(key) + "&opsSecret=" + encodeURIComponent(secret));
      const data = await resp.json();
      if (data.success && data.data_source === "EPO OPS") {
        if (opsTestResult) {
          opsTestResult.textContent = "✓ 连接成功！OPS 降级查询可用。验证专利: " + (data.data.title || "EP1000000");
          opsTestResult.style.color = "var(--success)";
        }
        refreshOpsQuota();
      } else if (data.success) {
        if (opsTestResult) {
          opsTestResult.textContent = "✓ 凭证有效（Google Patents 已返回数据，未触发 OPS 降级）。可尝试查询 Google Patents 没有的专利号验证降级。";
          opsTestResult.style.color = "var(--success)";
        }
        refreshOpsQuota();
      } else {
        if (opsTestResult) {
          opsTestResult.textContent = "✗ 测试失败: " + (data.error || "未知错误") + "（注意：EP1000000 在 Google Patents 和 OPS 都应存在，若失败请检查凭证）";
          opsTestResult.style.color = "var(--danger)";
        }
      }
    } catch (e) {
      if (opsTestResult) {
        opsTestResult.textContent = "✗ 请求失败: " + e.message;
        opsTestResult.style.color = "var(--danger)";
      }
    } finally {
      opsTestBtn.disabled = false;
      opsTestBtn.textContent = "测试连接";
    }
  });
}

// OPS 刷新配额按钮
if (opsRefreshQuotaBtn) {
  opsRefreshQuotaBtn.addEventListener("click", refreshOpsQuota);
}

// OPS 配额 20 分钟自动刷新（与后端配额缓存 TTL 对齐）
setInterval(() => {
  const ops = getOpsSettings();
  if (ops.consumerKey && ops.consumerSecret) {
    refreshOpsQuota();
  }
}, 20 * 60 * 1000);

// ════════════════════════════════════════════════════════════════
//  ① 批量查询 + 标签页管理 + ② 页内查找 （新增功能）
// ════════════════════════════════════════════════════════════════

// ── 全屏专利详情标签页状态（session 级，页面关闭即清除） ──
const _pdOpenPatents = [];
let _pdActivePatent = null;
const _pdPatentCache = {};
let _pdBatchMode = false;
let _pdBatchController = null;

// ── DOM 引用 ──
const batchSearchToggleBtn = document.getElementById("batch-search-toggle-btn");
const batchSearchPanel = document.getElementById("batch-search-panel");
const batchInput = document.getElementById("batch-input");
const batchCount = document.getElementById("batch-count");
const batchSearchBtn = document.getElementById("batch-search-btn");
const batchClearBtn = document.getElementById("batch-clear-btn");
const batchResultsSection = document.getElementById("batch-results-section");
const batchResultsGrid = document.getElementById("batch-results-grid");
const batchProgress = document.getElementById("batch-progress");
const batchBackBtn = document.getElementById("batch-back-btn");
const pdTabsBar = document.getElementById("patent-detail-tabs-bar");
const pdFindBar = document.getElementById("patent-detail-find-bar");
const pdFindInput = document.getElementById("pd-find-input");
const pdFindPrev = document.getElementById("pd-find-prev");
const pdFindNext = document.getElementById("pd-find-next");
const pdFindCount = document.getElementById("pd-find-count");
const pdFindClose = document.getElementById("pd-find-close");

// ── 批量查询面板切换 ──
if (batchSearchToggleBtn) {
  batchSearchToggleBtn.addEventListener("click", () => {
    if (batchSearchPanel.classList.contains("hidden")) {
      batchSearchPanel.classList.remove("hidden");
      batchInput.focus();
    } else {
      batchSearchPanel.classList.add("hidden");
    }
  });
}

// ── 批量输入计数 ──
if (batchInput) {
  batchInput.addEventListener("input", () => {
    const nums = batchInput.value.split("\n").map(s => s.trim()).filter(s => s.length > 0);
    const count = Math.min(nums.length, 10);
    if (batchCount) batchCount.textContent = count + "/10";
    if (nums.length > 10) {
      batchCount.style.color = "var(--danger)";
    } else {
      batchCount.style.color = "";
    }
  });
}

// ── 批量清空 ──
if (batchClearBtn) {
  batchClearBtn.addEventListener("click", () => {
    if (batchInput) batchInput.value = "";
    if (batchCount) batchCount.textContent = "0/10";
  });
}

// ── 批量面板收起 ──
const batchCloseBtn = document.getElementById("batch-close-btn");
if (batchCloseBtn) {
  batchCloseBtn.addEventListener("click", () => {
    batchSearchPanel.classList.add("hidden");
  });
}

// ── 批量返回搜索 ──
if (batchBackBtn) {
  batchBackBtn.addEventListener("click", () => {
    _pdBatchMode = false;
    batchResultsSection.classList.add("hidden");
    if (_pdOpenPatents.length === 0) {
      patentDetailSection.classList.add("hidden");
    }
    // Show batch search input panel again
    if (batchSearchPanel) batchSearchPanel.classList.remove("hidden");
  });
}

// ── 带重试的 GP API 抓取（共享） ──
async function fetchPatentWithRetry(patentNumber, maxRetries = 2) {
  const raw = patentNumber.trim().toUpperCase().replace(/[\s\/]/g, "");
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 4000);
        await new Promise(r => setTimeout(r, delay));
      }
      const resp = await fetch(gpApiUrl(raw));
      if (!resp.ok) {
        lastErr = new Error("HTTP " + resp.status);
        continue;
      }
      const ct = resp.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        const text = await resp.text();
        lastErr = new Error("服务器返回了非JSON响应（" + ct.substring(0, 50) + "）");
        continue;
      }
      const json = await resp.json();
      if (json.success) {
        return json;
      }
      lastErr = new Error(json.error || "未找到该专利");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("查询失败");
}

// ── 限流延迟 ──
function _delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 批量查询执行 ──
if (batchSearchBtn) {
  batchSearchBtn.addEventListener("click", async () => {
    const lines = batchInput.value.split("\n").map(s => s.trim()).filter(s => s.length > 0);
    let numbers = [...new Set(lines.map(s => s.toUpperCase().replace(/[\s\/]/g, "")))].slice(0, 10);
    if (numbers.length === 0) {
      showError("请输入至少一个专利号");
      return;
    }

    _pdBatchMode = true;
    // Don't clear _pdPatentCache - keep previously fetched data for reuse
    // Only remove patents not in the current batch list
    const batchSet = new Set(numbers);
    Object.keys(_pdPatentCache).forEach(k => {
      if (!batchSet.has(k)) delete _pdPatentCache[k];
    });
    _pdOpenPatents.length = 0;
    _pdActivePatent = null;
    batchSearchPanel.classList.add("hidden");
    batchResultsSection.classList.remove("hidden");
    patentDetailSection.classList.add("hidden");
    resultSection.classList.add("hidden");
    hideError();
    _renderPdTabs();

    batchResultsGrid.innerHTML = "";
    const cards = {};
    numbers.forEach(pn => {
      const card = document.createElement("div");
      // Check cache first - session cache or localStorage GP cache
      const sessionCached = _pdPatentCache[pn];
      const lsCached = GPCache.get(pn);

      if (sessionCached || lsCached) {
        // Cache hit - show done state immediately
        const data = sessionCached || lsCached;
        if (!sessionCached && lsCached) _pdPatentCache[pn] = lsCached;
        card.className = "batch-result-card done cached";
        card.dataset.pn = pn;
        cards[pn] = card;
        batchResultsGrid.appendChild(card);
        _updateBatchCardDone(card, pn, data);
        // Update "cached" badge
        const statusEl = card.querySelector(".batch-card-status");
        if (statusEl) {
          statusEl.textContent = "缓存";
          statusEl.className = "batch-card-status cached";
          statusEl.style.background = "#e8f5e9";
          statusEl.style.color = "#2e7d32";
        }
      } else {
        card.className = "batch-result-card loading";
        card.dataset.pn = pn;
        card.innerHTML = `
          <div class="batch-card-thumb"><div class="batch-card-thumb-spinner"></div></div>
          <div class="batch-card-body">
            <div class="batch-card-pn">${escapeHtml(pn)} <span class="batch-card-status loading">查询中</span></div>
            <div class="batch-card-links">
              <a href="https://patents.google.com/patent/${encodeURIComponent(pn)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">GP</a>
              <a href="https://worldwide.espacenet.com/patent/search?q=${encodeURIComponent(pn)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Espacenet</a>
            </div>
          </div>`;
        card.addEventListener("click", () => {
          if (_pdPatentCache[pn]) {
            _openPdPatent(pn);
          }
        });
        batchResultsGrid.appendChild(card);
        cards[pn] = card;
      }
    });

    let completed = 0;
    let succeeded = 0;
    let fromCache = 0;
    const total = numbers.length;

    for (let i = 0; i < numbers.length; i++) {
      const pn = numbers[i];
      const card = cards[pn];

      // Skip if already loaded from cache
      if (_pdPatentCache[pn]) {
        completed++;
        succeeded++;
        fromCache++;
        if (batchProgress) batchProgress.textContent = `进度: ${completed}/${total} 完成 (${succeeded} 成功, ${completed - succeeded} 失败, ${fromCache} 缓存命中)`;
        continue;
      }

      if (batchProgress) batchProgress.textContent = `进度: ${i}/${total} 完成 (${succeeded} 成功, ${i - succeeded} 失败, ${fromCache} 缓存命中)`;

      try {
        const json = await fetchPatentWithRetry(pn, 2);
        if (json.data && json.data.data_source !== "Espacenet") {
          _pdPatentCache[pn] = json.data;
          GPCache.set(pn, json.data);
        }
        succeeded++;
        _updateBatchCardDone(card, pn, json.data);
      } catch (err) {
        _updateBatchCardError(card, pn, err.message);
      }
      completed++;
      if (batchProgress) batchProgress.textContent = `进度: ${completed}/${total} 完成 (${succeeded} 成功, ${completed - succeeded} 失败, ${fromCache} 缓存命中)`;

      if (i < numbers.length - 1 && !_pdPatentCache[numbers[i+1]]) {
        await _delay(1200);
      }
    }
  });
}

function _updateBatchCardDone(card, pn, data) {
  card.classList.remove("loading");
  card.classList.add("done");

  if (data && data.data_source === "Espacenet") {
    card.innerHTML = `
      <div class="batch-card-thumb"><div class="batch-card-thumb-placeholder">🌐</div></div>
      <div class="batch-card-body">
        <div class="batch-card-pn">${escapeHtml(pn)} <span class="batch-card-status" style="background:#e3f2fd;color:#1565c0">Espacenet</span></div>
        <div class="batch-card-title" style="color:var(--text-secondary)">Google Patents 未收录，需在 Espacenet 中查看</div>
        <div class="batch-card-links">
          <a href="https://patents.google.com/patent/${encodeURIComponent(pn)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">GP</a>
          <a href="https://worldwide.espacenet.com/patent/search?q=${encodeURIComponent(pn)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Espacenet</a>
          <button onclick="event.stopPropagation();openInAppWebview('https://worldwide.espacenet.com/patent/search?q=${encodeURIComponent(pn)}','Espacenet: ${escapeHtml(pn)}')">打开查看</button>
        </div>
      </div>`;
    card.style.cursor = "pointer";
    card.onclick = () => { openInAppWebview("https://worldwide.espacenet.com/patent/search?q=" + encodeURIComponent(pn), "Espacenet: " + pn); };
    return;
  }

  const thumb = (data.drawings && data.drawings.length > 0) ? data.drawings[0] : null;
  const abstract = (data.abstract || "").substring(0, 120) + (data.abstract && data.abstract.length > 120 ? "..." : "");
  const title = data.title || "无标题";
  const date = data.publication_date || data.application_date || "";
  const applicant = (data.assignees || []).join("; ") || "";

  card.innerHTML = `
    <div class="batch-card-thumb">
      ${thumb ? `<img src="${escapeHtml(thumb)}" alt="附图" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="batch-card-thumb-placeholder" style="display:none">📄</div>` : `<div class="batch-card-thumb-placeholder">📄</div>`}
    </div>
    <div class="batch-card-body">
      <div class="batch-card-pn">${escapeHtml(pn)} <span class="batch-card-status done">已获取</span></div>
      <div class="batch-card-title">${escapeHtml(title)}</div>
      <div class="batch-card-meta">
        ${date ? `<span>${escapeHtml(date)}</span>` : ""}
        ${applicant ? `<span>${escapeHtml(applicant.substring(0, 30))}${applicant.length > 30 ? "..." : ""}</span>` : ""}
      </div>
      ${abstract ? `<div class="batch-card-abstract">${escapeHtml(abstract)}</div>` : ""}
      <div class="batch-card-links">
        <a href="https://patents.google.com/patent/${encodeURIComponent(pn)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">GP</a>
        <a href="https://worldwide.espacenet.com/patent/search?q=${encodeURIComponent(pn)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Espacenet</a>
        <button onclick="event.stopPropagation();_openPdPatent('${escapeHtml(pn)}')">打开详情</button>
      </div>
    </div>`;
  card.style.cursor = "pointer";
  card.onclick = () => { _openPdPatent(pn); };
}

function _updateBatchCardError(card, pn, errMsg) {
  card.classList.remove("loading");
  card.classList.add("error");
  card.innerHTML = `
    <div class="batch-card-thumb"><div class="batch-card-thumb-placeholder" style="color:var(--danger)">⚠</div></div>
    <div class="batch-card-body">
      <div class="batch-card-pn">${escapeHtml(pn)} <span class="batch-card-status error">失败</span></div>
      <div class="batch-card-error">${escapeHtml(errMsg || "查询失败")}</div>
      <div class="batch-card-links">
        <a href="https://patents.google.com/patent/${encodeURIComponent(pn)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">GP</a>
        <a href="https://worldwide.espacenet.com/patent/search?q=${encodeURIComponent(pn)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Espacenet</a>
        <button class="batch-card-retry" onclick="event.stopPropagation();_retryBatchCard('${escapeHtml(pn)}', this)">重试</button>
      </div>
    </div>`;
  card.style.cursor = "default";
  card.onclick = null;
}

async function _retryBatchCard(pn, btnEl) {
  const card = btnEl.closest(".batch-result-card");
  if (!card) return;
  card.className = "batch-result-card loading";
  card.innerHTML = `
    <div class="batch-card-thumb"><div class="batch-card-thumb-spinner"></div></div>
    <div class="batch-card-body">
      <div class="batch-card-pn">${escapeHtml(pn)} <span class="batch-card-status loading">重试中</span></div>
      <div class="batch-card-links">
        <a href="https://patents.google.com/patent/${encodeURIComponent(pn)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Google Patents</a>
        <a href="https://worldwide.espacenet.com/patent/search?q=${encodeURIComponent(pn)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">Espacenet</a>
      </div>
    </div>`;
  card.onclick = null;

  try {
    const json = await fetchPatentWithRetry(pn, 2);
    _pdPatentCache[pn] = json.data;
    _updateBatchCardDone(card, pn, json.data);
  } catch (err) {
    _updateBatchCardError(card, pn, err.message);
  }
}

// ── 标签页管理：打开/切换/关闭 ──
function _returnToBatchResults() {
  if (batchResultsSection) {
    patentDetailSection.classList.add("hidden");
    batchResultsSection.classList.remove("hidden");
  }
}

function _renderPdTabs() {
  if (!pdTabsBar) return;
  const appEl = document.getElementById("app");
  if (patentDetailSection) {
    patentDetailSection.classList.toggle("has-tabs", _pdOpenPatents.length > 0);
  }
  if (appEl) {
    appEl.classList.toggle("wide-layout", _pdOpenPatents.length > 0);
  }
  if (_pdOpenPatents.length === 0) {
    pdTabsBar.classList.add("hidden");
    pdTabsBar.innerHTML = "";
    if (pdFindBar) pdFindBar.classList.add("hidden");
    _clearFindHighlights();
    return;
  }
  pdTabsBar.classList.remove("hidden");
  pdTabsBar.innerHTML = "";

  // Add "返回批量结果" button when in batch mode
  if (_pdBatchMode) {
    const backBtn = document.createElement("button");
    backBtn.className = "pdt-back-btn";
    backBtn.innerHTML = "← 返回批量结果";
    backBtn.title = "返回到批量查询结果列表";
    backBtn.addEventListener("click", () => { _returnToBatchResults(); });
    pdTabsBar.appendChild(backBtn);
  }

  _pdOpenPatents.forEach(pn => {
    const tab = document.createElement("div");
    tab.className = "pdt-tab" + (pn === _pdActivePatent ? " active" : "");
    tab.innerHTML = `<span class="pdt-tab-label">${escapeHtml(pn)}</span><span class="pdt-tab-close" title="关闭">&times;</span>`;
    tab.addEventListener("click", (e) => {
      if (e.target.classList.contains("pdt-tab-close")) {
        e.stopPropagation();
        _closePdTab(pn);
      } else {
        _switchPdTab(pn);
      }
    });
    pdTabsBar.appendChild(tab);
  });
}

function _switchPdTab(pn) {
  if (_pdActivePatent === pn) return;
  _pdActivePatent = pn;
  _clearFindHighlights();
  if (pdFindBar) pdFindBar.classList.add("hidden");
  const data = _pdPatentCache[pn];
  if (data) {
    renderPatentDetail(data);
    window._currentPatentData = data;
    patentDetailSection.classList.remove("hidden");
    if (patentInput) patentInput.value = pn;
  }
  _renderPdTabs();
}

function _closePdTab(pn) {
  const idx = _pdOpenPatents.indexOf(pn);
  if (idx === -1) return;
  _pdOpenPatents.splice(idx, 1);
  delete _pdPatentCache[pn];

  if (_pdActivePatent === pn) {
    if (_pdOpenPatents.length > 0) {
      const newIdx = Math.min(idx, _pdOpenPatents.length - 1);
      _pdActivePatent = _pdOpenPatents[newIdx];
      const data = _pdPatentCache[_pdActivePatent];
      if (data) {
        renderPatentDetail(data);
        window._currentPatentData = data;
        if (patentInput) patentInput.value = _pdActivePatent;
      }
    } else {
      _pdActivePatent = null;
      window._currentPatentData = null;
      patentDetailContent.innerHTML = '<p class="placeholder">请输入专利号查询</p>';
      if (patentInput) patentInput.value = "";
      _clearFindHighlights();
      if (pdFindBar) pdFindBar.classList.add("hidden");
    }
  }
  _renderPdTabs();
  if (_pdOpenPatents.length === 0) {
    if (_pdBatchMode && batchResultsSection) {
      // Return to batch results view
      patentDetailSection.classList.add("hidden");
      batchResultsSection.classList.remove("hidden");
    } else {
      patentDetailSection.classList.add("hidden");
    }
  }
}

function _openPdPatent(pn) {
  const raw = pn.trim().toUpperCase().replace(/[\s\/]/g, "");
  if (!raw) return;

  // JP patents in patent-detail mode go through normal GP flow (same as other countries)
  // Only dossier mode (doSearch) redirects JP to J-PlatPat

  clearPrefetchCache();

  const appEl = document.getElementById("app");
  if (appEl && appEl.classList.contains("home-mode")) appEl.classList.remove("home-mode");

  // When opening from batch results, stay in batch mode so user can return to results
  // Only clear batch mode when opening from regular search
  const cameFromBatch = _pdBatchMode && batchResultsSection && !batchResultsSection.classList.contains("hidden");
  if (!cameFromBatch) {
    _pdBatchMode = false;
  }
  if (batchResultsSection) batchResultsSection.classList.add("hidden");
  patentDetailSection.classList.remove("hidden");
  resultSection.classList.add("hidden");

  if (_pdOpenPatents.includes(raw)) {
    _switchPdTab(raw);
    return;
  }

  if (_pdPatentCache[raw]) {
    _pdOpenPatents.push(raw);
    _pdActivePatent = raw;
    renderPatentDetail(_pdPatentCache[raw]);
    window._currentPatentData = _pdPatentCache[raw];
    if (patentInput) patentInput.value = raw;
    _renderPdTabs();
    showDataSourceBadge("本地缓存", "从本地缓存恢复，无需重新查询");
    return;
  }

  // Check localStorage GP cache
  const gpCached = GPCache.get(raw);
  if (gpCached) {
    _pdPatentCache[raw] = gpCached;
    _pdOpenPatents.push(raw);
    _pdActivePatent = raw;
    renderPatentDetail(gpCached);
    window._currentPatentData = gpCached;
    if (patentInput) patentInput.value = raw;
    _renderPdTabs();
    showDataSourceBadge("本地缓存", "从本地缓存恢复，无需重新查询");
    return;
  }

  _pdOpenPatents.push(raw);
  _pdActivePatent = raw;
  patentDetailContent.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-secondary)"><div style="display:inline-block;width:32px;height:32px;border:3px solid var(--border-color);border-top-color:var(--accent);border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:12px"></div><div>正在加载 ' + escapeHtml(raw) + ' ...</div></div>';
  _renderPdTabs();

  fetchPatentWithRetry(raw, 2).then(json => {
    if (_pdActivePatent !== raw) return;

    if (json.data_source === "Espacenet" || (json.data && json.data.data_source === "Espacenet")) {
      const espacenetUrl = json.espacenet_url || (json.data && json.data.espacenet_url) || "";
      const idx = _pdOpenPatents.indexOf(raw);
      if (idx !== -1) _pdOpenPatents.splice(idx, 1);
      delete _pdPatentCache[raw];
      if (_pdOpenPatents.length > 0) {
        const newIdx = Math.min(idx, _pdOpenPatents.length - 1);
        _pdActivePatent = _pdOpenPatents[newIdx];
        const data = _pdPatentCache[_pdActivePatent];
        if (data) { renderPatentDetail(data); window._currentPatentData = data; if (patentInput) patentInput.value = _pdActivePatent; }
      } else {
        _pdActivePatent = null;
        window._currentPatentData = null;
        patentDetailContent.innerHTML = '<p class="placeholder">请输入专利号查询</p>';
        if (patentInput) patentInput.value = "";
      }
      _renderPdTabs();
      openInAppWebview(espacenetUrl, "Espacenet: " + raw);
      return;
    }

    _pdPatentCache[raw] = json.data;
    GPCache.set(raw, json.data);
    renderPatentDetail(json.data);
    window._currentPatentData = json.data;
    if (patentInput) patentInput.value = raw;

    if (json.data_source === "EPO OPS" || (json.data && json.data.data_source === "EPO OPS")) {
      showDataSourceBadge("EPO OPS", "Google Patents 未找到该专利，数据来自 EPO OPS 降级查询");
    } else {
      showDataSourceBadge("Google Patents", null);
    }
    PatentCache.addPatentHistory(raw, {
      applicantName: (json.data.assignees || []).join(", "),
      title: json.data.title || "",
    });
    refreshHistoryList();
  }).catch(err => {
    if (_pdActivePatent !== raw) return;
    const idx = _pdOpenPatents.indexOf(raw);
    if (idx !== -1) _pdOpenPatents.splice(idx, 1);
    delete _pdPatentCache[raw];
    if (_pdOpenPatents.length > 0) {
      const newIdx = Math.min(idx, _pdOpenPatents.length - 1);
      _pdActivePatent = _pdOpenPatents[newIdx];
      const data = _pdPatentCache[_pdActivePatent];
      if (data) {
        renderPatentDetail(data);
        window._currentPatentData = data;
      }
    } else {
      _pdActivePatent = null;
      window._currentPatentData = null;
      patentDetailContent.innerHTML = '<p class="placeholder" style="color:var(--danger)">查询失败: ' + escapeHtml(err.message) + '</p>';
    }
    _renderPdTabs();
    showError("查询 " + raw + " 失败: " + err.message);
  });
}

// ── 在 renderPatentDetail 生成的 header 中注入"页内查找"按钮 ──
// 通过 MutationObserver 监听 patentDetailContent 变化，在 pd-links 中添加查找按钮
const _obsConfig = { childList: true, subtree: false };
let _findBtnInjected = false;
function _injectFindButton() {
  if (!patentDetailContent) return;
  const pdLinks = patentDetailContent.querySelector(".pd-links");
  if (pdLinks && !pdLinks.querySelector(".pd-find-toggle-btn")) {
    const findBtn = document.createElement("button");
    findBtn.className = "pd-gp-link pd-find-toggle-btn";
    findBtn.title = "在本页内查找 (Ctrl+F)";
    findBtn.textContent = "页内查找";
    findBtn.addEventListener("click", togglePdFindBar);
    pdLinks.insertBefore(findBtn, pdLinks.firstChild);
  }
}
const _pdObserver = new MutationObserver(() => { _injectFindButton(); });
if (patentDetailContent) _pdObserver.observe(patentDetailContent, _obsConfig);

// ════════════════════════════════════════════════════════════════
//  ② 专利详情页内查找跳转功能
// ════════════════════════════════════════════════════════════════

let _pdFindMatches = [];
let _pdFindCurrentIdx = -1;
let _pdFindOriginalHTML = null;

function togglePdFindBar() {
  if (!pdFindBar) return;
  if (pdFindBar.classList.contains("hidden")) {
    pdFindBar.classList.remove("hidden");
    pdFindInput.focus();
    pdFindInput.select();
  } else {
    pdFindBar.classList.add("hidden");
    _clearFindHighlights();
  }
}

if (pdFindClose) {
  pdFindClose.addEventListener("click", () => {
    pdFindBar.classList.add("hidden");
    _clearFindHighlights();
  });
}

function _clearFindHighlights() {
  if (!patentDetailContent) return;
  const highlights = patentDetailContent.querySelectorAll(".pd-find-highlight");
  highlights.forEach(h => {
    const parent = h.parentNode;
    parent.replaceChild(document.createTextNode(h.textContent), h);
    parent.normalize();
  });
  _pdFindMatches = [];
  _pdFindCurrentIdx = -1;
  if (pdFindCount) pdFindCount.textContent = "";
}

function _doFind(term) {
  if (!patentDetailContent || !term || term.trim().length === 0) {
    _clearFindHighlights();
    return;
  }
  term = term.trim();
  if (term.length < 1) { _clearFindHighlights(); return; }

  _clearFindHighlights();

  const searchable = patentDetailContent.querySelectorAll(
    ".pd-abstract, .pd-info-value, .pd-class-desc, .pd-claim-text, .pd-description-text, .pd-citation-title, .pd-family-title, .pd-ai-interpret-content p, .pd-event-desc, .pd-document-desc"
  );

  let matchIdx = 0;
  const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");

  function highlightTextNode(node) {
    const text = node.textContent;
    regex.lastIndex = 0;
    let m;
    const matches = [];
    while ((m = regex.exec(text)) !== null) {
      matches.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
      if (m.index === regex.lastIndex) regex.lastIndex++;
    }
    if (matches.length === 0) return 0;

    const frag = document.createDocumentFragment();
    let lastIdx = 0;
    matches.forEach(match => {
      if (match.start > lastIdx) {
        frag.appendChild(document.createTextNode(text.substring(lastIdx, match.start)));
      }
      const mark = document.createElement("mark");
      mark.className = "pd-find-highlight";
      mark.dataset.matchIdx = matchIdx++;
      mark.textContent = match.text;
      frag.appendChild(mark);
      lastIdx = match.end;
    });
    if (lastIdx < text.length) {
      frag.appendChild(document.createTextNode(text.substring(lastIdx)));
    }
    node.parentNode.replaceChild(frag, node);
    return matches.length;
  }

  function walkTextNodes(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: function(n) {
        if (!n.textContent || n.textContent.trim().length === 0) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (p.closest("script, style, button, a, .pd-find-highlight")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    nodes.forEach(highlightTextNode);
  }

  searchable.forEach(walkTextNodes);

  _pdFindMatches = Array.from(patentDetailContent.querySelectorAll(".pd-find-highlight"));
  _pdFindCurrentIdx = _pdFindMatches.length > 0 ? 0 : -1;
  _updateFindCount();
  _scrollToCurrentMatch();
}

function _updateFindCount() {
  if (!pdFindCount) return;
  if (_pdFindMatches.length === 0) {
    pdFindCount.textContent = "无匹配";
  } else {
    pdFindCount.textContent = (_pdFindCurrentIdx + 1) + "/" + _pdFindMatches.length;
  }
  if (pdFindPrev) pdFindPrev.disabled = _pdFindMatches.length === 0;
  if (pdFindNext) pdFindNext.disabled = _pdFindMatches.length === 0;
}

function _scrollToCurrentMatch() {
  _pdFindMatches.forEach((el, i) => {
    el.classList.toggle("current", i === _pdFindCurrentIdx);
  });
  if (_pdFindCurrentIdx >= 0 && _pdFindMatches[_pdFindCurrentIdx]) {
    const matchEl = _pdFindMatches[_pdFindCurrentIdx];
    // Auto-switch to the tab panel containing this match if it's hidden
    const panel = matchEl.closest(".pd-tab-panel");
    if (panel && !panel.classList.contains("active") && panel.dataset.panel) {
      switchPatentTab(panel.dataset.panel);
    }
    // Expand any collapsed ancestor blocks
    const collapsedAncestor = matchEl.closest(".collapsed");
    if (collapsedAncestor) {
      collapsedAncestor.classList.remove("collapsed");
    }
    // Use requestAnimationFrame to ensure the tab switch has rendered before scrolling
    requestAnimationFrame(() => {
      matchEl.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }
}

function _findPrev() {
  if (_pdFindMatches.length === 0) return;
  _pdFindCurrentIdx = (_pdFindCurrentIdx - 1 + _pdFindMatches.length) % _pdFindMatches.length;
  _updateFindCount();
  _scrollToCurrentMatch();
}

function _findNext() {
  if (_pdFindMatches.length === 0) return;
  _pdFindCurrentIdx = (_pdFindCurrentIdx + 1) % _pdFindMatches.length;
  _updateFindCount();
  _scrollToCurrentMatch();
}

if (pdFindInput) {
  let _findTimer = null;
  pdFindInput.addEventListener("input", () => {
    clearTimeout(_findTimer);
    _findTimer = setTimeout(() => { _doFind(pdFindInput.value); }, 200);
  });
  pdFindInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) _findPrev(); else _findNext();
    } else if (e.key === "Escape") {
      pdFindBar.classList.add("hidden");
      _clearFindHighlights();
    }
  });
}

if (pdFindPrev) pdFindPrev.addEventListener("click", _findPrev);
if (pdFindNext) pdFindNext.addEventListener("click", _findNext);

// ── Ctrl+F 在专利详情页激活查找栏 ──
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "f") {
    if (patentDetailSection && !patentDetailSection.classList.contains("hidden") && _pdActivePatent) {
      e.preventDefault();
      togglePdFindBar();
    }
  }
  if (e.key === "Escape") {
    if (pdFindBar && !pdFindBar.classList.contains("hidden")) {
      pdFindBar.classList.add("hidden");
      _clearFindHighlights();
    }
  }
  // F3 下一个匹配
  if (e.key === "F3" && pdFindBar && !pdFindBar.classList.contains("hidden")) {
    e.preventDefault();
    if (e.shiftKey) _findPrev(); else _findNext();
  }
});

// ── Initialize history list on page load ──
refreshHistoryList();

// ── Initialize floating balls visibility ──
updateFloatingBallsVisibility();

// ── Fallback splash-screen removal (in case DOMContentLoaded handler fails) ──
setTimeout(() => {
  const splash = document.getElementById("splash-screen");
  if (splash) { splash.style.opacity = "0"; setTimeout(() => splash.remove(), 500); }
}, 8000);
