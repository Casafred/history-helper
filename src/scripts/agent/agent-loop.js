/*!
 * PatentLens Agent - Core Agent Loop
 * 核心ReAct编排器：负责LLM→工具调用→结果回传→循环直到完成
 */
var AgentCore = (function () {
  var BUS = AgentEventBus;
  var EVT = BUS.EVENTS;

  var MAX_ITERATIONS = 25;
  var LLM_TIMEOUT_MS = 120000; // 单次LLM调用超时：2分钟
  var currentAbortController = null;
  var isRunning = false;
  var memory = [];
  var systemPrompt = "";
  var sessionContext = {};

  var DEFAULT_SYSTEM_PROMPT = [
    "你是PatentLens智能专利助手，运行在Electron桌面应用中。",
    "你可以帮助用户自动查询和展示专利审查信息。",
    "",
    "## 工作方式",
    "你是ReAct Agent，通过「思考→调用工具→观察结果→继续思考」的循环来完成任务。",
    "任务拆解由你自主完成——根据用户需求自行规划步骤，使用update_todos记录你的计划。",
    "",
    "## 可用工具",
    "1. fetch_patent(patent_number) — 查询专利审查信息，自动展示在界面上。返回：专利号、标题、申请人、专利局、文档数、同族数等摘要",
    "2. get_patent_basic_info() — 获取当前已查询专利的基本信息（需先fetch_patent）",
    "3. get_documents_summary() — 获取审查文档列表摘要（需先fetch_patent）",
    "4. get_family_summary() — 获取同族专利信息摘要（需先fetch_patent）",
    "5. switch_to_tab(tab) — 切换界面标签页。tab可选：overview(概览)、family(同族)、kanban(审查看板)、ai-analysis(AI分析)",
    "6. update_todos(todos) — 更新任务进度列表，让用户看到你的计划。每个todo含id/content/status(pending/in_progress/completed)",
    "7. think(thought) — 记录你的思考过程，让用户了解你的意图",
    "8. finish(summary) — 任务完成时调用，给出最终总结",
    "9. ask_user(question, options) — 信息不足时向用户提问",
    "",
    "## 工作原则",
    "1. 收到用户消息后，先用think分析需求，再用update_todos制定计划（不要用固定模板，根据实际需求拆解）",
    "2. 用户提供专利号时，直接调用fetch_patent，不需要先确认",
    "3. 不要凭空猜测数据，必须通过工具获取真实信息",
    "4. 工具返回结果后，整理成清晰的自然语言回答用户",
    "5. 每完成一个步骤，更新对应todo的状态",
    "6. 所有步骤完成后，调用finish给出总结",
    "",
    "## 回答风格",
    "- 用中文回答",
    "- 专业但易懂，结构化呈现",
    "- 不要重复工具返回的原始JSON，提炼成用户能看懂的内容",
  ].join("\n");

  function setSystemPrompt(prompt) {
    systemPrompt = prompt || DEFAULT_SYSTEM_PROMPT;
  }

  function reset() {
    memory = [];
    sessionContext = {};
    isRunning = false;
    if (currentAbortController) {
      try { currentAbortController.abort(); } catch (e) {}
      currentAbortController = null;
    }
  }

  function abort() {
    if (currentAbortController) {
      currentAbortController.abort();
    }
    isRunning = false;
    BUS.emit(EVT.SESSION_ABORTED, {});
  }

  function isActive() {
    return isRunning;
  }

  function getMemory() {
    return memory.slice();
  }

  function getContext() {
    return Object.assign({}, sessionContext);
  }

  function updateContext(patch) {
    Object.assign(sessionContext, patch || {});
  }

  async function run(userMessage, options) {
    if (isRunning) {
      throw new Error("Agent is already running");
    }

    isRunning = true;
    currentAbortController = new AbortController();
    var signal = currentAbortController.signal;
    memory = [{ role: "user", content: userMessage }];
    sessionContext = { startTime: Date.now(), userMessage: userMessage };

    // 不再使用固定todo模板，让AI自己规划
    BUS.emit(EVT.SESSION_STARTED, { message: userMessage });

    var tools = AgentTools.getSchemas();
    console.log("[AgentCore] tools registered:", tools.length, "tool names:", tools.map(function(t){return t.function.name;}));

    try {
      var iteration = 0;
      var finalAnswer = "";

      while (iteration < MAX_ITERATIONS) {
        iteration++;
        if (signal.aborted) break;

        console.log("[AgentCore] iteration", iteration);

        var assistantMsg = { role: "assistant", content: "", tool_calls: [] };
        var reasoningBuf = "";
        var contentBuf = "";
        var gotToolCall = false;

        BUS.emit(EVT.ASSISTANT_START, {});
        var thinkStarted = false;

        // 超时保护
        var timeoutId = setTimeout(function() {
          if (currentAbortController) {
            console.warn("[AgentCore] LLM timeout, aborting...");
            try { currentAbortController.abort(); } catch(e) {}
          }
        }, LLM_TIMEOUT_MS);

        var streamGen;
        try {
          streamGen = AgentLLM.streamWithTools(
            systemPrompt,
            memory,
            tools,
            options || {},
            signal
          );
        } catch (llmErr) {
          clearTimeout(timeoutId);
          throw llmErr;
        }

        var streamResult;
        try {
          streamResult = await streamGen.next();
        } catch (streamErr) {
          clearTimeout(timeoutId);
          if (streamErr.name === "AbortError") {
            throw new Error("AI响应超时（" + (LLM_TIMEOUT_MS/1000) + "秒），请检查网络或API配置");
          }
          throw streamErr;
        }

        while (!streamResult.done) {
          var chunk = streamResult.value;

          if (chunk.type === "reasoning") {
            if (!thinkStarted) {
              BUS.emit(EVT.THINK_START, {});
              thinkStarted = true;
            }
            reasoningBuf += chunk.content;
            BUS.emit(EVT.THINK_CHUNK, { content: chunk.content });
          } else if (chunk.type === "content") {
            contentBuf += chunk.content;
            BUS.emit(EVT.ASSISTANT_CHUNK, { content: chunk.content });
          } else if (chunk.type === "tool_call_delta") {
            gotToolCall = true;
          }

          try {
            streamResult = await streamGen.next();
          } catch (streamErr2) {
            clearTimeout(timeoutId);
            if (streamErr2.name === "AbortError") {
              throw new Error("AI流式响应被中断");
            }
            throw streamErr2;
          }
        }

        clearTimeout(timeoutId);

        var finalChunk = streamResult.value || {};

        if (thinkStarted) {
          BUS.emit(EVT.THINK_END, { content: reasoningBuf });
        }

        var finalContent = finalChunk.content || contentBuf;
        var finalToolCalls = finalChunk.toolCalls || [];

        console.log("[AgentCore] iteration", iteration, "done. contentLen:", (finalContent||"").length, "toolCalls:", finalToolCalls ? finalToolCalls.length : 0);

        // 如果AI没有返回内容也没有工具调用，说明出问题了
        if (!finalContent && (!finalToolCalls || finalToolCalls.length === 0)) {
          console.warn("[AgentCore] Empty response from LLM, ending session");
          BUS.emit(EVT.ASSISTANT_END, { content: "" });
          finalAnswer = "（AI未返回有效内容，请检查API配置或重试）";
          break;
        }

        // 如果没有工具调用但有内容，视为最终回答
        if ((!gotToolCall && finalToolCalls.length === 0) && finalContent) {
          BUS.emit(EVT.ASSISTANT_END, { content: finalContent });
          assistantMsg.content = finalContent;
          memory.push(assistantMsg);
          finalAnswer = finalContent;
          break;
        }

        if (finalContent) {
          assistantMsg.content = finalContent;
          BUS.emit(EVT.ASSISTANT_END, { content: finalContent });
        } else {
          BUS.emit(EVT.ASSISTANT_END, { content: "" });
        }

        if (finalToolCalls.length === 0) {
          finalAnswer = finalContent || "";
          break;
        }

        // 保存assistant消息（含tool_calls）到memory
        assistantMsg.tool_calls = finalToolCalls.map(function (tc) {
          return {
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          };
        });
        memory.push(assistantMsg);

        // 执行工具调用
        for (var ti = 0; ti < finalToolCalls.length; ti++) {
          var tc = finalToolCalls[ti];
          console.log("[AgentCore] executing tool:", tc.name, "args:", JSON.stringify(tc.arguments).substring(0, 200));
          BUS.emit(EVT.TOOL_CALL_START, { name: tc.name, arguments: tc.arguments, id: tc.id });

          var toolResult;
          try {
            toolResult = await AgentTools.execute(tc.name, tc.arguments, sessionContext);
          } catch (toolErr) {
            console.error("[AgentCore] tool error:", tc.name, toolErr);
            toolResult = { error: toolErr.message || String(toolErr) };
          }

          console.log("[AgentCore] tool result:", tc.name, JSON.stringify(toolResult).substring(0, 200));
          BUS.emit(EVT.TOOL_CALL_END, { name: tc.name, result: toolResult, id: tc.id });

          var resultStr = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult, null, 2);
          memory.push({
            role: "tool",
            tool_call_id: tc.id,
            name: tc.name,
            content: resultStr,
          });
        }

        // 如果调用了finish工具，结束循环
        var hasFinishTool = finalToolCalls.some(function (tc) { return tc.name === "finish"; });
        if (hasFinishTool) {
          // 从finish工具的参数中提取summary作为最终回答
          for (var fi = 0; fi < finalToolCalls.length; fi++) {
            if (finalToolCalls[fi].name === "finish" && finalToolCalls[fi].arguments && finalToolCalls[fi].arguments.summary) {
              finalAnswer = finalToolCalls[fi].arguments.summary;
            }
          }
          break;
        }
      }

      if (iteration >= MAX_ITERATIONS) {
        console.warn("[AgentCore] reached max iterations", MAX_ITERATIONS);
        if (!finalAnswer) {
          finalAnswer = "（已达到最大迭代次数限制，任务可能未完全完成）";
        }
      }

      BUS.emit(EVT.SESSION_FINISHED, { answer: finalAnswer, context: sessionContext });
      isRunning = false;
      return { answer: finalAnswer, context: sessionContext };
    } catch (err) {
      isRunning = false;
      console.error("[AgentCore] error:", err);
      BUS.emit(EVT.SESSION_ERROR, { error: err.message || String(err) });
      throw err;
    } finally {
      currentAbortController = null;
    }
  }

  function updateTodos(todos) {
    sessionContext.todos = todos;
    BUS.emit(EVT.TODOS_UPDATED, { todos: todos });
  }

  return {
    run: run,
    abort: abort,
    reset: reset,
    isActive: isActive,
    getMemory: getMemory,
    getContext: getContext,
    updateContext: updateContext,
    setSystemPrompt: setSystemPrompt,
    updateTodos: updateTodos,
    DEFAULT_SYSTEM_PROMPT: DEFAULT_SYSTEM_PROMPT,
  };
})();
