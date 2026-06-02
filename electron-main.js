const { app, BrowserWindow } = require("electron");
const http = require("http");
const https = require("https");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const url = require("url");

const GD_API_BASE = "https://d1kazzu6rbodne.cloudfront.net";
const PADDLE_OCR_VL_URL = "https://k2neb1qcy1u6g4k5.aistudio-app.com/layout-parsing";
const PADDLE_OCR_VL_TOKEN = "70b270c8275606a7a97f8c4e8617cdeb935ed74c";
const GLM_OCR_URL = "https://open.bigmodel.cn/api/paas/v4/layout_parsing";

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
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    });
    res.end(data);
  });
}

function proxyGdApi(urlPath, res) {
  const targetUrl = GD_API_BASE + urlPath;

  if (urlPath.includes("/doc-content/")) {
    const args = [
      "-s",
      "-w", " HTTP_CODE_%{http_code}",
      "--max-time", "60",
      "-H", "user-type: external",
      "-H", "Accept: application/pdf,*/*",
      "-H", "Referer: https://globaldossier.uspto.gov/",
      "-H", "Origin: https://globaldossier.uspto.gov",
      "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      targetUrl,
    ];

    execFile("curl", args, { maxBuffer: 50 * 1024 * 1024, encoding: "buffer" }, (err, stdoutBuffer) => {
      if (err) {
        res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }

      const markerBuffer = Buffer.from(" HTTP_CODE_");
      let idx = -1;
      for (let i = Math.max(0, stdoutBuffer.length - 20); i < stdoutBuffer.length; i++) {
        if (stdoutBuffer.slice(i, i + markerBuffer.length).equals(markerBuffer)) {
          idx = i;
          break;
        }
      }

      let httpCode = 200;
      let bodyBuffer = stdoutBuffer;
      if (idx !== -1) {
        const codeStr = stdoutBuffer.slice(idx + markerBuffer.length).toString().trim();
        httpCode = parseInt(codeStr, 10);
        bodyBuffer = stdoutBuffer.slice(0, idx);
      }

      const isPdf = bodyBuffer.length > 100 && bodyBuffer[0] === 0x25 && bodyBuffer[1] === 0x50;
      const isAttachmentNotFound = bodyBuffer.length < 100 && bodyBuffer.toString("utf-8").includes("Attachment Not Found");

      const respHeaders = {
        "Content-Type": isPdf ? "application/pdf" : "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, user-type",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      };

      if (isAttachmentNotFound) {
        respHeaders["Content-Type"] = "text/plain";
        respHeaders["X-Attachment-Not-Found"] = "true";
      } else if (isPdf) {
        respHeaders["Content-Disposition"] = 'attachment; filename="document.pdf"';
      }

      res.writeHead(httpCode, respHeaders);
      res.end(bodyBuffer);
    });
  } else {
    const args = [
      "-s",
      "-w", "\n__HTTP_CODE__%{http_code}",
      "--max-time", "30",
      "-H", "user-type: external",
      "-H", "Accept: application/json, text/plain, */*",
      "-H", "Referer: https://globaldossier.uspto.gov/",
      "-H", "Origin: https://globaldossier.uspto.gov",
      "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      targetUrl,
    ];

    execFile("curl", args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }

      const marker = "\n__HTTP_CODE__";
      const idx = stdout.lastIndexOf(marker);
      let httpCode = 200;
      let body = stdout;
      if (idx !== -1) {
        httpCode = parseInt(stdout.substring(idx + marker.length), 10);
        body = stdout.substring(0, idx);
      }

      res.writeHead(httpCode, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, user-type",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      });
      res.end(body);
    });
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
      let data = "";
      resp.on("data", (chunk) => { data += chunk; });
      resp.on("end", () => {
        try {
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
                  page: pageNum,
                  label,
                  content,
                  bbox,
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
      let data = "";
      resp.on("data", (chunk) => { data += chunk; });
      resp.on("end", () => {
        try {
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
                    Math.round(bbox2d[0] * pw),
                    Math.round(bbox2d[1] * ph),
                    Math.round(bbox2d[2] * pw),
                    Math.round(bbox2d[3] * ph),
                  ];
                }
                allBlocks.push({
                  block_id: `B_p${pageNum}_${blockIdx}`,
                  page: pageNum,
                  label,
                  content,
                  bbox: pixelBbox,
                  order: block.index || blockIdx,
                  group_id: 0,
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

  const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  try {
    const curlArgs = [
      "-s",
      "-w", " HTTP_CODE_%{http_code}",
      "--max-time", "60",
      "-H", "user-type: external",
      "-H", "Accept: application/pdf,*/*",
      "-H", "Referer: https://globaldossier.uspto.gov/",
      "-H", "Origin: https://globaldossier.uspto.gov",
      "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      gdUrl,
    ];

    const curlResult = await new Promise((resolve, reject) => {
      execFile("curl", curlArgs, { maxBuffer: 50 * 1024 * 1024, encoding: "buffer" }, (err, stdoutBuffer) => {
        if (err) { reject(err); return; }
        const markerBuffer = Buffer.from(" HTTP_CODE_");
        let idx = -1;
        for (let i = Math.max(0, stdoutBuffer.length - 20); i < stdoutBuffer.length; i++) {
          if (stdoutBuffer.slice(i, i + markerBuffer.length).equals(markerBuffer)) { idx = i; break; }
        }
        let httpCode = 200;
        let bodyBuffer = stdoutBuffer;
        if (idx !== -1) {
          httpCode = parseInt(stdoutBuffer.slice(idx + markerBuffer.length).toString().trim(), 10);
          bodyBuffer = stdoutBuffer.slice(0, idx);
        }
        resolve({ httpCode, body: bodyBuffer });
      });
    });

    if (curlResult.httpCode !== 200) {
      throw new Error("PDF 下载失败: HTTP " + curlResult.httpCode);
    }
    if (curlResult.body.length < 100) {
      throw new Error("下载的文件过小，文档可能暂不可用");
    }

    const pdfBase64 = curlResult.body.toString("base64");
    let text = "";
    let markdown = "";
    let usedEngine = "none";
    let blocks = [];
    let pageDimensions = {};

    if (engine === "paddle_ocr_vl" || engine === "auto") {
      const r = await ocrWithPaddleVl(pdfBase64);
      if (r.text.trim() || r.markdown.trim()) {
        text = r.text;
        markdown = r.markdown;
        blocks = r.blocks;
        pageDimensions = r.pageDimensions;
        usedEngine = "paddle_ocr_vl";
      }
    }

    if (!text && !markdown && (engine === "glm_ocr" || (engine === "auto" && apiKey))) {
      const r = await ocrWithGlm(pdfBase64, apiKey);
      if (r.text.trim() || r.markdown.trim()) {
        text = r.text;
        markdown = r.markdown;
        blocks = r.blocks;
        pageDimensions = r.pageDimensions;
        usedEngine = "glm_ocr";
      }
    }

    if (!text && !markdown && engine !== "paddle_ocr_vl") {
      const r = await ocrWithPaddleVl(pdfBase64);
      if (r.text.trim() || r.markdown.trim()) {
        text = r.text;
        markdown = r.markdown;
        blocks = r.blocks;
        pageDimensions = r.pageDimensions;
        usedEngine = "paddle_ocr_vl";
      }
    }

    const result = {
      text,
      markdown,
      engine: usedEngine,
      char_count: text.length,
      blocks,
      page_dimensions: pageDimensions,
    };
    res.writeHead(200, corsHeaders);
    res.end(JSON.stringify(result));
  } catch (e) {
    console.error("Extract error:", e);
    res.writeHead(200, corsHeaders);
    res.end(JSON.stringify({ text: "", markdown: "", engine: "none", error: e.message }));
  }
}

function startServer() {
  return new Promise((resolve) => {
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

      if (req.url.startsWith("/api/gd/extract-text/")) {
        extractPdfText(req, res);
        return;
      }

      if (req.url.startsWith("/api/gd/")) {
        const gdPath = req.url.replace("/api/gd", "");
        proxyGdApi(gdPath, res);
        return;
      }

      let filePath = req.url === "/" ? "/index.html" : req.url;
      filePath = path.join(getSrcDir(), filePath);
      serveStatic(filePath, res);
    });

    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      console.log(`[Electron] Local server running on http://127.0.0.1:${port}/`);
      resolve(port);
    });
  });
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    center: true,
    title: "专利审查梳理工具",
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
