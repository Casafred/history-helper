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
  // GP 代理（仅用于访问 Google Patents）
  if (s.enabled) {
    params.push("proxy=1");
    if (s.proxyUrl) params.push("proxyUrl=" + encodeURIComponent(s.proxyUrl));
  }
  // 附加 EPO OPS 降级查询凭证（当 Google Patents 查询失败时自动降级）
  const opsConfig = getOpsSettings();
  if (opsConfig.enabled && opsConfig.consumerKey && opsConfig.consumerSecret) {
    params.push("opsKey=" + encodeURIComponent(opsConfig.consumerKey));
    params.push("opsSecret=" + encodeURIComponent(opsConfig.consumerSecret));
    // OPS 代理独立于 GP 代理（OPS 国内通常可直连，默认不走代理）
    const opsProxy = getOpsProxySettings();
    if (opsProxy.enabled) {
      params.push("opsProxy=1");
      if (opsProxy.proxyUrl) params.push("opsProxyUrl=" + encodeURIComponent(opsProxy.proxyUrl));
    }
  }
  if (params.length > 0) url += "?" + params.join("&");
  return url;
}

// EPO OPS 配置读取（从 AI 配置中获取 ops 字段）
function getOpsSettings() {
  const config = window.AI.loadAIConfig();
  const ops = window.AI.getOpsConfig(config);
  const enabled = localStorage.getItem("patentlens_ops_enabled") !== "false"; // 默认启用
  return { enabled: enabled, consumerKey: ops.consumerKey || "", consumerSecret: ops.consumerSecret || "" };
}

// OPS 代理设置（独立于 Google Patents 代理；EPO OPS 在国内通常可直连，默认关闭）
function getOpsProxySettings() {
  try {
    return JSON.parse(localStorage.getItem("patentlens_ops_proxy") || "{}");
  } catch { return {}; }
}
function saveOpsProxySettings(enabled, proxyUrl) {
  localStorage.setItem("patentlens_ops_proxy", JSON.stringify({ enabled: !!enabled, proxyUrl: proxyUrl || "" }));
}

// 返回 OPS 请求所需的代理查询串（形如 "proxy=1&proxyUrl=..."），无代理时返回空串
function getOpsProxyParams() {
  const s = getOpsProxySettings();
  if (!s.enabled) return "";
  const parts = ["proxy=1"];
  if (s.proxyUrl) parts.push("proxyUrl=" + encodeURIComponent(s.proxyUrl));
  return parts.join("&");
}

// 为 OPS 降级数据中的附图代理 URL 和 PDF 下载链接追加凭证参数
// 后端返回的 URL 形如 /api/ops/image/EP...?page=1&country=EP&doc=xxx&kind=A1
// 前端需追加 &opsKey=xxx&opsSecret=yyy 才能通过后端的 Bearer token 认证
// 注意：data.epo.org 直链 PDF 零认证，无需追加凭证
function augmentOpsUrls(data) {
  if (!data) return;
  const ops = getOpsSettings();
  if (!ops.consumerKey || !ops.consumerSecret) return;
  // 检查附图/PDF 开关（PDF 合并消耗大量配额，允许用户关闭）
  const drawingsEnabled = localStorage.getItem("patentlens_ops_drawings") !== "false";
  const credSuffix = "&opsKey=" + encodeURIComponent(ops.consumerKey) + "&opsSecret=" + encodeURIComponent(ops.consumerSecret);
  // 附加代理参数（OPS 后端路由同样需要 proxy/proxyUrl 才能访问 ops.epo.org）
  const proxyPart = getOpsProxyParams();
  const fullSuffix = credSuffix + (proxyPart ? "&" + proxyPart : "");

  if (drawingsEnabled && Array.isArray(data.drawings) && data.drawings.length > 0) {
    data.drawings = data.drawings.map(url => {
      if (typeof url === "string" && url.startsWith("/api/ops/image/") && !url.includes("opsKey=")) {
        return url + fullSuffix;
      }
      return url;
    });
  } else if (!drawingsEnabled) {
    data.drawings = []; // 用户关闭了附图功能
  }

  // 仅对 /api/ops/pdf 路由追加凭证；data.epo.org 直链 PDF 无需认证
  if (data.pdf_link && typeof data.pdf_link === "string" &&
      data.pdf_link.startsWith("/api/ops/pdf/") && !data.pdf_link.includes("opsKey=")) {
    data.pdf_link = data.pdf_link + fullSuffix;
  }
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

  // Patent detail mode - direct Google Patents search
  if (searchMode === "patent") {
    searchPatentDetail(input);
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

// ── 搜索模式切换 ──
document.querySelectorAll(".search-mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".search-mode-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    searchMode = btn.dataset.mode;
    if (searchMode === "patent") {
      patentInput.placeholder = "输入专利号查询原文信息（如 US12030161B2, EP4252965A3）";
      resultSection.classList.add("hidden");
      // Restore patent detail if previously loaded
      if (window._currentPatentData) patentDetailSection.classList.remove("hidden");
    } else {
      patentInput.placeholder = "输入专利号（如 US12030161B2, US17204063, EP4252965A3）系统自动识别类型";
      patentDetailSection.classList.add("hidden");
      // Restore result section if there's cached data
      if (currentData) resultSection.classList.remove("hidden");
    }
  });
});

// ── 专利原文查询（Google Patents） ──
async function searchPatentDetail(input) {
  // Clear prefetch cache when starting a new search
  clearPrefetchCache();

  const appEl = document.getElementById("app");
  if (appEl && appEl.classList.contains("home-mode")) appEl.classList.remove("home-mode");

  const raw = input.trim().toUpperCase().replace(/[\s\/]/g, "");
  if (!raw) { showError("请输入专利号"); return; }

  searchBtn.disabled = true;
  loadingText.textContent = "正在从 Google Patents 获取专利信息...";
  loading.classList.remove("hidden");
  resultSection.classList.add("hidden");
  patentDetailSection.classList.add("hidden");
  hideError();

  // 5 秒后提示"可能正在尝试降级"（后端 GP 超时 5 秒后自动降级）
  const fallbackHintId = setTimeout(() => {
    if (!loading.classList.contains("hidden")) {
      loadingText.textContent = "Google Patents 未响应，正在尝试降级查询...";
    }
  }, 5500);

  try {
    // 后端 Google Patents 已设置 5 秒超时自动降级 OPS，前端 60 秒兜底（防止异常卡死）
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    const resp = await fetch(gpApiUrl(raw), { signal: controller.signal });
    clearTimeout(timeoutId);
    clearTimeout(fallbackHintId);
    const json = await resp.json();

    if (!json.success) {
      showError(json.error || "未找到该专利");
      patentDetailSection.classList.add("hidden");
      searchBtn.disabled = false;
      loading.classList.add("hidden");
      return;
    }

    // Espacenet 降级：Google Patents 未找到，自动打开 Espacenet 页面
    if (json.data_source === "Espacenet" || (json.data && json.data.data_source === "Espacenet")) {
      const espacenetUrl = json.espacenet_url || (json.data && json.data.espacenet_url) || "";
      if (espacenetUrl) {
        // 在 Electron 中通过 shell.openExternal 打开系统浏览器
        if (window.electronAPI && window.electronAPI.openExternal) {
          window.electronAPI.openExternal(espacenetUrl);
        } else {
          window.open(espacenetUrl, "_blank");
        }
      }
      // 显示提示卡片而不是空白详情
      patentDetailContent.innerHTML = `
        <div class="pd-header">
          <div class="pd-patent-number">${escapeHtml(raw)}</div>
          <div class="pd-title">Google Patents 未找到该专利</div>
        </div>
        <div class="pd-espacenet-fallback" style="padding:24px;text-align:center;">
          <div style="font-size:15px;margin-bottom:12px;">已为你打开 <strong>Espacenet</strong> 查询该专利</div>
          <div style="margin-bottom:16px;">
            <a href="${escapeHtml(espacenetUrl)}" target="_blank" rel="noopener"
               style="display:inline-block;padding:10px 24px;background:#c62828;color:#fff;border-radius:6px;text-decoration:none;font-size:14px;">
              在 Espacenet 中查看
            </a>
          </div>
          <div style="color:#888;font-size:12px;">Espacenet 提供 PDF 下载、附图、权利要求等完整信息</div>
        </div>
      `;
      patentDetailSection.classList.remove("hidden");
      searchBtn.disabled = false;
      loading.classList.add("hidden");
      showDataSourceBadge("Espacenet", "Google Patents 未找到，已跳转 Espacenet");
      return;
    }

    // 当数据来自 EPO OPS 时，为附图代理 URL 和 PDF 下载链接追加 OPS 凭证
    if (json.data_source === "EPO OPS" || (json.data && json.data.data_source === "EPO OPS")) {
      augmentOpsUrls(json.data);
    }

    renderPatentDetail(json.data);
    window._currentPatentData = json.data;
    patentDetailSection.classList.remove("hidden");

    // 显示数据来源标识（当数据来自 EPO OPS 降级查询时）
    if (json.data_source === "EPO OPS" || (json.data && json.data.data_source === "EPO OPS")) {
      showDataSourceBadge("EPO OPS", "Google Patents 未找到该专利，数据来自 EPO OPS 降级查询");
    } else {
      showDataSourceBadge("Google Patents", null);
    }

    // Record to history
    const country = raw.match(/^[A-Z]{2}/)?.[0] || "";
    PatentCache.addHistory(raw, country, {
      applicantName: (json.data.assignees || []).join(", "),
      title: json.data.title || "",
    });
    PatentCache.addPatentHistory(raw, {
      applicantName: (json.data.assignees || []).join(", "),
      title: json.data.title || "",
    });
    refreshHistoryList();
  } catch (e) {
    clearTimeout(fallbackHintId);
    showError("查询失败: " + e.message);
  }

  searchBtn.disabled = false;
  loading.classList.add("hidden");
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
  html += '<button class="pd-gp-link" onclick="toggleGoogleTranslate()" title="使用 Google 翻译翻译整个页面" style="cursor:pointer;border:1px solid var(--accent);background:transparent;">网页翻译</button>';
  html += '<a href="' + escapeHtml(data.url) + '" target="_blank" rel="noopener" class="pd-gp-link">Google Patents</a>';
  if (data.pdf_link) {
    html += '<a href="' + escapeHtml(data.pdf_link) + '" target="_blank" rel="noopener" class="pd-pdf-link">PDF</a>';
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
    html += '<button class="pd-translate-btn" onclick="translatePatentSection(\'claims\')">翻译</button>';
    html += '<button class="pd-copy-btn" onclick="copyPatentSectionText(\'claims\')">复制</button>';
    html += '</div></div>';
    html += '<div class="pd-claims-list" data-section-type="claims">';
    data.claims.forEach((c, i) => {
      const claimType = c.type === 'independent' ? 'independent' : 'dependent';
      const claimClass = c.type === 'independent' ? 'claim-independent' : 'claim-dependent';
      html += '<div class="pd-claim-item ' + claimClass + '">';
      html += '<span class="pd-claim-num">' + escapeHtml(String(c.num || (i + 1))) + '.</span>';
      html += '<span class="pd-claim-type ' + claimType + '">' + (c.type === 'independent' ? '独立' : '从属') + '</span>';
      html += '<span class="pd-claim-text">' + escapeHtml(c.text) + '</span>';
      html += '</div>';
    });
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
    html += '<button class="pd-translate-btn" onclick="translatePatentSection(\'description\')">翻译</button>';
    html += '<button class="pd-copy-btn" onclick="copyPatentSectionText(\'description\')">复制</button>';
    html += '</div></div>';
    html += '<div class="pd-description-text" data-section-type="description">' + escapeHtml(data.description) + '</div>';
  } else {
    html += '<div class="pd-empty">暂无说明书数据</div>';
  }
  html += '</div>'; // panel description

  // ─── Tab 4: References ───
  html += '<div class="pd-tab-panel" data-panel="references">';

  // Patent citations
  if (data.patent_citations && data.patent_citations.length > 0) {
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title">引用专利 (' + data.patent_citations.length + ')</div>';
    html += '<div class="pd-citations">';
    data.patent_citations.forEach(c => {
      html += '<div class="pd-citation-item">';
      if (c.citation_type) {
        html += '<span class="pd-citation-marker ' + escapeHtml(c.citation_type) + '" title="' + (c.citation_type === 'examiner' ? '审查员引用' : '申请人引用') + '">' + (c.citation_type === 'examiner' ? '*' : '†') + '</span>';
      }
      html += '<a class="pd-patent-link" data-patent="' + escapeHtml(c.patent_number) + '">' + escapeHtml(c.patent_number) + '</a>';
      html += '<a href="https://patents.google.com/patent/' + encodeURIComponent(c.patent_number) + '" target="_blank" rel="noopener" class="pd-gp-link" style="font-size:11px;padding:1px 5px;margin-left:4px;" title="在 Google Patents 中打开">GP</a>';
      if (c.title) html += '<span class="pd-citation-title">' + escapeHtml(c.title) + '</span>';
      if (c.assignee) html += '<span class="pd-citation-assignee">' + escapeHtml(c.assignee) + '</span>';
      if (c.publication_date) html += '<span class="pd-citation-date">' + escapeHtml(c.publication_date) + '</span>';
      html += '</div>';
    });
    html += '</div>';
    html += '<div class="pd-citation-legend"><span class="pd-citation-marker examiner">*</span> 审查员引用 &nbsp; <span class="pd-citation-marker applicant">†</span> 申请人引用</div>';
    html += '</div>';
  }

  // Cited by
  if (data.cited_by && data.cited_by.length > 0) {
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title">被引用专利 (' + data.cited_by.length + ')</div>';
    html += '<div class="pd-citations">';
    data.cited_by.forEach(c => {
      html += '<div class="pd-citation-item">';
      html += '<a class="pd-patent-link" data-patent="' + escapeHtml(c.patent_number) + '">' + escapeHtml(c.patent_number) + '</a>';
      html += '<a href="https://patents.google.com/patent/' + encodeURIComponent(c.patent_number) + '" target="_blank" rel="noopener" class="pd-gp-link" style="font-size:11px;padding:1px 5px;margin-left:4px;" title="在 Google Patents 中打开">GP</a>';
      if (c.title) html += '<span class="pd-citation-title">' + escapeHtml(c.title) + '</span>';
      if (c.publication_date) html += '<span class="pd-citation-date">' + escapeHtml(c.publication_date) + '</span>';
      html += '</div>';
    });
    html += '</div></div>';
  }

  // Similar documents
  if (data.similar_documents && data.similar_documents.length > 0) {
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title">相似文档 (' + data.similar_documents.length + ')</div>';
    html += '<div class="pd-citations">';
    data.similar_documents.forEach(c => {
      html += '<div class="pd-citation-item">';
      html += '<a class="pd-patent-link" data-patent="' + escapeHtml(c.patent_number) + '">' + escapeHtml(c.patent_number) + '</a>';
      html += '<a href="' + escapeHtml(c.link) + '" target="_blank" rel="noopener" class="pd-gp-link" style="font-size:11px;padding:1px 5px;margin-left:4px;">GP</a>';
      html += '</div>';
    });
    html += '</div></div>';
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
        patentInput.value = pn;
        searchPatentDetail(pn);
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
}

// Switch patent detail tab
function switchPatentTab(tabName) {
  const layout = document.querySelector('.pd-tab-layout');
  if (!layout) return;
  layout.querySelectorAll('.pd-bookmark-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  layout.querySelectorAll('.pd-tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === tabName));
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
  // Find the section container - support both tab layout and collapsible layout
  let sectionEl = document.querySelector('[data-section-type="' + sectionType + '"]');
  if (!sectionEl) return;

  const translateBtn = sectionEl.querySelector('.pd-translate-btn');
  if (!translateBtn) return;

  // Check if translation already exists - toggle: restore original text and remove
  const existingResult = sectionEl.querySelector('.pd-translation-result');
  if (existingResult) {
    existingResult.remove();
    translateBtn.textContent = '翻译';
    // Restore original text
    if (sectionType === 'claims') {
      sectionEl.querySelectorAll('.pd-claim-text[data-original-text]').forEach(el => {
        el.textContent = el.dataset.originalText;
        delete el.dataset.translated;
      });
    } else if (sectionType === 'description') {
      const descEl = sectionEl.querySelector('.pd-description-text[data-original-text]');
      if (descEl) {
        descEl.textContent = descEl.dataset.originalText;
        delete descEl.dataset.translated;
      }
    }
    return;
  }

  translateBtn.textContent = '翻译中...';
  translateBtn.disabled = true;

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
    if (sectionType === "claims" && window._currentPatentData && window._currentPatentData.claims) {
      textToTranslate = window._currentPatentData.claims.map((c, i) =>
        "Claim " + (c.num || (i + 1)) + ": " + c.text
      ).join('\n\n');
    } else if (sectionType === "description" && window._currentPatentData && window._currentPatentData.description) {
      textToTranslate = window._currentPatentData.description.substring(0, 6000);
    }

    if (!textToTranslate) {
      showError("没有可翻译的内容");
      return;
    }

    const prompt = sectionType === "claims"
      ? "你是一位专业的专利文献翻译专家。请将以下英文专利权利要求翻译为中文。保持专利术语的准确性，保留所有数字标记，翻译要流畅自然。保持权利要求的编号。只返回翻译结果。"
      : "你是一位专业的专利文献翻译专家。请将以下英文专利说明书翻译为中文。保持专利术语的准确性，保留所有数字标记，翻译要流畅自然。只返回翻译结果。";

    const resp = await fetch(translateProvider.baseUrl + "/chat/completions", {
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
    const loadingEl = document.getElementById('pd-translation-loading-' + sectionType);
    if (loadingEl) loadingEl.remove();

    // Show translation result
    const resultDiv = document.createElement('div');
    resultDiv.className = 'pd-translation-result';
    resultDiv.innerHTML = '<div class="pd-translation-header"><span>AI 翻译结果</span><button class="pd-translation-close" onclick="this.parentElement.parentElement.remove(); var btn=document.querySelector(\'[data-section-type=' + sectionType + '] .pd-translate-btn\'); if(btn) btn.textContent=\'翻译\';">&times;</button></div><div class="pd-translation-body">' + escapeHtml(translated).replace(/\n/g, '<br>') + '</div>';

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
          descEl.dataset.originalText = descEl.textContent;
        }
        descEl.textContent = translated;
        descEl.dataset.translated = 'true';
      }
    }

    translateBtn.textContent = '隐藏翻译';
  } catch (e) {
    showError("翻译失败: " + e.message);
    translateBtn.textContent = '翻译';
    const loadingEl = document.getElementById('pd-translation-loading-' + sectionType);
    if (loadingEl) loadingEl.remove();
  } finally {
    translateBtn.disabled = false;
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

  // Find the section element and show loading
  const sectionEl = document.querySelector('[data-section-type="' + targetSection + '"]') || document.querySelector("#patent-detail-content");
  if (!sectionEl) return;

  // Show inline loading indicator
  const loadingEl = document.createElement('div');
  loadingEl.className = 'pd-translation-result';
  loadingEl.innerHTML = '<div class="pd-translation-header"><span>AI 翻译中...</span></div><div class="pd-translation-body" style="display:flex;align-items:center;gap:8px;"><div class="spinner" style="width:18px;height:18px;border-width:2px;margin:0;"></div><span>正在翻译选中文本...</span></div>';
  sectionEl.appendChild(loadingEl);

  try {
    const resp = await fetch(translateProvider.baseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + translateProvider.apiKey,
      },
      body: JSON.stringify({
        model: translateProvider.model,
        messages: [
          { role: "system", content: "你是一位专业的专利文献翻译专家。请将以下文本翻译为中文。保持专利术语的准确性，保留所有数字标记，翻译要流畅自然。只返回翻译结果。" },
          { role: "user", content: text }
        ],
        temperature: 0.3,
        max_tokens: 4096,
      }),
    });

    if (!resp.ok) throw new Error("API 请求失败: " + resp.status);
    const json = await resp.json();
    const translated = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content || "翻译失败";

    // Replace the loading indicator with the translation result
    loadingEl.innerHTML = '<div class="pd-translation-header"><span>AI 翻译结果（选中文本）</span><button class="pd-translation-close" onclick="this.parentElement.parentElement.remove();">&times;</button></div><div class="pd-translation-body">' + escapeHtml(translated).replace(/\n/g, '<br>') + '</div>';
  } catch (e) {
    showError("翻译失败: " + e.message);
    loadingEl.remove();
  }
}

// Copy patent section text to clipboard
function copyPatentSectionText(sectionType) {
  let text = "";
  if (sectionType === "claims" && window._currentPatentData && window._currentPatentData.claims) {
    text = window._currentPatentData.claims.map((c, i) =>
      (c.num || (i + 1)) + ". " + c.text
    ).join('\n\n');
  } else if (sectionType === "description" && window._currentPatentData && window._currentPatentData.description) {
    text = window._currentPatentData.description;
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
// 页面加载时自动注入，翻译栏始终待触发状态（左上角）
let _googleTranslateInjected = false;
let _googleTranslateActive = false;

function initGoogleTranslate() {
  if (_googleTranslateInjected) return;
  _googleTranslateInjected = true;
  _googleTranslateActive = true;

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
  };

  const script = document.createElement("script");
  script.id = "google-translate-script";
  script.type = "text/javascript";
  script.src = "https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit";
  script.onerror = function() {
    _googleTranslateInjected = false;
    _googleTranslateActive = false;
    container.remove();
  };
  document.head.appendChild(script);
}

// 页面加载后自动注入 Google Translate（始终待触发）
initGoogleTranslate();

function toggleGoogleTranslate() {
  const btn = document.getElementById("page-translate-btn");
  if (!btn) return;

  // Toggle off
  if (_googleTranslateActive) {
    const gtEls = document.querySelectorAll(".skiptranslate, #goog-gt-tt, .goog-te-spinner-pos, #google_translate_element");
    gtEls.forEach(el => el.remove());
    document.body.style.top = "";
    document.body.classList.remove("skiptranslate");
    const gtScript = document.getElementById("google-translate-script");
    if (gtScript) gtScript.remove();
    delete window.google;
    delete window.googleTranslateElementInit;
    _googleTranslateInjected = false;
    _googleTranslateActive = false;
    btn.textContent = "网页翻译";
    btn.title = "使用 Google 翻译翻译整个页面";
    return;
  }

  // Toggle on: re-inject
  initGoogleTranslate();
  btn.textContent = "关闭翻译";
  btn.title = "关闭 Google 翻译";
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
      // Ctrl/Cmd+Click: open in Google Patents directly
      if (e.ctrlKey || e.metaKey) {
        window.open("https://patents.google.com/patent/" + encodeURIComponent(pn), "_blank");
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
    html += '<button class="pd-translate-btn" onclick="translatePatentSection(\'claims\')">翻译</button>';
    html += '<button class="pd-copy-btn" onclick="copyPatentSectionText(\'claims\')">复制</button>';
    html += '</div></div>';
    html += '<div class="pd-claims-list" data-section-type="claims">';
    data.claims.forEach((c, i) => {
      const claimType = c.type === 'independent' ? 'independent' : 'dependent';
      const claimClass = c.type === 'independent' ? 'claim-independent' : 'claim-dependent';
      html += '<div class="pd-claim-item ' + claimClass + '">';
      html += '<span class="pd-claim-num">' + escapeHtml(String(c.num || (i + 1))) + '.</span>';
      html += '<span class="pd-claim-type ' + claimType + '">' + (c.type === 'independent' ? '独立' : '从属') + '</span>';
      html += '<span class="pd-claim-text">' + escapeHtml(c.text) + '</span>';
      html += '</div>';
    });
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
    html += '<button class="pd-translate-btn" onclick="translatePatentSection(\'description\')">翻译</button>';
    html += '<button class="pd-copy-btn" onclick="copyPatentSectionText(\'description\')">复制</button>';
    html += '</div></div>';
    html += '<div class="pd-description-text" data-section-type="description">' + escapeHtml(data.description) + '</div>';
  } else {
    html += '<div class="pd-empty">暂无说明书数据</div>';
  }
  html += '</div>'; // panel description

  // ─── Tab 4: References ───
  html += '<div class="pd-tab-panel" data-panel="references">';

  // Patent citations
  if (data.patent_citations && data.patent_citations.length > 0) {
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title">引用专利 (' + data.patent_citations.length + ')</div>';
    html += '<div class="pd-citations">';
    data.patent_citations.forEach(c => {
      html += '<div class="pd-citation-item">';
      if (c.citation_type) {
        html += '<span class="pd-citation-marker ' + escapeHtml(c.citation_type) + '" title="' + (c.citation_type === 'examiner' ? '审查员引用' : '申请人引用') + '">' + (c.citation_type === 'examiner' ? '*' : '†') + '</span>';
      }
      html += '<a class="pd-patent-link" data-patent="' + escapeHtml(c.patent_number) + '">' + escapeHtml(c.patent_number) + '</a>';
      html += '<a href="https://patents.google.com/patent/' + encodeURIComponent(c.patent_number) + '" target="_blank" rel="noopener" class="pd-gp-link" style="font-size:11px;padding:1px 5px;margin-left:4px;" title="在 Google Patents 中打开">GP</a>';
      if (c.title) html += '<span class="pd-citation-title">' + escapeHtml(c.title) + '</span>';
      if (c.assignee) html += '<span class="pd-citation-assignee">' + escapeHtml(c.assignee) + '</span>';
      if (c.publication_date) html += '<span class="pd-citation-date">' + escapeHtml(c.publication_date) + '</span>';
      html += '</div>';
    });
    html += '</div>';
    html += '<div class="pd-citation-legend"><span class="pd-citation-marker examiner">*</span> 审查员引用 &nbsp; <span class="pd-citation-marker applicant">†</span> 申请人引用</div>';
    html += '</div>';
  }

  // Cited by
  if (data.cited_by && data.cited_by.length > 0) {
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title">被引用专利 (' + data.cited_by.length + ')</div>';
    html += '<div class="pd-citations">';
    data.cited_by.forEach(c => {
      html += '<div class="pd-citation-item">';
      html += '<a class="pd-patent-link" data-patent="' + escapeHtml(c.patent_number) + '">' + escapeHtml(c.patent_number) + '</a>';
      html += '<a href="https://patents.google.com/patent/' + encodeURIComponent(c.patent_number) + '" target="_blank" rel="noopener" class="pd-gp-link" style="font-size:11px;padding:1px 5px;margin-left:4px;" title="在 Google Patents 中打开">GP</a>';
      if (c.title) html += '<span class="pd-citation-title">' + escapeHtml(c.title) + '</span>';
      if (c.publication_date) html += '<span class="pd-citation-date">' + escapeHtml(c.publication_date) + '</span>';
      html += '</div>';
    });
    html += '</div></div>';
  }

  // Similar documents
  if (data.similar_documents && data.similar_documents.length > 0) {
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title">相似文档 (' + data.similar_documents.length + ')</div>';
    html += '<div class="pd-citations">';
    data.similar_documents.forEach(c => {
      html += '<div class="pd-citation-item">';
      html += '<a class="pd-patent-link" data-patent="' + escapeHtml(c.patent_number) + '">' + escapeHtml(c.patent_number) + '</a>';
      html += '<a href="' + escapeHtml(c.link) + '" target="_blank" rel="noopener" class="pd-gp-link" style="font-size:11px;padding:1px 5px;margin-left:4px;">GP</a>';
      html += '</div>';
    });
    html += '</div></div>';
  }

  // Family applications
  if (data.family_applications && data.family_applications.length > 0) {
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title">同族申请 (' + data.family_applications.length + ')</div>';
    html += '<div class="pd-citations">';
    data.family_applications.forEach(fa => {
      html += '<div class="pd-citation-item">';
      if (fa.publication_number) {
        html += '<a class="pd-patent-link" data-patent="' + escapeHtml(fa.publication_number) + '">' + escapeHtml(fa.publication_number) + '</a>';
      }
      if (fa.title) html += '<span class="pd-citation-title">' + escapeHtml(fa.title) + '</span>';
      if (fa.status) html += '<span class="pd-citation-date">' + escapeHtml(fa.status) + '</span>';
      html += '</div>';
    });
    html += '</div></div>';
  }

  // External links
  if (data.external_links && Object.keys(data.external_links).length > 0) {
    html += '<div class="pd-section">';
    html += '<div class="pd-section-title">外部链接</div>';
    html += '<div class="pd-citations">';
    for (const [key, link] of Object.entries(data.external_links)) {
      if (link.url) {
        html += '<div class="pd-citation-item">';
        html += '<a href="' + escapeHtml(link.url) + '" target="_blank" rel="noopener" class="pd-external-link">' + escapeHtml(link.text || key) + '</a>';
        html += '</div>';
      }
    }
    html += '</div></div>';
  }

  if ((!data.patent_citations || data.patent_citations.length === 0) && (!data.cited_by || data.cited_by.length === 0) && (!data.similar_documents || data.similar_documents.length === 0) && (!data.family_applications || data.family_applications.length === 0)) {
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
  const pdfLink = document.getElementById("ppv-pdf-link");

  if (!viewer) return;

  const raw = patentNumber.trim().toUpperCase().replace(/[\s\/]/g, "");

  // If already open, just switch to it
  const existing = _ppvOpenPatents.find(e => e.patentNumber === raw);
  if (existing) {
    _ppvActivePatent = raw;
    _patentPopupData = existing.data;
    content.innerHTML = existing.html;
    _bindPpvContentEvents(content, existing.data);
    _renderPpvPatentTabs();
    loading.classList.add("hidden");
    viewer.classList.remove("hidden");
    ball.classList.add("hidden");
    pnEl.textContent = raw;
    titleEl.textContent = existing.data.title || "无标题";
    gpLink.href = "https://patents.google.com/patent/" + encodeURIComponent(raw);
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
  pdfLink.classList.add("hidden");

  // Check prefetch cache first
  if (_prefetchCache[raw]) {
    const data = _prefetchCache[raw];
    _patentPopupData = data;
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
    return;
  }

  try {
    const resp = await fetch(gpApiUrl(raw));
    const json = await resp.json();

    if (!json.success) {
      content.innerHTML = '<div class="ppv-error">' + escapeHtml(json.error || "未找到该专利") + '</div>';
      loading.classList.add("hidden");
      titleEl.textContent = "查询失败";
      return;
    }

    const data = json.data;
    _patentPopupData = data;
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

  const content = document.getElementById("ppv-content");
  const pnEl = document.getElementById("ppv-patent-number");
  const titleEl = document.getElementById("ppv-patent-title");
  const gpLink = document.getElementById("ppv-gp-link");
  const pdfLink = document.getElementById("ppv-pdf-link");

  content.innerHTML = entry.html;
  _bindPpvContentEvents(content, entry.data);
  _renderPpvPatentTabs();

  if (pnEl) pnEl.textContent = patentNumber;
  if (titleEl) titleEl.textContent = entry.data.title || "无标题";
  if (gpLink) gpLink.href = "https://patents.google.com/patent/" + encodeURIComponent(patentNumber);
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
  if (ball) ball.classList.remove("hidden");
  _ppvOpenPatents = [];
  _ppvActivePatent = "";
  const tabsBar = document.getElementById("ppv-patent-tabs");
  if (tabsBar) tabsBar.innerHTML = "";
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

    // Deep-clone kanbanState but skip pageDimensions in traceIndex
    const traceIndexClone = {};
    for (const [key, val] of Object.entries(kanbanState.traceIndex)) {
      const { pageDimensions, ...rest } = val;
      traceIndexClone[key] = rest;
    }

    // Deep-clone extractions but skip pageDimensions
    const extractionsClone = {};
    for (const [idx, ext] of Object.entries(kanbanState.extractions)) {
      const { pageDimensions, ...rest } = ext;
      extractionsClone[idx] = rest;
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

      // Restore extractions - re-populate pageDimensions from blocks
      kanbanState.extractions = {};
      if (cacheEntry.kanbanState.extractions) {
        for (const [idx, ext] of Object.entries(cacheEntry.kanbanState.extractions)) {
          kanbanState.extractions[idx] = { ...ext, pageDimensions: {} };
          // Re-populate pageDimensions from blocks if available
          if (ext.blocks && Array.isArray(ext.blocks)) {
            for (const b of ext.blocks) {
              if (b.page != null && b.bbox) {
                if (!kanbanState.extractions[idx].pageDimensions[b.page]) {
                  // Estimate page dimensions from bbox if not available
                  kanbanState.extractions[idx].pageDimensions[b.page] = null;
                }
              }
            }
          }
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
        if (analysisContentEl) analysisContentEl.innerHTML = renderMarkdownWithTrace(kanbanState.analysis);
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

      // Show reader floating ball
      if (readerFloatingBall && kanbanState.documents.length > 0) {
        readerFloatingBall.classList.remove("hidden");
      }

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
    if (entries.length === 0 && Object.keys(PatentCache.getPatentHistoryAll()).length === 0) {
      historyList.innerHTML = '<div style="color:var(--text-muted);font-size:12px;text-align:center;padding:16px 4px;">暂无历史记录</div>';
    } else {
      historyList.innerHTML = entries.map(e => {
        const currentPatent = currentData ? (currentData.raw || (currentData.office + currentData.applicationNumber)) : "";
        const isActive = e.patentNumber === currentPatent;
        let badges = "";
        if (!e.isCached) badges += '<span class="history-badge" style="background:var(--bg-hover);color:var(--text-muted);">仅记录</span>';
        if (e.hasOCR) badges += '<span class="history-badge badge-ocr">OCR</span>';
        if (e.hasAnalysis) badges += '<span class="history-badge badge-analysis">分析</span>';
        if (e.hasCitedRefs) badges += '<span class="history-badge badge-cited">引用</span>';
        const titleHtml = e.title ? '<div class="history-item-title">' + escapeHtml(e.title.length > 30 ? e.title.substring(0, 30) + '...' : e.title) + '</div>' : '';
        const applicantHtml = e.applicantName ? '<div class="history-item-applicant">申请人: ' + escapeHtml(e.applicantName.length > 20 ? e.applicantName.substring(0, 20) + '...' : e.applicantName) + '</div>' : '';
        return `<div class="history-item${isActive ? ' active' : ''}" data-patent="${escapeHtml(e.patentNumber)}" data-cached="${e.isCached ? '1' : '0'}" data-timestamp="${e.timestamp || 0}">
          <div class="history-item-patent">${escapeHtml(e.patentNumber)}</div>
          ${titleHtml}
          ${applicantHtml}
          <div class="history-item-time">${e.office ? '<span style="color:var(--accent);margin-right:4px;">' + escapeHtml(e.office) + '</span>' : ''}${timeAgo(e.timestamp)}</div>
          ${badges ? '<div class="history-item-badges">' + badges + '</div>' : ''}
        </div>`;
      }).join("");

      // Also show patent original text history
      const patentHistory = PatentCache.getPatentHistoryAll();
      for (const [key, item] of Object.entries(patentHistory)) {
        if (item.timestamp) {
          const ts = new Date(item.timestamp);
          const timeStr = ts.toLocaleDateString() + " " + ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          const li = document.createElement("div");
          li.className = "history-item patent-history-item";
          li.dataset.patentNumber = item.patentNumber;
          li.dataset.type = "patent";
          li.dataset.timestamp = item.timestamp;
          li.innerHTML = `
            <div class="history-item-patent"><span class="history-office-badge gp-badge" style="background:var(--accent);color:#fff;font-size:10px;padding:1px 4px;border-radius:3px;margin-right:4px;">GP</span>${escapeHtml(item.patentNumber)}</div>
            ${item.title ? `<div class="history-item-title">${escapeHtml(item.title.length > 30 ? item.title.substring(0, 30) + '...' : item.title)}</div>` : ""}
            ${item.applicantName ? `<div class="history-item-applicant">申请人: ${escapeHtml(item.applicantName.length > 20 ? item.applicantName.substring(0, 20) + '...' : item.applicantName)}</div>` : ""}
            <div class="history-item-time">${timeStr}</div>
          `;
          // Insert at the right position by timestamp
          const existingItems = historyList.querySelectorAll(".history-item");
          let inserted = false;
          for (const existing of existingItems) {
            const existingTs = parseInt(existing.dataset.timestamp || "0");
            if (item.timestamp > existingTs) {
              historyList.insertBefore(li, existing);
              inserted = true;
              break;
            }
          }
          if (!inserted) historyList.appendChild(li);
        }
      }

      // Add click handlers for dossier history items
      historyList.querySelectorAll(".history-item:not(.patent-history-item)").forEach(item => {
        item.addEventListener("click", () => {
          const patentNumber = item.dataset.patent;
          const isCached = item.dataset.cached === "1";
          if (isCached) {
            restoreFromCache(patentNumber);
          } else {
            restoreFromHistory(patentNumber);
          }
        });
      });

      // Add click handlers for patent history items
      historyList.querySelectorAll(".patent-history-item").forEach(item => {
        item.addEventListener("click", () => {
          const patentNumber = item.dataset.patentNumber;
          // Switch to patent mode and search
          searchMode = "patent";
          document.querySelectorAll(".search-mode-btn").forEach(b => {
            b.classList.toggle("active", b.dataset.mode === "patent");
          });
          searchPatentDetail(patentNumber);
        });
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
  const analysisChatFloatBall = document.getElementById("analysis-chat-float-ball");
  if (analysisChatFloatBall) analysisChatFloatBall.classList.add("hidden");
  const analysisChatPanel = document.getElementById("analysis-chat-panel");
  if (analysisChatPanel) analysisChatPanel.classList.add("hidden");

  // Show reader floating ball when documents are loaded
  if (readerFloatingBall && items.length > 0) {
    readerFloatingBall.classList.remove("hidden");
    const iconOpen = readerFloatingBall.querySelector(".reader-fb-icon-open");
    const iconBack = readerFloatingBall.querySelector(".reader-fb-icon-back");
    readerFloatingBall.title = "点击打开阅读器";
    if (iconOpen) iconOpen.classList.remove("hidden");
    if (iconBack) iconBack.classList.add("hidden");
  }

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
    config.translate.defaultLang = translateDefaultLang ? translateDefaultLang.value : "zh";
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
  if (translateDefaultLang) translateDefaultLang.value = translate.defaultLang || "zh";

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
                  blocks: fbResult.blocks || [], pageDims: fbResult.page_dimensions || {},
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
              blocks: result.blocks || [], pageDims: result.page_dimensions || {},
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
      if (chunk.content) {
        fullText += chunk.content;
        if (!_streamRafPending && (fullText.length - _lastRenderLen > 20 || fullText.length < 200)) {
          _streamRafPending = true;
          requestAnimationFrame(() => {
            if (streamContainer) {
              streamContainer.innerHTML = marked.parse(fullText);
            }
            _lastRenderLen = fullText.length;
            _streamRafPending = false;
          });
        }
      }
    }
    // Final render
    if (streamContainer) streamContainer.innerHTML = marked.parse(fullText);

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
      // Create a stable container once to avoid full DOM replacement on each chunk
      analysisContent.innerHTML = '<div class="kanban-analysis-content markdown-body"></div>';
      const streamContainer = analysisContent.querySelector(".kanban-analysis-content");
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
        if (chunk.content) {
          fullText += chunk.content;
          // Throttle rendering: only render if enough new content or enough time passed
          if (!_streamRafPending && (fullText.length - _lastRenderLen > 20 || fullText.length < 200)) {
            _streamRafPending = true;
            requestAnimationFrame(() => {
              if (streamContainer) {
                streamContainer.innerHTML = renderMarkdownWithTrace(fullText);
              }
              _lastRenderLen = fullText.length;
              _streamRafPending = false;
            });
          }
        }
      }
      // Final render to ensure all content is displayed
      if (streamContainer) streamContainer.innerHTML = renderMarkdownWithTrace(fullText);
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

  // Hide any OCR progress overlay from previous document
  hideOcrProgressOverlay();

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
    readerContent.innerHTML = '<div class="markdown-body">' + renderMarkdownWithTrace(kanbanState.analysis) + '</div>';
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

function showOcrProgressOverlay(statusText, progress) {
  const existing = document.getElementById("ocr-progress-overlay");
  if (existing) {
    // Update existing overlay
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
  readerPdfContainer.prepend(overlay);
}

function hideOcrProgressOverlay() {
  const existing = document.getElementById("ocr-progress-overlay");
  if (existing) existing.remove();
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
    pdfViewState.baseScale = containerWidth > 0 ? Math.min(containerWidth / viewport.width, 1.5) : 1.0;
    pdfViewState.scale = pdfViewState.baseScale;

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
    pdfViewState.baseScale = containerWidth > 0 ? Math.min(containerWidth / viewport.width, 1.5) : 1.0;
    pdfViewState.scale = pdfViewState.baseScale;

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
        showOcrProgressOverlay("正在自动 OCR 识别中，PDF 已可浏览...");
        ocrPdf(); // fire-and-forget, will re-render on completion
      }
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

    if (pageBlocks.length > 0 && pageDim) {
      const scaleX = viewport.width / pageDim.width;
      const scaleY = viewport.height / pageDim.height;

      pageBlocks.forEach(b => {
        if (!b.bbox) return;
        const [x1, y1, x2, y2] = b.bbox;
        const overlay = document.createElement("div");
        overlay.className = "pdf-block-overlay";
        overlay.dataset.blockId = b.block_id;
        overlay.dataset.label = b.label || "text";
        overlay.style.left = (x1 * scaleX) + "px";
        overlay.style.top = (y1 * scaleY) + "px";
        overlay.style.width = ((x2 - x1) * scaleX) + "px";
        overlay.style.height = ((y2 - y1) * scaleY) + "px";

        const tooltip = document.createElement("div");
        tooltip.className = "pdf-block-tooltip";
        tooltip.textContent = b.block_id + " [" + (b.label || "text") + "]";
        overlay.appendChild(tooltip);

        overlay.addEventListener("click", (ev) => {
          ev.stopPropagation();
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
        });

        overlay.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
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

  // 全局 mousemove / mouseup 用于框选
  if (readerPdfContainer._selectionHandlersInstalled) return;
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
    const selectionRect = wrapper.querySelector(".pdf-selection-rect");
    if (selectionRect) {
      const left = Math.min(pdfViewState.selectStart.x, x);
      const top = Math.min(pdfViewState.selectStart.y, y);
      const width = Math.abs(x - pdfViewState.selectStart.x);
      const height = Math.abs(y - pdfViewState.selectStart.y);
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
    pdfPageInfo.textContent = pdfViewState.currentPage + " / " + pdfViewState.totalPages;
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

  // Show progress overlay with phase indicators
  showOcrProgressOverlay("正在下载 PDF 文档...", 5);

  // Simulate download phase progress
  let downloadTimer = null;
  let downloadProgress = 5;
  if (totalPages > 0) {
    downloadTimer = setInterval(() => {
      if (downloadProgress < 30) {
        downloadProgress += 3;
        showOcrProgressOverlay("正在下载 PDF 文档...", downloadProgress);
      }
    }, 500);
  }

  const MAX_RETRIES = 2;
  let success = false;

  async function tryExtract(engine, retriesLeft) {
    try {
      // Update progress to OCR phase
      if (downloadTimer) clearInterval(downloadTimer);
      showOcrProgressOverlay("正在 OCR 识别 (" + (engine === "paddle_ocr_vl" ? "PaddleOCR" : "GLM OCR") + ")...", 35);

      // Simulate OCR phase progress
      let ocrTimer = null;
      let ocrProgress = 35;
      if (totalPages > 0) {
        ocrTimer = setInterval(() => {
          if (ocrProgress < 85) {
            ocrProgress += Math.max(1, Math.floor((85 - ocrProgress) * 0.08));
            showOcrProgressOverlay("正在 OCR 识别 (" + (engine === "paddle_ocr_vl" ? "PaddleOCR" : "GLM OCR") + ")... " + Math.round(ocrProgress * totalPages / 85) + "/" + totalPages + " 页", ocrProgress);
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
      showOcrProgressOverlay("正在解析 OCR 结果...", 90);
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
      showOcrProgressOverlay("OCR 完成", 100);
      updateExtractPanel();
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
    // Re-render PDF with block overlays, preserving scroll position
    if (pdfViewState.active) {
      // Save current scroll position
      const scrollTop = readerPdfContainer.scrollTop;
      const scrollRatio = readerPdfContainer.scrollHeight > 0 ? scrollTop / readerPdfContainer.scrollHeight : 0;
      await renderPdfView(idx);
      // Restore scroll position after re-render
      requestAnimationFrame(() => {
        const newScrollTop = Math.round(scrollRatio * readerPdfContainer.scrollHeight);
        readerPdfContainer.scrollTop = newScrollTop;
      });
    }
    // Hide OCR progress overlay
    hideOcrProgressOverlay();
  } else {
    // Hide OCR progress overlay on failure too
    hideOcrProgressOverlay();
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
  contentEl.innerHTML = blocksInfo + '<pre class="extract-pre">' + escapeHtml(text) + '</pre>';
}

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
    let fullContent = "";
    let _rafPending = false;

    AI.streamChat(provider.type, provider.apiKey, provider.baseUrl, {
      model: provider.model,
      messages,
      maxTokens: 32768,
    }).then(async (stream) => {
      for await (const chunk of stream) {
        if (chunk.content) {
          fullContent += chunk.content;
          if (!_rafPending) {
            _rafPending = true;
            requestAnimationFrame(() => {
              if (streamContainer) streamContainer.innerHTML = marked.parse(fullContent);
              _rafPending = false;
            });
          }
        }
      }
      if (streamContainer) streamContainer.innerHTML = marked.parse(fullContent);
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
    pdfOcrBtn.addEventListener("click", async () => {
      if (pdfOcrBtn.disabled) return;
      pdfOcrBtn.disabled = true;
      pdfOcrBtn.textContent = "OCR中...";
      await ocrPdf();
      pdfOcrBtn.disabled = false;
      pdfOcrBtn.textContent = "OCR 提取";
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

  // Page translate button (Google Translate widget)
  const pageTranslateBtn = document.getElementById("page-translate-btn");
  if (pageTranslateBtn) {
    pageTranslateBtn.addEventListener("click", toggleGoogleTranslate);
  }

  // PDF clear selection button
  const clearSelBtn = document.getElementById("pdf-clear-selection-btn");
  if (clearSelBtn) {
    clearSelBtn.addEventListener("click", clearPdfBlockSelection);
  }

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

  // Floating ball click to restore reader
  if (readerChatToggle) {
    readerChatToggle.addEventListener("click", () => {
      if (readerChatPanel) {
        const wasHidden = readerChatPanel.classList.contains("hidden");
        if (wasHidden) {
          readerChatPanel.classList.remove("hidden");
          readerChatToggle.classList.add("active");
          enterReadingMode("chat");
        } else {
          // Chat panel is visible, toggle off exits reading mode
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
      if (chunk.content) {
        fullResponse += chunk.content;
        if (!_rafPending) {
          _rafPending = true;
          requestAnimationFrame(() => {
            if (assistantMsgEl) {
              const contentEl = assistantMsgEl.querySelector(".chat-msg-content") || assistantMsgEl;
              contentEl.innerHTML = renderMarkdown(fullResponse);
            }
            _rafPending = false;
          });
        }
      }
    }
    // Final render
    if (assistantMsgEl) {
      const contentEl = assistantMsgEl.querySelector(".chat-msg-content") || assistantMsgEl;
      contentEl.innerHTML = renderMarkdown(fullResponse);
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
  const floatBall = document.getElementById("analysis-chat-float-ball");
  if (floatBall) floatBall.classList.remove("hidden");
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
const opsDrawingsCheckbox = document.getElementById("ops-drawings-checkbox");
const opsConsumerKeyInput = document.getElementById("ops-consumer-key-input");
const opsConsumerSecretInput = document.getElementById("ops-consumer-secret-input");
const opsProxyCheckbox = document.getElementById("ops-proxy-checkbox");
const opsProxyUrlGroup = document.getElementById("ops-proxy-url-group");
const opsProxyUrlInput = document.getElementById("ops-proxy-url-input");
const opsSaveBtn = document.getElementById("ops-save-btn");
const opsTestBtn = document.getElementById("ops-test-btn");
const opsTestResult = document.getElementById("ops-test-result");
const opsQuotaDisplayGroup = document.getElementById("ops-quota-display-group");
const opsRefreshQuotaBtn = document.getElementById("ops-refresh-quota-btn");

// OPS 代理开关联动：勾选时显示代理地址输入框
if (opsProxyCheckbox) {
  const savedOpsProxy = getOpsProxySettings();
  opsProxyCheckbox.checked = !!savedOpsProxy.enabled;
  if (opsProxyUrlInput) opsProxyUrlInput.value = savedOpsProxy.proxyUrl || "";
  if (opsProxyUrlGroup) opsProxyUrlGroup.style.display = savedOpsProxy.enabled ? "" : "none";
  opsProxyCheckbox.addEventListener("change", () => {
    if (opsProxyUrlGroup) opsProxyUrlGroup.style.display = opsProxyCheckbox.checked ? "" : "none";
  });
}

// 回填 OPS 配置到表单（由 loadAISettingsToForm 调用）
function loadOpsSettingsToForm() {
  const ops = getOpsSettings();
  if (opsEnabledCheckbox) opsEnabledCheckbox.checked = ops.enabled;
  if (opsConsumerKeyInput) opsConsumerKeyInput.value = ops.consumerKey;
  if (opsConsumerSecretInput) opsConsumerSecretInput.value = ops.consumerSecret;
  if (opsDrawingsCheckbox) opsDrawingsCheckbox.checked = localStorage.getItem("patentlens_ops_drawings") !== "false";
  // 回填 OPS 代理设置（独立于 GP 代理）
  const opsProxy = getOpsProxySettings();
  if (opsProxyCheckbox) opsProxyCheckbox.checked = !!opsProxy.enabled;
  if (opsProxyUrlInput) opsProxyUrlInput.value = opsProxy.proxyUrl || "";
  if (opsProxyUrlGroup) opsProxyUrlGroup.style.display = opsProxy.enabled ? "" : "none";
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
    const proxyPart = getOpsProxyParams();
    const resp = await fetch("/api/ops/quota?opsKey=" + encodeURIComponent(ops.consumerKey) + "&opsSecret=" + encodeURIComponent(ops.consumerSecret) + (proxyPart ? "&" + proxyPart : ""));
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
    localStorage.setItem("patentlens_ops_drawings", opsDrawingsCheckbox && opsDrawingsCheckbox.checked ? "true" : "false");
    // 保存 OPS 代理设置（独立于 GP 代理）
    saveOpsProxySettings(
      opsProxyCheckbox ? opsProxyCheckbox.checked : false,
      opsProxyUrlInput ? opsProxyUrlInput.value.trim() : ""
    );
    opsSaveBtn.textContent = "已保存 ✓";
    setTimeout(() => { opsSaveBtn.textContent = "保存"; }, 1500);
    // 保存后显示配额区域
    if (opsQuotaDisplayGroup && config.ops.consumerKey) {
      opsQuotaDisplayGroup.style.display = "";
      refreshOpsQuota();
    }
  });
}

// OPS 测试连接按钮（直接测试 OPS token + 轻量查询，不走 Google Patents 路由）
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
      opsTestResult.textContent = "正在直连 OPS 获取 token 并查询 EP1000000...";
      opsTestResult.style.color = "var(--text-secondary)";
    }
    try {
      // 直接调用 OPS 测试端点（1. 获取 token  2. 用 EP1000000 做轻量 biblio 查询）
      // 代理参数优先取表单当前值（用户可能还没点"保存"）
      let proxyPart = "";
      if (opsProxyCheckbox && opsProxyCheckbox.checked) {
        const pUrl = opsProxyUrlInput ? opsProxyUrlInput.value.trim() : "";
        proxyPart = "proxy=1" + (pUrl ? "&proxyUrl=" + encodeURIComponent(pUrl) : "");
      }
      const resp = await fetch("/api/ops/test?opsKey=" + encodeURIComponent(key) + "&opsSecret=" + encodeURIComponent(secret) + (proxyPart ? "&" + proxyPart : ""));
      const data = await resp.json();
      if (data.success) {
        if (opsTestResult) {
          const quotaTxt = data.quota && data.quota.throttle ? "（配额状态: " + data.quota.throttle + "）" : "";
          opsTestResult.textContent = "✓ 连接成功！OPS 凭证有效，token 与查询均通过" + quotaTxt;
          opsTestResult.style.color = "var(--success)";
        }
        refreshOpsQuota();
      } else {
        const stage = data.stage === "token" ? "（Token 获取阶段失败：请检查 key/secret 是否正确、网络/代理是否能访问 ops.epo.org）"
                    : data.stage === "query" ? "（Token 有效但查询失败：可能是配额用尽或网络中断）"
                    : "";
        if (opsTestResult) {
          opsTestResult.textContent = "✗ 测试失败: " + (data.error || "未知错误") + stage;
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

// ── Initialize history list on page load ──
refreshHistoryList();

// ── Fallback splash-screen removal (in case DOMContentLoaded handler fails) ──
setTimeout(() => {
  const splash = document.getElementById("splash-screen");
  if (splash) { splash.style.opacity = "0"; setTimeout(() => splash.remove(), 500); }
}, 8000);
