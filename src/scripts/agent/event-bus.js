/*!
 * PatentLens Agent - Event Bus
 * 事件总线：解耦Agent编排层与UI层，所有状态变更都通过事件传递
 */
var AgentEventBus = (function () {
  var listeners = {};

  function on(event, callback) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(callback);
    return function () {
      off(event, callback);
    };
  }

  function off(event, callback) {
    if (!listeners[event]) return;
    if (!callback) {
      delete listeners[event];
      return;
    }
    var idx = listeners[event].indexOf(callback);
    if (idx !== -1) listeners[event].splice(idx, 1);
  }

  function emit(event, data) {
    if (!listeners[event]) return;
    var cbs = listeners[event].slice();
    for (var i = 0; i < cbs.length; i++) {
      try {
        cbs[i](data);
      } catch (e) {
        console.error("[AgentEventBus] error in listener for", event, e);
      }
    }
  }

  function once(event, callback) {
    var wrapper = function (data) {
      off(event, wrapper);
      callback(data);
    };
    on(event, wrapper);
  }

  function removeAll() {
    listeners = {};
  }

  return {
    on: on,
    off: off,
    emit: emit,
    once: once,
    removeAll: removeAll,

    EVENTS: {
      SESSION_STARTED: "session:started",
      SESSION_FINISHED: "session:finished",
      SESSION_ERROR: "session:error",
      SESSION_ABORTED: "session:aborted",

      TODOS_UPDATED: "todos:updated",

      THINK_START: "think:start",
      THINK_CHUNK: "think:chunk",
      THINK_END: "think:end",

      TOOL_CALL_START: "tool:call:start",
      TOOL_CALL_END: "tool:call:end",
      TOOL_CALL_ERROR: "tool:call:error",

      ASSISTANT_CHUNK: "assistant:chunk",
      ASSISTANT_START: "assistant:start",
      ASSISTANT_END: "assistant:end",

      TAB_SWITCH: "ui:switch_tab",
      DATA_UPDATED: "data:updated",

      USER_QUESTION: "ui:user_question",
      USER_ANSWER: "ui:user_answer",
    },
  };
})();
