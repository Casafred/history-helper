const invoke = window.__TAURI__.core.invoke;

const patentInput = document.getElementById("patent-input");
const searchBtn = document.getElementById("search-btn");
const convertBtn = document.getElementById("convert-btn");
const officeBadge = document.getElementById("office-badge");
const resultSection = document.getElementById("result-section");
const convertSection = document.getElementById("convert-section");
const loading = document.getElementById("loading");
const errorToast = document.getElementById("error-toast");

let currentAppNumber = null;

patentInput.addEventListener("input", async () => {
  const val = patentInput.value.trim();
  if (!val) {
    officeBadge.classList.add("hidden");
    return;
  }
  try {
    const result = await invoke("detect_patent_office", { input: val });
    if (result.success) {
      officeBadge.textContent = result.data + " \u4E13\u5229";
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
  loading.classList.remove("hidden");
  resultSection.classList.add("hidden");
  convertSection.classList.add("hidden");
  hideError();

  try {
    const appResult = await invoke("fetch_application", { appNumber: input });
    if (!appResult.success) {
      showError(appResult.error || "\u67E5\u8BE2\u5931\u8D25");
      return;
    }

    currentAppNumber = input;
    renderOverview(appResult.data);

    const txResult = await invoke("fetch_transactions", { appNumber: input });
    if (txResult.success && txResult.data) {
      renderTimeline(txResult.data);
    }

    const docResult = await invoke("fetch_documents", { appNumber: input });
    if (docResult.success && docResult.data) {
      renderDocuments(docResult.data);
    }

    const contResult = await invoke("fetch_continuity", { appNumber: input });
    if (contResult.success && contResult.data) {
      renderContinuity(contResult.data);
    }

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
      showError(result.error || "\u683C\u5F0F\u8F6C\u6362\u5931\u8D25");
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

function renderOverview(data) {
  const bag = data?.patentFileWrapperDataBag?.[0];
  if (!bag) {
    document.getElementById("app-info").innerHTML =
      '<p class="placeholder">\u672A\u627E\u5230\u7533\u8BF7\u6570\u636E</p>';
    return;
  }

  const meta = bag.applicationMetaData || {};
  const infoHtml = [
    infoRow("\u7533\u8BF7\u53F7", bag.applicationNumberText),
    infoRow("\u53D1\u660E\u540D\u79F0", meta.inventionTitle),
    infoRow("\u7533\u8BF7\u4EBA", meta.firstApplicantName),
    infoRow("\u5BA1\u67E5\u5458", meta.examinerNameText),
    infoRow("\u7533\u8BF7\u7C7B\u578B", meta.applicationTypeLabelName),
    infoRow("\u63D0\u4EA4\u65E5\u671F", meta.filingDate),
    infoRow(
      "\u5206\u7C7B\u53F7",
      meta.class && meta.subclass ? meta.class + "/" + meta.subclass : "-"
    ),
    infoRow("\u5BA1\u67E5\u5355\u5143", meta.groupArtUnitNumber),
  ].join("");

  document.getElementById("app-info").innerHTML = infoHtml;

  const statusHtml = [
    infoRow("\u72B6\u6001\u7801", meta.applicationStatusCode),
    infoRow("\u72B6\u6001\u63CF\u8FF0", meta.applicationStatusDescriptionText),
    infoRow("\u6388\u6743\u65E5\u671F", meta.grantDate),
    infoRow("\u4E13\u5229\u53F7", meta.patentNumber),
  ].join("");

  document.getElementById("app-status").innerHTML = statusHtml;
}

function renderTimeline(data) {
  const bag = data?.patentFileWrapperDataBag?.[0];
  const events = bag?.eventDataBag || [];
  if (events.length === 0) {
    document.getElementById("timeline-content").innerHTML =
      '<p class="placeholder">\u65E0\u5BA1\u67E5\u4E8B\u4EF6\u8BB0\u5F55</p>';
    return;
  }

  const sorted = [...events].sort((a, b) => {
    const da = a.eventDate || "";
    const db = b.eventDate || "";
    return db.localeCompare(da);
  });

  const html = sorted
    .map(
      (e) =>
        '<div class="timeline-item">' +
        '<span class="timeline-date">' +
        (e.eventDate || "-") +
        "</span>" +
        '<span class="timeline-code">' +
        (e.eventCode || "-") +
        "</span>" +
        '<span class="timeline-desc">' +
        (e.eventDescriptionText || "-") +
        "</span>" +
        "</div>"
    )
    .join("");

  document.getElementById("timeline-content").innerHTML = html;
}

function renderDocuments(data) {
  const docs = data?.documentBag || [];
  if (docs.length === 0) {
    document.getElementById("documents-content").innerHTML =
      '<p class="placeholder">\u65E0\u5BA1\u67E5\u6587\u6863</p>';
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

      const downloadHtml = downloadUrl
        ? '<a class="doc-download" href="' +
          downloadUrl +
          '" target="_blank">PDF' +
          (pages ? " (" + pages + "p)" : "") +
          "</a>"
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
        (d.documentDirectionCategory ? " \u00B7 " + d.documentDirectionCategory : "") +
        "</div>" +
        "</div>" +
        downloadHtml +
        "</div>"
      );
    })
    .join("");

  document.getElementById("documents-content").innerHTML = html;
}

function renderContinuity(data) {
  const bag = data?.patentFileWrapperDataBag?.[0];
  const parents = bag?.parentContinuityBag || [];
  const children = bag?.childContinuityBag || [];

  if (parents.length === 0 && children.length === 0) {
    document.getElementById("continuity-content").innerHTML =
      '<p class="placeholder">\u65E0\u7EED\u6848/\u5206\u6848\u5173\u7CFB</p>';
    return;
  }

  let html = "";

  if (parents.length > 0) {
    html +=
      '<div class="info-card"><div class="card-header">\u7236\u6848</div><div class="card-body">';
    html += parents
      .map(
        (p) =>
          '<div class="info-row">' +
          '<span class="info-label">' +
          (p.continuityTypeCode || "Continuation") +
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
      '<div class="info-card" style="margin-top:12px"><div class="card-header">\u5B50\u6848</div><div class="card-body">';
    html += children
      .map(
        (c) =>
          '<div class="info-row">' +
          '<span class="info-label">' +
          (c.continuityTypeCode || "Continuation") +
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

  document.getElementById("continuity-content").innerHTML = html;
}

function renderConvertResult(data) {
  if (!data) {
    document.getElementById("convert-result").innerHTML =
      '<p class="placeholder">\u65E0\u6CD5\u8BC6\u522B\u683C\u5F0F</p>';
    return;
  }

  const html = [
    infoRow("\u539F\u59CB\u8F93\u5165", data.raw),
    infoRow("\u8BC6\u522B\u5C40", data.office),
    infoRow("\u7533\u8BF7\u53F7", data.applicationNumber),
    infoRow("\u516C\u5F00\u53F7", data.publicationNumber || "-"),
    infoRow("\u4E13\u5229\u53F7", data.patentNumber || "-"),
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

function hideError() {
  errorToast.classList.add("hidden");
}
