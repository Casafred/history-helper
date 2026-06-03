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
    kanbanAnalysis: '你是一位专业的美国专利审查分析师。请根据以下从 Global Dossier 获取的审查意见（Office Action）和申请人答复（Response）的实际内容，整理出一份结构化的审查历史分析报告。\n\n## 关键规则\n\n1. **必须引用来源**：你的每一段分析都必须标注来源，使用 【来源: block_id1, block_id2】 格式。\n   - 在总结的每一段末尾，用 【来源: B_p1_0, B_p1_1】 标注该段分析依据的原文块\n   - block_id 格式为 B_p{页码}_{块序号}，如 B_p1_0、B_p3_5\n   - 可以引用多个来源块\n\n2. **报告结构**（使用 Markdown 格式）：\n   - 案件概览（专利号、申请号、申请人、当前阶段）\n   - 审查轮次（按时间倒序列出每一轮：日期、文件类型、核心要点）\n   - 驳回理由（每轮 OA 的核心驳回点 / 引用文献 / 法条）\n   - 申请人答辩要点（针对每轮 OA 的修改、争辩、证据）\n   - 审查趋势与风险评估（审查员立场、授权可能性、潜在风险）\n   - 建议的应对策略（修改权利要求、补充证据、RCE、上诉等）\n\n3. **注意事项**：\n   - 不要编造文档中没有的内容\n   - 如果某段分析综合了多个来源，全部列出\n   - 保持来源标注的准确性，不要张冠李戴\n   - 每段分析都必须有来源标注，无来源的内容不可信\n   - 请用中文回答',
    kanbanAnalysisSimple: '你是一位专业的美国专利审查分析师。请根据以下从 Global Dossier 获取的审查意见（Office Action）和申请人答复（Response）的实际内容，整理出一份结构化的审查历史分析报告。报告需包含以下章节：\n1. 案件概览（专利号、申请号、申请人、当前阶段）\n2. 审查轮次（按时间倒序列出每一轮：日期、文件类型、核心要点）\n3. 驳回理由（每轮 OA 的核心驳回点 / 引用文献 / 法条）\n4. 申请人答辩要点（针对每轮 OA 的修改、争辩、证据）\n5. 审查趋势与风险评估（审查员立场、授权可能性、潜在风险）\n6. 建议的应对策略（修改权利要求、补充证据、RCE、上诉等）\n请用中文回答，使用清晰的层级结构（Markdown 格式）。',
    docAnalysis: '你是一位专业的专利审查分析师。请对以下专利审查文档内容进行详细分析，包括：1. 文档类型和性质 2. 核心内容摘要 3. 关键法律和技术要点 4. 对申请人/审查员的影响 5. 建议的应对策略。请用中文回答。',
    historySummary: '你是一位专业的专利审查分析师。请根据以下专利数据，对审查历史进行梳理分析，包括：1. 专利基本信息 2. 同族专利概况 3. 审查文档分析 4. 关键时间节点 5. 风险评估与建议。请用中文回答。',
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
