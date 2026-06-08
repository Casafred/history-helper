# PatentLens - 专利审查历史梳理工具

一款用于梳理多地区专利审查历史的桌面工具。支持专利号格式自动转换、通过 USPTO ODP API 获取审查历史、审查时间线可视化展示，后续将接入 AI 做审查内容智能梳理。

---

## 项目状态

| 版本 | 状态 | 说明 |
|------|------|------|
| v0.1.0 | 开发中 | MVP：专利号转换 + USPTO API 查询 + 审查历史展示 |

---

## 功能概览

| 功能 | 优先级 | 当前状态 | 说明 |
|------|--------|----------|------|
| 专利号格式转换 | P0 | ✅ 已实现 | 支持 US/CN/EP/JP/KR/WO 六局识别与格式化 |
| 美国专利审查历史查询 | P0 | ✅ 已实现 | 通过 USPTO ODP API 获取申请数据、审查事件、文档列表 |
| 审查时间线展示 | P0 | ✅ 已实现 | 按时间倒序展示审查事件，分类标记 |
| 审查文档列表与下载 | P0 | ✅ 已实现 | 列出所有审查文档，提供 PDF 下载链接 |
| 续案/分案关系展示 | P1 | ✅ 已实现 | 展示父案、子案关系链 |
| 同族专利查询 (Global Dossier) | P1 | 🔲 待开发 | IP5 五局同族审查信息 |
| AI 辅助内容梳理 | P2 | 🔲 待开发 | 审查意见摘要与智能分析 |
| 批量查询 | P2 | 🔲 待开发 | 批量输入专利号，逐个查询 |

---

## 技术栈

| 层级 | 技术 | 版本 | 用途 |
|------|------|------|------|
| 语言 | Rust | 2021 Edition | 后端全部逻辑 |
| 桌面框架 | Tauri | v2 | 桌面应用壳，Rust 后端 + WebView 前端 |
| HTTP 客户端 | reqwest | 0.12 | 调用 USPTO ODP API |
| 异步运行时 | tokio | 1 | async/await 支持 |
| 序列化 | serde / serde_json | 1.0 | JSON 解析与数据模型 |
| 错误处理 | thiserror | 2 | 自定义错误类型 |
| 前端 | HTML / CSS / JavaScript | - | Tauri 内嵌 WebView 渲染 |
| 环境变量 | dotenv | 0.15 | 读取 .env 中的 API 密钥 |

---

## 项目结构

```
history-helper/
├── docs/                                    # 项目文档（详见下方"文档体系"）
├── src/                                     # 前端代码
│   ├── index.html                           # 主页面
│   ├── styles/main.css                      # 暗色主题样式
│   └── scripts/app.js                       # 前端交互逻辑
├── src-tauri/                               # Rust 后端（Tauri 核心）
│   ├── Cargo.toml                           # Rust 依赖配置
│   ├── tauri.conf.json                      # Tauri 应用配置
│   ├── capabilities/default.json            # Tauri 权限声明
│   ├── build.rs                             # Tauri 构建脚本
│   └── src/
│       ├── main.rs                          # 程序入口
│       ├── lib.rs                           # Tauri 命令注册 + 状态管理
│       ├── api/
│       │   ├── mod.rs
│       │   └── uspto.rs                     # USPTO ODP API 客户端
│       ├── patent/
│       │   ├── mod.rs
│       │   └── converter.rs                 # 专利号格式转换（含单元测试）
│       ├── parser/
│       │   ├── mod.rs
│       │   └── office_action.rs             # 审查意见解析 + 时间线构建
│       └── models/
│           ├── mod.rs
│           └── patent.rs                    # 数据模型定义
├── .env.example                             # API 密钥模板
├── .gitignore                               # Git 忽略规则
├── package.json                             # npm 配置（Tauri CLI）
└── README.md                                # 本文件
```

---

## 文档体系

所有文档位于 `docs/` 目录，按编号阅读：

| 编号 | 文档 | 内容 |
|------|------|------|
| 01 | [项目概述与技术选型](docs/01-项目概述与技术选型.md) | 项目背景、需求分析、技术选型论证、版本规划 |
| 02 | [USPTO API 注册与使用指南](docs/02-USPTO-API注册与使用指南.md) | API 密钥申请、端点说明、认证方式、限流规则、常见文档代码 |
| 03 | [开发规范](docs/03-开发规范.md) | Git 规范、密钥管理、打包命名、代码风格、项目目录结构 |
| 04 | [交叉编译与打包指南](docs/04-交叉编译与打包指南.md) | cross 工具、GitHub Actions CI、打包检查清单 |
| 05 | [架构设计](docs/05-架构设计.md) | 系统架构、数据流、模块交互、前后端通信机制 |
| 06 | [开发者上手指南](docs/06-开发者上手指南.md) | 环境搭建、首次运行、调试方法、常见问题 |
| 07 | [API 数据模型与字段映射](docs/07-API数据模型与字段映射.md) | USPTO API 响应结构、Rust 数据模型、前端字段映射 |

---

## 快速开始

> 详细的步骤说明请参阅 [开发者上手指南](docs/06-开发者上手指南.md)

### 前置条件

- Rust 1.77.2+（`rustup` 安装）
- Node.js 18+（前端工具链）
- USPTO ODP API Key（[申请方式](docs/02-USPTO-API注册与使用指南.md)）

### 安装与运行

```bash
# 1. 克隆项目
git clone <repo-url>
cd history-helper

# 2. 配置 API 密钥
cp .env.example .env
# 编辑 .env，填入你的 USPTO_API_KEY

# 3. 安装前端依赖
npm install

# 4. 开发模式运行
npm run dev
```

### 构建

```bash
npm run build
```

---

## 核心设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 为什么选 Rust 而非 Python | Rust | 打包体积 <10MB、零依赖部署、无需安装运行时 |
| 为什么选 Tauri 而非 Electron | Tauri | 使用系统 WebView，体积仅 3-8MB vs Electron 100MB+ |
| 为什么用 ODP API 而非爬虫 | API | 官方接口稳定、结构化数据、不易触发反爬 |
| 为什么每次 API 调用间隔 1.5s | 限流保护 | USPTO 限流约 10-15 次/分钟，1.5s 间隔留有安全余量 |
| 为什么 API Key 存 .env 而非配置文件 | 安全 | .env 在 .gitignore 中，避免密钥泄露至远程仓库 |

---

## 许可证

内部使用。获取的专利文档仅限内部梳理使用，禁止对外传播或商用。
