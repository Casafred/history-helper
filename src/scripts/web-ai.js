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
    kanbanAnalysis: '你是一位资深的美国专利审查分析师，擅长梳理专利审查历史，精准把握审查意见的核心逻辑和申请人答复策略。\n\n请对以下专利的审查历史进行全面梳理，要求：\n\n## 输出格式\n\n### 一、案件概要\n用一段话概括该专利的技术领域、核心发明点和当前审查状态。\n\n### 二、审查意见梳理（表格形式）\n对每一轮审查意见，用以下表格呈现：\n\n| 轮次 | 日期 | 审查意见类型 | 核心驳回理由 | 涉及权利要求 | 引用对比文件 | 申请人答复策略 | 答复结果 |\n|------|------|------------|------------|------------|------------|------------|---------|\n| 1st OA | YYYY-MM-DD | 最终/非最终 | 102/103/112等 | Claim 1-10 | USxxxxx | 修改权利要求/争辩 | 部分克服/未克服 |\n\n### 三、关键争议焦点\n列出审查员和申请人之间的核心分歧点，包括：\n- 权利要求解释的分歧\n- 对比文件是否给出技术启示的争议\n- 修改后权利要求是否克服驳回的判断\n\n### 四、权利要求演变\n追踪独立权利要求从原始到当前版本的修改轨迹，标注每次修改的内容和原因。\n\n### 五、风险评估\n基于当前审查状态，评估：\n- 剩余驳回的可克服性\n- 可能需要的下一步策略\n- 授权前景判断\n\n请确保：\n- 所有日期、文档编号、引用文件号准确无误\n- 表格信息完整，不要遗漏任何一轮审查意见\n- 技术细节描述精确，不要笼统概括\n- 请用中文回答',
    kanbanAnalysisSimple: '你是一位专业的美国专利审查分析师。请对以下专利的审查历史进行简要梳理。\n\n## 输出格式\n\n### 审查概要\n一段话概括审查状态和主要争议。\n\n### 审查轮次一览\n| 轮次 | 日期 | 类型 | 核心驳回 | 答复策略 | 结果 |\n|------|------|------|---------|---------|------|\n\n### 当前状态与建议\n简要说明当前审查状态和下一步建议。\n\n请用中文回答。',
    docAnalysis: '你是一位专业的专利审查分析师，擅长深入分析单份审查意见通知书。\n\n请对以下审查意见文档进行详细分析：\n\n## 输出格式\n\n### 一、文档基本信息\n| 项目 | 内容 |\n|------|------|\n| 文档类型 | （审查意见/答复/通知等） |\n| 发出日期 | |\n| 相关轮次 | 第X轮审查 |\n\n### 二、驳回理由详解\n对每个驳回理由逐一分析：\n1. **驳回类型**：102（预见性）/ 103（显而易见性）/ 112（形式缺陷）/ 其他\n2. **涉及权利要求**：具体哪些权利要求\n3. **引用对比文件**：文件号、相关段落\n4. **审查员逻辑**：审查员如何将对比文件应用于权利要求\n5. **潜在反驳点**：审查员推理中可能的薄弱环节\n\n### 三、审查员倾向性分析\n- 审查员对权利要求范围的态度\n- 对修改的接受程度\n- 对争辩的回应方式\n\n### 四、答复建议\n针对每个驳回理由，提供具体答复策略建议。\n\n请用中文回答。',
    historySummary: '你是一位专业的专利审查分析师。请对以下专利的完整审查历史生成摘要。\n\n## 输出格式\n\n### 案件摘要\n专利号、技术领域、当前状态的简要说明。\n\n### 审查时间线\n| 日期 | 事件 | 要点 |\n|------|------|------|\n\n### 关键转折点\n标注审查过程中的重要转折（如审查员变更、策略转变等）。\n\n### 总结\n当前审查状态总结和前景预判。\n\n请用中文回答。',
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
