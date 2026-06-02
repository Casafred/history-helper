var AI = (function () {
  var STORAGE_KEY = "history-helper-ai-config";

  function getDefaultBaseUrl(type) {
    switch (type) {
      case "openai": return "https://api.openai.com/v1";
      case "zhipu": return "https://open.bigmodel.cn/api/paas/v4";
      case "deepseek": return "https://api.deepseek.com/v1";
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

  function getCurrentProvider(config) {
    var keys = Object.keys(config);
    for (var i = 0; i < keys.length; i++) {
      var c = config[keys[i]];
      if (c && c.apiKey) return c;
    }
    return null;
  }

  function buildUrl(baseUrl) {
    return baseUrl.replace(/\/+$/, "");
  }

  async function* streamChat(providerType, apiKey, baseUrl, params, signal) {
    var url = buildUrl(baseUrl) + "/chat/completions";
    var body = {
      model: params.model,
      messages: params.messages,
      temperature: params.temperature || 0.1,
      max_tokens: params.maxTokens || 16384,
      stream: true,
    };

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
          var content = (parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content) || "";
          if (content) yield { content: content, done: false };
        } catch (e) { continue; }
      }
    }

    yield { content: "", done: true };
  }

  async function testConnection(providerType, apiKey, baseUrl, model) {
    var start = performance.now();
    try {
      var url = buildUrl(baseUrl) + "/chat/completions";
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
    streamChat: streamChat,
    testConnection: testConnection,
  };
})();
