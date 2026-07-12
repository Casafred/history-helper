/*!
 * PatentLens Agent - Entry Point
 * Agent系统入口：初始化、注册工具、对外API
 *
 * 对外暴露:
 *   PatentLensAgent.init()           初始化所有工具
 *   PatentLensAgent.chat(message)    发送消息给Agent，开始一轮对话
 *   PatentLensAgent.stop()           停止当前任务
 *   PatentLensAgent.isRunning()      检查是否正在运行
 *   PatentLensAgent.on(event, cb)    监听事件
 *   PatentLensAgent.reset()          重置会话
 */
var PatentLensAgent = (function () {
  var initialized = false;
  var BUS = AgentEventBus;

  function init(options) {
    if (initialized) return;
    initialized = true;

    var opts = options || {};

    AgentCore.setSystemPrompt(opts.systemPrompt || null);

    AgentBaseTools.registerAll();
    AgentPatentTools.registerAll();

    if (opts.extraTools && Array.isArray(opts.extraTools)) {
      for (var i = 0; i < opts.extraTools.length; i++) {
        AgentTools.register(opts.extraTools[i]);
      }
    }

    console.log("[PatentLensAgent] initialized with tools:", AgentTools.list().map(function (t) { return t.name; }));
  }

  async function chat(message) {
    if (!initialized) init();
    if (AgentCore.isActive()) {
      AgentCore.abort();
      await new Promise(function (r) { return setTimeout(r, 100); });
    }
    return AgentCore.run(message);
  }

  function stop() {
    AgentCore.abort();
  }

  function isRunning() {
    return AgentCore.isActive();
  }

  function on(event, callback) {
    return BUS.on(event, callback);
  }

  function reset() {
    AgentCore.reset();
  }

  function registerTool(toolDef) {
    AgentTools.register(toolDef);
  }

  return {
    init: init,
    chat: chat,
    stop: stop,
    isRunning: isRunning,
    on: on,
    reset: reset,
    registerTool: registerTool,
    EVENTS: BUS.EVENTS,
  };
})();
