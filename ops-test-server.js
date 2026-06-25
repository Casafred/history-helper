#!/usr/bin/env node
/**
 * EPO OPS 独立测试服务器
 * 用法: node ops-test-server.js
 * 浏览器打开: http://localhost:9999/ops-test-page.html
 */
const http = require("http");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const OPS_API_BASE = "https://ops.epo.org/3.2/rest-services";
const OPS_AUTH_URL = "https://ops.epo.org/3.2/auth/accesstoken";
const PORT = 9999;

// OPS Token 缓存
const opsTokenCache = new Map();

// 通用 curl 请求（不注入任何 USPTO 头，支持可选代理）
function curlRequest(targetUrl, options) {
  return new Promise((resolve) => {
    const opts = options || {};
    const args = ["-s", "-k", "-L", "--max-time", String(opts.timeout || 30), "--connect-timeout", "10"];
    const tmpHeaderFile = require("os").tmpdir() + "/ops_hdr_" + Date.now() + "_" + Math.floor(Math.random() * 1e6) + ".txt";
    args.push("-D", tmpHeaderFile);
    if (opts.method && opts.method !== "GET") args.push("-X", opts.method);
    if (opts.headers) {
      for (const [k, v] of Object.entries(opts.headers)) args.push("-H", k + ": " + v);
    }
    if (opts.body) args.push("-d", opts.body);
    // 代理：仅当显式启用时才加 --proxy
    if (opts.useProxy && opts.proxyUrl) {
      args.splice(1, 0, "--proxy", opts.proxyUrl);
    }
    args.push(targetUrl);
    console.log("[curl]", args.filter(a => !a.startsWith("Authorization")).join(" "));
    execFile("curl", args, { maxBuffer: 50 * 1024 * 1024, encoding: opts.binary ? "buffer" : "utf8" }, (err, stdout) => {
      let headerText = "";
      try { headerText = fs.readFileSync(tmpHeaderFile, "utf8"); fs.unlinkSync(tmpHeaderFile); } catch (e) {}
      if (err) {
        resolve({ error: err.message, stdout: null, headerText, statusCode: 0, headers: {}, body: null });
        return;
      }
      let statusCode = 0;
      const headers = {};
      for (const line of headerText.split(/\r?\n/)) {
        const sm = line.match(/^HTTP\/[\d.]+\s+(\d+)/);
        if (sm) statusCode = parseInt(sm[1], 10);
        const hm = line.match(/^([^:]+):\s*(.*)$/);
        if (hm) headers[hm[1].toLowerCase()] = hm[2].trim();
      }
      resolve({ statusCode, headers, body: stdout, error: null });
    });
  });
}

async function getOpsToken(consumerKey, consumerSecret, useProxy, proxyUrl) {
  if (!consumerKey || !consumerSecret) return { error: "缺少凭证" };
  const cacheKey = consumerKey + ":" + consumerSecret;
  const cached = opsTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) return { token: cached.token, fromCache: true };

  const credentials = Buffer.from(consumerKey + ":" + consumerSecret).toString("base64");
  const result = await curlRequest(OPS_AUTH_URL, {
    method: "POST",
    headers: { "Authorization": "Basic " + credentials, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
    timeout: 15,
    useProxy, proxyUrl,
  });
  if (result.error) return { error: "Token请求失败: " + result.error };
  if (result.statusCode !== 200) return { error: "Token认证失败 HTTP " + result.statusCode, body: typeof result.body === "string" ? result.body.substring(0, 300) : "" };
  try {
    const data = JSON.parse(result.body);
    if (!data.access_token) return { error: "响应无access_token" };
    opsTokenCache.set(cacheKey, { token: data.access_token, expiresAt: Date.now() + ((parseInt(data.expires_in, 10) || 1200) - 60) * 1000 });
    return { token: data.access_token };
  } catch (e) { return { error: "Token JSON解析失败: " + e.message }; }
}

async function opsRequest(consumerKey, consumerSecret, opsPath, useProxy, proxyUrl) {
  const tokenResult = await getOpsToken(consumerKey, consumerSecret, useProxy, proxyUrl);
  if (tokenResult.error) return tokenResult;
  const fullUrl = OPS_API_BASE + opsPath;
  const result = await curlRequest(fullUrl, {
    method: "GET",
    headers: { "Authorization": "Bearer " + tokenResult.token, "Accept": "application/json" },
    timeout: 30,
    useProxy, proxyUrl,
  });
  if (result.error) return { error: result.error, url: fullUrl };
  return { httpCode: result.statusCode, headers: result.headers, body: typeof result.body === "string" ? result.body : "", url: fullUrl };
}

const server = http.createServer((req, res) => {
  const corsHdr = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  // 静态文件
  if (req.url === "/" || req.url === "/ops-test-page.html") {
    fs.readFile(path.join(__dirname, "src", "ops-test-page.html"), (err, data) => {
      if (err) { res.writeHead(404); res.end("Not Found"); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(data);
    });
    return;
  }

  // /api/ops/token — 仅测试 Token 获取
  if (req.url.startsWith("/api/ops/token")) {
    const u = new URL(req.url, "http://localhost");
    const key = u.searchParams.get("opsKey") || "";
    const secret = u.searchParams.get("opsSecret") || "";
    const useProxy = u.searchParams.get("proxy") === "1";
    const proxyUrl = u.searchParams.get("proxyUrl") || "";
    (async () => {
      const r = await getOpsToken(key, secret, useProxy, proxyUrl);
      res.writeHead(200, corsHdr);
      res.end(JSON.stringify(r));
    })();
    return;
  }

  // /api/ops/raw — 任意 OPS 路径查询
  if (req.url.startsWith("/api/ops/raw")) {
    const u = new URL(req.url, "http://localhost");
    const opsPath = u.searchParams.get("path") || "";
    const key = u.searchParams.get("opsKey") || "";
    const secret = u.searchParams.get("opsSecret") || "";
    const useProxy = u.searchParams.get("proxy") === "1";
    const proxyUrl = u.searchParams.get("proxyUrl") || "";
    (async () => {
      if (!opsPath || !key || !secret) { res.writeHead(400, corsHdr); res.end(JSON.stringify({ error: "缺少参数" })); return; }
      const r = await opsRequest(key, secret, opsPath, useProxy, proxyUrl);
      if (r.error) { res.writeHead(200, corsHdr); res.end(JSON.stringify({ httpCode: 0, error: r.error })); return; }
      res.writeHead(200, corsHdr);
      res.end(JSON.stringify({ httpCode: r.httpCode, body: r.body, headers: r.headers }));
    })();
    return;
  }

  // /api/ops/full-query — 模拟完整降级查询（GP超时→OPS）
  if (req.url.startsWith("/api/ops/full-query")) {
    const u = new URL(req.url, "http://localhost");
    const patent = u.searchParams.get("patent") || "EP1000000";
    const key = u.searchParams.get("opsKey") || "";
    const secret = u.searchParams.get("opsSecret") || "";
    const useProxy = u.searchParams.get("proxy") === "1";
    const proxyUrl = u.searchParams.get("proxyUrl") || "";
    (async () => {
      if (!key || !secret) { res.writeHead(400, corsHdr); res.end(JSON.stringify({ error: "缺少凭证" })); return; }

      // 解析专利号
      const num = patent.toUpperCase().replace(/[\s\/]/g, "");
      const m = num.match(/^([A-Z]{2})(\d+)([A-Z]\d*)?$/);
      if (!m) { res.writeHead(400, corsHdr); res.end(JSON.stringify({ error: "无法解析专利号: " + patent })); return; }
      const country = m[1], docNumber = m[2], kindCode = m[3] || "";
      const epodocNum = country + docNumber;

      // 串行查询各端点
      const endpoints = {
        biblio: "/published-data/publication/epodoc/" + encodeURIComponent(epodocNum) + "/biblio",
        abstract: "/published-data/publication/epodoc/" + encodeURIComponent(epodocNum) + "/abstract",
        claims: "/published-data/publication/epodoc/" + encodeURIComponent(epodocNum) + "/claims",
        description: "/published-data/publication/epodoc/" + encodeURIComponent(epodocNum) + "/description",
        legal: "/legal/publication/epodoc/" + encodeURIComponent(epodocNum),
        family: "/family/publication/epodoc/" + encodeURIComponent(epodocNum),
      };

      const results = {};
      for (const [name, opsPath] of Object.entries(endpoints)) {
        console.log("[OPS-TEST] 查询 " + name + ": " + opsPath + (useProxy ? " (proxy=" + proxyUrl + ")" : " (直连)"));
        const r = await opsRequest(key, secret, opsPath, useProxy, proxyUrl);
        results[name] = { httpCode: r.httpCode || 0, error: r.error || null, bodyLen: r.body ? r.body.length : 0 };
        if (r.httpCode === 200 && r.body) {
          try { results[name].preview = r.body.substring(0, 500); } catch (e) {}
        }
        // biblio 失败就停止
        if (name === "biblio" && r.httpCode !== 200) {
          results._stoppedAt = name;
          break;
        }
      }

      // 尝试解析 biblio 提取标题
      let title = "";
      try {
        const biblioResult = await opsRequest(key, secret, endpoints.biblio, useProxy, proxyUrl);
        if (biblioResult.httpCode === 200 && biblioResult.body) {
          const biblioJson = JSON.parse(biblioResult.body);
          const wpd = biblioJson["ops:world-patent-data"];
          let bibDoc = null;
          // 单文档格式
          const exDocs = wpd?.["exchange-documents"]?.["exchange-document"];
          if (exDocs) bibDoc = Array.isArray(exDocs) ? exDocs[0] : exDocs;
          // 搜索结果格式
          if (!bibDoc) {
            const sr = wpd?.["ops:biblio-search"]?.["ops:search-result"]?.["exchange-document"];
            if (sr) bibDoc = Array.isArray(sr) ? sr[0] : sr;
          }
          const biblio = bibDoc?.["bibliographic-data"] || {};
          const titleObj = biblio["invention-title"];
          if (typeof titleObj === "string") title = titleObj;
          else if (Array.isArray(titleObj)) {
            const en = titleObj.find(t => t["@lang"] === "en");
            title = (en || titleObj[0])?.$ || "";
          } else if (titleObj?.$) title = titleObj.$;
        }
      } catch (e) { title = "(解析失败: " + e.message + ")"; }

      res.writeHead(200, corsHdr);
      res.end(JSON.stringify({ patent, epodocNum, country, docNumber, kindCode, title, useProxy, proxyUrl: useProxy ? proxyUrl : "(直连)", endpoints: results }));
    })();
    return;
  }

  res.writeHead(404); res.end("Not Found");
});

server.listen(PORT, () => console.log("EPO OPS 测试服务器启动: http://localhost:" + PORT + "/ops-test-page.html"));
