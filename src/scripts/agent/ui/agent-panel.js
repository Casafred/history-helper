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
  var currentStepsBubble = null;
  var currentStepsList = null;
  var stepsCount = 0;
  var completedSteps = 0;

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

  // Quick actions: each has a label and a message template.
  // {pn} placeholder is replaced with the patent number the user enters.
  var QUICK_ACTIONS = [
    { label: "审查文档查询", icon: "search", msg: "查询专利 {pn} 的审查文档信息" },
    { label: "专利原文查询", icon: "doc", msg: "查询并分析专利 {pn} 的原文详情" },
    { label: "同族专利分析", icon: "family", msg: "帮我查一下专利 {pn} 的同族专利" },
    { label: "审查文档列表分析", icon: "list", msg: "分析专利 {pn} 的审查文档列表，给出关键信息摘要" },
    { label: "法律状态查询", icon: "legal", msg: "查询专利 {pn} 的法律状态和时间线" },
    { label: "全面分析", icon: "full", msg: "对专利 {pn} 进行全面分析，包括审查文档、同族、法律状态" },
  ];

  function loadPosition() {
    try {
      var pos = localStorage.getItem("patentlens_agent_position_v2");
      if (pos) {
        pos = JSON.parse(pos);
        if (toggleBtn) {
          toggleBtn.style.left = pos.toggleLeft || "";
          toggleBtn.style.top = pos.toggleTop || "20px";
          toggleBtn.style.right = pos.toggleRight || "20px";
          toggleBtn.style.bottom = pos.toggleBottom || "";
        }
        if (panelEl && pos.panelWidth) {
          panelEl.style.width = pos.panelWidth + "px";
          panelEl.style.height = pos.panelHeight + "px";
          panelEl.style.left = pos.panelLeft || "";
          panelEl.style.top = pos.panelTop || "90px";
          panelEl.style.right = pos.panelRight || "20px";
          panelEl.style.bottom = pos.panelBottom || "";
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
        toggleBottom: toggleBtn.style.bottom || "",
        panelWidth: panelEl.offsetWidth,
        panelHeight: panelEl.offsetHeight,
        panelLeft: panelEl.style.left,
        panelTop: panelEl.style.top,
        panelRight: panelEl.style.right || "20px",
        panelBottom: panelEl.style.bottom || "",
      };
      localStorage.setItem("patentlens_agent_position_v2", JSON.stringify(pos));
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
      var ctx = AgentCore.getContext();
      if (ctx.todos && ctx.todos.length > 0) {
        var hasIncomplete = ctx.todos.some(function (t) { return t.status !== "completed"; });
        if (hasIncomplete) {
          var completedTodos = ctx.todos.map(function (t) {
            return Object.assign({}, t, { status: "completed" });
          });
          AgentCore.updateTodos(completedTodos);
        }
      }
      finishAllSteps();
    });

    BUS.on(EVT.SESSION_ERROR, function (data) {
      isProcessing = false;
      updateButtons();
      toggleBtn.classList.remove("running");
      addErrorMessage(data.error || "发生错误");
      var ctx = AgentCore.getContext();
      if (ctx.todos && ctx.todos.length > 0) {
        var completedTodos = ctx.todos.map(function (t) {
          return Object.assign({}, t, { status: t.status === "completed" ? "completed" : "pending" });
        });
        AgentCore.updateTodos(completedTodos);
      }
      finishAllSteps();
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

  // Build SVG icon for quick action buttons (no emoji)
  function _quickActionIcon(name) {
    var icons = {
      search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
      doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>',
      family: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="3"/><circle cx="17" cy="7" r="3"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/><path d="M14 15h4a4 4 0 0 1 4 4v2"/></svg>',
      list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>',
      legal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6l9-3 9 3"/><path d="M5 6v12c0 1 1 2 2 2h10c1 0 2-1 2-2V6"/><line x1="12" y1="6" x2="12" y2="20"/></svg>',
      full: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9"/><path d="M21 3v6h-6"/></svg>',
    };
    return icons[name] || icons.search;
  }

  function renderWelcome() {
    messagesEl.innerHTML =
      '<div class="agent-welcome">' +
        '<h3>PatentLens 智能助手</h3>' +
        '<p>输入专利号，选择操作类型，我会自动帮你查询和分析</p>' +
        '<div class="agent-quick-input-wrap">' +
          '<input type="text" id="agent-pn-input" class="agent-pn-input" placeholder="输入专利号，如 US12030161B2" autocomplete="off">' +
        '</div>' +
        '<div class="agent-quick-actions">' +
          QUICK_ACTIONS.map(function (a) {
            return '<button class="agent-quick-btn" data-action="' + a.label + '" data-msg="' + escapeHtml(a.msg) + '">' +
              '<span class="agent-quick-icon">' + _quickActionIcon(a.icon) + '</span>' +
              '<span class="agent-quick-label">' + escapeHtml(a.label) + '</span>' +
            '</button>';
          }).join("") +
        '</div>' +
      '</div>';

    // Bind quick action buttons
    messagesEl.querySelectorAll(".agent-quick-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var pnInput = document.getElementById("agent-pn-input");
        var pn = pnInput ? pnInput.value.trim() : "";
        var msgTemplate = btn.getAttribute("data-msg") || "";
        if (!pn) {
          // No patent number — focus the input and flash it
          if (pnInput) {
            pnInput.focus();
            pnInput.style.borderColor = "var(--danger, #ef4444)";
            pnInput.style.boxShadow = "0 0 0 2px rgba(239,68,68,0.2)";
            setTimeout(function() {
              pnInput.style.borderColor = "";
              pnInput.style.boxShadow = "";
            }, 1500);
          }
          return;
        }
        var msg = msgTemplate.replace("{pn}", pn);
        inputEl.value = msg;
        sendMessage();
      });
    });

    // Enter key in patent number input triggers the first quick action
    var pnInputEl = document.getElementById("agent-pn-input");
    if (pnInputEl) {
      pnInputEl.addEventListener("keydown", function(e) {
        if (e.key === "Enter") {
          e.preventDefault();
          var firstBtn = messagesEl.querySelector(".agent-quick-btn");
          if (firstBtn) firstBtn.click();
        }
      });
    }
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
      if (t.status === "completed") icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><polyline points="20 6 9 17 4 12"/></svg>';
      else if (t.status === "in_progress") icon = '<span style="display:inline-block;width:14px;height:14px;border:2px solid var(--accent, #22c55e);border-top-color:transparent;border-radius:50%;animation:agent-spin 0.8s linear infinite"></span>';
      else icon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
      html += '<div class="' + cls + '"><span class="todo-status">' + icon + '</span><span>' + escapeHtml(t.content) + '</span></div>';
    });
    todosEl.innerHTML = html;
  }

  function addUserMessage(text) {
    removeWelcome();
    var msg = document.createElement("div");
    msg.className = "agent-msg user";
    msg.innerHTML =
      '<div class="agent-msg-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></div>' +
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
      '<div class="agent-msg-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg></div>' +
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

  function openPatentInApp(patentNumber, isFulltext) {
    if (!patentNumber) return;
    try {
      var patentBtn = document.querySelector('.search-mode-btn[data-mode="patent"]');
      var dossierBtn = document.querySelector('.search-mode-btn[data-mode="dossier"]');

      if (isFulltext && typeof searchPatentDetail === "function") {
        if (patentBtn) patentBtn.click();
        setTimeout(function () {
          var input = document.getElementById("patent-input");
          if (input) input.value = patentNumber;
          searchPatentDetail(patentNumber);
        }, 100);
      } else if (typeof doSearch === "function") {
        if (dossierBtn) dossierBtn.click();
        setTimeout(function () {
          var input = document.getElementById("patent-input");
          if (input) input.value = patentNumber;
          doSearch(patentNumber);
        }, 100);
      }

      setTimeout(function () {
        var panel = document.getElementById("agent-panel");
        if (panel) panel.classList.remove("open");
        isOpen = false;
      }, 200);
    } catch (e) {
      console.error("openPatentInApp error:", e);
    }
  }

  function extractPatentNumbers(text) {
    if (!text) return [];
    var patterns = [
      /\b(CN|US|EP|WO|DE|JP|KR|GB|FR|AU|CA)\d{6,14}[A-Z]?\d?\b/gi,
      /\bCN\d{9,10}[AB]\b/gi,
    ];
    var nums = [];
    var seen = new Set();
    patterns.forEach(function (p) {
      var matches = text.match(p);
      if (matches) {
        matches.forEach(function (m) {
          var upper = m.toUpperCase();
          if (!seen.has(upper)) {
            seen.add(upper);
            nums.push(upper);
          }
        });
      }
    });
    return nums;
  }

  function appendActionButton(bubble, text, onClick, iconSvg) {
    var btn = document.createElement("button");
    btn.className = "agent-action-btn";
    btn.innerHTML = (iconSvg || '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>') + '<span>' + escapeHtml(text) + '</span>';
    btn.addEventListener("click", onClick);
    var wrapper = document.createElement("div");
    wrapper.style.marginTop = "8px";
    wrapper.appendChild(btn);
    bubble.appendChild(wrapper);
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

        var ctx = (typeof AgentCore !== "undefined" && AgentCore.getContext) ? AgentCore.getContext() : null;
        var patentNum = null;
        var isFulltext = false;

        if (ctx) {
          if (ctx.patentNumber) {
            patentNum = ctx.patentNumber;
            isFulltext = !!ctx.patentFulltextData;
          }
        }

        if (!patentNum) {
          var foundNums = extractPatentNumbers(currentAssistantRawText);
          if (foundNums.length > 0) {
            patentNum = foundNums[0];
            isFulltext = true;
          }
        }

        if (patentNum) {
          var label = isFulltext ? "在应用内查看专利原文" : "在应用内查看专利详情";
          appendActionButton(
            currentAssistantBubble,
            label + ": " + patentNum,
            function () { openPatentInApp(patentNum, isFulltext); },
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>'
          );
        }
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
      '<div class="agent-msg-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>' +
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

  function startStepsBubble() {
    if (currentStepsBubble) return;
    var msg = document.createElement("div");
    msg.className = "agent-msg bot";
    msg.innerHTML =
      '<div class="agent-msg-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg></div>' +
      '<div class="agent-msg-body">' +
        '<div class="agent-steps" data-steps>' +
          '<div class="steps-header">' +
            '<span class="steps-title">执行步骤</span>' +
            '<span class="steps-count">0 步</span>' +
            '<span class="steps-toggle">折叠</span>' +
          '</div>' +
          '<div class="steps-list"></div>' +
        '</div>' +
      '</div>';
    messagesEl.appendChild(msg);
    currentStepsBubble = msg.querySelector(".agent-steps");
    currentStepsList = msg.querySelector(".steps-list");
    stepsCount = 0;
    completedSteps = 0;
    var header = msg.querySelector(".steps-header");
    var toggle = msg.querySelector(".steps-toggle");
    var stepsBubbleEl = currentStepsBubble;
    function toggleSteps() {
      if (!stepsBubbleEl) return;
      var isCollapsed = stepsBubbleEl.classList.toggle("collapsed");
      if (toggle) toggle.textContent = isCollapsed ? "展开" : "折叠";
    }
    header.addEventListener("click", function (e) {
      e.stopPropagation();
      toggleSteps();
    });
    scrollToBottom();
  }

  function updateStepsCount() {
    if (!currentStepsBubble) return;
    var countEl = currentStepsBubble.querySelector(".steps-count");
    if (countEl) {
      countEl.textContent = completedSteps + "/" + stepsCount + " 步";
    }
    var titleEl = currentStepsBubble.querySelector(".steps-title");
    if (titleEl && stepsCount > 0) {
      if (completedSteps >= stepsCount) {
        titleEl.textContent = "执行完成";
      } else {
        titleEl.textContent = "执行步骤";
      }
    }
  }

  function addToolCallStart(name, args) {
    if (!currentStepsBubble) startStepsBubble();
    stepsCount++;
    var stepItem = document.createElement("div");
    stepItem.className = "step-item running";
    stepItem.dataset.tool = name;
    stepItem.dataset.stepIdx = stepsCount - 1;
    var argsPreview = "";
    if (args) {
      try {
        var keys = Object.keys(args);
        if (keys.length > 0) {
          argsPreview = keys.slice(0, 2).map(function(k) {
            var v = args[k];
            if (typeof v === "string" && v.length > 20) v = v.substring(0, 20) + "...";
            return k + ": " + v;
          }).join(", ");
          if (keys.length > 2) argsPreview += "...";
        }
      } catch(e) {}
    }
    stepItem.innerHTML =
      '<span class="step-icon spinner"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></span>' +
      '<span class="step-text"><span class="step-tool-name">' + escapeHtml(name) + '</span>' +
      (argsPreview ? ' <span class="step-args">' + escapeHtml(argsPreview) + '</span>' : '') +
      ' <span class="step-status">执行中...</span></span>';
    currentStepsList.appendChild(stepItem);
    updateStepsCount();
    scrollToBottom();
  }

  function finishToolCall(name, result) {
    if (!currentStepsBubble) return;
    var steps = currentStepsList.querySelectorAll(".step-item[data-tool='" + name + "'].running");
    var stepItem = steps.length > 0 ? steps[steps.length - 1] : null;
    var isError = result && result.error;
    completedSteps++;
    if (stepItem) {
      stepItem.classList.remove("running");
      if (isError) {
        stepItem.classList.add("error");
        stepItem.innerHTML =
          '<span class="step-icon error"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></span>' +
          '<span class="step-text"><span class="step-tool-name">' + escapeHtml(name) + '</span>' +
          ' <span class="step-status error">失败: ' + escapeHtml(result.error) + '</span></span>';
      } else {
        stepItem.classList.add("done");
        var resultSummary = getToolResultSummary(name, result);
        stepItem.innerHTML =
          '<span class="step-icon done"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px"><polyline points="20 6 9 17 4 12"/></svg></span>' +
          '<span class="step-text"><span class="step-tool-name">' + escapeHtml(name) + '</span>' +
          (resultSummary ? ' <span class="step-result">' + escapeHtml(resultSummary) + '</span>' : '') +
          '</span>';
      }
    }
    updateStepsCount();
    scrollToBottom();
  }

  function getToolResultSummary(name, result) {
    if (!result) return "";
    if (name === "fetch_patent" || name === "fetch_patent_fulltext") {
      if (result.patentNumber) return result.patentNumber;
      if (result.ok && result.title) return result.title.length > 30 ? result.title.substring(0, 30) + "..." : result.title;
    }
    if (name === "get_patent_claims") {
      return result.totalClaims + "项权利要求（" + result.independentClaims + "项独权）";
    }
    if (name === "get_patent_basic_info") {
      return result.patentNumber || result.title || "";
    }
    if (name === "get_patent_abstract") {
      return result.patentNumber || "";
    }
    if (name === "switch_tab") {
      return "切换到 " + (result.tab || result.targetTab || "");
    }
    if (name === "search") {
      return result.count ? result.count + "条结果" : "搜索完成";
    }
    if (name === "get_timeline") {
      return result.eventCount + "个审查节点";
    }
    if (name === "run_ai_analysis" || name === "fetch_dossier_and_analyze") {
      return result.documentCount ? result.documentCount + "篇文档，AI分析已启动" : (result.tip || "分析已启动");
    }
    if (name === "open_document_reader") {
      return "文档阅读器已打开";
    }
    if (name === "get_documents_summary") {
      return result.documentCount + "篇审查文档";
    }
    return result.ok ? "完成" : "";
  }

  function finishToolCallError(name, error) {
    finishToolCall(name, { error: error });
  }

  function finishAllSteps() {
    if (currentStepsBubble) {
      var titleEl = currentStepsBubble.querySelector(".steps-title");
      if (titleEl && stepsCount > 0) {
        if (completedSteps >= stepsCount) {
          titleEl.textContent = "执行步骤（全部完成）";
        } else {
          titleEl.textContent = "执行步骤（" + completedSteps + "/" + stepsCount + "）";
        }
      }
      var countEl = currentStepsBubble.querySelector(".steps-count");
      if (countEl) {
        countEl.textContent = completedSteps + "/" + stepsCount + " 步";
      }
      var spinnerEl = currentStepsBubble.querySelector(".step-icon.spinner");
      if (spinnerEl && completedSteps >= stepsCount) {
        spinnerEl.classList.remove("spinner");
        spinnerEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:12px;height:12px"><polyline points="20 6 9 17 4 12"/></svg>';
      }
    }
    currentStepsBubble = null;
    currentStepsList = null;
    stepsCount = 0;
    completedSteps = 0;
  }

  function addErrorMessage(text) {
    var msg = document.createElement("div");
    msg.className = "agent-msg bot";
    msg.innerHTML =
      '<div class="agent-msg-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg></div>' +
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
      '<div class="agent-msg-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div>' +
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
    currentStepsBubble = null;
    currentStepsList = null;
    stepsCount = 0;
    completedSteps = 0;
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
