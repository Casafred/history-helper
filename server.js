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

  if (req.url.startsWith("/api/gd/")) {
    const gdPath = req.url.replace("/api/gd", "");
    proxyGdApi(gdPath, res);
    return;
  }

  // JPO API proxy (JP-specific)
  if (req.url.startsWith("/api/jpo/")) {
    proxyJpoApi(req, res);
    return;
  }

  // DPMA proxy (DE-specific)
  if (req.url.startsWith("/api/de/")) {
    proxyDpmaApi(req, res);
    return;
  }

  let urlPath = req.url === "/" ? "/web.html" : req.url;
  // Strip query parameters for static file serving
  const qIdx = urlPath.indexOf("?");
  if (qIdx !== -1) urlPath = urlPath.substring(0, qIdx);
  const filePath = path.join(__dirname, "src", urlPath);
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
  console.log(`JPO API proxy: /api/jpo/* -> ${JPO_API_BASE}/* (via curl)`);
  console.log(`DPMA proxy: /api/de/* -> ${DPMA_REGISTER_BASE}/* (via curl)`);
});

// ─── JPO API Proxy (JP-specific) ──────────────────────────────────────

function proxyJpoApi(req, res) {
  const urlObj = new URL(req.url, "http://localhost");
  const urlPath = urlObj.pathname.replace("/api/jpo", "");

  // Handle status endpoint (no proxy needed)
  if (urlPath === "/status") {
    const jpoUsername = process.env.JPO_API_USERNAME || "";
    const jpoPassword = process.env.JPO_API_PASSWORD || "";
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({
      configured: !!(jpoUsername && jpoPassword),
      office: "JP",
      source: "JPO API (ip-data.jpo.go.jp)",
    }));
    return;
  }

  // For web mode, JPO API requires credentials from environment
  const jpoUsername = process.env.JPO_API_USERNAME;
  const jpoPassword = process.env.JPO_API_PASSWORD;

  if (!jpoUsername || !jpoPassword) {
    res.writeHead(503, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({
      error: "JPO API 未配置。请在环境变量中设置 JPO_API_USERNAME 和 JPO_API_PASSWORD",
    }));
    return;
  }

  // Step 1: Get access token
  const tokenUrl = `${JPO_API_BASE}/oauth2/token`;
  const tokenArgs = [
    "-s", "--max-time", "30",
    "-X", "POST",
    "-H", `Host: ip-data.jpo.go.jp`,
    "-H", "Content-Type: application/x-www-form-urlencoded",
    "--data-urlencode", "grant_type=password",
    "--data-urlencode", `username=${jpoUsername}`,
    "--data-urlencode", `password=${jpoPassword}`,
    tokenUrl,
  ];

  execFile("curl", tokenArgs, { maxBuffer: 1024 * 1024 }, (tokenErr, tokenStdout) => {
    if (tokenErr) {
      res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "JPO token request failed: " + tokenErr.message }));
      return;
    }

    let tokenData;
    try {
      tokenData = JSON.parse(tokenStdout);
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "JPO token parse failed" }));
      return;
    }

    if (!tokenData.access_token) {
      res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "JPO authentication failed: " + (tokenStdout.substring(0, 200)) }));
      return;
    }

    // Step 2: Make the actual API request with the token
    const apiUrl = `${JPO_API_BASE}/api/patent/v1${urlPath}`;
    const apiArgs = [
      "-s", "-w", "\n__HTTP_CODE__%{http_code}",
      "--max-time", "60",
      "-H", `Authorization: Bearer ${tokenData.access_token}`,
      "-H", "Host: ip-data.jpo.go.jp",
      "-H", "Accept: application/json, application/zip, */*",
      apiUrl,
    ];

    execFile("curl", apiArgs, { maxBuffer: 50 * 1024 * 1024, encoding: "buffer" }, (apiErr, apiStdout) => {
      if (apiErr) {
        res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "JPO API request failed: " + apiErr.message }));
        return;
      }

      const markerBuffer = Buffer.from("\n__HTTP_CODE__");
      let idx = -1;
      for (let i = Math.max(0, apiStdout.length - 30); i < apiStdout.length; i++) {
        if (apiStdout.slice(i, i + markerBuffer.length).equals(markerBuffer)) {
          idx = i;
          break;
        }
      }

      let httpCode = 200;
      let bodyBuffer = apiStdout;
      if (idx !== -1) {
        httpCode = parseInt(apiStdout.slice(idx + markerBuffer.length).toString().trim(), 10);
        bodyBuffer = apiStdout.slice(0, idx);
      }

      // Check if response is JSON or ZIP
      const isJson = bodyBuffer.length > 0 && bodyBuffer[0] === 0x7B; // '{'
      const isZip = bodyBuffer.length > 2 && bodyBuffer[0] === 0x50 && bodyBuffer[1] === 0x4B; // 'PK'

      const respHeaders = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      };

      if (isJson) {
        respHeaders["Content-Type"] = "application/json";
        res.writeHead(httpCode, respHeaders);
        res.end(bodyBuffer);
      } else if (isZip) {
        respHeaders["Content-Type"] = "application/zip";
        respHeaders["Content-Disposition"] = "attachment; filename=\"jpo_document.zip\"";
        res.writeHead(httpCode, respHeaders);
        res.end(bodyBuffer);
      } else {
        respHeaders["Content-Type"] = "application/json";
        res.writeHead(httpCode, respHeaders);
        // Try to parse as text
        try {
          const text = bodyBuffer.toString("utf-8");
          res.end(JSON.stringify({ error: "Unexpected response", detail: text.substring(0, 500) }));
        } catch (e) {
          res.end(bodyBuffer);
        }
      }
    });
  });
}

// ─── DPMA Proxy (DE-specific) ──────────────────────────────────────────

function proxyDpmaApi(req, res) {
  const urlObj = new URL(req.url, "http://localhost");
  const urlPath = urlObj.pathname.replace("/api/de", "");

  // Handle status endpoint
  if (urlPath === "/status") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({
      configured: true,
      office: "DE",
      source: "DPMAregister (register.dpma.de)",
    }));
    return;
  }

  // Handle file inspection
  if (urlPath.startsWith("/file-inspection/")) {
    const fileNumber = urlPath.replace("/file-inspection/", "");
    proxyDpmaFileInspection(fileNumber, res);
    return;
  }

  // Handle document download
  if (urlPath.startsWith("/download/")) {
    const docPath = urlPath.replace("/download/", "");
    const docUrl = docPath.startsWith("http") ? docPath : `${DPMA_REGISTER_BASE}/${docPath}`;
    proxyDpmaDownload(docUrl, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify({ error: "Unknown DE API endpoint" }));
}

function proxyDpmaFileInspection(fileNumber, res) {
  // Step 1: Search for the patent in DPMAregister
  const searchUrl = `${DPMA_REGISTER_BASE}/DPMAregister/pat/experte?search=${encodeURIComponent(fileNumber)}`;
  const searchArgs = [
    "-s", "-L", "--max-time", "30",
    "-H", "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "-H", "Accept-Language: de,en-US;q=0.7,en;q=0.3",
    "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    searchUrl,
  ];

  execFile("curl", searchArgs, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
    if (err) {
      res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "DPMA search failed: " + err.message }));
      return;
    }

    // For now, return the search results as structured data
    // The DPMAregister HTML parsing is complex and would need a proper HTML parser
    // In production, this would be handled by the Rust backend's DpmaClient
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({
      fileNumber: fileNumber,
      documents: [],
      note: "DPMAregister file inspection requires the Tauri backend (DpmaClient) for full HTML parsing. In web mode, please use the Tauri desktop app for DE patent document access.",
      searchUrl: searchUrl,
    }));
  });
}

function proxyDpmaDownload(docUrl, res) {
  const args = [
    "-s", "-w", " HTTP_CODE_%{http_code}",
    "--max-time", "60",
    "-H", "Accept: application/pdf,*/*",
    "-H", "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    docUrl,
  ];

  execFile("curl", args, { maxBuffer: 50 * 1024 * 1024, encoding: "buffer" }, (err, stdoutBuffer) => {
    if (err) {
      res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ error: "DPMA download failed: " + err.message }));
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
      httpCode = parseInt(stdoutBuffer.slice(idx + markerBuffer.length).toString().trim(), 10);
      bodyBuffer = stdoutBuffer.slice(0, idx);
    }

    const isPdf = bodyBuffer.length > 2 && bodyBuffer[0] === 0x25 && bodyBuffer[1] === 0x50;
    const respHeaders = {
      "Content-Type": isPdf ? "application/pdf" : "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
    };

    if (isPdf) {
      respHeaders["Content-Disposition"] = 'attachment; filename="de_document.pdf"';
    }

    res.writeHead(httpCode, respHeaders);
    res.end(bodyBuffer);
  });
}
