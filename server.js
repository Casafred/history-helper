const http = require("http");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const GD_API_BASE = "https://d1kazzu6rbodne.cloudfront.net";
const JPO_API_BASE = "https://ip-data.jpo.go.jp";
const DPMA_REGISTER_BASE = "https://register.dpma.de";
const GOOGLE_PATENTS_BASE = "https://patents.google.com";
// EPO OPS（Open Patent Services）API v3.2 —— 作为 Google Patents 的降级数据源
const OPS_API_BASE = "https://ops.epo.org/3.2/rest-services";
const OPS_AUTH_URL = "https://ops.epo.org/3.2/auth/accesstoken";
// 系统代理：优先取 HTTPS_PROXY / HTTP_PROXY 环境变量，否则使用默认值
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "http://127.0.0.1:7897";
const PORT = 8080;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

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
  const url = GD_API_BASE + urlPath;

  if (urlPath.includes("/doc-content/")) {
    const args = [
      "-s",
      "-w", " HTTP_CODE_%{http_code}",
      "--max-time", "60",
      "-H", "user-type: external",
      "-H", "Accept: application/pdf,*/*",
      "-H", "Referer: https://globaldossier.uspto.gov/",
      "-H", "Origin: https://globaldossier.uspto.gov",
      "-H", "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      url,
    ];

    execFile("curl", args, { maxBuffer: 50 * 1024 * 1024, encoding: "buffer" }, (err, stdoutBuffer) => {
      if (err) {
        res.writeHead(502, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
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
      "-H", "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      url,
    ];

    execFile("curl", args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        res.writeHead(502, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
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

      const respHeaders = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, user-type",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      };
      res.writeHead(httpCode, respHeaders);
      res.end(body);
    });
  }
}

// ── JPO API proxy ──────────────────────────────────────────────────────────

let jpoAccessToken = null;
let jpoTokenExpires = 0;

async function getJpoToken() {
  const username = process.env.JPO_API_USERNAME;
  const password = process.env.JPO_API_PASSWORD;
  if (!username || !password) return null;

  if (jpoAccessToken && Date.now() < jpoTokenExpires) return jpoAccessToken;

  const tokenUrl = `${JPO_API_BASE}/oauth2/token`;
  const body = `grant_type=password&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

  const result = await new Promise((resolve) => {
    execFile("curl", [
      "-s", "-w", "\n__HTTP_CODE__%{http_code}",
      "--max-time", "15",
      "-X", "POST",
      "-H", `Host: ip-data.jpo.go.jp`,
      "-H", "Content-Type: application/x-www-form-urlencoded",
      "-d", body,
      tokenUrl,
    ], { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      const marker = "\n__HTTP_CODE__";
      const idx = stdout.lastIndexOf(marker);
      let httpCode = 200;
      let jsonBody = stdout;
      if (idx !== -1) {
        httpCode = parseInt(stdout.substring(idx + marker.length), 10);
        jsonBody = stdout.substring(0, idx);
      }
      if (httpCode !== 200) { resolve(null); return; }
      try {
        const data = JSON.parse(jsonBody);
        resolve(data);
      } catch { resolve(null); }
    });
  });

  if (!result || !result.access_token) return null;
  jpoAccessToken = result.access_token;
  jpoTokenExpires = Date.now() + ((result.expires_in || 3600) - 300) * 1000;
  return jpoAccessToken;
}

function proxyJpoDoc(docType, appNumber, res) {
  const endpointMap = {
    refusal_reason: "app_doc_cont_refusal_reason",
    dispatch: "app_doc_cont_dispatch",
    submission: "app_doc_cont_submission",
    trial: "app_doc_cont_trial",
  };
  const endpoint = endpointMap[docType] || "app_doc_cont_dispatch";
  const url = `${JPO_API_BASE}/api/patent/v1/${endpoint}/${appNumber}`;

  (async () => {
    const token = await getJpoToken();
    if (!token) {
      res.writeHead(503, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "JPO API 未配置 (需设置 JPO_API_USERNAME / JPO_API_PASSWORD)" }));
      return;
    }

    const args = [
      "-s", "-w", " HTTP_CODE_%{http_code}",
      "--max-time", "60",
      "-H", `Authorization: Bearer ${token}`,
      "-H", "Host: ip-data.jpo.go.jp",
      "-H", "Accept: application/zip,*/*",
      url,
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
          idx = i; break;
        }
      }

      let httpCode = 200;
      let bodyBuffer = stdoutBuffer;
      if (idx !== -1) {
        httpCode = parseInt(stdoutBuffer.slice(idx + markerBuffer.length).toString().trim(), 10);
        bodyBuffer = stdoutBuffer.slice(0, idx);
      }

      const isZip = bodyBuffer.length > 2 && bodyBuffer[0] === 0x50 && bodyBuffer[1] === 0x4b;
      res.writeHead(httpCode, {
        "Content-Type": isZip ? "application/zip" : "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      });
      res.end(bodyBuffer);
    });
  })();
}

// ── DPMA register proxy ────────────────────────────────────────────────────

function proxyDpmaRegisterInfo(number, res) {
  // 将号码转换为 AKZ 格式
  let akz = number;
  if (akz.startsWith("DE") || akz.startsWith("de")) akz = akz.substring(2);
  // 去除公开类型后缀
  while (akz.length > 0 && /[A-Za-z]/.test(akz[akz.length - 1])) {
    akz = akz.substring(0, akz.length - 1);
  }
  // 去除空格和点
  akz = akz.replace(/[\s.]/g, "");
  // 如果10位数字，计算校验位
  if (/^\d{10}$/.test(akz)) {
    const weights = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3];
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += parseInt(akz[i]) * weights[i];
    const check = (11 - (sum % 11)) % 11;
    akz = akz + check;
  }

  const registerUrl = `${DPMA_REGISTER_BASE}/DPMAregister/pat/register?AKZ=${encodeURIComponent(akz)}&CURSOR=0`;

  const args = [
    "-s", "-w", "\n__HTTP_CODE__%{http_code}",
    "--max-time", "30",
    "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "-H", "Accept-Language: de,en-US;q=0.7,en;q=0.3",
    "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    registerUrl,
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

    // 返回HTML让前端解析，或直接返回原始内容
    res.writeHead(httpCode, {
      "Content-Type": "text/html; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
    res.end(body);
  });
}

function proxyDpmaDownload(reqUrl, res) {
  // reqUrl = /api/de/download?uri=...
  const urlObj = new URL(reqUrl, "http://localhost");
  const targetUrl = urlObj.searchParams.get("uri");
  if (!targetUrl) {
    res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ error: "Missing uri parameter" }));
    return;
  }

  const args = [
    "-s", "-w", " HTTP_CODE_%{http_code}",
    "--max-time", "60",
    "-H", "Accept: application/pdf,*/*",
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
        idx = i; break;
      }
    }

    let httpCode = 200;
    let bodyBuffer = stdoutBuffer;
    if (idx !== -1) {
      httpCode = parseInt(stdoutBuffer.slice(idx + markerBuffer.length).toString().trim(), 10);
      bodyBuffer = stdoutBuffer.slice(0, idx);
    }

    const isPdf = bodyBuffer.length > 2 && bodyBuffer[0] === 0x25 && bodyBuffer[1] === 0x50;
    res.writeHead(httpCode, {
      "Content-Type": isPdf ? "application/pdf" : "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
    res.end(bodyBuffer);
  });
}

// ── EPO OPS 降级查询模块 ──────────────────────────────────────────────────────
// 作为 Google Patents 的降级数据源：GP 抓取失败时自动切换到 OPS 查询
// 参考：https://github.com/talenlin/epo-ops-mcp
// 关键点：
//   1. Accept: application/json（OPS 返回 JSON）
//   2. EPODOC 格式 doc-number 不含 kind code，需自动分离
//   3. Token 缓存 + 自动刷新（提前 5 分钟刷新）
//   4. 配额信息从响应头解析并缓存（前端 20 分钟自动刷新显示）

// OPS Token 缓存：key = consumerKey:consumerSecret
const opsTokenCache = new Map();
// OPS 配额缓存：key = consumerKey:consumerSecret
const opsQuotaCache = new Map();
// 配额缓存有效期 20 分钟（与前端自动刷新周期对齐）
const OPS_QUOTA_CACHE_TTL = 20 * 60 * 1000;

// 临时响应头文件路径（避免 HTTP/2 分隔符问题）
function opsTmpHeaderPath() {
  const os = require("os");
  return path.join(os.tmpdir(), "ops_hdr_" + process.pid + "_" + Date.now() + "_" + Math.random().toString(36).slice(2) + ".txt");
}

function opsReadHeaderFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return "";
  } finally {
    try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
  }
}

// 获取 OPS Token（带缓存）
async function getOpsToken(consumerKey, consumerSecret) {
  if (!consumerKey || !consumerSecret) {
    return { error: "缺少 OPS consumer key 或 secret" };
  }
  const cacheKey = consumerKey + ":" + consumerSecret;
  const cached = opsTokenCache.get(cacheKey);
  // 提前 5 分钟刷新 token（EPO token 通常 20 分钟有效）
  if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
    return { token: cached.token, fromCache: true };
  }

  const credentials = Buffer.from(consumerKey + ":" + consumerSecret).toString("base64");
  const headerFile = opsTmpHeaderPath();

  const result = await new Promise((resolve) => {
    execFile("curl", [
      "-s", "-D", headerFile, "-w", "\n__HTTP_CODE__%{http_code}",
      "--max-time", "15", "-X", "POST",
      "-H", "Authorization: Basic " + credentials,
      "-H", "Content-Type: application/x-www-form-urlencoded",
      "-d", "grant_type=client_credentials",
      OPS_AUTH_URL,
    ], { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      const headers = opsReadHeaderFile(headerFile);
      if (err) { resolve({ error: "curl 错误: " + err.message }); return; }
      const marker = "\n__HTTP_CODE__";
      const idx = stdout.lastIndexOf(marker);
      let httpCode = 200, jsonBody = stdout;
      if (idx !== -1) {
        httpCode = parseInt(stdout.substring(idx + marker.length), 10);
        jsonBody = stdout.substring(0, idx);
      }
      resolve({ httpCode, headers, body: jsonBody });
    });
  });

  if (result.error) return result;
  if (result.httpCode !== 200) {
    return { error: "OPS 认证失败 HTTP " + result.httpCode, httpCode: result.httpCode, responseBody: result.body };
  }
  let tokenData;
  try { tokenData = JSON.parse(result.body); } catch (e) {
    return { error: "OPS Token 解析失败: " + e.message, responseBody: result.body };
  }
  if (!tokenData.access_token) {
    return { error: "OPS 响应无 access_token", responseBody: result.body };
  }
  opsTokenCache.set(cacheKey, {
    token: tokenData.access_token,
    expiresAt: Date.now() + ((parseInt(tokenData.expires_in, 10) || 1200) - 60) * 1000,
  });
  return { token: tokenData.access_token };
}

// 通用 OPS GET 请求（JSON 格式）
async function opsRequest(consumerKey, consumerSecret, opsPath) {
  const tokenResult = await getOpsToken(consumerKey, consumerSecret);
  if (tokenResult.error) return tokenResult;
  const token = tokenResult.token;
  const fullUrl = OPS_API_BASE + opsPath;
  const headerFile = opsTmpHeaderPath();

  const result = await new Promise((resolve) => {
    execFile("curl", [
      "-s", "-D", headerFile, "-w", "\n__HTTP_CODE__%{http_code}",
      "--max-time", "30",
      "-H", "Authorization: Bearer " + token,
      "-H", "Accept: application/json",
      fullUrl,
    ], { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
      const headers = opsReadHeaderFile(headerFile);
      if (err) { resolve({ error: "curl 错误: " + err.message }); return; }
      const marker = "\n__HTTP_CODE__";
      const idx = stdout.lastIndexOf(marker);
      let httpCode = 200, body = stdout;
      if (idx !== -1) {
        httpCode = parseInt(stdout.substring(idx + marker.length), 10);
        body = stdout.substring(0, idx);
      }
      resolve({ httpCode, headers, body, url: fullUrl });
    });
  });

  // 解析配额头并更新缓存
  if (result.headers) {
    const cacheKey = consumerKey + ":" + consumerSecret;
    const throttleMatch = result.headers.match(/x-throttling-control:\s*([^\r\n]+)/i);
    const hourMatch = result.headers.match(/x-individualquotaperhour-used:\s*(\d+)/i);
    const weekMatch = result.headers.match(/x-registeredquotaperweek-used:\s*(\d+)/i);
    if (throttleMatch || hourMatch || weekMatch) {
      opsQuotaCache.set(cacheKey, {
        throttle: throttleMatch ? throttleMatch[1].trim() : null,
        hourUsed: hourMatch ? parseInt(hourMatch[1], 10) : null,
        weekUsed: weekMatch ? parseInt(weekMatch[1], 10) : null,
        updatedAt: Date.now(),
      });
    }
  }
  return result;
}

// 解析专利号：分离 country / docNumber / kindCode
// EP3787843B1 → { country: "EP", docNumber: "3787843", kindCode: "B1", epodocNum: "EP3787843" }
function parseOpsPatentNumber(input) {
  const num = input.toUpperCase().replace(/[\s\/]/g, "");
  const m = num.match(/^([A-Z]{2})(\d+)([A-Z]\d*)?$/);
  if (!m) return { error: "无法解析专利号: " + input };
  const country = m[1];
  const docNumber = m[2];
  const kindCode = m[3] || "";
  return { country, docNumber, kindCode, epodocNum: country + docNumber, original: num };
}

// ── OPS JSON 数据解析辅助函数 ──

// 从 OPS document-id 数组中提取指定类型的号码
function opsExtractDocId(docIdList, idType) {
  if (!Array.isArray(docIdList)) docIdList = [docIdList];
  for (const d of docIdList) {
    if (d && d["@id-type"] === idType) {
      return { country: d.country, docNumber: d["doc-number"], kind: d.kind };
    }
  }
  return null;
}

// 安全提取数组（OPS JSON 单值时不是数组）
function opsArray(val) {
  if (val == null) return [];
  return Array.isArray(val) ? val : [val];
}

// 提取日期 YYYY-MM-DD（从 date 字段）
function opsFormatDate(dateStr) {
  if (!dateStr || typeof dateStr !== "string") return "";
  // OPS 日期格式通常是 YYYYMMDD
  if (/^\d{8}$/.test(dateStr)) {
    return dateStr.substring(0, 4) + "-" + dateStr.substring(4, 6) + "-" + dateStr.substring(6, 8);
  }
  return dateStr;
}

// ── OPS JSON → Google Patents 数据结构转换 ──
// 输出结构必须与 server.js extractPatentFromHtml 输出一致
// 参见 web-app.js renderPatentDetail 期望的字段
function convertOpsToGpStructure(patentInput, biblioData, abstractData, claimsData, descriptionData, legalData, familyData, citingData) {
  const parsed = parseOpsPatentNumber(patentInput);
  const patentNumber = parsed.original || patentInput;

  // biblio 数据根节点：ops:world-patent-data > ops:biblio-search > ops:search-result > exchange-document
  let biblioRoot = null;
  try {
    biblioRoot = biblioData["ops:world-patent-data"]["ops:biblio-search"]["ops:search-result"]["exchange-document"];
    if (Array.isArray(biblioRoot)) biblioRoot = biblioRoot[0];
  } catch (e) { /* biblio 可能缺失 */ }
  if (!biblioRoot && biblioData) {
    // 某些响应直接返回 exchange-document
    biblioRoot = biblioData["exchange-document"] || biblioData;
  }

  const result = {
    patent_number: patentNumber,
    title: "",
    url: GOOGLE_PATENTS_BASE + "/patent/" + encodeURIComponent(patentNumber),
    pdf_link: "",
    external_links: {},
    abstract: "",
    inventors: [],
    assignees: [],
    application_date: "",
    publication_date: "",
    priority_date: "",
    classifications: [],
    landscapes: [],
    family_id: "",
    family_applications: [],
    country_status: [],
    legal_events: [],
    events_timeline: [],
    drawings: [],
    claims: [],
    description: "",
    patent_citations: [],
    cited_by: [],
    similar_documents: [],
    data_source: "EPO OPS",
  };

  if (!biblioRoot) return result;

  const biblio = biblioRoot["bibliographic-data"] || {};

  // 标题
  try {
    const titleObj = biblio["invention-title"];
    if (titleObj) {
      if (typeof titleObj === "string") result.title = titleObj;
      else if (titleObj.$) result.title = titleObj.$;
      else if (titleObj["text"]) result.title = titleObj["text"];
    }
  } catch (e) { /* ignore */ }

  // 出版引用（publication-date + patent_number kind）
  try {
    const pubRef = biblio["publication-reference"];
    if (pubRef && pubRef["document-id"]) {
      const docIds = opsArray(pubRef["document-id"]);
      const epodoc = opsExtractDocId(docIds, "epodoc");
      const docdb = opsExtractDocId(docIds, "docdb");
      if (epodoc) {
        // 用 epodoc 号码作为正式公开号
        result.publication_date = opsFormatDate(epodoc.date ? epodoc.date["date"] : "");
      }
      if (docdb && docdb.date) {
        if (!result.publication_date) result.publication_date = opsFormatDate(docdb.date);
      }
    }
  } catch (e) { /* ignore */ }

  // 申请引用（application-date）
  try {
    const appRef = biblio["application-reference"];
    if (appRef && appRef["document-id"]) {
      const docIds = opsArray(appRef["document-id"]);
      const epodoc = opsExtractDocId(docIds, "epodoc");
      if (epodoc && epodoc.date) result.application_date = opsFormatDate(epodoc.date);
    }
  } catch (e) { /* ignore */ }

  // 优先权日期
  try {
    const priorityClaims = biblio["priority-claims"];
    if (priorityClaims && priorityClaims["priority-claim"]) {
      const claims = opsArray(priorityClaims["priority-claim"]);
      if (claims.length > 0 && claims[0]["document-id"]) {
        const docIds = opsArray(claims[0]["document-id"]);
        const epodoc = opsExtractDocId(docIds, "epodoc");
        if (epodoc && epodoc.date) result.priority_date = opsFormatDate(epodoc.date);
      }
    }
  } catch (e) { /* ignore */ }

  // 当事人（发明人、申请人）
  try {
    const parties = biblio.parties;
    if (parties) {
      // 发明人
      if (parties.inventors && parties.inventors.inventor) {
        const inventors = opsArray(parties.inventors.inventor);
        result.inventors = inventors.map(inv => {
          const name = inv["inventor-name"];
          if (name && name.name) {
            return [name.name["last-name"], name.name["first-name"]].filter(Boolean).join(" ");
          }
          return "";
        }).filter(Boolean);
      }
      // 申请人
      if (parties.applicants && parties.applicants.applicant) {
        const applicants = opsArray(parties.applicants.applicant);
        result.assignees = applicants.map(app => {
          const name = app["applicant-name"];
          if (name && name.name) return name.name["organisation-name"] || name.name["last-name"] || "";
          return "";
        }).filter(Boolean);
      }
    }
  } catch (e) { /* ignore */ }

  // CPC 分类
  try {
    const cpc = biblio["classification-cpc"];
    if (cpc) {
      // classification-cpc 可能有 cpc-classification-symbol 或 classification-symbol
      const symbols = opsArray(cpc["cpc-classification-symbol"] || cpc["classification-symbol"]);
      result.classifications = symbols.map(sym => {
        if (typeof sym === "string") return { code: sym, description: "" };
        if (sym.$) return { code: sym.$, description: "" };
        return null;
      }).filter(Boolean);
    }
    // IPCR 分类作为补充
    const ipcr = biblio["classification-ipcr"];
    if (ipcr && ipcr["classification-ipcr"]) {
      const ipcrItems = opsArray(ipcr["classification-ipcr"]);
      for (const item of ipcrItems) {
        const sym = item["ipc-classification-symbol"];
        if (sym && !result.classifications.find(c => c.code === sym)) {
          result.classifications.push({ code: sym, description: "" });
        }
      }
    }
  } catch (e) { /* ignore */ }

  // 向后引用（patent_citations）
  try {
    const refsCited = biblio["references-cited"];
    if (refsCited && refsCited.citation) {
      const citations = opsArray(refsCited.citation);
      result.patent_citations = citations.map(cit => {
        const patCite = cit["patcit"];
        if (patCite && patCite["document-id"]) {
          const docIds = opsArray(patCite["document-id"]);
          const docdb = opsExtractDocId(docIds, "docdb");
          if (docdb) {
            return {
              patent_number: docdb.country + docdb.docNumber + (docdb.kind || ""),
              country: docdb.country,
            };
          }
        }
        return null;
      }).filter(Boolean);
    }
  } catch (e) { /* ignore */ }

  // 摘要
  try {
    if (abstractData && abstractData["ops:world-patent-data"]) {
      const abstractNode = abstractData["ops:world-patent-data"].abstract;
      if (abstractNode) {
        // abstract 下有 p 子节点
        const pNodes = opsArray(abstractNode.p);
        result.abstract = pNodes.map(p => (typeof p === "string" ? p : (p.$ || ""))).join("\n").trim();
        if (!result.abstract && typeof abstractNode === "object" && abstractNode.$) {
          result.abstract = abstractNode.$;
        }
      }
    }
  } catch (e) { /* ignore */ }

  // 权利要求
  try {
    if (claimsData && claimsData["ops:world-patent-data"]) {
      const claimsNode = claimsData["ops:world-patent-data"].claims;
      if (claimsNode && claimsNode.claim) {
        const claims = opsArray(claimsNode.claim);
        result.claims = claims.map((c, i) => {
          const num = c["@num"] || c["@number"] || String(i + 1);
          const claimText = c["claim-text"];
          // claim-text 可能有多层嵌套
          let text = "";
          if (typeof claimText === "string") text = claimText;
          else if (claimText) {
            const texts = opsArray(claimText);
            text = texts.map(t => typeof t === "string" ? t : (t.$ || extractNestedText(t))).join("");
          }
          // Detect dependent claims by checking if text references other claims
          const trimmedText = text.trim();
          const isDependent =
            /根据权利要求/.test(trimmedText) ||
            /根據權利要求/.test(trimmedText) ||
            /claim\s*\d+/i.test(trimmedText.substring(0, 300)) ||
            /claims\s*\d+/i.test(trimmedText.substring(0, 300)) ||
            /所述的/.test(trimmedText.substring(0, 80));
          return { num: String(num), type: isDependent ? "dependent" : "independent", text: trimmedText };
        });
      }
    }
  } catch (e) { /* ignore */ }

  // 说明书
  try {
    if (descriptionData && descriptionData["ops:world-patent-data"]) {
      const descNode = descriptionData["ops:world-patent-data"].description;
      if (descNode) {
        // description 下有 p 子节点
        const pNodes = opsArray(descNode.p);
        result.description = pNodes.map(p => {
          if (typeof p === "string") return p;
          if (p.$) return p.$;
          return extractNestedText(p);
        }).join("\n").trim();
      }
    }
  } catch (e) { /* ignore */ }

  // 法律事件
  try {
    if (legalData && legalData["ops:world-patent-data"]) {
      const legalNode = legalData["ops:world-patent-data"]["ops:legal"];
      if (legalNode) {
        const events = opsArray(legalNode["legal-event"]);
        result.legal_events = events.map(ev => ({
          date: opsFormatDate(ev.date),
          code: ev["event-code"] || ev.code || "",
          description: ev.description || (ev.attributor ? ev.attributor : ""),
        }));
      }
    }
  } catch (e) { /* ignore */ }

  // 同族
  try {
    if (familyData && familyData["ops:world-patent-data"]) {
      const familyNode = familyData["ops:world-patent-data"]["ops:patent-family"];
      if (familyNode) {
        const members = opsArray(familyNode["family-member"]);
        result.family_applications = members.map(mem => {
          const pubRef = mem["publication-reference"];
          if (pubRef && pubRef["document-id"]) {
            const docIds = opsArray(pubRef["document-id"]);
            const docdb = opsExtractDocId(docIds, "docdb");
            if (docdb) {
              return {
                publication_number: docdb.country + docdb.docNumber + (docdb.kind || ""),
                title: "",
                status: "",
              };
            }
          }
          return null;
        }).filter(Boolean);
        if (result.family_applications.length > 0) {
          result.family_id = parsed.epodocNum;
        }
      }
    }
  } catch (e) { /* ignore */ }

  // 向前引用（cited_by）—— 来自 citing 搜索结果
  try {
    if (citingData && citingData["ops:world-patent-data"]) {
      const searchResult = citingData["ops:world-patent-data"]["ops:biblio-search"];
      if (searchResult && searchResult["ops:search-result"]) {
        const exDocs = opsArray(searchResult["ops:search-result"]["exchange-document"]);
        result.cited_by = exDocs.map(doc => {
          const docId = doc["@id"] || doc["bibliographic-data"];
          if (typeof docId === "string") return { patent_number: docId };
          // 从 bibliographic-data 提取公开号及更多信息
          try {
            const bibData = doc["bibliographic-data"];
            const pubRef = bibData["publication-reference"]["document-id"];
            const epodoc = opsExtractDocId(opsArray(pubRef), "epodoc");
            const entry = { patent_number: epodoc ? epodoc.country + epodoc.docNumber : "" };
            // Extract title
            try {
              const titleData = bibData["invention-title"];
              if (typeof titleData === "string") entry.title = titleData;
              else if (titleData && titleData.$) entry.title = titleData.$;
              else if (titleData) entry.title = extractNestedText(titleData);
            } catch (e) { /* ignore */ }
            // Extract publication date
            try {
              const pubRefArr = opsArray(pubRef);
              const docdb = opsExtractDocId(pubRefArr, "docdb");
              if (docdb && docdb.date) entry.publication_date = docdb.date;
              else {
                // Try from epodoc
                if (epodoc && epodoc.date) entry.publication_date = epodoc.date;
              }
            } catch (e) { /* ignore */ }
            // Extract assignee/applicant
            try {
              const parties = bibData["parties"];
              if (parties && parties.applicants) {
                const applicants = opsArray(parties.applicants.applicant);
                if (applicants.length > 0) {
                  const first = applicants[0];
                  if (typeof first === "string") entry.assignee = first;
                  else if (first["name"]) entry.assignee = first["name"].$ || first["name"];
                  else entry.assignee = extractNestedText(first);
                }
              }
            } catch (e) { /* ignore */ }
            if (entry.patent_number) return entry;
          } catch (e) { /* ignore */ }
          return null;
        }).filter(Boolean);
      }
    }
  } catch (e) { /* ignore */ }

  return result;
}

// 递归提取嵌套文本（用于 claim-text / description p 节点）
function extractNestedText(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (node.$) return node.$;
  let text = "";
  for (const key of Object.keys(node)) {
    if (key.startsWith("@") || key === "$") continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const v of val) text += extractNestedText(v);
    } else {
      text += extractNestedText(val);
    }
  }
  return text;
}

// ── OPS 主查询入口 ──
// 并发请求多个端点，组装成 Google Patents 兼容的数据结构
async function queryOpsPatent(patentInput, consumerKey, consumerSecret) {
  const parsed = parseOpsPatentNumber(patentInput);
  if (parsed.error) return { success: false, error: parsed.error };

  const epodocNum = parsed.epodocNum;
  console.log("[OPS] 查询专利: " + patentInput + " → epodoc: " + epodocNum);

  // 并发请求各端点（使用 JSON 格式）
  const endpoints = {
    biblio: "/published-data/publication/epodoc/" + encodeURIComponent(epodocNum) + "/biblio",
    abstract: "/published-data/publication/epodoc/" + encodeURIComponent(epodocNum) + "/abstract",
    claims: "/published-data/publication/epodoc/" + encodeURIComponent(epodocNum) + "/claims",
    description: "/published-data/publication/epodoc/" + encodeURIComponent(epodocNum) + "/description",
    legal: "/legal/publication/epodoc/" + encodeURIComponent(epodocNum),
    family: "/family/publication/epodoc/" + encodeURIComponent(epodocNum),
    citing: "/published-data/search/?q=" + encodeURIComponent("ct=" + epodocNum) + "&Range=1-25",
  };

  const promises = Object.entries(endpoints).map(async ([key, opsPath]) => {
    const result = await opsRequest(consumerKey, consumerSecret, opsPath);
    if (result.error || result.httpCode !== 200) {
      console.log("[OPS] " + key + " 失败: " + (result.error || "HTTP " + result.httpCode));
      return [key, null];
    }
    try {
      const json = JSON.parse(result.body);
      return [key, json];
    } catch (e) {
      console.log("[OPS] " + key + " JSON 解析失败: " + e.message);
      return [key, null];
    }
  });

  const results = await Promise.all(promises);
  const dataMap = {};
  for (const [key, val] of results) dataMap[key] = val;

  // 至少需要 biblio 数据才算成功
  if (!dataMap.biblio) {
    return { success: false, error: "OPS 查询失败：无法获取著录数据（专利可能不存在或号码格式错误）" };
  }

  const data = convertOpsToGpStructure(
    patentInput,
    dataMap.biblio,
    dataMap.abstract,
    dataMap.claims,
    dataMap.description,
    dataMap.legal,
    dataMap.family,
    dataMap.citing
  );

  // 至少要有标题或摘要才算有效数据
  if (!data.title && !data.abstract) {
    return { success: false, error: "OPS 查询返回空数据（无标题无摘要）" };
  }

  console.log("[OPS] 查询成功: " + data.title + " | 权利要求: " + data.claims.length + " | 引用: " + data.patent_citations.length);
  return { success: true, data: data, patent_number: data.patent_number, data_source: "EPO OPS" };
}

// 获取 OPS 配额信息（带 20 分钟缓存）
function getOpsQuota(consumerKey, consumerSecret) {
  if (!consumerKey || !consumerSecret) return null;
  const cacheKey = consumerKey + ":" + consumerSecret;
  const cached = opsQuotaCache.get(cacheKey);
  if (cached && Date.now() - cached.updatedAt < OPS_QUOTA_CACHE_TTL) {
    return cached;
  }
  return cached; // 即使过期也返回旧数据（下一次请求会刷新）
}

// ── Google Patents scraper ────────────────────────────────────────────────────

function normalizePatentNumber(input) {
  const normalized = input.toUpperCase().replace(/[\s\/]/g, "");
  const countryMatch = normalized.match(/^([A-Z]{2})(\d+[A-Z]?\d*)/);
  if (!countryMatch) return { normalized, variants: [] };
  const country = countryMatch[1];
  const rest = countryMatch[2];
  const numberMatch = rest.match(/^(\d+)([A-Z]+\d*)?$/);
  if (!numberMatch) return { normalized, variants: [] };
  const base = numberMatch[1];
  const suffix = numberMatch[2] || "";
  const variants = [];
  const basePatent = country + base;
  if (basePatent !== normalized) variants.push(basePatent);
  if (suffix) {
    const letterOnly = suffix.match(/^([A-Z]+)/);
    if (letterOnly) {
      const v = country + base + letterOnly[1];
      if (v !== normalized && !variants.includes(v)) variants.push(v);
    }
  }
  return { normalized, variants };
}

function extractPatentFromHtml(html, patentId) {
  // Strategy 1: JSON-LD
  const jsonLdMatch = html.match(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  let jsonLdResult = null;
  if (jsonLdMatch) {
    try {
      const ldData = JSON.parse(jsonLdMatch[1]);
      const graph = ldData["@graph"] || [ldData];
      const patentEntry = graph.find(item => item["@type"] === "Patent");
      if (patentEntry) {
        jsonLdResult = {
          patent_number: patentId,
          title: patentEntry.name || patentEntry.title || "",
          abstract: patentEntry.abstract || "",
          url: `https://patents.google.com/patent/${patentId}`,
          application_date: "",
          publication_date: "",
          inventors: [],
          assignees: [],
          drawings: [],
          patent_citations: [],
          cited_by: [],
          classifications: [],
          claims: [],
          description: "",
          pdf_link: "",
          events_timeline: [],
          legal_events: [],
          similar_documents: [],
          family_id: "",
          family_applications: [],
          country_status: [],
          priority_date: "",
          external_links: {},
          landscapes: [],
        };
        if (patentEntry.inventor) {
          jsonLdResult.inventors = (Array.isArray(patentEntry.inventor) ? patentEntry.inventor : [patentEntry.inventor]).map(i => i.name || i).filter(n => typeof n === "string");
        }
        if (patentEntry.assignee) {
          jsonLdResult.assignees = (Array.isArray(patentEntry.assignee) ? patentEntry.assignee : [patentEntry.assignee]).map(a => a.name || a).filter(n => typeof n === "string");
        }
        if (patentEntry.filingDate) jsonLdResult.application_date = patentEntry.filingDate;
        if (patentEntry.publicationDate) jsonLdResult.publication_date = patentEntry.publicationDate;
        if (patentEntry.image) {
          const imgs = Array.isArray(patentEntry.image) ? patentEntry.image : [patentEntry.image];
          jsonLdResult.drawings = imgs.map(i => (typeof i === "string" ? i : (i.url || i.contentUrl || ""))).filter(u => u && u.startsWith("http"));
        }
      }
    } catch (e) { /* fall through to HTML parsing */ }
  }

  // Strategy 2: HTML element parsing (always run to supplement missing fields)
  const htmlResult = {
    patent_number: patentId,
    title: "",
    abstract: "",
    url: `https://patents.google.com/patent/${patentId}`,
    application_date: "",
    publication_date: "",
    inventors: [],
    assignees: [],
    drawings: [],
    patent_citations: [],
    cited_by: [],
    classifications: [],
    claims: [],
    description: "",
    pdf_link: "",
    events_timeline: [],
    legal_events: [],
    similar_documents: [],
    family_id: "",
    family_applications: [],
    country_status: [],
    priority_date: "",
    external_links: {},
    landscapes: [],
  };

  // Title
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (titleMatch) htmlResult.title = titleMatch[1].replace(/<[^>]+>/g, "").trim();

  // Abstract
  const abstractMatch = html.match(/<section[^>]*itemprop="abstract"[^>]*>([\s\S]*?)<\/section>/i)
    || html.match(/<div[^>]*class="abstract"[^>]*>([\s\S]*?)<\/div>/i)
    || html.match(/<abstract>([\s\S]*?)<\/abstract>/i);
  if (abstractMatch) htmlResult.abstract = abstractMatch[1].replace(/<[^>]+>/g, "").trim();

  // Inventors
  const inventorMatches = html.matchAll(/<dd[^>]*itemprop="inventor"[^>]*>([\s\S]*?)<\/dd>/gi);
  for (const m of inventorMatches) {
    const name = m[1].replace(/<[^>]+>/g, "").trim();
    if (name) htmlResult.inventors.push(name);
  }

  // Assignees
  const assigneeMatches = html.matchAll(/<dd[^>]*itemprop="assignee(?:Current|Original)"[^>]*>([\s\S]*?)<\/dd>/gi);
  for (const m of assigneeMatches) {
    const name = m[1].replace(/<[^>]+>/g, "").trim();
    if (name && !htmlResult.assignees.includes(name)) htmlResult.assignees.push(name);
  }

  // Dates
  const filingMatch = html.match(/<time[^>]*itemprop="filingDate"[^>]*>([\s\S]*?)<\/time>/i);
  if (filingMatch) htmlResult.application_date = filingMatch[1].replace(/<[^>]+>/g, "").trim();
  const pubMatch = html.match(/<time[^>]*itemprop="publicationDate"[^>]*>([\s\S]*?)<\/time>/i);
  if (pubMatch) htmlResult.publication_date = pubMatch[1].replace(/<[^>]+>/g, "").trim();

  // Drawings - itemprop="images"
  const imageMatches = html.matchAll(/<li[^>]*itemprop="images"[^>]*>([\s\S]*?)<\/li>/gi);
  for (const m of imageMatches) {
    const fullMeta = m[1].match(/<meta[^>]*itemprop="full"[^>]*content="([^"]+)"/);
    if (fullMeta && fullMeta[1].startsWith("http")) {
      htmlResult.drawings.push(fullMeta[1]);
    } else {
      const thumbImg = m[1].match(/<img[^>]*itemprop="thumbnail"[^>]*src="([^"]+)"/);
      if (thumbImg) {
        let url = thumbImg[1];
        if (url.startsWith("//")) url = "https:" + url;
        if (url.startsWith("http")) htmlResult.drawings.push(url);
      }
    }
  }

  // Helper: extract citation fields from a <tr> row, supporting both old class-based
  // and new itemprop-based Google Patents HTML formats
  function extractCitationRow(row) {
    // Patent number: try href link, then itemprop="publicationNumber"
    let patentNumber = "";
    const numMatch = row.match(/<a[^>]*href="\/patent\/([^"]+)"[^>]*>/);
    if (numMatch) {
      patentNumber = numMatch[1].replace(/<[^>]+>/g, "").trim();
      // Remove language suffix from href like "WO2017147208A1/en" -> "WO2017147208A1"
      patentNumber = patentNumber.replace(/\/[a-z]{2}$/, '');
    } else {
      const pubNumMatch = row.match(/itemprop="publicationNumber"[^>]*>([\s\S]*?)<\/span>/i);
      if (pubNumMatch) patentNumber = pubNumMatch[1].replace(/<[^>]+>/g, "").trim();
    }
    if (!patentNumber) return null;

    // Title: try class="patent-title", then itemprop="title"
    let title = "";
    const titleByClass = row.match(/<td[^>]*class="patent-title[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    if (titleByClass) {
      title = titleByClass[1].replace(/<[^>]+>/g, "").trim();
    } else {
      const titleByItemprop = row.match(/<td[^>]*itemprop="title"[^>]*>([\s\S]*?)<\/td>/i);
      if (titleByItemprop) title = titleByItemprop[1].replace(/<[^>]+>/g, "").trim();
    }

    // Publication date: try <time>, then itemprop="publicationDate" on <td>
    let pubDate = "";
    const pubDateByTime = row.match(/<time[^>]*>([\s\S]*?)<\/time>/i);
    if (pubDateByTime) {
      pubDate = pubDateByTime[1].replace(/<[^>]+>/g, "").trim();
    } else {
      const pubDateByItemprop = row.match(/<td[^>]*itemprop="publicationDate"[^>]*>([\s\S]*?)<\/td>/i);
      if (pubDateByItemprop) pubDate = pubDateByItemprop[1].replace(/<[^>]+>/g, "").trim();
    }

    // Assignee: try class="patent-assignee", then itemprop="assigneeOriginal"
    let assignee = "";
    const assigneeByClass = row.match(/<td[^>]*class="patent-assignee[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    if (assigneeByClass) {
      assignee = assigneeByClass[1].replace(/<[^>]+>/g, "").trim();
    } else {
      const assigneeByItemprop = row.match(/itemprop="assigneeOriginal"[^>]*>([\s\S]*?)<\/span>/i);
      if (assigneeByItemprop) assignee = assigneeByItemprop[1].replace(/<[^>]+>/g, "").trim();
    }

    // Priority date: try <time itemprop="priorityDate">, then <td itemprop="priorityDate">
    let priorityDate = "";
    const priorityByTime = row.match(/<time[^>]*itemprop="priorityDate"[^>]*>([\s\S]*?)<\/time>/i);
    if (priorityByTime) {
      priorityDate = priorityByTime[1].replace(/<[^>]+>/g, "").trim();
    } else {
      const priorityByTd = row.match(/<td[^>]*itemprop="priorityDate"[^>]*>([\s\S]*?)<\/td>/i);
      if (priorityByTd) priorityDate = priorityByTd[1].replace(/<[^>]+>/g, "").trim();
    }

    return { patent_number: patentNumber, title, publication_date: pubDate, assignee, priority_date: priorityDate };
  }

  // Patent citations (backward references)
  // backwardReferencesOrig = examiner citations (marked with * in Google Patents)
  const citationMatches = html.matchAll(/<tr[^>]*itemprop="backwardReferencesOrig"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const m of citationMatches) {
    const row = m[1];
    const extracted = extractCitationRow(row);
    if (extracted) {
      const hasStar = /\*/.test(row.replace(/<[^>]+>/g, ""));
      const entry = {
        ...extracted,
        link: "https://patents.google.com/patent/" + extracted.patent_number,
        citation_type: hasStar ? "examiner" : "applicant",
      };
      if (!extracted.priority_date) delete entry.priority_date;
      htmlResult.patent_citations.push(entry);
    }
  }
  // backwardReferencesFamily = family-level citations (typically applicant)
  const citationFamilyMatches = html.matchAll(/<tr[^>]*itemprop="backwardReferencesFamily"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const m of citationFamilyMatches) {
    const row = m[1];
    const extracted = extractCitationRow(row);
    if (extracted) {
      const pn = extracted.patent_number;
      if (!htmlResult.patent_citations.find(c => c.patent_number === pn)) {
        const entry = {
          ...extracted,
          link: "https://patents.google.com/patent/" + pn,
          citation_type: "applicant",
        };
        if (!extracted.priority_date) delete entry.priority_date;
        htmlResult.patent_citations.push(entry);
      }
    }
  }

  // CPC Classifications
  const classMatches = html.matchAll(/<li[^>]*itemprop="classifications"[^>]*>([\s\S]*?)<\/li>/gi);
  for (const m of classMatches) {
    const row = m[1];
    const codeMatch = row.match(/<span[^>]*class="classification-code[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const descMatch = row.match(/<span[^>]*class="classification-desc[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (codeMatch) {
      htmlResult.classifications.push({
        code: codeMatch[1].replace(/<[^>]+>/g, "").trim(),
        description: descMatch ? descMatch[1].replace(/<[^>]+>/g, "").trim() : "",
      });
    }
  }

  // Claims - extract from section itemprop="claims"
  const claimsSection = html.match(/<section[^>]*itemprop="claims"[^>]*>([\s\S]*?)<\/section>/i)
    || html.match(/<div[^>]*class="claims"[^>]*>([\s\S]*?)<\/div>/i);
  if (claimsSection) {
    const claimsHtml = claimsSection[1];

    // Helper: find matching closing tag for an opening div at given position
    // Returns the index of the closing </div> that matches, or -1
    function findMatchingCloseDiv(html, openStart) {
      let depth = 0;
      let i = openStart;
      while (i < html.length) {
        const openIdx = html.indexOf("<div", i);
        const closeIdx = html.indexOf("</div>", i);
        if (closeIdx === -1) return -1;
        if (openIdx !== -1 && openIdx < closeIdx) {
          // Check it's a real div tag (not e.g. <divider)
          const ch = html.charCodeAt(openIdx + 4);
          if (ch === 32 || ch === 62 || ch === 47 || ch === 10 || ch === 9) {
            depth++;
            i = openIdx + 4;
            continue;
          }
        }
        depth--;
        if (depth === 0) return closeIdx;
        i = closeIdx + 6;
      }
      return -1;
    }

    // Strategy 1: Extract from <div class="claim..." num="N"> or <div num="N" class="claim...">
    function extractDivClaims(html) {
      // First pass: collect all claim fragments, grouped by num
      // wrapperType: 'independent' if inside <div class="claim">, 'dependent' if inside <div class="claim-dependent">, null if unknown
      const claimMap = new Map(); // num -> { texts: [], wrapperType: null|'independent'|'dependent' }
      const claimStartRegex = /<div([^>]*?)>/gi;
      let m;
      while ((m = claimStartRegex.exec(html)) !== null) {
        const attrs = m[1];
        const classMatch = attrs.match(/class="([^"]*)"/i);
        const numMatch = attrs.match(/num="(\d+)"/i);
        if (!classMatch || !numMatch) continue;
        const className = classMatch[1];
        // Only match top-level claim divs: class contains "claim" or "claim-dependent" as standalone words
        // Exclude sub-element classes: claim-text, claim-line, claim-ref, etc.
        const hasClaimClass = /(?:^|\s)claim(?:\s|$)/.test(className);
        const hasDependentClass = /(?:^|\s)claim-dependent(?:\s|$)/.test(className);
        if (!hasClaimClass && !hasDependentClass) continue;
        const claimNum = numMatch[1];
        // Detect parent wrapper class: <div class="claim"> = independent, <div class="claim-dependent"> = dependent
        // The outer wrapper is the MOST RELIABLE indicator of independent/dependent status.
        // For Chinese patents: <div class="claim"><div num="1" class="claim"> = independent
        //                      <div class="claim-dependent"><div num="2" class="claim"> = dependent
        let wrapperType = null; // null = no wrapper info found
        const beforeTag = html.substring(0, m.index);
        // Find ALL <div ...> opening tags before current position and classify them.
        // We distinguish wrappers (no num attribute) from inner claim divs (have num attribute).
        let insideDependentWrapper = false;
        let insideIndependentWrapper = false;
        const allDivBefore = [...beforeTag.matchAll(/<div([^>]*?)>/gi)];
        for (let di = allDivBefore.length - 1; di >= 0; di--) {
          const divAttrs = allDivBefore[di][1];
          const divClassMatch = divAttrs.match(/class="([^"]*)"/i);
          if (!divClassMatch) continue;
          const divClass = divClassMatch[1];
          // Only consider divs that have "claim" or "claim-dependent" as standalone word in class
          const hasClaimWord = /(?:^|\s)claim(?:\s|$)/.test(divClass);
          const hasDependentWord = /(?:^|\s)claim-dependent(?:\s|$)/.test(divClass);
          if (!hasClaimWord && !hasDependentWord) continue;
          // Skip inner claim divs (they have num attribute; wrappers don't)
          if (/num="/i.test(divAttrs)) continue;
          // Check if this wrapper div is still open (unclosed)
          const afterDiv = beforeTag.substring(allDivBefore[di].index + allDivBefore[di][0].length);
          const openCount = (afterDiv.match(/<div[\s>]/gi) || []).length;
          const closeCount = (afterDiv.match(/<\/div>/gi) || []).length;
          if (openCount < closeCount) continue; // already closed
          // Found an unclosed wrapper
          if (hasDependentWord) {
            insideDependentWrapper = true;
            break;
          } else if (hasClaimWord) {
            insideIndependentWrapper = true;
            break;
          }
        }
        if (insideDependentWrapper) wrapperType = 'dependent';
        else if (insideIndependentWrapper) wrapperType = 'independent';
        // Also check if the div itself has claim-dependent class
        if (hasDependentClass) wrapperType = 'dependent';
        const openTagEnd = m.index + m[0].length;
        const closeIdx = findMatchingCloseDiv(html, m.index);
        if (closeIdx === -1) continue;
        const claimBody = html.substring(openTagEnd, closeIdx);
        // Clean HTML
        let claimText = claimBody
          .replace(/<br\s*\/?>/gi, " ")
          .replace(/<\/div>/gi, " ")
          .replace(/<claim-ref[^>]*>/gi, " ")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/gi, " ")
          .replace(/&amp;/gi, "&")
          .replace(/&lt;/gi, "<")
          .replace(/&gt;/gi, ">")
          .replace(/\s+/g, " ")
          .trim();
        if (claimText.length < 1) continue;
        if (!claimMap.has(claimNum)) {
          claimMap.set(claimNum, { texts: [], wrapperType: null });
        }
        const entry = claimMap.get(claimNum);
        entry.texts.push(claimText);
        // wrapperType: 'dependent' always wins; 'independent' only if not already set to 'dependent'
        if (wrapperType === 'dependent') entry.wrapperType = 'dependent';
        else if (wrapperType === 'independent' && entry.wrapperType !== 'dependent') entry.wrapperType = 'independent';
      }
      // Second pass: merge fragments of the same claim number
      const claims = [];
      for (const [num, entry] of claimMap) {
        const fullText = entry.texts.join(" ").replace(/\s+/g, " ").trim();
        if (fullText.length < 3) continue;
        // Determine dependent/independent:
        // Priority 1: wrapper class (most reliable) — <div class="claim"> = independent, <div class="claim-dependent"> = dependent
        // Priority 2: text-based detection (fallback when no wrapper info)
        let isDependent;
        if (entry.wrapperType === 'dependent') {
          isDependent = true;
        } else if (entry.wrapperType === 'independent') {
          isDependent = false;
        } else {
          // No wrapper info, use text-based detection
          isDependent = /claim\s*\d+/i.test(fullText.substring(0, 200))
            || fullText.includes('根据权利要求')
            || fullText.includes('根據權利要求')
            || /所述的/.test(fullText.substring(0, 80));
        }
        claims.push({ num, text: fullText, type: isDependent ? "dependent" : "independent" });
      }
      // Sort by claim number
      claims.sort((a, b) => parseInt(a.num) - parseInt(b.num));
      return claims;
    }

    // Strategy 2: Extract from <li class="claim"> / <li class="claim-dependent">
    function extractLiClaims(html) {
      const claimMap = new Map();
      const claimMatches = html.matchAll(/<li[^>]*class="claim(?:-dependent)?[^"]*"[^>]*>([\s\S]*?)<\/li>/gi);
      for (const cm of claimMatches) {
        const claimBody = cm[1];
        const isDependent = cm[0].includes('claim-dependent');
        let claimText = claimBody
          .replace(/<br\s*\/?>/gi, " ")
          .replace(/<\/div>/gi, " ")
          .replace(/<claim-ref[^>]*>/gi, " ")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/gi, " ")
          .replace(/&amp;/gi, "&")
          .replace(/&lt;/gi, "<")
          .replace(/&gt;/gi, ">")
          .replace(/\s+/g, " ")
          .trim();
        const numMatch = cm[0].match(/num="(\d+)"/);
        const claimNum = numMatch ? numMatch[1] : "";
        if (claimText.length < 1) continue;
        if (!claimMap.has(claimNum)) {
          claimMap.set(claimNum, { texts: [], isDependentByClass: false });
        }
        const entry = claimMap.get(claimNum);
        entry.texts.push(claimText);
        if (isDependent) entry.isDependentByClass = true;
      }
      const claims = [];
      for (const [num, entry] of claimMap) {
        const fullText = entry.texts.join(" ").replace(/\s+/g, " ").trim();
        if (fullText.length < 3) continue;
        const isDep = entry.isDependentByClass || /claim\s*\d+/i.test(fullText.substring(0, 200)) || fullText.includes('根据权利要求');
        claims.push({ num, text: fullText, type: isDep ? "dependent" : "independent" });
      }
      claims.sort((a, b) => parseInt(a.num) - parseInt(b.num));
      return claims;
    }

    // Strategy 3: Extract from claim-text divs (some pages use <div class="claim-text">)
    function extractClaimTextDivs(html) {
      const claimMap = new Map();
      const claimTextMatches = html.matchAll(/<div[^>]*class="claim-text"[^>]*>([\s\S]*?)<\/div>/gi);
      for (const cm of claimTextMatches) {
        let claimText = cm[1]
          .replace(/<br\s*\/?>/gi, " ")
          .replace(/<[^>]+>/g, "")
          .replace(/&nbsp;/gi, " ")
          .replace(/\s+/g, " ")
          .trim();
        // Try to find claim number from parent context
        const parentContext = html.substring(Math.max(0, cm.index - 200), cm.index);
        const numMatch = parentContext.match(/num="(\d+)"/);
        const claimNum = numMatch ? numMatch[1] : "";
        if (claimText.length < 1) continue;
        if (!claimMap.has(claimNum)) {
          claimMap.set(claimNum, { texts: [] });
        }
        claimMap.get(claimNum).texts.push(claimText);
      }
      const claims = [];
      for (const [num, entry] of claimMap) {
        const fullText = entry.texts.join(" ").replace(/\s+/g, " ").trim();
        if (fullText.length < 3) continue;
        const isDep = /claim\s*\d+/i.test(fullText.substring(0, 200)) || fullText.includes('根据权利要求');
        claims.push({ num, text: fullText, type: isDep ? "dependent" : "independent" });
      }
      claims.sort((a, b) => parseInt(a.num) - parseInt(b.num));
      return claims;
    }

    // Try all strategies, pick the best one
    // Prefer the strategy with the most reasonable claim count (not too many fragments)
    // After merging by num, the strategy with fewer but longer claims is better
    const divClaims = extractDivClaims(claimsHtml);
    const liClaims = extractLiClaims(claimsHtml);
    const claimTextDivs = extractClaimTextDivs(claimsHtml);

    function avgTextLength(claims) {
      if (claims.length === 0) return 0;
      return claims.reduce((sum, c) => sum + c.text.length, 0) / claims.length;
    }

    const candidates = [
      { claims: divClaims, name: 'divClaims' },
      { claims: liClaims, name: 'liClaims' },
      { claims: claimTextDivs, name: 'claimTextDivs' },
    ].filter(c => c.claims.length > 0);

    if (candidates.length > 0) {
      // Pick the candidate with highest average text length (most complete claims)
      candidates.sort((a, b) => avgTextLength(b.claims) - avgTextLength(a.claims));
      htmlResult.claims = candidates[0].claims;
    }

    // Post-processing: merge fragmented claims
    // Google Patents sometimes uses flat divs where each line is a separate <div class="claim" num="N">
    // with sequential line numbers (not claim numbers). In this case, claims whose text doesn't start
    // with a claim number prefix (e.g., "9.") are continuations of the preceding claim.
    if (htmlResult.claims.length > 1) {
      const merged = [];
      let current = null;
      for (const claim of htmlResult.claims) {
        // Check if this claim starts with a claim number prefix like "9." or "10."
        const prefixMatch = claim.text.match(/^(\d+)\.\s/);
        if (prefixMatch) {
          // Start of a new claim - use the text prefix as the actual claim number
          if (current) merged.push(current);
          current = { ...claim, num: prefixMatch[1] };
        } else if (current) {
          // Continuation of the current claim (no number prefix)
          current.text = (current.text + " " + claim.text).replace(/\s+/g, " ").trim();
          // If continuation comes from a dependent class, mark the whole claim as dependent
          if (claim.type === "dependent") current.type = "dependent";
        } else {
          // No preceding claim to merge with, keep as standalone
          current = { ...claim };
        }
      }
      if (current) merged.push(current);
      // Deduplicate by claim number: if same num appears multiple times, keep the longest text
      const dedupMap = new Map();
      for (const claim of merged) {
        if (!dedupMap.has(claim.num) || dedupMap.get(claim.num).text.length < claim.text.length) {
          dedupMap.set(claim.num, claim);
        }
      }
      htmlResult.claims = Array.from(dedupMap.values());
      htmlResult.claims.sort((a, b) => parseInt(a.num) - parseInt(b.num));
    }

    // Last resort: extract claims by number pattern in plain text
    if (htmlResult.claims.length === 0) {
      const textContent = claimsHtml
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<\/div>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/\s+/g, " ");
      const claimNumRegex = /(?:^|\s)(\d+)\.\s*((?:(?!\s+\d+\.\s)[\s\S])+)/gm;
      let cm;
      while ((cm = claimNumRegex.exec(textContent)) !== null) {
        const claimNum = cm[1];
        let claimText = cm[2].trim();
        if (claimText && claimText.length > 5) {
          const isDep = /claim\s*\d+/i.test(claimText.substring(0, 150)) || claimText.includes('根据权利要求');
          htmlResult.claims.push({ num: claimNum, text: claimText, type: isDep ? "dependent" : "independent" });
        }
      }
    }
  }

  // Description
  const descSection = html.match(/<section[^>]*itemprop="description"[^>]*>([\s\S]*?)<\/section>/i)
    || html.match(/<div[^>]*class="description"[^>]*>([\s\S]*?)<\/div>/i);
  if (descSection) {
    let descHtml = descSection[1];
    // Try to extract from ul.description structure (Google Patents format)
    const ulDesc = descHtml.match(/<ul[^>]*class="description"[^>]*>([\s\S]*?)<\/ul>/i);
    if (ulDesc) {
      // Process headings and list items
      let parts = ulDesc[1].replace(/<heading[^>]*>([\s\S]*?)<\/heading>/gi, '\n\n## $1\n');
      parts = parts.replace(/<\/li>/gi, '\n');
      parts = parts.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      htmlResult.description = parts;
    } else {
      // Try description-paragraph divs
      // Semantic HTML tags (<technical-field>, <background-art>, <disclosure>, etc.) are the
      // most reliable section boundary markers. We extract each semantic tag's content
      // and process its paragraphs, marking the first one as a ## heading.
      const semanticTags = [
        'technical-field', 'background-art', 'disclosure',
        'description-of-drawings', 'best-mode', 'mode-for-invention',
        'embodiment', 'description-of-embodiments',
        'industrial-applicability', 'sequence-list',
      ];

      // Build ranges [start, end) in descHtml for each semantic tag occurrence
      const semanticRanges = [];
      for (const tag of semanticTags) {
        const tagRegex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
        let tagMatch;
        while ((tagMatch = tagRegex.exec(descHtml)) !== null) {
          // tagMatch.index is the start of the opening tag
          // The content starts after the opening tag
          const contentStart = tagMatch.index + tagMatch[0].indexOf('>') + 1;
          const contentEnd = tagMatch.index + tagMatch[0].length - (`</${tag}>`).length;
          semanticRanges.push({ start: tagMatch.index, contentStart, contentEnd, end: tagMatch.index + tagMatch[0].length, tag });
        }
      }

      const paraMatches = [...descHtml.matchAll(/<div[^>]*class="description-paragraph"[^>]*>([\s\S]*?)<\/div>/gi)];

      // For each semantic tag, find which paragraph is the first one inside it
      const firstParaInSemantic = new Set(); // stores pm.index values
      for (const range of semanticRanges) {
        for (const pm of paraMatches) {
          // pm.index is the start of the <div> opening tag
          if (pm.index >= range.contentStart && pm.index < range.contentEnd) {
            firstParaInSemantic.add(pm.index);
            break; // only the first paragraph in each semantic tag
          }
        }
      }

      const paragraphs = [];
      for (const pm of paraMatches) {
        let pText = pm[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        if (!pText) continue;
        // If this paragraph is the first one inside a semantic tag, mark it as a heading
        if (firstParaInSemantic.has(pm.index)) {
          if (!pText.startsWith('## ')) pText = '## ' + pText;
        }
        paragraphs.push(pText);
      }
      if (paragraphs.length > 0) {
        // Fallback: detect common Chinese/English section heading patterns in paragraph text
        // and prefix them with ## if not already marked. This catches headings that don't
        // have semantic tag wrappers (e.g., some Google Patents formats).
        const sectionHeadingPatterns = [
          /^技术领域$/, /^背景技术$/, /^发明内容$/, /^附图说明$/,
          /^具体实施方式$/, /^具体实施例$/, /^实施方式$/, /^实施例$/, /^工业应用性$/,
          /^TECHNICAL FIELD$/i, /^BACKGROUND$/i, /^BACKGROUND OF THE INVENTION$/i,
          /^SUMMARY$/i, /^SUMMARY OF THE INVENTION$/i,
          /^DETAILED DESCRIPTION$/i, /^DETAILED DESCRIPTION OF(?: THE)? (?:PREFERRED)?(?: EMBODIMENTS?)?$/i,
          /^DRAWINGS$/i, /^BRIEF DESCRIPTION OF (?:THE )?DRAWINGS$/i,
          /^EMBODIMENTS?$/i, /^DESCRIPTION OF EMBODIMENTS?$/i,
        ];
        const processedParagraphs = paragraphs.map(p => {
          if (p.startsWith('## ')) return p;
          for (const pattern of sectionHeadingPatterns) {
            if (pattern.test(p)) return '## ' + p;
          }
          return p;
        });
        htmlResult.description = processedParagraphs.join('\n\n');
      } else {
        htmlResult.description = descHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
    }
  }

  // PDF link
  const pdfMatch = html.match(/<a[^>]*itemprop="pdfLink"[^>]*href="([^"]+)"[^>]*>/i)
    || html.match(/<a[^>]*href="([^"]*patentimages[^"]*\.pdf)"[^>]*>/i)
    || html.match(/<a[^>]*href="([^"]*)"[^>]*>.*?PDF.*?<\/a>/i);
  if (pdfMatch) htmlResult.pdf_link = pdfMatch[1];

  // Events timeline - extract from application events
  const eventRows = html.matchAll(/<tr[^>]*itemprop="applicationEvents"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const er of eventRows) {
    const row = er[1];
    const dateMatch = row.match(/<time[^>]*>([\s\S]*?)<\/time>/i);
    const titleMatch = row.match(/<td[^>]*class="event-desc[^"]*"[^>]*>([\s\S]*?)<\/td>/i)
      || row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi);
    if (dateMatch) {
      htmlResult.events_timeline.push({
        date: dateMatch[1].replace(/<[^>]+>/g, "").trim(),
        title: titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : ""
      });
    }
  }
  // Also try legal events from table
  const legalRows = html.matchAll(/<tr[^>]*itemprop="legalEvents"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const lr of legalRows) {
    const row = lr[1];
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)];
    if (cells.length >= 2) {
      htmlResult.legal_events.push({
        date: cells[0][1].replace(/<[^>]+>/g, "").trim(),
        code: cells.length >= 3 ? cells[1][1].replace(/<[^>]+>/g, "").trim() : "",
        description: cells[cells.length >= 3 ? 2 : 1][1].replace(/<[^>]+>/g, "").trim()
      });
    }
  }

  // Priority date
  const priorityMatch = html.match(/<time[^>]*itemprop="priorityDate"[^>]*>([\s\S]*?)<\/time>/i);
  if (priorityMatch) htmlResult.priority_date = priorityMatch[1].replace(/<[^>]+>/g, "").trim();
  // Also try datetime attribute
  if (!htmlResult.priority_date) {
    const priorityDt = html.match(/<time[^>]*itemprop="priorityDate"[^>]*datetime="([^"]+)"/i);
    if (priorityDt) htmlResult.priority_date = priorityDt[1];
  }

  // Cited by (forward references)
  const citedByMatches = html.matchAll(/<tr[^>]*itemprop="forwardReferencesOrig"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const m of citedByMatches) {
    const row = m[1];
    const extracted = extractCitationRow(row);
    if (extracted) {
      const entry = {
        ...extracted,
        link: "https://patents.google.com/patent/" + extracted.patent_number,
      };
      if (!extracted.priority_date) delete entry.priority_date;
      htmlResult.cited_by.push(entry);
    }
  }
  // Also try forwardReferencesFamily
  const citedByFamilyMatches = html.matchAll(/<tr[^>]*itemprop="forwardReferencesFamily"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const m of citedByFamilyMatches) {
    const row = m[1];
    const extracted = extractCitationRow(row);
    if (extracted) {
      const pn = extracted.patent_number;
      // Avoid duplicates
      if (!htmlResult.cited_by.find(c => c.patent_number === pn)) {
        const entry = {
          ...extracted,
          link: "https://patents.google.com/patent/" + pn,
        };
        if (!extracted.priority_date) delete entry.priority_date;
        htmlResult.cited_by.push(entry);
      }
    }
  }

  // Similar documents
  const similarMatches = html.matchAll(/<tr[^>]*itemprop="similarDocuments"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const m of similarMatches) {
    const row = m[1];
    const numMatch = row.match(/<a[^>]*href="\/patent\/([^"]+)"[^>]*>/);
    if (numMatch) {
      htmlResult.similar_documents.push({
        patent_number: numMatch[1].replace(/<[^>]+>/g, "").trim(),
        link: "https://patents.google.com/patent/" + numMatch[1].replace(/<[^>]+>/g, "").trim(),
      });
    }
  }

  // Family ID
  const familyIdMatch = html.match(/ID=(\d+)/i);
  if (familyIdMatch) htmlResult.family_id = familyIdMatch[1];

  // Family applications
  const familyAppMatches = html.matchAll(/<tr[^>]*itemprop="applications"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const m of familyAppMatches) {
    const row = m[1];
    const numMatch = row.match(/<a[^>]*href="\/patent\/([^"]+)"[^>]*>/);
    const titleMatch2 = row.match(/<td[^>]*class="patent-title[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const statusMatch = row.match(/<td[^>]*class="patent-status[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    if (numMatch) {
      htmlResult.family_applications.push({
        publication_number: numMatch[1].replace(/<[^>]+>/g, "").trim(),
        title: titleMatch2 ? titleMatch2[1].replace(/<[^>]+>/g, "").trim() : "",
        status: statusMatch ? statusMatch[1].replace(/<[^>]+>/g, "").trim() : "",
        link: "https://patents.google.com/patent/" + numMatch[1].replace(/<[^>]+>/g, "").trim(),
      });
    }
  }
  // Also try docdbFamily (Also Published As)
  const docdbMatches = html.matchAll(/<tr[^>]*itemprop="docdbFamily"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const m of docdbMatches) {
    const row = m[1];
    const numMatch = row.match(/<a[^>]*href="\/patent\/([^"]+)"[^>]*>/);
    if (numMatch) {
      const pn = numMatch[1].replace(/<[^>]+>/g, "").trim();
      if (!htmlResult.family_applications.find(f => f.publication_number === pn)) {
        htmlResult.family_applications.push({
          publication_number: pn,
          link: "https://patents.google.com/patent/" + pn,
        });
      }
    }
  }

  // Country status
  const countryMatches = html.matchAll(/<tr[^>]*itemprop="countryStatus"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const m of countryMatches) {
    const row = m[1];
    const countryMatch = row.match(/<td[^>]*>([\s\S]*?)<\/td>/i);
    const numMatch = row.match(/<a[^>]*href="\/patent\/([^"]+)"[^>]*>/);
    if (countryMatch) {
      const cc = countryMatch[1].replace(/<[^>]+>/g, "").trim();
      htmlResult.country_status.push({
        country_code: cc,
        publication_number: numMatch ? numMatch[1].replace(/<[^>]+>/g, "").trim() : "",
        link: numMatch ? "https://patents.google.com/patent/" + numMatch[1].replace(/<[^>]+>/g, "").trim() : "",
      });
    }
  }

  // External links
  const linkMatches = html.matchAll(/<li[^>]*itemprop="links"[^>]*>([\s\S]*?)<\/li>/gi);
  for (const m of linkMatches) {
    const row = m[1];
    const idMatch = row.match(/<meta[^>]*itemprop="id"[^>]*content="([^"]+)"/i);
    const urlMatch = row.match(/<a[^>]*itemprop="url"[^>]*href="([^"]+)"/i);
    const textMatch = row.match(/<span[^>]*itemprop="text"[^>]*>([\s\S]*?)<\/span>/i);
    if (idMatch) {
      htmlResult.external_links[idMatch[1]] = {
        text: textMatch ? textMatch[1].replace(/<[^>]+>/g, "").trim() : idMatch[1],
        url: urlMatch ? urlMatch[1] : "",
      };
    }
  }

  // Landscapes (technical fields)
  const landscapeMatches = html.matchAll(/<li[^>]*itemprop="landscapes"[^>]*>([\s\S]*?)<\/li>/gi);
  for (const m of landscapeMatches) {
    const row = m[1];
    const nameMatch = row.match(/<span[^>]*itemprop="name"[^>]*>([\s\S]*?)<\/span>/i);
    if (nameMatch) {
      htmlResult.landscapes.push({
        name: nameMatch[1].replace(/<[^>]+>/g, "").trim(),
      });
    }
  }

  // Merge: JSON-LD takes priority for core fields, HTML supplements missing fields
  if (jsonLdResult) {
    // Use JSON-LD for core fields (title, abstract, inventors, assignees, dates, drawings)
    // but supplement with HTML-parsed classifications and citations
    if (htmlResult.classifications.length > 0) jsonLdResult.classifications = htmlResult.classifications;
    if (htmlResult.patent_citations.length > 0) jsonLdResult.patent_citations = htmlResult.patent_citations;
    // Supplement any missing core fields from HTML
    if (!jsonLdResult.title && htmlResult.title) jsonLdResult.title = htmlResult.title;
    if (!jsonLdResult.abstract && htmlResult.abstract) jsonLdResult.abstract = htmlResult.abstract;
    if (!jsonLdResult.application_date && htmlResult.application_date) jsonLdResult.application_date = htmlResult.application_date;
    if (!jsonLdResult.publication_date && htmlResult.publication_date) jsonLdResult.publication_date = htmlResult.publication_date;
    if (jsonLdResult.inventors.length === 0 && htmlResult.inventors.length > 0) jsonLdResult.inventors = htmlResult.inventors;
    if (jsonLdResult.assignees.length === 0 && htmlResult.assignees.length > 0) jsonLdResult.assignees = htmlResult.assignees;
    if (jsonLdResult.drawings.length === 0 && htmlResult.drawings.length > 0) jsonLdResult.drawings = htmlResult.drawings;
    if (htmlResult.claims.length > 0) jsonLdResult.claims = htmlResult.claims;
    if (htmlResult.description) jsonLdResult.description = htmlResult.description;
    if (htmlResult.pdf_link) jsonLdResult.pdf_link = htmlResult.pdf_link;
    if (htmlResult.events_timeline.length > 0) jsonLdResult.events_timeline = htmlResult.events_timeline;
    if (htmlResult.legal_events.length > 0) jsonLdResult.legal_events = htmlResult.legal_events;
    if (htmlResult.priority_date) jsonLdResult.priority_date = htmlResult.priority_date;
    if (htmlResult.cited_by.length > 0) jsonLdResult.cited_by = htmlResult.cited_by;
    if (htmlResult.similar_documents.length > 0) jsonLdResult.similar_documents = htmlResult.similar_documents;
    if (htmlResult.family_id) jsonLdResult.family_id = htmlResult.family_id;
    if (htmlResult.family_applications.length > 0) jsonLdResult.family_applications = htmlResult.family_applications;
    if (htmlResult.country_status.length > 0) jsonLdResult.country_status = htmlResult.country_status;
    if (Object.keys(htmlResult.external_links).length > 0) jsonLdResult.external_links = htmlResult.external_links;
    if (htmlResult.landscapes.length > 0) jsonLdResult.landscapes = htmlResult.landscapes;
    return jsonLdResult;
  }

  return htmlResult;
}

function scrapeGooglePatent(patentNumber, res, useProxy, proxyUrl, opsKey, opsSecret) {
  const { normalized, variants } = normalizePatentNumber(patentNumber);
  const allToTry = [normalized, ...variants];

  (async () => {
    for (const tryNumber of allToTry) {
      const url = `${GOOGLE_PATENTS_BASE}/patent/${encodeURIComponent(tryNumber)}`;
      const args = [
        "-s", "-k", "-w", "\n__HTTP_CODE__%{http_code}",
        "--max-time", "30",
        "-L",
        "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "-H", "Accept-Language: en-US,en;q=0.9",
        "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        url,
      ];
      if (useProxy && proxyUrl) {
        args.splice(2, 0, "--proxy", proxyUrl);
      }

      console.log(`[GP] 尝试抓取: ${url}`);

      const result = await new Promise((resolve) => {
        execFile("curl", args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
          if (err) {
            console.log(`[GP] curl 错误: ${err.message}`);
            resolve(null);
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
          console.log(`[GP] HTTP ${httpCode}, body长度: ${body.length}`);
          resolve({ httpCode, body });
        });
      });

      if (!result) {
        // curl error (network issue), try next variant
        continue;
      }

      if (result.httpCode === 429) {
        res.writeHead(429, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "Google Patents 请求过于频繁，请稍后重试" }));
        return;
      }

      if (result.httpCode === 200 && result.body && result.body.length > 1000) {
        const data = extractPatentFromHtml(result.body, tryNumber);
        if (data.title || data.abstract) {
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ success: true, data, patent_number: tryNumber }));
          return;
        }
      }
    }

    // Google Patents 所有变体均失败 —— 降级到 Espacenet
    const espacenetUrl = "https://worldwide.espacenet.com/patent/search?q=" + encodeURIComponent(patentNumber);
    console.log("[GP→Espacenet] Google Patents 未找到，降级到 Espacenet: " + espacenetUrl);
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({
      success: true,
      data_source: "Espacenet",
      espacenet_url: espacenetUrl,
      patent_number: normalized,
      data: { patent_number: normalized, data_source: "Espacenet", espacenet_url: espacenetUrl },
    }));
  })();
}

const server = http.createServer((req, res) => {
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

  if (req.url.startsWith("/api/jpo/doc/")) {
    const parts = req.url.replace("/api/jpo/doc/", "").split("/");
    const docType = parts[0] || "dispatch";
    const appNumber = parts.slice(1).join("/");
    proxyJpoDoc(docType, appNumber, res);
    return;
  }

  if (req.url.startsWith("/api/de/download")) {
    proxyDpmaDownload(req.url, res);
    return;
  }

  if (req.url.startsWith("/api/de/register-info/")) {
    const number = req.url.replace("/api/de/register-info/", "");
    proxyDpmaRegisterInfo(number, res);
    return;
  }

  if (req.url.startsWith("/api/gp/")) {
    const urlObj = new URL(req.url, "http://localhost");
    const patentNumber = urlObj.pathname.replace("/api/gp/", "");
    const useProxy = urlObj.searchParams.get("proxy") === "1";
    const proxyUrl = urlObj.searchParams.get("proxyUrl") || PROXY_URL;
    // OPS 降级查询凭证（前端从设置中读取并透传）
    const opsKey = urlObj.searchParams.get("opsKey") || process.env.OPS_CONSUMER_KEY || "";
    const opsSecret = urlObj.searchParams.get("opsSecret") || process.env.OPS_CONSUMER_SECRET || "";
    scrapeGooglePatent(decodeURIComponent(patentNumber), res, useProxy, proxyUrl, opsKey, opsSecret);
    return;
  }

  // OPS 配额查询端点（前端 20 分钟自动刷新调用）
  if (req.url.startsWith("/api/ops/quota")) {
    const urlObj = new URL(req.url, "http://localhost");
    const opsKey = urlObj.searchParams.get("opsKey") || process.env.OPS_CONSUMER_KEY || "";
    const opsSecret = urlObj.searchParams.get("opsSecret") || process.env.OPS_CONSUMER_SECRET || "";
    const quota = getOpsQuota(opsKey, opsSecret);
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({
      success: !!quota,
      quota: quota,
      message: quota ? null : "暂无配额数据，请先查询一次专利以触发配额采集",
    }));
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
  let filePath = path.join(__dirname, "src", urlPath);
  serveStatic(filePath, res);
});

async function extractPdfText(req, res) {
  const urlObj = new URL(req.url, "http://localhost");
  const urlPath = urlObj.pathname.replace("/api/gd/extract-text", "");
  const engine = urlObj.searchParams.get("engine") || "auto";
  const apiKey = urlObj.searchParams.get("api_key") || "";
  const gdUrl = `${GD_API_BASE}/doc-content/svc/doccontent${urlPath}`;

  const args = [
    "-s",
    "-w", " HTTP_CODE_%{http_code}",
    "--max-time", "60",
    "-H", "user-type: external",
    "-H", "Accept: application/pdf,*/*",
    "-H", "Referer: https://globaldossier.uspto.gov/",
    "-H", "Origin: https://globaldossier.uspto.gov",
    "-H", "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    gdUrl,
  ];

  const tempDir = "/tmp";
  const pdfPath = path.join(tempDir, `patent_${Date.now()}.pdf`);

  try {
    const curlResult = await new Promise((resolve, reject) => {
      execFile("curl", args, { maxBuffer: 50 * 1024 * 1024, encoding: "buffer" }, (err, stdoutBuffer) => {
        if (err) {
          reject(err);
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

        resolve({ httpCode, body: bodyBuffer });
      });
    });

    if (curlResult.httpCode !== 200) {
      throw new Error("PDF 下载失败: HTTP " + curlResult.httpCode);
    }

    const bodyText = curlResult.body.toString("utf-8");
    if (bodyText.includes("Attachment Not Found")) {
      throw new Error("文档暂不可下载（Attachment Not Found）");
    }

    if (curlResult.body.length < 100) {
      throw new Error("下载的文件过小，文档可能暂不可用");
    }

    await new Promise((resolve, reject) => {
      fs.writeFile(pdfPath, curlResult.body, (writeErr) => {
        if (writeErr) reject(writeErr);
        else resolve();
      });
    });

    const pythonArgs = [path.join(__dirname, "extract_pdf.py"), pdfPath, engine];
    if (apiKey) pythonArgs.push(apiKey);

    const extractResult = await new Promise((resolve) => {
      execFile("python3", pythonArgs, { maxBuffer: 50 * 1024 * 1024, timeout: 300000 }, (err, stdout, stderr) => {
        if (err) {
          console.error("Python error:", stderr || err.message);
          resolve({ text: "", markdown: "", engine: "none", error: stderr || err.message });
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseErr) {
          resolve({ text: stdout, markdown: "", engine: "unknown" });
        }
      });
    });

    fs.unlink(pdfPath, () => {});

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(extractResult));
  } catch (e) {
    console.error("Extract error:", e);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ text: "", markdown: "", engine: "none", error: e.message }));
  }
}

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
  console.log(`GD API proxy: /api/gd/* -> ${GD_API_BASE}/* (via curl)`);
  console.log(`JPO API proxy: /api/jpo/doc/* -> ${JPO_API_BASE}/* (via curl)`);
  console.log(`DPMA proxy: /api/de/* -> ${DPMA_REGISTER_BASE}/* (via curl)`);
});
