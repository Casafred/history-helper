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
      case "deepseek": return "deepseek-v4-flash";
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
    kanbanAnalysis: '你是一位面向**竞争对手方**的专利侵权分析顾问。请根据以下从 Global Dossier 获取的审查意见（Office Action）和申请人答复（Response）的实际内容，整理出一份结构化的审查历史分析报告，帮助竞争对手方评估该专利的授权稳定性、权利要求范围和规避设计空间。\n\n## 关键规则\n\n1. **必须首先阅读审查时间线概要**：用户消息开头包含"审查时间线概要"，列出了所有审查文档的日期、类型和当前阶段。你必须根据时间线概要判断专利的当前状态（如已授权、审查中等），并在分析中准确反映。如果时间线显示专利已授权，不得在分析中说"正在等待下一次答复"或类似表述；如果时间线显示当前待答复，也不得错误地说已授权。\n\n2. **必须逐句引用来源**：你的**每一句话、每一个结论**都必须标注来源，使用 【来源: block_id1, block_id2】 格式。这是最重要的规则，没有来源标注的内容不可信。\n   - 每一句话的末尾都要用 【来源: D0_B_p1_0, D1_B_p2_3】 标注该句分析依据的原文块\n   - **所有表格中每个单元格的每个要点都必须标注【来源: ...】**，不要因为表格格式而省略来源\n   - block_id 格式为 D{文档序号}_B_p{页码}_{块序号}，如 D0_B_p1_0、D1_B_p3_5，其中D后面的数字对应文档序号\n   - 可以且应该引用多个来源块，特别是跨文档引用时（如对比审查意见和答复）\n   - **严禁张冠李戴**：D0_开头的来源只能来自文档0，D1_开头的只能来自文档1，以此类推\n   - 总结性语句也必须标注来源，不能因为是总结就省略\n\n3. **核心分析视角——审查员与申请人的辩驳对话**：\n   审查历史本质上是审查员与申请人之间的"对话"过程。你必须以**辩驳对话**的视角梳理，而非简单罗列文档。每一轮审查中：\n   - 审查员提出了哪些**具体驳回理由**（引用了哪条法条、哪篇对比文献、针对哪个权利要求、核心论点是什么）\n   - 申请人**如何反驳**（是争辩不认同、还是修改权利要求规避、还是两者结合）\n   - 申请人的反驳**是否有效**（审查员后续是否接受、是否再次驳回同一理由）\n   - 这轮辩驳对**权利要求范围**产生了什么影响（缩小了什么、引入了什么限制）\n\n4. **报告结构**（使用 Markdown 格式）：\n\n   ### 一、案件概要\n   专利号、申请号、申请人、当前阶段、对侵权方的影响概述。\n\n   ### 二、审查对话时间线\n   按时间**正序**列出每一轮审查对话，体现审查员与申请人的来回沟通：\n   | 轮次 | 日期 | 发文方 | 文档类型 | 核心要点 | 对侵权方的意义 |\n   每个单元格都要标注来源。\n\n   ### 三、争议焦点辩驳详表（核心部分）\n   按**争议焦点**（而非按文档）组织，梳理审查员与申请人在每个争议点上的辩驳来回。每个争议焦点包含：\n   - **争议焦点**：如"权利要求1相对于D1的创造性"、"101条款适格性"、"112条款清楚性"等\n   - **审查员论点**：审查员提出的具体驳回理由、引用的对比文献编号、法条、核心逻辑【来源: 审查意见的block_id】\n   - **申请人反驳**：申请人的争辩策略（争辩/修改/两者）、反驳的核心论点【来源: 答复的block_id】\n   - **权利要求修改**：为应对此争议，申请人是否修改了权利要求、修改了什么【来源: 答复的block_id】\n   - **辩驳有效性评估**：该反驳是否成功（后续审查员是否接受/再次驳回）、对侵权方的启示\n   建议用表格或分点形式，每个争议焦点单独成段，**跨文档引用来源**（同时引用审查意见和答复的block_id）。\n\n   ### 四、权利要求范围演变与联动对照表（核心部分）\n   将权利要求的修改与审查意见、申请人答复**联动对照**，而非孤立列出修改：\n   | 轮次 | 审查员意见要点 | 申请人答复策略 | 权利要求修改内容 | 范围变化 | 对规避设计的影响 | 禁反言风险 |\n   - **审查员意见要点**：该轮审查员对权利要求的主要意见【来源: 审查意见block_id】\n   - **申请人答复策略**：申请人是争辩、修改还是结合【来源: 答复block_id】\n   - **权利要求修改内容**：具体修改了哪些权利要求、增加了什么限定【来源: 答复block_id】\n   - **范围变化**：明显缩小/适度缩小/基本不变/扩大，并说明缩小了什么\n   - **对规避设计的影响**：修改后竞争对手方规避空间变大还是变小\n   - **禁反言风险**：申请人的修改或陈述是否构成档案历史禁反言，限制了未来权利要求解释\n   每个单元格都必须标注来源，**同一行应同时引用审查意见和答复的block_id**，体现联动。\n\n   ### 五、关键无效机会\n   基于上述辩驳梳理，总结竞争对手方可利用的无效理由：\n   - 审查员引用但未完全采纳的对比文献\n   - 申请人修改后可能仍存在的缺陷\n   - 审查过程中暴露的权利要求弱点\n\n   ### 六、授权前景与风险评级\n   授权可能性：高/中/低 | 权利要求范围：宽/中/窄 | 规避难度：高/中/低，并说明判断依据（需标注来源）。\n\n   ### 七、监控建议\n   建议竞争对手方关注的审查进展和关键节点。\n\n5. **注意事项**：\n   - 不要编造文档中没有的内容\n   - 如果某段分析综合了多个来源，全部列出\n   - 保持来源标注的准确性，不要张冠李戴\n   - **每一句话都必须有来源标注，无来源的内容不可信**\n   - 始终站在竞争对手方立场，关注：权利要求范围是否可被缩小、审查员引用的文献是否可用于无效、申请人的修改是否引入了禁反言\n   - 分析中可能包含权利要求书（CLM）和说明书（SPEC）作为参考上下文，请结合这些文件理解审查意见和答复的针对性修改\n   - **权利要求范围演变必须与审查意见和答复联动对照**，不能孤立地只列修改内容\n   - 请用中文回答',
    kanbanAnalysisSimple: '你是一位面向**竞争对手方**的专利侵权分析顾问。请根据以下审查意见和答复内容，整理出一份简明的审查历史分析报告。\n\n**必须首先阅读审查时间线概要**：用户消息开头包含"审查时间线概要"，列出了所有审查文档的日期、类型和当前阶段。你必须根据时间线概要判断专利的当前状态（如已授权、审查中等），并在分析中准确反映。如果时间线显示专利已授权，不得在分析中说"正在等待下一次答复"或类似表述。\n\n## 报告结构（Markdown 格式）：\n\n### 一、审查概要\n专利号、申请人、当前阶段。\n\n### 二、审查对话时间线\n按时间正序列出每轮审查对话（审查员意见 ↔ 申请人答复），体现来回沟通：\n| 轮次 | 日期 | 发文方 | 核心要点 | 对侵权方的影响 |\n\n### 三、争议焦点与权利要求联动速览\n将争议焦点与权利要求修改联动对照：\n| 争议焦点 | 审查员论点 | 申请人反驳策略 | 权利要求修改 | 范围变化 | 规避影响 |\n每个单元格都必须标注【来源: block_id】，**同一行应同时引用审查意见和答复的block_id**。\n\n### 四、风险速评\n授权可能性：高/中/低 | 权利要求范围：宽/中/窄 | 规避难度：高/中/低，并说明判断依据（需标注来源）。\n\n### 五、监控建议\n建议关注的审查进展。\n\n**关键规则**：\n- **每一句话都必须标注来源**，使用 【来源: D{文档序号}_B_p{页码}_{块序号}】 格式\n- block_id 格式为 D{文档序号}_B_p{页码}_{块序号}，如 D0_B_p1_0、D1_B_p3_5\n- 可以引用多个来源，特别是跨文档对比时\n- **严禁张冠李戴**：D0_开头的来源只能来自文档0，D1_开头的只能来自文档1\n- **权利要求修改必须与审查员意见、申请人答复联动对照**，不能孤立列出\n- 始终站在竞争对手方立场，关注权利要求范围、无效机会和规避空间。请用中文回答。',
    docAnalysis: '你是一位面向**竞争对手方**的专利侵权分析顾问。请对以下专利审查文档内容进行详细分析，帮助竞争对手方评估该文档对侵权风险和规避策略的影响。\n\n## 关键规则\n\n1. **必须逐句引用来源**：你的**每一句话、每一个结论**都必须标注来源，使用 【来源: block_id1, block_id2】 格式。\n   - block_id 格式为 D{文档序号}_B_p{页码}_{块序号}，如 D0_B_p1_0、D0_B_p3_5\n   - 在总结的每一段末尾标注该段分析依据的原文块\n   - **每一句话都必须有来源标注**\n\n2. **报告结构**（Markdown 格式）：\n   - **文档基本信息**（文档类型、日期、发文方）\n   - **审查员论点详解**（如果是审查意见：审查员引用的对比文献、法条、针对的权利要求、核心论点逻辑；如果是答复：申请人对哪些论点进行了反驳）\n   - **争议焦点梳理**：按争议点组织，列出审查员的具体论点 → 申请人的反驳策略 → 权利要求是否因此修改\n   - **申请人陈述与档案历史禁反言**（申请人的争辩和修改，可能构成禁反言限制权利要求解释的要点）\n   - **权利要求修改分析**（修改了哪些权利要求、缩小了什么范围、修改是否针对审查员的具体意见、对规避设计的影响）\n   - **审查员倾向性**（审查员是否容易说服、对特定论点的偏好、是否在后续审查中重复提出同一理由）\n   - **侵权方行动建议**（基于此文档，竞争对手方应采取的策略）\n\n3. **注意事项**：\n   - 不要编造文档中没有的内容\n   - 始终站在竞争对手方立场\n   - **如果是答复文档，必须梳理申请人对审查员哪些具体论点进行了反驳，以及反驳策略**\n   - **如果是审查意见，必须梳理审查员针对哪些权利要求、引用了哪些文献、依据什么法条**\n   - 请用中文回答',
    historySummary: '你是一位面向**竞争对手方**的专利侵权分析顾问。请根据以下专利数据，对审查历史进行梳理分析，帮助竞争对手方快速了解该专利的审查全貌和风险点。\n\n## 报告结构（Markdown 格式）：\n1. **案件摘要**（专利号、申请人、技术领域、当前状态）\n2. **审查对话时间线**（按时间正序列出审查员与申请人的来回沟通：申请、实审请求、每轮OA/答复、授权/驳回，及每个节点对侵权方的意义）\n3. **关键转折点**（审查中的重大变化：权利要求大幅修改、审查员更换立场、引入关键对比文献、辩驳策略转变等）\n4. **风险总结与监控建议**（授权稳定性评估、权利要求范围判断、建议监控的同族申请）\n\n**注意**：始终站在竞争对手方立场，关注无效机会和规避空间。请用中文回答。',
    citedRefsAnalysis: '请对以上引用文献相关文档进行分析，包括：\n1. 审查员引用了哪些文献？列出每篇引用文献的编号、类型和相关性说明\n2. 申请人引用了哪些文献？与审查员引用有何异同\n3. 引用文献的技术领域分布，是否涉及竞争对手专利\n4. 引用文献对本专利权利要求的影响评估\n5. 建议关注的引用文献和潜在风险\n\n**注意**：每一句话和结论都必须标注来源，使用 【来源: block_id】 格式。请用中文回答。',
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
