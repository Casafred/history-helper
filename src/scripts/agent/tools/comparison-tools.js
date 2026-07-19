/* PatentLens Agent - Claim Comparison Tools */
var AgentComparisonTools = (function () {
  var BUS = AgentEventBus;
  var EVT = BUS.EVENTS;

  var _prepState = null;

  function log(msg, isError) {
    console.log("[AgentComparison] " + msg);
  }

  function normalizePatentNumber(input) {
    if (!input) return "";
    return String(input).trim().toUpperCase().replace(/[\s\/]/g, "");
  }

  function parsePatentNumbers(text) {
    if (!text) return [];
    return String(text)
      .split(/[\n,;，；\s]+/)
      .map(function (s) { return s.trim(); })
      .filter(Boolean)
      .map(normalizePatentNumber)
      .filter(Boolean);
  }

  function switchToComparisonMode() {
    var cmpBtn = document.querySelector('.search-mode-btn[data-mode="comparison"]');
    if (cmpBtn) {
      cmpBtn.classList.add("active");
      cmpBtn.click();
    }
    document.querySelectorAll(".search-mode-btn").forEach(function (b) {
      if (b.dataset.mode !== "comparison") b.classList.remove("active");
    });
    return { ok: true };
  }

  function waitFor(conditionFn, timeoutMs, intervalMs) {
    timeoutMs = timeoutMs || 60000;
    intervalMs = intervalMs || 300;
    return new Promise(function (resolve) {
      var start = Date.now();
      var timer = setInterval(function () {
        try {
          if (conditionFn()) {
            clearInterval(timer);
            resolve({ ok: true, elapsed: Date.now() - start });
            return;
          }
        } catch (e) {}
        if (Date.now() - start > timeoutMs) {
          clearInterval(timer);
          resolve({ ok: false, timedOut: true, elapsed: Date.now() - start });
        }
      }, intervalMs);
    });
  }

  function waitMs(ms) {
    return new Promise(function (r) { return setTimeout(r, ms); });
  }

  async function fetchPatentData(patentNum) {
    var pn = normalizePatentNumber(patentNum);
    if (typeof GPCache !== "undefined") {
      var cached = GPCache.get(pn);
      if (cached && cached.claims && cached.claims.length > 0) {
        return { ok: true, fromCache: true, data: cached };
      }
    }
    if (window._pdPatentCache && window._pdPatentCache[pn]) {
      var sessionCached = window._pdPatentCache[pn];
      if (sessionCached.claims && sessionCached.claims.length > 0) {
        return { ok: true, fromCache: true, data: sessionCached };
      }
    }
    if (typeof fetchPatentWithRetry === "function") {
      try {
        var resp = await fetchPatentWithRetry(pn, 3);
        if (resp && resp.success && resp.data) {
          var patentData = resp.data;
          if (patentData.claims && patentData.claims.length > 0 && patentData.data_source !== "Espacenet") {
            if (typeof GPCache !== "undefined") {
              GPCache.set(pn, patentData);
            }
            if (window._pdPatentCache) {
              window._pdPatentCache[pn] = patentData;
            }
            return { ok: true, fromCache: false, data: patentData };
          }
          if (patentData.data_source === "Espacenet") {
            return { ok: false, error: "Espacenet降级数据不含权利要求" };
          }
          return { ok: false, error: "未找到权利要求数据" };
        }
        return { ok: false, error: (resp && resp.error) ? resp.error : "查询失败" };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    }
    return { ok: false, error: "专利查询功能不可用" };
  }

  function extractIndependentClaims(patentData, patentNum) {
    var claims = patentData.claims || [];
    var indeps = [];
    claims.forEach(function (c, i) {
      var isInd = false;
      if (c.type === "independent") {
        isInd = true;
      } else if (c.type === "dependent") {
        isInd = false;
      } else if (c.dependent_on !== undefined && c.dependent_on !== null && c.dependent_on !== "" && c.dependent_on !== false) {
        isInd = false;
      } else if (typeof ComparisonCore !== "undefined" && ComparisonCore.isIndependentClaim) {
        isInd = ComparisonCore.isIndependentClaim(c, i);
      } else {
        var text = (c.text || "").trim();
        var head = text.substring(0, 300);
        if (/^(根据|如|按照|依据).*(权利要求|权项)/i.test(head)) isInd = false;
        else if (/前記|所述的/.test(text.substring(0, 80))) isInd = false;
        else if (/\bclaim\s+\d+/i.test(head)) isInd = false;
        else isInd = i === 0;
      }
      if (isInd) {
        indeps.push({
          num: c.num || (i + 1),
          text: c.text || "",
          textPreview: (c.text || "").substring(0, 200),
          isIndependent: true,
          idx: i
        });
      }
    });
    return indeps;
  }

  function registerAll() {

    AgentTools.register({
      name: "prepare_claim_comparison",
      description: "准备权利要求比对：输入多个专利号（用逗号/换行/空格分隔，如 US14412875, CN101172339B, EP1234567B1），自动查询各专利并提取独立权利要求。查询完成后会返回各专利的独权列表供确认。仅用于权利要求比对场景，普通专利查询请用fetch_patent或fetch_patent_fulltext。",
      parameters: {
        type: "object",
        properties: {
          patent_numbers: {
            type: "string",
            description: "专利号列表，支持多个，用逗号、换行或空格分隔。例如：US14412875, CN101172339B, EP1234567B1",
          },
          anchor_patent: {
            type: "string",
            description: "（可选）指定作为锚点（比对基准）的专利号。如不指定，默认使用第一个专利的第一项独权作为锚点。",
          },
        },
        required: ["patent_numbers"],
      },
      execute: async function (args) {
        var numbers = parsePatentNumbers(args.patent_numbers);
        if (numbers.length < 2) {
          return { ok: false, error: "至少需要2个专利号进行比对，您输入了 " + numbers.length + " 个" };
        }
        if (numbers.length > 10) {
          return { ok: false, error: "最多支持同时比对10个专利" };
        }

        switchToComparisonMode();
        await waitMs(500);

        if (typeof ComparisonCore !== "undefined") {
          ComparisonCore.clearItems();
          ComparisonCore.setInputMode("patent");
        }
        await waitMs(200);

        var textarea = document.getElementById("cmp-patent-numbers");
        if (textarea) {
          textarea.value = numbers.join("\n");
          if (typeof ComparisonCore !== "undefined") {
            ComparisonCore.setPatentNumbersText(numbers.join("\n"));
          }
        }

        var results = {};
        var errors = [];
        var allIndeps = {};
        var patentDataCache = {};

        for (var i = 0; i < numbers.length; i++) {
          var pn = numbers[i];
          log("正在查询专利 " + (i + 1) + "/" + numbers.length + ": " + pn);
          await waitMs(i === 0 ? 300 : 200);
          var result = await fetchPatentData(pn);
          if (result.ok) {
            var indeps = extractIndependentClaims(result.data, pn);
            results[pn] = {
              patentNumber: result.data.patent_number || result.data.patentNumber || pn,
              title: result.data.title || "",
              applicant: result.data.assignee || result.data.applicant || "",
              totalClaims: (result.data.claims || []).length,
              independentClaims: indeps,
              fromCache: result.fromCache
            };
            allIndeps[pn] = indeps;
            patentDataCache[pn] = result.data;
            log(pn + " 查询成功（" + (result.data.claims || []).length + "项权利要求，" + indeps.length + "项独权）");
          } else {
            errors.push(pn + ": " + result.error);
            log(pn + " 查询失败: " + result.error, true);
          }
        }

        var successCount = Object.keys(results).length;
        if (successCount < 2) {
          return {
            ok: false,
            error: "专利查询失败，成功获取到 " + successCount + " 个专利（至少需要2个）。错误: " + errors.join("; "),
            successfulPatents: Object.keys(results),
            errors: errors
          };
        }

        var anchorPatent = normalizePatentNumber(args.anchor_patent) || numbers[0];
        if (!results[anchorPatent]) {
          anchorPatent = Object.keys(results)[0];
        }

        _prepState = {
          patentNumbers: numbers,
          results: results,
          errors: errors,
          anchorPatent: anchorPatent,
          allIndeps: allIndeps,
          patentDataCache: patentDataCache
        };

        if (typeof ComparisonCore !== "undefined") {
          var fetchedPatents = {};
          Object.keys(patentDataCache).forEach(function (key) {
            var d = patentDataCache[key];
            var r = results[key];
            fetchedPatents[key] = {
              patentNumber: d.patent_number || d.patentNumber || key,
              title: d.title || r.title,
              applicant: d.assignee || d.applicant || r.applicant,
              claims: d.claims || []
            };
          });
          ComparisonCore.setFetchedPatents(fetchedPatents, errors, {});
          ComparisonCore.setPatentNumbersText(numbers.join("\n"));
        }

        if (typeof ComparisonUI !== "undefined" && ComparisonUI.render) {
          ComparisonUI.render();
        }

        var summary = {
          ok: true,
          action: "专利查询完成",
          totalQueried: numbers.length,
          successCount: successCount,
          errorCount: errors.length,
          errors: errors,
          anchorPatent: anchorPatent,
          defaultAnchorClaim: anchorPatent + ":1",
          patents: {}
        };

        Object.keys(results).forEach(function (pn) {
          var r = results[pn];
          summary.patents[pn] = {
            title: r.title,
            applicant: r.applicant,
            totalClaims: r.totalClaims,
            independentClaimCount: r.independentClaims.length,
            independentClaims: r.independentClaims.map(function (c) {
              return {
                num: c.num,
                textPreview: c.textPreview,
                claimId: pn + ":" + c.num
              };
            })
          };
        });

        summary.tip = "已成功查询到 " + successCount + " 个专利的独立权利要求。请在对话中用清晰的表格/列表向用户展示各专利的独权选项（专利号、权项号、内容预览），然后用ask_user询问：1）要比对哪些权项（默认全部独权）；2）以哪个为锚点（默认" + anchorPatent + "权1）。用户可以用自然语言回答（如「全部都要」「只选权1」「用美国专利做基准」等），理解后调用execute_claim_comparison传参后台执行。绝不要让用户去界面上手动选择锚点或点击按钮！";
        return summary;
      },
    });

    AgentTools.register({
      name: "execute_claim_comparison",
      description: "在后台自动执行权利要求AI比对：添加选中的权项、设置锚点、运行AI语义比对、生成HTML报告并自动触发下载。**完全在后台执行，不需要用户在界面上操作任何东西。** 用户通过对话确认选择后调用此工具。",
      parameters: {
        type: "object",
        properties: {
          selected_claims: {
            type: "string",
            description: "（可选）指定要比对的权利要求，格式为「专利号:权项号」，多个用逗号分隔。例如：US11148275B2:1, US11148275B2:18, EP3481593B1:1。留空或不填则默认选择所有专利的全部独立权利要求。",
          },
          anchor_claim: {
            type: "string",
            description: "（可选）指定锚点权利要求，格式为「专利号:权项号」。如不指定则使用第一个专利的权1作为锚点。",
          },
          auto_export: {
            type: "boolean",
            description: "（可选）是否在比对完成后自动导出并下载HTML报告，默认true。",
          },
        },
      },
      execute: async function (args) {
        if (!_prepState) {
          return { ok: false, error: "请先调用prepare_claim_comparison准备比对数据" };
        }
        var state = _prepState;
        var results = state.results;
        var anchorClaim = args.anchor_claim || "";
        var autoExport = args.auto_export !== false;

        var claimSelections = {};
        var selectedClaimsInput = (args.selected_claims || "").trim();

        Object.keys(results).forEach(function (pn) {
          claimSelections[pn] = state.allIndeps[pn].map(function (c) { return c.num; });
        });

        if (selectedClaimsInput) {
          claimSelections = {};
          var pairs = selectedClaimsInput.split(/[,，;；\s]+/).filter(Boolean);
          pairs.forEach(function (pair) {
            var parts = pair.split(/[:：]+/);
            var pn = normalizePatentNumber(parts[0]);
            var cn = parts[1] ? parseInt(parts[1], 10) : 1;
            if (!claimSelections[pn]) claimSelections[pn] = [];
            if (claimSelections[pn].indexOf(cn) === -1) claimSelections[pn].push(cn);
          });
        }

        var anchorPatent = state.anchorPatent;
        var anchorNum = 1;
        if (anchorClaim) {
          var aParts = anchorClaim.split(/[:：]+/);
          anchorPatent = normalizePatentNumber(aParts[0]) || state.anchorPatent;
          anchorNum = aParts[1] ? parseInt(aParts[1], 10) : 1;
        }

        if (typeof ComparisonCore === "undefined") {
          return { ok: false, error: "智能比对模块未加载" };
        }

        ComparisonCore.clearItems();

        var itemsToAdd = [];
        var anchorId = null;
        var dataCache = state.patentDataCache || {};

        Object.keys(claimSelections).forEach(function (pn) {
          var patentData = dataCache[pn];
          if (!patentData && typeof GPCache !== "undefined") patentData = GPCache.get(pn);
          if (!patentData && window._pdPatentCache) patentData = window._pdPatentCache[pn];
          if (!patentData || !patentData.claims) return;

          var selectedNums = claimSelections[pn];
          selectedNums.forEach(function (cnum) {
            var claim = null;
            var claimIdx = -1;
            for (var ci = 0; ci < patentData.claims.length; ci++) {
              var c = patentData.claims[ci];
              var cn = c.num || (ci + 1);
              if (cn == cnum) {
                claim = c;
                claimIdx = ci;
                break;
              }
            }
            if (!claim) return;
            var isAnchor = (pn === anchorPatent && cnum == anchorNum);
            var label = pn + " 权" + cnum;
            var itemId = "cmp_" + pn + "_" + cnum;
            var item = {
              id: itemId,
              label: label,
              source: "patent",
              patentNumber: pn,
              claimNumber: cnum,
              originalText: claim.text || "",
              isSelected: true,
              isAnchor: isAnchor
            };
            itemsToAdd.push(item);
            if (isAnchor && !anchorId) {
              anchorId = itemId;
            }
          });
        });

        if (itemsToAdd.length < 2) {
          return { ok: false, error: "可用于比对的权利要求不足2项，请检查选择" };
        }
        if (!anchorId) anchorId = itemsToAdd[0].id;

        log("已选择 " + itemsToAdd.length + " 项权利要求，锚点: " + (itemsToAdd.find(function(i){return i.id===anchorId;})||{}).label);

        itemsToAdd.forEach(function (item) {
          ComparisonCore.addItem(item);
        });
        ComparisonCore.setAnchor(anchorId);
        ComparisonCore.selectAll();

        await waitMs(300);
        if (typeof ComparisonUI !== "undefined" && ComparisonUI.render) {
          ComparisonUI.render();
        }
        await waitMs(500);

        log("开始AI比对分析，请稍候...");

        var result = null;
        try {
          result = await ComparisonCore.runComparison();
        } catch (e) {
          return { ok: false, error: "比对失败: " + (e.message || String(e)) };
        }

        if (!result) {
          return { ok: false, error: "比对未完成（可能被用户中止）" };
        }

        if (autoExport && typeof ComparisonReport !== "undefined" && ComparisonReport.exportHtml) {
          await waitMs(500);
          try {
            ComparisonReport.exportHtml();
            log("HTML报告已触发下载");
          } catch (e) {
            log("报告导出失败: " + e.message, true);
          }
        }

        if (typeof ComparisonUI !== "undefined" && ComparisonUI.render) {
          ComparisonUI.render();
        }

        _prepState = null;

        var markdownContent = result.markdownContent || "";
        var summaryPreview = markdownContent.length > 3000 ? markdownContent.substring(0, 3000) + "..." : markdownContent;

        return {
          ok: true,
          action: "权利要求比对完成",
          itemCount: itemsToAdd.length,
          anchor: (itemsToAdd.find(function(i){return i.id===anchorId;})||{}).label,
          htmlReportExported: autoExport,
          markdownPreview: summaryPreview,
          markdownLength: markdownContent.length,
          tip: "比对分析已完成！HTML报告已自动触发下载。请根据markdownPreview中的比对结果，整理成清晰的结构化总结（如：保护范围差异、技术特征增减、各国独权异同点等）告知用户。用户可切换到智能比对标签页查看完整交互结果，或点击导出按钮重新下载报告。",
          resultReady: true
        };
      },
    });

    AgentTools.register({
      name: "quick_compare_claims",
      description: "快捷一站式权利要求比对：自动查询→自动选全部独权→以第一个专利权1为锚点→后台运行AI比对→自动下载HTML报告。不需要中间确认/选择步骤。适用于用户明确说「直接比对」「快速对比」「帮我对比一下」等不需要选择权项的快速场景。如果用户说要先看独权列表、要选特定权项、要换锚点，请使用prepare_claim_comparison流程。",
      parameters: {
        type: "object",
        properties: {
          patent_numbers: {
            type: "string",
            description: "专利号列表，多个用逗号/换行/空格分隔，如 US14412875, CN101172339B, EP1234567B1",
          },
          anchor_patent: {
            type: "string",
            description: "（可选）指定锚点专利号，默认使用第一个专利",
          },
        },
        required: ["patent_numbers"],
      },
      execute: async function (args) {
        var prepResult = await AgentTools.execute("prepare_claim_comparison", {
          patent_numbers: args.patent_numbers,
          anchor_patent: args.anchor_patent
        }, {});

        if (!prepResult.ok) {
          return prepResult;
        }

        var execResult = await AgentTools.execute("execute_claim_comparison", {
          anchor_claim: prepResult.anchorPatent ? prepResult.anchorPatent + ":1" : "",
          auto_export: true
        }, {});

        return execResult;
      },
    });
  }

  return { registerAll: registerAll };
})();
