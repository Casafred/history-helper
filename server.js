const http = require("http");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const GD_API_BASE = "https://d1kazzu6rbodne.cloudfront.net";
const JPO_API_BASE = "https://ip-data.jpo.go.jp";
const DPMA_REGISTER_BASE = "https://register.dpma.de";
const GOOGLE_PATENTS_BASE = "https://patents.google.com";
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
  const citationMatches = html.matchAll(/<tr[^>]*itemprop="backwardReferencesOrig"[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const m of citationMatches) {
    const row = m[1];
    const numMatch = row.match(/<a[^>]*href="\/patent\/([^"]+)"[^>]*>/);
    const titleMatch2 = row.match(/<td[^>]*class="patent-title[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    if (numMatch) {
      htmlResult.patent_citations.push({
        patent_number: numMatch[1].replace(/<[^>]+>/g, "").trim(),
        title: titleMatch2 ? titleMatch2[1].replace(/<[^>]+>/g, "").trim() : "",
      });
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

    // Strategy 1: Extract from <div class="claim" num="N"> elements (Google Patents format)
    // Use a function to properly handle nested divs by tracking depth
    function extractDivClaims(html) {
      const claims = [];
      const claimStartRegex = /<div[^>]*class="claim[^"]*"[^>]*num="(\d+)"[^>]*>/gi;
      let match;
      while ((match = claimStartRegex.exec(html)) !== null) {
        const claimNum = match[1];
        const startIndex = match.index + match[0].length;
        // Find matching closing tag by tracking div depth
        let depth = 1;
        let pos = startIndex;
        const divOpen = /<div[\s>]/gi;
        const divClose = /<\/div>/gi;
        divOpen.lastIndex = startIndex;
        divClose.lastIndex = startIndex;
        while (depth > 0 && pos < html.length) {
          const nextOpen = divOpen.exec(html);
          const nextClose = divClose.exec(html);
          if (!nextClose) break;
          if (nextOpen && nextOpen.index < nextClose.index) {
            depth++;
            pos = nextOpen.index + 1;
          } else {
            depth--;
            if (depth === 0) {
              const claimBody = html.substring(startIndex, nextClose.index);
              let claimText = claimBody.replace(/<br\s*\/?>/gi, " ").replace(/<\/div>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
              const isDependent = /claim-dependent/.test(match[0]) || /claim\s*\d+/i.test(claimText.substring(0, 100)) || claimText.includes('根据权利要求');
              if (claimText && claimText.length > 5) {
                claims.push({ num: claimNum, text: claimText, type: isDependent ? "dependent" : "independent" });
              }
              break;
            }
            pos = nextClose.index + 1;
          }
        }
      }
      return claims;
    }

    // Also try <div num="N" class="claim"> (attribute order may vary)
    function extractDivClaimsAlt(html) {
      const claims = [];
      const claimStartRegex = /<div[^>]*num="(\d+)"[^>]*class="claim[^"]*"[^>]*>/gi;
      let match;
      while ((match = claimStartRegex.exec(html)) !== null) {
        const claimNum = match[1];
        const startIndex = match.index + match[0].length;
        let depth = 1;
        let pos = startIndex;
        const divOpen = /<div[\s>]/gi;
        const divClose = /<\/div>/gi;
        divOpen.lastIndex = startIndex;
        divClose.lastIndex = startIndex;
        while (depth > 0 && pos < html.length) {
          const nextOpen = divOpen.exec(html);
          const nextClose = divClose.exec(html);
          if (!nextClose) break;
          if (nextOpen && nextOpen.index < nextClose.index) {
            depth++;
            pos = nextOpen.index + 1;
          } else {
            depth--;
            if (depth === 0) {
              const claimBody = html.substring(startIndex, nextClose.index);
              let claimText = claimBody.replace(/<br\s*\/?>/gi, " ").replace(/<\/div>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
              const isDependent = /claim-dependent/.test(match[0]) || /claim\s*\d+/i.test(claimText.substring(0, 100)) || claimText.includes('根据权利要求');
              if (claimText && claimText.length > 5) {
                claims.push({ num: claimNum, text: claimText, type: isDependent ? "dependent" : "independent" });
              }
              break;
            }
            pos = nextClose.index + 1;
          }
        }
      }
      return claims;
    }

    // Also try <li class="claim"> format
    function extractLiClaims(html) {
      const claims = [];
      const claimMatches = html.matchAll(/<li[^>]*class="claim(?:-dependent)?[^"]*"[^>]*>([\s\S]*?)<\/li>/gi);
      for (const cm of claimMatches) {
        const claimBody = cm[1];
        const isDependent = cm[0].includes('claim-dependent');
        let claimText = claimBody.replace(/<br\s*\/?>/gi, " ").replace(/<\/div>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        const numMatch = cm[0].match(/num="(\d+)"/);
        const claimNum = numMatch ? numMatch[1] : "";
        if (claimText && claimText.length > 5) {
          claims.push({ num: claimNum, text: claimText, type: isDependent ? "dependent" : "independent" });
        }
      }
      return claims;
    }

    // Try all strategies, pick the one with most claims
    const divClaims = extractDivClaims(claimsHtml);
    const divClaimsAlt = extractDivClaimsAlt(claimsHtml);
    const liClaims = extractLiClaims(claimsHtml);

    if (divClaims.length >= divClaimsAlt.length && divClaims.length >= liClaims.length && divClaims.length > 0) {
      htmlResult.claims = divClaims;
    } else if (divClaimsAlt.length >= liClaims.length && divClaimsAlt.length > 0) {
      htmlResult.claims = divClaimsAlt;
    } else if (liClaims.length > 0) {
      htmlResult.claims = liClaims;
    }

    // Last resort: extract claims by number pattern in text
    if (htmlResult.claims.length === 0) {
      const textContent = claimsHtml.replace(/<br\s*\/?>/gi, " ").replace(/<\/div>/gi, " ").replace(/<[^>]+>/g, " ");
      const claimNumRegex = /(?:^|\s)(\d+)\.\s*((?:(?!^\d+\.\s)[\s\S])+)/gm;
      let cm;
      while ((cm = claimNumRegex.exec(textContent)) !== null) {
        const claimNum = cm[1];
        let claimText = cm[2].replace(/\s+/g, " ").trim();
        if (claimText && claimText.length > 5) {
          const isDep = /claim\s*\d+/i.test(claimText.substring(0, 100)) || claimText.includes('根据权利要求');
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
  const pdfMatch = html.match(/<a[^>]*itemprop="pdfLink"[^>]*href="([^"]+)"[^>]*>/i);
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
    return jsonLdResult;
  }

  return htmlResult;
}

function scrapeGooglePatent(patentNumber, res) {
  const { normalized, variants } = normalizePatentNumber(patentNumber);
  const allToTry = [normalized, ...variants];

  (async () => {
    for (const tryNumber of allToTry) {
      const url = `${GOOGLE_PATENTS_BASE}/patent/${encodeURIComponent(tryNumber)}`;
      const args = [
        "-s", "-k", "-w", "\n__HTTP_CODE__%{http_code}",
        "--proxy", PROXY_URL,
        "--max-time", "30",
        "-L",
        "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "-H", "Accept-Language: en-US,en;q=0.9",
        "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        url,
      ];

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

    res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ success: false, error: `未找到专利: ${patentNumber}`, patent_number: normalized }));
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
    const patentNumber = req.url.replace("/api/gp/", "").replace(/[?#].*$/, "");
    scrapeGooglePatent(decodeURIComponent(patentNumber), res);
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
