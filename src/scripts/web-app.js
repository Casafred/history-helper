const GD_API_BASE = "/api/gd";

const OFFICE_NAMES = {
  US: "美国 (USPTO)",
  EP: "欧洲 (EPO)",
  JP: "日本 (JPO)",
  KR: "韩国 (KIPO)",
  WO: "WIPO (PCT)",
  WIPO: "WIPO (PCT)",
};

let currentData = null;

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
const aiSummarizeBtn = document.getElementById("ai-summarize-btn");
const aiStatus = document.getElementById("ai-status");
const aiSummaryResult = document.getElementById("ai-summary-result");
const kanbanAutoBtn = document.getElementById("kanban-auto-btn");
const readerBtn = document.getElementById("reader-btn");
const readerModal = document.getElementById("reader-modal");
const readerCloseBtn = document.getElementById("reader-close-btn");
const readerDocList = document.getElementById("reader-doc-list");
const readerContent = document.getElementById("reader-content");
const readerExportBtn = document.getElementById("reader-export-btn");
const exportWordBtn = document.getElementById("export-word-btn");

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
  return null;
}

function parsePatentNumber(input) {
  const trimmed = input.trim();
  const office = detectOffice(trimmed);
  if (!office) return null;

  let stripped = trimmed;
  let queryType = "application";

  // Extract kind code (e.g. B2, A1, B1, A9 from US12030161B2)
  const kindCodeMatch = stripped.match(/^(.*?[0-9])([A-Z]\d*)$/i);
  let kindCode = null;
  if (kindCodeMatch) {
    stripped = kindCodeMatch[1];
    kindCode = kindCodeMatch[2].toUpperCase();
  }

  let appNum = stripped;
  switch (office) {
    case "US":
      appNum = stripped.replace(/^US/i, "").replace(/[^0-9]/g, "");
      // Determine query type based on number format and kind code
      if (kindCode) {
        const kc = kindCode.toUpperCase();
        if (/^B\d*$/.test(kc)) {
          // B1, B2 etc. → granted patent number
          queryType = "patent";
        } else if (/^A\d*$/.test(kc)) {
          // A1, A2, A9 etc. → pre-grant publication number
          queryType = "publication";
        } else if (/^S\d*$/.test(kc)) {
          // Design patent
          queryType = "patent";
        } else if (/^P\d*$/.test(kc)) {
          // Plant patent
          queryType = "patent";
        }
      } else if (appNum.length === 11 && /^20\d{9}$/.test(appNum)) {
        // 11-digit number starting with 20 → pre-grant publication (e.g. 20220301610)
        queryType = "publication";
      } else if (appNum.length >= 7 && appNum.length <= 8 && !/^\d{2}\d{6}$/.test(appNum)) {
        // 7-8 digit number that doesn't look like series+serial application number
        // Could be a patent number, but default to application for safety
        queryType = "application";
      }
      break;
    case "EP":
      appNum = stripped.replace(/^EP/i, "").replace(/[\s.]/g, "");
      // EP numbers: 7-8 digit publication numbers, 8-digit application numbers (2-digit year + 6-digit serial)
      if (kindCode) {
        // Any kind code (A1, B1, etc.) means it's a publication number
        queryType = "publication";
      } else if (appNum.length <= 8) {
        // Without kind code, short numbers are likely publication numbers
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
  const result = { office, applicationNumber: docNum, queryType, kindCode: pn.kindCode };
  const warnings = [];

  try {
    const familyData = await gdFetch(`/patent-family/svc/family/${queryType}/${office}/${docNum}`);
    result.family = familyData;
    // Extract the corresponding application number from family response
    if (familyData && familyData.corrAppNum) {
      result.corrAppNum = familyData.corrAppNum;
    }
  } catch (e) {
    warnings.push("同族查询失败: " + e.message);
  }

  loadingText.textContent = "正在查询审查文档...";
  await new Promise(r => setTimeout(r, 1500));

  // Use corrAppNum for doc-list query if available (needed for patent/publication type queries)
  const docListNum = result.corrAppNum || docNum;
  try {
    const docData = await gdFetch(`/doc-list/svc/doclist/${office}/${docListNum}/A`);
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
  try { renderTimeline(result); } catch (e) { console.error("renderTimeline:", e); }

  if (warnings.length > 0) {
    warnings.forEach(w => showError("警告: " + w));
  }

  aiSummarizeBtn.disabled = false;
  kanbanAutoBtn.disabled = false;
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
  kanbanState.traceIndex = {};

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
        const urlDocNum = isUS ? (data.corrAppNum || data.applicationNumber) : encodeURIComponent(data.corrAppNum || data.docNumber || data.applicationNumber);
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
    // Find the US family member with a title
    const usMember = data.family.list.find(m => m.countryCode === "US" || m.countryCode === data.office);
    title = (usMember && usMember.docList && usMember.docList.title) ? usMember.docList.title : "";
    if (!title) {
      for (const m of data.family.list) {
        if (m.docList && m.docList.title) { title = m.docList.title; break; }
      }
    }
  }

  const queryTypeLabels = {
    application: "申请号",
    publication: "公开号",
    patent: "专利号",
  };
  const queryTypeLabel = queryTypeLabels[data.queryType] || "申请号";

  // Determine current status from documents
  let currentStatus = "未知";
  let statusClass = "";
  if (data.documents) {
    const docs = extractDocuments(data.documents);
    if (docs.length > 0) {
      const latestDoc = docs[docs.length - 1];
      const docCode = latestDoc.docCode || latestDoc.documentType || latestDoc.kindCode || latestDoc.type || "";
      const desc = latestDoc.docDesc || latestDoc.documentDescription || latestDoc.description || "";
      const statusInfo = getStatusInfo(data.office, docCode, desc);
      if (statusInfo.stage === "授权") {
        currentStatus = "已授权";
        statusClass = "status-allowed";
      } else if (statusInfo.stage === "复审") {
        currentStatus = "复审中";
        statusClass = "status-appeal";
      } else if (statusInfo.type === "office_action") {
        currentStatus = "审查中（待答复）";
        statusClass = "status-pending";
      } else if (statusInfo.type === "response") {
        currentStatus = "审查中（已答复）";
        statusClass = "status-response";
      } else if (statusInfo.type === "allowance") {
        currentStatus = "已授权";
        statusClass = "status-allowed";
      } else {
        currentStatus = statusInfo.stage || "审查中";
        statusClass = "status-pending";
      }
    }
  }

  // Get publication numbers from family data
  let pubNumbers = [];
  let appDateStr = "";
  let applicantNames = [];
  let priorityClaims = [];
  if (data.family && data.family.list) {
    data.family.list.forEach(m => {
      if (m.countryCode === data.office) {
        if (m.pubList) {
          m.pubList.forEach(p => {
            pubNumbers.push((p.pubCountry || "") + p.pubNum + (p.kindCode ? p.kindCode : ""));
          });
        }
        if (m.appDateStr) appDateStr = m.appDateStr;
        if (m.applicantNames && m.applicantNames.length > 0) applicantNames = m.applicantNames;
        if (m.priorityClaimList && m.priorityClaimList.length > 0) priorityClaims = m.priorityClaimList;
      }
    });
    // Fallback: get from any member if US member doesn't have the data
    if (!appDateStr || applicantNames.length === 0) {
      const firstMember = data.family.list.find(m => m.appDateStr || (m.applicantNames && m.applicantNames.length > 0));
      if (firstMember) {
        if (!appDateStr && firstMember.appDateStr) appDateStr = firstMember.appDateStr;
        if (applicantNames.length === 0 && firstMember.applicantNames) applicantNames = firstMember.applicantNames;
      }
    }
  }
  // Also check doc-list response for applicant names
  if (applicantNames.length === 0 && data.documents && data.documents.applicantNames) {
    applicantNames = data.documents.applicantNames;
  }

  const oaCount = (data.documents && data.documents.oaIndCount) ? data.documents.oaIndCount : 0;

  appInfo.innerHTML = `
    <div class="info-row"><span class="info-label">申请局</span><span class="info-value">${office}</span></div>
    <div class="info-row"><span class="info-label">${queryTypeLabel}</span><span class="info-value">${data.applicationNumber || "-"}</span></div>
    ${data.corrAppNum && data.corrAppNum !== data.applicationNumber ? '<div class="info-row"><span class="info-label">申请号</span><span class="info-value">' + escapeHtml(data.corrAppNum) + '</span></div>' : ''}
    ${appDateStr ? '<div class="info-row"><span class="info-label">申请日</span><span class="info-value">' + escapeHtml(appDateStr) + '</span></div>' : ''}
    ${pubNumbers.length > 0 ? '<div class="info-row"><span class="info-label">公开/专利号</span><span class="info-value">' + pubNumbers.map(p => escapeHtml(p)).join('、') + '</span></div>' : ''}
    ${title ? '<div class="info-row"><span class="info-label">标题</span><span class="info-value">' + escapeHtml(title) + '</span></div>' : ''}
    ${applicantNames.length > 0 ? '<div class="info-row"><span class="info-label">发明人</span><span class="info-value">' + applicantNames.map(n => escapeHtml(n)).join('、') + '</span></div>' : ''}
    ${priorityClaims.length > 0 ? '<div class="info-row"><span class="info-label">优先权</span><span class="info-value">' + priorityClaims.map(function(p) { return escapeHtml((p.country || "") + (p.docNumber || "") + (p.kindCode ? " " + p.kindCode : "")); }).join('；') + '</span></div>' : ''}
  `;

  const family = data.family;
  if (family) {
    const famCount = countFamilyMembers(family);
    const docCount = countDocuments(data.documents);
    appStatus.innerHTML = `
      <div class="info-row"><span class="info-label">当前状态</span><span class="info-value ${statusClass}">${currentStatus}</span></div>
      <div class="info-row"><span class="info-label">审查文档</span><span class="info-value">${docCount} 份${oaCount > 0 ? '（审查意见 ' + oaCount + ' 份）' : ''}</span></div>
      <div class="info-row"><span class="info-label">同族成员</span><span class="info-value">${famCount} 个</span></div>
    `;
  } else if (data.documents) {
    const docCount = countDocuments(data.documents);
    appStatus.innerHTML = `
      <div class="info-row"><span class="info-label">当前状态</span><span class="info-value ${statusClass}">${currentStatus}</span></div>
      <div class="info-row"><span class="info-label">审查文档</span><span class="info-value">${docCount} 份${oaCount > 0 ? '（审查意见 ' + oaCount + ' 份）' : ''}</span></div>
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
  const urlDocNum = isUS ? (data.corrAppNum || data.applicationNumber) : encodeURIComponent(data.corrAppNum || docNumber);

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
    const downloadUrl = docId ? `/api/gd/doc-content/svc/doccontent/${data.office}/${urlDocNum}/${encodedDocId}/${numberOfPages}/${docFormat}` : null;
    const extractUrl = docId ? `/api/gd/extract-text/${data.office}/${urlDocNum}/${encodedDocId}/${numberOfPages}/${docFormat}` : null;

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
      const urlDocNum = isUS ? (currentData.corrAppNum || currentData.applicationNumber) : encodeURIComponent(currentData.corrAppNum || currentData.docNumber || currentData.applicationNumber);
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

  aiSummarizeBtn.disabled = true;
  aiStatus.textContent = "正在分析文档: " + docType + "...";
  aiStatus.className = "ai-status ai-status-processing";
  aiSummaryResult.classList.remove("hidden");

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
        aiSummaryResult.innerHTML = '<div class="ai-summary-content markdown-body">' + renderMarkdown(fullText) + "</div>";
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
    const wideTabs = ["kanban", "timeline"];
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
  const ocrConfig = window.AI.getOCRConfig(config);
  ocrConfig.engine = ocrEngineSelect.value;
  ocrConfig.glmKey = ocrGlmKeyInput.value.trim();

  // Save custom prompts
  const promptKeys = [
    { id: "prompt-kanban-analysis", key: "kanbanAnalysis" },
    { id: "prompt-kanban-simple", key: "kanbanAnalysisSimple" },
    { id: "prompt-doc-analysis", key: "docAnalysis" },
    { id: "prompt-history-summary", key: "historySummary" },
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

function loadAISettingsToForm() {
  const config = window.AI.loadAIConfig();
  let type = aiProviderSelect.value;
  if (!config[type]) type = Object.keys(config).find(k => k !== "ocr" && k !== "prompts") || "zhipu";
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
  toggleOcrGlmKeyVisibility();

  // Load custom prompts
  const promptKeys = [
    { id: "prompt-kanban-analysis", key: "kanbanAnalysis" },
    { id: "prompt-kanban-simple", key: "kanbanAnalysisSimple" },
    { id: "prompt-doc-analysis", key: "docAnalysis" },
    { id: "prompt-history-summary", key: "historySummary" },
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
    };
    const key = keyMap[promptId];
    if (!key) return;
    const textarea = document.getElementById("prompt-" + promptId);
    if (textarea) {
      textarea.value = window.AI.getDefaultPrompt(key);
    }
  });
});

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
    const systemPrompt = window.AI.getCustomPrompt(window.AI.loadAIConfig(), "historySummary");

    for await (const chunk of window.AI.streamChat(
      provider.type, provider.apiKey, provider.baseUrl,
      {
        model: provider.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(currentData, null, 2) },
        ],
        temperature: 0.3,
        maxTokens: 32768,
      }
    )) {
      if (chunk.content) {
        fullText += chunk.content;
        aiSummaryResult.innerHTML = '<div class="ai-summary-content markdown-body">' + renderMarkdown(fullText) + "</div>";
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

async function doExtractText(office, docNum, docId, pages, docFormat, engine, apiKey) {
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
  const primaryEngine = ocrConfig.engine || "paddle_ocr_vl";
  const glmApiKey = window.AI.getGlmOcrApiKey(config);
  const statusEl = document.getElementById("kanban-status");
  const isUS = currentData.office === "US";
  const urlDocNum = isUS ? (currentData.corrAppNum || currentData.applicationNumber) : encodeURIComponent(currentData.corrAppNum || currentData.docNumber || currentData.applicationNumber);

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
            if (statusEl) statusEl.textContent = it.name + " 提取失败，无 GLM Key 无法切换 GLM OCR";
            extractReport.failed.push({ name: it.name, docCode: it.docCode, reason: result.error + "（无 GLM Key，无法降级）" });
            if (container) container.innerHTML = '<p class="extract-error">' + escapeHtml(result.error) + '</p>';
            return false;
          }
          if (statusEl) statusEl.textContent = it.name + " 提取失败，切换引擎重试...";
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
            if (statusEl) statusEl.textContent = it.name + " 内容为空，无 GLM Key 无法切换 GLM OCR";
            extractReport.empty.push({ name: it.name, docCode: it.docCode });
            if (container) container.innerHTML = '<p class="extract-empty">未能提取到文本（无 GLM Key，无法降级）</p>';
            return false;
          }
          if (statusEl) statusEl.textContent = it.name + " 内容为空，切换引擎重试...";
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
        if (statusEl) statusEl.textContent = it.name + " 提取异常，重试中...";
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
  }

  const successCount = extractReport.success.length;
  const emptyCount = extractReport.empty.length;
  const failedCount = extractReport.failed.length;
  const totalCount = oaItems.length;

  if (statusEl) {
    let statusText = "提取完成: " + successCount + "/" + totalCount + " 成功";
    if (emptyCount > 0) statusText += ", " + emptyCount + " 为空";
    if (failedCount > 0) statusText += ", " + failedCount + " 失败";
    statusEl.textContent = statusText;
  }

  if (successCount === 0) {
    analysisContent.innerHTML = '<p class="placeholder" style="color:var(--danger)">所有文档提取均失败，无法进行 AI 分析。请检查网络连接或尝试切换 OCR 引擎。</p>';
    kanbanAutoBtn.disabled = false;
    return;
  }

  if (statusEl) statusEl.textContent = "正在用 AI 整理审查历史...";
  analysisContent.innerHTML = '<p class="extracting">AI 正在整理审查意见和答复...</p>';

  const hasBlocks = oaItems.some(it => {
    const ext = kanbanState.extractions[it.idx];
    return ext && ext.blocks && ext.blocks.length > 0;
  });

  const annotatedLines = [];
  oaItems.forEach((it, idx) => {
    const ext = kanbanState.extractions[it.idx];
    if (!ext) {
      annotatedLines.push(`【${idx + 1}】${it.docCode} - ${it.name}（${it.date}）\n[未能提取内容]`);
      return;
    }
    const header = `【${idx + 1}】${it.docCode} - ${it.name}（${it.date}）`;
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

  try {
    let fullText = "";
    for await (const chunk of window.AI.streamChat(
      provider.type, provider.apiKey, provider.baseUrl,
      {
        model: provider.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: annotatedLines.join("\n\n---\n\n") },
        ],
        temperature: 0.3,
        maxTokens: 32768,
      }
    )) {
      if (chunk.content) {
        fullText += chunk.content;
        analysisContent.innerHTML = '<div class="kanban-analysis-content markdown-body">' + renderMarkdownWithTrace(fullText) + "</div>";
      }
    }
    kanbanState.analysis = fullText;
    if (statusEl) statusEl.textContent = "AI 整理完成 ✓ 共 " + oaItems.length + " 份审查/答复文档" + (hasBlocks ? "（含溯源标记）" : "");

    let reportHtml = "";
    if (emptyCount > 0 || failedCount > 0) {
      reportHtml = '<div class="extract-report"><h4>提取完整性报告</h4>';
      if (extractReport.success.length > 0) {
        reportHtml += '<div class="report-success">✓ 成功: ' + extractReport.success.map(s => escapeHtml(s.name) + ' (' + s.chars + '字/' + s.engine + ')').join('、') + '</div>';
      }
      if (emptyCount > 0) {
        reportHtml += '<div class="report-warning">内容为空: ' + extractReport.empty.map(s => escapeHtml(s.name)).join('、') + '</div>';
      }
      if (failedCount > 0) {
        reportHtml += '<div class="report-error">✗ 提取失败: ' + extractReport.failed.map(s => escapeHtml(s.name) + ' (' + escapeHtml(s.reason) + ')').join('、') + '</div>';
      }
      reportHtml += '</div>';
      analysisContent.innerHTML = reportHtml + '<div class="kanban-analysis-content markdown-body">' + renderMarkdownWithTrace(fullText) + "</div>";
    }
  } catch (e) {
    analysisContent.innerHTML = '<p class="placeholder" style="color:var(--danger)">' + escapeHtml(e.toString()) + "</p>";
    if (statusEl) statusEl.textContent = "AI 整理失败 ✗";
  } finally {
    kanbanAutoBtn.disabled = false;
  }
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
    const refLinks = validRefs.map(ref => {
      const info = kanbanState.traceIndex[ref];
      const pageLabel = info ? `第${info.page}页` : ref;
      return `<a class="trace-link" data-block-id="${escapeHtml(ref)}" title="跳转到原文 ${pageLabel}">${escapeHtml(ref)}</a>`;
    }).join(" ");
    return `<span class="trace-links"><span class="trace-label">溯源:</span> ${refLinks}</span>`;
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

function onTraceClick(blockId) {
  const info = kanbanState.traceIndex[blockId];
  if (!info) {
    showError("溯源信息不存在: " + blockId);
    return;
  }
  if (readerModal.classList.contains("hidden")) {
    openReader();
  }
  selectReaderDoc(info.docIdx);
  setTimeout(() => {
    const md = kanbanState.extractions[info.docIdx];
    if (!md) return;
    const content = md.markdown || md.text || "";
    const blocks = md.blocks || [];
    const targetBlock = blocks.find(b => b.block_id === blockId);
    if (targetBlock && targetBlock.content) {
      const snippet = targetBlock.content.substring(0, 80);
      const el = readerContent.querySelector(`[data-block-id="${blockId}"]`);
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
        <span class="trace-locator-id">${escapeHtml(blockId)}</span>
        <span class="trace-locator-page">第 ${info.page} 页</span>
        <button class="trace-locator-close" onclick="this.parentElement.parentElement.remove()">×</button>
      </div>
      <div class="trace-locator-content">${escapeHtml((info.content || "").substring(0, 300))}${info.content && info.content.length > 300 ? "..." : ""}</div>
      ${info.bbox ? '<div class="trace-locator-bbox">区域坐标: [' + info.bbox.join(", ") + "]</div>" : ""}
    `;
    readerContent.insertBefore(traceEl, readerContent.firstChild);
    traceEl.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 300);
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

  const importantTypes = ["office_action", "response", "allowance", "request"];
  const timelineItems = items.filter(it => importantTypes.indexOf(it.type) !== -1);

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

function openReader() {
  if (!readerModal) return;
  const items = kanbanState.documents;
  if (!items || items.length === 0) {
    showError("请先查询专利并加载审查文档");
    return;
  }

  readerModal.classList.remove("hidden");

  const importantTypes = ["office_action", "response", "allowance"];
  const readerItems = items.filter(it => importantTypes.indexOf(it.type) !== -1);

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
  const items = kanbanState.documents;
  const it = items.find(d => d.idx === idx);
  if (!it) return;

  document.querySelectorAll(".reader-doc-item").forEach(el => el.classList.remove("active"));
  const activeEl = document.querySelector(`.reader-doc-item[data-idx="${idx}"]`);
  if (activeEl) activeEl.classList.add("active");

  const ext = kanbanState.extractions[idx];
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

async function exportToWord() {
  if (typeof docx === "undefined" || typeof saveAs === "undefined") {
    showError("Word 导出库未加载，请刷新页面重试");
    return;
  }

  const items = kanbanState.documents;
  const importantTypes = ["office_action", "response", "allowance"];
  const exportItems = items ? items.filter(it => importantTypes.indexOf(it.type) !== -1) : [];

  const children = [];

  children.push(
    new docx.Paragraph({
      children: [new docx.TextRun({ text: "专利审查历史分析报告", bold: true, size: 36, font: "Microsoft YaHei" })],
      spacing: { after: 200 },
    })
  );

  if (currentData) {
    const info = `专利号: ${currentData.docNumber || ""} | 申请号: ${currentData.applicationNumber || ""} | 申请人: ${currentData.applicantName || ""}`;
    children.push(
      new docx.Paragraph({
        children: [new docx.TextRun({ text: info, size: 20, color: "666666", font: "Microsoft YaHei" })],
        spacing: { after: 400 },
      })
    );
  }

  if (kanbanState.analysis) {
    children.push(
      new docx.Paragraph({
        children: [new docx.TextRun({ text: "审查历史综合分析", bold: true, size: 28, font: "Microsoft YaHei" })],
        spacing: { before: 200, after: 100 },
      })
    );

    const lines = kanbanState.analysis.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        children.push(new docx.Paragraph({ children: [] }));
        continue;
      }
      if (trimmed.startsWith("# ")) {
        children.push(new docx.Paragraph({
          children: [new docx.TextRun({ text: trimmed.slice(2), bold: true, size: 28, font: "Microsoft YaHei" })],
          spacing: { before: 200, after: 100 },
        }));
      } else if (trimmed.startsWith("## ")) {
        children.push(new docx.Paragraph({
          children: [new docx.TextRun({ text: trimmed.slice(3), bold: true, size: 24, font: "Microsoft YaHei" })],
          spacing: { before: 160, after: 80 },
        }));
      } else if (trimmed.startsWith("### ")) {
        children.push(new docx.Paragraph({
          children: [new docx.TextRun({ text: trimmed.slice(4), bold: true, size: 22, font: "Microsoft YaHei" })],
          spacing: { before: 120, after: 60 },
        }));
      } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
        children.push(new docx.Paragraph({
          children: [new docx.TextRun({ text: trimmed.slice(2), size: 20, font: "Microsoft YaHei" })],
          bullet: { level: 0 },
        }));
      } else {
        const boldParts = trimmed.split(/\*\*(.*?)\*\*/g);
        const runs = boldParts.map((part, i) => {
          if (i % 2 === 1) {
            return new docx.TextRun({ text: part, bold: true, size: 20, font: "Microsoft YaHei" });
          }
          return new docx.TextRun({ text: part, size: 20, font: "Microsoft YaHei" });
        });
        children.push(new docx.Paragraph({ children: runs, spacing: { after: 60 } }));
      }
    }
  }

  children.push(
    new docx.Paragraph({
      children: [new docx.TextRun({ text: "审查文档详情", bold: true, size: 28, font: "Microsoft YaHei" })],
      spacing: { before: 400, after: 100 },
    })
  );

  for (const it of exportItems) {
    children.push(
      new docx.Paragraph({
        children: [new docx.TextRun({ text: `${it.docCode} - ${it.name}（${it.date}）`, bold: true, size: 22, font: "Microsoft YaHei" })],
        spacing: { before: 200, after: 60 },
      })
    );

    const ext = kanbanState.extractions[it.idx];
    if (ext) {
      const content = ext.markdown || ext.text || "";
      const contentLines = content.split("\n").slice(0, 100);
      for (const line of contentLines) {
        children.push(new docx.Paragraph({
          children: [new docx.TextRun({ text: line, size: 18, font: "Microsoft YaHei" })],
          spacing: { after: 30 },
        }));
      }
    } else {
      children.push(new docx.Paragraph({
        children: [new docx.TextRun({ text: "（未提取内容）", italics: true, size: 18, color: "999999", font: "Microsoft YaHei" })],
      }));
    }
  }

  const doc = new docx.Document({
    sections: [{ children }],
  });

  const blob = await docx.Packer.toBlob(doc);
  const fileName = `专利审查报告_${currentData ? (currentData.docNumber || currentData.applicationNumber || "unknown") : "export"}.docx`;
  saveAs(blob, fileName);
}

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

  if (readerBtn) {
    readerBtn.addEventListener("click", openReader);
  }

  if (readerCloseBtn) {
    readerCloseBtn.addEventListener("click", () => {
      readerModal.classList.add("hidden");
    });
  }

  if (readerModal) {
    readerModal.querySelector(".modal-overlay").addEventListener("click", () => {
      readerModal.classList.add("hidden");
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

  document.addEventListener("click", (e) => {
    const traceLink = e.target.closest(".trace-link");
    if (traceLink) {
      const blockId = traceLink.dataset.blockId;
      if (blockId) onTraceClick(blockId);
    }
  });
});

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
      const urlDocNum = isUS ? (currentData.corrAppNum || currentData.applicationNumber) : encodeURIComponent(currentData.corrAppNum || currentData.docNumber || currentData.applicationNumber);
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
