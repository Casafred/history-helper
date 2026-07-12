/*!
 * PatentLens Agent - Patent Tools
 * 专利相关工具：封装现有UI逻辑，供Agent调用
 * 适配Electron环境（不依赖Tauri）
 */
var AgentPatentTools = (function () {
  var BUS = AgentEventBus;
  var EVT = BUS.EVENTS;

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
        var title = "";
        var applicantName = "";
        try {
          if (currentData.documents && currentData.documents.title) {
            title = currentData.documents.title;
          } else if (currentData.family && currentData.family.list && currentData.family.list.length > 0) {
            title = currentData.family.list[0].title || "";
          }
          applicantName = currentData.applicantName || "";
        } catch (e) { /* ignore */ }
        return {
          patentNumber: currentData.raw || (currentData.office + currentData.applicationNumber) || "",
          applicationNumber: currentData.applicationNumber || "",
          office: currentData.office || "",
          title: title,
          applicantName: applicantName,
          documents: currentData.documents || [],
          family: currentData.family || null,
          warnings: currentData.warnings || [],
        };
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function switchToTab(tabName) {
    var tabMap = {
      "overview": "overview",
      "family": "family",
      "kanban": "kanban",
      "documents": "kanban",
      "ai-analysis": "ai-analysis",
      "ai-summary": "ai-analysis",
    };
    var actualTab = tabMap[tabName] || tabName;
    var tabBtn = document.querySelector('.tab-btn[data-tab="' + actualTab + '"]');
    if (tabBtn && !tabBtn.classList.contains("active")) {
      tabBtn.click();
    } else if (tabBtn) {
      // already active
    }
    BUS.emit(EVT.TAB_SWITCH, { tab: actualTab });
    return { ok: true, switchedTo: actualTab };
  }

  function registerAll() {

    AgentTools.register({
      name: "fetch_patent",
      description: "查询专利审查信息并在界面上展示。输入专利号后自动查询同族、审查文档列表等数据，并切换到概览页面显示。这是查询专利的主要入口，支持US/EP/WO/DE/KR等专利局。",
      parameters: {
        type: "object",
        properties: {
          patent_number: {
            type: "string",
            description: "专利号，如 US14412875, EP1234567B1, WO2023123456",
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

        await new Promise(function (r) { return setTimeout(r, 800); });

        var data = getCurrentPatentData();
        if (data && data.patentNumber) {
          AgentCore.updateContext({ patentData: data, patentNumber: args.patent_number });

          switchToTab("overview");

          var docCount = 0;
          if (data.documents) {
            if (Array.isArray(data.documents)) {
              docCount = data.documents.length;
            } else if (data.documents.list && Array.isArray(data.documents.list)) {
              docCount = data.documents.list.length;
            }
          }

          return {
            ok: true,
            patentNumber: data.patentNumber,
            office: data.office,
            title: data.title || "(暂无标题)",
            applicantName: data.applicantName || "",
            documentCount: docCount,
            hasFamily: !!(data.family && data.family.list && data.family.list.length > 0),
            familyMemberCount: data.family && data.family.list ? data.family.list.length : 0,
            warnings: data.warnings,
          };
        }

        return { ok: false, error: "查询完成但未获取到数据，可能是专利号格式不支持或网络问题" };
      },
    });

    AgentTools.register({
      name: "switch_to_tab",
      description: "切换应用界面的标签页。可选值：overview（概览）、family（同族）、kanban（审查看板/文档列表）、ai-analysis（AI分析）。",
      parameters: {
        type: "object",
        properties: {
          tab: {
            type: "string",
            enum: ["overview", "family", "kanban", "ai-analysis"],
            description: "要切换到的标签页名称",
          },
        },
        required: ["tab"],
      },
      execute: function (args) {
        return Promise.resolve(switchToTab(args.tab));
      },
    });

    AgentTools.register({
      name: "get_documents_summary",
      description: "获取当前查询专利的审查文档列表摘要，包括文档类型、日期、标题等信息。需要先调用fetch_patent。",
      parameters: { type: "object", properties: {} },
      execute: function () {
        var data = getCurrentPatentData();
        if (!data) return Promise.resolve({ error: "请先调用fetch_patent查询专利" });
        var docs = [];
        var docSource = data.documents;
        var docList = [];
        if (Array.isArray(docSource)) {
          docList = docSource;
        } else if (docSource && docSource.list && Array.isArray(docSource.list)) {
          docList = docSource.list;
        } else if (docSource && Array.isArray(docSource.docs)) {
          docList = docSource.docs;
        }
        docList.forEach(function (d, i) {
          docs.push({
            idx: d.idx || i,
            type: d.type || d.docType || "",
            date: d.date || d.pubDate || "",
            title: d.title || d.description || "",
            docCode: d.docCode || "",
          });
        });
        return Promise.resolve({
          ok: true,
          patentNumber: data.patentNumber,
          count: docs.length,
          documents: docs,
        });
      },
    });

    AgentTools.register({
      name: "get_family_summary",
      description: "获取当前查询专利的同族信息摘要。需要先调用fetch_patent。",
      parameters: { type: "object", properties: {} },
      execute: function () {
        var data = getCurrentPatentData();
        if (!data || !data.family) return Promise.resolve({ error: "请先调用fetch_patent查询专利" });
        var members = [];
        if (data.family.list && Array.isArray(data.family.list)) {
          data.family.list.forEach(function (m) {
            members.push({
              country: m.countryCode || "",
              pubNum: m.pubNum || (m.docNum && m.docNum.docNumber) || "",
              appNum: m.appNum || "",
              title: m.title || "",
              kindCode: m.kindCode || "",
            });
          });
        }
        return Promise.resolve({
          ok: true,
          patentNumber: data.patentNumber,
          familyId: data.family.familyId || "",
          memberCount: members.length,
          members: members,
        });
      },
    });

    AgentTools.register({
      name: "get_patent_basic_info",
      description: "获取当前已查询专利的基本信息（专利号、标题、申请人、专利局等）。需要先调用fetch_patent。",
      parameters: { type: "object", properties: {} },
      execute: function () {
        var data = getCurrentPatentData();
        if (!data) return Promise.resolve({ error: "请先调用fetch_patent查询专利" });
        return Promise.resolve({
          patentNumber: data.patentNumber,
          applicationNumber: data.applicationNumber,
          office: data.office,
          title: data.title || "(暂无标题)",
          applicantName: data.applicantName || "",
        });
      },
    });
  }

  return { registerAll: registerAll };
})();
