/*!
 * PatentLens Agent - Tool Registry
 * 工具注册中心：所有工具统一注册、统一描述、统一调用
 * 每个工具包含：name, description, schema(OpenAI function格式), execute函数
 */
var AgentTools = (function () {
  var tools = {};

  function normalizeParameters(params) {
    if (!params) {
      return { type: "object", properties: {} };
    }
    if (!params.type) params.type = "object";
    if (!params.properties) params.properties = {};
    // required 只在有值时保留，空数组会导致DeepSeek等API报400
    if (!params.required || (Array.isArray(params.required) && params.required.length === 0)) {
      delete params.required;
    }
    return params;
  }

  function register(toolDef) {
    if (!toolDef || !toolDef.name) {
      console.error("[AgentTools] invalid tool definition:", toolDef);
      return;
    }
    tools[toolDef.name] = {
      name: toolDef.name,
      description: toolDef.description || "",
      parameters: normalizeParameters(toolDef.parameters),
      execute: typeof toolDef.execute === "function" ? toolDef.execute : function () {
        return Promise.resolve({ error: "tool not implemented: " + toolDef.name });
      },
      isBlocking: !!toolDef.isBlocking,
      autoConfirm: toolDef.autoConfirm !== false,
    };
  }

  function unregister(name) {
    delete tools[name];
  }

  function get(name) {
    return tools[name] || null;
  }

  function list() {
    return Object.keys(tools).map(function (k) {
      var t = tools[k];
      return {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        isBlocking: t.isBlocking,
        autoConfirm: t.autoConfirm,
      };
    });
  }

  function getSchemas() {
    return Object.keys(tools).map(function (k) {
      var t = tools[k];
      return {
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      };
    });
  }

  async function execute(name, args, context) {
    var tool = tools[name];
    if (!tool) {
      return { error: "unknown tool: " + name };
    }
    try {
      var result = await tool.execute(args || {}, context || {});
      return result;
    } catch (e) {
      console.error("[AgentTools] error executing", name, e);
      return { error: e.message || String(e) };
    }
  }

  function clear() {
    tools = {};
  }

  return {
    register: register,
    unregister: unregister,
    get: get,
    list: list,
    getSchemas: getSchemas,
    execute: execute,
    clear: clear,
  };
})();
