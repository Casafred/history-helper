const http = require("http");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const GD_API_BASE = "https://d1kazzu6rbodne.cloudfront.net";
const JPO_API_BASE = "https://ip-data.jpo.go.jp";
const DPMA_REGISTER_BASE = "https://register.dpma.de";
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

  if (req.url.startsWith("/api/merge-pdf") && req.method === "POST") {
    mergePdfDocs(req, res);
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
    const items = params.items; // [{downloadUrl, originalTitle, chineseTitle, date, docCode}]

    if (!items || !Array.isArray(items) || items.length === 0) {
      res.writeHead(400, corsHeaders);
      res.end(JSON.stringify({ error: "No items provided" }));
      return;
    }

    const tempDir = "/tmp";
    const mergeId = `merge_${Date.now()}`;
    const downloadPromises = items.map(async (item, idx) => {
      const pdfPath = path.join(tempDir, `${mergeId}_doc${idx}.pdf`);
      let downloadUrl = item.downloadUrl;

      // For GD API URLs, convert to direct CloudFront URL
      if (downloadUrl.startsWith("/api/gd/")) {
        downloadUrl = GD_API_BASE + downloadUrl.replace("/api/gd", "");
      }

      // For JPO URLs, we need to handle token auth separately
      if (downloadUrl.startsWith("/api/jpo/")) {
        // JPO docs require auth token - use the proxy function approach
        try {
          const parts = downloadUrl.replace("/api/jpo/doc/", "").split("/");
          const docType = parts[0] || "dispatch";
          const appNumber = parts.slice(1).join("/");
          const token = await getJpoToken();
          if (!token) {
            return { success: false, pdfPath, error: "JPO API not configured" };
          }
          const jpoUrl = `${JPO_API_BASE}/api/patent/v1/${{refusal_reason: "app_doc_cont_refusal_reason", dispatch: "app_doc_cont_dispatch", submission: "app_doc_cont_submission", trial: "app_doc_cont_trial"}[docType] || "app_doc_cont_dispatch"}/${appNumber}`;
          const jpoArgs = ["-s", "-w", " HTTP_CODE_%{http_code}", "--max-time", "60", "-o", pdfPath, "-H", `Authorization: Bearer ${token}`, "-H", "Host: ip-data.jpo.go.jp", "-H", "Accept: application/zip,*/*", jpoUrl];
          const jpoResult = await new Promise((resolve) => {
            execFile("curl", jpoArgs, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
              if (err) { resolve({ success: false, error: err.message }); return; }
              const match = (stdout || "").match(/HTTP_CODE_(\d+)/);
              const httpCode = match ? parseInt(match[1], 10) : 0;
              resolve({ success: httpCode === 200, httpCode });
            });
          });
          if (!jpoResult.success) {
            return { success: false, pdfPath, error: `JPO HTTP ${jpoResult.httpCode}` };
          }
          // Verify PDF
          try {
            const stat = fs.statSync(pdfPath);
            if (stat.size < 100) return { success: false, pdfPath, error: "File too small" };
          } catch (e) {
            return { success: false, pdfPath, error: e.message };
          }
          return { success: true, pdfPath };
        } catch (e) {
          return { success: false, pdfPath, error: e.message };
        }
      }

      // GD API direct download
      const curlArgs = [
        "-s", "-w", " HTTP_CODE_%{http_code}",
        "--max-time", "60",
        "-o", pdfPath,
        "-H", "user-type: external",
        "-H", "Accept: application/pdf,*/*",
        "-H", "Referer: https://globaldossier.uspto.gov/",
        "-H", "Origin: https://globaldossier.uspto.gov",
        "-H", "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        downloadUrl,
      ];

      return new Promise((resolve) => {
        execFile("curl", curlArgs, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
          if (err) {
            resolve({ success: false, pdfPath, error: err.message });
            return;
          }
          const match = (stdout || "").match(/HTTP_CODE_(\d+)/);
          const httpCode = match ? parseInt(match[1], 10) : 0;
          if (httpCode !== 200) {
            resolve({ success: false, pdfPath, error: `HTTP ${httpCode}` });
            return;
          }
          // Verify file exists and is a valid PDF
          try {
            const stat = fs.statSync(pdfPath);
            if (stat.size < 100) {
              resolve({ success: false, pdfPath, error: "File too small" });
              return;
            }
            const header = fs.readFileSync(pdfPath, { length: 5 });
            if (header[0] !== 0x25 || header[1] !== 0x50) {
              resolve({ success: false, pdfPath, error: "Not a valid PDF" });
              return;
            }
          } catch (e) {
            resolve({ success: false, pdfPath, error: e.message });
            return;
          }
          resolve({ success: true, pdfPath });
        });
      });
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

    // Call merge_pdf.py
    const outputPath = path.join(tempDir, `${mergeId}_merged.pdf`);
    const mergeArgs = [
      path.join(__dirname, "merge_pdf.py"),
      "--output", outputPath,
      "--items", JSON.stringify(mergeItems),
    ];

    const mergeResult = await new Promise((resolve) => {
      execFile("python3", mergeArgs, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
        if (err) {
          console.error("Merge error:", stderr || err.message);
          resolve({ success: false, error: stderr || err.message });
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve({ success: false, error: stdout });
        }
      });
    });

    if (!mergeResult.success) {
      res.writeHead(200, corsHeaders);
      res.end(JSON.stringify({ error: "Merge failed: " + (mergeResult.error || "unknown"), failedItems }));
      return;
    }

    // Read the merged PDF and send it
    fs.readFile(outputPath, (readErr, pdfData) => {
      // Cleanup temp files
      mergeItems.forEach((item) => {
        try { fs.unlinkSync(item.pdf_path); } catch {}
      });
      try { fs.unlinkSync(outputPath); } catch {}

      if (readErr) {
        res.writeHead(200, corsHeaders);
        res.end(JSON.stringify({ error: "Failed to read merged PDF" }));
        return;
      }

      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Access-Control-Allow-Origin": "*",
        "Content-Disposition": 'attachment; filename="merged_patent_docs.pdf"',
      });
      res.end(pdfData);
    });
  } catch (e) {
    console.error("Merge PDF error:", e);
    res.writeHead(200, corsHeaders);
    res.end(JSON.stringify({ error: e.message }));
  }
}

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
  console.log(`GD API proxy: /api/gd/* -> ${GD_API_BASE}/* (via curl)`);
  console.log(`JPO API proxy: /api/jpo/doc/* -> ${JPO_API_BASE}/* (via curl)`);
  console.log(`DPMA proxy: /api/de/* -> ${DPMA_REGISTER_BASE}/* (via curl)`);
});
