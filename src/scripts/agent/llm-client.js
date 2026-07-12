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
    var rawChunkCount = 0;
    var toolCallDeltaCount = 0;

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
          console.log("[AgentLLM] [DONE] finalized toolCalls:", finalToolCalls.length, "raw:", currentToolCalls.length);
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
          rawChunkCount++;
          var choice = parsed.choices && parsed.choices[0];
          var delta = choice && choice.delta;
          // 检查finish_reason
          if (choice && choice.finish_reason) {
            console.log("[AgentLLM] finish_reason:", choice.finish_reason, "contentLen:", currentContent.length, "toolCalls:", currentToolCalls.length);
          }
          if (!delta) {
            // 某些provider在finish_reason所在的chunk中没有delta，但可能有message
            if (choice && choice.message && choice.message.tool_calls) {
              console.log("[AgentLLM] found message.tool_calls (non-stream style):", choice.message.tool_calls.length);
              _mergeMessageToolCalls(currentToolCalls, toolCallArgsMap, choice.message.tool_calls);
            }
            continue;
          }

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

          // tool_calls - 兼容多种格式：
          // 1. OpenAI标准: {index, id, function: {name, arguments}}
          // 2. 部分provider: {index, id, name, arguments} (无function包装)
          // 3. 完整tool_calls在finish chunk中: message.tool_calls
          if (delta.tool_calls) {
            for (var j = 0; j < delta.tool_calls.length; j++) {
              var tc = delta.tool_calls[j];
              var idx = (tc.index != null) ? tc.index : j;

              // 详细记录每个tool_call delta用于调试（前10个）
              toolCallDeltaCount++;
              if (toolCallDeltaCount <= 10) {
                console.log("[AgentLLM] tool_call delta #" + toolCallDeltaCount + " idx=" + idx + ":", JSON.stringify(tc).substring(0, 400));
              }

              if (!currentToolCalls[idx]) {
                currentToolCalls[idx] = {
                  id: tc.id || ("call_" + Date.now() + "_" + idx),
                  type: "function",
                  function: { name: "", arguments: "" },
                };
                toolCallArgsMap[idx] = "";
              }
              if (tc.id) currentToolCalls[idx].id = tc.id;
              if (tc.type) currentToolCalls[idx].type = tc.type;

              // 格式1: function包装 (OpenAI标准)
              if (tc.function) {
                if (tc.function.name) {
                  currentToolCalls[idx].function.name += tc.function.name;
                }
                if (tc.function.arguments != null) {
                  toolCallArgsMap[idx] += tc.function.arguments;
                  currentToolCalls[idx].function.arguments = toolCallArgsMap[idx];
                }
              }

              // 格式2: 顶层name/arguments (部分provider兼容)
              if (tc.name) {
                currentToolCalls[idx].function.name += tc.name;
              }
              if (tc.arguments != null && typeof tc.arguments === "string") {
                toolCallArgsMap[idx] += tc.arguments;
                currentToolCalls[idx].function.arguments = toolCallArgsMap[idx];
              }

              yield {
                type: "tool_call_delta",
                index: idx,
                name: currentToolCalls[idx].function.name,
                arguments: toolCallArgsMap[idx],
              };
            }
          }

          // 某些provider在带finish_reason的chunk中同时给出完整message.tool_calls
          if (choice && choice.message && choice.message.tool_calls) {
            console.log("[AgentLLM] found message.tool_calls alongside delta:", choice.message.tool_calls.length);
            _mergeMessageToolCalls(currentToolCalls, toolCallArgsMap, choice.message.tool_calls);
          }
        } catch (e) { /* ignore malformed JSON line */ }
      }
    }

    // 流结束时如果没有收到 [DONE]，也要返回最终结果
    var finalToolCalls2 = _finalizeToolCalls(currentToolCalls, toolCallArgsMap);
    console.log("[AgentLLM] stream ended, finalized toolCalls:", finalToolCalls2.length, "raw:", currentToolCalls.length);
    yield {
      type: "done",
      content: currentContent,
      reasoningContent: currentReasoning,
      toolCalls: finalToolCalls2.length > 0 ? finalToolCalls2 : null,
    };
  }

  // 合并非流式style的message.tool_calls到累积数组
  function _mergeMessageToolCalls(currentToolCalls, toolCallArgsMap, messageToolCalls) {
    for (var n = 0; n < messageToolCalls.length; n++) {
      var mtc = messageToolCalls[n];
      var midx = (mtc.index != null) ? mtc.index : n;
      if (!currentToolCalls[midx]) {
        currentToolCalls[midx] = {
          id: mtc.id || ("call_" + Date.now() + "_" + midx),
          type: "function",
          function: { name: "", arguments: "" },
        };
        toolCallArgsMap[midx] = "";
      }
      if (mtc.id) currentToolCalls[midx].id = mtc.id;
      if (mtc.function) {
        if (mtc.function.name) currentToolCalls[midx].function.name = mtc.function.name;
        if (mtc.function.arguments != null) {
          toolCallArgsMap[midx] = mtc.function.arguments;
          currentToolCalls[midx].function.arguments = mtc.function.arguments;
        }
      }
      if (mtc.name) currentToolCalls[midx].function.name = mtc.name;
      if (mtc.arguments != null && typeof mtc.arguments === "string") {
        toolCallArgsMap[midx] = mtc.arguments;
        currentToolCalls[midx].function.arguments = mtc.arguments;
      }
    }
  }

  function _finalizeToolCalls(currentToolCalls, toolCallArgsMap) {
    var result = [];
    for (var k = 0; k < currentToolCalls.length; k++) {
      var tc = currentToolCalls[k];
      if (!tc) continue;
      var name = (tc.function && tc.function.name) ? tc.function.name : "";
      var argsStr = toolCallArgsMap[k] || "";

      if (!name) {
        console.warn("[AgentLLM] tool_call[" + k + "] has empty name, args:", argsStr.substring(0, 200));
        // 即使name为空也保留，可能后续能从上下文恢复
        // 但如果arguments也为空，则确实无效，跳过
        if (!argsStr) continue;
        name = "unknown";
      }

      var parsedArgs = {};
      if (argsStr) {
        try { parsedArgs = JSON.parse(argsStr); } catch (_) { parsedArgs = { _raw: argsStr }; }
      }
      result.push({
        id: tc.id,
        name: name,
        arguments: parsedArgs,
      });
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
