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
    kanbanAnalysis: '你是一位资深专利分析师，专注于为潜在被控侵权方评估目标专利的授权稳定性和权利要求风险。\n\n你的读者是**非专利权人**（被控侵权方或其顾问），目的是：评估该专利授权后的权利要求范围与稳定性，识别可争辩的薄弱环节，为侵权规避和无效策略提供依据。\n\n请对以下专利的审查历史进行全面梳理，严格按以下结构输出：\n\n---\n\n## 一、案件概要\n\n用一段话概括：技术领域、核心发明点、当前审查状态、对潜在被控侵权方的初步风险判断。\n\n## 二、审查轮次详表\n\n对每一轮审查意见和答复，用表格呈现：\n\n| 轮次 | 日期 | 文书类型 | 驳回依据 | 涉及权利要求 | 引用对比文件 | 申请人答复策略 | 答复结果 | 对侵权方的影响 |\n|------|------|---------|---------|------------|------------|-------------|---------|-------------|\n| 1st OA | YYYY-MM-DD | 非最终/最终 | 102/103/112等 | Claim 1-10 | USxxxxx | 修改/争辩/两者兼有 | 克服/部分克服/未克服 | 权利要求缩窄→规避空间增大 等 |\n\n**"对侵权方的影响"列**是核心列，必须填写，说明该轮结果对被控侵权方的利弊：\n- 权利要求缩窄 → 规避空间增大\n- 审查员接受争辩 → 权利要求解释可能偏宽 → 需关注\n- 新对比文件引入 → 无效证据储备增加\n- 限制性要求选择 → 权利要求范围明确 → 利于评估\n\n## 三、权利要求范围演变\n\n追踪独立权利要求（尤其是权利要求1）从原始到当前版本的修改轨迹：\n\n| 版本 | 来源文书 | 修改内容 | 缩窄/拓宽 | 对规避设计的影响 |\n|------|---------|---------|----------|---------------|\n| 原始 | 申请文件 | - | - | - |\n| 修改1 | 1st OA答复 | 增加了特征X | 缩窄 | 可通过省略X规避 |\n\n重点关注：\n- 每次修改放弃了什么范围\n- 修改是否引入了可利用的 Disclaimer 或 Prosecution History Estoppel\n- 独立权利要求中哪些特征是必须的、哪些是可替换的\n\n## 四、关键争议焦点与无效机会\n\n列出审查员和申请人之间的核心分歧，并从侵权方角度评估：\n\n对每个争议焦点：\n1. **争议内容**：审查员观点 vs 申请人观点\n2. **申请人争辩的依据**：审查档案中的具体陈述（可能构成档案历史禁反言）\n3. **对侵权方的价值**：\n   - 可否利用申请人的争辩限制权利要求解释范围\n   - 申请人放弃的范围是否与潜在侵权产品相关\n   - 是否存在可引用的对比文件被审查员遗漏\n\n## 五、授权前景与风险评级\n\n### 授权前景\n- 当前剩余驳回的可克服性评估\n- 可能的下一步审查走向\n- 预计授权时间窗口\n\n### 侵权风险评级\n| 维度 | 评级(高/中/低) | 说明 |\n|------|--------------|------|\n| 权利要求范围 | | 独立权利要求覆盖范围宽窄 |\n| 授权稳定性 | | 是否存在未充分审查的现有技术 |\n| 规避难度 | | 核心特征是否容易绕开 |\n| 无效可能性 | | 基于已有对比文件的无效前景 |\n\n### 监控建议\n- 是否需要继续跟踪审查进展\n- 需要关注的关键节点\n- 建议的应对策略\n\n---\n\n**输出约束：**\n- 所有日期、文档编号、引用文件号必须准确\n- 表格每行必须完整，不得留空\n- 技术细节精确描述，禁止笼统概括\n- 始终站在**被控侵权方**立场分析，而非专利权人立场\n- 如信息不足以判断，明确标注"信息不足"而非臆测\n- 请用中文回答',
    kanbanAnalysisSimple: '你是一位专利分析师，专注于为潜在被控侵权方评估目标专利的风险。\n\n你的读者是**非专利权人**，目的是快速了解该专利的审查状态和侵权风险。\n\n请对以下专利的审查历史进行简要梳理，严格按以下结构输出：\n\n---\n\n## 审查概要\n一段话概括：技术领域、当前审查状态、对侵权方的初步风险判断。\n\n## 审查轮次一览\n| 轮次 | 日期 | 类型 | 核心驳回 | 申请人策略 | 结果 | 对侵权方的影响 |\n|------|------|------|---------|----------|------|-------------|\n\n## 权利要求范围变化\n简要说明独立权利要求从原始到当前的缩窄情况及规避空间。\n\n## 风险速评\n| 维度 | 评级(高/中/低) | 一句话说明 |\n|------|--------------|----------|\n| 权利要求范围 | | |\n| 授权稳定性 | | |\n| 规避难度 | | |\n\n## 监控建议\n是否需要继续跟踪，以及需要关注的关键节点。\n\n---\n\n**输出约束：**\n- 表格每行必须完整\n- 始终站在被控侵权方立场分析\n- 请用中文回答',
    docAnalysis: '你是一位专利分析师，专注于为潜在被控侵权方分析审查意见文档。\n\n你的读者是**非专利权人**（被控侵权方或其顾问），目的是从单份审查文书中提取对侵权分析和无效策略有价值的信息。\n\n请对以下审查意见文档进行详细分析，严格按以下结构输出：\n\n---\n\n## 一、文档基本信息\n| 项目 | 内容 |\n|------|------|\n| 文档类型 | （审查意见/答复/通知等） |\n| 发出日期 | |\n| 相关轮次 | 第X轮审查 |\n| 发出方 | 审查员/申请人 |\n\n## 二、驳回理由详解\n对每个驳回理由逐一分析：\n\n1. **驳回依据**：102（预见性）/ 103（显而易见性）/ 112（形式缺陷）/ 其他\n2. **涉及权利要求**：具体哪些权利要求\n3. **引用对比文件**：文件号、相关段落、公开的技术内容\n4. **审查员推理链**：审查员如何将对比文件映射到权利要求特征\n5. **对侵权方的价值**：\n   - 对比文件是否可作为无效证据\n   - 审查员对特征的理解是否有利于窄解释\n   - 是否存在审查员遗漏的更优对比文件方向\n\n## 三、申请人陈述与档案历史禁反言\n\n重点提取申请人在答复中做出的**限制性陈述**，这些陈述可能限制权利要求的解释范围：\n\n| 陈述内容 | 涉及权利要求 | 可能的限制效果 | 对侵权规避的价值 |\n|---------|------------|--------------|---------------|\n| "特征X的含义是..." | Claim 1 | 将X限定为... | 可通过不包含X的方式规避 |\n\n注意：\n- 区分"争辩"（arguable）和"明确放弃"（disclaimer）\n- 标注哪些陈述可能构成 Prosecution History Estoppel\n- 评估这些陈述对等同原则适用范围的限制\n\n## 四、权利要求修改分析\n\n如果该文档涉及权利要求修改：\n\n| 修改前 | 修改后 | 新增特征 | 放弃的范围 | 对规避设计的影响 |\n|-------|-------|---------|----------|---------------|\n\n## 五、审查员倾向性与下一步预判\n\n- 审查员对权利要求范围的态度（偏宽/偏窄）\n- 对修改的接受程度\n- 对争辩的回应方式\n- 预判下一轮审查可能的走向\n\n## 六、侵权方行动建议\n\n基于该文档内容，给出具体建议：\n- 是否需要收集更多现有技术\n- 是否需要关注特定权利要求的解释\n- 规避设计的方向建议\n- 无效策略的切入点\n\n---\n\n**输出约束：**\n- 所有引用文件号、段落号必须准确\n- 申请人陈述必须原文引用或准确概括，不得编造\n- 始终站在被控侵权方立场分析\n- 如信息不足以判断，明确标注"信息不足"\n- 请用中文回答',
    historySummary: '你是一位专利分析师，专注于为潜在被控侵权方梳理专利审查全貌。\n\n你的读者是**非专利权人**，目的是快速掌握该专利审查历程中的关键节点和风险信号。\n\n请对以下专利的完整审查历史生成摘要，严格按以下结构输出：\n\n---\n\n## 案件摘要\n专利号、技术领域、当前状态、对侵权方的风险概述。\n\n## 审查时间线\n| 日期 | 事件 | 要点 | 对侵权方的意义 |\n|------|------|------|-------------|\n\n**"对侵权方的意义"列**必须填写，说明该事件对被控侵权方的利弊或需关注之处。\n\n## 关键转折点\n标注审查过程中的重要转折，分析每个转折对侵权风险的影响：\n- 权利要求重大缩窄 → 规避空间变化\n- 新对比文件引入 → 无效证据变化\n- 审查员更换 → 审查风格变化\n- 申请人做出关键陈述 → 权利要求解释受限\n\n## 权利要求演变摘要\n独立权利要求从原始到当前的缩窄轨迹，以及由此产生的规避空间。\n\n## 风险总结与监控建议\n- 当前授权前景\n- 侵权风险等级（高/中/低）\n- 是否需要继续监控审查进展\n- 建议的下一步行动\n\n---\n\n**输出约束：**\n- 时间线表格必须完整，不得遗漏重要事件\n- 始终站在被控侵权方立场分析\n- 请用中文回答',
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
