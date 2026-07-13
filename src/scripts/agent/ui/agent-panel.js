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
  var currentAssistantRawText = "";
  var renderTimeout = null;

  function renderMarkdown(text) {
    if (typeof marked !== "undefined") {
      try {
        marked.setOptions({
          breaks: true,
          gfm: true,
        });
        return marked.parse(text || "");
      } catch (e) {
        return escapeHtml(text);
      }
    }
    return escapeHtml(text);
  }

  function scheduleRender() {
    if (renderTimeout) clearTimeout(renderTimeout);
    renderTimeout = setTimeout(function () {
      if (currentAssistantBubble) {
        currentAssistantBubble.innerHTML = renderMarkdown(currentAssistantRawText);
        scrollToBottom();
      }
    }, 50);
  }

  var SUGGESTIONS = [
    "查询 US14412875 的审查信息",
    "帮我查一下这个专利的同族专利",
    "分析这个专利的审查文档列表",
    "查完后切换到审查看板",
  ];

  function loadPosition() {
    try {
      var pos = localStorage.getItem("patentlens_agent_position");
      if (pos) {
        pos = JSON.parse(pos);
        if (toggleBtn) {
          toggleBtn.style.left = pos.toggleLeft || "";
          toggleBtn.style.top = pos.toggleTop || "";
          toggleBtn.style.right = pos.toggleRight || "20px";
          toggleBtn.style.bottom = pos.toggleBottom || "20px";
        }
        if (panelEl && pos.panelWidth) {
          panelEl.style.width = pos.panelWidth + "px";
          panelEl.style.height = pos.panelHeight + "px";
          panelEl.style.left = pos.panelLeft || "";
          panelEl.style.top = pos.panelTop || "";
          panelEl.style.right = pos.panelRight || "20px";
          panelEl.style.bottom = pos.panelBottom || "90px";
        }
      }
    } catch (e) {}
  }

  function savePosition() {
    try {
      var pos = {
        toggleLeft: toggleBtn.style.left,
        toggleTop: toggleBtn.style.top,
        toggleRight: toggleBtn.style.right || "20px",
        toggleBottom: toggleBtn.style.bottom || "20px",
        panelWidth: panelEl.offsetWidth,
        panelHeight: panelEl.offsetHeight,
        panelLeft: panelEl.style.left,
        panelTop: panelEl.style.top,
        panelRight: panelEl.style.right || "20px",
        panelBottom: panelEl.style.bottom || "90px",
      };
      localStorage.setItem("patentlens_agent_position", JSON.stringify(pos));
    } catch (e) {}
  }

  function makeDraggable(element, handle, onDragEnd, isToggleBtn) {
    var isDragging = false;
    var hasMoved = false;
    var startX, startY, startLeft, startTop;

    function onMouseDown(e) {
      if (e.target.closest("button") || e.target.closest("input") || e.target.closest("textarea") || e.target.closest("a")) {
        return;
      }
      isDragging = true;
      hasMoved = false;
      startX = e.clientX;
      startY = e.clientY;
      var rect = element.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      element.style.right = "auto";
      element.style.bottom = "auto";
      e.preventDefault();
    }

    function onMouseMove(e) {
      if (!isDragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        hasMoved = true;
        if (isToggleBtn) {
          element._dragged = true;
        }
      }
      var newLeft = startLeft + dx;
      var newTop = startTop + dy;
      var maxLeft = window.innerWidth - element.offsetWidth;
      var maxTop = window.innerHeight - element.offsetHeight;
      newLeft = Math.max(0, Math.min(newLeft, maxLeft));
      newTop = Math.max(0, Math.min(newTop, maxTop));
      element.style.left = newLeft + "px";
      element.style.top = newTop + "px";
    }

    function onMouseUp() {
      if (isDragging) {
        isDragging = false;
        if (onDragEnd) onDragEnd();
        if (hasMoved) {
          savePosition();
        }
      }
    }

    handle.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  function makeResizable(panel) {
    var handles = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
    var isResizing = false;
    var currentHandle = null;
    var startX, startY, startW, startH, startLeft, startTop;

    handles.forEach(function (dir) {
      var handle = document.createElement("div");
      handle.className = "agent-resize-handle " + dir;
      panel.appendChild(handle);

      handle.addEventListener("mousedown", function (e) {
        isResizing = true;
        currentHandle = dir;
        startX = e.clientX;
        startY = e.clientY;
        var rect = panel.getBoundingClientRect();
        startW = rect.width;
        startH = rect.height;
        startLeft = rect.left;
        startTop = rect.top;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        e.preventDefault();
        e.stopPropagation();
      });
    });

    function onMouseMove(e) {
      if (!isResizing) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      var newW = startW;
      var newH = startH;
      var newLeft = startLeft;
      var newTop = startTop;
      var minW = 320;
      var minH = 400;
      var maxW = window.innerWidth - 40;
      var maxH = window.innerHeight - 40;

      if (currentHandle.includes("e")) newW = Math.max(minW, Math.min(maxW, startW + dx));
      if (currentHandle.includes("w")) {
        newW = Math.max(minW, Math.min(maxW, startW - dx));
        newLeft = startLeft + (startW - newW);
        if (newLeft < 0) {
          newW = newW + newLeft;
          newLeft = 0;
        }
      }
      if (currentHandle.includes("s")) newH = Math.max(minH, Math.min(maxH, startH + dy));
      if (currentHandle.includes("n")) {
        newH = Math.max(minH, Math.min(maxH, startH - dy));
        newTop = startTop + (startH - newH);
        if (newTop < 0) {
          newH = newH + newTop;
          newTop = 0;
        }
      }

      panel.style.width = newW + "px";
      panel.style.height = newH + "px";
      panel.style.left = newLeft + "px";
      panel.style.top = newTop + "px";
    }

    function onMouseUp() {
      if (isResizing) {
        isResizing = false;
        currentHandle = null;
        savePosition();
      }
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }

  function createPanel() {
    toggleBtn = document.createElement("button");
    toggleBtn.className = "agent-toggle-btn";
    toggleBtn.title = "PatentLens 智能助手 (拖拽可移动位置)";
    toggleBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>';
    toggleBtn.addEventListener("click", function(e) {
      if (!toggleBtn._dragged) {
        togglePanel();
      }
      toggleBtn._dragged = false;
    });
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

    makeDraggable(toggleBtn, toggleBtn, null, true);
    makeDraggable(panelEl, panelEl.querySelector(".agent-panel-header"), null, false);
    makeResizable(panelEl);
    loadPosition();

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

    BUS.on(EVT.ASSISTANT_END, function (data) {
      finishAssistantBubble(data && data.content ? data.content : null);
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
      else if (t.status === "in_progress") icon = '<span style="display:inline-block;width:14px;height:14px;border:2px solid var(--accent, #22c55e);border-top-color:transparent;border-radius:50%;animation:agent-spin 0.8s linear infinite"></span>';
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
    currentAssistantRawText = "";
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
    currentAssistantRawText += text;
    scheduleRender();
  }

  function finishAssistantBubble(finalContent) {
    if (renderTimeout) {
      clearTimeout(renderTimeout);
      renderTimeout = null;
    }
    if (currentAssistantBubble) {
      var typing = currentAssistantBubble.parentElement.querySelector(".agent-typing");
      if (typing) typing.remove();
      if (finalContent && !currentAssistantRawText) {
        currentAssistantRawText = finalContent;
      }
      if (currentAssistantRawText) {
        currentAssistantBubble.innerHTML = renderMarkdown(currentAssistantRawText);
      } else {
        currentAssistantBubble.parentElement.parentElement.style.display = "none";
      }
    }
    currentAssistantBubble = null;
    currentAssistantRawText = "";
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
    var thinkingEl = msg.querySelector(".agent-msg-thinking");
    currentThinkingBubble = thinkingEl;
    var toggle = thinkingEl.querySelector(".thinking-toggle");
    toggle.addEventListener("click", function () {
      thinkingEl.classList.toggle("collapsed");
      toggle.textContent = thinkingEl.classList.contains("collapsed") ? "展开" : "收起";
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
      '<div class="agent-msg-body"><div class="agent-msg-bubble" style="background:rgba(248,113,113,0.1);color:var(--danger,#f87171);border-left:3px solid var(--danger,#f87171);border-top-left-radius:4px">' + escapeHtml(text) + '</div></div>';
    messagesEl.appendChild(msg);
    scrollToBottom();
  }

  function addSystemMessage(text) {
    var msg = document.createElement("div");
    msg.style.textAlign = "center";
    msg.style.color = "var(--text-muted)";
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
        btn.style.background = "var(--accent)";
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
