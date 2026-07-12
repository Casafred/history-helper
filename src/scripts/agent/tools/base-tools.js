/*!
 * PatentLens Agent - Base Tools
 * 基础工具集：think, update_todos, finish, switch_to_tab 等
 */
var AgentBaseTools = (function () {
  var BUS = AgentEventBus;
  var EVT = BUS.EVENTS;

  function registerAll() {
    AgentTools.register({
      name: "think",
      description: "在开始操作或做决策前，用这个工具写下你的思考过程。用户可以看到你的思考，这有助于让用户理解你在做什么。在调用其他工具前，可以先用think说明你打算做什么。",
      parameters: {
        type: "object",
        properties: {
          thought: {
            type: "string",
            description: "你的思考内容，包括对当前情况的分析、下一步打算、为什么这么做等",
          },
        },
        required: ["thought"],
      },
      execute: function (args) {
        return Promise.resolve({ ok: true, thought: args.thought });
      },
    });

    AgentTools.register({
      name: "update_todos",
      description: "更新当前任务列表状态，让用户看到进度。每次完成一个步骤或开始新步骤时都应该调用这个工具。",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "任务列表，每个任务包含id、content、status",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "任务唯一标识" },
                content: { type: "string", description: "任务描述" },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                  description: "任务状态",
                },
              },
              required: ["id", "content", "status"],
            },
          },
        },
        required: ["todos"],
      },
      execute: function (args, context) {
        var ctx = AgentCore.getContext();
        var merged = [];
        var existing = ctx.todos || [];
        var existingMap = {};
        for (var i = 0; i < existing.length; i++) {
          existingMap[existing[i].id] = existing[i];
        }
        for (var j = 0; j < args.todos.length; j++) {
          var t = args.todos[j];
          merged.push(Object.assign({}, existingMap[t.id] || {}, t));
        }
        AgentCore.updateTodos(merged);
        return Promise.resolve({ ok: true, todos: merged });
      },
    });

    AgentTools.register({
      name: "finish",
      description: "当你已经完成所有任务，准备给用户最终回答时，调用这个工具标记任务完成。",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "任务完成总结",
          },
        },
        required: ["summary"],
      },
      execute: function (args) {
        return Promise.resolve({ ok: true, finished: true, summary: args.summary });
      },
    });

    AgentTools.register({
      name: "switch_to_tab",
      description: "自动切换应用界面的标签页，让用户直接看到对应的数据。可选标签：overview(概览), family(同族), documents(审查文档), ai-summary(AI梳理)。",
      parameters: {
        type: "object",
        properties: {
          tab: {
            type: "string",
            enum: ["overview", "family", "documents", "ai-summary"],
            description: "要切换到的标签页名称",
          },
        },
        required: ["tab"],
      },
      execute: function (args) {
        var tabName = args.tab;
        var tabBtn = document.querySelector('.tab-btn[data-tab="' + tabName + '"]');
        if (tabBtn) {
          tabBtn.click();
        }
        BUS.emit(EVT.TAB_SWITCH, { tab: tabName });
        return Promise.resolve({ ok: true, switchedTo: tabName });
      },
    });

    AgentTools.register({
      name: "ask_user",
      description: "当你需要用户提供更多信息、做出选择或确认某个操作时，使用这个工具向用户提问。这会暂停当前流程等待用户回答。",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "要向用户提问的内容",
          },
          options: {
            type: "array",
            description: "可选的选项列表，供用户快速选择",
            items: { type: "string" },
          },
        },
        required: ["question"],
      },
      isBlocking: true,
      execute: function (args) {
        return new Promise(function (resolve) {
          BUS.emit(EVT.USER_QUESTION, {
            question: args.question,
            options: args.options || [],
            callback: function (answer) {
              resolve({ ok: true, answer: answer });
            },
          });
        });
      },
    });
  }

  return { registerAll: registerAll };
})();
