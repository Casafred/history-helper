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

function showError(msg) {
  errorToast.textContent = msg;
  errorToast.classList.remove("hidden");
  setTimeout(() => {
    errorToast.classList.add("hidden");
  }, 5000);
}

function showWarning(msg) {
  showError("⚠️ " + msg);
}

function hideError() {
  errorToast.classList.add("hidden");
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
  loadingText.textContent = "正在查询专利信息...";
  loading.classList.remove("hidden");
  resultSection.classList.add("hidden");
  convertSection.classList.add("hidden");
  batchSection.classList.add("hidden");
  hideError();

  try {
    const result = await invoke("fetch_patent", { input });
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
      renderFamily(currentData);
    } catch (e) {
      console.error("renderFamily error:", e);
      document.getElementById("family-content").innerHTML =
        '<p class="placeholder" style="color:var(--danger)">同族渲染失败</p>';
    }

    try {
      renderDocuments(currentData);
    } catch (e) {
      console.error("renderDocuments error:", e);
      document.getElementById("documents-content").innerHTML =
        '<p class="placeholder" style="color:var(--danger)">文档渲染失败</p>';
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

function renderOverview(data) {
  const appInfo = document.getElementById("app-info");
  const appStatus = document.getElementById("app-status");

  const office = OFFICE_NAMES[data.office] || data.office;
  const appNum = data.applicationNumber || "-";

  appInfo.innerHTML = `
    <div class="info-row">
      <span class="info-label">申请局</span>
      <span class="info-value">${office}</span>
    </div>
    <div class="info-row">
      <span class="info-label">申请号</span>
      <span class="info-value">${appNum}</span>
    </div>
  `;

  appStatus.innerHTML = `
    <p class="placeholder">Global Dossier 不提供申请状态详情</p>
  `;
}

function renderFamily(data) {
  const container = document.getElementById("family-content");
  const family = data.family;

  if (!family) {
    container.innerHTML = '<p class="placeholder">未查询到同族信息</p>';
    return;
  }

  container.innerHTML = '<pre class="json-preview">' + JSON.stringify(family, null, 2) + '</pre>';
}

function renderDocuments(data) {
  const container = document.getElementById("documents-content");
  const docs = data.documents;

  if (!docs) {
    container.innerHTML = '<p class="placeholder">未查询到文档信息</p>';
    return;
  }

  container.innerHTML = '<pre class="json-preview">' + JSON.stringify(docs, null, 2) + '</pre>';
}

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

function renderConvertResult(data) {
  const container = document.getElementById("convert-result");
  container.innerHTML = '<pre class="json-preview">' + JSON.stringify(data, null, 2) + '</pre>';
}

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

  try {
    const results = await invoke("batch_fetch_patents", { inputs: numbers });
    for (const result of results) {
      completed++;
      progressFill.style.width = `${(completed / numbers.length) * 100}%`;
      progressText.textContent = `${completed}/${numbers.length}`;

      const item = document.createElement("div");
      item.className = "batch-item";

      if (result.success) {
        const data = result.data;
        const office = data?.office || "Unknown";
        const appNum = data?.applicationNumber || numbers[completed - 1];

        item.innerHTML =
          '<div class="batch-item-header">' +
          '<span class="batch-item-num">' + (OFFICE_NAMES[office] || office) + " " + appNum + "</span>" +
          '<span class="batch-item-status">✓ 成功</span>' +
          "</div>";
      } else {
        item.innerHTML =
          '<div class="batch-item-header">' +
          '<span class="batch-item-num">' + numbers[completed - 1] + "</span>" +
          '<span class="batch-item-error">' + (result.error || "查询失败") + "</span>" +
          "</div>";
      }

      batchResultsList.appendChild(item);
    }
  } catch (e) {
    showError("批量查询失败: " + e.toString());
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
    config[type].model = aiModelSelect.value;
    window.AI.saveAIConfig(config);
  }
  aiSettingsModal.classList.add("hidden");
});

aiSummarizeBtn.addEventListener("click", async () => {
  if (!currentData) return;

  const config = window.AI.loadAIConfig();
  const currentProvider = window.AI.getCurrentProvider(config);
  if (!currentProvider) {
    showError("请先在 AI 设置中配置并选择一个 AI 服务商");
    aiSettingsBtn.click();
    return;
  }

  aiSummarizeBtn.disabled = true;
  aiStatus.textContent = "正在生成梳理...";
  aiStatus.className = "ai-status ai-status-processing";
  aiSummaryResult.classList.remove("hidden");
  aiSummaryResult.innerHTML = '<p class="placeholder">AI 正在分析审查历史，请稍候...</p>';
  aiAbortController = new AbortController();

  try {
    const result = await window.AI.summarize(
      currentProvider.type,
      currentProvider.apiKey,
      currentProvider.baseUrl,
      currentProvider.model,
      JSON.stringify(currentData, null, 2),
      aiAbortController.signal
    );

    if (result.success) {
      aiSummaryResult.innerHTML = '<div class="ai-summary-content">' + result.summary.replace(/\n/g, "<br>") + "</div>";
      aiStatus.textContent = "梳理完成 ✓";
      aiStatus.className = "ai-status ai-status-success";
    } else {
      aiSummaryResult.innerHTML = '<p class="placeholder" style="color:var(--danger)">' + result.error + "</p>";
      aiStatus.textContent = "梳理失败 ✗";
      aiStatus.className = "ai-status ai-status-error";
    }
  } catch (e) {
    if (e.name === "AbortError") {
      aiStatus.textContent = "已取消";
      aiStatus.className = "ai-status";
      aiSummaryResult.innerHTML = '<p class="placeholder">已取消梳理</p>';
    } else {
      aiSummaryResult.innerHTML = '<p class="placeholder" style="color:var(--danger)">' + e.toString() + "</p>";
      aiStatus.textContent = "梳理失败 ✗";
      aiStatus.className = "ai-status ai-status-error";
    }
  } finally {
    aiSummarizeBtn.disabled = false;
  }
});

function loadAISettingsToForm() {
  const config = window.AI.loadAIConfig();
  const currentProvider = window.AI.getCurrentProvider(config);
  if (currentProvider) {
    aiProviderSelect.value = currentProvider.type;
    aiBaseUrlInput.value = currentProvider.baseUrl;
    aiApiKeyInput.value = currentProvider.apiKey;
    updateModelOptions(currentProvider.type);
    aiModelSelect.value = currentProvider.model;
  } else {
    const type = aiProviderSelect.value;
    aiBaseUrlInput.value = window.AI.getDefaultBaseUrl(type);
    updateModelOptions(type);
  }
}

function updateModelOptions(type) {
  const models = window.AI.getAvailableModels(type);
  aiModelSelect.innerHTML = "";
  models.forEach((model) => {
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
  updateGdStatus();
  loadAISettingsToForm();
});
