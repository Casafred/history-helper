/*!
 * PatentLens Agent - Core Agent Loop
 * 核心ReAct编排器：负责LLM→工具调用→结果回传→循环直到完成
 */
var AgentCore = (function () {
  var BUS = AgentEventBus;
  var EVT = BUS.EVENTS;

  var MAX_ITERATIONS = 25;
  var currentAbortController = null;
  var isRunning = false;
  var memory = [];
  var systemPrompt = "";
  var sessionContext = {};

  var DEFAULT_SYSTEM_PROMPT = '你是PatentLens智能专利助手，可以帮助用户自动查询和展示专利信息。\n\n## 核心规则\n\n1. **直接使用fetch_patent**：用户给出专利号时，直接调用fetch_patent工具，不需要先调用detect_patent_office或convert_patent_number——fetch_patent内部会自动处理专利号识别、格式转换、数据获取和UI展示。\n\n2. **工具使用原则**：\n   - 不要凭空猜测专利信息，必须调用工具获取真实数据\n   - 一次可以并行调用多个工具（如同时获取摘要和权利要求）\n   - 调用工具获得结果后，将数据整理成清晰的自然语言回答用户\n   - 每完成一个步骤，用update_todos更新任务进度\n   - 重要决策前可以用think说明你的思路\n\n3. **可用工具说明**：\n   - fetch_patent(专利号): 查询专利并展示在界面上，返回基本信息摘要\n   - fetch_family(): 查看同族专利（需先fetch_patent）\n   - fetch_documents(): 查看审查文档列表（需先fetch_patent）\n   - get_abstract()/get_claims()/get_description(): 获取摘要/权利要求/说明书全文\n   - switch_to_tab(tab): 切换标签页(overview/family/documents/ai-summary)\n   - update_todos(): 更新任务进度\n   - think(): 记录思考过程\n   - finish(): 标记任务完成\n   - ask_user(): 向用户提问（信息不足时使用）\n\n4. **回答风格**：\n   - 用中文回答\n   - 专业但易懂，结构化呈现信息\n   - 不要重复工具返回的原始JSON，要提炼成用户能看懂的内容\n   - 数据要准确，基于工具返回的结果\n\n现在开始帮助用户。';

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

  function _buildInitialTodos(userMessage) {
    return [
      { id: "t1", content: "理解用户需求", status: "in_progress" },
      { id: "t2", content: "查询专利数据", status: "pending" },
      { id: "t3", content: "获取所需详细信息", status: "pending" },
      { id: "t4", content: "整理结果回答用户", status: "pending" },
    ];
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

    var initialTodos = _buildInitialTodos(userMessage);
    BUS.emit(EVT.TODOS_UPDATED, { todos: initialTodos });
    sessionContext.todos = initialTodos;

    BUS.emit(EVT.SESSION_STARTED, { message: userMessage });

    var tools = AgentTools.getSchemas();

    try {
      var iteration = 0;
      var finalAnswer = "";

      while (iteration < MAX_ITERATIONS) {
        iteration++;
        if (signal.aborted) break;

        var assistantMsg = { role: "assistant", content: "", tool_calls: [] };
        var reasoningBuf = "";
        var contentBuf = "";
        var toolCallsMap = {};
        var toolCallNames = [];
        var gotToolCall = false;

        BUS.emit(EVT.ASSISTANT_START, {});
        var thinkStarted = false;

        var streamGen = AgentLLM.streamWithTools(
          systemPrompt,
          memory,
          tools,
          options || {},
          signal
        );

        var streamResult = await streamGen.next();
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
            var idx = chunk.index;
            if (!toolCallsMap[idx]) {
              toolCallsMap[idx] = { id: "", name: "", argsStr: "" };
            }
            if (chunk.name) toolCallsMap[idx].name += chunk.name;
            if (chunk.arguments) toolCallsMap[idx].argsStr += chunk.arguments;
          }

          streamResult = await streamGen.next();
        }

        var finalChunk = streamResult.value || {};

        if (thinkStarted) {
          BUS.emit(EVT.THINK_END, { content: reasoningBuf });
        }

        var finalContent = finalChunk.content || contentBuf;
        var finalToolCalls = finalChunk.toolCalls || [];

        if (!gotToolCall && finalToolCalls.length === 0) {
          finalToolCalls = [];
        }

        if (!gotToolCall && finalToolCalls.length === 0 && finalContent) {
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
          finalAnswer = finalContent;
          break;
        }

        assistantMsg.tool_calls = finalToolCalls.map(function (tc) {
          return {
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          };
        });
        memory.push(assistantMsg);

        var toolResults = [];
        for (var ti = 0; ti < finalToolCalls.length; ti++) {
          var tc = finalToolCalls[ti];
          BUS.emit(EVT.TOOL_CALL_START, { name: tc.name, arguments: tc.arguments, id: tc.id });

          var toolResult;
          try {
            toolResult = await AgentTools.execute(tc.name, tc.arguments, sessionContext);
          } catch (toolErr) {
            toolResult = { error: toolErr.message || String(toolErr) };
          }

          BUS.emit(EVT.TOOL_CALL_END, { name: tc.name, result: toolResult, id: tc.id });

          var resultStr = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult, null, 2);
          memory.push({
            role: "tool",
            tool_call_id: tc.id,
            name: tc.name,
            content: resultStr,
          });
          toolResults.push({ name: tc.name, result: toolResult });
        }

        var hasFinishTool = finalToolCalls.some(function (tc) { return tc.name === "finish"; });
        if (hasFinishTool) {
          break;
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
