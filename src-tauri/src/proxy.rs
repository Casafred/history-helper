use axum::{
    body::Body,
    extract::State,
    http::{header, Method, Request, Response, StatusCode},
    response::IntoResponse,
    routing::any,
    Router,
};
use reqwest::Client;
use std::path::PathBuf;
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};

const GD_API_BASE: &str = "https://d1kazzu6rbodne.cloudfront.net";

const PADDLE_OCR_VL_URL: &str =
    "https://k2neb1qcy1u6g4k5.aistudio-app.com/layout-parsing";
const PADDLE_OCR_VL_TOKEN: &str = "70b270c8275606a7a97f8c4e8617cdeb935ed74c";
const GLM_OCR_URL: &str = "https://open.bigmodel.cn/api/paas/v4/layout_parsing";

struct ProxyState {
    src_dir: PathBuf,
    http_client: Client,
}

pub fn start_proxy_server(src_dir: PathBuf) -> u16 {
    let http_client = Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36")
        .build()
        .unwrap_or_default();

    let state = ProxyState {
        src_dir,
        http_client,
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .fallback(any(proxy_handler))
        .layer(cors)
        .with_state(std::sync::Arc::new(state));

    // Bind to port 0 to get a random available port
    let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
    let listener = rt.block_on(async {
        TcpListener::bind("127.0.0.1:0").await.expect("Failed to bind port")
    });
    let port = listener.local_addr().unwrap().port();

    // Spawn the server in a background thread
    std::thread::spawn(move || {
        rt.block_on(async {
            axum::serve(listener, app).await.expect("Proxy server error");
        });
    });

    port
}

async fn proxy_handler(State(state): State<std::sync::Arc<ProxyState>>, req: Request<Body>) -> impl IntoResponse {
    let path = req.uri().path().to_string();

    // Handle extract-text API
    if path.starts_with("/api/gd/extract-text/") {
        return handle_extract_text(&state, &path, &req).await;
    }

    // Handle GD API proxy
    if path.starts_with("/api/gd/") {
        return handle_gd_proxy(&state, &path).await;
    }

    // Serve static files
    handle_static_file(&state, &path).await
}

async fn handle_gd_proxy(state: &ProxyState, path: &str) -> Response<Body> {
    let gd_path = path.replace("/api/gd", "");
    let target_url = format!("{}{}", GD_API_BASE, gd_path);

    let is_doc_content = gd_path.contains("/doc-content/");

    let mut request = state.http_client.get(&target_url)
        .header("user-type", "external")
        .header("Referer", "https://globaldossier.uspto.gov/")
        .header("Origin", "https://globaldossier.uspto.gov");

    if is_doc_content {
        request = request.header("Accept", "application/pdf,*/*");
    } else {
        request = request.header("Accept", "application/json, text/plain, */*");
    }

    match request.send().await {
        Ok(resp) => {
            let status = resp.status();
            let bytes = match resp.bytes().await {
                Ok(b) => b,
                Err(e) => {
                    return json_error(502, &format!("Failed to read response: {}", e));
                }
            };

            if is_doc_content {
                let is_pdf = bytes.len() > 100 && bytes.len() > 1 && bytes[0] == 0x25 && bytes[1] == 0x50;
                let is_not_found = bytes.len() < 100 && String::from_utf8_lossy(&bytes).contains("Attachment Not Found");

                let content_type = if is_not_found {
                    "text/plain"
                } else if is_pdf {
                    "application/pdf"
                } else {
                    "application/octet-stream"
                };

                let mut response = Response::builder()
                    .status(status)
                    .header(header::CONTENT_TYPE, content_type)
                    .header("Access-Control-Allow-Origin", "*");

                if is_not_found {
                    response = response.header("X-Attachment-Not-Found", "true");
                } else if is_pdf {
                    response = response.header("Content-Disposition", "attachment; filename=\"document.pdf\"");
                }

                response.body(Body::from(bytes.to_vec())).unwrap_or_else(|_| {
                    json_error(500, "Failed to build response")
                })
            } else {
                Response::builder()
                    .status(status)
                    .header(header::CONTENT_TYPE, "application/json")
                    .header("Access-Control-Allow-Origin", "*")
                    .body(Body::from(bytes.to_vec()))
                    .unwrap_or_else(|_| json_error(500, "Failed to build response"))
            }
        }
        Err(e) => json_error(502, &format!("Proxy request failed: {}", e)),
    }
}

async fn handle_extract_text(state: &ProxyState, path: &str, _req: &Request<Body>) -> Response<Body> {
    // Parse query params
    let gd_path = path.replace("/api/gd/extract-text", "");
    let query_string = _req.uri().query().unwrap_or("");
    let params: std::collections::HashMap<String, String> = url::form_urlencoded::parse(query_string.as_bytes())
        .into_owned()
        .collect();

    let engine = params.get("engine").map(|s| s.as_str()).unwrap_or("auto");
    let api_key = params.get("api_key").map(|s| s.as_str()).unwrap_or("");

    let gd_url = format!("{}/doc-content/svc/doccontent{}", GD_API_BASE, gd_path);

    // Download PDF
    let pdf_result = state.http_client.get(&gd_url)
        .header("user-type", "external")
        .header("Referer", "https://globaldossier.uspto.gov/")
        .header("Origin", "https://globaldossier.uspto.gov")
        .header("Accept", "application/pdf,*/*")
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await;

    let pdf_bytes = match pdf_result {
        Ok(resp) => {
            let status = resp.status();
            if !status.is_success() {
                return json_ok(&serde_json::json!({
                    "text": "",
                    "markdown": "",
                    "engine": "none",
                    "error": format!("PDF 下载失败: HTTP {}", status)
                }));
            }
            match resp.bytes().await {
                Ok(b) => b,
                Err(e) => {
                    return json_ok(&serde_json::json!({
                        "text": "",
                        "markdown": "",
                        "engine": "none",
                        "error": format!("PDF 读取失败: {}", e)
                    }));
                }
            }
        }
        Err(e) => {
            return json_ok(&serde_json::json!({
                "text": "",
                "markdown": "",
                "engine": "none",
                "error": format!("PDF 下载失败: {}", e)
            }));
        }
    };

    if pdf_bytes.len() < 100 {
        return json_ok(&serde_json::json!({
            "text": "",
            "markdown": "",
            "engine": "none",
            "error": "下载的文件过小，文档可能暂不可用"
        }));
    }

    let pdf_base64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &pdf_bytes,
    );

    // Use OCR client from our existing module
    let ocr_client = crate::ocr::OcrClient::new();
    let result = ocr_client.extract(&pdf_base64, engine, api_key).await;

    match serde_json::to_value(&result) {
        Ok(val) => json_ok(&val),
        Err(e) => json_ok(&serde_json::json!({
            "text": "",
            "markdown": "",
            "engine": "none",
            "error": format!("序列化结果失败: {}", e)
        })),
    }
}

async fn handle_static_file(state: &ProxyState, path: &str) -> Response<Body> {
    let file_path = if path == "/" {
        "index.html"
    } else {
        path.trim_start_matches('/')
    };

    let full_path = state.src_dir.join(file_path);

    // Security: prevent directory traversal
    if !full_path.starts_with(&state.src_dir) {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("Not Found"))
            .unwrap();
    }

    match tokio::fs::read(&full_path).await {
        Ok(data) => {
            let content_type = match full_path.extension().and_then(|e| e.to_str()) {
                Some("html") => "text/html; charset=utf-8",
                Some("css") => "text/css; charset=utf-8",
                Some("js") => "application/javascript; charset=utf-8",
                Some("json") => "application/json; charset=utf-8",
                Some("png") => "image/png",
                Some("ico") => "image/x-icon",
                Some("svg") => "image/svg+xml",
                Some("woff2") => "font/woff2",
                Some("woff") => "font/woff",
                Some("ttf") => "font/ttf",
                _ => "application/octet-stream",
            };

            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, content_type)
                .body(Body::from(data))
                .unwrap()
        }
        Err(_) => Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("Not Found"))
            .unwrap(),
    }
}

fn json_error(status: u16, message: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header("Access-Control-Allow-Origin", "*")
        .body(Body::from(
            serde_json::json!({ "error": message }).to_string(),
        ))
        .unwrap()
}

fn json_ok(data: &serde_json::Value) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header("Access-Control-Allow-Origin", "*")
        .body(Body::from(data.to_string()))
        .unwrap()
}
