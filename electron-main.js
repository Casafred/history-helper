const { app, BrowserWindow } = require("electron");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const GD_API_BASE = "https://d1kazzu6rbodne.cloudfront.net";
const PADDLE_OCR_VL_URL = "https://k2neb1qcy1u6g4k5.aistudio-app.com/layout-parsing";
const PADDLE_OCR_VL_TOKEN = "70b270c8275606a7a97f8c4e8617cdeb935ed74c";
const GLM_OCR_URL = "https://open.bigmodel.cn/api/paas/v4/layout_parsing";

const GD_HEADERS = {
  "user-type": "external",
  "Referer": "https://globaldossier.uspto.gov/",
  "Origin": "https://globaldossier.uspto.gov",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
};

let mainWindow;
let server;

function getSrcDir() {
  return path.join(__dirname, "src");
}

function serveStatic(filePath, res) {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}

function httpsGet(targetUrl, headers, timeout) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(targetUrl);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      headers: { ...GD_HEADERS, ...headers },
      timeout: timeout || 30000,
    };
    const req = https.request(options, (resp) => {
      const chunks = [];
      resp.on("data", (chunk) => chunks.push(chunk));
      resp.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({ statusCode: resp.statusCode, headers: resp.headers, body });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    req.end();
  });
}

function httpsPost(targetUrl, headers, payload, timeout) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(targetUrl);
    const bodyData = typeof payload === "string" ? payload : JSON.stringify(payload);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        ...headers,
        "Content-Length": Buffer.byteLength(bodyData),
      },
      timeout: timeout || 180000,
    };
    const req = https.request(options, (resp) => {
      const chunks = [];
      resp.on("data", (chunk) => chunks.push(chunk));
      resp.on("end", () => {
        const body = Buffer.concat(chunks);
        resolve({ statusCode: resp.statusCode, headers: resp.headers, body });
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
    req.write(bodyData);
    req.end();
  });
}

async function proxyGdApi(urlPath, res) {
  const targetUrl = GD_API_BASE + urlPath;
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, user-type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };

  try {
    const isDocContent = urlPath.includes("/doc-content/");
    const acceptHeader = isDocContent ? "application/pdf,*/*" : "application/json, text/plain, */*";
    const timeout = isDocContent ? 60000 : 30000;

    const result = await httpsGet(targetUrl, { Accept: acceptHeader }, timeout);

    if (result.statusCode !== 200) {
      corsHeaders["Content-Type"] = "application/json";
      res.writeHead(result.statusCode, corsHeaders);
      res.end(JSON.stringify({ error: `HTTP ${result.statusCode}` }));
      return;
    }

    const bodyText = result.body.toString("utf-8");
    const isAttachmentNotFound = result.body.length < 100 && bodyText.includes("Attachment Not Found");
    const isPdf = result.body.length > 100 && result.body[0] === 0x25 && result.body[1] === 0x50;

    if (isDocContent) {
      corsHeaders["Content-Type"] = isPdf ? "application/pdf" : "application/octet-stream";
      if (isAttachmentNotFound) {
        corsHeaders["Content-Type"] = "text/plain";
        corsHeaders["X-Attachment-Not-Found"] = "true";
      } else if (isPdf) {
        corsHeaders["Content-Disposition"] = 'attachment; filename="document.pdf"';
      }
    } else {
      corsHeaders["Content-Type"] = "application/json";
    }

    res.writeHead(200, corsHeaders);
    res.end(result.body);
  } catch (e) {
    corsHeaders["Content-Type"] = "application/json";
    res.writeHead(502, corsHeaders);
    res.end(JSON.stringify({ error: e.message }));
  }
}

function ocrWithPaddleVl(pdfBase64) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      file: pdfBase64,
      fileType: 2,
      useDocOrientationClassify: true,
      useDocUnwarping: false,
      useLayoutDetection: true,
      useChartRecognition: false,
      layoutThreshold: 0.5,
      prettifyMarkdown: true,
      showFormulaNumber: false,
      visualize: false,
    });

    const urlObj = new URL(PADDLE_OCR_VL_URL);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Authorization": `token ${PADDLE_OCR_VL_TOKEN}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: 180000,
    };

    const req = https.request(options, (resp) => {
      const chunks = [];
      resp.on("data", (chunk) => chunks.push(chunk));
      resp.on("end", () => {
        try {
          const data = Buffer.concat(chunks).toString("utf-8");
          const parsed = JSON.parse(data);
          const allMarkdown = [];
          const allText = [];
          const allBlocks = [];
          const pageDimensions = {};

          if (parsed.errorCode === 0) {
            const results = (parsed.result || {}).layoutParsingResults || [];
            results.forEach((r, pageIdx) => {
              const pageNum = pageIdx + 1;
              const md = (r.markdown || {}).text || "";
              if (md) allMarkdown.push(md);
              const pruned = r.prunedResult || {};
              const pw = pruned.width || 0;
              const ph = pruned.height || 0;
              if (pw && ph) pageDimensions[pageNum] = { width: pw, height: ph };
              const parsingList = pruned.parsing_res_list || [];
              parsingList.forEach((block) => {
                const content = block.block_content || "";
                const label = block.block_label || "";
                const bbox = block.block_bbox || null;
                allBlocks.push({
                  block_id: `B_p${pageNum}_${block.block_id || allBlocks.length}`,
                  page: pageNum, label, content, bbox,
                  order: block.block_order || 0,
                  group_id: block.group_id || 0,
                });
                if (content && ["text", "title", "table", "formula"].includes(label)) {
                  allText.push(content);
                }
              });
            });
          }

          resolve({
            markdown: allMarkdown.join("\n\n---\n\n"),
            text: allText.join("\n"),
            blocks: allBlocks,
            pageDimensions,
          });
        } catch (e) {
          resolve({ markdown: "", text: "", blocks: [], pageDimensions: {} });
        }
      });
    });

    req.on("error", () => resolve({ markdown: "", text: "", blocks: [], pageDimensions: {} }));
    req.on("timeout", () => { req.destroy(); resolve({ markdown: "", text: "", blocks: [], pageDimensions: {} }); });
    req.write(payload);
    req.end();
  });
}

function ocrWithGlm(pdfBase64, apiKey) {
  return new Promise((resolve) => {
    const fileData = `data:application/pdf;base64,${pdfBase64}`;
    const payload = JSON.stringify({
      model: "glm-ocr",
      file: fileData,
      return_crop_images: false,
      need_layout_visualization: false,
    });

    const urlObj = new URL(GLM_OCR_URL);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: 180000,
    };

    const req = https.request(options, (resp) => {
      const chunks = [];
      resp.on("data", (chunk) => chunks.push(chunk));
      resp.on("end", () => {
        try {
          const data = Buffer.concat(chunks).toString("utf-8");
          const parsed = JSON.parse(data);
          const allMarkdown = [];
          const allText = [];
          const allBlocks = [];
          const pageDimensions = {};

          const md = parsed.md_results || "";
          if (md) allMarkdown.push(md);
          const layoutDetails = parsed.layout_details || [];
          const dataInfo = parsed.data_info || {};
          const pagesInfo = dataInfo.pages || [];

          layoutDetails.forEach((pageDetails, pageIdx) => {
            const pageNum = pageIdx + 1;
            if (pageIdx < pagesInfo.length) {
              const pi = pagesInfo[pageIdx];
              const pw = pi.width || 0;
              const ph = pi.height || 0;
              if (pw && ph) pageDimensions[pageNum] = { width: pw, height: ph };
            }
            if (Array.isArray(pageDetails)) {
              pageDetails.forEach((block, blockIdx) => {
                const content = block.content || "";
                const label = block.label || "";
                const bbox2d = block.bbox_2d || null;
                const pw = (pageDimensions[pageNum] || {}).width || 0;
                const ph = (pageDimensions[pageNum] || {}).height || 0;
                let pixelBbox = null;
                if (bbox2d && bbox2d.length === 4 && pw && ph) {
                  pixelBbox = [
                    Math.round(bbox2d[0] * pw), Math.round(bbox2d[1] * ph),
                    Math.round(bbox2d[2] * pw), Math.round(bbox2d[3] * ph),
                  ];
                }
                allBlocks.push({
                  block_id: `B_p${pageNum}_${blockIdx}`,
                  page: pageNum, label, content, bbox: pixelBbox,
                  order: block.index || blockIdx, group_id: 0,
                });
                if (content && ["text", "title", "table", "formula"].includes(label)) {
                  allText.push(content);
                }
              });
            }
          });

          resolve({
            markdown: allMarkdown.join("\n\n---\n\n"),
            text: allText.join("\n"),
            blocks: allBlocks,
            pageDimensions,
          });
        } catch (e) {
          resolve({ markdown: "", text: "", blocks: [], pageDimensions: {} });
        }
      });
    });

    req.on("error", () => resolve({ markdown: "", text: "", blocks: [], pageDimensions: {} }));
    req.on("timeout", () => { req.destroy(); resolve({ markdown: "", text: "", blocks: [], pageDimensions: {} }); });
    req.write(payload);
    req.end();
  });
}

async function extractPdfText(req, res) {
  const urlObj = new URL(req.url, "http://localhost");
  const urlPath = urlObj.pathname.replace("/api/gd/extract-text", "");
  const engine = urlObj.searchParams.get("engine") || "auto";
  const apiKey = urlObj.searchParams.get("api_key") || "";
  const gdUrl = `${GD_API_BASE}/doc-content/svc/doccontent${urlPath}`;

  const corsHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  try {
    const result = await httpsGet(gdUrl, { Accept: "application/pdf,*/*" }, 60000);

    if (result.statusCode !== 200) {
      throw new Error("PDF 下载失败: HTTP " + result.statusCode);
    }
    if (result.body.length < 100) {
      throw new Error("下载的文件过小，文档可能暂不可用");
    }

    const pdfBase64 = result.body.toString("base64");
    let text = "";
    let markdown = "";
    let usedEngine = "none";
    let blocks = [];
    let pageDimensions = {};

    if (engine === "paddle_ocr_vl" || engine === "auto") {
      const r = await ocrWithPaddleVl(pdfBase64);
      if (r.text.trim() || r.markdown.trim()) {
        text = r.text; markdown = r.markdown; blocks = r.blocks;
        pageDimensions = r.pageDimensions; usedEngine = "paddle_ocr_vl";
      }
    }

    if (!text && !markdown && (engine === "glm_ocr" || (engine === "auto" && apiKey))) {
      const r = await ocrWithGlm(pdfBase64, apiKey);
      if (r.text.trim() || r.markdown.trim()) {
        text = r.text; markdown = r.markdown; blocks = r.blocks;
        pageDimensions = r.pageDimensions; usedEngine = "glm_ocr";
      }
    }

    if (!text && !markdown && engine !== "paddle_ocr_vl") {
      const r = await ocrWithPaddleVl(pdfBase64);
      if (r.text.trim() || r.markdown.trim()) {
        text = r.text; markdown = r.markdown; blocks = r.blocks;
        pageDimensions = r.pageDimensions; usedEngine = "paddle_ocr_vl";
      }
    }

    res.writeHead(200, corsHeaders);
    res.end(JSON.stringify({
      text, markdown, engine: usedEngine, char_count: text.length,
      blocks, page_dimensions: pageDimensions,
    }));
  } catch (e) {
    console.error("Extract error:", e);
    res.writeHead(200, corsHeaders);
    res.end(JSON.stringify({ text: "", markdown: "", engine: "none", error: e.message }));
  }
}

// ============ 浏览器插件接口 ============

function handleExtensionApi(req, res) {
  const corsHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  const urlObj = new URL(req.url, "http://localhost");
  const pathname = urlObj.pathname;

  // GET /api/extension/port — 返回当前服务端口（供插件发现）
  if (pathname === "/api/extension/port" && req.method === "GET") {
    const port = server.address()?.port;
    res.writeHead(200, corsHeaders);
    res.end(JSON.stringify({ port, status: "ok" }));
    return;
  }

  // POST /api/extension/import — 接收插件抓取的数据
  if (pathname === "/api/extension/import" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        console.log("[Extension] 收到数据:", data.office, data.type || data.data?.type);

        // 通知前端渲染器（通过 postMessage 注入到页面）
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.executeJavaScript(
            `window.postMessage({type:'extension-data',payload:${JSON.stringify(data).replace(/</g, '\\u003c')}},'*');`
          );
        }

        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ success: true, message: "数据已接收" }));
      } catch (e) {
        res.writeHead(400, corsHeaders);
        res.end(JSON.stringify({ success: false, error: "无效的 JSON 数据" }));
      }
    });
    return;
  }

  // POST /api/extension/analyze — 对文本内容做 AI 梳理
  if (pathname === "/api/extension/analyze" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        console.log("[Extension] 分析请求:", data.office, data.type);

        // 通知前端渲染器进行 AI 分析（通过 postMessage 注入到页面）
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.executeJavaScript(
            `window.postMessage({type:'extension-analyze',payload:${JSON.stringify({office: data.office, content: data.content, type: data.type, source: "browser-extension"}).replace(/</g, '\\u003c')}},'*');`
          );
        }

        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ success: true, message: "分析请求已提交" }));
      } catch (e) {
        res.writeHead(400, corsHeaders);
        res.end(JSON.stringify({ success: false, error: "无效的 JSON 数据" }));
      }
    });
    return;
  }

  res.writeHead(404, corsHeaders);
  res.end(JSON.stringify({ error: "未知的扩展接口" }));
}

function writePortFile(port) {
  try {
    const portFile = path.join(app.getPath("userData"), "extension-port.json");
    fs.writeFileSync(portFile, JSON.stringify({ port, pid: process.pid, timestamp: Date.now() }));
    console.log(`[Electron] Extension port file: ${portFile}`);
  } catch (e) {
    console.warn("[Electron] 无法写入端口文件:", e.message);
  }
}

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, user-type",
        });
        res.end();
        return;
      }

      // ── 浏览器插件接口 ──
      if (req.url.startsWith("/api/extension/")) {
        handleExtensionApi(req, res);
        return;
      }

      if (req.url.startsWith("/api/gd/extract-text/")) {
        extractPdfText(req, res);
        return;
      }

      if (req.url.startsWith("/api/gd/")) {
        const gdPath = req.url.replace("/api/gd", "");
        proxyGdApi(gdPath, res);
        return;
      }

      let urlPath = req.url === "/" ? "/web.html" : req.url;
      const qIdx = urlPath.indexOf("?");
      if (qIdx !== -1) urlPath = urlPath.substring(0, qIdx);
      const filePath = path.join(getSrcDir(), urlPath);
      serveStatic(filePath, res);
    });

    // 优先使用固定端口 7865，被占用则自动分配
    const preferredPort = 7865;
    
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE" && preferredPort) {
        console.log(`[Electron] Port ${preferredPort} in use, trying random port...`);
        server.listen(0, "127.0.0.1", () => {
          const port = server.address().port;
          console.log(`[Electron] Local server running on http://127.0.0.1:${port}/`);
          writePortFile(port);
          resolve(port);
        });
      } else {
        reject(err);
      }
    });

    server.listen(preferredPort, "127.0.0.1", () => {
      const port = server.address().port;
      console.log(`[Electron] Local server running on http://127.0.0.1:${port}/`);
      writePortFile(port);
      resolve(port);
    });
  });
}

function createWindow(port) {
  const iconPath = path.join(__dirname, "src", "icon.png");
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    center: true,
    title: "PatentLens - 专利审查梳理工具",
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  const port = await startServer();
  createWindow(port);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(port);
    }
  });
});

app.on("window-all-closed", () => {
  if (server) server.close();
  app.quit();
});
