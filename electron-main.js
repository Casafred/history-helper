const { app, BrowserWindow } = require("electron");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const { PDFDocument, rgb, StandardFonts } = require("pdf-lib");
const fontkit = require("@pdf-lib/fontkit");

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

  // Patent citations (backward references)
  // backwardReferencesOrig = examiner citations (marked with * in Google Patents)
  const citationMatches = html.matchAll(/<tr[^>]*itemprop="backwardReferencesOrig"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const m of citationMatches) {
    const row = m[1];
    const numMatch = row.match(/<a[^>]*href="\/patent\/([^"]+)"[^>]*>/);
    const titleMatch2 = row.match(/<td[^>]*class="patent-title[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const pubDateMatch = row.match(/<time[^>]*>([\s\S]*?)<\/time>/i);
    const assigneeMatch = row.match(/<td[^>]*class="patent-assignee[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    // Check for * marker in the row (examiner citation indicator)
    const hasStar = /\*/.test(row.replace(/<[^>]+>/g, ""));
    if (numMatch) {
      htmlResult.patent_citations.push({
        patent_number: numMatch[1].replace(/<[^>]+>/g, "").trim(),
        title: titleMatch2 ? titleMatch2[1].replace(/<[^>]+>/g, "").trim() : "",
        publication_date: pubDateMatch ? pubDateMatch[1].replace(/<[^>]+>/g, "").trim() : "",
        assignee: assigneeMatch ? assigneeMatch[1].replace(/<[^>]+>/g, "").trim() : "",
        link: "https://patents.google.com/patent/" + numMatch[1].replace(/<[^>]+>/g, "").trim(),
        citation_type: hasStar ? "examiner" : "applicant",
      });
    }
  }
  // backwardReferencesFamily = family-level citations (typically applicant)
  const citationFamilyMatches = html.matchAll(/<tr[^>]*itemprop="backwardReferencesFamily"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const m of citationFamilyMatches) {
    const row = m[1];
    const numMatch = row.match(/<a[^>]*href="\/patent\/([^"]+)"[^>]*>/);
    const titleMatch2 = row.match(/<td[^>]*class="patent-title[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    if (numMatch) {
      const pn = numMatch[1].replace(/<[^>]+>/g, "").trim();
      if (!htmlResult.patent_citations.find(c => c.patent_number === pn)) {
        htmlResult.patent_citations.push({
          patent_number: pn,
          title: titleMatch2 ? titleMatch2[1].replace(/<[^>]+>/g, "").trim() : "",
          link: "https://patents.google.com/patent/" + pn,
          citation_type: "applicant",
        });
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
      const claims = [];
      // Match any div with both class="claim..." and num="N" in any order
      const claimStartRegex = /<div([^>]*?)>/gi;
      let m;
      while ((m = claimStartRegex.exec(html)) !== null) {
        const attrs = m[1];
        const classMatch = attrs.match(/class="([^"]*claim[^"]*)"/i);
        const numMatch = attrs.match(/num="(\d+)"/i);
        if (!classMatch || !numMatch) continue;
        // Must have "claim" in class (not e.g. "claim-text" as a top-level)
        if (!/\bclaim\b/.test(classMatch[1])) continue;
        const claimNum = numMatch[1];
        const isDependentByClass = /claim-dependent/.test(classMatch[1]);
        const openTagEnd = m.index + m[0].length;
        const closeIdx = findMatchingCloseDiv(html, m.index);
        if (closeIdx === -1) continue;
        const claimBody = html.substring(openTagEnd, closeIdx);
        // Clean HTML: replace <br> and </div> with space first to preserve word boundaries
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
        // Determine dependent/independent
        const isDependent = isDependentByClass
          || /claim\s*\d+/i.test(claimText.substring(0, 150))
          || claimText.includes('根据权利要求')
          || claimText.includes('根據權利要求')
          || /所述的/.test(claimText.substring(0, 50));
        if (claimText && claimText.length > 3) {
          claims.push({ num: claimNum, text: claimText, type: isDependent ? "dependent" : "independent" });
        }
      }
      return claims;
    }

    // Strategy 2: Extract from <li class="claim"> / <li class="claim-dependent">
    function extractLiClaims(html) {
      const claims = [];
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
        if (claimText && claimText.length > 3) {
          const isDep = isDependent || /claim\s*\d+/i.test(claimText.substring(0, 150)) || claimText.includes('根据权利要求');
          claims.push({ num: claimNum, text: claimText, type: isDep ? "dependent" : "independent" });
        }
      }
      return claims;
    }

    // Strategy 3: Extract from claim-text divs (some pages use <div class="claim-text">)
    function extractClaimTextDivs(html) {
      const claims = [];
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
        if (claimText && claimText.length > 3) {
          const isDep = /claim\s*\d+/i.test(claimText.substring(0, 150)) || claimText.includes('根据权利要求');
          claims.push({ num: claimNum, text: claimText, type: isDep ? "dependent" : "independent" });
        }
      }
      return claims;
    }

    // Try all strategies, pick the one with most claims
    const divClaims = extractDivClaims(claimsHtml);
    const liClaims = extractLiClaims(claimsHtml);
    const claimTextDivs = extractClaimTextDivs(claimsHtml);

    const candidates = [
      { claims: divClaims, name: 'divClaims' },
      { claims: liClaims, name: 'liClaims' },
      { claims: claimTextDivs, name: 'claimTextDivs' },
    ].sort((a, b) => b.claims.length - a.claims.length);

    if (candidates[0].claims.length > 0) {
      htmlResult.claims = candidates[0].claims;
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
      const paraMatches = descHtml.matchAll(/<div[^>]*class="description-paragraph"[^>]*>([\s\S]*?)<\/div>/gi);
      const paragraphs = [];
      for (const pm of paraMatches) {
        const pText = pm[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        if (pText) paragraphs.push(pText);
      }
      if (paragraphs.length > 0) {
        htmlResult.description = paragraphs.join('\n\n');
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
    const numMatch = row.match(/<a[^>]*href="\/patent\/([^"]+)"[^>]*>/);
    const titleMatch2 = row.match(/<td[^>]*class="patent-title[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const pubDateMatch = row.match(/<time[^>]*>([\s\S]*?)<\/time>/i);
    if (numMatch) {
      htmlResult.cited_by.push({
        patent_number: numMatch[1].replace(/<[^>]+>/g, "").trim(),
        title: titleMatch2 ? titleMatch2[1].replace(/<[^>]+>/g, "").trim() : "",
        publication_date: pubDateMatch ? pubDateMatch[1].replace(/<[^>]+>/g, "").trim() : "",
        link: "https://patents.google.com/patent/" + numMatch[1].replace(/<[^>]+>/g, "").trim(),
      });
    }
  }
  // Also try forwardReferencesFamily
  const citedByFamilyMatches = html.matchAll(/<tr[^>]*itemprop="forwardReferencesFamily"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const m of citedByFamilyMatches) {
    const row = m[1];
    const numMatch = row.match(/<a[^>]*href="\/patent\/([^"]+)"[^>]*>/);
    const titleMatch2 = row.match(/<td[^>]*class="patent-title[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    if (numMatch) {
      const pn = numMatch[1].replace(/<[^>]+>/g, "").trim();
      // Avoid duplicates
      if (!htmlResult.cited_by.find(c => c.patent_number === pn)) {
        htmlResult.cited_by.push({
          patent_number: pn,
          title: titleMatch2 ? titleMatch2[1].replace(/<[^>]+>/g, "").trim() : "",
          link: "https://patents.google.com/patent/" + pn,
        });
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
      "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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

  res.writeHead(404, corsHeaders);
  res.end(JSON.stringify({ success: false, error: `未找到专利: ${patentNumber}`, patent_number: normalized }));
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
