const http = require("http");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const GD_API_BASE = "https://d1kazzu6rbodne.cloudfront.net";
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
    // 文档内容请求（二进制文件，如PDF）
    const args = [
      "-s",
      "-w", " HTTP_CODE_%{http_code}",
      "--max-time", "60",
      "-H", "user-type: external",
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

      // 寻找 HTTP 代码标记
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

      const respHeaders = {
        "Content-Type": "application/pdf",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, user-type",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Content-Disposition": `attachment; filename="document.pdf"`,
      };
      res.writeHead(httpCode, respHeaders);
      res.end(bodyBuffer);
    });
  } else {
    // 普通 API 请求（JSON）
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

  if (req.url.startsWith("/api/gd/lookup-app-num/")) {
    lookupAppNum(req, res);
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

  let filePath = req.url === "/" ? "/web.html" : req.url;
  filePath = path.join(__dirname, "src", filePath);
  serveStatic(filePath, res);
});

async function extractPdfText(req, res) {
  const segments = req.url.split("/");
  const office = segments[4];
  const appNum = segments[5];
  const docId = segments[6];

  const gdUrl = `${GD_API_BASE}/doc-content/svc/doccontent/${office}/${appNum}/${docId}/1/PDF`;

  const args = [
    "-s",
    gdUrl,
    "-H", "user-type: external",
    "-H", "Referer: https://globaldossier.uspto.gov/",
    "-H", "Origin: https://globaldossier.uspto.gov",
    "-H", "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  ];

  const tempDir = "/tmp";
  const pdfPath = path.join(tempDir, `patent_${Date.now()}.pdf`);

  try {
    await new Promise((resolve, reject) => {
      const curl = execFile("curl", args, { maxBuffer: 50 * 1024 * 1024, encoding: "buffer" }, (err, stdout, stderr) => {
        if (err) {
          reject(err);
          return;
        }
        fs.writeFile(pdfPath, stdout, (writeErr) => {
          if (writeErr) reject(writeErr);
          else resolve();
        });
      });
    });

    const text = await new Promise((resolve, reject) => {
      const python = execFile("python3", [path.join(__dirname, "extract_pdf.py"), pdfPath], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          console.error("Python error:", stderr);
          resolve("");
          return;
        }
        resolve(stdout);
      });
    });

    fs.unlink(pdfPath, () => {});

    const response = {
      success: true,
      text: text || ""
    };

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(JSON.stringify(response));
  } catch (e) {
    console.error("Extract error:", e);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(JSON.stringify({
      success: false,
      error: e.message
    }));
  }
}

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
  console.log(`GD API proxy: /api/gd/* -> ${GD_API_BASE}/* (via curl)`);
});

async function lookupAppNum(req, res) {
  const segments = req.url.split("/");
  const office = segments[4];
  const pubNum = decodeURIComponent(segments[5] || "");

  const respond = (data) => {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    });
    res.end(JSON.stringify(data));
  };

  if (office === "CN") {
    try {
      const appNum = await lookupCnAppNum(pubNum);
      if (appNum) {
        respond({ applicationNumber: appNum, office: "CN" });
      } else {
        respond({ error: "未找到对应申请号", office: "CN" });
      }
    } catch (e) {
      console.error("lookupAppNum error:", e);
      respond({ error: e.message, office: "CN" });
    }
  } else {
    respond({ error: "暂不支持 " + office + " 的公开号查询", office });
  }
}

async function lookupCnAppNum(pubNum) {
  let cleanNum = pubNum.replace(/^CN/i, "").replace(/\./g, "");
  const kindMatch = cleanNum.match(/^(\d+)([A-Z]\d*)$/i);
  let kindCode = "";
  if (kindMatch) {
    cleanNum = kindMatch[1];
    kindCode = kindMatch[2].toUpperCase();
  }

  const opsUrl = `https://ops.epo.org/3.2/rest-services/published-data/publication/docdb/CN,${cleanNum},${kindCode || "A"}`;
  const args = [
    "-s",
    "-w", "\n__HTTP_CODE__%{http_code}",
    "--max-time", "15",
    "-H", "Accept: application/json",
    opsUrl
  ];

  const stdout = await new Promise((resolve, reject) => {
    execFile("curl", args, { maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
      if (err) { reject(err); return; }
      resolve(stdout);
    });
  });

  const marker = "\n__HTTP_CODE__";
  const idx = stdout.lastIndexOf(marker);
  let httpCode = 200;
  let body = stdout;
  if (idx !== -1) {
    httpCode = parseInt(stdout.substring(idx + marker.length), 10);
    body = stdout.substring(0, idx);
  }

  if (httpCode === 200 || httpCode === 303) {
    try {
      const data = JSON.parse(body);
      const appRef = data?.["ops:world-patent-data"]?.["exchange-documents"]?.["exchange-document"]?.["bibliographic-data"]?.["application-reference"]?.["document-id"];
      if (appRef) {
        const appId = Array.isArray(appRef) ? appRef.find(d => d["@country"] === "CN") || appRef[0] : appRef;
        if (appId && appId["doc-number"]) {
          let appNum = appId["doc-number"]["$"] || appId["doc-number"];
          appNum = String(appNum).replace(/^CN/i, "").replace(/\./g, "");
          return appNum;
        }
      }
    } catch (e) {
      console.error("EPO OPS parse error:", e);
    }
  }

  return null;
}
