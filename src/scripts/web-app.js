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
const aiTestBtn = document.getElementById("ai-test-btn");
const aiSaveBtn = document.getElementById("ai-save-btn");
const aiTestResult = document.getElementById("ai-test-result");
const aiSummarizeBtn = document.getElementById("ai-summarize-btn");
const aiStatus = document.getElementById("ai-status");
const aiSummaryResult = document.getElementById("ai-summary-result");

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

  if (warnings.length > 0) {
    warnings.forEach(w => showError("⚠️ " + w));
  }

  aiSummarizeBtn.disabled = false;
  resultSection.classList.remove("hidden");
  searchBtn.disabled = false;
  loading.classList.add("hidden");
});

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
  container.innerHTML = '<p class="extracting">正在提取文档内容...</p>';
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error("提取失败: HTTP " + resp.status);
    const data = await resp.json();
    const text = data.text || data.content || "";
    if (!text || text.trim().length === 0) {
      container.innerHTML = '<p class="extract-empty">该文档为图片型PDF，无法提取文本内容。建议下载后使用OCR工具处理。</p>';
    } else {
      container.innerHTML = '<pre class="extracted-text">' + escapeHtml(text) + '</pre>';
    }
  } catch (e) {
    container.innerHTML = '<p class="extract-error">提取失败: ' + escapeHtml(e.message) + '</p>';
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
    window.AI.saveAIConfig(config);
  }
  aiSettingsModal.classList.add("hidden");
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

function loadAISettingsToForm() {
  const config = window.AI.loadAIConfig();
  const provider = window.AI.getCurrentProvider(config);
  if (provider) {
    aiProviderSelect.value = provider.type;
    aiBaseUrlInput.value = provider.baseUrl;
    aiApiKeyInput.value = provider.apiKey;
    updateModelOptions(provider.type);
    aiModelSelect.value = provider.model;
  } else {
    const type = aiProviderSelect.value;
    aiBaseUrlInput.value = window.AI.getDefaultBaseUrl(type);
    updateModelOptions(type);
  }
}

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
    }
  });
});
