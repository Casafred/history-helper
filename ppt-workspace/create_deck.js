const pptxgen = require("pptxgenjs");

// ── Theme ──────────────────────────────────────────────
const COLORS = {
  bg:          "0D1117",
  bgCard:      "161B22",
  bgCardAlt:   "1C2333",
  accent:      "58A6FF",
  accentGreen: "3FB950",
  accentOrange:"D29922",
  accentRed:   "F85149",
  accentPurple:"BC8CFF",
  text:        "E6EDF3",
  textSub:     "8B949E",
  border:      "30363D",
  white:       "FFFFFF",
};

const FONT = "Microsoft YaHei";
const FONT_MONO = "Consolas";

// ── Deck ───────────────────────────────────────────────
const pptx = new pptxgen();
pptx.layout = "LAYOUT_WIDE";
pptx.author = "PatentLens";
pptx.title  = "PatentLens 项目概览";

// ── Helpers ────────────────────────────────────────────
function addBg(slide) {
  slide.background = { color: COLORS.bg };
}

function addTitleBar(slide, title, subtitle) {
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: "100%", h: 1.1,
    fill: { color: COLORS.bgCard },
    line: { color: COLORS.border, width: 0.5 },
  });
  slide.addText(title, {
    x: 0.6, y: 0.15, w: 10, h: 0.55,
    fontSize: 24, fontFace: FONT, color: COLORS.white, bold: true,
  });
  if (subtitle) {
    slide.addText(subtitle, {
      x: 0.6, y: 0.65, w: 10, h: 0.35,
      fontSize: 12, fontFace: FONT, color: COLORS.textSub,
    });
  }
}

function addCard(slide, x, y, w, h, opts = {}) {
  slide.addShape(pptx.ShapeType.rect, {
    x, y, w, h,
    fill: { color: opts.fill || COLORS.bgCard },
    rectRadius: 0.1,
    line: { color: opts.border || COLORS.border, width: 0.75 },
    shadow: { type: "outer", blur: 6, offset: 2, color: "000000", opacity: 0.3 },
  });
}

function addIconBadge(slide, x, y, text, color) {
  slide.addShape(pptx.ShapeType.ellipse, {
    x, y, w: 0.45, h: 0.45,
    fill: { color },
    shadow: { type: "outer", blur: 3, offset: 1, color: "000000", opacity: 0.25 },
  });
  slide.addText(text, {
    x, y, w: 0.45, h: 0.45,
    fontSize: 14, fontFace: FONT, color: COLORS.white, bold: true,
    align: "center", valign: "middle",
  });
}

// ── Slide 1: Title ─────────────────────────────────────
{
  const slide = pptx.addSlide();
  addBg(slide);

  // Decorative top bar
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: "100%", h: 0.06,
    fill: { color: COLORS.accent },
  });

  // Logo circle
  slide.addShape(pptx.ShapeType.ellipse, {
    x: 5.55, y: 1.2, w: 1.9, h: 1.9,
    fill: { color: COLORS.accent },
    shadow: { type: "outer", blur: 12, offset: 4, color: "58A6FF", opacity: 0.35 },
  });
  slide.addText("PL", {
    x: 5.55, y: 1.2, w: 1.9, h: 1.9,
    fontSize: 48, fontFace: FONT, color: COLORS.white, bold: true,
    align: "center", valign: "middle",
  });

  slide.addText("PatentLens", {
    x: 1, y: 3.4, w: 11, h: 0.9,
    fontSize: 40, fontFace: FONT, color: COLORS.white, bold: true,
    align: "center",
  });
  slide.addText("专利审查文档获取与梳理工具", {
    x: 1, y: 4.3, w: 11, h: 0.55,
    fontSize: 20, fontFace: FONT, color: COLORS.accent,
    align: "center",
  });
  slide.addText("多专利局查询 · 审查时间线 · AI 智能梳理 · OCR 文字提取 · 全文翻译", {
    x: 1, y: 5.1, w: 11, h: 0.45,
    fontSize: 13, fontFace: FONT, color: COLORS.textSub,
    align: "center",
  });

  // Bottom bar
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 7.44, w: "100%", h: 0.06,
    fill: { color: COLORS.accent },
  });
}

// ── Slide 2: Pain Points & Solution ────────────────────
{
  const slide = pptx.addSlide();
  addBg(slide);
  addTitleBar(slide, "项目背景与痛点", "专利审查历史梳理的现状与挑战");

  const painPoints = [
    { icon: "1", color: COLORS.accentRed,    title: "多平台切换", desc: "美/中/欧/日/韩各局系统独立\n操作流程各异，效率低下" },
    { icon: "2", color: COLORS.accentOrange,  title: "格式转换繁琐", desc: "不同国家专利号格式不同\n手动转换容易出错" },
    { icon: "3", color: COLORS.accent,        title: "审查信息分散", desc: "同族专利在不同局的\n审查进度需分别查询" },
    { icon: "4", color: COLORS.accentPurple,  title: "梳理效率低", desc: "审查历史文档量大\n人工梳理耗时费力" },
  ];

  painPoints.forEach((p, i) => {
    const cx = 0.5 + i * 3.1;
    const cy = 1.5;
    addCard(slide, cx, cy, 2.8, 2.8, { fill: COLORS.bgCard });
    addIconBadge(slide, cx + 1.15, cy + 0.25, p.icon, p.color);
    slide.addText(p.title, {
      x: cx + 0.15, y: cy + 0.85, w: 2.5, h: 0.45,
      fontSize: 16, fontFace: FONT, color: COLORS.white, bold: true,
      align: "center",
    });
    slide.addText(p.desc, {
      x: cx + 0.15, y: cy + 1.4, w: 2.5, h: 1.2,
      fontSize: 11, fontFace: FONT, color: COLORS.textSub,
      align: "center", valign: "top", lineSpacingMultiple: 1.4,
    });
  });

  // Divider
  slide.addShape(pptx.ShapeType.rect, {
    x: 1.5, y: 4.65, w: 10, h: 0.04,
    fill: { color: COLORS.accent },
  });
  slide.addText("PatentLens 解决方案", {
    x: 3.5, y: 4.5, w: 5, h: 0.5,
    fontSize: 13, fontFace: FONT, color: COLORS.accent, bold: true,
    align: "center",
  });

  const solutions = [
    "统一入口查询 US/EP/JP/DE/CN 五局",
    "自动识别专利号类型并转换格式",
    "IP5 同族审查信息一站式展示",
    "AI 智能梳理审查意见与答复策略",
  ];
  solutions.forEach((s, i) => {
    const sx = 0.5 + i * 3.1;
    addCard(slide, sx, 5.15, 2.8, 0.7, { fill: COLORS.bgCardAlt });
    slide.addText(s, {
      x: sx + 0.15, y: 5.15, w: 2.5, h: 0.7,
      fontSize: 10.5, fontFace: FONT, color: COLORS.accentGreen,
      valign: "middle",
    });
  });
}

// ── Slide 3: Core Features ─────────────────────────────
{
  const slide = pptx.addSlide();
  addBg(slide);
  addTitleBar(slide, "核心功能特性", "12 项核心能力覆盖专利审查全流程");

  const features = [
    { title: "多专利局查询",     desc: "支持 US/EP/JP/DE/CN\n自动识别专利号类型", color: COLORS.accent },
    { title: "审查文档获取",     desc: "Global Dossier API\n自动分类归档", color: COLORS.accentGreen },
    { title: "审查时间线",       desc: "按时间倒序展示\n分类标记审查事件", color: COLORS.accentOrange },
    { title: "同族专利",         desc: "IP5 五局同族\n审查信息展示", color: COLORS.accentPurple },
    { title: "AI 智能梳理",     desc: "DeepSeek/GLM/OpenAI\n流式生成梳理报告", color: COLORS.accent },
    { title: "OCR 文字提取",    desc: "PaddleOCR-VL / GLM OCR\n双引擎版面识别", color: COLORS.accentGreen },
    { title: "全文翻译",         desc: "独立翻译模型\n流式实时显示", color: COLORS.accentOrange },
    { title: "阅读模式",         desc: "沉浸式阅读\n翻译/AI 对话面板", color: COLORS.accentPurple },
    { title: "AI 文档对话",     desc: "基于文档内容\n与 AI 实时对话", color: COLORS.accent },
    { title: "Word 导出",       desc: "审查报告导出\n自动填充概览信息", color: COLORS.accentGreen },
    { title: "溯源对照",         desc: "AI 结果溯源原文\n点击跳转对照", color: COLORS.accentOrange },
    { title: "浏览器扩展",       desc: "Chrome 扩展\nJ-PlatPat/DPMA 跳转", color: COLORS.accentPurple },
  ];

  features.forEach((f, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const cx = 0.4 + col * 3.15;
    const cy = 1.35 + row * 2.0;
    addCard(slide, cx, cy, 2.9, 1.75, { fill: COLORS.bgCard });

    // Color dot
    slide.addShape(pptx.ShapeType.ellipse, {
      x: cx + 0.15, y: cy + 0.2, w: 0.25, h: 0.25,
      fill: { color: f.color },
    });
    slide.addText(f.title, {
      x: cx + 0.5, y: cy + 0.15, w: 2.2, h: 0.35,
      fontSize: 13, fontFace: FONT, color: COLORS.white, bold: true,
      valign: "middle",
    });
    slide.addText(f.desc, {
      x: cx + 0.15, y: cy + 0.65, w: 2.6, h: 0.95,
      fontSize: 10, fontFace: FONT, color: COLORS.textSub,
      valign: "top", lineSpacingMultiple: 1.35,
    });
  });
}

// ── Slide 4: Architecture Diagram ──────────────────────
{
  const slide = pptx.addSlide();
  addBg(slide);
  addTitleBar(slide, "技术架构", "Electron + Tauri 双框架 · 前后端分离 · 多数据源集成");

  // Frontend Layer
  addCard(slide, 0.4, 1.35, 5.6, 2.8, { fill: "0D1F3C", border: COLORS.accent });
  slide.addText("前端层 (HTML / CSS / JS)", {
    x: 0.6, y: 1.45, w: 5.2, h: 0.4,
    fontSize: 13, fontFace: FONT, color: COLORS.accent, bold: true,
  });

  const feModules = [
    { name: "看板式管理", sub: "web-app.js" },
    { name: "AI 服务调用", sub: "web-ai.js" },
    { name: "文档分类映射", sub: "patent-status.js" },
    { name: "PDF 渲染", sub: "pdf.js + Canvas" },
    { name: "Markdown 渲染", sub: "marked.js" },
    { name: "Word 导出", sub: "docx.js" },
  ];
  feModules.forEach((m, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const mx = 0.6 + col * 1.8;
    const my = 2.0 + row * 0.95;
    addCard(slide, mx, my, 1.65, 0.8, { fill: COLORS.bgCard });
    slide.addText(m.name, {
      x: mx + 0.08, y: my + 0.05, w: 1.5, h: 0.35,
      fontSize: 9.5, fontFace: FONT, color: COLORS.white, bold: true,
    });
    slide.addText(m.sub, {
      x: mx + 0.08, y: my + 0.4, w: 1.5, h: 0.3,
      fontSize: 7.5, fontFace: FONT_MONO, color: COLORS.textSub,
    });
  });

  // Backend Layer
  addCard(slide, 6.3, 1.35, 5.8, 2.8, { fill: "1A0D2E", border: COLORS.accentPurple });
  slide.addText("后端层 (Rust / Node.js)", {
    x: 6.5, y: 1.45, w: 5.4, h: 0.4,
    fontSize: 13, fontFace: FONT, color: COLORS.accentPurple, bold: true,
  });

  const beModules = [
    { name: "USPTO API", sub: "api/uspto.rs" },
    { name: "Global Dossier", sub: "api/global_dossier.rs" },
    { name: "JPO / DPMA", sub: "api/jpo.rs / dpma.rs" },
    { name: "号码转换", sub: "patent/converter.rs" },
    { name: "文档解析", sub: "parser/office_action.rs" },
    { name: "SQLite 缓存", sub: "cache/sqlite.rs" },
  ];
  beModules.forEach((m, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const mx = 6.5 + col * 1.85;
    const my = 2.0 + row * 0.95;
    addCard(slide, mx, my, 1.7, 0.8, { fill: COLORS.bgCard });
    slide.addText(m.name, {
      x: mx + 0.08, y: my + 0.05, w: 1.55, h: 0.35,
      fontSize: 9.5, fontFace: FONT, color: COLORS.white, bold: true,
    });
    slide.addText(m.sub, {
      x: mx + 0.08, y: my + 0.4, w: 1.55, h: 0.3,
      fontSize: 7.5, fontFace: FONT_MONO, color: COLORS.textSub,
    });
  });

  // IPC indicator
  slide.addText("IPC / HTTP", {
    x: 4.8, y: 2.5, w: 2.4, h: 0.5,
    fontSize: 11, fontFace: FONT, color: COLORS.accentOrange, bold: true,
    align: "center", valign: "middle",
  });

  // Data Source Layer
  addCard(slide, 0.4, 4.45, 11.7, 1.5, { fill: "0D2E1A", border: COLORS.accentGreen });
  slide.addText("数据源 & 外部服务", {
    x: 0.6, y: 4.55, w: 5, h: 0.35,
    fontSize: 13, fontFace: FONT, color: COLORS.accentGreen, bold: true,
  });

  const dataSources = [
    { name: "USPTO ODP API", desc: "美国专利全量数据" },
    { name: "Global Dossier", desc: "IP5 同族审查信息" },
    { name: "DeepSeek / GLM", desc: "AI 梳理与对话" },
    { name: "PaddleOCR-VL", desc: "免费 OCR 引擎" },
    { name: "GLM OCR", desc: "高精度 OCR 引擎" },
  ];
  dataSources.forEach((d, i) => {
    const dx = 0.6 + i * 2.3;
    addCard(slide, dx, 5.0, 2.1, 0.75, { fill: COLORS.bgCard });
    slide.addText(d.name, {
      x: dx + 0.1, y: 5.02, w: 1.9, h: 0.35,
      fontSize: 10, fontFace: FONT, color: COLORS.white, bold: true,
    });
    slide.addText(d.desc, {
      x: dx + 0.1, y: 5.37, w: 1.9, h: 0.3,
      fontSize: 8.5, fontFace: FONT, color: COLORS.textSub,
    });
  });

  // Desktop Framework
  addCard(slide, 0.4, 6.2, 5.6, 0.85, { fill: "2A1A0D", border: COLORS.accentOrange });
  slide.addText("桌面框架", {
    x: 0.6, y: 6.25, w: 1.5, h: 0.35,
    fontSize: 11, fontFace: FONT, color: COLORS.accentOrange, bold: true,
  });
  slide.addText("Electron (当前)  /  Tauri v2 (备选)", {
    x: 0.6, y: 6.6, w: 5.2, h: 0.3,
    fontSize: 10, fontFace: FONT, color: COLORS.textSub,
  });

  // Output formats
  addCard(slide, 6.3, 6.2, 5.8, 0.85, { fill: "1A0D2E", border: COLORS.accentPurple });
  slide.addText("输出格式", {
    x: 6.5, y: 6.25, w: 1.5, h: 0.35,
    fontSize: 11, fontFace: FONT, color: COLORS.accentPurple, bold: true,
  });
  slide.addText("Word (.docx)  /  PDF  /  Markdown  /  翻译对照", {
    x: 6.5, y: 6.6, w: 5.4, h: 0.3,
    fontSize: 10, fontFace: FONT, color: COLORS.textSub,
  });
}

// ── Slide 5: Workflow ──────────────────────────────────
{
  const slide = pptx.addSlide();
  addBg(slide);
  addTitleBar(slide, "工作流程", "从专利号输入到审查报告导出的完整链路");

  const steps = [
    { num: "01", color: COLORS.accent,       title: "输入专利号",     desc: "输入 US/EP/JP/DE/CN\n专利号，系统自动\n识别专利局与类型" },
    { num: "02", color: COLORS.accentGreen,   title: "获取审查数据",   desc: "调用 USPTO / Global\nDossier API，获取\n审查历史与文档列表" },
    { num: "03", color: COLORS.accentOrange,  title: "时间线展示",     desc: "按时间倒序展示\n审查事件，自动分类\n标记文档类型" },
    { num: "04", color: COLORS.accentPurple,  title: "OCR 文字提取",  desc: "PaddleOCR-VL 或\nGLM OCR 引擎提取\nPDF 文档文字内容" },
    { num: "05", color: COLORS.accent,        title: "AI 智能梳理",   desc: "DeepSeek / GLM /\nOpenAI 流式生成\n审查意见梳理报告" },
    { num: "06", color: COLORS.accentGreen,   title: "溯源与导出",     desc: "AI 结果溯源原文\n对照阅读，导出\nWord / 翻译报告" },
  ];

  steps.forEach((s, i) => {
    const cx = 0.35 + i * 2.05;
    const cy = 1.5;

    addCard(slide, cx, cy, 1.85, 3.2, { fill: COLORS.bgCard });

    // Number badge
    slide.addShape(pptx.ShapeType.ellipse, {
      x: cx + 0.6, y: cy + 0.2, w: 0.65, h: 0.65,
      fill: { color: s.color },
      shadow: { type: "outer", blur: 4, offset: 1, color: "000000", opacity: 0.3 },
    });
    slide.addText(s.num, {
      x: cx + 0.6, y: cy + 0.2, w: 0.65, h: 0.65,
      fontSize: 16, fontFace: FONT, color: COLORS.white, bold: true,
      align: "center", valign: "middle",
    });

    slide.addText(s.title, {
      x: cx + 0.1, y: cy + 1.05, w: 1.65, h: 0.4,
      fontSize: 12, fontFace: FONT, color: COLORS.white, bold: true,
      align: "center",
    });
    slide.addText(s.desc, {
      x: cx + 0.1, y: cy + 1.55, w: 1.65, h: 1.5,
      fontSize: 9.5, fontFace: FONT, color: COLORS.textSub,
      align: "center", valign: "top", lineSpacingMultiple: 1.4,
    });

    // Arrow
    if (i < steps.length - 1) {
      slide.addText(">", {
        x: cx + 1.85, y: cy + 1.3, w: 0.2, h: 0.4,
        fontSize: 16, color: COLORS.accent, bold: true,
        align: "center", valign: "middle",
      });
    }
  });

  // Parallel features
  slide.addText("并行能力", {
    x: 0.5, y: 5.0, w: 2, h: 0.35,
    fontSize: 12, fontFace: FONT, color: COLORS.accentOrange, bold: true,
  });

  const parallelFeatures = [
    { name: "全文翻译", desc: "独立翻译模型，流式实时显示" },
    { name: "AI 文档对话", desc: "基于当前文档与 AI 实时对话" },
    { name: "同族专利查询", desc: "IP5 五局同族审查信息" },
    { name: "浏览器扩展", desc: "J-PlatPat / DPMA 一键跳转" },
  ];
  parallelFeatures.forEach((f, i) => {
    const px = 0.5 + i * 3.05;
    addCard(slide, px, 5.45, 2.8, 0.9, { fill: COLORS.bgCardAlt });
    slide.addText(f.name, {
      x: px + 0.15, y: 5.48, w: 2.5, h: 0.35,
      fontSize: 11, fontFace: FONT, color: COLORS.white, bold: true,
    });
    slide.addText(f.desc, {
      x: px + 0.15, y: 5.83, w: 2.5, h: 0.4,
      fontSize: 9, fontFace: FONT, color: COLORS.textSub,
    });
  });
}

// ── Slide 6: Document Classification ───────────────────
{
  const slide = pptx.addSlide();
  addBg(slide);
  addTitleBar(slide, "文档智能分类", "自动识别审查文档类型，颜色标记一目了然");

  const categories = [
    { color: COLORS.accentRed,    type: "审查意见",     examples: "驳回、限制性要求等",       tag: "CTNF / CTF / REST" },
    { color: COLORS.accent,       type: "申请人答复",   examples: "修改、意见陈述等",         tag: "RESP / AMDT" },
    { color: COLORS.accentGreen,  type: "授权通知",     examples: "授权通知、授权决定等",     tag: "NTCE / WDEC" },
    { color: COLORS.accentOrange, type: "申请人请求",   examples: "RCE、审查请求等",          tag: "RCE / EX.RQ" },
    { color: COLORS.textSub,      type: "通知",         examples: "官方通知类文件",           tag: "CTFR / EX.Q" },
    { color: "6E7681",            type: "其他文件",     examples: "说明书、权利要求等",       tag: "SPEC / CLMS" },
  ];

  categories.forEach((c, i) => {
    const cy = 1.4 + i * 0.95;
    addCard(slide, 0.5, cy, 11.4, 0.8, { fill: COLORS.bgCard });

    // Color bar
    slide.addShape(pptx.ShapeType.rect, {
      x: 0.5, y: cy, w: 0.12, h: 0.8,
      fill: { color: c.color },
      rectRadius: 0.06,
    });

    slide.addText(c.type, {
      x: 0.85, y: cy + 0.05, w: 2.2, h: 0.35,
      fontSize: 14, fontFace: FONT, color: c.color, bold: true,
    });
    slide.addText(c.examples, {
      x: 0.85, y: cy + 0.4, w: 2.2, h: 0.3,
      fontSize: 9.5, fontFace: FONT, color: COLORS.textSub,
    });

    // Code tag
    addCard(slide, 3.3, cy + 0.15, 2.5, 0.5, { fill: COLORS.bgCardAlt, border: c.color });
    slide.addText(c.tag, {
      x: 3.3, y: cy + 0.15, w: 2.5, h: 0.5,
      fontSize: 10, fontFace: FONT_MONO, color: c.color,
      align: "center", valign: "middle",
    });

    // Dot
    slide.addShape(pptx.ShapeType.ellipse, {
      x: 6.2, y: cy + 0.2, w: 0.4, h: 0.4,
      fill: { color: c.color },
    });

    const mappingDescs = [
      "US/EP/JP/DE/CN 五局文档代码映射",
      "自动识别答复类型与修改内容",
      "授权/注册通知自动标记",
      "RCE 等请求自动归类",
      "官方通知与审查意见区分",
      "说明书等非审查文档归类",
    ];
    slide.addText(mappingDescs[i], {
      x: 6.85, y: cy + 0.05, w: 4.8, h: 0.35,
      fontSize: 10.5, fontFace: FONT, color: COLORS.text,
    });
    slide.addText("支持 US / EP / JP / DE / CN 五局文档代码自动映射与分类", {
      x: 6.85, y: cy + 0.4, w: 4.8, h: 0.3,
      fontSize: 8.5, fontFace: FONT, color: COLORS.textSub,
    });
  });
}

// ── Slide 7: AI & OCR Capabilities ─────────────────────
{
  const slide = pptx.addSlide();
  addBg(slide);
  addTitleBar(slide, "AI 与 OCR 能力矩阵", "多引擎支持 · 灵活配置 · 流式响应");

  // AI Services
  addCard(slide, 0.4, 1.35, 5.8, 3.0, { fill: COLORS.bgCard, border: COLORS.accent });
  slide.addText("AI 智能梳理服务", {
    x: 0.6, y: 1.45, w: 5.4, h: 0.4,
    fontSize: 14, fontFace: FONT, color: COLORS.accent, bold: true,
  });

  const aiServices = [
    { provider: "DeepSeek", model: "deepseek-chat", transModel: "deepseek-v4-flash", url: "api.deepseek.com" },
    { provider: "智谱 AI (GLM)", model: "glm-4-plus", transModel: "glm-4-flash", url: "open.bigmodel.cn" },
    { provider: "OpenAI 兼容", model: "gpt-4o", transModel: "gpt-4o-mini", url: "可自定义" },
  ];
  aiServices.forEach((a, i) => {
    const ay = 2.0 + i * 0.75;
    addCard(slide, 0.6, ay, 5.4, 0.65, { fill: COLORS.bgCardAlt });
    slide.addText(a.provider, {
      x: 0.75, y: ay + 0.03, w: 1.8, h: 0.3,
      fontSize: 11, fontFace: FONT, color: COLORS.white, bold: true,
    });
    slide.addText("分析: " + a.model + "  |  翻译: " + a.transModel, {
      x: 0.75, y: ay + 0.33, w: 3.5, h: 0.25,
      fontSize: 8.5, fontFace: FONT_MONO, color: COLORS.textSub,
    });
    slide.addText(a.url, {
      x: 4.0, y: ay + 0.05, w: 1.9, h: 0.25,
      fontSize: 8, fontFace: FONT_MONO, color: COLORS.accent,
      align: "right",
    });
  });

  const aiFeatures = ["SSE 流式响应", "自定义提示词", "溯源对照阅读", "AI 文档对话"];
  aiFeatures.forEach((f, i) => {
    const fx = 0.6 + i * 1.4;
    slide.addText(f, {
      x: fx, y: 4.25, w: 1.35, h: 0.25,
      fontSize: 8.5, fontFace: FONT, color: COLORS.accentGreen,
    });
  });

  // OCR Services
  addCard(slide, 6.5, 1.35, 5.6, 3.0, { fill: COLORS.bgCard, border: COLORS.accentGreen });
  slide.addText("OCR 文字提取引擎", {
    x: 6.7, y: 1.45, w: 5.2, h: 0.4,
    fontSize: 14, fontFace: FONT, color: COLORS.accentGreen, bold: true,
  });

  const ocrEngines = [
    { name: "PaddleOCR-VL", desc: "免费，无需 API Key\n版面识别与文字提取", tag: "免费", tagColor: COLORS.accentGreen },
    { name: "GLM OCR", desc: "需智谱 API Key\n识别精度更高", tag: "高精度", tagColor: COLORS.accentOrange },
  ];
  ocrEngines.forEach((o, i) => {
    const oy = 2.05 + i * 1.1;
    addCard(slide, 6.7, oy, 5.2, 0.95, { fill: COLORS.bgCardAlt });
    slide.addText(o.name, {
      x: 6.85, y: oy + 0.05, w: 2.5, h: 0.35,
      fontSize: 12, fontFace: FONT, color: COLORS.white, bold: true,
    });
    slide.addText(o.desc, {
      x: 6.85, y: oy + 0.4, w: 3.0, h: 0.5,
      fontSize: 9, fontFace: FONT, color: COLORS.textSub, lineSpacingMultiple: 1.3,
    });
    addCard(slide, 10.3, oy + 0.15, 1.4, 0.35, { fill: o.tagColor });
    slide.addText(o.tag, {
      x: 10.3, y: oy + 0.15, w: 1.4, h: 0.35,
      fontSize: 9, fontFace: FONT, color: COLORS.white, bold: true,
      align: "center", valign: "middle",
    });
  });

  const ocrFeatures = ["噪音符号清理", "PDF 版面识别", "自动段落还原", "异步 API 调用"];
  ocrFeatures.forEach((f, i) => {
    const fx = 6.7 + i * 1.4;
    slide.addText(f, {
      x: fx, y: 4.25, w: 1.35, h: 0.25,
      fontSize: 8.5, fontFace: FONT, color: COLORS.accentGreen,
    });
  });

  // Translation
  addCard(slide, 0.4, 4.7, 11.7, 1.2, { fill: COLORS.bgCard, border: COLORS.accentOrange });
  slide.addText("全文翻译", {
    x: 0.6, y: 4.8, w: 2, h: 0.35,
    fontSize: 14, fontFace: FONT, color: COLORS.accentOrange, bold: true,
  });
  const transFeatures = [
    "独立翻译模型配置（可与 AI 分析模型不同）",
    "全文合并翻译，不分页不分块",
    "流式实时显示翻译结果",
    "翻译对照阅读模式",
  ];
  transFeatures.forEach((f, i) => {
    const tx = 0.6 + (i % 2) * 5.8;
    const ty = 5.2 + Math.floor(i / 2) * 0.3;
    slide.addText(f, {
      x: tx, y: ty, w: 5.6, h: 0.25,
      fontSize: 10, fontFace: FONT, color: COLORS.text,
    });
  });
}

// ── Slide 8: Summary ───────────────────────────────────
{
  const slide = pptx.addSlide();
  addBg(slide);

  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: "100%", h: 0.06,
    fill: { color: COLORS.accent },
  });

  slide.addText("PatentLens", {
    x: 1, y: 1.0, w: 11, h: 0.8,
    fontSize: 36, fontFace: FONT, color: COLORS.white, bold: true,
    align: "center",
  });
  slide.addText("专利审查文档获取与梳理工具 — 项目总览", {
    x: 1, y: 1.8, w: 11, h: 0.5,
    fontSize: 16, fontFace: FONT, color: COLORS.accent,
    align: "center",
  });

  const summaryItems = [
    { num: "5+", label: "支持专利局", sub: "US / EP / JP / DE / CN" },
    { num: "12", label: "核心功能", sub: "查询 / 获取 / 梳理 / 翻译 / 导出" },
    { num: "3", label: "AI 服务商", sub: "DeepSeek / GLM / OpenAI" },
    { num: "2", label: "OCR 引擎", sub: "PaddleOCR-VL / GLM OCR" },
  ];
  summaryItems.forEach((s, i) => {
    const sx = 0.8 + i * 3.0;
    addCard(slide, sx, 2.7, 2.7, 1.6, { fill: COLORS.bgCard });
    slide.addText(s.num, {
      x: sx, y: 2.8, w: 2.7, h: 0.7,
      fontSize: 32, fontFace: FONT, color: COLORS.accent, bold: true,
      align: "center",
    });
    slide.addText(s.label, {
      x: sx, y: 3.45, w: 2.7, h: 0.35,
      fontSize: 14, fontFace: FONT, color: COLORS.white, bold: true,
      align: "center",
    });
    slide.addText(s.sub, {
      x: sx, y: 3.8, w: 2.7, h: 0.35,
      fontSize: 9, fontFace: FONT, color: COLORS.textSub,
      align: "center",
    });
  });

  // Key highlights
  addCard(slide, 0.8, 4.65, 11.0, 1.8, { fill: COLORS.bgCard });
  slide.addText("核心价值", {
    x: 1.0, y: 4.75, w: 3, h: 0.35,
    fontSize: 14, fontFace: FONT, color: COLORS.accentGreen, bold: true,
  });

  const values = [
    ["统一入口", "多专利局审查信息一站式查询，告别多平台切换"],
    ["智能梳理", "AI 自动提取审查意见要点，生成结构化梳理报告"],
    ["精准溯源", "AI 分析结果可溯源至原文位置，点击跳转对照阅读"],
    ["灵活配置", "多 AI/OCR 引擎可选，独立翻译模型，自定义提示词"],
  ];
  values.forEach((v, i) => {
    const vx = 1.0 + (i % 2) * 5.4;
    const vy = 5.2 + Math.floor(i / 2) * 0.55;
    slide.addText(v[0], {
      x: vx, y: vy, w: 1.3, h: 0.35,
      fontSize: 11, fontFace: FONT, color: COLORS.accent, bold: true,
    });
    slide.addText(v[1], {
      x: vx + 1.3, y: vy, w: 4.0, h: 0.35,
      fontSize: 10, fontFace: FONT, color: COLORS.textSub,
    });
  });

  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 7.44, w: "100%", h: 0.06,
    fill: { color: COLORS.accent },
  });
}

// ── Write ──────────────────────────────────────────────
const outPath = "/workspace/ppt-workspace/PatentLens-Overview.pptx";
pptx.writeFile({ fileName: outPath }).then(() => {
  console.log("Deck written to:", outPath);
}).catch(err => {
  console.error("Error:", err);
});
