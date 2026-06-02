const GD_API_BASE = "/api/gd";

const OFFICE_NAMES = {
  US: "美国 (USPTO)",
  CN: "中国 (CNIPA)",
  EP: "欧洲 (EPO)",
  JP: "日本 (JPO)",
  KR: "韩国 (KIPO)",
  WO: "WIPO (PCT)",
  WIPO: "WIPO (PCT)",
};

let currentData = null;

const patentInput = document.getElementById("patent-input");
const searchBtn = document.getElementById("search-btn");
const convertBtn = document.getElementById("convert-btn");
const queryTypeSelect = document.getElementById("query-type");
const officeBadge = document.getElementById("office-badge");
const resultSection = document.getElementById("result-section");
const convertSection = document.getElementById("convert-section");
const batchSection = document.getElementById("batch-section");
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
const ocrAutoExtract = document.getElementById("ocr-auto-extract");
const aiTestBtn = document.getElementById("ai-test-btn");
const aiSaveBtn = document.getElementById("ai-save-btn");
const aiTestResult = document.getElementById("ai-test-result");
const aiSummarizeBtn = document.getElementById("ai-summarize-btn");
const aiStatus = document.getElementById("ai-status");
const aiSummaryResult = document.getElementById("ai-summary-result");
const kanbanAutoBtn = document.getElementById("kanban-auto-btn");

const batchBtn = document.getElementById("batch-btn");
const batchInput = document.getElementById("batch-input");
const batchStartBtn = document.getElementById("batch-start-btn");
const batchProgress = document.getElementById("batch-progress");
const progressFill = document.getElementById("progress-fill");
const progressText = document.getElementById("progress-text");
const batchResults = document.getElementById("batch-results");
const batchResultsList = document.getElementById("batch-results-list");

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
  if (upper.startsWith("CN")) return "CN";
  if (upper.startsWith("EP")) return "EP";
  if (upper.startsWith("JP")) return "JP";
  if (upper.startsWith("KR")) return "KR";
  if (upper.startsWith("WO") || upper.startsWith("PCT")) return "WO";
  return null;
}

function parsePatentNumber(input) {
  const trimmed = input.trim();
  const office = detectOffice(trimmed);
  if (!office) return null;

  let stripped = trimmed;
  let queryType = "application";

  const kindCodeMatch = stripped.match(/^(.*?[0-9])([A-Z]\d+)$/i);
  let kindCode = null;
  if (kindCodeMatch) {
    stripped = kindCodeMatch[1];
    kindCode = kindCodeMatch[2].toUpperCase();
  }

  let appNum = stripped;
  switch (office) {
    case "US":
      appNum = stripped.replace(/^US/i, "").replace(/[^0-9]/g, "");
      break;
    case "CN":
      appNum = stripped.replace(/^CN/i, "").replace(/\./g, "");
      if (appNum.length <= 9 && !kindCode) {
        queryType = "publication";
      }
      break;
    case "EP":
      appNum = stripped.replace(/^EP/i, "").replace(/[\s.]/g, "");
      if (appNum.length <= 8 && !kindCode) {
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
  }

  return { office, raw: trimmed, applicationNumber: appNum, kindCode: kindCode, queryType };
}

async function gdFetch(urlPath) {
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

  const pn = parsePatentNumber(input);
  if (!pn) { showError("无法识别专利号格式: " + input); return; }

  searchBtn.disabled = true;
  loadingText.textContent = "正在查询专利信息...";
  loading.classList.remove("hidden");
  resultSection.classList.add("hidden");
  convertSection.classList.add("hidden");
  batchSection.classList.add("hidden");
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
  } catch (e) {
    warnings.push("同族查询失败: " + e.message);
  }

  loadingText.textContent = "正在查询审查文档...";
  await new Promise(r => setTimeout(r, 1500));

  try {
    const docData = await gdFetch(`/doc-list/svc/doclist/${office}/${docNum}/A`);
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
  try { renderDocuments(result); } catch (e) { console.error("renderDocuments:", e); }
  try { renderKanban(result); } catch (e) { console.error("renderKanban:", e); }

  if (warnings.length > 0) {
    warnings.forEach(w => showError("⚠️ " + w));
  }

  aiSummarizeBtn.disabled = false;
  kanbanAutoBtn.disabled = false;
  resultSection.classList.remove("hidden");
  searchBtn.disabled = false;
  loading.classList.add("hidden");

  const config = window.AI.loadAIConfig();
  const ocrConfig = window.AI.getOCRConfig(config);
  if (ocrConfig.autoExtract && result.documents) {
    autoExtractOfficeActions(result);
  }
});

let kanbanState = {
  documents: [],
  extractions: {},
  analysis: "",
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

  const columns = [
    { key: "office_action", title: "📋 审查意见", color: "kanban-col-oa" },
    { key: "response", title: "💬 申请人答复", color: "kanban-col-response" },
    { key: "request", title: "📝 申请人请求", color: "kanban-col-request" },
    { key: "allowance", title: "✅ 授权通知", color: "kanban-col-allowance" },
    { key: "notification", title: "📢 通知", color: "kanban-col-notification" },
    { key: "misc", title: "📦 其他文件", color: "kanban-col-misc" },
  ];

  let html = '<div class="kanban-columns">';
  columns.forEach(col => {
    const colItems = items.filter(it => it.type === col.key);
    const count = colItems.length;
    html += `
      <div class="kanban-column ${col.color}">
        <div class="kanban-column-header">
          <span class="kanban-column-title">${col.title}</span>
          <span class="kanban-column-count">${count}</span>
        </div>
        <div class="kanban-column-body">
    `;
    if (count === 0) {
      html += '<p class="kanban-empty">无</p>';
    } else {
      colItems.forEach(it => {
        const isUS = data.office === "US";
        const urlDocNum = isUS ? data.applicationNumber : encodeURIComponent(data.docNumber || data.applicationNumber);
        const encodedDocId = encodeURIComponent(it.docId);
        const extractUrl = it.docId ? `/api/gd/extract-text/${data.office}/${urlDocNum}/${encodedDocId}/${it.numberOfPages}/${it.docFormat}` : null;
        const downloadUrl = it.docId ? `/api/gd/doc-content/svc/doccontent/${data.office}/${urlDocNum}/${encodedDocId}/${it.numberOfPages}/${it.docFormat}` : null;
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
  if (data.documents && data.documents.title) {
    title = data.documents.title;
  } else if (data.family && data.family.list && data.family.list.length > 0) {
    title = data.family.list[0].title || "";
  }

  const queryTypeLabel = data.queryType === "publication" ? "公开号/专利号" : "申请号";

  appInfo.innerHTML = `
    <div class="info-row"><span class="info-label">申请局</span><span class="info-value">${office}</span></div>
    <div class="info-row"><span class="info-label">${queryTypeLabel}</span><span class="info-value">${data.applicationNumber || "-"}</span></div>
    ${data.documents && data.documents.docNumber ? '<div class="info-row"><span class="info-label">文档编号</span><span class="info-value">' + escapeHtml(data.documents.docNumber) + '</span></div>' : ''}
    ${title ? '<div class="info-row"><span class="info-label">标题</span><span class="info-value">' + escapeHtml(title) + '</span></div>' : ''}
  `;

  const family = data.family;
  if (family) {
    const famCount = countFamilyMembers(family);
    const docCount = countDocuments(data.documents);
    appStatus.innerHTML = `
      <div class="info-row"><span class="info-label">同族成员</span><span class="info-value">${famCount} 个</span></div>
      <div class="info-row"><span class="info-label">审查文档</span><span class="info-value">${docCount} 份</span></div>
    `;
  } else {
    appStatus.innerHTML = '<p class="placeholder">暂无状态信息</p>';
  }
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

async function autoExtractOfficeActions(data) {
  const items = kanbanState.documents;
  const oaItems = items.filter(it => shouldIncludeInAIAnalysis(data.office, it.type));
  if (oaItems.length === 0) return;

  const config = window.AI.loadAIConfig();
  const ocrConfig = window.AI.getOCRConfig(config);
  const provider = window.AI.getCurrentProvider(config);
  const engine = ocrConfig.engine || "paddle_ocr_vl";

  const statusEl = document.getElementById("kanban-status");
  for (let i = 0; i < oaItems.length; i++) {
    const it = oaItems[i];
    if (statusEl) statusEl.textContent = "自动提取中 (" + (i + 1) + "/" + oaItems.length + "): " + it.name;
    const container = document.getElementById("kanban-extracted-" + it.idx);
    if (!container) continue;
    container.classList.remove("hidden");
    container.innerHTML = '<p class="extracting">正在自动提取内容（引擎: ' + escapeHtml(engine) + '）...</p>';

    const isUS = data.office === "US";
    const urlDocNum = isUS ? data.applicationNumber : encodeURIComponent(data.docNumber || data.applicationNumber);
    const encodedDocId = encodeURIComponent(it.docId);
    const extractUrl = `/api/gd/extract-text/${data.office}/${urlDocNum}/${encodedDocId}/${it.numberOfPages}/${it.docFormat}?engine=${encodeURIComponent(engine)}`;
    let finalUrl = extractUrl;
    if (engine === "glm_ocr" && provider && provider.apiKey) {
      finalUrl += "&api_key=" + encodeURIComponent(provider.apiKey);
    }

    try {
      const resp = await fetch(finalUrl);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const result = await resp.json();
      if (result.error) {
        container.innerHTML = '<p class="extract-error">提取失败: ' + escapeHtml(result.error) + '</p>';
        continue;
      }
      const text = result.text || "";
      const markdown = result.markdown || "";
      if (!text && !markdown) {
        container.innerHTML = '<p class="extract-empty">未能提取到文本</p>';
        continue;
      }
      const displayText = markdown || text;
      kanbanState.extractions[it.idx] = { text, markdown, engine: result.engine };
      container.innerHTML = `
        <div class="extracted-header">
          <span class="extracted-engine">引擎: ${escapeHtml(result.engine)}</span>
          <span class="extracted-chars">字符数: ${displayText.length}</span>
          <button class="btn-small btn-ai-analyze" data-action="ai-analyze-doc" data-idx="${it.idx}" data-doctype="${escapeHtml(it.docCode)}">AI 分析</button>
        </div>
        <pre class="extracted-text">${escapeHtml(displayText.length > 8000 ? displayText.substring(0, 8000) + "\n\n[...已截断...]" : displayText)}</pre>
      `;
    } catch (e) {
      container.innerHTML = '<p class="extract-error">提取失败: ' + escapeHtml(e.message) + '</p>';
    }
  }
  if (statusEl) {
    const ok = Object.keys(kanbanState.extractions).length;
    statusEl.textContent = "共 " + items.length + " 份审查文档，自动提取完成 " + ok + " 份";
  }
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

  const docNumber = docs.docNumber || data.applicationNumber;
  const isUS = data.office === "US";
  const urlDocNum = isUS ? data.applicationNumber : encodeURIComponent(docNumber);

  let html = "";
  docList.forEach((d, idx) => {
    const docType = d.docCode || d.documentType || d.kindCode || d.type || "文档";
    const desc = d.docDesc || d.documentDescription || d.description || d.docId || "";
    const date = d.legalDateStr || d.documentDate || d.date || "";
    const docId = d.documentId || d.docId || "";
    const numberOfPages = d.numberOfPages != null ? d.numberOfPages : 1;
    const docFormat = d.docFormat || "PDF";

    let typeClass = "doc-type";
    const lowerDesc = desc.toLowerCase();
    if (lowerDesc.includes("rejection") || lowerDesc.includes("拒绝") || lowerDesc.includes("驳回")) {
      typeClass += " rejection";
    } else if (lowerDesc.includes("allowance") || lowerDesc.includes("准予") || lowerDesc.includes("授权")) {
      typeClass += " allowance";
    }

    const encodedDocId = encodeURIComponent(docId);
    const downloadUrl = docId ? `/api/gd/doc-content/svc/doccontent/${data.office}/${urlDocNum}/${encodedDocId}/${numberOfPages}/${docFormat}` : null;
    const extractUrl = docId ? `/api/gd/extract-text/${data.office}/${urlDocNum}/${encodedDocId}/${numberOfPages}/${docFormat}` : null;

    html += `
      <div class="doc-item">
        <span class="${typeClass}">${escapeHtml(docType)}</span>
        <div class="doc-info">
          <div class="doc-desc">${escapeHtml(desc)}</div>
          ${date ? '<div class="doc-date">' + escapeHtml(date) + '</div>' : ''}
        </div>
        <div class="doc-actions">
          ${extractUrl ? `<select class="engine-select" data-idx="${idx}"><option value="auto">自动</option><option value="paddle_ocr_vl">PaddleOCR</option><option value="glm_ocr">GLM OCR</option></select>` : ''}
          ${extractUrl ? `<button class="btn-small btn-extract" data-action="extract" data-url="${extractUrl}" data-idx="${idx}" data-doctype="${escapeHtml(docType)}">提取内容</button>` : ''}
          ${downloadUrl ? `<button class="btn-small btn-download" data-action="download" data-url="${downloadUrl}" data-filename="${escapeHtml(docType)}_${escapeHtml(date.replace(/\//g, '-'))}.pdf">下载</button>` : ''}
        </div>
      </div>
      <div id="doc-extracted-${idx}" class="doc-extracted hidden"></div>
    `;
  });
  container.innerHTML = html;
}

async function extractDocumentText(url, idx, docType) {
  const container = document.getElementById("doc-extracted-" + idx);
  if (!container) return;
  container.classList.remove("hidden");

  const engineSelect = document.querySelector(`.engine-select[data-idx="${idx}"]`);
  const selectedEngine = engineSelect ? engineSelect.value : "auto";
  const engine = selectedEngine === "auto" ? (ocrEngineSelect ? ocrEngineSelect.value : "paddle_ocr_vl") : selectedEngine;

  const sep = url.includes("?") ? "&" : "?";
  let extractUrl = url + sep + "engine=" + encodeURIComponent(engine);

  const config = window.AI.loadAIConfig();
  const provider = window.AI.getCurrentProvider(config);
  if (engine === "glm_ocr" && provider && provider.apiKey) {
    extractUrl += "&api_key=" + encodeURIComponent(provider.apiKey);
  }

  container.innerHTML = '<p class="extracting">正在提取文档内容（引擎: ' + escapeHtml(engine === "auto" ? "自动" : engine) + '）...</p>';

  try {
    const resp = await fetch(extractUrl);
    if (!resp.ok) throw new Error("提取失败: HTTP " + resp.status);
    const data = await resp.json();

    if (data.error) {
      container.innerHTML = '<p class="extract-error">提取失败: ' + escapeHtml(data.error) + '</p>';
      return;
    }

    const text = data.text || "";
    const markdown = data.markdown || "";
    const usedEngine = data.engine || "unknown";

    if (!text && !markdown) {
      container.innerHTML = '<p class="extract-empty">未能提取到文本内容。可尝试切换 OCR 引擎（PaddleOCR 或 GLM OCR）后重新提取。</p>';
      return;
    }

    const displayText = markdown || text;
    const charCount = displayText.length;

    container.innerHTML = `
      <div class="extracted-header">
        <span class="extracted-engine">引擎: ${escapeHtml(usedEngine)}</span>
        <span class="extracted-chars">字符数: ${charCount}</span>
        <button class="btn-small btn-ai-analyze" data-action="ai-analyze-doc" data-idx="${idx}" data-doctype="${escapeHtml(docType)}">AI 分析此文档</button>
      </div>
      <pre class="extracted-text">${escapeHtml(displayText)}</pre>
    `;

    container._extractedText = text;
    container._extractedMarkdown = markdown;
    container._docType = docType;
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

  aiSummarizeBtn.disabled = true;
  aiStatus.textContent = "正在分析文档: " + docType + "...";
  aiStatus.className = "ai-status ai-status-processing";
  aiSummaryResult.classList.remove("hidden");

  const truncatedContent = content.length > 30000 ? content.substring(0, 30000) + "\n\n[...内容过长已截断...]" : content;

  const systemPrompt = "你是一位专业的专利审查分析师。请对以下专利审查文档内容进行详细分析，包括：1. 文档类型和性质 2. 核心内容摘要 3. 关键法律和技术要点 4. 对申请人/审查员的影响 5. 建议的应对策略。请用中文回答。";

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
        maxTokens: 16384,
      }
    )) {
      if (chunk.content) {
        fullText += chunk.content;
        aiSummaryResult.innerHTML = '<div class="ai-summary-content">' + escapeHtml(fullText).replace(/\n/g, "<br>") + "</div>";
      }
    }
    aiStatus.textContent = "分析完成 ✓";
    aiStatus.className = "ai-status ai-status-success";
  } catch (e) {
    aiSummaryResult.innerHTML = '<p class="placeholder" style="color:var(--danger)">' + escapeHtml(e.toString()) + "</p>";
    aiStatus.textContent = "分析失败 ✗";
    aiStatus.className = "ai-status ai-status-error";
  } finally {
    aiSummarizeBtn.disabled = false;
  }
}

async function downloadDocument(url, filename) {
  try {
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

convertBtn.addEventListener("click", () => {
  const input = patentInput.value.trim();
  if (!input) return;
  const pn = parsePatentNumber(input);
  if (!pn) { showError("无法识别专利号格式"); return; }
  document.getElementById("convert-result").innerHTML =
    '<pre class="json-preview">' + JSON.stringify(pn, null, 2) + '</pre>';
  convertSection.classList.remove("hidden");
});

document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  });
});

batchBtn.addEventListener("click", () => {
  batchSection.classList.toggle("hidden");
});

batchStartBtn.addEventListener("click", async () => {
  const text = batchInput.value.trim();
  if (!text) return;
  const numbers = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  if (numbers.length === 0) return;

  batchStartBtn.disabled = true;
  batchProgress.classList.remove("hidden");
  batchResults.classList.remove("hidden");
  batchResultsList.innerHTML = "";
  let completed = 0;
  progressFill.style.width = "0%";
  progressText.textContent = `0/${numbers.length}`;

  for (const num of numbers) {
    completed++;
    progressFill.style.width = `${(completed / numbers.length) * 100}%`;
    progressText.textContent = `${completed}/${numbers.length}`;

    const item = document.createElement("div");
    item.className = "batch-item";

    const pn = parsePatentNumber(num);
    if (!pn) {
      item.innerHTML = `<div class="batch-item-header"><span class="batch-item-num">${escapeHtml(num)}</span><span class="batch-item-error">无法识别格式</span></div>`;
      batchResultsList.appendChild(item);
      continue;
    }

    try {
      const familyData = await gdFetch(`/patent-family/svc/family/application/${pn.office}/${pn.applicationNumber}`);
      const famCount = countFamilyMembers(familyData);
      const officeName = OFFICE_NAMES[pn.office] || pn.office;
      item.innerHTML = `<div class="batch-item-header"><span class="batch-item-num">${officeName} ${pn.applicationNumber}</span><span class="batch-item-status">✓ ${famCount} 个同族</span></div>`;
    } catch (e) {
      item.innerHTML = `<div class="batch-item-header"><span class="batch-item-num">${escapeHtml(num)}</span><span class="batch-item-error">${escapeHtml(e.message)}</span></div>`;
    }

    batchResultsList.appendChild(item);
  }

  batchStartBtn.disabled = false;
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
  const ocrConfig = window.AI.getOCRConfig(config);
  ocrConfig.engine = ocrEngineSelect.value;
  ocrConfig.autoExtract = ocrAutoExtract.checked;
  window.AI.saveAIConfig(config);
  aiSettingsModal.classList.add("hidden");
});

function loadAISettingsToForm() {
  const config = window.AI.loadAIConfig();
  let type = aiProviderSelect.value;
  if (!config[type]) type = Object.keys(config).find(k => k !== "ocr") || "zhipu";
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
  if (ocrAutoExtract) ocrAutoExtract.checked = ocrConfig.autoExtract !== false;
}

aiSummarizeBtn.addEventListener("click", async () => {
  if (!currentData) return;
  const config = window.AI.loadAIConfig();
  const provider = window.AI.getCurrentProvider(config);
  if (!provider) {
    showError("请先在 AI 设置中配置并选择一个 AI 服务商");
    aiSettingsBtn.click();
    return;
  }

  aiSummarizeBtn.disabled = true;
  aiStatus.textContent = "正在生成梳理...";
  aiStatus.className = "ai-status ai-status-processing";
  aiSummaryResult.classList.remove("hidden");
  aiSummaryResult.innerHTML = '<p class="placeholder">AI 正在分析审查历史，请稍候...</p>';

  try {
    let fullText = "";
    const systemPrompt = "你是一位专业的专利审查分析师。请根据以下专利数据，对审查历史进行梳理分析，包括：1. 专利基本信息 2. 同族专利概况 3. 审查文档分析 4. 关键时间节点 5. 风险评估与建议。请用中文回答。";

    for await (const chunk of window.AI.streamChat(
      provider.type, provider.apiKey, provider.baseUrl,
      {
        model: provider.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(currentData, null, 2) },
        ],
        temperature: 0.3,
        maxTokens: 16384,
      }
    )) {
      if (chunk.content) {
        fullText += chunk.content;
        aiSummaryResult.innerHTML = '<div class="ai-summary-content">' + escapeHtml(fullText).replace(/\n/g, "<br>") + "</div>";
      }
    }

    aiStatus.textContent = "梳理完成 ✓";
    aiStatus.className = "ai-status ai-status-success";
  } catch (e) {
    aiSummaryResult.innerHTML = '<p class="placeholder" style="color:var(--danger)">' + escapeHtml(e.toString()) + "</p>";
    aiStatus.textContent = "梳理失败 ✗";
    aiStatus.className = "ai-status ai-status-error";
  } finally {
    aiSummarizeBtn.disabled = false;
  }
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

kanbanAutoBtn.addEventListener("click", async () => {
  if (!currentData) { showError("请先查询专利"); return; }
  const config = window.AI.loadAIConfig();
  const provider = window.AI.getCurrentProvider(config);
  if (!provider) {
    showError("请先在 AI 设置中配置并选择一个 AI 服务商");
    aiSettingsBtn.click();
    return;
  }

  const items = kanbanState.documents;
  if (!items || items.length === 0) { showError("请先查询专利并加载审查文档"); return; }

  kanbanAutoBtn.disabled = true;
  const analysisSection = document.getElementById("kanban-analysis");
  const analysisContent = document.getElementById("kanban-analysis-content");
  analysisSection.classList.remove("hidden");
  analysisContent.innerHTML = '<p class="extracting">正在准备审查意见和答复的提取内容...</p>';

  const oaItems = items.filter(it => shouldIncludeInAIAnalysis(currentData.office, it.type));
  if (oaItems.length === 0) {
    analysisContent.innerHTML = '<p class="placeholder">未找到审查意见或答复类文档</p>';
    kanbanAutoBtn.disabled = false;
    return;
  }

  const ocrConfig = window.AI.getOCRConfig(config);
  const engine = ocrConfig.engine || "paddle_ocr_vl";
  const statusEl = document.getElementById("kanban-status");

  const missing = oaItems.filter(it => !kanbanState.extractions[it.idx]);
  for (let i = 0; i < missing.length; i++) {
    const it = missing[i];
    if (statusEl) statusEl.textContent = "补提中 (" + (i + 1) + "/" + missing.length + "): " + it.name;
    const container = document.getElementById("kanban-extracted-" + it.idx);
    if (!container) continue;
    container.classList.remove("hidden");
    container.innerHTML = '<p class="extracting">正在提取（' + escapeHtml(engine) + '）...</p>';
    const isUS = currentData.office === "US";
    const urlDocNum = isUS ? currentData.applicationNumber : encodeURIComponent(currentData.docNumber || currentData.applicationNumber);
    const encodedDocId = encodeURIComponent(it.docId);
    let extractUrl = `/api/gd/extract-text/${currentData.office}/${urlDocNum}/${encodedDocId}/${it.numberOfPages}/${it.docFormat}?engine=${encodeURIComponent(engine)}`;
    if (engine === "glm_ocr" && provider && provider.apiKey) {
      extractUrl += "&api_key=" + encodeURIComponent(provider.apiKey);
    }
    try {
      const resp = await fetch(extractUrl);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const result = await resp.json();
      if (result.error) { container.innerHTML = '<p class="extract-error">' + escapeHtml(result.error) + '</p>'; continue; }
      const text = result.text || "";
      const markdown = result.markdown || "";
      if (!text && !markdown) { container.innerHTML = '<p class="extract-empty">未能提取到文本</p>'; continue; }
      kanbanState.extractions[it.idx] = { text, markdown, engine: result.engine };
      const displayText = markdown || text;
      container.innerHTML = `
        <div class="extracted-header">
          <span class="extracted-engine">引擎: ${escapeHtml(result.engine)}</span>
          <span class="extracted-chars">字符数: ${displayText.length}</span>
        </div>
        <pre class="extracted-text">${escapeHtml(displayText.length > 6000 ? displayText.substring(0, 6000) + "\n\n[...已截断...]" : displayText)}</pre>
      `;
    } catch (e) {
      container.innerHTML = '<p class="extract-error">' + escapeHtml(e.message) + '</p>';
    }
  }

  if (statusEl) statusEl.textContent = "正在用 AI 整理审查历史...";
  analysisContent.innerHTML = '<p class="extracting">AI 正在整理审查意见和答复...</p>';

  const lines = [];
  oaItems.forEach((it, idx) => {
    const ext = kanbanState.extractions[it.idx];
    if (!ext) {
      lines.push(`【${idx + 1}】${it.docCode} - ${it.name}（${it.date}）\n[未能提取内容]`);
      return;
    }
    const content = (ext.markdown || ext.text || "").substring(0, 12000);
    lines.push(`【${idx + 1}】${it.docCode} - ${it.name}（${it.date}）\n${content}`);
  });

  const systemPrompt = "你是一位专业的美国专利审查分析师。请根据以下从 Global Dossier 获取的审查意见（Office Action）和申请人答复（Response）的实际内容，整理出一份结构化的审查历史分析报告。报告需包含以下章节：\n1. 📌 案件概览（专利号、申请号、申请人、当前阶段）\n2. 📋 审查轮次（按时间倒序列出每一轮：日期、文件类型、核心要点）\n3. ⚠️ 驳回理由（每轮 OA 的核心驳回点 / 引用文献 / 法条）\n4. 💬 申请人答辩要点（针对每轮 OA 的修改、争辩、证据）\n5. 📊 审查趋势与风险评估（审查员立场、授权可能性、潜在风险）\n6. 🎯 建议的应对策略（修改权利要求、补充证据、RCE、上诉等）\n请用中文回答，使用清晰的层级结构（Markdown 格式）。";

  try {
    let fullText = "";
    for await (const chunk of window.AI.streamChat(
      provider.type, provider.apiKey, provider.baseUrl,
      {
        model: provider.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: lines.join("\n\n---\n\n") },
        ],
        temperature: 0.3,
        maxTokens: 16384,
      }
    )) {
      if (chunk.content) {
        fullText += chunk.content;
        analysisContent.innerHTML = '<div class="kanban-analysis-content">' + escapeHtml(fullText).replace(/\n/g, "<br>") + "</div>";
      }
    }
    kanbanState.analysis = fullText;
    if (statusEl) statusEl.textContent = "AI 整理完成 ✓ 共 " + oaItems.length + " 份审查/答复文档";
  } catch (e) {
    analysisContent.innerHTML = '<p class="placeholder" style="color:var(--danger)">' + escapeHtml(e.toString()) + "</p>";
    if (statusEl) statusEl.textContent = "AI 整理失败 ✗";
  } finally {
    kanbanAutoBtn.disabled = false;
  }
});

document.addEventListener("DOMContentLoaded", () => {
  loadAISettingsToForm();

  document.getElementById("documents-content").addEventListener("click", (e) => {
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
      } else if (action === "ai-analyze-doc") {
        aiAnalyzeDocument(parseInt(btn.dataset.idx), btn.dataset.doctype);
      }
    });
  }
});

async function kanbanManualExtract(url, idx, docType) {
  const container = document.getElementById("kanban-extracted-" + idx);
  if (!container) return;
  container.classList.remove("hidden");

  const config = window.AI.loadAIConfig();
  const ocrConfig = window.AI.getOCRConfig(config);
  const provider = window.AI.getCurrentProvider(config);
  const engine = ocrConfig.engine || "paddle_ocr_vl";

  let extractUrl = url + (url.includes("?") ? "&" : "?") + "engine=" + encodeURIComponent(engine);
  if (engine === "glm_ocr" && provider && provider.apiKey) {
    extractUrl += "&api_key=" + encodeURIComponent(provider.apiKey);
  }

  container.innerHTML = '<p class="extracting">正在提取内容（引擎: ' + escapeHtml(engine) + '）...</p>';

  try {
    const resp = await fetch(extractUrl);
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const result = await resp.json();
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
    kanbanState.extractions[idx] = { text, markdown, engine: result.engine };
    container.innerHTML = `
      <div class="extracted-header">
        <span class="extracted-engine">引擎: ${escapeHtml(result.engine)}</span>
        <span class="extracted-chars">字符数: ${displayText.length}</span>
        <button class="btn-small btn-ai-analyze" data-action="ai-analyze-doc" data-idx="${idx}" data-doctype="${escapeHtml(docType)}">AI 分析</button>
      </div>
      <pre class="extracted-text">${escapeHtml(displayText.length > 8000 ? displayText.substring(0, 8000) + "\n\n[...已截断...]" : displayText)}</pre>
    `;
  } catch (e) {
    container.innerHTML = '<p class="extract-error">' + escapeHtml(e.message) + '</p>';
  }
}
