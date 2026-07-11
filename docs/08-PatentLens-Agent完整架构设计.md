# PatentLens Agent 完整架构设计文档

> **版本**: v1.0  
> **日期**: 2026-07-11  
> **目标**: 将 PatentLens 改造为 TRAE 级别的智能代理系统——支持自然语言驱动、子代理任务分发、自动任务拆解、实时进度反馈、思考链可视化、文件系统操作、人机协作确认的完整 Agent 工作台

---

## 一、核心愿景

### 1.1 从"GUI工具"到"AI工作台"

当前 PatentLens 是一个**功能完备的 GUI 工具**，但用户需要：
- 记住每个 Tab 的用途
- 手动按顺序点击按钮
- 自己判断下一步该做什么
- 自己整合多来源信息

改造后，PatentLens Agent 成为一个**专利分析师的 AI 协作伙伴**：
- 用户用自然语言描述目标："帮我分析 US14412875 的审查历史，重点找创造性争议，输出对比表格，导出Word"
- Agent 自动拆解任务、调度子代理、调用工具、更新进度、交付结果
- 过程中可以看到 Agent 的思考过程、当前步骤、实时进度
- 关键节点（如批量下载、覆盖文件）会主动询问用户确认

### 1.2 对标 TRAE 的核心能力矩阵

| 能力维度 | TRAE 现状 | PatentLens Agent 目标 |
|---------|----------|---------------------|
| **意图理解** | 理解复杂开发需求 | 理解专利分析需求（含隐式意图） |
| **任务规划** | TodoWrite 自动拆解任务 | TodoList 自动拆解专利分析步骤 |
| **主代理编排** | 一个主代理统筹全局 | 主代理 + 领域子代理分工协作 |
| **子代理分发** | general_purpose_task / search 子代理 | 数据采集代理 / OCR代理 / 分析代理 / 报告代理 |
| **工具系统** | 文件读写、搜索、编辑、命令、浏览器 | 专利查询、文档下载、OCR、AI分析、文件操作、导出 |
| **思考过程** | 内部推理 + reasoning_content 展示 | 思考状态可视化（"正在分析..."） |
| **进度更新** | Todo 状态实时变化 | 任务列表 + 进度条 + 当前步骤提示 |
| **人机协作** | AskUserQuestion 请求决策 | 关键操作前询问用户（批量下载、覆盖报告等） |
| **错误修正** | 工具失败自动分析并重试 | API 限流/失败自动退避重试，无法解决时询问用户 |
| **上下文记忆** | 会话历史持续 | 会话内记住已查询的专利、已生成的分析 |
| **输出交付** | 文件编辑/创建 | 自动生成报告、导出 Word/PDF、保存分析结果 |

---

## 二、整体架构：七层模型

```
┌─────────────────────────────────────────────────────────────────────┐
│                        PatentLens Agent v1.0                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐ │
│  │ ⑦ 用户交互层 (UI Layer)                                       │ │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ │ │
│  │  │ 自然语言   │ │ 任务面板   │ │ 思考/进度  │ │ 结果渲染   │ │ │
│  │  │ 聊天框     │ │ (TodoList) │ │ 实时面板   │ │ (Tab联动)  │ │ │
│  │  └────────────┘ └────────────┘ └────────────┘ └────────────┘ │ │
│  └───────────────────────────────┬───────────────────────────────┘ │
│                                  │                                  │
│  ┌───────────────────────────────▼───────────────────────────────┐ │
│  │ ⑥ 主代理编排层 (Orchestrator)                                  │ │
│  │  ┌─────────────────────────────────────────────────────────┐  │ │
│  │  │  PatentLensOrchestrator (主Agent)                       │  │ │
│  │  │  · 意图识别  · 任务规划  · 子代理调度  · 进度管理       │  │ │
│  │  │  · 人机交互  · 错误处理  · 最终结果聚合                 │  │ │
│  │  └─────────────┬───────────────────┬───────────────────────┘  │ │
│  │                │                   │                          │ │
│  │  ┌─────────────▼───────┐  ┌────────▼────────┐                │ │
│  │  │  Planner (规划器)   │  │ Memory (记忆)   │                │ │
│  │  │ · 任务拆解          │  │ · 会话上下文    │                │ │
│  │  │ · TodoList管理      │  │ · 专利缓存      │                │ │
│  │  │ · 依赖排序          │  │ · 用户偏好      │                │ │
│  │  └─────────────────────┘  └─────────────────┘                │ │
│  └───────────────────────────────┬───────────────────────────────┘ │
│                                  │                                  │
│  ┌───────────────────────────────▼───────────────────────────────┐ │
│  │ ⑤ 子代理层 (Sub-Agents)                                       │ │
│  │                                                               │ │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐          │ │
│  │  │ DataCollection│ │ OCRProcessor │ │ PatentAnalyst│          │ │
│  │  │ Agent         │ │ Agent        │ │ Agent        │          │ │
│  │  │ (数据采集)    │ │ (文档处理)    │ │ (智能分析)    │          │ │
│  │  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘          │ │
│  │         │                │                │                   │ │
│  │  ┌──────▼───────┐ ┌──────▼───────┐ ┌──────▼───────┐          │ │
│  │  │ ReportGen    │ │ SearchAgent  │ │ FileOpsAgent │          │ │
│  │  │ Agent        │ │ (检索代理)   │ │ (文件操作)    │          │ │
│  │  │ (报告生成)    │ │              │ │              │          │ │
│  │  └──────────────┘ └──────────────┘ └──────────────┘          │ │
│  └───────────────────────────────┬───────────────────────────────┘ │
│                                  │                                  │
│  ┌───────────────────────────────▼───────────────────────────────┐ │
│  │ ④ 工具执行层 (Tool Runtime)                                    │ │
│  │                                                               │ │
│  │  ┌─────────────────────────────────────────────────────────┐  │ │
│  │  │  Tool Registry + Tool Executor                          │  │ │
│  │  │  · 参数校验  · 权限检查  · 超时控制  · 重试逻辑         │  │ │
│  │  │  · 结果标准化 · 错误包装  · 日志记录                    │  │ │
│  │  └─────────────────────────────────────────────────────────┘  │ │
│  └───────────────────────────────┬───────────────────────────────┘ │
│                                  │                                  │
│  ┌───────────────────────────────▼───────────────────────────────┐ │
│  │ ③ 工具定义层 (Tool Definitions)                                │ │
│  │                                                               │ │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐  │ │
│  │  │ 专利查询类 │ │ 文档处理类 │ │ 分析类工具 │ │ 基础工具类 │  │ │
│  │  │ · 解析专利号│ │ · 下载文档 │ │ · AI梳理   │ │ · 读文件   │  │ │
│  │  │ · 获取同族 │ │ · OCR识别  │ │ · 单篇分析 │ │ · 写文件   │  │ │
│  │  │ · 获取文档 │ │ · 文本提取 │ │ · 对比分析 │ │ · 搜索     │  │ │
│  │  │ · JP/DE查询│ │ · 文档合并 │ │ · 摘要生成 │ │ · 思考     │  │ │
│  │  └────────────┘ └────────────┘ └────────────┘ └────────────┘  │ │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐  │ │
│  │  │ UI操作类   │ │ 导出类工具 │ │ 搜索类工具 │ │ 系统工具类 │  │ │
│  │  │ · 切换Tab  │ │ · 导出Word │ │ · 代码搜索 │ │ · 执行命令 │  │ │
│  │  │ · 显示结果 │ │ · 导出PDF  │ │ · 文本搜索 │ │ · 打开路径 │  │ │
│  │  │ · 通知用户 │ │ · 保存项目 │ │ · Web搜索  │ │ · 环境配置 │  │ │
│  │  └────────────┘ └────────────┘ └────────────┘ └────────────┘  │ │
│  └───────────────────────────────┬───────────────────────────────┘ │
│                                  │ Tauri IPC / Direct Call          │
│  ┌───────────────────────────────▼───────────────────────────────┐ │
│  │ ② 核心能力层 (Core Capabilities)  ← 现有 Rust 后端             │ │
│  │                                                               │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐         │ │
│  │  │ USPTO/EP │ │ Global   │ │ OCR引擎  │ │ AI大模型 │         │ │
│  │  │ /JPO/DPMA│ │ Dossier  │ │ (Paddle/ │ │ (智谱/DS │         │ │
│  │  │ API客户端│ │ 爬虫     │ │  GLM)    │ │  /OpenAI)│         │ │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘         │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐         │ │
│  │  │ SQLite   │ │ PDF处理  │ │ DOCX生成 │ │ 文件系统 │         │ │
│  │  │ 缓存     │ │ (pdf-lib)│ │ (docx)   │ │ 访问     │         │ │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘         │ │
│  └───────────────────────────────┬───────────────────────────────┘ │
│                                  │                                  │
│  ┌───────────────────────────────▼───────────────────────────────┐ │
│  │ ① LLM 抽象层 (LLM Provider)                                    │ │
│  │  支持：智谱GLM / DeepSeek / OpenAI / 本地模型(Ollama)          │ │
│  │  能力：Function Calling / Streaming / Reasoning / Vision      │ │
│  └───────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 三、核心组件详细设计

### 3.1 主代理编排器 (Orchestrator)

主代理是整个系统的"大脑"，负责理解用户意图、制定计划、调度子代理、管理进度。

```javascript
class PatentLensOrchestrator {
  constructor(config) {
    this.llm = createLLMClient(config);
    this.planner = new TaskPlanner();
    this.memory = new AgentMemory();
    this.toolRegistry = new ToolRegistry();
    this.subAgents = new Map();
    this.eventBus = new EventBus();
    this.maxSteps = 30;
    this.currentTodoList = [];
    this.registerSubAgents();
    this.registerTools();
  }

  async run(userMessage, options = {}) {
    const sessionId = options.sessionId || this.createSession();
    const context = await this.buildContext(sessionId, userMessage);

    this.emit("session:start", { sessionId, userMessage });

    // Step 1: 意图理解 + 任务规划
    this.emit("status:update", { phase: "planning", message: "正在分析需求并制定计划..." });
    const plan = await this.planner.createPlan(userMessage, context, this.llm);
    this.currentTodoList = plan.todos;
    this.emit("todos:created", { todos: plan.todos });

    // Step 2: 执行计划（Tool Loop + 子代理调度）
    const result = await this.executePlan(plan, context);

    // Step 3: 结果聚合与交付
    this.emit("session:complete", { result });
    return result;
  }

  async executePlan(plan, context) {
    const messageHistory = context.messageHistory;
    messageHistory.push({ role: "user", content: plan.augmentedPrompt });

    for (let step = 0; step < this.maxSteps; step++) {
      // 更新进度
      this.updateProgress(step, plan.todos);

      // 调用 LLM（带思考过程）
      const response = await this.callLLMWithThinking({
        messages: messageHistory,
        tools: this.getAllAvailableTools(),
        tool_choice: "auto",
      });

      const message = response.message;
      messageHistory.push(message);

      // 展示思考过程（如果有）
      if (message.reasoning_content) {
        this.emit("thinking:update", { content: message.reasoning_content });
      }

      // 检查是否为最终回答
      if (this.isFinalAnswer(message)) {
        await this.markAllTodosCompleted();
        return await this.formatFinalResponse(message, context);
      }

      // 处理工具调用（可能是直接调工具，也可能是调度子代理）
      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          await this.handleToolCall(toolCall, messageHistory, context);
        }
      }

      // 检查是否需要向用户提问
      if (this.needUserInput(message)) {
        const userResponse = await this.askUserQuestion(message.questions);
        messageHistory.push({ role: "user", content: userResponse });
      }
    }

    return this.forceComplete(messageHistory);
  }

  async handleToolCall(toolCall, messageHistory, context) {
    const toolName = toolCall.function.name;
    const args = JSON.parse(toolCall.function.arguments);

    // 检查是否是子代理调用
    if (this.subAgents.has(toolName)) {
      return await this.dispatchSubAgent(toolName, args, messageHistory, context);
    }

    // 检查是否是 TodoWrite 工具（任务管理）
    if (toolName === "update_todos") {
      return await this.handleTodoUpdate(args);
    }

    // 检查是否是思考工具
    if (toolName === "think") {
      this.emit("thinking:update", { content: args.thought });
      return { thought_recorded: true };
    }

    // 检查是否需要用户确认（敏感操作）
    if (this.isSensitiveTool(toolName, args)) {
      const approved = await this.requestUserApproval(toolName, args);
      if (!approved) {
        this.addToolResult(messageHistory, toolCall.id, {
          error: "用户取消了此操作"
        });
        return;
      }
    }

    // 普通工具执行
    this.emit("tool:start", { toolName, args, todoId: args._todoId });
    this.markTodoInProgress(args._todoId);

    try {
      const result = await this.toolRegistry.execute(toolName, args, context);
      this.addToolResult(messageHistory, toolCall.id, result);
      this.emit("tool:end", { toolName, result, success: true });
      this.markTodoCompleted(args._todoId);
      return result;
    } catch (error) {
      const errorResult = await this.handleToolError(error, toolName, args);
      this.addToolResult(messageHistory, toolCall.id, errorResult);
      this.emit("tool:end", { toolName, error, success: false });
      return errorResult;
    }
  }
}
```

### 3.2 任务规划器 (Task Planner)

类似 TRAE 的 TodoWrite，自动拆解任务、管理依赖关系、更新状态。

```javascript
class TaskPlanner {
  async createPlan(userMessage, context, llm) {
    const systemPrompt = `
你是一位专业的专利分析师助手的任务规划模块。根据用户的需求，将任务拆解为清晰的、可执行的步骤。

规则：
1. 每个任务必须是具体的、可通过工具完成的原子操作
2. 任务之间按依赖关系排序（前置任务完成才能开始后续任务）
3. 任务粒度适中——既不能太粗（一个任务包含太多操作），也不能太细（每个API调用一个任务）
4. 对于"分析专利X"这类请求，标准流程通常是：
   - 解析并验证专利号格式
   - 获取专利基本信息 + 同族数据
   - 获取审查文档列表
   - 筛选关键文档（审查意见、答复）
   - 下载并OCR关键文档
   - 执行AI分析
   - 生成/导出报告
5. 如果用户只问简单问题（如"这个专利当前状态"），只生成必要的最少任务

请以 JSON 格式输出，不要有其他文字：
{
  "plan_summary": "简短描述整体计划",
  "todos": [
    {
      "id": "task-1",
      "content": "具体任务描述",
      "status": "pending",
      "priority": "high|medium|low",
      "depends_on": [] // 依赖的任务id
    }
  ],
  "augmented_prompt": "增强后的prompt，告诉主代理执行计划时的注意事项"
}`;

    const response = await llm.call({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `用户请求：${userMessage}\n\n现有上下文：${JSON.stringify(context.summary)}` }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    });

    return JSON.parse(response.content);
  }

  // 提供给 Agent 的工具：更新任务状态
  getTodoToolDefinition() {
    return {
      type: "function",
      function: {
        name: "update_todos",
        description: "更新任务列表状态。在开始一个任务前标记为in_progress，完成后标记为completed。也可以添加新任务。",
        parameters: {
          type: "object",
          properties: {
            updates: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string", description: "任务ID，如task-1" },
                  status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                  content: { type: "string", description: "如果是新任务，填写任务描述" }
                },
                required: ["id", "status"]
              }
            }
          },
          required: ["updates"]
        }
      }
    };
  }
}
```

### 3.3 子代理系统 (Sub-Agents)

子代理是专门负责某一领域任务的"专家代理"，拥有自己独立的系统提示词和工具子集，完成后向主代理汇报结果。

#### 子代理类型定义

| 子代理名称 | 职责 | 可用工具 | 系统提示词特点 |
|-----------|------|---------|--------------|
| **DataCollectionAgent** | 采集专利数据（多专利局、批量查询） | parse_patent_number, fetch_patent, fetch_family, jpo_fetch, dpma_fetch | 擅长处理API错误、限流重试、多数据源整合 |
| **OCRProcessingAgent** | 批量下载文档 + OCR识别 | download_document, extract_text, merge_pdfs | 擅长并行下载、OCR质量检查、识别失败重试 |
| **PatentAnalystAgent** | 深度专利分析 | ai_summarize, analyze_single_doc, compare_patents, find_cited_refs | 拥有完整的专利分析prompt，输出结构化分析 |
| **ReportGenerationAgent** | 报告生成与导出 | generate_docx, generate_pdf, save_project, export_report | 擅长文档排版、格式规范、批量导出 |
| **SearchAgent** | 信息检索（代码/文档/网络） | search_codebase, grep_files, web_search | 擅长在现有项目文件、分析结果中搜索信息 |
| **FileOpsAgent** | 文件系统操作 | read_file, write_file, list_directory, create_dir | 安全的文件读写，防止越界访问 |

#### 子代理基类实现

```javascript
class SubAgent {
  constructor(config) {
    this.name = config.name;
    this.description = config.description;
    this.systemPrompt = config.systemPrompt;
    this.tools = config.tools; // 此子代理可用的工具子集
    this.llm = config.llm;
    this.maxSteps = config.maxSteps || 10;
    this.parentContext = null;
  }

  // 子代理作为主代理的一个"工具"被调用
  getToolDefinition() {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: this.getInputSchema(),
      }
    };
  }

  async execute(taskDescription, parentContext) {
    this.parentContext = parentContext;
    const messageHistory = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: taskDescription }
    ];

    this.emit("subagent:start", { agent: this.name, task: taskDescription });

    for (let step = 0; step < this.maxSteps; step++) {
      const response = await this.llm.call({
        messages: messageHistory,
        tools: this.tools,
        tool_choice: "auto",
        temperature: 0.1,
      });

      const message = response.message;
      messageHistory.push(message);

      // 子代理没有更多工具调用 = 完成，返回结果
      if (!message.tool_calls || message.tool_calls.length === 0) {
        this.emit("subagent:complete", { agent: this.name, result: message.content });
        return {
          success: true,
          agent: this.name,
          summary: message.content, // 返回给主代理的摘要
          full_history: messageHistory, // 完整历史（用于主代理检查）
          artifacts: this.getArtifacts(messageHistory), // 产出物（文件路径、数据ID等）
        };
      }

      // 执行工具（在子代理自己的上下文中）
      for (const toolCall of message.tool_calls) {
        const result = await this.executeToolWithinContext(toolCall, messageHistory);
        messageHistory.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
    }

    return {
      success: false,
      agent: this.name,
      error: "达到最大步骤限制",
    };
  }
}
```

#### 子代理注册示例（数据采集代理）

```javascript
function createDataCollectionAgent(toolRegistry, llm) {
  return new SubAgent({
    name: "data_collection_agent",
    description: "专利数据采集专家。负责从USPTO、Global Dossier、JPO、DPMA等多个数据源获取专利数据。处理API错误、限流、数据格式标准化。当需要获取一个或多个专利的基本信息、同族数据、审查文档列表时使用此代理。",
    llm,
    maxSteps: 15,
    systemPrompt: `你是专利数据采集专家。你的职责是准确获取专利数据。

工作规则：
1. 首先解析专利号，确认专利局和格式正确
2. 调用fetch_patent获取完整数据（包含同族+文档列表）
3. 如果USPTO/Global Dossier失败，尝试对应国家局API（JPO/DPMA）
4. 遇到API限流（429）自动等待重试，不要立即失败
5. 对于批量专利，逐个处理，记录失败项
6. 返回结果时，用简洁的中文总结获取到了什么数据、有哪些警告或失败项
7. 所有数据必须来自实际API调用，不要编造数据

输出格式要求：
- 总结获取到的数据概要
- 列出任何警告、失败或缺失数据
- 返回关键数据供后续分析代理使用`,
    tools: [
      toolRegistry.getToolDef("parse_patent_number"),
      toolRegistry.getToolDef("fetch_patent"),
      toolRegistry.getToolDef("fetch_family"),
      toolRegistry.getToolDef("fetch_documents"),
      toolRegistry.getToolDef("jpo_fetch_progress"),
      toolRegistry.getToolDef("dpma_register_info"),
      toolRegistry.getToolDef("think"), // 思考工具
    ],
  });
}
```

### 3.4 工具系统 (Tool System)

TRAE 级 Agent 拥有两大类工具：**领域工具**（专利相关）和**基础工具**（文件、思考、搜索等通用能力）。

#### 3.4.1 基础工具集（类似TRAE的核心工具）

这些是 Agent "思考、操作、探索"的基础能力：

```javascript
// ===== 1. think 工具（最重要的工具之一）=====
// 让 Agent 可以显式记录思考过程，帮助复杂推理
const thinkTool = {
  type: "function",
  function: {
    name: "think",
    description: "在执行复杂操作前，使用此工具记录你的思考过程。这对于需要多步推理、分析复杂情况、制定策略时非常有用。思考内容不会直接展示给用户，但会帮助你理清思路。",
    parameters: {
      type: "object",
      properties: {
        thought: {
          type: "string",
          description: "你的思考内容。可以分析当前情况、列出可选方案、评估风险、规划下一步等。"
        }
      },
      required: ["thought"]
    }
  }
};

// ===== 2. 文件读取 =====
const readFileTool = {
  type: "function",
  function: {
    name: "read_file",
    description: "读取本地文件内容。可以读取已保存的分析报告、配置文件、导出的文档等。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件绝对路径" },
        offset: { type: "number", description: "起始行号（大文件分页读取）" },
        limit: { type: "number", description: "读取行数" }
      },
      required: ["path"]
    }
  }
};

// ===== 3. 文件写入 =====
const writeFileTool = {
  type: "function",
  function: {
    name: "write_file",
    description: "写入内容到本地文件。用于保存分析结果、导出报告、保存项目配置等。注意：这是敏感操作，会覆盖现有文件。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件绝对路径" },
        content: { type: "string", description: "要写入的内容" },
        append: { type: "boolean", description: "是否追加模式（默认覆盖）", default: false }
      },
      required: ["path", "content"]
    },
    sensitive: true, // 标记为敏感操作，需要用户确认（如果文件已存在）
  }
};

// ===== 4. 列出目录 =====
const listDirTool = {
  type: "function",
  function: {
    name: "list_directory",
    description: "列出指定目录下的文件和子目录。用于查找已保存的分析项目、报告文件等。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目录绝对路径" }
      },
      required: ["path"]
    }
  }
};

// ===== 5. 搜索文件内容（类似Grep）=====
const grepSearchTool = {
  type: "function",
  function: {
    name: "search_in_files",
    description: "在已保存的分析报告、项目文件中搜索关键词。支持正则表达式。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "搜索模式（支持正则）" },
        path: { type: "string", description: "搜索目录路径" },
        file_type: { type: "string", description: "文件类型过滤，如 .md, .txt, .json" },
        case_insensitive: { type: "boolean", default: false }
      },
      required: ["pattern", "path"]
    }
  }
};

// ===== 6. 向用户提问 =====
const askUserTool = {
  type: "function",
  function: {
    name: "ask_user",
    description: "当你需要用户提供额外信息、在多个方案中做选择、或确认关键决策时，使用此工具向用户提问。不要在不需要时滥用此工具。",
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "问题内容" },
              header: { type: "string", description: "问题简短标签（如'分析范围'、'导出格式'）" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "选项标签" },
                    description: { type: "string", description: "选项说明" }
                  },
                  required: ["label", "description"]
                },
                description: "可选答案列表（2-4个选项）"
              },
              multiSelect: { type: "boolean", default: false, description: "是否允许多选" }
            },
            required: ["question", "header", "options", "multiSelect"]
          }
        }
      },
      required: ["questions"]
    }
  }
};

// ===== 7. UI操作：切换Tab =====
const switchTabTool = {
  type: "function",
  function: {
    name: "switch_to_tab",
    description: "切换界面到指定的Tab页，方便用户查看对应内容。",
    parameters: {
      type: "object",
      properties: {
        tab_name: {
          type: "string",
          enum: ["overview", "family", "documents", "ai_summary", "agent_chat"],
          description: "要切换到的Tab名称"
        },
        highlight: { type: "string", description: "可选：要高亮显示的元素ID或内容区域" }
      },
      required: ["tab_name"]
    }
  }
};

// ===== 8. 显示通知/预览 =====
const showNotificationTool = {
  type: "function",
  function: {
    name: "show_preview",
    description: "在界面上预览结果或打开文件给用户查看。",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["file", "url", "content", "report"], description: "预览类型" },
        path: { type: "string", description: "文件路径（type=file时必填）" },
        content: { type: "string", description: "内容（type=content时必填）" },
        title: { type: "string", description: "预览标题" }
      },
      required: ["type"]
    }
  }
};
```

#### 3.4.2 专利领域工具集

这些是在现有 Tauri 命令基础上封装的领域工具：

```javascript
// 专利工具集（包装现有 Tauri invoke）
const patentTools = [
  {
    type: "function",
    function: {
      name: "parse_patent_number",
      description: "解析专利号，识别专利局（US/CN/EP/JP/KR/WO/DE），返回标准化格式。处理任何专利查询前必须先调用此工具验证格式。",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "原始专利号输入" }
        },
        required: ["input"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "fetch_patent_data",
      description: "获取专利完整数据（基本信息+同族+文档列表）。数据会自动缓存。这是分析任何专利的第一步数据获取。",
      parameters: {
        type: "object",
        properties: {
          patent_number: { type: "string", description: "标准化专利号" },
          _todoId: { type: "string", description: "关联的任务ID（内部使用）" }
        },
        required: ["patent_number"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "download_and_ocr",
      description: "下载审查文档PDF并执行OCR文字识别，返回带溯源ID的结构化文本。用于获取可分析的文档内容。",
      parameters: {
        type: "object",
        properties: {
          country: { type: "string", description: "国家代码" },
          doc_number: { type: "string", description: "文献号" },
          doc_id: { type: "string", description: "文档ID（从fetch_patent_data获取）" },
          ocr_engine: {
            type: "string",
            enum: ["paddle_ocr_vl", "glm_ocr"],
            default: "paddle_ocr_vl",
            description: "OCR引擎选择"
          },
          _todoId: { type: "string" }
        },
        required: ["country", "doc_number", "doc_id"]
      },
      sensitive: false, // 单文档下载不需要确认
    }
  },
  {
    type: "function",
    function: {
      name: "batch_download_ocr",
      description: "批量下载并OCR多篇文档。这是敏感操作，会消耗较多API配额和时间。",
      parameters: {
        type: "object",
        properties: {
          documents: {
            type: "array",
            items: {
              type: "object",
              properties: {
                country: { type: "string" },
                doc_number: { type: "string" },
                doc_id: { type: "string" },
                doc_type: { type: "string", description: "文档类型（如CTNF审查意见、答复等）" }
              },
              required: ["country", "doc_number", "doc_id"]
            }
          },
          ocr_engine: { type: "string", default: "paddle_ocr_vl" },
          _todoId: { type: "string" }
        },
        required: ["documents"]
      },
      sensitive: true, // 批量操作需要用户确认
    }
  },
  {
    type: "function",
    function: {
      name: "ai_patent_analysis",
      description: "执行AI专利分析，生成结构化审查历史分析报告。支持多种分析深度。",
      parameters: {
        type: "object",
        properties: {
          patent_data: { type: "object", description: "fetch_patent_data返回的完整专利数据" },
          ocr_results: {
            type: "array",
            items: { type: "object" },
            description: "download_and_ocr返回的OCR结果数组"
          },
          analysis_type: {
            type: "string",
            enum: [
              "full_analysis",      // 完整分析（时间线+争议焦点+权利要求演变+无效机会）
              "quick_summary",      // 快速摘要（基本信息+当前状态+关键节点）
              "controversy_focus",  // 争议焦点分析
              "claim_evolution",    // 权利要求演变专题
              "cited_refs",         // 引用文献分析
              "single_doc"          // 单篇文档深度分析
            ],
            description: "分析类型"
          },
          focus_points: {
            type: "array",
            items: { type: "string" },
            description: "用户特别关注的焦点（如['创造性', '101适格性', '禁反言']）"
          },
          _todoId: { type: "string" }
        },
        required: ["patent_data", "analysis_type"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "export_report",
      description: "导出分析报告为文件（Word/PDF/Markdown）。",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "报告内容（Markdown格式）" },
          format: { type: "string", enum: ["docx", "pdf", "md"], description: "导出格式" },
          filename: { type: "string", description: "文件名（不含扩展名）" },
          patent_number: { type: "string", description: "相关专利号" },
          open_after_export: { type: "boolean", default: true, description: "导出后是否自动打开" }
        },
        required: ["content", "format", "filename"]
      },
      sensitive: true, // 写文件需要确认
    }
  },
];
```

### 3.5 思考过程与进度可视化

#### 3.5.1 三层状态展示

用户界面需要实时展示三个层次的信息：

```
┌─────────────────────────────────────────────────────────────────┐
│  🤖 PatentLens Agent                                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 📋 任务列表 (TodoList)                                   │   │
│  │ ✅ 解析专利号 US14412875                                 │   │
│  │ ✅ 获取专利基本信息和同族数据                             │   │
│  │ 🔄 下载并OCR关键审查文档 (2/4 完成)                      │   │
│  │ ⏳ 执行AI分析（争议焦点专题）                             │   │
│  │ ⏳ 生成并导出Word报告                                    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 💭 当前思考                                              │   │
│  │ 正在下载第3篇文档（CTNF Non-Final Rejection），          │   │
│  │ 这篇是第一次审查意见，包含了审查员引用的所有核心对比      │   │
│  │ 文献，对后续分析至关重要...                              │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 📊 进度                                                  │   │
│  │ ████████████░░░░░░░░░░  58%  · 预计剩余 2分钟           │   │
│  │ 当前：正在OCR识别 US14412875_CTNF_20180315.pdf          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 💬 对话                                                  │   │
│  │ 用户：帮我分析US14412875，重点看创造性争议，导出Word     │   │
│  │                                                                 │
│  │ 助手：好的，我来帮你分析这个专利。                       │   │
│  │  [自动切换到概览Tab] 已获取到专利基本信息：               │   │
│  │  - 申请人：XXX Inc.                                      │   │
│  │  - 当前状态：已授权                                      │   │
│  │  - 找到12篇审查文档，将下载其中4篇关键文档...            │   │
│  │                                                                 │
│  │ 助手：[自动切换到AI梳理Tab] 分析完成！以下是核心发现：    │   │
│  │  ### 争议焦点：权利要求1相对于D1的创造性                 │   │
│  │  ...                                                     │   │
│  │                                                                 │
│  │  💾 报告已导出：~/PatentLens/Reports/US14412875_分析.docx│   │
│  │  [打开文件] [打开所在文件夹]                              │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  💬 输入你的需求... [发送]                               │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

#### 3.5.2 事件总线（实现实时更新）

```javascript
class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    const callbacks = this.listeners.get(event) || [];
    callbacks.forEach(cb => {
      try { cb(data); } catch (e) { console.error(e); }
    });
  }
}

// 事件类型定义
const AgentEvents = {
  // 会话级
  SESSION_START: "session:start",
  SESSION_COMPLETE: "session:complete",
  SESSION_ERROR: "session:error",

  // 规划与任务
  TODOS_CREATED: "todos:created",
  TODOS_UPDATED: "todos:updated",
  TODO_IN_PROGRESS: "todo:in_progress",
  TODO_COMPLETED: "todo:completed",

  // 思考与状态
  THINKING_UPDATE: "thinking:update",
  STATUS_UPDATE: "status:update",
  PROGRESS_UPDATE: "progress:update",

  // 工具
  TOOL_START: "tool:start",
  TOOL_END: "tool:end",
  TOOL_ERROR: "tool:error",

  // 子代理
  SUBAGENT_START: "subagent:start",
  SUBAGENT_PROGRESS: "subagent:progress",
  SUBAGENT_COMPLETE: "subagent:complete",

  // 人机交互
  USER_QUESTION: "user:question",         // Agent向用户提问
  USER_APPROVAL: "user:approval",         // 请求用户确认
  SWITCH_TAB: "ui:switch_tab",            // 切换Tab
  SHOW_PREVIEW: "ui:show_preview",        // 显示预览

  // 流式输出
  STREAM_CHUNK: "stream:chunk",           // 最终回答的流式token
};
```

### 3.6 记忆系统 (Memory System)

```javascript
class AgentMemory {
  constructor() {
    this.sessions = new Map(); // sessionId -> SessionContext
    this.patentCache = new Map(); // patentNumber -> cached data
    this.userPreferences = this.loadPreferences();
  }

  createSession() {
    const sessionId = generateId();
    this.sessions.set(sessionId, {
      id: sessionId,
      createdAt: Date.now(),
      messageHistory: [],
      analyzedPatents: new Set(),
      artifacts: [], // 产生的文件、报告等
      currentPatentData: null,
      currentOcrResults: [],
    });
    return sessionId;
  }

  async buildContext(sessionId, userMessage) {
    const session = this.sessions.get(sessionId);

    // 提取消息中可能的专利号
    const patentNumbers = extractPatentNumbers(userMessage);

    // 从缓存加载已分析过的专利数据
    const cachedPatents = [];
    for (const pn of patentNumbers) {
      if (this.patentCache.has(pn)) {
        cachedPatents.push(this.patentCache.get(pn));
      }
    }

    return {
      sessionId,
      messageHistory: session.messageHistory,
      analyzedPatents: [...session.analyzedPatents],
      cachedPatents,
      userPreferences: this.userPreferences,
      summary: this.buildContextSummary(session, cachedPatents),
    };
  }

  // 自动缓存专利数据（工具执行后自动调用）
  cachePatentData(patentNumber, data) {
    this.patentCache.set(patentNumber, {
      data,
      cachedAt: Date.now(),
    });
  }
}
```

### 3.7 人机协作机制 (Human-in-the-Loop)

关键操作需要用户确认，问题不明确时主动提问：

```javascript
// 敏感工具判断
function isSensitiveTool(toolName, args) {
  const sensitiveTools = [
    "batch_download_ocr",  // 批量下载消耗配额
    "write_file",          // 写文件可能覆盖
    "export_report",       // 导出文件
    "execute_command",     // 执行命令
  ];

  if (sensitiveTools.includes(toolName)) return true;

  // write_file 如果文件已存在，也视为敏感
  if (toolName === "write_file" && args.path) {
    return fileExists(args.path);
  }

  return false;
}

// 用户确认对话框（类似TRAE的RequestAuthorization）
async function requestUserApproval(toolName, args) {
  return new Promise((resolve) => {
    const messages = {
      batch_download_ocr: `即将批量下载 ${args.documents.length} 篇文档并执行OCR，这可能需要几分钟时间并消耗API配额。是否继续？`,
      write_file: `文件 ${args.path} 已存在，是否覆盖？`,
      export_report: `即将导出报告到 ${args.filename}.${args.format}，是否继续？`,
    };

    eventBus.emit(AgentEvents.USER_APPROVAL, {
      toolName,
      args,
      message: messages[toolName] || `确认执行 ${toolName}？`,
      resolve, // UI层调用resolve(true/false)
    });
  });
}
```

---

## 四、前端UI集成方案

### 4.1 新增Agent Chat面板

在现有界面中增加一个Agent对话入口（可以是侧边栏、悬浮按钮、或新Tab）：

```html
<!-- 在现有 index.html 中新增 -->
<section id="agent-section" class="agent-section hidden">
  <!-- 任务列表面板 -->
  <div id="agent-todos-panel" class="agent-panel">
    <div class="panel-header">📋 任务进度</div>
    <div id="agent-todos-list" class="todos-list"></div>
    <div id="agent-progress-bar" class="progress-bar-container">
      <div class="progress-bar"></div>
      <span class="progress-text">准备中...</span>
    </div>
  </div>

  <!-- 思考过程面板（可折叠） -->
  <div id="agent-thinking-panel" class="agent-panel collapsible">
    <div class="panel-header collapsible-header">
      💭 思考过程 <span class="collapse-icon">▼</span>
    </div>
    <div id="agent-thinking-content" class="thinking-content collapsed"></div>
  </div>

  <!-- 对话区域 -->
  <div id="agent-chat-messages" class="chat-messages"></div>

  <!-- 用户提问对话框（动态插入） -->
  <div id="agent-question-modal" class="modal hidden">
    <!-- AskUserQuestion 动态渲染 -->
  </div>

  <!-- 确认对话框（动态插入） -->
  <div id="agent-approval-modal" class="modal hidden">
    <!-- 确认/取消按钮 -->
  </div>

  <!-- 输入区域 -->
  <div class="chat-input-area">
    <textarea
      id="agent-input"
      placeholder="输入你的需求，例如：帮我分析US14412875的审查历史，重点关注创造性争议，导出Word报告..."
      rows="2"
    ></textarea>
    <button id="agent-send-btn" class="btn-primary">发送</button>
    <button id="agent-stop-btn" class="btn-secondary hidden">停止</button>
  </div>
</section>

<!-- 悬浮Agent按钮 -->
<button id="agent-fab" class="agent-fab" title="打开AI助手">
  🤖
</button>
```

### 4.2 UI事件监听

```javascript
class AgentUI {
  constructor(agent) {
    this.agent = agent;
    this.bindEvents();
    this.setupAgentListeners();
  }

  setupAgentListeners() {
    // 任务列表更新
    this.agent.on(AgentEvents.TODOS_CREATED, ({ todos }) => {
      this.renderTodos(todos);
    });
    this.agent.on(AgentEvents.TODOS_UPDATED, ({ updates }) => {
      this.updateTodoStatus(updates);
    });
    this.agent.on(AgentEvents.TODO_COMPLETED, ({ todoId }) => {
      this.markTodoDone(todoId);
      this.updateProgressBar();
    });

    // 思考过程
    this.agent.on(AgentEvents.THINKING_UPDATE, ({ content }) => {
      this.appendThinking(content);
    });

    // 工具开始/结束 - 自动切换Tab
    this.agent.on(AgentEvents.TOOL_START, ({ toolName, args }) => {
      this.showToolInProgress(toolName, args);
      this.autoSwitchTabForTool(toolName);
    });

    // 流式回答
    this.agent.on(AgentEvents.STREAM_CHUNK, ({ content }) => {
      this.appendStreamingContent(content);
    });

    // 用户确认对话框
    this.agent.on(AgentEvents.USER_APPROVAL, ({ message, resolve }) => {
      this.showApprovalDialog(message, resolve);
    });

    // 用户提问
    this.agent.on(AgentEvents.USER_QUESTION, ({ questions, resolve }) => {
      this.showQuestionDialog(questions, resolve);
    });

    // 切换Tab
    this.agent.on(AgentEvents.SWITCH_TAB, ({ tab_name, highlight }) => {
      this.switchToMainTab(tab_name);
      if (highlight) this.highlightElement(highlight);
    });

    // 预览/打开文件
    this.agent.on(AgentEvents.SHOW_PREVIEW, ({ type, path, title }) => {
      if (type === "file") this.openFile(path);
    });
  }

  autoSwitchTabForTool(toolName) {
    const toolTabMap = {
      fetch_patent_data: "overview",
      parse_patent_number: "overview",
      download_and_ocr: "documents",
      batch_download_ocr: "documents",
      ai_patent_analysis: "ai_summary",
      export_report: "ai_summary",
    };
    const tab = toolTabMap[toolName];
    if (tab) {
      setTimeout(() => this.switchToMainTab(tab), 300);
    }
  }
}
```

---

## 五、目录结构与文件规划

```
src/
├── scripts/
│   ├── agent/                      # 🆕 Agent系统目录
│   │   ├── index.js                # Agent入口，对外暴露createPatentLensAgent
│   │   ├── orchestrator.js         # 主代理编排器
│   │   ├── planner.js              # 任务规划器（TodoList管理）
│   │   ├── memory.js               # 记忆系统
│   │   ├── event-bus.js            # 事件总线
│   │   ├── tool-registry.js        # 工具注册中心
│   │   ├── tool-executor.js        # 工具执行器（含重试/超时/校验）
│   │   ├── llm-client.js           # LLM统一客户端（支持流式+Function Calling）
│   │   ├── sub-agents/             # 子代理目录
│   │   │   ├── sub-agent-base.js   # 子代理基类
│   │   │   ├── data-collection.js  # 数据采集代理
│   │   │   ├── ocr-processing.js   # OCR处理代理
│   │   │   ├── patent-analyst.js   # 专利分析代理
│   │   │   ├── report-generation.js# 报告生成代理
│   │   │   ├── search-agent.js     # 搜索代理
│   │   │   └── file-ops.js         # 文件操作代理
│   │   ├── tools/                  # 工具定义目录
│   │   │   ├── index.js            # 工具汇总导出
│   │   │   ├── base-tools.js       # 基础工具（think/read_file/write_file/ask_user等）
│   │   │   ├── patent-tools.js     # 专利领域工具（封装Tauri命令）
│   │   │   ├── ui-tools.js         # UI操作工具（switch_tab/show_preview）
│   │   │   └── search-tools.js     # 搜索工具
│   │   ├── prompts/                # 提示词目录
│   │   │   ├── orchestrator.js     # 主代理系统提示词
│   │   │   ├── planner.js          # 规划器提示词
│   │   │   └── sub-agents/         # 子代理提示词
│   │   │       ├── data-collection.md
│   │   │       ├── ocr-processing.md
│   │   │       ├── patent-analyst.md
│   │   │       └── report-generation.md
│   │   └── ui/                     # Agent UI绑定
│   │       ├── chat-panel.js       # 聊天面板UI逻辑
│   │       ├── todo-renderer.js    # TodoList渲染
│   │       ├── thinking-panel.js   # 思考面板渲染
│   │       └── approval-dialog.js  # 确认/提问对话框
│   ├── web-ai.js                   # 现有AI模块（复用）
│   ├── web-app.js                  # 现有主逻辑（少量修改集成Agent）
│   └── ...
├── styles/
│   ├── main.css
│   └── agent.css                   # 🆕 Agent面板样式
└── index.html                      # 修改：添加Agent UI元素
```

---

## 六、系统提示词工程（System Prompts）

### 6.1 主代理系统提示词（核心）

```
你是 PatentLens Agent，一个专业的专利审查分析AI助手，集成在 PatentLens 桌面应用中。

## 你的身份
- 你是专利分析师的智能协作伙伴，不是聊天机器人
- 你的目标是帮助用户完成真实的专利分析工作，而不是泛泛而谈
- 你拥有完整的专利数据查询、文档下载、OCR识别、AI分析、报告生成工具

## 核心工作流程

### 当用户提出一个分析请求时，你必须按以下流程执行：

1. **理解需求，制定计划**
   - 使用 update_todos 工具创建清晰的任务列表
   - 任务数量控制在3-8个，不要太细也不要太粗
   - 让用户看到你要做什么

2. **数据采集阶段**
   - 先用 parse_patent_number 验证专利号格式
   - 用 fetch_patent_data 获取基础数据
   - 如果需要多篇专利数据，可以调度 data_collection_agent 子代理
   - 获取数据后，自动切换到对应Tab让用户看到结果

3. **文档处理阶段（如需要深度分析）**
   - 从文档列表中筛选关键文档（审查意见CTNF/CTF、申请人答复等）
   - 使用 download_and_ocr 或 batch_download_ocr 获取文本内容
   - 大量文档批量处理前，告知用户数量和预计时间
   - 如果需要并行处理多篇文档，调度 ocr_processing_agent 子代理

4. **分析阶段**
   - 使用 ai_patent_analysis 执行分析
   - 根据用户关注点选择合适的 analysis_type
   - 复杂分析可以调度 patent_analyst_agent 子代理
   - 分析过程中使用 think 工具记录你的分析思路（用户可以看到）

5. **交付阶段**
   - 将结果展示给用户（自动切换到AI梳理Tab）
   - 如果用户需要导出，使用 export_report 生成Word/PDF
   - 保存分析结果到项目文件
   - 询问用户是否需要进一步分析

## 工具使用规则

1. **think 工具**：在以下情况必须使用 think：
   - 开始复杂任务前，先理清思路
   - 遇到工具错误时，分析原因再决定下一步
   - 分析专利数据时，记录关键发现
   - 不确定用户意图时，分析可能的选项

2. **update_todos 工具**：
   - 开始执行计划时创建初始任务列表
   - 开始一个任务前标记为 in_progress
   - 完成一个任务后标记为 completed
   - 如果需要新任务，可以随时添加

3. **子代理调度**：遇到以下情况时使用子代理（而不是自己直接调工具）：
   - 批量处理3个以上专利 → data_collection_agent
   - 批量OCR 5篇以上文档 → ocr_processing_agent
   - 需要多维度深度分析 → patent_analyst_agent
   - 需要生成格式规范的正式报告 → report_generation_agent
   子代理返回结果后，你需要检查结果、整合信息、决定下一步。

4. **ask_user 工具**：当遇到以下情况时，主动询问用户：
   - 专利号格式有歧义，无法确定是哪个专利局
   - 用户需求不明确（如"帮我看看这个专利"，没说看什么方面）
   - 有多种分析方式，需要用户选择深度/范围
   - 批量操作前确认范围（如"找到20篇文档，是全部分析还是只看关键的？"）
   不要问已经能从上下文推断答案的问题。

5. **敏感操作确认**：以下操作需要用户确认（系统会自动弹出确认框，你不需要自己问）：
   - 批量下载超过3篇文档
   - 覆盖已存在的文件
   - 导出报告到默认位置

## 回答风格

- 专业但不生硬，像一个经验丰富的专利分析师同事
- 用中文回答（除非用户用其他语言）
- 分析结果要有条理，使用Markdown格式（标题、表格、列表）
- 每一个事实性结论必须标注来源【来源: block_id】
- 给出结论的同时，说明对竞争对手方的意义
- 执行过程中及时告知用户进展，不要让用户等待时什么都看不到

## 重要约束

- 绝对不能编造数据、编造专利内容、编造OCR结果
- 工具调用失败时如实告知用户，分析原因，建议解决方案
- 不要重复调用已经失败过且原因明确的工具（如API Key未配置）
- 所有分析必须基于工具返回的真实数据
- 引用对比文献时保留完整专利号格式（如US12345678B2）
```

---

## 七、实施路线图（分四个里程碑）

### 里程碑1：Agent基础框架（1周）
- [ ] 搭建 LLM Client（统一流式 Function Calling）
- [ ] 实现 EventBus 事件系统
- [ ] 实现基础 Tool Registry + Executor
- [ ] 实现最简 Tool Loop（无规划、无子代理）
- [ ] 封装3-5个核心专利工具
- [ ] 添加 think 基础工具
- [ ] 基础 Chat UI（输入框 + 消息展示）
- [ ] **验收**：能对话、能调用查询专利工具、简单流程跑通

### 里程碑2：任务规划 + 进度可视化（1周）
- [ ] 实现 TaskPlanner（自动拆解TodoList）
- [ ] 实现 update_todos 工具
- [ ] TodoList UI组件（状态实时更新）
- [ ] 进度条 + 状态展示
- [ ] 思考过程面板（可折叠）
- [ ] 工具执行状态显示
- [ ] UI Tab自动切换联动
- [ ] **验收**：输入"分析USxxx"能自动生成任务列表、按步骤执行、看到进度和思考过程

### 里程碑3：子代理系统 + 完整工具集（1-2周）
- [ ] 实现 SubAgent 基类
- [ ] 实现 DataCollectionAgent（数据采集代理）
- [ ] 实现 OCRProcessingAgent（文档处理代理）
- [ ] 实现 PatentAnalystAgent（分析代理）
- [ ] 实现 ReportGenerationAgent（报告代理）
- [ ] 补齐所有基础工具（read_file/write_file/ask_user/search等）
- [ ] 人机协作：敏感操作确认对话框
- [ ] 人机协作：AskUserQuestion 多选项提问
- [ ] 记忆系统（会话上下文、专利缓存）
- [ ] **验收**：复杂任务能自动调度子代理并行处理，关键操作会询问用户，能导出报告

### 里程碑4：生产级优化（1周）
- [ ] 错误自动重试 + 退避策略
- [ ] 超时控制 + 中断机制（停止按钮）
- [ ] 并行工具执行优化
- [ ] 用户偏好设置（默认导出格式、默认OCR引擎、分析模板）
- [ ] 项目保存/加载功能（分析到一半可以保存下次继续）
- [ ] 性能优化（缓存、并发控制）
- [ ] 日志与可观测性（记录Agent决策过程便于调优prompt）
- [ ] Prompt调优与测试用例
- [ ] **验收**：稳定可靠，达到TRAE级别的使用体验

---

## 八、关键设计决策说明

### 为什么不用LangChain/LangGraph？

你的场景和TRAE类似：**固定前端环境、工具集明确、需要精细控制UI联动**。LangChain带来的抽象层会：
1. 增加包体积（你的桌面应用不需要Node.js后端重型依赖）
2. 隐藏了Tool Loop的细节，难以做UI联动（实时进度、Tab切换、思考展示）
3. 子代理调度用代码写比用框架DSL更透明可控
4. TRAE本身也没有用LangChain，而是自己实现的轻量编排层

**核心Tool Loop只有约200行代码**，完全可控，方便调试和定制。

### 为什么子代理在前端实现而不是后端？

1. **复用现有AI配置**：用户的API Key、模型选择已经存在`localStorage`，在前端可以直接复用
2. **UI联动更直接**：子代理进度、思考过程可以直接推送给UI
3. **Tauri后端无LLM依赖**：当前Rust后端是纯数据API层，不引入LLM依赖保持架构清晰
4. **未来如果需要，可以将重型子代理（如批量处理100个专利）迁移到后端，前端保持轻量调度**

### 为什么think工具是"一等公民"？

你观察TRAE会发现，复杂任务中它会先"想清楚"再做。think工具的价值：
1. **帮助LLM进行Chain-of-Thought推理**：比隐式思考更稳定，尤其是多步骤复杂任务
2. **让用户看到Agent的"工作过程"**：增加信任感，而不是一个黑盒
3. **调试Prompt时非常有用**：可以看到Agent为什么做出某个决策

---

## 九、未来扩展方向

1. **MCP Server支持**：将PatentLens工具封装为MCP Server，这样可以在Claude Desktop、Cursor等外部AI工具中直接使用专利分析能力
2. **多会话/项目管理**：可以同时进行多个分析项目，保存工作进度
3. **分析模板系统**：用户可以保存常用的分析流程模板（如"无效分析模板"、"FTO分析模板"）
4. **定时监控Agent**：后台定期检查监控的专利，有新审查动作时通知用户
5. **多用户协作**：共享分析结果和注释（需要后端服务）
6. **本地模型支持**：集成Ollama，完全离线运行（需要小模型能稳定支持Function Calling）

---

*文档结束。这是一个完整的TRAE级别Agent架构，从核心编排到子代理、从工具系统到UI交互，覆盖了所有必要组件。可以开始按里程碑实施。*
