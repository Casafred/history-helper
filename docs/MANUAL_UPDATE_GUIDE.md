# 说明书更新必读指南

本文件为 PatentLens 说明书更新的操作规范，每次更新说明书前必须阅读并遵循。

---

## 1 PDF 生成工具选择

### 1.1 必须使用 WeasyPrint

禁止使用 wkhtmltopdf，原因如下：

| 问题 | wkhtmltopdf | WeasyPrint |
|------|-------------|------------|
| 中文字体 | 容易丢失文字（显示为空白） | 正确嵌入字体，文字可见 |
| 文字可复制 | 可能不可复制 | 文字可正常复制 |
| PDF 书签目录 | 需要补丁版 Qt，标准版不支持 | 自动从 `<h1>` `<h2>` `<h3>` 生成书签 |
| CSS 支持 | 部分现代 CSS 不支持 | 支持更完整的 CSS 规范 |

### 1.2 安装依赖

```bash
# 1. 安装中文字体（必须！否则 PDF 中文全部空白）
apt-get install -y fonts-noto-cjk fonts-noto-cjk-extra
fc-cache -f -v

# 2. 安装 WeasyPrint
pip3 install weasyprint
```

### 1.3 生成 PDF 命令

```bash
cd /workspace
python3 -c "
from weasyprint import HTML
HTML(filename='user-manual-new.html').write_pdf('PatentLens-用户使用说明书-V0.3.0.pdf')
print('PDF generated successfully')
"
```

### 1.4 验证 PDF 书签

```bash
python3 -c "
from weasyprint import HTML
pdf = HTML(filename='/workspace/user-manual-new.html').render()
bookmarks = pdf.make_bookmark_tree()
def print_bookmarks(items, depth=0):
    for item in items:
        print('  ' * depth + item[0])
        if item[2]:
            print_bookmarks(item[2], depth + 1)
print_bookmarks(bookmarks)
"
```

---

## 2 说明书更新流程

### 2.1 更新步骤（严格按顺序执行）

1. **审查代码变化** — 对比 `git log`，梳理面向用户的新功能点
2. **更新 HTML** — 修改 `user-manual-new.html`，包括：
   - 封面版本号
   - 目录（如有新增章节）
   - 受影响章节的内容
   - 版本更新清单（新增一条记录）
3. **确认字体已安装** — 运行 `fc-list :lang=zh | head -3`，若无输出则需安装 `fonts-noto-cjk`
4. **确认 WeasyPrint 已安装** — 运行 `python3 -c "import weasyprint; print('OK')"`
5. **生成 PDF** — 使用 WeasyPrint 生成（见 1.3 节命令）
6. **验证 PDF** — 确认以下三点：
   - 中文文字可见（非空白）
   - 中文文字可复制（非图片）
   - PDF 书签目录存在且层级正确
7. **删除旧版 PDF** — `rm PatentLens-用户使用说明书-V旧版号.pdf`
8. **提交推送** — 将 HTML、PDF 和其他变更一起提交并推送到远端

### 2.2 常见更新场景

| 场景 | 需要更新的章节 |
|------|---------------|
| 新增关系类型 | 1.2 核心功能、5.2 AI抽取、5.4 关系编辑、6.2 关系类型、6.x 新增图例章节 |
| 新增视觉元素 | 6.x 新增图例章节、1.2 核心功能 |
| 新增交互功能 | 3.4 画布操作、5.x 功能详解对应章节 |
| 修改 AI 提示词 | 5.9 设置 → 提示词 Tab |
| 新增 AI 服务商/模型 | 6 常见问题 Q4、7.3 AI 服务配置参考 |
| 修改导出功能 | 5.8 Word 导出、5.13 合并导出 PDF |
| 新增 OCR/翻译功能 | 5.10 OCR 文字提取、5.11 全文翻译、5.14 OCR 选区翻译 |
| 新增看板功能 | 5.4 审查看板 |

---

## 3 常见错误与避免方法

### 3.1 PDF 中文全部空白
- **原因**：未安装中文字体
- **解决**：
  ```bash
  apt-get install -y fonts-noto-cjk fonts-noto-cjk-extra
  fc-cache -f -v
  ```

### 3.2 PDF 无书签目录
- **原因**：使用了 wkhtmltopdf（无补丁 Qt 不支持 `--outline`）
- **解决**：改用 WeasyPrint，它会自动从 HTML 标题标签生成书签

### 3.3 PDF 文字不可复制（图片化）
- **原因**：wkhtmltopdf 在某些环境下会将文字渲染为图片
- **解决**：改用 WeasyPrint

### 3.4 版本号不一致
- **原因**：HTML 封面版本号、PDF 文件名版本号、版本更新清单版本号三者未同步
- **解决**：更新时检查三处版本号是否一致：
  - HTML 封面 `版本 V0.X.X`
  - PDF 文件名 `PatentLens-用户使用说明书-V0.X.X.pdf`
  - 版本更新清单 `V0.X.X (YYYY-MM-DD)`

### 3.5 旧版 PDF 未删除
- **原因**：生成新版 PDF 后忘记删除旧版
- **解决**：在生成命令前先执行 `rm -f PatentLens-用户使用说明书-V旧版号.pdf`

---

## 4 HTML 结构要求（确保 PDF 书签正确）

WeasyPrint 根据 HTML 标题标签自动生成 PDF 书签层级：

| HTML 标签 | PDF 书签层级 | 对应说明书结构 |
|-----------|-------------|---------------|
| `<h1>` | 一级书签 | 章标题（如"1 产品概述"） |
| `<h2>` | 二级书签 | 节标题（如"1.1 产品简介"） |
| `<h3>` | 三级书签 | 小节标题（如"5.2.1 提示词设置"） |

**注意事项**：
- 不要跳过标题层级（如 `<h1>` 后直接跟 `<h3>`）
- 封面和目录页的标题不应出现在书签中（使用 CSS `bookmark-level: none` 或不使用标题标签）
- 确保每个章节的标题文字清晰明确，因为它们会直接成为 PDF 书签的名称

---

## 5 质量检查清单

每次生成 PDF 后，必须逐项确认：

- [ ] PDF 中文文字可见（非空白）
- [ ] PDF 中文文字可复制（非图片）
- [ ] PDF 书签目录存在
- [ ] 书签层级正确（章→节→小节）
- [ ] 封面版本号与 PDF 文件名版本号一致
- [ ] 旧版本 PDF 已删除
- [ ] HTML 和 PDF 已一起提交到 Git

---

## 6 当前说明书文件

- **HTML 源文件**：`/workspace/user-manual-new.html`
- **PDF 输出文件**：`/workspace/PatentLens-用户使用说明书-V0.5.0.pdf`
- **当前版本**：V0.5.0
