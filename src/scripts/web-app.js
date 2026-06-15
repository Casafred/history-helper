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
const loading = document.getElementById("loading");
const loadingText = document.getElementById("loading-text");
const errorToast = document.getElementById("error-toast");

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
const readerMinimizeBtn = document.getElementById("reader-minimize-btn");
const readerFloatingBall = document.getElementById("reader-floating-ball");
const readerDocList = document.getElementById("reader-doc-list");
const readerContent = document.getElementById("reader-content");
const readerExportBtn = document.getElementById("reader-export-btn");
const exportWordBtn = document.getElementById("export-word-btn");
const readerPdfToggle = document.getElementById("reader-pdf-toggle");
const readerDockBtn = document.getElementById("reader-dock-btn");
const readerFullscreenBtn = document.getElementById("reader-fullscreen-btn");
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
        input: familyMatch[2].startsWith("US") ? familyMatch[3] : familyMatch[3],
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
  const result = { office, applicationNumber: docNum, queryType };
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

  try { renderOverview(result); } catch (e) { console.error("renderOverview:", e); }
  try { renderFamily(result); } catch (e) { console.error("renderFamily:", e); }
  try { renderKanban(result); } catch (e) { console.error("renderKanban:", e); }
  try { renderTimeline(result); } catch (e) { console.error("renderTimeline:", e); }

  if (warnings.length > 0) {
    warnings.forEach(w => showError("警告: " + w));
  }

  if (aiSummarizeBtn) aiSummarizeBtn.disabled = false;
  const citedRefsManualBtn = document.getElementById("cited-refs-manual-btn");
  if (citedRefsManualBtn) citedRefsManualBtn.disabled = false;
  const manualSelectBtn = document.getElementById("kanban-manual-select-btn");
  if (manualSelectBtn) manualSelectBtn.disabled = false;
  resultSection.classList.remove("hidden");
  searchBtn.disabled = false;
  loading.classList.add("hidden");
});

let kanbanState = {
  documents: [],
  extractions: {},
  analysis: "",
  traceIndex: {},
};

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
  const docCount = family ? countDocuments(data.documents) : 0;
  const oaCount = items.filter(it => it.type === "office_action").length;
  const respCount = items.filter(it => it.type === "response").length;
  const allowCount = items.filter(it => it.type === "allowance").length;

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
    if (blocks.length > 0) {
      blocks.forEach(b => {
        kanbanState.traceIndex[b.block_id] = {
          docIdx: idx,
          page: b.page,
          bbox: b.bbox,
          content: b.content,
          label: b.label,
          pageDimensions: pageDimensions[b.page] || null,
        };
      });
    }
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
        if (aiSummaryResult) aiSummaryResult.innerHTML = '<div class="ai-summary-content markdown-body">' + renderMarkdown(fullText) + "</div>";
      }
    }
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

modalCloseBtn.addEventListener("click", () => { aiSettingsModal.classList.add("hidden"); });
modalOverlay.addEventListener("click", () => { aiSettingsModal.classList.add("hidden"); });

aiProviderSelect.addEventListener("change", () => {
  const type = aiProviderSelect.value;
  aiBaseUrlInput.value = window.AI.getDefaultBaseUrl(type);
  updateModelOptions(type);
});

if (ocrEngineSelect) {
  ocrEngineSelect.addEventListener("change", toggleOcrGlmKeyVisibility);
}

aiTestBtn.addEventListener("click", async () => {
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

aiSaveBtn.addEventListener("click", () => {
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
      { id: "prompt-history-summary", key: "historySummary" },
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

// Settings tab switching
document.querySelectorAll(".settings-tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const tabId = btn.dataset.settingsTab;
    document.querySelectorAll(".settings-tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".settings-tab-content").forEach(c => c.classList.remove("active"));
    btn.classList.add("active");
    const tabContent = document.getElementById("settings-tab-" + tabId);
    if (tabContent) tabContent.classList.add("active");
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
    { id: "prompt-history-summary", key: "historySummary" },
    { id: "prompt-cited-refs-analysis", key: "citedRefsAnalysis" },
  ];
  promptKeys.forEach(p => {
    const el = document.getElementById(p.id);
    if (el) el.value = window.AI.getCustomPrompt(config, p.key);
  });
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
      "history-summary": "historySummary",
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
    analysisContent.innerHTML = '<p class="extracting">正在提取引用文献内容并分析...</p>';

    // 先提取引用文献文档内容（如果尚未提取）
    const ocrConfig = window.AI.getOCRConfig(config);
    const primaryEngine = ocrConfig.engine || "paddle_ocr_vl";
    const glmApiKey = window.AI.getGlmOcrApiKey(config);
    const isUS = currentData.office === "US";
    const urlDocNum = isUS ? currentData.applicationNumber : encodeURIComponent(currentData.docNumber || currentData.applicationNumber);

    for (const doc of citedDocs) {
      if (kanbanState.extractions[doc.idx] && kanbanState.extractions[doc.idx].text) continue;

      // 需要先提取此文档
      const extractUrl = `/api/gd/doc-content/svc/doccontent/${currentData.office}/${urlDocNum}/${doc.docId}/${doc.numberOfPages}/${doc.docFormat}`;
      try {
        analysisContent.innerHTML = `<p class="extracting">正在提取 ${doc.docCode} - ${doc.name}...</p>`;
        const resp = await fetch(extractUrl);
        if (!resp.ok) {
          kanbanState.extractions[doc.idx] = { text: "", error: `HTTP ${resp.status}` };
          continue;
        }
        const arrayBuf = await resp.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuf)));

        const ocrResp = await fetch("/api/gd/extract-text/ocr", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pdf_base64: b64, engine: primaryEngine }),
        });
        if (!ocrResp.ok) {
          kanbanState.extractions[doc.idx] = { text: "", error: `OCR HTTP ${ocrResp.status}` };
          continue;
        }
        const ocrResult = await ocrResp.json();
        if (ocrResult.error) {
          // 降级尝试 GLM OCR
          if (glmApiKey && primaryEngine !== "glm_ocr") {
            try {
              const glmResp = await fetch("/api/gd/extract-text/ocr", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ pdf_base64: b64, engine: "glm_ocr", glm_api_key: glmApiKey }),
              });
              const glmResult = await glmResp.json();
              if (!glmResult.error && glmResult.text) {
                kanbanState.extractions[doc.idx] = {
                  markdown: glmResult.markdown || "",
                  text: glmResult.text || "",
                  blocks: glmResult.blocks || [],
                  pageDims: glmResult.pageDims || {},
                  engine: "glm_ocr",
                };
                continue;
              }
            } catch {}
          }
          kanbanState.extractions[doc.idx] = { text: "", error: ocrResult.error };
          continue;
        }
        kanbanState.extractions[doc.idx] = {
          markdown: ocrResult.markdown || "",
          text: ocrResult.text || "",
          blocks: ocrResult.blocks || [],
          pageDims: ocrResult.pageDims || {},
          engine: ocrResult.engine || primaryEngine,
        };
      } catch (e) {
        kanbanState.extractions[doc.idx] = { text: "", error: e.message };
      }
      if (citedRefsAbortController && citedRefsAbortController.signal.aborted) break;
    }

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

    analysisContent.innerHTML = '';
    let fullText = "";
    let _streamRafPending = false;
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
        if (!_streamRafPending) {
          _streamRafPending = true;
          requestAnimationFrame(() => {
            analysisContent.innerHTML = marked.parse(fullText);
            analysisSection.scrollTop = analysisSection.scrollHeight;
            _streamRafPending = false;
          });
        }
      }
    }

    kanbanState.citedRefsAnalysis = fullText;
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

    manualSelectPanel.classList.remove("hidden");

    const items = kanbanState.documents;
    const CITED_DOC_CODES = ["FOR", "892", "1449", "IDS", "SRNT", "SRFW"];

    let html = '<div class="ai-manual-header"><span class="ai-manual-title">手动选择引用文献文件范围</span></div>';
    html += '<div class="ai-manual-select-all"><button id="cited-manual-select-all" class="btn-small btn-extract">全选</button><button id="cited-manual-select-none" class="btn-small btn-extract">全不选</button><button id="cited-manual-select-default" class="btn-small btn-extract">默认选择</button></div>';
    html += '<div class="ai-manual-docs">';
    items.forEach(it => {
      html += `
        <label class="ai-manual-doc-item">
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
    html += '<div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">';
    html += '<button id="cited-manual-select-cancel" class="btn-secondary">取消</button>';
    html += '<button id="cited-manual-select-merge-btn" class="btn-secondary">合并导出选中文档</button>';
    html += '<button id="cited-manual-select-confirm" class="btn-primary">确认并开始AI梳理</button>';
    html += '</div>';

    manualSelectPanel.innerHTML = html;

    // Try to load saved selections, fall back to defaults
    if (!loadManualSelection("cited", items, ".cited-manual-select-checkbox", manualSelectPanel, null)) {
      // Apply default checks (already set in HTML via CITED_DOC_CODES)
    }

    document.getElementById("cited-manual-select-all").addEventListener("click", () => {
      manualSelectPanel.querySelectorAll(".cited-manual-select-checkbox").forEach(cb => cb.checked = true);
    });
    document.getElementById("cited-manual-select-none").addEventListener("click", () => {
      manualSelectPanel.querySelectorAll(".cited-manual-select-checkbox").forEach(cb => cb.checked = false);
    });
    document.getElementById("cited-manual-select-default").addEventListener("click", () => {
      manualSelectPanel.querySelectorAll(".cited-manual-select-checkbox").forEach(cb => {
        const idx = parseInt(cb.dataset.idx);
        const it = items.find(d => d.idx === idx);
        cb.checked = it && CITED_DOC_CODES.includes(it.docCode);
      });
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

manualSelectBtn.addEventListener("click", () => {
  const items = kanbanState.documents;
  if (!items || items.length === 0) {
    showError("请先查询专利并加载审查文档");
    return;
  }

  const manualSelectPanel = document.getElementById("ai-manual-select");
  if (!manualSelectPanel) return;

  // Interrupt any existing process
  if (activeAnalysisProcess) {
    abortActiveProcess();
  }

  const canDownload = currentData && (currentData.office === "US" || currentData.office === "EP");
  if (!canDownload) {
    showError("CN / DE / JP 专利暂不支持文档下载与提取，无法进行 AI 梳理");
    return;
  }

  // Build checkbox list
  const typeLabels = { office_action: "审查意见", response: "答复", request: "请求", allowance: "授权", notification: "通知", misc: "其他" };
  let html = '<div class="ai-manual-header"><span class="ai-manual-title">手动选择分析文件范围</span></div>';
  html += '<div class="ai-manual-select-all"><button id="manual-select-all" class="btn-small btn-extract">全选</button><button id="manual-select-none" class="btn-small btn-extract">全不选</button><button id="manual-select-default" class="btn-small btn-extract">默认选择</button></div>';
  html += '<div class="ai-manual-docs">';
  items.forEach(it => {
    const typeLabel = typeLabels[it.type] || it.type;
    html += `
      <label class="ai-manual-doc-item">
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

  document.getElementById("manual-select-all").addEventListener("click", () => {
    manualSelectPanel.querySelectorAll(".manual-select-checkbox").forEach(cb => cb.checked = true);
  });
  document.getElementById("manual-select-none").addEventListener("click", () => {
    manualSelectPanel.querySelectorAll(".manual-select-checkbox").forEach(cb => cb.checked = false);
  });
  document.getElementById("manual-select-default").addEventListener("click", () => {
    manualSelectPanel.querySelectorAll(".manual-select-checkbox").forEach(cb => {
      const idx = parseInt(cb.dataset.idx);
      const it = items.find(d => d.idx === idx);
      cb.checked = it && shouldIncludeInAIAnalysis(currentData.office, it.type);
    });
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
    analysisContent.innerHTML = '<p class="extracting">正在准备手动选择的文档提取内容...</p>';

    const selectedItems = items.filter(it => selectedIdxs.includes(it.idx));
    const CLAIMS_CODES_MANUAL = ["CLM", "FWCLM"];
    const oaItems = selectedItems;

    const ocrConfig = window.AI.getOCRConfig(config);
    const primaryEngine = ocrConfig.engine || "paddle_ocr_vl";
    const glmApiKey = window.AI.getGlmOcrApiKey(config);
    const statusEl = document.getElementById("ai-analysis-status");
    const isUS = currentData.office === "US";
    const urlDocNum = isUS ? currentData.applicationNumber : encodeURIComponent(currentData.docNumber || currentData.applicationNumber);

    const MAX_RETRIES = 2;
    const extractReport = { success: [], empty: [], failed: [] };

    async function extractWithRetry(it, engine, retriesLeft) {
      const container = document.getElementById("kanban-extracted-" + it.idx);
      if (container) {
        container.classList.remove("hidden");
        const attemptNum = MAX_RETRIES - retriesLeft + 1;
        container.innerHTML = '<p class="extracting">正在提取（' + escapeHtml(engine) + '）' + (attemptNum > 1 ? '第' + attemptNum + '次尝试' : '') + '...</p>';
      }
      try {
        const useApiKey = engine === "glm_ocr" ? glmApiKey : "";
        const result = await doExtractText(currentData.office, urlDocNum, it.docId, it.numberOfPages, it.docFormat, engine, useApiKey);
        if (result.error) {
          if (retriesLeft > 0) {
            const fallbackEngine = engine === "paddle_ocr_vl" ? "glm_ocr" : "paddle_ocr_vl";
            if (fallbackEngine === "glm_ocr" && !glmApiKey) {
              extractReport.failed.push({ name: it.name, docCode: it.docCode, reason: result.error + "（无 GLM Key，无法降级）" });
              if (container) container.innerHTML = '<p class="extract-error">' + escapeHtml(result.error) + '</p>';
              return false;
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
            const fallbackEngine = engine === "paddle_ocr_vl" ? "glm_ocr" : "paddle_ocr_vl";
            if (fallbackEngine === "glm_ocr" && !glmApiKey) {
              extractReport.empty.push({ name: it.name, docCode: it.docCode });
              if (container) container.innerHTML = '<p class="extract-empty">未能提取到文本（无 GLM Key，无法降级）</p>';
              return false;
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
        if (blocks.length > 0) {
          blocks.forEach(b => {
            kanbanState.traceIndex[b.block_id] = {
              docIdx: it.idx, page: b.page, bbox: b.bbox,
              content: b.content, label: b.label,
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
        if (retriesLeft > 0) {
          await new Promise(r => setTimeout(r, 2000));
          return await extractWithRetry(it, engine, retriesLeft - 1);
        }
        extractReport.failed.push({ name: it.name, docCode: it.docCode, reason: e.message });
        const container = document.getElementById("kanban-extracted-" + it.idx);
        if (container) container.innerHTML = '<p class="extract-error">' + escapeHtml(e.message) + '</p>';
        return false;
      }
    }

    const missing = oaItems.filter(it => !kanbanState.extractions[it.idx]);
    for (let i = 0; i < missing.length; i++) {
      const it = missing[i];
      if (statusEl) statusEl.textContent = "提取中 (" + (i + 1) + "/" + missing.length + "): " + it.name;
      await extractWithRetry(it, primaryEngine, MAX_RETRIES);
      if (kanbanAutoAbortController && kanbanAutoAbortController.signal.aborted) break;
    }

    const successCount = extractReport.success.length;
    if (successCount === 0) {
      analysisContent.innerHTML = '<p class="placeholder" style="color:var(--danger)">所有文档提取均失败，无法进行 AI 分析。</p>';
      const manualSelectBtnEl2 = document.getElementById("kanban-manual-select-btn");
      if (manualSelectBtnEl2) { manualSelectBtnEl2.disabled = false; manualSelectBtnEl2.classList.remove("hidden"); }
      kanbanAutoAbortController = null;
      return;
    }

    if (statusEl) statusEl.textContent = "正在用 AI 整理审查历史...";
    analysisContent.innerHTML = '<p class="extracting">AI 正在整理选中的文档...</p>';

    const hasBlocks = oaItems.some(it => {
      const ext = kanbanState.extractions[it.idx];
      return ext && ext.blocks && ext.blocks.length > 0;
    });

    const annotatedLines = [];
    const timelineSummary = buildTimelineSummary(currentData.office, kanbanState.documents);

    oaItems.forEach((it, idx) => {
      const ext = kanbanState.extractions[it.idx];
      if (!ext) {
        const isClaimsDoc = CLAIMS_CODES_MANUAL.includes(it.docCode);
        const missingHeader = isClaimsDoc
          ? `【${idx + 1}】${it.docCode} - ${it.name}（${it.date}）[权利要求参考]`
          : `【${idx + 1}】${it.docCode} - ${it.name}（${it.date}）`;
        annotatedLines.push(missingHeader + "\n[未能提取内容]");
        return;
      }
      const isClaimsDoc = CLAIMS_CODES_MANUAL.includes(it.docCode);
      const header = isClaimsDoc
        ? `【${idx + 1}】${it.docCode} - ${it.name}（${it.date}）[权利要求参考]`
        : `【${idx + 1}】${it.docCode} - ${it.name}（${it.date}）`;
      if (hasBlocks && ext.blocks && ext.blocks.length > 0) {
        const blockParts = ext.blocks
          .filter(b => b.content && b.content.trim())
          .map(b => `[ref:${b.block_id}]${b.content}[/ref:${b.block_id}]`)
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
      let _streamRafPending = false;
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
          if (!_streamRafPending) {
            _streamRafPending = true;
            requestAnimationFrame(() => {
              analysisContent.innerHTML = '<div class="kanban-analysis-content markdown-body">' + renderMarkdownWithTrace(fullText) + "</div>";
              _streamRafPending = false;
            });
          }
        }
      }
      kanbanState.analysis = fullText;
      // Save context for continued chat
      kanbanState.analysisSystemPrompt = systemPrompt;
      kanbanState.analysisUserMessage = userMessage;
      analysisChatHistory = [];
      showAnalysisChatToggle();
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
        analysisContent.innerHTML = reportHtml + '<div class="kanban-analysis-content markdown-body">' + renderMarkdownWithTrace(fullText) + "</div>";
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
});

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
    const refs = refsStr.split(",").map(r => r.trim()).filter(r => r.startsWith("B_"));
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
      // Extract block index from block_id like "B_p2_5" -> 5
      const blockMatch = ref.match(/B_p(\d+)_(\d+)/);
      if (blockMatch) {
        grouped[key].push({ ref, blockIdx: parseInt(blockMatch[2]), page: parseInt(blockMatch[1]) });
      } else {
        grouped[key].push({ ref, blockIdx: -1, page: info.page });
      }
    });

    Object.keys(grouped).forEach(key => {
      const [docIdxStr, pageStr, docLabel] = key.split("|");
      const page = parseInt(pageStr);
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
          const refId = `B_p${page}_${bi}`;
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
      return marked.parse(processed);
    } catch (e) {
      return escapeHtml(processed).replace(/\n/g, "<br>");
    }
  }
  return escapeHtml(processed).replace(/\n/g, "<br>");
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

  // Set pending highlight before any view switching
  pdfViewState.pendingHighlight = primaryBlockId;
  pdfViewState.pendingHighlightRange = blockIds;
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
    // If pendingHighlight is still set, try direct highlight
    if (pdfViewState.active) {
      const overlay = readerPdfContainer.querySelector(`.pdf-block-overlay[data-block-id="${primaryBlockId}"]`);
      if (overlay) {
        highlightPdfBlock(primaryBlockId);
        blockIds.forEach(id => {
          if (id !== primaryBlockId) {
            const el = readerPdfContainer.querySelector(`.pdf-block-overlay[data-block-id="${id}"]`);
            if (el) el.classList.add("highlight-range");
          }
        });
        pdfViewState.pendingHighlight = null;
        pdfViewState.pendingHighlightRange = null;
        pdfViewState.traceJumpPending = false;
      }
    }

    // Text view fallback
    if (!pdfViewState.active) {
      const md = kanbanState.extractions[info.docIdx];
      if (!md) return;
      const content = md.markdown || md.text || "";
      const blocks = md.blocks || [];
      const targetBlock = blocks.find(b => b.block_id === primaryBlockId);
      if (targetBlock && targetBlock.content) {
        const el = readerContent.querySelector(`[data-block-id="${primaryBlockId}"]`);
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
          <span class="trace-locator-id">${escapeHtml(primaryBlockId)}</span>
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
  const timelineItems = items.filter(it => importantTypes.indexOf(it.type) !== -1 || importantDocCodes.includes(it.docCode));

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

function openReader(defaultToPdf = false, skipRender = false) {
  if (!readerModal) return;
  const items = kanbanState.documents;
  if (!items || items.length === 0) {
    showError("请先查询专利并加载审查文档");
    return;
  }

  readerModal.classList.remove("hidden");
  if (defaultToPdf && !pdfViewState.active) {
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
  if (activeEl) activeEl.classList.add("active");

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
    readerPdfToggle.classList.remove("active");
    readerPdfToggle.textContent = "PDF 视图";
  } else {
    pdfViewState.active = true;
    readerPdfView.classList.remove("hidden");
    readerContent.classList.add("hidden");
    readerPdfToggle.classList.add("active");
    readerPdfToggle.textContent = "文本视图";
    if (!skipRender && pdfViewState.currentDocIdx !== null) {
      renderPdfView(pdfViewState.currentDocIdx);
    }
  }
}

function showOcrProgressOverlay() {
  // Remove existing overlay if any
  hideOcrProgressOverlay();
  const overlay = document.createElement("div");
  overlay.id = "ocr-progress-overlay";
  overlay.style.cssText = "position:sticky;top:0;z-index:50;display:flex;align-items:center;gap:10px;padding:8px 16px;background:var(--accent-dim);border-bottom:2px solid var(--accent);font-size:13px;color:var(--accent);";
  overlay.innerHTML = '<div class="ocr-progress-spinner" style="width:16px;height:16px;border:2px solid var(--accent);border-top-color:transparent;border-radius:50%;animation:spin 0.8s linear infinite;flex-shrink:0;"></div><span>正在 OCR 识别中，PDF 已可浏览...</span>';
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
        showOcrProgressOverlay();
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

  const MAX_RETRIES = 2;
  let success = false;

  async function tryExtract(engine, retriesLeft) {
    try {
      const useApiKey = engine === "glm_ocr" ? glmApiKey : "";
      const result = await doExtractText(currentData.office, urlDocNum, it.docId, it.numberOfPages, it.docFormat, engine, useApiKey);
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
      const blocks = result.blocks || [];
      const pageDimensions = result.page_dimensions || {};
      kanbanState.extractions[it.idx] = { text, markdown, engine: result.engine, blocks, pageDimensions };
      if (blocks.length > 0) {
        blocks.forEach(b => {
          kanbanState.traceIndex[b.block_id] = {
            docIdx: it.idx, page: b.page, bbox: b.bbox,
            content: b.content, label: b.label,
            pageDimensions: pageDimensions[b.page] || null,
          };
        });
      }
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
        if (pdfTranslateContent) {
          pdfTranslateContent.innerHTML = `<div class="pdf-translate-result">${renderMarkdown(fullResponse)}</div>`;
        }
      }
    }

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
  // Switch to the specified panel tab
  if (activePanel) {
    switchRightPanelTab(activePanel);
  }
}

function exitReadingMode() {
  const readerBody = document.querySelector(".reader-body");
  const rightPanel = document.getElementById("reader-right-panel");
  const translatePanel = document.getElementById("pdf-translate-panel");
  const chatPanel = document.getElementById("reader-chat-panel");
  // Hide both panels
  if (translatePanel) translatePanel.classList.add("hidden");
  if (chatPanel) chatPanel.classList.add("hidden");
  if (readerBody) readerBody.classList.remove("reading-mode");
  if (rightPanel) rightPanel.classList.add("hidden");
  // Deactivate chat toggle button
  if (readerChatToggle) readerChatToggle.classList.remove("active");
}

function switchRightPanelTab(panelName) {
  const translatePanel = document.getElementById("pdf-translate-panel");
  const chatPanel = document.getElementById("reader-chat-panel");
  const tabs = document.querySelectorAll(".right-panel-tab");

  // Update tab active states
  tabs.forEach(tab => {
    tab.classList.toggle("active", tab.dataset.panel === panelName);
  });

  // Show/hide panels
  if (panelName === "translate") {
    if (translatePanel) translatePanel.classList.remove("hidden");
    if (chatPanel) chatPanel.classList.add("hidden");
  } else if (panelName === "chat") {
    if (chatPanel) chatPanel.classList.remove("hidden");
    if (translatePanel) translatePanel.classList.add("hidden");
  }
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
    readerContent.innerHTML = "<h3>AI 分析中...</h3>";
    let fullContent = "";

    AI.streamChat(provider.type, provider.apiKey, provider.baseUrl, {
      model: provider.model,
      messages,
      maxTokens: 32768,
    }).then(async (stream) => {
      for await (const chunk of stream) {
        if (chunk.content) {
          fullContent += chunk.content;
          readerContent.innerHTML = marked.parse(fullContent);
        }
      }
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
      if (readerFloatingBall) readerFloatingBall.classList.add("hidden");
      // Reset PDF view state when closing
      if (pdfViewState.active) {
        pdfViewState.active = false;
        readerPdfView.classList.add("hidden");
        readerContent.classList.remove("hidden");
        readerPdfToggle.classList.remove("active");
        readerPdfToggle.textContent = "PDF 视图";
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
      if (content && content.classList.contains("docked")) {
        // In docked mode, minimize to floating ball instead of closing
        readerModal.classList.add("hidden");
        if (readerFloatingBall) readerFloatingBall.classList.remove("hidden");
      } else {
        // Full screen mode, close fully
        readerModal.classList.add("hidden");
        if (readerFloatingBall) readerFloatingBall.classList.add("hidden");
        if (pdfViewState.active) {
          pdfViewState.active = false;
          readerPdfView.classList.add("hidden");
          readerContent.classList.remove("hidden");
          readerPdfToggle.classList.remove("active");
          readerPdfToggle.textContent = "PDF 视图";
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

  if (readerPdfToggle) {
    readerPdfToggle.addEventListener("click", togglePdfView);
  }

  if (readerDockBtn) {
    readerDockBtn.addEventListener("click", () => {
      const content = document.querySelector(".reader-modal-content");
      if (content) {
        content.classList.add("docked");
        readerDockBtn.classList.add("hidden");
        readerFullscreenBtn.classList.remove("hidden");
      }
    });
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

  if (readerFullscreenBtn) {
    readerFullscreenBtn.addEventListener("click", () => {
      const content = document.querySelector(".reader-modal-content");
      if (content) {
        content.classList.remove("docked");
        readerFullscreenBtn.classList.add("hidden");
        readerDockBtn.classList.remove("hidden");
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
      showOcrProgressOverlay();
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

  // PDF clear selection button
  const clearSelBtn = document.getElementById("pdf-clear-selection-btn");
  if (clearSelBtn) {
    clearSelBtn.addEventListener("click", clearPdfBlockSelection);
  }

  // Right panel close button (exits reading mode entirely)
  const rightPanelCloseBtn = document.getElementById("right-panel-close-btn");
  if (rightPanelCloseBtn) {
    rightPanelCloseBtn.addEventListener("click", () => {
      exitReadingMode();
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

  // Minimize to floating ball
  if (readerMinimizeBtn) {
    readerMinimizeBtn.addEventListener("click", () => {
      readerModal.classList.add("hidden");
      if (readerFloatingBall) readerFloatingBall.classList.remove("hidden");
    });
  }

  // Floating ball click to restore reader
  if (readerFloatingBall) {
    readerFloatingBall.addEventListener("click", () => {
      readerFloatingBall.classList.add("hidden");
      readerModal.classList.remove("hidden");
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

  // Splash screen
  setTimeout(() => {
    const splash = document.getElementById("splash-screen");
    if (splash) {
      splash.style.opacity = "0";
      setTimeout(() => splash.remove(), 500);
    }
  }, 1800);
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
    const stream = AI.streamChat(provider.type, provider.apiKey, provider.baseUrl, {
      model: provider.model,
      messages: messages,
      maxTokens: 4096,
    }, chatAbortController.signal);

    for await (const chunk of stream) {
      if (chatAbortController.signal.aborted) break;
      if (chunk.content) {
        fullResponse += chunk.content;
        if (assistantMsgEl) {
          const contentEl = assistantMsgEl.querySelector(".chat-msg-content") || assistantMsgEl;
          contentEl.innerHTML = renderMarkdown(fullResponse);
        }
      }
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
    for await (const chunk of stream) {
      if (analysisChatAbortController.signal.aborted) break;
      if (chunk.content) {
        fullResponse += chunk.content;
        if (assistantMsgEl) {
          const contentEl = assistantMsgEl.querySelector(".chat-msg-content") || assistantMsgEl;
          contentEl.innerHTML = renderMarkdown(fullResponse);
        }
      }
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
    if (blocks.length > 0) {
      blocks.forEach(b => {
        kanbanState.traceIndex[b.block_id] = {
          docIdx: idx,
          page: b.page,
          bbox: b.bbox,
          content: b.content,
          label: b.label,
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

  if (progressCallback) progressCallback("start", selectedItems.length);

  try {
    const resp = await fetch("/api/merge-pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: selectedItems }),
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
