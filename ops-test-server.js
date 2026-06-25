/**
 * EPO OPS 独立测试服务器
 * 用法：node ops-test-server.js
 * 浏览器访问：http://localhost:9099
 *
 * 零依赖，仅用 Node.js 内置模块 + curl。
 * 用于实测 OPS 各端点调用效果，验证 key/secret 是否可用。
 */

const http = require("http");
const { execFile } = require("child_process");
const url = require("url");
const fs = require("fs");
const os = require("os");
const path = require("path");

const OPS_API_BASE = "https://ops.epo.org/3.2/rest-services";
const OPS_AUTH_URL = "https://ops.epo.org/3.2/auth/accesstoken";
const PORT = 9099;

// ── Token 缓存 ──
const tokenCache = new Map();

function getCredsKey(consumerKey, consumerSecret) {
  return consumerKey + ":" + consumerSecret;
}

// 创建临时文件路径（用于存放 curl 响应头）
function tmpHeaderPath() {
  return path.join(os.tmpdir(), "ops_headers_" + process.pid + "_" + Date.now() + "_" + Math.random().toString(36).slice(2) + ".txt");
}

// 从临时头文件读取并解析头部字符串
function readHeaderFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    return content;
  } catch (e) {
    return "";
  } finally {
    try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
  }
}

async function getOpsToken(consumerKey, consumerSecret) {
  if (!consumerKey || !consumerSecret) {
    return { error: "缺少 consumer_key 或 consumer_secret" };
  }
  const cacheKey = getCredsKey(consumerKey, consumerSecret);
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return { token: cached.token, fromCache: true };
  }

  const credentials = Buffer.from(consumerKey + ":" + consumerSecret).toString("base64");
  const body = "grant_type=client_credentials";
  const headerFile = tmpHeaderPath();

  const result = await new Promise((resolve) => {
    execFile("curl", [
      "-s",
      "-D", headerFile,
      "-w", "\n__HTTP_CODE__%{http_code}",
      "--max-time", "15",
      "-X", "POST",
      "-H", "Authorization: Basic " + credentials,
      "-H", "Content-Type: application/x-www-form-urlencoded",
      "-d", body,
      OPS_AUTH_URL,
    ], { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      const headers = readHeaderFile(headerFile);
      if (err) { resolve({ error: "curl 错误: " + err.message }); return; }

      const marker = "\n__HTTP_CODE__";
      const idx = stdout.lastIndexOf(marker);
      let httpCode = 200;
      let jsonBody = stdout;
      if (idx !== -1) {
        httpCode = parseInt(stdout.substring(idx + marker.length), 10);
        jsonBody = stdout.substring(0, idx);
      }

      resolve({ httpCode, headers, body: jsonBody });
    });
  });

  if (result.error) return result;
  if (result.httpCode !== 200) {
    return {
      error: "认证失败 HTTP " + result.httpCode,
      httpCode: result.httpCode,
      responseBody: result.body,
      responseHeaders: result.headers,
    };
  }

  let tokenData;
  try {
    tokenData = JSON.parse(result.body);
  } catch (e) {
    return { error: "Token 响应解析失败: " + e.message, responseBody: result.body };
  }

  if (!tokenData.access_token) {
    return { error: "响应中无 access_token", responseBody: result.body };
  }

  tokenCache.set(cacheKey, {
    token: tokenData.access_token,
    expiresAt: Date.now() + ((parseInt(tokenData.expires_in, 10) || 3600) - 300) * 1000,
    quota: null,
  });

  return { token: tokenData.access_token, expiresIn: tokenData.expires_in, raw: tokenData };
}

// ── 通用 OPS 请求 ──
async function opsRequest(consumerKey, consumerSecret, opsPath, accept) {
  accept = accept || "application/xml";
  const tokenResult = await getOpsToken(consumerKey, consumerSecret);
  if (tokenResult.error) return tokenResult;
  const token = tokenResult.token;

  const fullUrl = OPS_API_BASE + opsPath;
  const headerFile = tmpHeaderPath();

  const result = await new Promise((resolve) => {
    execFile("curl", [
      "-s",
      "-D", headerFile,
      "-w", "\n__HTTP_CODE__%{http_code}",
      "--max-time", "30",
      "-H", "Authorization: Bearer " + token,
      "-H", "Accept: " + accept,
      fullUrl,
    ], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      const headers = readHeaderFile(headerFile);
      if (err) { resolve({ error: "curl 错误: " + err.message }); return; }

      const marker = "\n__HTTP_CODE__";
      const idx = stdout.lastIndexOf(marker);
      let httpCode = 200;
      let body = stdout;
      if (idx !== -1) {
        httpCode = parseInt(stdout.substring(idx + marker.length), 10);
        body = stdout.substring(0, idx);
      }

      resolve({ httpCode, headers, body: body, url: fullUrl });
    });
  });

  // 解析配额头并更新缓存
  if (result.headers) {
    const throttleMatch = result.headers.match(/X-Throttling-Control:\s*([^\r\n]+)/i);
    if (throttleMatch) {
      const cacheKey = getCredsKey(consumerKey, consumerSecret);
      const cached = tokenCache.get(cacheKey);
      if (cached) {
        cached.quota = throttleMatch[1].trim();
        cached.quotaUpdated = Date.now();
      }
    }
    // 解析更详细的配额信息
    const hourMatch = result.headers.match(/x-individualquotaperhour-used:\s*(\d+)/i);
    const weekMatch = result.headers.match(/x-registeredquotaperweek-used:\s*(\d+)/i);
    if (hourMatch || weekMatch) {
      const cacheKey = getCredsKey(consumerKey, consumerSecret);
      const cached = tokenCache.get(cacheKey);
      if (cached) {
        cached.quotaHourUsed = hourMatch ? parseInt(hourMatch[1], 10) : cached.quotaHourUsed;
        cached.quotaWeekUsed = weekMatch ? parseInt(weekMatch[1], 10) : cached.quotaWeekUsed;
      }
    }
  }

  return result;
}

// ── 二进制下载（PDF 单页）──
async function opsDownloadBinary(consumerKey, consumerSecret, opsPath) {
  const tokenResult = await getOpsToken(consumerKey, consumerSecret);
  if (tokenResult.error) return tokenResult;
  const token = tokenResult.token;

  const fullUrl = OPS_API_BASE + opsPath;
  const headerFile = tmpHeaderPath();

  return new Promise((resolve) => {
    execFile("curl", [
      "-s",
      "-D", headerFile,
      "-w", "\n__HTTP_CODE__%{http_code}",
      "--max-time", "30",
      "-H", "Authorization: Bearer " + token,
      "-H", "Accept: application/pdf",
      fullUrl,
    ], { maxBuffer: 30 * 1024 * 1024, encoding: "buffer" }, (err, stdoutBuffer) => {
      const headers = readHeaderFile(headerFile);
      if (err) { resolve({ error: "curl 错误: " + err.message }); return; }

      const marker = Buffer.from("\n__HTTP_CODE__");
      let idx = -1;
      for (let i = Math.max(0, stdoutBuffer.length - 20); i < stdoutBuffer.length; i++) {
        if (stdoutBuffer.subarray(i, i + marker.length).equals(marker)) {
          idx = i; break;
        }
      }
      let httpCode = 200;
      let finalBody = stdoutBuffer;
      if (idx !== -1) {
        httpCode = parseInt(stdoutBuffer.subarray(idx + marker.length).toString().trim(), 10);
        finalBody = stdoutBuffer.subarray(0, idx);
      }

      resolve({ httpCode, headers: headers, body: finalBody, url: fullUrl });
    });
  });
}

// ── HTTP 服务器 ──
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlObj = url.parse(req.url, true);

  // 首页
  if (urlObj.pathname === "/" || urlObj.pathname === "/index.html") {
    const htmlPath = path.join(__dirname, "ops-test-page.html");
    fs.readFile(htmlPath, (err, data) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("读取页面失败: " + err.message);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
    return;
  }

  // API: 测试 token
  if (urlObj.pathname === "/api/token") {
    const { consumerKey, consumerSecret } = urlObj.query;
    const result = await getOpsToken(consumerKey, consumerSecret);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result, null, 2));
    return;
  }

  // API: 查询配额
  if (urlObj.pathname === "/api/quota") {
    const { consumerKey, consumerSecret } = urlObj.query;
    const cacheKey = getCredsKey(consumerKey, consumerSecret);
    const cached = tokenCache.get(cacheKey);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      quota: cached ? cached.quota : null,
      quotaHourUsed: cached ? cached.quotaHourUsed : null,
      quotaWeekUsed: cached ? cached.quotaWeekUsed : null,
      quotaUpdated: cached ? cached.quotaUpdated : null,
      tokenCached: !!cached,
      tokenExpiresAt: cached ? cached.expiresAt : null,
    }, null, 2));
    return;
  }

  // API: 通用 OPS 端点调用
  if (urlObj.pathname === "/api/ops") {
    const { consumerKey, consumerSecret, path: opsPath, accept } = urlObj.query;
    if (!opsPath) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "缺少 path 参数" }));
      return;
    }
    const result = await opsRequest(consumerKey, consumerSecret, opsPath, accept || "application/xml");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result, null, 2));
    return;
  }

  // API: 预设端点快捷调用
  if (urlObj.pathname === "/api/preset") {
    const { consumerKey, consumerSecret, endpoint, patentNumber } = urlObj.query;
    const num = (patentNumber || "").toUpperCase().replace(/[\s\/]/g, "");
    if (!num) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "缺少 patentNumber" }));
      return;
    }

    let opsPath;
    let desc;
    switch (endpoint) {
      case "biblio":
        opsPath = "/published-data/publication/epodoc/" + encodeURIComponent(num) + "/biblio";
        desc = "著录项目（标题、申请人、发明人、日期、分类号、向后引用）";
        break;
      case "abstract":
        opsPath = "/published-data/publication/epodoc/" + encodeURIComponent(num) + "/abstract";
        desc = "摘要";
        break;
      case "claims":
        opsPath = "/published-data/publication/epodoc/" + encodeURIComponent(num) + "/claims";
        desc = "权利要求";
        break;
      case "description":
        opsPath = "/published-data/publication/epodoc/" + encodeURIComponent(num) + "/description";
        desc = "说明书";
        break;
      case "images":
        opsPath = "/published-data/publication/epodoc/" + encodeURIComponent(num) + "/images";
        desc = "附图/文档信息";
        break;
      case "equivalent":
        opsPath = "/published-data/publication/epodoc/" + encodeURIComponent(num) + "/equivalent";
        desc = "同族等效文献";
        break;
      case "legal":
        opsPath = "/published-data/publication/epodoc/" + encodeURIComponent(num) + "/legal";
        desc = "法律状态";
        break;
      case "citing":
        opsPath = "/published-data/search/?q=" + encodeURIComponent("ct=" + num) + "&Range=1-25";
        desc = "向前引用（谁引用了本专利）";
        break;
      case "images-docdb": {
        const m = num.match(/^([A-Z]{2})(\d+)([A-Z]\d*)?$/);
        if (!m) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "号码格式无法转为 docdb" }));
          return;
        }
        const docdb = m[1] + "." + m[2] + "." + (m[3] || "A1");
        opsPath = "/published-data/publication/docdb/" + docdb + "/images";
        desc = "文档可用性（docdb 格式 " + docdb + "，含总页数）";
        break;
      }
      default:
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "未知 endpoint: " + endpoint }));
        return;
    }

    console.log("[OPS] " + endpoint + " → " + opsPath);
    const result = await opsRequest(consumerKey, consumerSecret, opsPath);
    const enriched = Object.assign({}, result, { desc: desc, endpoint: endpoint, patentNumber: num });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(enriched, null, 2));
    return;
  }

  // API: 下载单页 PDF
  if (urlObj.pathname === "/api/pdf-page") {
    const { consumerKey, consumerSecret, country, docNumber, kind, page } = urlObj.query;
    if (!country || !docNumber || !kind || !page) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "缺少参数 country/docNumber/kind/page" }));
      return;
    }
    const opsPath = "/published-data/images/" + country + "/" + docNumber + "/" + kind + "/fullimage.pdf?Range=" + page;
    console.log("[OPS-PDF] 下载第 " + page + " 页: " + opsPath);
    const result = await opsDownloadBinary(consumerKey, consumerSecret, opsPath);
    if (result.error || result.httpCode !== 200) {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(result, null, 2));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline; filename=\"page_" + page + ".pdf\"",
    });
    res.end(result.body);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log("");
  console.log("┌─────────────────────────────────────────────┐");
  console.log("│  EPO OPS 测试服务器已启动                    │");
  console.log("│  浏览器访问: http://localhost:" + PORT + "          │");
  console.log("│  按 Ctrl+C 停止                              │");
  console.log("└─────────────────────────────────────────────┘");
  console.log("");
});
