const invoke = window.__TAURI__.core.invoke;

const patentInput = document.getElementById("patent-input");
const searchBtn = document.getElementById("search-btn");
const convertBtn = document.getElementById("convert-btn");
const officeBadge = document.getElementById("office-badge");
const gdStatus = document.getElementById("gd-status");
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

const gdLoginBtn = document.getElementById("gd-login-btn");
const gdLoginModal = document.getElementById("gd-login-modal");
const gdModalCloseBtn = document.getElementById("gd-modal-close-btn");
const gdTokenInput = document.getElementById("gd-token-input");
const gdSaveBtn = document.getElementById("gd-save-btn");

const batchBtn = document.getElementById("batch-btn");
const batchInput = document.getElementById("batch-input");
const batchStartBtn = document.getElementById("batch-start-btn");
const batchCancelBtn = document.getElementById("batch-cancel-btn");
const batchProgress = document.getElementById("batch-progress");
const progressFill = document.getElementById("progress-fill");
const progressText = document.getElementById("progress-text");
const batchResults = document.getElementById("batch-results");
const batchResultsList = document.getElementById("batch-results-list");

const CONTINUITY_TYPE_MAP = {
  CON: "续案 (Continuation)",
  DIV: "分案 (Divisional)",
  CPA: "部分续案 (Continuation-in-Part)",
  CONT: "续案 (Continuation)",
};

const DIRECTION_MAP = {
  INCOMING: "来件",
  OUTGOING: "去件",
  INTERNAL: "内部",
};

const EVENT_CATEGORY_STYLE = {
  office_action: { label: "审查意见", cls: "cat-oa" },
  applicant_response: { label: "申请人回复", cls: "cat-ar" },
  fee_payment: { label: "缴费", cls: "cat-fee" },
  status_change: { label: "状态变更", cls: "cat-sc" },
  publication: { label: "公开", cls: "cat-pub" },
  other: { label: "其他", cls: "cat-other" },
};

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
let currentOffice = null;
let aiAbortController = null;
let batchAbortController = null;

function loadGdToken() {
  return localStorage.getItem("gd_token") || "";
}

function saveGdToken(token) {
  localStorage.setItem("gd_token", token);
}

function updateGdStatus() {
  const token = loadGdToken();
  if (token) {
    gdStatus.textContent = "GD 已登录 ✓";
    gdStatus.className = "gd-status gd-logged-in";
  } else {
    gdStatus.textContent = "GD 未登录";
    gdStatus.className = "gd-status gd-logged-out";
  }
  gdStatus.classList.remove("hidden");
}

patentInput.addEventListener("input", async () => {
  const val = patentInput.value.trim();
  if (!val) {
    officeBadge.classList.add("hidden");
    return;
  }
  try {
    const result = await invoke("detect_patent_office", { input: val });
    if (result.success) {
      const office = result.data;
      const name = OFFICE_NAMES[office] || office;
      officeBadge.textContent = name + " 专利";
      officeBadge.classList.remove("hidden");
    } else {
      officeBadge.classList.add("hidden");
    }
  } catch {
    officeBadge.classList.add("hidden");
  }
});

patentInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") searchBtn.click();
});

searchBtn.addEventListener("click", async () => {
  const input = patentInput.value.trim();
  if (!input) return;

  searchBtn.disabled = true;
  loadingText.textContent = "正在查询审查历史...";
  loading.classList.remove("hidden");
  resultSection.classList.add("hidden");
  convertSection.classList.add("hidden");
  batchSection.classList.add("hidden");
  hideError();

  try {
    const result = await invoke("fetch_examination_history", { appNumber: input });
    if (!result.success) {
      showError(result.error || "查询失败");
      return;
    }

    currentData = result.data;
    currentOffice = currentData?.office || "US";

    if (currentData?.cached) {
      showWarning("数据来自本地缓存（1小时有效期）");
    }

    if (currentData.warnings && currentData.warnings.length > 0) {
      currentData.warnings.forEach((w) => showWarning(w));
    }

    try {
      renderOverview(currentData);
    } catch (e) {
      console.error("renderOverview error:", e);
      document.getElementById("app-info").innerHTML =
        '<p class="placeholder" style="color:var(--danger)">概览渲染失败</p>';
    }

    try {
      renderTimeline(currentData);
    } catch (e) {
      console.error("renderTimeline error:", e);
      document.getElementById("timeline-content").innerHTML =
        '<p class="placeholder" style="color:var(--danger)">时间线渲染失败</p>';
    }

    try {
      renderDocuments(currentData);
    } catch (e) {
      console.error("renderDocuments error:", e);
      document.getElementById("documents-content").innerHTML =
        '<p class="placeholder" style="color:var(--danger)">文档渲染失败</p>';
    }

    try {
      renderContinuity(currentData);
    } catch (e) {
      console.error("renderContinuity error:", e);
      document.getElementById("continuity-content").innerHTML =
        '<p class="placeholder" style="color:var(--danger)">续案/同族渲染失败</p>';
    }

    try {
      renderFamily(currentData);
    } catch (e) {
      console.error("renderFamily error:", e);
      document.getElementById("family-content").innerHTML =
        '<p class="placeholder" style="color:var(--danger)">GD 同族渲染失败</p>';
    }

    aiSummarizeBtn.disabled = false;
    resultSection.classList.remove("hidden");
  } catch (e) {
    showError(e.toString());
  } finally {
    searchBtn.disabled = false;
    loading.classList.add("hidden");
  }
});

convertBtn.addEventListener("click", async () => {
  const input = patentInput.value.trim();
  if (!input) return;

  try {
    const result = await invoke("convert_patent_number", { input });
    if (result.success) {
      renderConvertResult(result.data);
      convertSection.classList.remove("hidden");
    } else {
      showError(result.error || "格式转换失败");
    }
  } catch (e) {
    showError(e.toString());
  }
});

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  });
});

gdLoginBtn.addEventListener("click", () => {
  gdTokenInput.value = loadGdToken();
  gdLoginModal.classList.remove("hidden");
});

gdModalCloseBtn.addEventListener("click", () => {
  gdLoginModal.classList.add("hidden");
});

document.querySelector("#gd-login-modal .modal-overlay").addEventListener("click", () => {
  gdLoginModal.classList.add("hidden");
});

gdSaveBtn.addEventListener("click", async () => {
  const token = gdTokenInput.value.trim();
  if (!token) {
    showError("请输入 Access Token");
    return;
  }

  try {
    await invoke("set_gd_token", { token });
    saveGdToken(token);
    updateGdStatus();
    gdLoginModal.classList.add("hidden");
  } catch (e) {
    showError("保存 Token 失败: " + e.toString());
  }
});

batchBtn.addEventListener("click", () => {
  batchSection.classList.toggle("hidden");
});

batchStartBtn.addEventListener("click", async () => {
  const text = batchInput.value.trim();
  if (!text) return;

  const numbers = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (numbers.length === 0) return;

  batchStartBtn.disabled = true;
  batchCancelBtn.classList.remove("hidden");
  batchProgress.classList.remove("hidden");
  batchResults.classList.remove("hidden");
  batchResultsList.innerHTML = "";
  batchAbortController = new AbortController();

  let completed = 0;
  progressFill.style.width = "0%";
  progressText.textContent = `0/${numbers.length}`;

  for (const num of numbers) {
    if (batchAbortController.signal.aborted) break;

    try {
      const result = await invoke("fetch_examination_history", { appNumber: num });
      completed++;
      progressFill.style.width = `${(completed / numbers.length) * 100}%`;
      progressText.textContent = `${completed}/${numbers.length}`;

      const item = document.createElement("div");
      item.className = "batch-item";

      if (result.success) {
        const data = result.data;
        const office = data?.office || "US";
        const appNum = data?.applicationNumber || num;
        const appData = data?.application?.patentFileWrapperDataBag?.[0]?.applicationMetaData;
        const title = appData?.inventionTitle || "-";
        const status = appData?.applicationStatusDescriptionText || "-";

        item.innerHTML =
          '<div class="batch-item-header">' +
          '<span class="batch-item-num">' + (OFFICE_NAMES[office] || office) + " " + appNum + "</span>" +
          '<span class="batch-item-status">' + status + "</span>" +
          "</div>" +
          '<div class="batch-item-title">' + title + "</div>";
      } else {
        item.innerHTML =
          '<div class="batch-item-header">' +
          '<span class="batch-item-num">' + num + "</span>" +
          '<span class="batch-item-error">' + (result.error || "查询失败") + "</span>" +
          "</div>";
      }

      batchResultsList.appendChild(item);
    } catch (e) {
      completed++;
      progressFill.style.width = `${(completed / numbers.length) * 100}%`;
      progressText.textContent = `${completed}/${numbers.length}`;

      const item = document.createElement("div");
      item.className = "batch-item";
      item.innerHTML =
        '<div class="batch-item-header">' +
        '<span class="batch-item-num">' + num + "</span>" +
        '<span class="batch-item-error">' + e.toString() + "</span>" +
        "</div>";
      batchResultsList.appendChild(item);
    }
  }

  batchStartBtn.disabled = false;
  batchCancelBtn.classList.add("hidden");
});

batchCancelBtn.addEventListener("click", () => {
  if (batchAbortController) {
    batchAbortController.abort();
  }
  batchStartBtn.disabled = false;
  batchCancelBtn.classList.add("hidden");
});

aiSettingsBtn.addEventListener("click", () => {
  loadAISettingsToForm();
  aiSettingsModal.classList.remove("hidden");
});

modalCloseBtn.addEventListener("click", () => {
  aiSettingsModal.classList.add("hidden");
});

modalOverlay.addEventListener("click", () => {
  aiSettingsModal.classList.add("hidden");
});

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

  if (!apiKey) {
    showTestResult(false, "请输入 API Key");
    return;
  }

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
    config[type].defaultModel = aiModelSelect.value;
  }
  window.AI.saveAIConfig(config);
  aiSettingsModal.classList.add("hidden");
});

aiSummarizeBtn.addEventListener("click", async () => {
  if (!currentData) return;

  const config = window.AI.loadAIConfig();
  let activeType = null;
  let activeConfig = null;
  for (const [type, cfg] of Object.entries(config)) {
    if (cfg.apiKey) {
      activeType = type;
      activeConfig = cfg;
      break;
    }
  }

  if (!activeConfig || !activeConfig.apiKey) {
    showError("请先在 AI 设置中配置 API Key");
    return;
  }

  aiSummarizeBtn.disabled = true;
  aiStatus.textContent = "AI 正在分析审查历史...";
  aiSummaryResult.innerHTML = '<div class="spinner" style="margin:20px auto"></div>';
  aiAbortController = new AbortController();

  try {
    const summaryText = buildSummaryPrompt(currentData);
    let fullText = "";

    const stream = window.AI.streamChat(
      activeType,
      activeConfig.apiKey,
      activeConfig.baseUrl,
      {
        model: activeConfig.defaultModel,
        messages: [
          {
            role: "system",
            content: "你是一位专业的专利代理师，擅长分析专利审查历史。请用中文回答，结构清晰，重点突出。",
          },
          { role: "user", content: summaryText },
        ],
        temperature: 0.3,
        maxTokens: 8192,
      },
      aiAbortController.signal
    );

    aiSummaryResult.innerHTML = "";
    for await (const chunk of stream) {
      if (chunk.done) break;
      fullText += chunk.content;
      aiSummaryResult.innerHTML = markdownToHtml(fullText);
    }

    aiStatus.textContent = "梳理完成";
  } catch (e) {
    if (e.name !== "AbortError") {
      aiStatus.textContent = "梳理失败";
      aiSummaryResult.innerHTML =
        '<p class="placeholder" style="color:var(--danger)">AI 梳理失败: ' +
        e.message +
        "</p>";
    }
  } finally {
    aiSummarizeBtn.disabled = false;
  }
});

function loadAISettingsToForm() {
  const config = window.AI.loadAIConfig();
  let activeType = "zhipu";
  for (const [type, cfg] of Object.entries(config)) {
    if (cfg.apiKey) {
      activeType = type;
      break;
    }
  }
  aiProviderSelect.value = activeType;
  const active = config[activeType];
  aiApiKeyInput.value = active.apiKey || "";
  aiBaseUrlInput.value = active.baseUrl || window.AI.getDefaultBaseUrl(activeType);
  updateModelOptions(activeType, active.defaultModel);
}

function updateModelOptions(type, selectedModel) {
  const models = window.AI.getDefaultModels(type);
  const config = window.AI.loadAIConfig();
  const saved = config[type]?.defaultModel;
  const target = selectedModel || saved || models[0];

  aiModelSelect.innerHTML = models
    .map((m) => '<option value="' + m + '">' + m + "</option>")
    .join("");

  if (models.includes(target)) {
    aiModelSelect.value = target;
  }
}

function showTestResult(success, message) {
  aiTestResult.textContent = message;
  aiTestResult.className = "test-result " + (success ? "test-success" : "test-error");
  aiTestResult.classList.remove("hidden");
}

function buildSummaryPrompt(data) {
  const appData = data?.application?.patentFileWrapperDataBag?.[0];
  const meta = appData?.applicationMetaData || {};
  const events = data?.events || [];
  const officeActions = data?.officeActions || [];

  let prompt = "请分析以下专利申请的审查历史，梳理关键信息：\n\n";
  prompt += "【申请信息】\n";
  prompt += "- 申请号: " + (appData?.applicationNumberText || data?.applicationNumber || "-") + "\n";
  prompt += "- 专利局: " + (OFFICE_NAMES[data?.office] || data?.office || "US") + "\n";
  prompt += "- 发明名称: " + (meta.inventionTitle || "-") + "\n";
  prompt += "- 申请人: " + (meta.firstApplicantName || "-") + "\n";
  prompt += "- 审查员: " + (meta.examinerNameText || "-") + "\n";
  prompt += "- 提交日期: " + (meta.filingDate || "-") + "\n";
  prompt += "- 当前状态: " + (meta.applicationStatusDescriptionText || "-") + "\n\n";

  if (officeActions.length > 0) {
    prompt += "【审查意见列表】\n";
    officeActions.forEach((oa, i) => {
      prompt +=
        (i + 1) +
        ". " +
        (oa.officeActionType || oa.documentCode || "-") +
        " (" +
        (oa.officialDate || "-") +
        ")\n";
    });
    prompt += "\n";
  }

  if (events.length > 0) {
    prompt += "【审查事件时间线（最近20条）】\n";
    const recent = events
      .sort((a, b) => (b.eventDate || "").localeCompare(a.eventDate || ""))
      .slice(0, 20);
    recent.forEach((e) => {
      prompt +=
        "- " +
        (e.eventDate || "-") +
        " [" +
        (e.eventCode || "-") +
        "] " +
        (e.eventDescriptionText || "-") +
        "\n";
    });
    prompt += "\n";
  }

  prompt +=
    "请从以下方面进行梳理：\n" +
    "1. 审查历程概述：按时间线总结审查的主要阶段\n" +
    "2. 关键审查意见：列出每次审查意见的核心驳回理由和引用的对比文件\n" +
    "3. 申请人应对策略：总结申请人对每次审查意见的回复策略\n" +
    "4. 当前状态分析：评估申请的前景和可能的后续步骤\n" +
    "5. 风险提示：指出可能存在的审查风险或需要注意的问题";

  return prompt;
}

function markdownToHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/^### (.+)$/gm, '<h4 class="ai-h">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 class="ai-h">$1</h3>')
    .replace(/^# (.+)$/gm, '<h2 class="ai-h">$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

function renderOverview(data) {
  const office = data?.office || "US";

  if (office !== "US") {
    const appNum = data?.applicationNumber || "-";
    const officeName = OFFICE_NAMES[office] || office;
    let html = infoRow("专利局", officeName);
    html += infoRow("申请号", appNum);

    if (data?.family) {
      const familyList = data.family?.list || [];
      if (familyList.length > 0) {
        const first = familyList[0];
        html += infoRow("发明名称", first.title || "-");
        html += infoRow("申请人", first.applicantNames || "-");
      }
      html += infoRow("同族成员数", familyList.length.toString());
    }

    if (data?.documents?.docs) {
      html += infoRow("审查文档数", data.documents.docs.length.toString());
    }

    document.getElementById("app-info").innerHTML = html;
    document.getElementById("app-status").innerHTML =
      '<p class="placeholder">非 US 专利状态详情请查看 GD 同族 Tab</p>';
    return;
  }

  const appData = data?.application;
  const bag = appData?.patentFileWrapperDataBag?.[0];
  if (!bag) {
    document.getElementById("app-info").innerHTML =
      '<p class="placeholder">未找到申请数据</p>';
    return;
  }

  const meta = bag.applicationMetaData || {};
  const infoHtml = [
    infoRow("申请号", bag.applicationNumberText),
    infoRow("发明名称", meta.inventionTitle),
    infoRow("申请人", meta.firstApplicantName),
    infoRow("审查员", meta.examinerNameText),
    infoRow("申请类型", meta.applicationTypeLabelName),
    infoRow("提交日期", meta.filingDate),
    infoRow(
      "分类号",
      meta.class && meta.subclass ? meta.class + "/" + meta.subclass : "-"
    ),
    infoRow("审查单元", meta.groupArtUnitNumber),
  ].join("");

  document.getElementById("app-info").innerHTML = infoHtml;

  const statusHtml = [
    infoRow("状态码", meta.applicationStatusCode),
    infoRow("状态描述", meta.applicationStatusDescriptionText),
    infoRow("授权日期", meta.grantDate),
    infoRow("专利号", meta.patentNumber),
  ].join("");

  document.getElementById("app-status").innerHTML = statusHtml;
}

function renderTimeline(data) {
  const events = data?.events || [];
  if (events.length === 0) {
    document.getElementById("timeline-content").innerHTML =
      '<p class="placeholder">无审查事件记录（非 US 专利暂无时间线数据）</p>';
    return;
  }

  const sorted = [...events].sort((a, b) => {
    const da = a.eventDate || "";
    const db = b.eventDate || "";
    return db.localeCompare(da);
  });

  const html = sorted
    .map((e) => {
      const category = e.eventCategory || "other";
      const catStyle = EVENT_CATEGORY_STYLE[category] || EVENT_CATEGORY_STYLE.other;
      return (
        '<div class="timeline-item">' +
        '<span class="timeline-date">' +
        (e.eventDate || "-") +
        "</span>" +
        '<span class="timeline-code">' +
        (e.eventCode || "-") +
        "</span>" +
        '<span class="timeline-cat ' +
        catStyle.cls +
        '">' +
        catStyle.label +
        "</span>" +
        '<span class="timeline-desc">' +
        (e.eventDescriptionText || "-") +
        "</span>" +
        "</div>"
      );
    })
    .join("");

  document.getElementById("timeline-content").innerHTML = html;
}

function renderDocuments(data) {
  const office = data?.office || "US";

  if (office !== "US" && data?.documents?.docs) {
    const docs = data.documents.docs;
    if (docs.length === 0) {
      document.getElementById("documents-content").innerHTML =
        '<p class="placeholder">无审查文档</p>';
      return;
    }

    const html = docs
      .map((d) => {
        const code = d.docCode || d.docCodeDesc || "-";
        const date = d.legalDateStr || "-";
        const desc = d.docDesc || d.docCodeDesc || "-";
        const docId = d.docId || "";
        const pages = d.numberOfPages;

        const downloadHtml = docId
          ? '<button class="doc-download gd-doc-download" data-country="' +
            office + '" data-doc-number="' +
            (data.applicationNumber || "") + '" data-doc-id="' +
            docId + '" data-pages="1">PDF' +
            (pages ? " (" + pages + "p)" : "") +
            "</button>"
          : "";

        return (
          '<div class="doc-item">' +
          '<span class="doc-type">' + code + "</span>" +
          '<div class="doc-info">' +
          '<div class="doc-desc">' + desc + "</div>" +
          '<div class="doc-date">' + date + "</div>" +
          "</div>" +
          downloadHtml +
          "</div>"
        );
      })
      .join("");

    document.getElementById("documents-content").innerHTML = html;
    bindGdDocDownload();
    return;
  }

  const docs = data?.documents || [];
  if (!Array.isArray(docs) || docs.length === 0) {
    document.getElementById("documents-content").innerHTML =
      '<p class="placeholder">无审查文档</p>';
    return;
  }

  const rejectionCodes = ["CTNF", "CTF", "CTFR"];
  const allowanceCodes = ["NTCE"];

  const sorted = [...docs].sort((a, b) => {
    const da = a.officialDate || "";
    const db = b.officialDate || "";
    return db.localeCompare(da);
  });

  const html = sorted
    .map((d) => {
      const code = d.documentCode || "";
      const isRej = rejectionCodes.includes(code);
      const isAllow = allowanceCodes.includes(code);

      let typeClass = "doc-type";
      if (isRej) typeClass += " rejection";
      else if (isAllow) typeClass += " allowance";

      const downloadUrl = d.downloadOptionBag?.[0]?.downloadUrl || "";
      const pages = d.downloadOptionBag?.[0]?.pageTotalQuantity;

      const direction = d.documentDirectionCategory
        ? DIRECTION_MAP[d.documentDirectionCategory] || d.documentDirectionCategory
        : "";

      const downloadHtml = downloadUrl
        ? '<button class="doc-download" data-url="' +
          downloadUrl +
          '">PDF' +
          (pages ? " (" + pages + "p)" : "") +
          "</button>"
        : "";

      return (
        '<div class="doc-item">' +
        '<span class="' +
        typeClass +
        '">' +
        code +
        "</span>" +
        '<div class="doc-info">' +
        '<div class="doc-desc">' +
        (d.documentCodeDescriptionText || "-") +
        "</div>" +
        '<div class="doc-date">' +
        (d.officialDate || "-") +
        (direction ? " \u00B7 " + direction : "") +
        "</div>" +
        "</div>" +
        downloadHtml +
        "</div>"
      );
    })
    .join("");

  document.getElementById("documents-content").innerHTML = html;
  bindUsptoDocDownload();
}

function bindUsptoDocDownload() {
  document.querySelectorAll(".doc-download:not(.gd-doc-download)").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const url = btn.getAttribute("data-url");
      if (!url) return;

      btn.disabled = true;
      btn.textContent = "下载中...";

      try {
        const result = await invoke("download_document", { url });
        if (!result.success) {
          showError(result.error || "下载失败");
          btn.textContent = "PDF";
          btn.disabled = false;
          return;
        }

        downloadBlob(result.data.data, "document.pdf");
        btn.textContent = "已下载";
        setTimeout(() => {
          btn.textContent = "PDF";
          btn.disabled = false;
        }, 2000);
      } catch (e) {
        showError("文档下载失败: " + e.toString());
        btn.textContent = "PDF";
        btn.disabled = false;
      }
    });
  });
}

function bindGdDocDownload() {
  document.querySelectorAll(".gd-doc-download").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const country = btn.getAttribute("data-country");
      const docNumber = btn.getAttribute("data-doc-number");
      const docId = btn.getAttribute("data-doc-id");
      const pages = btn.getAttribute("data-pages");

      btn.disabled = true;
      btn.textContent = "下载中...";

      try {
        const result = await invoke("download_gd_document", {
          country,
          docNumber,
          docId,
          pages,
          format: "PDF",
        });
        if (!result.success) {
          showError(result.error || "下载失败");
          btn.textContent = "PDF";
          btn.disabled = false;
          return;
        }

        downloadBlob(result.data.data, "document.pdf");
        btn.textContent = "已下载";
        setTimeout(() => {
          btn.textContent = "PDF";
          btn.disabled = false;
        }, 2000);
      } catch (e) {
        showError("文档下载失败: " + e.toString());
        btn.textContent = "PDF";
        btn.disabled = false;
      }
    });
  });
}

function downloadBlob(base64Data, filename) {
  const byteCharacters = atob(base64Data);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  const blob = new Blob([byteArray], { type: "application/pdf" });
  const blobUrl = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(blobUrl);
}

function renderContinuity(data) {
  if (data?.office && data.office !== "US") {
    document.getElementById("continuity-content").innerHTML =
      '<p class="placeholder">非 US 专利的续案信息请查看 GD 同族 Tab</p>';
    return;
  }

  const contBag = data?.continuity?.patentFileWrapperDataBag?.[0];
  const parents = contBag?.parentContinuityBag || [];
  const children = contBag?.childContinuityBag || [];

  const fpBag = data?.foreignPriority?.patentFileWrapperDataBag?.[0];
  const foreignPriorities = fpBag?.foreignPriorityBag || [];

  if (parents.length === 0 && children.length === 0 && foreignPriorities.length === 0) {
    document.getElementById("continuity-content").innerHTML =
      '<p class="placeholder">无续案/分案/同族关系</p>';
    return;
  }

  let html = "";

  if (parents.length > 0) {
    html +=
      '<div class="info-card"><div class="card-header">父案</div><div class="card-body">';
    html += parents
      .map(
        (p) =>
          '<div class="info-row">' +
          '<span class="info-label">' +
          (CONTINUITY_TYPE_MAP[p.continuityTypeCode] || p.continuityTypeCode || "续案") +
          "</span>" +
          '<span class="info-value">' +
          (p.parentApplicationNumberText || "-") +
          " (" +
          (p.parentApplicationStatusDescriptionText || "-") +
          ")</span>" +
          "</div>"
      )
      .join("");
    html += "</div></div>";
  }

  if (children.length > 0) {
    html +=
      '<div class="info-card" style="margin-top:12px"><div class="card-header">子案</div><div class="card-body">';
    html += children
      .map(
        (c) =>
          '<div class="info-row">' +
          '<span class="info-label">' +
          (CONTINUITY_TYPE_MAP[c.continuityTypeCode] || c.continuityTypeCode || "续案") +
          "</span>" +
          '<span class="info-value">' +
          (c.childApplicationNumberText || "-") +
          " (" +
          (c.childApplicationStatusDescriptionText || "-") +
          ")</span>" +
          "</div>"
      )
      .join("");
    html += "</div></div>";
  }

  if (foreignPriorities.length > 0) {
    html +=
      '<div class="info-card" style="margin-top:12px"><div class="card-header">外国优先权</div><div class="card-body">';
    html += foreignPriorities
      .map(
        (fp) =>
          '<div class="info-row">' +
          '<span class="info-label">' +
          (fp.foreignPriorityCountryCode || "-") +
          "</span>" +
          '<span class="info-value">' +
          (fp.foreignPriorityNumberText || "-") +
          " (" +
          (fp.foreignPriorityDate || "-") +
          ")</span>" +
          "</div>"
      )
      .join("");
    html += "</div></div>";
  }

  document.getElementById("continuity-content").innerHTML = html;
}

function renderFamily(data) {
  const office = data?.office || "US";

  if (office === "US" && data?.family) {
    renderFamilyData(data.family);
    return;
  }

  if (data?.family) {
    renderFamilyData(data.family);
    return;
  }

  const token = loadGdToken();
  if (!token) {
    document.getElementById("family-content").innerHTML =
      '<p class="placeholder">需要登录 Global Dossier 后查看同族专利信息。请点击上方「GD 登录」按钮。</p>';
    return;
  }

  document.getElementById("family-content").innerHTML =
    '<p class="placeholder">查询后自动显示同族信息</p>';
}

function renderFamilyData(family) {
  if (!family) {
    document.getElementById("family-content").innerHTML =
      '<p class="placeholder">无同族数据</p>';
    return;
  }

  const list = family.list || [];
  if (list.length === 0) {
    document.getElementById("family-content").innerHTML =
      '<p class="placeholder">未找到同族专利</p>';
    return;
  }

  let html = '<div class="family-list">';

  list.forEach((member) => {
    const country = member.countryCode || "-";
    const appNum = member.appNum || "-";
    const title = member.title || "-";
    const applicant = member.applicantNames || "-";
    const appDate = member.appDateStr || "-";
    const officeName = OFFICE_NAMES[country] || country;

    let pubs = "";
    if (member.pubList && member.pubList.length > 0) {
      pubs = member.pubList
        .map(
          (p) =>
            (p.pubCountry || "") + " " + (p.pubNum || "") + " (" + (p.pubDateStr || "-") + ")"
        )
        .join(", ");
    }

    html +=
      '<div class="family-member">' +
      '<div class="family-member-header">' +
      '<span class="family-member-office">' + officeName + "</span>" +
      '<span class="family-member-num">' + appNum + "</span>" +
      "</div>" +
      '<div class="family-member-title">' + title + "</div>" +
      '<div class="family-member-info">' +
      '<span>申请人: ' + applicant + "</span>" +
      '<span>申请日: ' + appDate + "</span>" +
      "</div>" +
      (pubs ? '<div class="family-member-pubs">公开: ' + pubs + "</div>" : "") +
      "</div>";
  });

  html += "</div>";
  document.getElementById("family-content").innerHTML = html;
}

function renderConvertResult(data) {
  if (!data) {
    document.getElementById("convert-result").innerHTML =
      '<p class="placeholder">无法识别格式</p>';
    return;
  }

  const html = [
    infoRow("原始输入", data.raw),
    infoRow("识别局", OFFICE_NAMES[data.office] || data.office),
    infoRow("申请号", data.applicationNumber),
    infoRow("公开号", data.publicationNumber || "-"),
    infoRow("专利号", data.patentNumber || "-"),
  ].join("");

  document.getElementById("convert-result").innerHTML = html;
}

function infoRow(label, value) {
  return (
    '<div class="info-row"><span class="info-label">' +
    (label || "-") +
    '</span><span class="info-value">' +
    (value || "-") +
    "</span></div>"
  );
}

function showError(msg) {
  errorToast.textContent = msg;
  errorToast.classList.remove("hidden");
  setTimeout(() => errorToast.classList.add("hidden"), 5000);
}

function showWarning(msg) {
  const warningEl = document.createElement("div");
  warningEl.className = "toast warning-toast";
  warningEl.textContent = "\u26A0 " + msg;
  document.querySelector(".app-main").appendChild(warningEl);
  setTimeout(() => {
    if (warningEl.parentNode) {
      warningEl.parentNode.removeChild(warningEl);
    }
  }, 8000);
}

function hideError() {
  errorToast.classList.add("hidden");
}

updateGdStatus();
