/*!
 * PatentLens Agent - LLM Client
 * 支持OpenAI兼容的tools/function calling流式接口
 * 复用现有AI配置，但提供独立的带工具调用的流式生成
 */
var AgentLLM = (function () {

  function getProvider() {
    var config = AI.loadAIConfig();
    var provider = AI.getCurrentProvider(config);
    if (!provider) {
      throw new Error("未配置AI服务商，请先在AI设置中配置API Key");
    }
    if (!provider.apiKey) {
      throw new Error("当前AI服务商未设置API Key，请先在AI设置中配置");
    }
    var type = provider.type || config.currentProvider || "openai";
    var baseUrl = AI.buildUrl(type, provider.baseUrl || "");
    var model = provider.model || "";
    if (!model) {
      throw new Error("未配置AI模型，请先在AI设置中选择模型");
    }
    console.log("[AgentLLM] provider:", type, "model:", model, "baseUrl:", baseUrl);
    return {
      type: type,
      apiKey: provider.apiKey,
      baseUrl: baseUrl,
      model: model,
      temperature: 0.1,
    };
  }

  function buildMessages(systemPrompt, messages) {
    var msgs = [];
    if (systemPrompt) {
      msgs.push({ role: "system", content: systemPrompt });
    }
    for (var i = 0; i < messages.length; i++) {
      msgs.push(messages[i]);
    }
    return msgs;
  }

  function buildRequestBody(provider, systemPrompt, messages, tools, options, isStream) {
    var body = {
      model: (options && options.model) ? options.model : provider.model,
      messages: buildMessages(systemPrompt, messages),
      max_tokens: (options && options.maxTokens) ? options.maxTokens : 32768,
      stream: isStream,
      temperature: (options && options.temperature != null) ? options.temperature : provider.temperature,
    };

    // DeepSeek reasoner 模型不支持 temperature 参数
    if (provider.type === "deepseek" && body.model && body.model.indexOf("reasoner") !== -1) {
      delete body.temperature;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = (options && options.toolChoice) ? options.toolChoice : "auto";
    }

    return body;
  }

  async function* streamWithTools(systemPrompt, messages, tools, options, signal) {
    var provider = getProvider();
    var url = provider.baseUrl + "/chat/completions";
    var body = buildRequestBody(provider, systemPrompt, messages, tools, options, true);

    console.log("[AgentLLM] POST", url, "model:", body.model, "tools:", body.tools ? body.tools.length : 0);

    var response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + provider.apiKey,
        },
        body: JSON.stringify(body),
        signal: signal,
      });
    } catch (fetchErr) {
      console.error("[AgentLLM] fetch error:", fetchErr);
      throw new Error("无法连接AI服务: " + (fetchErr.message || fetchErr));
    }

    if (!response.ok) {
      var errorText = await response.text();
      console.error("[AgentLLM] API error", response.status, errorText);
      throw new Error("AI API 请求失败 (" + response.status + "): " + errorText.substring(0, 500));
    }

    var reader = response.body && response.body.getReader();
    if (!reader) throw new Error("无法读取响应流");

    var decoder = new TextDecoder();
    var buffer = "";

    var currentContent = "";
    var currentReasoning = "";
    var currentToolCalls = [];
    var toolCallArgsMap = {};

    while (true) {
      var result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      var lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (var i = 0; i < lines.length; i++) {
        var trimmed = lines[i].trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;
        var dataStr = trimmed.slice(5).trim();
        if (dataStr === "[DONE]") {
          var finalToolCalls = _finalizeToolCalls(currentToolCalls, toolCallArgsMap);
          yield {
            type: "done",
            content: currentContent,
            reasoningContent: currentReasoning,
            toolCalls: finalToolCalls.length > 0 ? finalToolCalls : null,
          };
          return;
        }
        try {
          var parsed = JSON.parse(dataStr);
          var delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
          if (!delta) continue;

          // reasoning_content (DeepSeek reasoner / 智谱 thinking)
          if (delta.reasoning_content) {
            currentReasoning += delta.reasoning_content;
            yield { type: "reasoning", content: delta.reasoning_content };
          }

          // content
          if (delta.content) {
            currentContent += delta.content;
            yield { type: "content", content: delta.content };
          }

          // tool_calls (OpenAI standard format)
          if (delta.tool_calls) {
            for (var j = 0; j < delta.tool_calls.length; j++) {
              var tc = delta.tool_calls[j];
              var idx = (tc.index != null) ? tc.index : 0;
              if (!currentToolCalls[idx]) {
                currentToolCalls[idx] = {
                  id: tc.id || ("call_" + Date.now() + "_" + idx),
                  type: "function",
                  function: { name: "", arguments: "" },
                };
                toolCallArgsMap[idx] = "";
              }
              if (tc.id) currentToolCalls[idx].id = tc.id;
              if (tc.function) {
                if (tc.function.name) {
                  currentToolCalls[idx].function.name += tc.function.name;
                }
                if (tc.function.arguments) {
                  toolCallArgsMap[idx] += tc.function.arguments;
                  currentToolCalls[idx].function.arguments = toolCallArgsMap[idx];
                }
              }
              yield {
                type: "tool_call_delta",
                index: idx,
                name: (tc.function && tc.function.name) ? tc.function.name : "",
                arguments: (tc.function && tc.function.arguments) ? tc.function.arguments : "",
              };
            }
          }
        } catch (e) { /* ignore malformed JSON line */ }
      }
    }

    // 流结束时如果没有收到 [DONE]，也要返回最终结果
    var finalToolCalls2 = _finalizeToolCalls(currentToolCalls, toolCallArgsMap);
    yield {
      type: "done",
      content: currentContent,
      reasoningContent: currentReasoning,
      toolCalls: finalToolCalls2.length > 0 ? finalToolCalls2 : null,
    };
  }

  function _finalizeToolCalls(currentToolCalls, toolCallArgsMap) {
    var result = [];
    for (var k = 0; k < currentToolCalls.length; k++) {
      if (currentToolCalls[k] && currentToolCalls[k].function && currentToolCalls[k].function.name) {
        var argsStr = toolCallArgsMap[k] || "{}";
        var parsedArgs = {};
        try { parsedArgs = JSON.parse(argsStr); } catch (_) { parsedArgs = { _raw: argsStr }; }
        result.push({
          id: currentToolCalls[k].id,
          name: currentToolCalls[k].function.name,
          arguments: parsedArgs,
        });
      }
    }
    return result;
  }

  async function callWithoutStream(systemPrompt, messages, options, signal) {
    var provider = getProvider();
    var url = provider.baseUrl + "/chat/completions";
    var body = buildRequestBody(provider, systemPrompt, messages, null, options, false);

    var response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + provider.apiKey,
      },
      body: JSON.stringify(body),
      signal: signal,
    });

    if (!response.ok) {
      var errorText = await response.text();
      throw new Error("AI API 请求失败 (" + response.status + "): " + errorText);
    }

    var data = await response.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
  }

  return {
    getProvider: getProvider,
    streamWithTools: streamWithTools,
    callWithoutStream: callWithoutStream,
  };
})();
