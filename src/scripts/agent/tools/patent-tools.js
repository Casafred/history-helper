/*!
 * PatentLens Agent - Patent Tools
 * 专利相关工具：封装现有UI逻辑，供Agent调用
 * 适配Electron环境（不依赖Tauri）
 */
var AgentPatentTools = (function () {
  var BUS = AgentEventBus;
  var EVT = BUS.EVENTS;

  var currentFulltextData = null;

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

  function waitForFulltextComplete(timeoutMs) {
    return new Promise(function (resolve) {
      var timeout = setTimeout(function () {
        resolve({ timedOut: true });
      }, timeoutMs || 60000);

      var checkInterval = setInterval(function () {
        var searchBtnEl = document.getElementById("search-btn");
        var detailSection = document.getElementById("patent-detail-section");
        if (searchBtnEl && !searchBtnEl.disabled && detailSection && !detailSection.classList.contains("hidden")) {
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

  function getCurrentFulltextData() {
    if (currentFulltextData) {
      return currentFulltextData;
    }
    if (typeof window !== "undefined" && window._currentPatentData) {
      return window._currentPatentData;
    }
    if (typeof _pdPatentCache !== "undefined") {
      var keys = Object.keys(_pdPatentCache);
      if (keys.length > 0) {
        return _pdPatentCache[keys[keys.length - 1]];
      }
    }
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
      description: "查询专利审查档案/审查历史信息（dossier模式），获取同族专利、审查文档列表、审查时间线等审查流程相关数据。注意：此工具不包含权利要求书、说明书等专利全文内容。当用户需要：总结权利要求保护范围、查看专利全文、分析技术方案、查看说明书内容时，必须使用fetch_patent_fulltext工具。",
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

    AgentTools.register({
      name: "fetch_patent_fulltext",
      description: "查询专利原文（Google Patents），获取完整的专利信息包括：标题、摘要、权利要求书、说明书、申请人、发明人、引证/被引信息等。当用户需要总结权利要求保护范围、分析专利技术方案、查看专利全文内容时，应使用此工具而非fetch_patent。",
      parameters: {
        type: "object",
        properties: {
          patent_number: {
            type: "string",
            description: "专利号，支持CN/US/EP/WO/DE/JP/KR等各国专利号，如 CN101172339B, US14412875, EP1234567B1",
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

        if (typeof searchMode !== "undefined") {
          searchMode = "patent";
          document.querySelectorAll(".search-mode-btn").forEach(function (b) {
            b.classList.toggle("active", b.dataset.mode === "patent");
          });
        }

        patentInput.value = args.patent_number;

        if (typeof searchPatentDetail === "function") {
          try {
            await searchPatentDetail(args.patent_number);
          } catch (e) {
            return { error: "查询失败: " + e.message };
          }
        } else {
          return { error: "专利原文查询功能不可用" };
        }

        await new Promise(function (r) { return setTimeout(r, 1000); });

        var data = getCurrentFulltextData();
        if (data) {
          currentFulltextData = data;
          AgentCore.updateContext({ patentFulltextData: data, patentNumber: args.patent_number });

          var result = {
            ok: true,
            patentNumber: data.patent_number || args.patent_number,
            title: data.title || "(暂无标题)",
            abstract: data.abstract || "",
            assignees: data.assignees || [],
            inventors: data.inventors || [],
            publicationDate: data.publication_date || "",
            filingDate: data.filing_date || "",
            priorityDate: data.priority_date || "",
            claimsCount: (data.claims || []).length,
            hasDescription: !!(data.description && data.description.length > 0),
            citationCount: (data.patent_citations || []).length,
            citedByCount: (data.cited_by || []).length,
          };

          return result;
        }

        return { ok: false, error: "查询完成但未获取到专利原文数据，请检查专利号是否正确" };
      },
    });

    AgentTools.register({
      name: "get_patent_claims",
      description: "获取已查询专利原文的权利要求书全文。必须先调用fetch_patent_fulltext获取专利原文。返回所有权利要求的编号、类型（独立/从属）和文本内容。",
      parameters: { type: "object", properties: {} },
      execute: function () {
        var data = getCurrentFulltextData();
        if (!data || !data.claims) {
          return Promise.resolve({ error: "请先调用fetch_patent_fulltext查询专利原文" });
        }
        var claims = (data.claims || []).map(function (c, i) {
          return {
            num: c.num || (i + 1),
            type: c.type || (c.dependent_on ? "dependent" : "independent"),
            dependentOn: c.dependent_on || null,
            text: c.text || "",
          };
        });
        return Promise.resolve({
          ok: true,
          patentNumber: data.patent_number || "",
          title: data.title || "",
          totalClaims: claims.length,
          independentClaims: claims.filter(function (c) { return c.type === "independent" || !c.dependentOn; }).length,
          claims: claims,
        });
      },
    });

    AgentTools.register({
      name: "get_patent_abstract",
      description: "获取已查询专利原文的摘要。必须先调用fetch_patent_fulltext。",
      parameters: { type: "object", properties: {} },
      execute: function () {
        var data = getCurrentFulltextData();
        if (!data) {
          return Promise.resolve({ error: "请先调用fetch_patent_fulltext查询专利原文" });
        }
        return Promise.resolve({
          ok: true,
          patentNumber: data.patent_number || "",
          title: data.title || "",
          abstract: data.abstract || "",
        });
      },
    });
  }

  return { registerAll: registerAll };
})();
