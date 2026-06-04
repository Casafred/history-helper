# 项目规则

## 服务器启动前必做

启动任何服务器（`node server.js`、`electron .`、`tauri dev` 等）之前，必须先安装项目依赖：

```bash
# Node.js 依赖
npm install

# Python 依赖（OCR 功能需要）
pip install -r requirements.txt
```

当前 Python 依赖：
- `requests` — extract_pdf.py 中 PaddleOCR-VL 和 GLM OCR 的 HTTP 请求所需
