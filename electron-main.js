const { app, BrowserWindow, shell, ipcMain, dialog, session, clipboard } = require("electron");

// 全局命令行配置：模拟真实Chrome浏览器环境，用于绕过WAF检测
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
app.commandLine.appendSwitch("disable-blink-features", "AutomationControlled");
app.commandLine.appendSwitch("user-agent", CHROME_UA);
app.commandLine.appendSwitch("lang", "zh-CN");

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");
const { normalizePatentNumber, extractPatentFromHtml } = require("./patent-parser");

const GD_API_BASE = "https://d1kazzu6rbodne.cloudfront.net";
const GOOGLE_PATENTS_BASE = "https://patents.google.com";
// 系统代理：优先取 HTTPS_PROXY / HTTP_PROXY 环境变量，否则使用默认值
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "http://127.0.0.1:7897";
const PADDLE_OCR_V2_URL = "https://paddleocr.aistudio-app.com/api/v2/ocr/jobs";
const PADDLE_OCR_V2_TOKEN = "70b270c8275606a7a97f8c4e8617cdeb935ed74c";
const PADDLE_OCR_V2_MODEL = "PaddleOCR-VL-1.6";
const PADDLE_OCR_V2_POLL_INTERVAL = 5000;
const PADDLE_OCR_V2_POLL_TIMEOUT = 300000;
const GLM_OCR_URL = "https://open.bigmodel.cn/api/paas/v4/layout_parsing";

// OCR result cache: key = sha256(pdfBase64), value = { result, timestamp }
const ocrCache = new Map();
const OCR_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

const GD_HEADERS = {
  "user-type": "external",
  "Referer": "https://globaldossier.uspto.gov/",
  "Origin": "https://globaldossier.uspto.gov",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
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
  ".otf": "font/otf",
  ".ttc": "font/collection",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

// ── CJK font detection: bundled font first, then system fonts ──
function findCjkFont() {
  // 1. Bundled NotoSansSC (TTF, most reliable with pdf-lib)
  const bundledPaths = [
    path.join(__dirname, "fonts", "NotoSansSC-Regular.ttf"),
    path.join(__dirname, "src", "fonts", "NotoSansSC-Regular.ttf"),
  ];
  // In asar-packed app, fonts may need unpack path
  for (const p of bundledPaths) {
    try {
      const resolved = p.includes(".asar" + path.sep) ? p.replace(".asar" + path.sep, ".asar.unpacked" + path.sep) : p;
      if (fs.existsSync(resolved)) return resolved;
      if (fs.existsSync(p)) return p;
    } catch {}
  }

  // 2. System CJK fonts (TTC files may cause "layout is not a function" with pdf-lib)
  const platform = process.platform;
  const candidates = [];

  if (platform === "win32") {
    const windir = process.env.WINDIR || "C:\\Windows";
    candidates.push(
      path.join(windir, "Fonts", "simhei.ttf"),       // SimHei (黑体) - TTF, most compatible
      path.join(windir, "Fonts", "msyh.ttc"),          // Microsoft YaHei - TTC, may fail
      path.join(windir, "Fonts", "msyhbd.ttc"),        // Microsoft YaHei Bold - TTC
      path.join(windir, "Fonts", "simsun.ttc"),        // SimSun (宋体) - TTC
    );
  } else if (platform === "darwin") {
    candidates.push(
      "/Library/Fonts/Arial Unicode.ttf",              // Arial Unicode MS - TTF
      "/System/Library/Fonts/PingFang.ttc",            // PingFang SC - TTC
      "/System/Library/Fonts/STHeiti Light.ttc",       // STHeiti - TTC
    );
  } else {
    candidates.push(
      "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",  // TTF
      "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",            // TTC
      "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",     // TTC
      "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",     // TTC
    );
  }

  for (const fontPath of candidates) {
    try {
      if (fs.existsSync(fontPath)) return fontPath;
    } catch {}
  }
  return null;
}

let mainWindow;
let server;
let _serverPort = null;  // 本地 HTTP 服务端口，供 createPopoutWindow 使用

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

// ── Google Patents scraping ──

function httpsGetWithRedirect(targetUrl, headers, timeout, maxRedirects) {
  maxRedirects = maxRedirects || 5;
  return new Promise((resolve, reject) => {
    const urlObj = new URL(targetUrl);
    const isHttps = urlObj.protocol === "https:";
    const lib = isHttps ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      headers: headers || {},
      timeout: timeout || 30000,
    };
    const req = lib.request(options, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        if (maxRedirects <= 0) { reject(new Error("Too many redirects")); return; }
        let loc = resp.headers.location;
        if (loc.startsWith("/")) loc = urlObj.origin + loc;
        resolve(httpsGetWithRedirect(loc, headers, timeout, maxRedirects - 1));
        return;
      }
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

async function scrapeGooglePatent(patentNumber, res, useProxy, proxyUrl) {
  const { normalized, variants } = normalizePatentNumber(patentNumber);
  const allToTry = [normalized, ...variants];
  const corsHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  for (const tryNumber of allToTry) {
    const url = `${GOOGLE_PATENTS_BASE}/patent/${encodeURIComponent(tryNumber)}`;
    const curlArgs = [
      "-s", "-k", "-L",
      "-w", "\n__HTTP_CODE__%{http_code}",
      "--max-time", "30",
      "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "-H", "Accept-Language: en-US,en;q=0.9",
      "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      url
    ];
    if (useProxy && proxyUrl) {
      curlArgs.splice(1, 0, "--proxy", proxyUrl);
    }

    try {
      const rawOutput = await new Promise((resolve, reject) => {
        execFile("curl", curlArgs, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
          if (err) { reject(err); return; }
          resolve(stdout);
        });
      });

      const marker = "\n__HTTP_CODE__";
      const idx = rawOutput.lastIndexOf(marker);
      let httpCode = 200;
      let html = rawOutput;
      if (idx !== -1) {
        httpCode = parseInt(rawOutput.substring(idx + marker.length), 10);
        html = rawOutput.substring(0, idx);
      }
      console.log(`[GP] ${tryNumber} → HTTP ${httpCode}, body长度: ${html.length}`);

      if (httpCode === 200 && html && html.length > 1000) {
        const data = extractPatentFromHtml(html, tryNumber);
        if (data.title || data.abstract) {
          res.writeHead(200, corsHeaders);
          res.end(JSON.stringify({ success: true, data, patent_number: tryNumber }));
          return;
        }
      }
    } catch (e) {
      console.log(`[GP] curl 错误: ${e.message}`);
      continue;
    }
  }

  // Google Patents 未找到 —— 降级到 Espacenet（在应用内 webview 中打开）
  const espacenetUrl = "https://worldwide.espacenet.com/patent/search?q=" + encodeURIComponent(patentNumber);
  console.log("[GP→Espacenet] Google Patents 未找到，降级到 Espacenet: " + espacenetUrl);
  res.writeHead(200, corsHeaders);
  res.end(JSON.stringify({
    success: true,
    data_source: "Espacenet",
    espacenet_url: espacenetUrl,
    patent_number: normalized,
    data: { patent_number: normalized, data_source: "Espacenet", espacenet_url: espacenetUrl },
  }));
}

// ── PaddleOCR V2 (async Job API) ──

function _paddleV2SubmitJob(pdfBase64) {
  return new Promise((resolve) => {
    const fileBuffer = Buffer.from(pdfBase64, "base64");
    const boundary = "----PaddleForm" + Date.now();
    const parts = [];

    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${PADDLE_OCR_V2_MODEL}`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="optionalPayload"\r\n\r\n${JSON.stringify({ useDocOrientationClassify: true, useDocUnwarping: false, useChartRecognition: false })}`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="document.pdf"\r\nContent-Type: application/pdf\r\n\r\n`);

    const headerBuf = Buffer.from(parts.join("\r\n"), "utf-8");
    const footerBuf = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8");
    const body = Buffer.concat([headerBuf, fileBuffer, footerBuf]);

    const urlObj = new URL(PADDLE_OCR_V2_URL);
    const options = {
      hostname: urlObj.hostname, port: 443, path: urlObj.pathname, method: "POST",
      headers: {
        "Authorization": `bearer ${PADDLE_OCR_V2_TOKEN}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length,
      },
      timeout: 30000,
    };

    const req = https.request(options, (resp) => {
      const chunks = [];
      resp.on("data", (chunk) => chunks.push(chunk));
      resp.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          resolve((data.data || {}).jobId || null);
        } catch (e) {
          console.error("[PaddleV2] submit parse error:", e.message);
          resolve(null);
        }
      });
    });
    req.on("error", (e) => { console.error("[PaddleV2] submit error:", e.message); resolve(null); });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

function _paddleV2PollJob(jobId) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    function poll() {
      if (Date.now() - startTime > PADDLE_OCR_V2_POLL_TIMEOUT) {
        console.error("[PaddleV2] poll timeout");
        return resolve(null);
      }

      const urlObj = new URL(`${PADDLE_OCR_V2_URL}/${jobId}`);
      const options = {
        hostname: urlObj.hostname, port: 443, path: urlObj.pathname, method: "GET",
        headers: { "Authorization": `bearer ${PADDLE_OCR_V2_TOKEN}` },
        timeout: 10000,
      };

      const req = https.request(options, (resp) => {
        const chunks = [];
        resp.on("data", (chunk) => chunks.push(chunk));
        resp.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            const d = data.data || {};
            const state = d.state;

            if (state === "done") {
              return resolve(d);
            } else if (state === "failed") {
              console.error("[PaddleV2] job failed:", d.errorMsg);
              return resolve(null);
            } else {
              // pending or running — continue polling
              setTimeout(poll, PADDLE_OCR_V2_POLL_INTERVAL);
            }
          } catch (e) {
            console.error("[PaddleV2] poll parse error:", e.message);
            resolve(null);
          }
        });
      });
      req.on("error", (e) => { console.error("[PaddleV2] poll error:", e.message); resolve(null); });
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.end();
    }

    poll();
  });
}

function _paddleV2FetchJsonlResult(jsonlUrl) {
  return new Promise((resolve) => {
    const urlObj = new URL(jsonlUrl);
    const options = {
      hostname: urlObj.hostname, port: 443,
      path: urlObj.pathname + urlObj.search, method: "GET",
      timeout: 60000,
    };

    const req = https.request(options, (resp) => {
      const chunks = [];
      resp.on("data", (chunk) => chunks.push(chunk));
      resp.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf-8");
          const lines = text.trim().split("\n").filter((l) => l.trim());

          const allMarkdown = [];
          const allText = [];
          const allBlocks = [];
          const pageDimensions = {};
          let pageNum = 0;

          for (const line of lines) {
            const parsed = JSON.parse(line);
            const results = (parsed.result || {}).layoutParsingResults || [];

            for (const r of results) {
              pageNum++;
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
            }
          }

          resolve({
            markdown: allMarkdown.join("\n\n---\n\n"),
            text: allText.join("\n"),
            blocks: allBlocks,
            pageDimensions,
          });
        } catch (e) {
          console.error("[PaddleV2] JSONL parse error:", e.message);
          resolve({ markdown: "", text: "", blocks: [], pageDimensions: {} });
        }
      });
    });
    req.on("error", () => resolve({ markdown: "", text: "", blocks: [], pageDimensions: {} }));
    req.on("timeout", () => { req.destroy(); resolve({ markdown: "", text: "", blocks: [], pageDimensions: {} }); });
    req.end();
  });
}

function _ocrCacheKey(pdfBase64) {
  const crypto = require("crypto");
  return crypto.createHash("sha256").update(pdfBase64).digest("hex");
}

function _ocrCacheGet(key) {
  const entry = ocrCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > OCR_CACHE_TTL) {
    ocrCache.delete(key);
    return null;
  }
  return entry.result;
}

function _ocrCacheSet(key, result) {
  ocrCache.set(key, { result, timestamp: Date.now() });
  // Prune expired entries periodically
  if (ocrCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of ocrCache) {
      if (now - v.timestamp > OCR_CACHE_TTL) ocrCache.delete(k);
    }
  }
}

function ocrWithPaddleVl(pdfBase64) {
  return new Promise(async (resolve) => {
    // Check cache first
    const cacheKey = _ocrCacheKey(pdfBase64);
    const cached = _ocrCacheGet(cacheKey);
    if (cached) {
      console.log("[PaddleV2] cache hit");
      return resolve(cached);
    }

    try {
      // Step 1: Submit Job
      const jobId = await _paddleV2SubmitJob(pdfBase64);
      if (!jobId) {
        console.error("[PaddleV2] failed to submit job");
        return resolve({ markdown: "", text: "", blocks: [], pageDimensions: {} });
      }
      console.log("[PaddleV2] job submitted:", jobId);

      // Step 2: Poll until done
      const pollResult = await _paddleV2PollJob(jobId);
      if (!pollResult) {
        return resolve({ markdown: "", text: "", blocks: [], pageDimensions: {} });
      }

      // Step 3: Fetch JSONL result
      const jsonlUrl = (pollResult.resultUrl || {}).jsonUrl || "";
      if (!jsonlUrl) {
        console.error("[PaddleV2] no jsonlUrl in result");
        return resolve({ markdown: "", text: "", blocks: [], pageDimensions: {} });
      }

      const result = await _paddleV2FetchJsonlResult(jsonlUrl);
      // Cache successful result
      if (result.text || result.markdown) {
        _ocrCacheSet(cacheKey, result);
      }
      resolve(result);
    } catch (e) {
      console.error("[PaddleV2] error:", e.message);
      resolve({ markdown: "", text: "", blocks: [], pageDimensions: {} });
    }
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

async function mergePdfDocs(req, res) {
  const corsHeaders = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  try {
    const body = await new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk; });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });

    const params = JSON.parse(body);
    const items = params.items;
    const patentInfo = params.patentInfo || {};

    if (!items || !Array.isArray(items) || items.length === 0) {
      res.writeHead(400, corsHeaders);
      res.end(JSON.stringify({ error: "No items provided" }));
      return;
    }

    const tempDir = require("os").tmpdir();
    const mergeId = `merge_${Date.now()}`;
    const downloadPromises = items.map(async (item, idx) => {
      const pdfPath = path.join(tempDir, `${mergeId}_doc${idx}.pdf`);
      let downloadUrl = item.downloadUrl;

      // Convert relative URLs to absolute GD API URLs
      if (downloadUrl.startsWith("/api/gd/")) {
        downloadUrl = GD_API_BASE + downloadUrl.replace("/api/gd", "");
      }

      // JPO URLs need token auth
      if (downloadUrl.startsWith("/api/jpo/")) {
        // JPO not supported in merge export for Electron version yet
        return { success: false, pdfPath, error: "JPO docs not supported in merge export" };
      }

      try {
        const result = await httpsGet(downloadUrl, { Accept: "application/pdf,*/*" }, 60000);
        if (result.statusCode !== 200) {
          return { success: false, pdfPath, error: `HTTP ${result.statusCode}` };
        }
        if (result.body.length < 100) {
          return { success: false, pdfPath, error: "File too small" };
        }
        if (result.body[0] !== 0x25 || result.body[1] !== 0x50) {
          return { success: false, pdfPath, error: "Not a valid PDF" };
        }
        fs.writeFileSync(pdfPath, result.body);
        return { success: true, pdfPath };
      } catch (e) {
        return { success: false, pdfPath, error: e.message };
      }
    });

    const downloadResults = await Promise.all(downloadPromises);
    const mergeItems = [];
    const failedItems = [];

    downloadResults.forEach((result, idx) => {
      if (result.success) {
        mergeItems.push({
          pdf_path: result.pdfPath,
          original_title: items[idx].originalTitle || "",
          chinese_title: items[idx].chineseTitle || "",
          date: items[idx].date || "",
          doc_code: items[idx].docCode || "",
        });
      } else {
        failedItems.push({ index: idx, error: result.error });
      }
    });

    if (mergeItems.length === 0) {
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({ error: "All PDF downloads failed", failedItems }));
      return;
    }

    // ── Merge PDFs using pdf-lib (pure JS, no Python needed) ──
    try {
      const mergedPdf = await PDFDocument.create();
      mergedPdf.registerFontkit(fontkit);

      const font = await mergedPdf.embedFont(StandardFonts.Helvetica);
      const fontBold = await mergedPdf.embedFont(StandardFonts.HelveticaBold);

      // Try to load system CJK font for Chinese title rendering
      let cjkFont = null;
      const cjkFontPath = findCjkFont();
      if (cjkFontPath) {
        try {
          const cjkFontBytes = fs.readFileSync(cjkFontPath);
          cjkFont = await mergedPdf.embedFont(cjkFontBytes);
          // Verify the CJK font actually works by testing layout
          if (cjkFont && typeof cjkFont.widthOfTextAtSize !== "function") {
            console.warn("[Merge] CJK font embedded but missing layout methods, discarding");
            cjkFont = null;
          } else {
            console.log("[Merge] Loaded CJK font:", cjkFontPath);
          }
        } catch (e) {
          console.warn("[Merge] Failed to load CJK font:", cjkFontPath, e.message);
          cjkFont = null;
        }
      } else {
        console.warn("[Merge] No system CJK font found, Chinese titles will use doc_code fallback");
      }

      // Load logo image
      let logoImage = null;
      try {
        let logoPath = path.join(__dirname, "src", "PATENTLENSNEWLOGO.png");
        if (logoPath.includes(".asar" + path.sep)) {
          logoPath = logoPath.replace(".asar" + path.sep, ".asar.unpacked" + path.sep);
        }
        if (fs.existsSync(logoPath)) {
          const logoBytes = fs.readFileSync(logoPath);
          logoImage = await mergedPdf.embedPng(logoBytes);
        }
      } catch (e) {
        console.error("Logo load error:", e.message);
      }

      const total = mergeItems.length;
      const PRIMARY_COLOR = rgb(0.29, 0.44, 0.65);

      for (let i = 0; i < total; i++) {
        const item = mergeItems[i];

        // ── Create cover page ──
        const coverPage = mergedPdf.addPage([595.28, 841.89]); // A4
        const { width: pw, height: ph } = coverPage.getSize();

        // Top accent bar (taller to accommodate patent info)
        const barHeight = patentInfo.patentNumber ? 110 : 80;
        coverPage.drawRectangle({
          x: 0, y: ph - barHeight, width: pw, height: barHeight,
          color: PRIMARY_COLOR,
        });

        // Logo in top-left of accent bar
        let badgeX = 40;
        if (logoImage) {
          const logoDims = logoImage.scale(36 / Math.max(logoImage.width, logoImage.height));
          coverPage.drawImage(logoImage, {
            x: 40, y: ph - 58, width: logoDims.width, height: logoDims.height,
          });
          badgeX = 40 + logoDims.width + 12;
        }

        // Document index badge
        coverPage.drawText(`Document ${i + 1} / ${total}`, {
          x: badgeX, y: ph - 35, size: 14, font: fontBold, color: rgb(1, 1, 1),
        });

        // "by PatentLens" in top-right
        const byText = "by PatentLens";
        const byWidth = font.widthOfTextAtSize(byText, 10);
        coverPage.drawText(byText, {
          x: pw - 40 - byWidth, y: ph - 55, size: 10, font, color: rgb(0.85, 0.88, 0.92),
        });

        // Patent number in accent bar (second line, left-aligned)
        if (patentInfo.patentNumber) {
          const pnLabel = `Patent: ${patentInfo.patentNumber}`;
          const pnOffice = patentInfo.office ? `  (${patentInfo.office})` : "";
          const pnText = pnLabel + pnOffice;
          coverPage.drawText(pnText, {
            x: badgeX, y: ph - 55, size: 12, font: fontBold, color: rgb(0.9, 0.92, 0.96),
          });
        }

        // Patent title below accent bar
        let patentTitleBottom = ph - barHeight; // track Y position after patent info
        if (patentInfo.title) {
          const ptSize = 13;
          const maxPtWidth = pw - 80;
          const hasCjkPt = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(patentInfo.title);
          const ptFont = (hasCjkPt && cjkFont) ? cjkFont : font;
          try {
            let displayPt = patentInfo.title;
            if (ptFont.widthOfTextAtSize(displayPt, ptSize) > maxPtWidth) {
              while (displayPt.length > 1 && ptFont.widthOfTextAtSize(displayPt + "...", ptSize) > maxPtWidth) {
                displayPt = displayPt.slice(0, -1);
              }
              displayPt += "...";
            }
            const ptWidth = ptFont.widthOfTextAtSize(displayPt, ptSize);
            coverPage.drawText(displayPt, {
              x: (pw - ptWidth) / 2, y: ph - barHeight - 25, size: ptSize, font: ptFont, color: rgb(0.35, 0.35, 0.45),
            });
            patentTitleBottom = ph - barHeight - 25;
          } catch (e) {
            // fallback: strip CJK
            const safePt = patentInfo.title.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, "").trim();
            if (safePt) {
              const ptWidth = font.widthOfTextAtSize(safePt, ptSize);
              coverPage.drawText(safePt, {
                x: (pw - ptWidth) / 2, y: ph - barHeight - 25, size: ptSize, font, color: rgb(0.35, 0.35, 0.45),
              });
              patentTitleBottom = ph - barHeight - 25;
            }
          }
        }

        // Inventors / Applicants line
        const inventorStr = patentInfo.inventors || "";
        const applicantStr = patentInfo.applicants || "";
        if (inventorStr || applicantStr) {
          const infoSize = 10;
          let infoText = "";
          if (inventorStr) infoText += `Inventor: ${inventorStr}`;
          if (applicantStr) infoText += (infoText ? "  |  " : "") + `Applicant: ${applicantStr}`;
          if (patentInfo.filingDate) infoText += `  |  Filed: ${patentInfo.filingDate}`;
          const maxInfoWidth = pw - 80;
          if (font.widthOfTextAtSize(infoText, infoSize) > maxInfoWidth) {
            while (infoText.length > 1 && font.widthOfTextAtSize(infoText + "...", infoSize) > maxInfoWidth) {
              infoText = infoText.slice(0, -1);
            }
            infoText += "...";
          }
          const infoWidth = font.widthOfTextAtSize(infoText, infoSize);
          coverPage.drawText(infoText, {
            x: (pw - infoWidth) / 2, y: patentTitleBottom - 18, size: infoSize, font, color: rgb(0.5, 0.5, 0.6),
          });
        }

        // Thin separator line
        const sepY = patentTitleBottom - 35;
        coverPage.drawLine({
          start: { x: 60, y: sepY },
          end: { x: pw - 60, y: sepY },
          thickness: 0.5,
          color: rgb(0.8, 0.8, 0.85),
        });

        // Chinese title (centered, large) - auto-truncate if too wide
        const cnTitle = item.chinese_title || item.doc_code || "Document";
        const cnTitleSize = 28;
        const maxTitleWidth = pw - 80; // 40px margin each side
        const cnTitleY = sepY - 50;
        let titleDrawn = false;
        if (cjkFont) {
          try {
            // Use CJK font for proper Chinese rendering
            let displayTitle = cnTitle;
            if (cjkFont.widthOfTextAtSize(displayTitle, cnTitleSize) > maxTitleWidth) {
              while (displayTitle.length > 1 && cjkFont.widthOfTextAtSize(displayTitle + "...", cnTitleSize) > maxTitleWidth) {
                displayTitle = displayTitle.slice(0, -1);
              }
              displayTitle += "...";
            }
            const cnTitleWidth = cjkFont.widthOfTextAtSize(displayTitle, cnTitleSize);
            coverPage.drawText(displayTitle, {
              x: (pw - cnTitleWidth) / 2, y: cnTitleY, size: cnTitleSize, font: cjkFont, color: PRIMARY_COLOR,
            });
            titleDrawn = true;
          } catch (e) {
            console.warn("[Merge] CJK font drawText failed, falling back to English:", e.message);
          }
        }
        if (!titleDrawn) {
          // No CJK font available or CJK rendering failed - use doc_code (English) as fallback
          const safeTitle = item.doc_code || cnTitle.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, "").trim() || "Document";
          let displayTitle = safeTitle;
          if (fontBold.widthOfTextAtSize(displayTitle, cnTitleSize) > maxTitleWidth) {
            while (displayTitle.length > 1 && fontBold.widthOfTextAtSize(displayTitle + "...", cnTitleSize) > maxTitleWidth) {
              displayTitle = displayTitle.slice(0, -1);
            }
            displayTitle += "...";
          }
          const cnTitleWidth = fontBold.widthOfTextAtSize(displayTitle, cnTitleSize);
          coverPage.drawText(displayTitle, {
            x: (pw - cnTitleWidth) / 2, y: cnTitleY, size: cnTitleSize, font: fontBold, color: PRIMARY_COLOR,
          });
        }

        // Original title (centered, smaller) - auto-truncate if too wide
        const enTitleY = cnTitleY - 40;
        if (item.original_title) {
          const enTitle = item.original_title;
          const enTitleSize = 16;
          const hasCjk = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(enTitle);
          const titleFont = (hasCjk && cjkFont) ? cjkFont : font;
          try {
            let displayTitle = enTitle;
            const maxEnWidth = pw - 80;
            if (titleFont.widthOfTextAtSize(displayTitle, enTitleSize) > maxEnWidth) {
              while (displayTitle.length > 1 && titleFont.widthOfTextAtSize(displayTitle + "...", enTitleSize) > maxEnWidth) {
                displayTitle = displayTitle.slice(0, -1);
              }
              displayTitle += "...";
            }
            const enTitleWidth = titleFont.widthOfTextAtSize(displayTitle, enTitleSize);
            coverPage.drawText(displayTitle, {
              x: (pw - enTitleWidth) / 2, y: enTitleY, size: enTitleSize, font: titleFont, color: rgb(0.4, 0.4, 0.5),
            });
          } catch (e) {
            // Fallback: strip CJK characters and use standard font
            const safeEnTitle = enTitle.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, "").trim();
            if (safeEnTitle) {
              const enTitleWidth = font.widthOfTextAtSize(safeEnTitle, enTitleSize);
              coverPage.drawText(safeEnTitle, {
                x: (pw - enTitleWidth) / 2, y: enTitleY, size: enTitleSize, font, color: rgb(0.4, 0.4, 0.5),
              });
            }
          }
        }

        // Date
        if (item.date) {
          const dateText = `Date: ${item.date}`;
          const dateWidth = font.widthOfTextAtSize(dateText, 12);
          coverPage.drawText(dateText, {
            x: (pw - dateWidth) / 2, y: enTitleY - 50, size: 12, font, color: rgb(0.5, 0.5, 0.6),
          });
        }

        // Doc code
        if (item.doc_code) {
          const codeText = `Code: ${item.doc_code}`;
          const codeWidth = font.widthOfTextAtSize(codeText, 12);
          coverPage.drawText(codeText, {
            x: (pw - codeWidth) / 2, y: enTitleY - 75, size: 12, font, color: rgb(0.5, 0.5, 0.6),
          });
        }

        // ── Append source PDF pages ──
        try {
          const pdfBytes = fs.readFileSync(item.pdf_path);
          const srcDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
          const pages = await mergedPdf.copyPages(srcDoc, srcDoc.getPageIndices());
          pages.forEach(p => mergedPdf.addPage(p));
        } catch (e) {
          console.error(`Failed to load PDF ${item.pdf_path}:`, e.message);
        }

        // Clean up temp file
        try { fs.unlinkSync(item.pdf_path); } catch {}
      }

      const mergedBytes = await mergedPdf.save();

      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Access-Control-Allow-Origin": "*",
        "Content-Disposition": 'attachment; filename="merged_patent_docs.pdf"',
      });
      res.end(mergedBytes);
    } catch (mergeErr) {
      console.error("Merge error:", mergeErr);
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({ error: "Merge failed: " + (mergeErr.message || "unknown"), failedItems }));
    }
  } catch (e) {
    console.error("Merge PDF error:", e);
    res.writeHead(200, corsHeaders);
    res.end(JSON.stringify({ error: e.message }));
  }
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

    // OCR with retry on rate-limit (429) or transient errors
    const MAX_OCR_RETRIES = 3;
    const RETRY_BASE_DELAY = 10000; // 10s base, exponential backoff

    async function ocrWithRetry(ocrFn, fnArg, engineName) {
      for (let attempt = 0; attempt < MAX_OCR_RETRIES; attempt++) {
        const r = await ocrFn(fnArg);
        if (r.text && r.text.trim()) return r;
        if (r.markdown && r.markdown.trim()) return r;
        // Empty result — if not last attempt, wait and retry
        if (attempt < MAX_OCR_RETRIES - 1) {
          const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
          console.log(`[OCR] ${engineName} returned empty, retry ${attempt + 1}/${MAX_OCR_RETRIES} in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
      return { text: "", markdown: "", blocks: [], pageDimensions: {} };
    }

    if (engine === "paddle_ocr_vl" || engine === "auto") {
      const r = await ocrWithRetry(ocrWithPaddleVl, pdfBase64, "PaddleOCR");
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
      const r = await ocrWithRetry(ocrWithPaddleVl, pdfBase64, "PaddleOCR-fallback");
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

      if (req.url.startsWith("/api/merge-pdf") && req.method === "POST") {
        mergePdfDocs(req, res);
        return;
      }

      if (req.url.startsWith("/api/gd/extract-text/")) {
        extractPdfText(req, res);
        return;
      }

      if (req.url.startsWith("/api/gp/")) {
        const urlObj = new URL(req.url, "http://localhost");
        const patentNumber = urlObj.pathname.replace("/api/gp/", "");
        const useProxy = urlObj.searchParams.get("proxy") === "1";
        const proxyUrl = urlObj.searchParams.get("proxyUrl") || PROXY_URL;
        scrapeGooglePatent(decodeURIComponent(patentNumber), res, useProxy, proxyUrl);
        return;
      }

      // OPS 配额查询端点（Electron 版精简实现，前端 20 分钟自动刷新调用）
      if (req.url.startsWith("/api/ops/quota")) {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ success: false, quota: null, message: "Electron 版暂不支持 OPS 配额查询" }));
        return;
      }

      // JPO 文档代理（精简实现）
      if (req.url.startsWith("/api/jpo/doc/")) {
        res.writeHead(501, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "JPO API 未在 Electron 版中配置" }));
        return;
      }

      // DE 专利代理（精简实现）
      if (req.url.startsWith("/api/de/")) {
        res.writeHead(501, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "DPMA API 未在 Electron 版中配置" }));
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
      // /fonts/* 从 workspace 根目录的 fonts/ 提供（CJK 字体嵌入用）
      let filePath;
      if (urlPath.startsWith("/fonts/")) {
        filePath = path.join(__dirname, urlPath);
      } else {
        filePath = path.join(getSrcDir(), urlPath);
      }
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
      preload: path.join(__dirname, "preload.js"),
      webviewTag: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  // 窗口打开处理：本地同域请求允许；外部链接统一通过 createPopoutWindow 创建带工具栏的弹窗
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.log("[Electron] mainWindow setWindowOpenHandler url=" + url);
    if (url.startsWith("chrome-extension://")) {
      return { action: "allow" };
    }
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
      return { action: "allow" };
    }
    createPopoutWindow(url, "专利原文查看", port);
    return { action: "deny" };
  });
  // 关闭前确认：若存在未导出的 PDF 标注，弹出原生确认框
  mainWindow.on("close", (event) => {
    if (hasUnsavedAnnotations && !mainWindow._forceClose) {
      event.preventDefault();
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: "question",
        buttons: ["关闭并丢弃标注", "取消"],
        defaultId: 1,
        cancelId: 1,
        title: "确认关闭",
        message: "当前有未导出的 PDF 标注，关闭后将丢失。",
        detail: "如需保留标注，请先点击「导出标注后文档」。",
      });
      if (choice === 0) {
        mainWindow._forceClose = true;
        mainWindow.close();
      }
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

// 弹出独立窗口：用于 GP / espacenet 原文对照查看
// 通过本地 HTTP 服务器加载 popout.html（webview 标签需要 http:// 源，data: URL 不支持）
function createPopoutWindow(targetUrl, title, port, opts) {
  console.log("[Electron] createPopoutWindow targetUrl=" + targetUrl + ", title=" + title + ", port=" + port);

  // CNIPA中国专利查询系统：使用独立BrowserWindow直接加载（瑞数WAF需要完整浏览器环境）
  if (targetUrl && (targetUrl.indexOf("cnipa.gov.cn") !== -1 || targetUrl.indexOf("cpquery") !== -1)) {
    const patentNo = (opts && opts.cnpn) ? String(opts.cnpn) : "";
    const cnWin = new BrowserWindow({
      width: 1200,
      height: 850,
      title: title || "中国专利查询系统",
      show: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: false,
        sandbox: false,
        webSecurity: true,
        preload: path.join(__dirname, "cnipa-preload.js"),
      },
    });
    cnWin.webContents.setUserAgent(CHROME_UA);
    // Auto-copy patent number to clipboard on open
    if (patentNo) {
      clipboard.writeText(patentNo);
      console.log("[CNIPA] Copied patent number to clipboard:", patentNo);
    }
    // Inject top toolbar with patent number and copy button after page loads
    const injectToolbar = (wc) => {
      if (!patentNo) return;
      const toolbarCode = `
        (function() {
          if (document.getElementById('__cnipa_toolbar__')) return;
          try {
            var tb = document.createElement('div');
            tb.id = '__cnipa_toolbar__';
            tb.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#dc2626;color:#fff;padding:8px 16px;display:flex;align-items:center;gap:12px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,0.2);box-sizing:border-box;';
            tb.innerHTML = '<span style="font-weight:600;white-space:nowrap;">中国专利查询</span><span style="opacity:0.8;">|</span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace;background:rgba(255,255,255,0.15);padding:4px 10px;border-radius:4px;">' + ${JSON.stringify(patentNo)} + '</span><button id="__cnipa_copy_btn__" style="background:#fff;color:#dc2626;border:none;padding:5px 14px;border-radius:4px;cursor:pointer;font-weight:600;font-size:13px;white-space:nowrap;">📋 复制号码</button>';
            document.documentElement.appendChild(tb);
            document.body.style.setProperty('margin-top', '44px', 'important');
            var toastTimer = null;
            function showToast(msg) {
              var old = document.getElementById('__cnipa_toast__');
              if (old) old.remove();
              var t = document.createElement('div');
              t.id = '__cnipa_toast__';
              t.style.cssText = 'position:fixed;top:60px;left:50%;transform:translateX(-50%);background:#16a34a;color:#fff;padding:10px 24px;border-radius:8px;z-index:2147483647;font-size:14px;font-weight:500;box-shadow:0 4px 12px rgba(0,0,0,0.2);';
              t.textContent = msg;
              document.documentElement.appendChild(t);
              clearTimeout(toastTimer);
              toastTimer = setTimeout(function() { t.remove(); }, 2500);
            }
            var copyBtn = document.getElementById('__cnipa_copy_btn__');
            copyBtn.addEventListener('click', function() {
              try {
                navigator.clipboard.writeText(${JSON.stringify(patentNo)}).then(function() {
                  showToast('✅ 专利号已复制到剪贴板');
                  copyBtn.textContent = '✅ 已复制';
                  setTimeout(function() { copyBtn.textContent = '📋 复制号码'; }, 2000);
                }).catch(function() {
                  var ta = document.createElement('textarea');
                  ta.value = ${JSON.stringify(patentNo)};
                  ta.style.position = 'fixed';
                  ta.style.opacity = '0';
                  document.body.appendChild(ta);
                  ta.select();
                  document.execCommand('copy');
                  ta.remove();
                  showToast('✅ 专利号已复制到剪贴板');
                  copyBtn.textContent = '✅ 已复制';
                  setTimeout(function() { copyBtn.textContent = '📋 复制号码'; }, 2000);
                });
              } catch(e) { showToast('复制失败'); }
            });
            // Show initial toast
            setTimeout(function() { showToast('✅ 专利号已复制到剪贴板，可直接粘贴查询'); }, 500);
          } catch(e) { console.log('[CNIPA toolbar] inject error:', e); }
        })();
      `;
      wc.executeJavaScript(toolbarCode).catch(() => {});
    };
    cnWin.webContents.on("did-finish-load", () => {
      console.log("[CNIPA] did-finish-load, title:", cnWin.webContents.getTitle());
      setTimeout(() => injectToolbar(cnWin.webContents), 800);
    });
    cnWin.webContents.on("did-navigate-in-page", () => {
      setTimeout(() => injectToolbar(cnWin.webContents), 500);
    });
    console.log("[CNIPA] Loading URL:", targetUrl);
    cnWin.loadURL(targetUrl, { userAgent: CHROME_UA });
    cnWin.webContents.on("did-start-loading", () => {
      console.log("[CNIPA] did-start-loading");
    });
    cnWin.webContents.on("did-stop-loading", () => {
      console.log("[CNIPA] did-stop-loading, current URL:", cnWin.webContents.getURL());
    });
    cnWin.webContents.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) {
        console.error("[CNIPA] did-fail-load:", errorCode, errorDescription, validatedURL);
      }
    });
    cnWin.webContents.on("page-title-updated", (_e, title) => {
      console.log("[CNIPA] page-title-updated:", title);
    });
    cnWin.webContents.setWindowOpenHandler(({ url }) => {
      console.log("[CNIPA] window-open:", url);
      if (url && url.startsWith("http")) {
        if (url.indexOf("cnipa.gov.cn") !== -1 || url.indexOf("cpquery") !== -1) {
          cnWin.loadURL(url, { userAgent: CHROME_UA });
        } else {
          shell.openExternal(url);
        }
      }
      return { action: "deny" };
    });
    return cnWin;
  }

  let popoutUrl = `http://127.0.0.1:${port}/popout.html?url=${encodeURIComponent(targetUrl)}&title=${encodeURIComponent(title || targetUrl)}`;
  if (opts && opts.jpn) {
    popoutUrl += "&jpn=" + encodeURIComponent(opts.jpn);
  }
  if (opts && opts.cnpn) {
    popoutUrl += "&cnpn=" + encodeURIComponent(opts.cnpn);
  }
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: title || "专利原文查看",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
      webviewTag: true,
    },
  });
  win.loadURL(popoutUrl);
  // 弹窗中点击外部链接时，同样创建带工具栏的弹窗（而不是裸窗口）
  win.webContents.setWindowOpenHandler(({ url }) => {
    console.log("[Electron] popout setWindowOpenHandler url=" + url);
    if (url.startsWith("chrome-extension://")) {
      return { action: "allow" };
    }
    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
      return { action: "allow" };
    }
    createPopoutWindow(url, "专利原文查看", port);
    return { action: "deny" };
  });
  // 拦截 webview 内 guest webContents 的新窗口请求
  // 同域链接在当前 webview 内导航（通过 executeJavaScript 重定向），外部链接开带工具栏的新弹窗
  win.webContents.on("did-attach-webview", (_event, guestWebContents) => {
    console.log("[Electron] popout webview attached");
    guestWebContents.setUserAgent(CHROME_UA);

    const isCNIPAUrl = (u) => u && (u.indexOf("cnipa.gov.cn") !== -1 || u.indexOf("cpquery") !== -1);

    guestWebContents.on("did-start-loading", () => {
      const u = guestWebContents.getURL();
      if (isCNIPAUrl(u)) console.log("[CNIPA webview] did-start-loading:", u);
    });
    guestWebContents.on("did-stop-loading", () => {
      const u = guestWebContents.getURL();
      if (isCNIPAUrl(u)) console.log("[CNIPA webview] did-stop-loading:", u);
    });
    guestWebContents.on("did-fail-load", (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) {
        const u = guestWebContents.getURL();
        if (isCNIPAUrl(u) || isCNIPAUrl(validatedURL)) {
          console.error("[CNIPA webview] did-fail-load:", errorCode, errorDescription, validatedURL);
        }
      }
    });
    guestWebContents.on("did-finish-load", () => {
      const u = guestWebContents.getURL();
      if (isCNIPAUrl(u)) {
        console.log("[CNIPA webview] did-finish-load, title:", guestWebContents.getTitle());
      }
    });
    guestWebContents.on("console-message", (_e, level, message, line, sourceId) => {
      const u = guestWebContents.getURL();
      if (isCNIPAUrl(u)) {
        console.log(`[CNIPA webview console][${level}]`, message, sourceId + ":" + line);
      }
    });
    guestWebContents.on("page-title-updated", (_e, title) => {
      const u = guestWebContents.getURL();
      if (isCNIPAUrl(u)) console.log("[CNIPA webview] page-title-updated:", title);
    });

    guestWebContents.setWindowOpenHandler(({ url }) => {
      console.log("[Electron] webview guest setWindowOpenHandler url=" + url);
      if (!url) return { action: "deny" };
      // 允许 chrome-extension:// 页面（沉浸式翻译设置页等）在新窗口打开
      if (url.startsWith("chrome-extension://")) {
        return { action: "allow" };
      }
      if (!url.startsWith("http")) return { action: "deny" };
      // Determine if same-host by checking the guest's current URL
      try {
        var newHost = new URL(url).hostname;
        var curUrl = guestWebContents.getURL();
        var curHost = curUrl ? new URL(curUrl).hostname : "";
        var lowUrl = url.toLowerCase();
        var isPdf = lowUrl.indexOf(".pdf") !== -1;
        var isHelp = lowUrl.indexOf("/help") !== -1 || lowUrl.indexOf("/faq") !== -1 || lowUrl.indexOf("/print") !== -1;
        if (newHost && curHost && newHost === curHost && !isPdf && !isHelp) {
          // Same host content page: navigate within the webview
          guestWebContents.loadURL(url, { userAgent: CHROME_UA });
          return { action: "deny" };
        }
        if (isPdf || isHelp) {
          shell.openExternal(url);
          return { action: "deny" };
        }
      } catch(e) {}
      // External domain: open as a new popout with toolbar
      createPopoutWindow(url, "专利原文查看", port);
      return { action: "deny" };
    });
  });
  win.webContents.on("did-fail-load", (_e, errorCode, errorDescription) => {
    console.error("[Electron] popout did-fail-load", errorCode, errorDescription, "url=" + popoutUrl);
  });
  return win;
}

// 渲染进程同步的"是否存在未导出 PDF 标注"标志位，供 mainWindow.on('close') 确认
let hasUnsavedAnnotations = false;

// ── 沉浸式翻译 用户脚本自动下载与注入 ──
// 沉浸式翻译支持：优先加载本地解压的Chrome扩展，回退到用户脚本注入
// 用户可将沉浸式翻译Chrome扩展解压到: {userData}/extensions/immersive-translate/
// 该目录下需要有 manifest.json 文件
const IMMERSIVE_TRANSLATE_USERSCRIPT_URL = "https://download.immersivetranslate.com/immersive-translate.user.js";
const IMMERSIVE_TRANSLATE_EXTENSION_ID = "immersive-translate";
let immersiveTranslateScript = null;
let immersiveTranslatePromise = null;
let immersiveTranslateExtension = null;
let immersiveTranslateExtensionTried = false;
let immersiveTranslateStatus = {
  loaded: false,
  method: null, // "extension" | "userscript" | null
  path: null,
  error: null,
};

function downloadText(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const lib = urlObj.protocol === "https:" ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      timeout: 30000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    };
    const req = lib.request(options, (resp) => {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        let loc = resp.headers.location;
        if (loc.startsWith("/")) loc = urlObj.origin + loc;
        downloadText(loc).then(resolve).catch(reject);
        return;
      }
      if (resp.statusCode !== 200) {
        reject(new Error(`HTTP ${resp.statusCode}`));
        return;
      }
      const chunks = [];
      resp.on("data", (chunk) => chunks.push(chunk));
      resp.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

async function prepareImmersiveTranslate() {
  if (immersiveTranslateStatus.loaded) return immersiveTranslateStatus;
  if (immersiveTranslatePromise) return immersiveTranslatePromise;

  immersiveTranslatePromise = (async () => {
    const userDataPath = app.getPath("userData");
    const extensionsDir = path.join(userDataPath, "extensions");
    const extPath = path.join(extensionsDir, IMMERSIVE_TRANSLATE_EXTENSION_ID);
    const manifestPath = path.join(extPath, "manifest.json");

    // Strategy 1: Try loading unpacked Chrome extension (only if not already attempted at startup)
    try {
      if (!immersiveTranslateExtensionTried && fs.existsSync(manifestPath)) {
        immersiveTranslateExtensionTried = true;
        console.log("[Translate] 发现本地扩展目录, 尝试加载 Chrome 扩展:", extPath);
        try {
          const ses = session.defaultSession;
          immersiveTranslateExtension = await ses.loadExtension(extPath, { allowFileAccess: true });
          immersiveTranslateStatus = {
            loaded: true,
            method: "extension",
            path: extPath,
            error: null,
          };
          console.log("[Translate] ✅ Chrome 扩展加载成功:", IMMERSIVE_TRANSLATE_EXTENSION_ID);
          return immersiveTranslateStatus;
        } catch(extErr) {
          console.warn("[Translate] Chrome 扩展加载失败, 回退到用户脚本:", extErr.message);
          immersiveTranslateStatus.error = "Extension load failed: " + extErr.message;
        }
      } else {
        console.log("[Translate] 本地扩展目录不存在:", extPath);
        // Ensure extensions directory exists for user to manually install
        try { fs.mkdirSync(extPath, { recursive: true }); } catch(e) {}
      }
    } catch(e) {
      console.warn("[Translate] 检查扩展目录出错:", e.message);
    }

    // Strategy 2: Download userscript as fallback
    const scriptPath = path.join(userDataPath, "immersive-translate.user.js");
    try {
      // Try cache first
      if (fs.existsSync(scriptPath)) {
        try {
          const stat = fs.statSync(scriptPath);
          const age = Date.now() - stat.mtimeMs;
          if (age < 7 * 24 * 60 * 60 * 1000) {
            immersiveTranslateScript = fs.readFileSync(scriptPath, "utf-8");
            console.log("[Translate] 使用缓存的用户脚本, 长度:", immersiveTranslateScript.length);
            immersiveTranslateStatus = {
              loaded: true,
              method: "userscript",
              path: scriptPath,
              error: null,
            };
            return immersiveTranslateStatus;
          }
        } catch(e) {}
      }
      // Download fresh
      console.log("[Translate] 正在下载沉浸式翻译用户脚本...");
      const script = await downloadText(IMMERSIVE_TRANSLATE_USERSCRIPT_URL);
      if (script && script.length > 10000) {
        immersiveTranslateScript = script;
        try { fs.writeFileSync(scriptPath, script, "utf-8"); } catch(e) {}
        console.log("[Translate] ✅ 用户脚本下载成功, 长度:", script.length);
        immersiveTranslateStatus = {
          loaded: true,
          method: "userscript",
          path: scriptPath,
          error: null,
        };
        return immersiveTranslateStatus;
      } else {
        console.warn("[Translate] 下载的脚本内容异常, 长度:", script ? script.length : 0);
      }
    } catch(e) {
      console.warn("[Translate] 下载用户脚本失败:", e.message);
      immersiveTranslateStatus.error = e.message;
    }

    // Fallback: expired cache
    try {
      if (fs.existsSync(scriptPath)) {
        immersiveTranslateScript = fs.readFileSync(scriptPath, "utf-8");
        console.log("[Translate] 使用过期的缓存脚本");
        immersiveTranslateStatus = {
          loaded: true,
          method: "userscript",
          path: scriptPath,
          error: "expired cache",
        };
        return immersiveTranslateStatus;
      }
    } catch(e2) {}

    // Nothing worked
    if (!immersiveTranslateStatus.loaded) {
      immersiveTranslateStatus = {
        loaded: false,
        method: null,
        path: extPath,
        error: immersiveTranslateStatus.error || "无法加载沉浸式翻译，请手动安装Chrome扩展到: " + extPath,
      };
    }
    return immersiveTranslateStatus;
  })();

  return immersiveTranslatePromise;
}

app.whenReady().then(async () => {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(true);
  });

  // 优先尝试加载本地Chrome扩展（同步等待，确保扩展在窗口创建前加载完成）
  // 用户脚本下载是异步的，不阻塞窗口创建
  const userDataPath = app.getPath("userData");
  const extPath = path.join(userDataPath, "extensions", IMMERSIVE_TRANSLATE_EXTENSION_ID);
  const manifestPath = path.join(extPath, "manifest.json");
  try {
    if (fs.existsSync(manifestPath)) {
      immersiveTranslateExtensionTried = true;
      try { fs.mkdirSync(extPath, { recursive: true }); } catch(e) {}
      try {
        immersiveTranslateExtension = await ses.loadExtension(extPath, { allowFileAccess: true });
        immersiveTranslateStatus = {
          loaded: true,
          method: "extension",
          path: extPath,
          error: null,
        };
        console.log("[Translate] ✅ Chrome 扩展加载成功:", IMMERSIVE_TRANSLATE_EXTENSION_ID);
      } catch(extErr) {
        console.warn("[Translate] Chrome 扩展加载失败:", extErr.message);
        immersiveTranslateStatus.error = "Extension load failed: " + extErr.message;
      }
    } else {
      immersiveTranslateExtensionTried = true;
      try { fs.mkdirSync(extPath, { recursive: true }); } catch(e) {}
    }
  } catch(e) {
    immersiveTranslateExtensionTried = true;
    console.warn("[Translate] 检查扩展目录出错:", e.message);
  }
  // 异步下载用户脚本（回退方案，不阻塞窗口创建）
  prepareImmersiveTranslate();
  // IPC: 渲染进程请求在系统浏览器中打开外部链接
  ipcMain.on("open-external", (_event, url) => {
    if (typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"))) {
      shell.openExternal(url);
    }
  });

  // IPC: 渲染进程同步当前是否存在未导出的 PDF 标注（用于关闭前确认）
  ipcMain.on("set-has-annotations", (_event, val) => {
    hasUnsavedAnnotations = !!val;
  });

  // IPC: 渲染进程请求创建弹出窗口（直连，不依赖 window.open → setWindowOpenHandler 链路）
  ipcMain.on("open-popout-window", (_event, targetUrl, title, opts) => {
    if (typeof targetUrl === "string" && _serverPort) {
      createPopoutWindow(targetUrl, title, _serverPort, opts || null);
    }
  });

  // IPC: 获取沉浸式翻译用户脚本（供渲染进程注入到webview中）
  ipcMain.handle("get-immersive-translate-status", async () => {
    await prepareImmersiveTranslate();
    return {
      ...immersiveTranslateStatus,
      script: immersiveTranslateScript,
      extensionsDir: path.join(app.getPath("userData"), "extensions"),
    };
  });

  ipcMain.handle("get-immersive-translate-script", async () => {
    if (immersiveTranslateScript) return immersiveTranslateScript;
    await prepareImmersiveTranslate();
    return immersiveTranslateScript;
  });

  ipcMain.handle("open-extensions-folder", async () => {
    const extDir = path.join(app.getPath("userData"), "extensions", IMMERSIVE_TRANSLATE_EXTENSION_ID);
    try { fs.mkdirSync(extDir, { recursive: true }); } catch(e) {}
    shell.openPath(extDir);
    return extDir;
  });

  // IPC: 渲染进程请求导出含标注的 PDF（主进程执行，fontkit 可靠可用）
  ipcMain.handle("export-pdf-annotations", async (_event, { pdfBytes, annots, patentNum, docTitle }) => {
    try {
      const pdfDoc = await PDFDocument.load(Buffer.from(pdfBytes));
      pdfDoc.registerFontkit(fontkit);

      // 加载 CJK 字体（用于注释文字）
      let cjkFont = null;
      const hasNoteText = annots.some(a => a.type === "note" && a.text);
      if (hasNoteText) {
        const cjkFontPath = findCjkFont();
        if (cjkFontPath) {
          try {
            const fontBytes = fs.readFileSync(cjkFontPath);
            // 不使用 subset:true — CJK 字体（特别是 TTC/CFF 格式）子集化会导致
            // fontkit CFFSubset.encode RangeError 崩溃，全量嵌入更可靠
            cjkFont = await pdfDoc.embedFont(fontBytes);
            console.log("[ExportPDF] 加载 CJK 字体:", cjkFontPath);
          } catch (e) { console.warn("[ExportPDF] CJK 字体加载失败:", e.message); }
        }
      }

      const pages = pdfDoc.getPages();
      for (const annot of annots) {
        const page = pages[annot.page - 1];
        if (!page) continue;
        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(annot.color || "");
        const cr = m ? parseInt(m[1], 16) / 255 : 229 / 255;
        const cg = m ? parseInt(m[2], 16) / 255 : 57 / 255;
        const cb = m ? parseInt(m[3], 16) / 255 : 53 / 255;
        const col = rgb(cr, cg, cb);
        const lineW = annot.lineWidth || 2;

        // Helper: draw a line (supports dash)
        const drawStyledLine = (x1, y1, x2, y2, thickness, isDash) => {
          if (!isDash) {
            page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: thickness, color: col });
            return;
          }
          // Draw dashed line as segments
          const dx = x2 - x1;
          const dy = y2 - y1;
          const totalLen = Math.sqrt(dx * dx + dy * dy);
          const dashLen = thickness * 3;
          const gapLen = thickness * 2;
          const cycleLen = dashLen + gapLen;
          if (totalLen < 1) return;
          const ux = dx / totalLen;
          const uy = dy / totalLen;
          let pos = 0;
          while (pos < totalLen) {
            const segStart = pos;
            const segEnd = Math.min(pos + dashLen, totalLen);
            page.drawLine({
              start: { x: x1 + ux * segStart, y: y1 + uy * segStart },
              end: { x: x1 + ux * segEnd, y: y1 + uy * segEnd },
              thickness: thickness, color: col,
            });
            pos += cycleLen;
          }
        };

        if (annot.type === "highlight") {
          const x1 = Math.min(annot.x1, annot.x2);
          const x2 = Math.max(annot.x1, annot.x2);
          const y1 = Math.min(annot.y1, annot.y2);
          const y2 = Math.max(annot.y1, annot.y2);
          page.drawRectangle({
            x: x1, y: y1, width: x2 - x1, height: y2 - y1,
            borderColor: col, borderWidth: lineW,
            color: col, opacity: 0.12,
          });
        } else if (annot.type === "underline") {
          drawStyledLine(annot.x1, annot.y1, annot.x2, annot.y2, lineW, annot.dash);
        } else if (annot.type === "arrow") {
          drawStyledLine(annot.x1, annot.y1, annot.x2, annot.y2, lineW, annot.dash);
          const angle = Math.atan2(annot.y2 - annot.y1, annot.x2 - annot.x1);
          const headLen = 6 + lineW * 2;
          const headAngle = 0.4;
          const hx1 = annot.x2 - headLen * Math.cos(angle - headAngle);
          const hy1 = annot.y2 - headLen * Math.sin(angle - headAngle);
          const hx2 = annot.x2 - headLen * Math.cos(angle + headAngle);
          const hy2 = annot.y2 - headLen * Math.sin(angle + headAngle);
          page.drawLine({ start: { x: annot.x2, y: annot.y2 }, end: { x: hx1, y: hy1 }, thickness: lineW, color: col });
          page.drawLine({ start: { x: annot.x2, y: annot.y2 }, end: { x: hx2, y: hy2 }, thickness: lineW, color: col });
        } else if (annot.type === "note" && annot.text && cjkFont) {
          const fontSize = annot.fontSize || 14;
          // 归一化坐标：PDF 坐标系 Y 轴自下而上，拖拽方向可能不同
          const pdfLeft = Math.min(annot.x1, annot.x2);
          const pdfRight = Math.max(annot.x1, annot.x2);
          const pdfBottom = Math.min(annot.y1, annot.y2);
          const pdfTop = Math.max(annot.y1, annot.y2);
          const maxWidth = Math.max(40, pdfRight - pdfLeft);
          const lines = annot.text.split("\n");
          const lineHeight = fontSize * 1.3;
          // 基线从顶部下方 fontSize 处开始（文字从基线向上延伸到顶部附近）
          let curY = pdfTop - fontSize * 0.85;
          for (let li = 0; li < lines.length; li++) {
            if (curY < pdfBottom) break;
            try {
              page.drawText(lines[li], {
                x: pdfLeft, y: curY,
                size: fontSize, font: cjkFont,
                color: col, maxWidth: maxWidth,
              });
            } catch (e) { /* 无法编码的字符跳过 */ }
            curY -= lineHeight;
          }
        }
      }

      const out = await pdfDoc.save();
      return { success: true, data: Buffer.from(out).toString("base64") };
    } catch (e) {
      console.error("[ExportPDF] 导出失败:", e);
      return { success: false, error: e.message };
    }
  });

  const port = await startServer();
  _serverPort = port;
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
