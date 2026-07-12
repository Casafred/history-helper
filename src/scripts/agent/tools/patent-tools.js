/*!
 * PatentLens Agent - Patent Tools
 * 专利相关工具：封装现有UI逻辑和Tauri后端命令，供Agent调用
 */
var AgentPatentTools = (function () {
  var BUS = AgentEventBus;
  var EVT = BUS.EVENTS;

  function isTauriAvailable() {
    return !!(window.__TAURI_INTERNALS__);
  }

  async function invoke(cmd, args) {
    if (!isTauriAvailable()) {
      return { error: "Tauri环境不可用，请在桌面应用中运行" };
    }
    try {
      return await window.__TAURI_INTERNALS__.invoke(cmd, args || {});
    } catch (e) {
      console.error("[PatentTools] invoke error:", cmd, e);
      return { error: e.message || String(e) };
    }
  }

  function waitForSearchComplete(timeoutMs) {
    return new Promise(function (resolve) {
      var timeout = setTimeout(function () {
        resolve({ timedOut: true });
      }, timeoutMs || 30000);

      var checkInterval = setInterval(function () {
        var loadingEl = document.getElementById("loading");
        var searchBtnEl = document.getElementById("search-btn");
        if (loadingEl && loadingEl.classList.contains("hidden") && searchBtnEl && !searchBtnEl.disabled) {
          clearTimeout(timeout);
          clearInterval(checkInterval);
          resolve({ done: true });
        }
      }, 300);
    });
  }

  function getCurrentPatentData() {
    try {
      if (typeof currentData !== "undefined" && currentData) {
        return {
          patentNumber: currentData.patentNumber || currentData.docNumber || "",
          applicationNumber: currentData.applicationNumber || "",
          office: currentData.office || "",
          title: currentData.title || "",
          applicants: currentData.applicants || [],
          filingDate: currentData.filingDate || "",
          grantDate: currentData.grantDate || "",
          status: currentData.status || "",
          abstract: currentData.abstract || "",
          claims: currentData.claims || "",
          description: currentData.description || "",
          documents: currentData.documents || [],
        };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function registerAll() {

    AgentTools.register({
      name: "detect_patent_office",
      description: "检测专利号所属的专利局（如US/EP/CN/JP/DE/WO）。在查询专利之前应该先调用这个工具识别专利局。",
      parameters: {
        type: "object",
        properties: {
          patent_number: {
            type: "string",
            description: "专利号字符串，如 US14412875, EP1234567B1, CN101234567A",
          },
        },
        required: ["patent_number"],
      },
      execute: async function (args) {
        var result = await invoke("detect_patent_office", { input: args.patent_number });
        if (result && result.success && result.data) {
          AgentCore.updateContext({
            patentNumber: args.patent_number,
            office: result.data.office,
            normalizedNumber: result.data.normalized || args.patent_number,
          });
        }
        return result;
      },
    });

    AgentTools.register({
      name: "convert_patent_number",
      description: "验证并标准化专利号格式，处理用户输入的各种变体格式。",
      parameters: {
        type: "object",
        properties: {
          patent_number: {
            type: "string",
            description: "原始专利号输入",
          },
        },
        required: ["patent_number"],
      },
      execute: async function (args) {
        return await invoke("convert_patent_number", { input: args.patent_number });
      },
    });

    AgentTools.register({
      name: "fetch_patent",
      description: "查询专利完整信息并在界面上展示。调用后会自动获取申请信息、摘要、同族、审查文档列表等数据，并切换到概览页面显示。这是查询专利的主要入口。",
      parameters: {
        type: "object",
        properties: {
          patent_number: {
            type: "string",
            description: "专利号，如 US14412875",
          },
        },
        required: ["patent_number"],
      },
      execute: async function (args) {
        var patentInput = document.getElementById("patent-input");
        var searchBtn = document.getElementById("search-btn");
        if (!patentInput || !searchBtn) {
          return { error: "找不到搜索输入框" };
        }

        patentInput.value = args.patent_number;

        if (typeof doSearch === "function") {
          try {
            await doSearch(args.patent_number);
          } catch (e) {
            return { error: "查询失败: " + e.message };
          }
        } else {
          searchBtn.click();
          await waitForSearchComplete(30000);
        }

        await new Promise(function (r) { return setTimeout(r, 500); });

        var data = getCurrentPatentData();
        if (data) {
          AgentCore.updateContext({ patentData: data, patentNumber: args.patent_number });

          var summary = {
            ok: true,
            patentNumber: data.patentNumber,
            title: data.title,
            applicants: data.applicants,
            office: data.office,
            status: data.status,
            filingDate: data.filingDate,
            grantDate: data.grantDate,
            abstract: data.abstract ? (data.abstract.substring(0, 500) + (data.abstract.length > 500 ? "..." : "")) : "",
            hasClaims: !!(data.claims && data.claims.length > 0),
            hasDescription: !!(data.description && data.description.length > 0),
            documentCount: Array.isArray(data.documents) ? data.documents.length : 0,
          };

          var tabBtn = document.querySelector('.tab-btn[data-tab="overview"]');
          if (tabBtn && !tabBtn.classList.contains("active")) {
            tabBtn.click();
          }

          return summary;
        }

        var detectResult = await invoke("detect_patent_office", { input: args.patent_number });
        return detectResult;
      },
    });

    AgentTools.register({
      name: "fetch_family",
      description: "查看专利同族信息。需要先调用fetch_patent查询专利。",
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async function () {
        var ctx = AgentCore.getContext();
        var pn = ctx.patentNumber;
        if (!pn) return { error: "请先调用fetch_patent查询专利" };

        var result = await invoke("fetch_family", { input: pn });
        var tabBtn = document.querySelector('.tab-btn[data-tab="family"]');
        if (tabBtn) tabBtn.click();
        return result;
      },
    });

    AgentTools.register({
      name: "fetch_documents",
      description: "查看审查文档列表。需要先调用fetch_patent查询专利。",
      parameters: {
        type: "object",
        properties: {},
      },
      execute: async function () {
        var data = getCurrentPatentData();
        if (data && Array.isArray(data.documents) && data.documents.length > 0) {
          var tabBtn = document.querySelector('.tab-btn[data-tab="documents"]');
          if (tabBtn) tabBtn.click();
          return {
            ok: true,
            count: data.documents.length,
            documents: data.documents.map(function (d) {
              return {
                idx: d.idx,
                type: d.type || d.docType || "",
                date: d.date || d.pubDate || "",
                title: d.title || d.description || "",
                docCode: d.docCode || "",
              };
            }),
          };
        }

        var ctx = AgentCore.getContext();
        var pn = ctx.patentNumber;
        if (!pn) return { error: "请先调用fetch_patent查询专利" };
        var result = await invoke("fetch_documents", { input: pn });
        var tabBtn = document.querySelector('.tab-btn[data-tab="documents"]');
        if (tabBtn) tabBtn.click();
        return result;
      },
    });

    AgentTools.register({
      name: "get_abstract",
      description: "获取专利摘要。需要先调用fetch_patent。",
      parameters: { type: "object", properties: {} },
      execute: function () {
        var data = getCurrentPatentData();
        if (!data) return Promise.resolve({ error: "请先调用fetch_patent获取专利数据" });
        return Promise.resolve({
          patentNumber: data.patentNumber,
          title: data.title,
          abstract: data.abstract || "暂无摘要信息",
        });
      },
    });

    AgentTools.register({
      name: "get_claims",
      description: "获取专利权利要求书全文。需要先调用fetch_patent。",
      parameters: { type: "object", properties: {} },
      execute: function () {
        var data = getCurrentPatentData();
        if (!data) return Promise.resolve({ error: "请先调用fetch_patent获取专利数据" });
        return Promise.resolve({
          patentNumber: data.patentNumber,
          claims: data.claims || "暂无权利要求信息",
        });
      },
    });

    AgentTools.register({
      name: "get_description",
      description: "获取专利说明书全文（背景技术、发明内容、具体实施方式等）。需要先调用fetch_patent。",
      parameters: { type: "object", properties: {} },
      execute: function () {
        var data = getCurrentPatentData();
        if (!data) return Promise.resolve({ error: "请先调用fetch_patent获取专利数据" });
        return Promise.resolve({
          patentNumber: data.patentNumber,
          description: data.description || "暂无说明书信息",
        });
      },
    });

    AgentTools.register({
      name: "jpo_status",
      description: "检查日本JPO API是否已配置（查询日本专利需要单独配置Consumer Key/Secret）。",
      parameters: { type: "object", properties: {} },
      execute: async function () {
        return await invoke("jpo_status");
      },
    });

    AgentTools.register({
      name: "dpma_status",
      description: "检查德国DPMA API状态。",
      parameters: { type: "object", properties: {} },
      execute: async function () {
        return await invoke("dpma_status");
      },
    });
  }

  return { registerAll: registerAll };
})();
