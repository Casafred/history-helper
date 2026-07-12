/*!
 * PatentLens Agent - UI Panel
 * 渲染Agent聊天面板、TodoList、思考过程，处理用户输入
 */
var AgentUI = (function () {
  var BUS = AgentEventBus;
  var EVT = BUS.EVENTS;

  var panelEl = null;
  var toggleBtn = null;
  var messagesEl = null;
  var todosEl = null;
  var inputEl = null;
  var sendBtn = null;
  var stopBtn = null;
  var isOpen = false;
  var isProcessing = false;
  var pendingQuestionCallback = null;
  var currentAssistantBubble = null;
  var currentThinkingBubble = null;

  var SUGGESTIONS = [
    "查询 US14412875 的基本信息和摘要",
    "帮我查一下这个专利的权利要求书",
    "分析这个专利的审查文档列表",
    "查完后切换到概览页面",
  ];

  function createPanel() {
    toggleBtn = document.createElement("button");
    toggleBtn.className = "agent-toggle-btn";
    toggleBtn.title = "PatentLens 智能助手";
    toggleBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>';
    toggleBtn.addEventListener("click", togglePanel);
    document.body.appendChild(toggleBtn);

    panelEl = document.createElement("div");
    panelEl.className = "agent-panel";
    panelEl.innerHTML =
      '<div class="agent-panel-header">' +
        '<div class="agent-panel-title">' +
          '<div class="bot-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg></div>' +
          '<span>PatentLens 智能助手</span>' +
        '</div>' +
        '<div class="agent-panel-actions">' +
          '<button id="agent-reset-btn" title="清空对话">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>' +
          '</button>' +
          '<button id="agent-close-btn" title="关闭">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="agent-todos" id="agent-todos" style="display:none"></div>' +
      '<div class="agent-messages" id="agent-messages"></div>' +
      '<div class="agent-input-area">' +
        '<textarea id="agent-input" placeholder="输入专利号或告诉我你想做什么... (Enter发送，Shift+Enter换行)" rows="1"></textarea>' +
        '<button class="agent-send-btn" id="agent-send-btn" title="发送">' +
          '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' +
        '</button>' +
        '<button class="agent-stop-btn" id="agent-stop-btn" title="停止" style="display:none">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>' +
        '</button>' +
      '</div>';

    document.body.appendChild(panelEl);

    messagesEl = panelEl.querySelector("#agent-messages");
    todosEl = panelEl.querySelector("#agent-todos");
    inputEl = panelEl.querySelector("#agent-input");
    sendBtn = panelEl.querySelector("#agent-send-btn");
    stopBtn = panelEl.querySelector("#agent-stop-btn");

    panelEl.querySelector("#agent-close-btn").addEventListener("click", closePanel);
    panelEl.querySelector("#agent-reset-btn").addEventListener("click", resetChat);
    sendBtn.addEventListener("click", sendMessage);
    stopBtn.addEventListener("click", function () {
      PatentLensAgent.stop();
    });

    inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    inputEl.addEventListener("input", function () {
      inputEl.style.height = "auto";
      inputEl.style.height = Math.min(inputEl.scrollHeight, 100) + "px";
    });

    renderWelcome();
    bindEvents();
  }

  function bindEvents() {
    BUS.on(EVT.SESSION_STARTED, function () {
      isProcessing = true;
      updateButtons();
      toggleBtn.classList.add("running");
    });

    BUS.on(EVT.SESSION_FINISHED, function () {
      isProcessing = false;
      updateButtons();
      toggleBtn.classList.remove("running");
      if (currentAssistantBubble) currentAssistantBubble = null;
      if (currentThinkingBubble) currentThinkingBubble = null;
    });

    BUS.on(EVT.SESSION_ERROR, function (data) {
      isProcessing = false;
      updateButtons();
      toggleBtn.classList.remove("running");
      addErrorMessage(data.error || "发生错误");
    });

    BUS.on(EVT.SESSION_ABORTED, function () {
      isProcessing = false;
      updateButtons();
      toggleBtn.classList.remove("running");
      addSystemMessage("已停止");
    });

    BUS.on(EVT.TODOS_UPDATED, function (data) {
      renderTodos(data.todos);
    });

    BUS.on(EVT.THINK_START, function () {
      startThinkingBubble();
    });

    BUS.on(EVT.THINK_CHUNK, function (data) {
      appendThinkingChunk(data.content);
    });

    BUS.on(EVT.THINK_END, function () {
      finishThinkingBubble();
    });

    BUS.on(EVT.TOOL_CALL_START, function (data) {
      addToolCallStart(data.name, data.arguments);
    });

    BUS.on(EVT.TOOL_CALL_END, function (data) {
      finishToolCall(data.name, data.result);
    });

    BUS.on(EVT.TOOL_CALL_ERROR, function (data) {
      finishToolCallError(data.name, data.error);
    });

    BUS.on(EVT.ASSISTANT_START, function () {
      startAssistantBubble();
    });

    BUS.on(EVT.ASSISTANT_CHUNK, function (data) {
      appendAssistantChunk(data.content);
    });

    BUS.on(EVT.ASSISTANT_END, function () {
      finishAssistantBubble();
    });

    BUS.on(EVT.USER_QUESTION, function (data) {
      showQuestion(data.question, data.options, data.callback);
    });

    BUS.on(EVT.TAB_SWITCH, function (data) {
      console.log("[AgentUI] tab switch requested:", data.tab);
    });
  }

  function renderWelcome() {
    messagesEl.innerHTML =
      '<div class="agent-welcome">' +
        '<h3>👋 你好，我是专利智能助手</h3>' +
        '<p>输入专利号，我可以帮你自动查询、分析专利信息</p>' +
        '<div class="agent-suggestions">' +
          SUGGESTIONS.map(function (s) {
            return '<button class="agent-suggestion">' + escapeHtml(s) + '</button>';
          }).join("") +
        '</div>' +
      '</div>';

    messagesEl.querySelectorAll(".agent-suggestion").forEach(function (btn) {
      btn.addEventListener("click", function () {
        inputEl.value = btn.textContent;
        sendMessage();
      });
    });
  }

  function renderTodos(todos) {
    if (!todos || todos.length === 0) {
      todosEl.style.display = "none";
      return;
    }
    todosEl.style.display = "block";
    var html = '<div class="agent-todos-title">任务进度</div>';
    todos.forEach(function (t) {
      var cls = "agent-todo-item " + (t.status === "completed" ? "completed" : t.status === "in_progress" ? "in-progress" : "");
      var icon = "";
      if (t.status === "completed") icon = "✅";
      else if (t.status === "in_progress") icon = '<span style="display:inline-block;width:14px;height:14px;border:2px solid #6366f1;border-top-color:transparent;border-radius:50%;animation:agent-spin 0.8s linear infinite"></span>';
      else icon = "⏳";
      html += '<div class="' + cls + '"><span class="todo-status">' + icon + '</span><span>' + escapeHtml(t.content) + '</span></div>';
    });
    todosEl.innerHTML = html;
  }

  function addUserMessage(text) {
    removeWelcome();
    var msg = document.createElement("div");
    msg.className = "agent-msg user";
    msg.innerHTML =
      '<div class="agent-msg-avatar">👤</div>' +
      '<div class="agent-msg-body"><div class="agent-msg-bubble">' + escapeHtml(text) + '</div></div>';
    messagesEl.appendChild(msg);
    scrollToBottom();
  }

  function startAssistantBubble() {
    removeWelcome();
    if (currentAssistantBubble) {
      finishAssistantBubble();
    }
    var msg = document.createElement("div");
    msg.className = "agent-msg bot";
    msg.innerHTML =
      '<div class="agent-msg-avatar">🤖</div>' +
      '<div class="agent-msg-body"><div class="agent-msg-bubble"></div><div class="agent-typing"><span></span><span></span><span></span></div></div>';
    messagesEl.appendChild(msg);
    currentAssistantBubble = msg.querySelector(".agent-msg-bubble");
    scrollToBottom();
  }

  function appendAssistantChunk(text) {
    if (!currentAssistantBubble) {
      startAssistantBubble();
    }
    var typing = currentAssistantBubble.parentElement.querySelector(".agent-typing");
    if (typing) typing.style.display = "none";
    currentAssistantBubble.textContent += text;
    scrollToBottom();
  }

  function finishAssistantBubble() {
    if (currentAssistantBubble) {
      var typing = currentAssistantBubble.parentElement.querySelector(".agent-typing");
      if (typing) typing.remove();
    }
    currentAssistantBubble = null;
  }

  function startThinkingBubble() {
    if (currentThinkingBubble) return;
    var msg = document.createElement("div");
    msg.className = "agent-msg bot";
    msg.innerHTML =
      '<div class="agent-msg-avatar">💭</div>' +
      '<div class="agent-msg-body">' +
        '<div class="agent-msg-thinking collapsed">' +
          '<div class="thinking-header"><span>思考中</span><span class="thinking-toggle">展开</span></div>' +
          '<div class="thinking-content"></div>' +
        '</div>' +
      '</div>';
    messagesEl.appendChild(msg);
    currentThinkingBubble = msg.querySelector(".agent-msg-thinking");
    var toggle = currentThinkingBubble.querySelector(".thinking-toggle");
    toggle.addEventListener("click", function () {
      currentThinkingBubble.classList.toggle("collapsed");
      toggle.textContent = currentThinkingBubble.classList.contains("collapsed") ? "展开" : "收起";
    });
    scrollToBottom();
  }

  function appendThinkingChunk(text) {
    if (!currentThinkingBubble) startThinkingBubble();
    var content = currentThinkingBubble.querySelector(".thinking-content");
    content.textContent += text;
    scrollToBottom();
  }

  function finishThinkingBubble() {
    if (currentThinkingBubble) {
      var header = currentThinkingBubble.querySelector(".thinking-header span:first-child");
      if (header) header.textContent = "思考过程";
    }
  }

  function addToolCallStart(name, args) {
    var msg = document.createElement("div");
    msg.className = "agent-msg bot";
    msg.innerHTML =
      '<div class="agent-msg-avatar">🔧</div>' +
      '<div class="agent-msg-body">' +
        '<div class="agent-tool-call" data-tool="' + escapeHtml(name) + '">' +
          '<span style="font-size:14px">⚙️</span>' +
          '<span>正在调用 <span class="agent-tool-name">' + escapeHtml(name) + '</span>...</span>' +
        '</div>' +
      '</div>';
    messagesEl.appendChild(msg);
    msg._toolResult = true;
    scrollToBottom();
  }

  function finishToolCall(name, result) {
    var lastTool = messagesEl.querySelector('.agent-tool-call[data-tool="' + name + '"]:last-child');
    if (lastTool) {
      var isError = result && result.error;
      if (isError) {
        lastTool.classList.add("error");
        lastTool.innerHTML = '<span style="font-size:14px">❌</span><span><span class="agent-tool-name">' + escapeHtml(name) + '</span> 调用失败: ' + escapeHtml(result.error) + '</span>';
      } else {
        lastTool.innerHTML = '<span style="font-size:14px">✅</span><span><span class="agent-tool-name">' + escapeHtml(name) + '</span> 执行完成</span>';
      }
    }
    scrollToBottom();
  }

  function finishToolCallError(name, error) {
    finishToolCall(name, { error: error });
  }

  function addErrorMessage(text) {
    var msg = document.createElement("div");
    msg.className = "agent-msg bot";
    msg.innerHTML =
      '<div class="agent-msg-avatar">❌</div>' +
      '<div class="agent-msg-body"><div class="agent-msg-bubble" style="background:#fef2f2;color:#991b1b;border-left:3px solid #ef4444">' + escapeHtml(text) + '</div></div>';
    messagesEl.appendChild(msg);
    scrollToBottom();
  }

  function addSystemMessage(text) {
    var msg = document.createElement("div");
    msg.style.textAlign = "center";
    msg.style.color = "#94a3b8";
    msg.style.fontSize = "12px";
    msg.style.padding = "4px 0";
    msg.textContent = text;
    messagesEl.appendChild(msg);
    scrollToBottom();
  }

  function showQuestion(question, options, callback) {
    pendingQuestionCallback = callback;
    var msg = document.createElement("div");
    msg.className = "agent-msg bot";
    var optionsHtml = "";
    if (options && options.length > 0) {
      optionsHtml = '<div class="agent-question-options">' +
        options.map(function (o, i) {
          return '<button class="agent-question-option" data-idx="' + i + '">' + escapeHtml(o) + '</button>';
        }).join("") +
        '</div>';
    }
    msg.innerHTML =
      '<div class="agent-msg-avatar">🤔</div>' +
      '<div class="agent-msg-body">' +
        '<div class="agent-question">' +
          '<div class="agent-question-text">' + escapeHtml(question) + '</div>' +
          optionsHtml +
        '</div>' +
      '</div>';
    messagesEl.appendChild(msg);

    var btns = msg.querySelectorAll(".agent-question-option");
    btns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var answer = btn.textContent;
        msg.querySelectorAll(".agent-question-option").forEach(function (b) {
          b.disabled = true;
          b.style.opacity = "0.5";
        });
        btn.style.background = "#3b82f6";
        btn.style.color = "#fff";
        if (pendingQuestionCallback) {
          var cb = pendingQuestionCallback;
          pendingQuestionCallback = null;
          cb(answer);
        }
      });
    });

    scrollToBottom();
  }

  function sendMessage() {
    var text = inputEl.value.trim();
    if (!text || isProcessing) return;
    if (pendingQuestionCallback) {
      var cb = pendingQuestionCallback;
      pendingQuestionCallback = null;
      addUserMessage(text);
      cb(text);
      inputEl.value = "";
      inputEl.style.height = "auto";
      return;
    }
    addUserMessage(text);
    inputEl.value = "";
    inputEl.style.height = "auto";
    PatentLensAgent.chat(text).catch(function (err) {
      console.error("[AgentUI] chat error:", err);
    });
  }

  function resetChat() {
    PatentLensAgent.reset();
    messagesEl.innerHTML = "";
    todosEl.innerHTML = "";
    todosEl.style.display = "none";
    currentAssistantBubble = null;
    currentThinkingBubble = null;
    pendingQuestionCallback = null;
    isProcessing = false;
    updateButtons();
    toggleBtn.classList.remove("running");
    renderWelcome();
  }

  function togglePanel() {
    isOpen = !isOpen;
    panelEl.classList.toggle("open", isOpen);
    if (isOpen) {
      setTimeout(function () { inputEl.focus(); }, 100);
    }
  }

  function closePanel() {
    isOpen = false;
    panelEl.classList.remove("open");
  }

  function openPanel() {
    isOpen = true;
    panelEl.classList.add("open");
    setTimeout(function () { inputEl.focus(); }, 100);
  }

  function updateButtons() {
    sendBtn.style.display = isProcessing ? "none" : "flex";
    stopBtn.style.display = isProcessing ? "flex" : "none";
    sendBtn.disabled = isProcessing;
    inputEl.disabled = false;
  }

  function removeWelcome() {
    var welcome = messagesEl.querySelector(".agent-welcome");
    if (welcome) welcome.remove();
  }

  function scrollToBottom() {
    requestAnimationFrame(function () {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function escapeHtml(text) {
    var d = document.createElement("div");
    d.textContent = text == null ? "" : String(text);
    return d.innerHTML;
  }

  function init() {
    if (panelEl) return;
    createPanel();
  }

  return {
    init: init,
    openPanel: openPanel,
    closePanel: closePanel,
    togglePanel: togglePanel,
  };
})();
