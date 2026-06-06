var AI = (function () {
  var STORAGE_KEY = "history-helper-ai-config";

  function getDefaultBaseUrl(type) {
    switch (type) {
      case "openai": return "https://api.openai.com";
      case "zhipu": return "https://open.bigmodel.cn/api/paas";
      case "deepseek": return "https://api.deepseek.com";
    }
  }

  function getDefaultModels(type) {
    switch (type) {
      case "openai": return ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"];
      case "zhipu": return ["glm-5.1", "glm-5-turbo", "glm-5", "glm-4.7", "glm-4.7-flashx", "glm-4.5-air", "glm-4-plus", "glm-4-flash", "glm-4-air"];
      case "deepseek": return ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"];
    }
  }

  function getAvailableModels(type) {
    var models = getDefaultModels(type);
    return models.map(function (m) { return { value: m, label: m }; });
  }

  function createDefaultConfig(type) {
    var models = getDefaultModels(type);
    return {
      type: type,
      apiKey: "",
      baseUrl: getDefaultBaseUrl(type),
      model: models[0] || "",
    };
  }

  function getDefaultTranslateModel(type) {
    switch (type) {
      case "zhipu": return "glm-4-flash";
      case "deepseek": return "deepseek-chat";
      case "openai": return "gpt-4o-mini";
      default: return "";
    }
  }

  function getTranslateProvider(config) {
    var translate = config.translate;
    if (translate && translate.provider) {
      var pType = translate.provider;
      var pConfig = config[pType];
      if (pConfig && pConfig.apiKey) {
        return {
          type: pType,
          apiKey: translate.apiKey || pConfig.apiKey,
          baseUrl: pConfig.baseUrl,
          model: translate.model || getDefaultTranslateModel(pType),
        };
      }
    }
    // Fallback: use current AI provider with default translate model
    var provider = getCurrentProvider(config);
    if (provider) {
      return {
        type: provider.type,
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        model: getDefaultTranslateModel(provider.type) || provider.model,
      };
    }
    return null;
  }

  function loadAIConfig() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return {
      openai: createDefaultConfig("openai"),
      zhipu: createDefaultConfig("zhipu"),
      deepseek: createDefaultConfig("deepseek"),
      ocr: { engine: "paddle_ocr_vl" },
    };
  }

  function saveAIConfig(config) {
    if (!config.ocr) config.ocr = { engine: "paddle_ocr_vl" };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  }

  function getOCRConfig(config) {
    if (!config.ocr) config.ocr = { engine: "paddle_ocr_vl" };
    return config.ocr;
  }

  function getGlmOcrApiKey(config) {
    if (config.ocr && config.ocr.glmKey) return config.ocr.glmKey;
    if (config.zhipu && config.zhipu.apiKey) return config.zhipu.apiKey;
    return "";
  }

  var DEFAULT_PROMPTS = {
    kanbanAnalysis: '你是一位面向**竞争对手方**的专利侵权分析顾问。请根据以下从 Global Dossier 获取的审查意见（Office Action）和申请人答复（Response）的实际内容，整理出一份结构化的审查历史分析报告，帮助竞争对手方评估该专利的授权稳定性、权利要求范围和规避设计空间。\n\n## 关键规则\n\n1. **必须首先阅读审查时间线概要**：用户消息开头包含"审查时间线概要"，列出了所有审查文档的日期、类型和当前阶段。你必须根据时间线概要判断专利的当前状态（如已授权、审查中等），并在分析中准确反映。如果时间线显示专利已授权，不得在分析中说"正在等待下一次答复"或类似表述；如果时间线显示当前待答复，也不得错误地说已授权。\n\n2. **必须引用来源**：你的每一段分析都必须标注来源，使用 【来源: block_id1, block_id2】 格式。\n   - 在总结的每一段末尾，用 【来源: B_p1_0, B_p1_1】 标注该段分析依据的原文块\n   - block_id 格式为 B_p{页码}_{块序号}，如 B_p1_0、B_p3_5\n   - 可以引用多个来源块\n\n3. **报告结构**（使用 Markdown 格式）：\n   - **案件概要**（专利号、申请号、申请人、当前阶段、对侵权方的影响概述）\n   - **审查轮次详表**（按时间倒序：日期 | 文件类型 | 核心要点 | 对侵权方的影响）\n   - **权利要求范围演变表**（每轮审查后独立权利要求的关键修改，及对规避设计的影响）\n   - **关键争议焦点与无效机会**（审查员引用的对比文献、申请人争辩的要点、竞争对手方可利用的无效理由）\n   - **授权前景与风险评级**（授权可能性：高/中/低 | 权利要求范围：宽/中/窄 | 规避难度：高/中/低）\n   - **监控建议**（建议竞争对手方关注的审查进展和关键节点）\n\n4. **注意事项**：\n   - 不要编造文档中没有的内容\n   - 如果某段分析综合了多个来源，全部列出\n   - 保持来源标注的准确性，不要张冠李戴\n   - 每段分析都必须有来源标注，无来源的内容不可信\n   - 始终站在竞争对手方立场，关注：权利要求范围是否可被缩小、审查员引用的文献是否可用于无效、申请人的修改是否引入了禁反言\n   - 分析中可能包含权利要求书（CLM）和说明书（SPEC）作为参考上下文，请结合这些文件理解审查意见和答复的针对性修改\n   - 请用中文回答',
    kanbanAnalysisSimple: '你是一位面向**竞争对手方**的专利侵权分析顾问。请根据以下审查意见和答复内容，整理出一份简明的审查历史分析报告。\n\n**必须首先阅读审查时间线概要**：用户消息开头包含"审查时间线概要"，列出了所有审查文档的日期、类型和当前阶段。你必须根据时间线概要判断专利的当前状态（如已授权、审查中等），并在分析中准确反映。如果时间线显示专利已授权，不得在分析中说"正在等待下一次答复"或类似表述。\n\n## 报告结构（Markdown 格式）：\n1. **审查概要**（专利号、申请人、当前阶段）\n2. **审查轮次一览表**（日期 | 文件类型 | 核心要点 | 对侵权方的影响）\n3. **风险速评**（授权可能性：高/中/低 | 权利要求范围：宽/中/窄 | 规避难度：高/中/低）\n4. **监控建议**（建议关注的审查进展）\n\n**注意**：始终站在竞争对手方立场，关注权利要求范围、无效机会和规避空间。请用中文回答。',
    docAnalysis: '你是一位面向**竞争对手方**的专利侵权分析顾问。请对以下专利审查文档内容进行详细分析，帮助竞争对手方评估该文档对侵权风险和规避策略的影响。\n\n## 关键规则\n\n1. **必须引用来源**：你的每一段分析都必须标注来源，使用 【来源: block_id1, block_id2】 格式。\n   - block_id 格式为 B_p{页码}_{块序号}，如 B_p1_0、B_p3_5\n   - 在总结的每一段末尾标注该段分析依据的原文块\n\n2. **报告结构**（Markdown 格式）：\n   - **文档基本信息**（文档类型、日期、发文方）\n   - **驳回理由详解**（审查员引用的对比文献、法条、核心论点，及对侵权方的价值——哪些论点可用于无效）\n   - **申请人陈述与档案历史禁反言**（申请人的争辩和修改，可能构成禁反言限制权利要求解释的要点）\n   - **权利要求修改分析**（修改了哪些权利要求、缩小了什么范围、对规避设计的影响）\n   - **审查员倾向性**（审查员是否容易说服、对特定论点的偏好）\n   - **侵权方行动建议**（基于此文档，竞争对手方应采取的策略）\n\n3. **注意事项**：\n   - 不要编造文档中没有的内容\n   - 始终站在竞争对手方立场\n   - 请用中文回答',
    historySummary: '你是一位面向**竞争对手方**的专利侵权分析顾问。请根据以下专利数据，对审查历史进行梳理分析，帮助竞争对手方快速了解该专利的审查全貌和风险点。\n\n## 报告结构（Markdown 格式）：\n1. **案件摘要**（专利号、申请人、技术领域、当前状态）\n2. **审查时间线**（关键节点：申请、实审请求、每轮OA/答复、授权/驳回，及每个节点对侵权方的意义）\n3. **关键转折点**（审查中的重大变化：权利要求大幅修改、审查员更换立场、引入关键对比文献等）\n4. **风险总结与监控建议**（授权稳定性评估、权利要求范围判断、建议监控的同族申请）\n\n**注意**：始终站在竞争对手方立场，关注无效机会和规避空间。请用中文回答。',
    citedRefsAnalysis: '请对以上引用文献相关文档进行分析，包括：\n1. 审查员引用了哪些文献？列出每篇引用文献的编号、类型和相关性说明\n2. 申请人引用了哪些文献？与审查员引用有何异同\n3. 引用文献的技术领域分布，是否涉及竞争对手专利\n4. 引用文献对本专利权利要求的影响评估\n5. 建议关注的引用文献和潜在风险',
  };

  function getDefaultPrompt(key) {
    return DEFAULT_PROMPTS[key] || "";
  }

  function getCustomPrompt(config, key) {
    if (config.prompts && config.prompts[key]) return config.prompts[key];
    return getDefaultPrompt(key);
  }

  function saveCustomPrompt(config, key, value) {
    if (!config.prompts) config.prompts = {};
    config.prompts[key] = value;
  }

  function resetPrompt(config, key) {
    if (config.prompts) delete config.prompts[key];
  }

  function getCurrentProvider(config) {
    var keys = Object.keys(config);
    for (var i = 0; i < keys.length; i++) {
      var c = config[keys[i]];
      if (c && c.apiKey) return c;
    }
    return null;
  }

  function buildUrl(providerType, baseUrl) {
    var base = baseUrl.replace(/\/+$/, "");
    if (providerType === "zhipu") {
      if (!base.endsWith("/v4")) base += "/v4";
    } else {
      if (!base.endsWith("/v1")) base += "/v1";
    }
    return base;
  }

  async function* streamChat(providerType, apiKey, baseUrl, params, signal) {
    var url = buildUrl(providerType, baseUrl) + "/chat/completions";

    var body = {
      model: params.model,
      messages: params.messages,
      max_tokens: params.maxTokens || 32768,
      stream: true,
    };

    if (providerType === "deepseek") {
      if (params.thinking && params.thinking.type === "enabled") {
        body.thinking = { type: "enabled" };
        if (params.thinking.budgetTokens) {
          body.thinking.budget_tokens = params.thinking.budgetTokens;
        }
      } else {
        body.temperature = params.temperature != null ? params.temperature : 0.1;
      }
      body.stream_options = { include_usage: true };
    } else if (providerType === "zhipu") {
      body.temperature = params.temperature != null ? params.temperature : 0.1;
    } else {
      body.temperature = params.temperature != null ? params.temperature : 0.1;
    }

    var response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey,
      },
      body: JSON.stringify(body),
      signal: signal,
    });

    if (!response.ok) {
      var errorText = await response.text();
      throw new Error("AI API 请求失败 (" + response.status + "): " + errorText);
    }

    var reader = response.body && response.body.getReader();
    if (!reader) throw new Error("无法读取响应流");

    var decoder = new TextDecoder();
    var buffer = "";

    while (true) {
      var result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      var lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (var i = 0; i < lines.length; i++) {
        var trimmed = lines[i].trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        var data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          yield { content: "", done: true };
          return;
        }
        try {
          var parsed = JSON.parse(data);
          var delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
          var content = (delta && delta.content) || "";
          var reasoningContent = (delta && delta.reasoning_content) || "";
          if (content || reasoningContent) {
            yield { content: content, reasoningContent: reasoningContent, done: false };
          }
        } catch (e) { continue; }
      }
    }

    yield { content: "", done: true };
  }

  async function testConnection(providerType, apiKey, baseUrl, model) {
    var start = performance.now();
    try {
      var url = buildUrl(providerType, baseUrl) + "/chat/completions";
      var response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 5,
          stream: false,
        }),
      });
      var latency = Math.round(performance.now() - start);
      if (response.ok) return { success: true, message: "连接成功 (" + latency + "ms)", latency: latency };
      var errorText = await response.text();
      return { success: false, message: "HTTP " + response.status + ": " + errorText.slice(0, 200), latency: latency };
    } catch (err) {
      var latency2 = Math.round(performance.now() - start);
      return { success: false, message: "网络错误: " + err.message, latency: latency2 };
    }
  }

  return {
    getDefaultBaseUrl: getDefaultBaseUrl,
    getAvailableModels: getAvailableModels,
    getDefaultTranslateModel: getDefaultTranslateModel,
    getTranslateProvider: getTranslateProvider,
    loadAIConfig: loadAIConfig,
    saveAIConfig: saveAIConfig,
    getCurrentProvider: getCurrentProvider,
    getOCRConfig: getOCRConfig,
    getGlmOcrApiKey: getGlmOcrApiKey,
    getDefaultPrompt: getDefaultPrompt,
    getCustomPrompt: getCustomPrompt,
    saveCustomPrompt: saveCustomPrompt,
    resetPrompt: resetPrompt,
    streamChat: streamChat,
    testConnection: testConnection,
  };
})();
