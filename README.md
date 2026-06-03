# PatentLens - 专利审查文档获取与梳理

一款面向侵权分析视角的专利审查文档获取与 AI 梳理工具。支持 US/EP/CN/DE/JP 五局专利审查历史查询、文档提取、AI 智能分析，帮助被控侵权方评估专利授权稳定性与规避空间。

---

## 功能概览

| 功能 | 状态 | 说明 |
|------|------|------|
| 多局专利号查询 | ✅ 已实现 | 支持 US/EP/CN/DE/JP，自动识别申请号/公开号/专利号 |
| 专利概览 | ✅ 已实现 | 当前状态、申请日、发明人、优先权、同族信息 |
| 同族专利展示 | ✅ 已实现 | Global Dossier 同族成员一览 |
| 审查文档六栏分类 | ✅ 已实现 | 审查意见/申请人答复/授权通知/通知/请求/其他，含搜索筛选 |
| 审查文档 OCR 提取 | ✅ 已实现 | PaddleOCR-VL + GLM OCR 双引擎，支持 PDF 文档内容提取 |
| AI 审查梳理 | ✅ 已实现 | 侵权分析视角，表格化审查轮次、权利要求演变、风险评级 |
| AI 单文档分析 | ✅ 已实现 | 档案历史禁反言分析、规避设计建议 |
| 溯源对照阅读 | ✅ 已实现 | AI 分析标注来源段落，点击跳转原文对照 |
| 审查文档中文翻译 | ✅ 已实现 | US/EP/CN/DE/JP 五局文档代码翻译与分类 |
| 审查时间线 | ✅ 已实现 | 按时间倒序展示审查事件 |
| 文档批量提取 | ✅ 已实现 | 一键批量 OCR 提取所有审查文档 |
| 文档下载与导出 | ✅ 已实现 | PDF 下载 + Word 导出 |
| AI 服务商配置 | ✅ 已实现 | 支持 OpenAI / DeepSeek / 自定义兼容接口 |
| Tauri 桌面端 | 🔄 开发中 | 桌面应用打包，部分功能待完善 |

---

## 待完善功能

| 功能 | 优先级 | 说明 |
|------|--------|------|
| Tauri 桌面端闪退修复 | P0 | 安装后启动闪退，需排查 Rust 端 panic |
| 批量专利号查询 | P1 | 支持一次输入多个专利号批量查询 |
| 审查文档缓存 | P1 | OCR 提取结果本地缓存，避免重复提取 |
| 更多 AI 模型支持 | P2 | Claude、Gemini 等 |
| 审查意见对比视图 | P2 | 同一权利要求在不同轮次的变化对比 |
| 导出报告模板 | P2 | 自定义 Word/PDF 报告模板 |
| 暗色/亮色主题切换 | P3 | 当前仅暗色主题 |
| 国际化 (i18n) | P3 | 界面语言切换 |

---

## 技术栈

| 层级 | 技术 | 用途 |
|------|------|------|
| 前端 | HTML / CSS / JavaScript | 页面渲染与交互 |
| 后端 | Node.js (server.js) | Web 版 API 代理服务器 |
| 桌面端 | Tauri v2 (Rust) | 桌面应用壳 |
| OCR | PaddleOCR-VL / GLM OCR | PDF 文档内容提取 |
| AI | OpenAI / DeepSeek API | 审查意见智能梳理 |
| 数据源 | Global Dossier API | USPTO 五局审查历史数据 |

---

## 项目结构

```
patentlens/
├── server.js                    # Web 版 Node.js 代理服务器
├── extract_pdf.py               # OCR 提取脚本 (PaddleOCR-VL)
├── src/
│   ├── web.html                 # Web 版主页面
│   ├── index.html               # Electron/Tauri 版主页面
│   ├── styles/main.css          # 暗色主题样式
│   └── scripts/
│       ├── web-app.js           # 核心前端逻辑
│       ├── web-ai.js            # AI 提示词与配置管理
│       └── patent-status.js     # 审查状态翻译与分类
├── src-tauri/                   # Tauri 桌面端
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── src/
│       ├── lib.rs               # Tauri 入口
│       ├── proxy.rs             # API 代理服务器
│       ├── ocr/                 # OCR 模块
│       ├── api/                 # API 客户端
│       ├── patent/              # 专利号解析
│       ├── cache/               # 缓存管理
│       └── models/              # 数据模型
├── .env.example                 # 环境变量模板
└── README.md
```

---

## 快速开始

### Web 版

```bash
# 1. 安装依赖
pip3 install requests paddleocr  # OCR 引擎
npm install                       # 前端依赖（如需）

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 GLM_API_KEY（OCR 用）等

# 3. 启动服务器
node server.js

# 4. 打开浏览器访问
# http://localhost:8080
```

### Tauri 桌面版

```bash
# 1. 安装 Rust 和 Tauri CLI
rustup default stable
npm install

# 2. 开发模式
npm run tauri dev

# 3. 构建
npm run tauri build
```

---

## AI 配置

在设置面板中配置 AI 服务商：

| 服务商 | 需要配置 | 说明 |
|--------|---------|------|
| OpenAI | API Key, Base URL | 支持 GPT-4 等模型 |
| DeepSeek | API Key | 性价比高，推荐 |
| 自定义 | API Key, Base URL, Model | 兼容 OpenAI 接口即可 |

---

## 支持的专利号格式

| 格式 | 示例 | 自动识别 |
|------|------|---------|
| US 专利号 | US12030161B2 | B1/B2 后缀 → patent 查询 |
| US 公开号 | US20220301610A1 | A1/A2 后缀 → publication 查询 |
| US 申请号 | US17204063 | 纯数字 → application 查询 |
| EP 公开号 | EP4252965A3 | 有 kind code → publication 查询 |
| CN 公开号 | CN114346969B | 有 kind code → publication 查询 |
| DE 公开号 | DE102021126285A1 | 有 kind code → publication 查询 |
| JP 公开号 | JP7535905B2 | 有 kind code → publication 查询 |

---

## 许可证

内部使用。获取的专利文档仅限内部梳理使用，禁止对外传播或商用。
