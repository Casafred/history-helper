use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, Response, StatusCode},
    Router,
};
use reqwest::Client;
use tower_http::cors::{Any, CorsLayer};

use crate::api::dpma::DpmaClient;
use crate::api::jpo::JpoClient;

const GD_API_BASE: &str = "https://d1kazzu6rbodne.cloudfront.net";

#[derive(Clone)]
struct ProxyState {
    http_client: Client,
    jpo_client: Option<JpoClient>,
    dpma_client: DpmaClient,
}

/// Start the API proxy server on a random port. Returns the port number.
pub fn start_api_proxy() -> u16 {
    let http_client = Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36")
        .build()
        .unwrap_or_default();

    // Initialize JPO client if credentials are available
    let jpo_client = if JpoClient::is_configured() {
        match JpoClient::new() {
            Ok(client) => {
                log::info!("[Proxy] JPO API client initialized successfully");
                Some(client)
            }
            Err(e) => {
                log::warn!("[Proxy] JPO API client init failed: {}", e);
                None
            }
        }
    } else {
        log::info!("[Proxy] JPO API credentials not configured, JP document access disabled");
        None
    };

    let dpma_client = DpmaClient::new();

    let state = ProxyState {
        http_client,
        jpo_client,
        dpma_client,
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        // Global Dossier API proxy (existing)
        .route("/api/gd/{*path}", axum::routing::any(api_handler))
        // JPO API routes (JP-specific)
        .route("/api/jpo/progress/{app_number}", axum::routing::get(jpo_progress_handler))
        .route("/api/jpo/doc/refusal-reason/{app_number}", axum::routing::get(jpo_refusal_reason_handler))
        .route("/api/jpo/doc/dispatch/{app_number}", axum::routing::get(jpo_dispatch_handler))
        .route("/api/jpo/doc/submission/{app_number}", axum::routing::get(jpo_submission_handler))
        .route("/api/jpo/doc/trial/{app_number}", axum::routing::get(jpo_trial_handler))
        .route("/api/jpo/status", axum::routing::get(jpo_status_handler))
        // DPMA routes (DE-specific)
        .route("/api/de/file-inspection/{file_number}", axum::routing::get(de_file_inspection_handler))
        .route("/api/de/download/{*path}", axum::routing::get(de_download_handler))
        .route("/api/de/status", axum::routing::get(de_status_handler))
        .layer(cors)
        .with_state(state);

    // Bind synchronously using std::net - no tokio needed at this point
    let std_listener = match std::net::TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[Tauri] Failed to bind port: {}", e);
            return 0;
        }
    };
    let port = std_listener.local_addr().map(|a| a.port()).unwrap_or(0);
    // Set non-blocking before converting to tokio listener
    if let Err(e) = std_listener.set_nonblocking(true) {
        eprintln!("[Tauri] Failed to set nonblocking: {}", e);
        return port;
    }

    std::thread::spawn(move || {
        let rt = match tokio::runtime::Runtime::new() {
            Ok(rt) => rt,
            Err(e) => {
                eprintln!("[Tauri] Failed to create tokio runtime: {}", e);
                return;
            }
        };
        rt.block_on(async {
            let listener = match tokio::net::TcpListener::from_std(std_listener) {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("[Tauri] Failed to convert std listener to tokio listener: {}", e);
                    return;
                }
            };
            if let Err(e) = axum::serve(listener, app).await {
                eprintln!("[Tauri] API proxy server error: {}", e);
            }
        });
    });

    port
}

type QueryParams = std::collections::HashMap<String, String>;

// ─── Global Dossier API Handler (existing) ──────────────────────────

async fn api_handler(
    State(state): State<ProxyState>,
    Path(path): Path<String>,
    Query(params): Query<QueryParams>,
) -> Response<Body> {
    let full_path = format!("/api/gd/{}", path);

    // Handle extract-text API
    if full_path.starts_with("/api/gd/extract-text/") {
        return handle_extract_text(&state, &full_path, &params).await;
    }

    // Handle GD API proxy
    handle_gd_proxy(&state, &full_path).await
}

async fn handle_gd_proxy(state: &ProxyState, path: &str) -> Response<Body> {
    let gd_path = path.replace("/api/gd", "");
    let target_url = format!("{}{}", GD_API_BASE, gd_path);

    let is_doc_content = gd_path.contains("/doc-content/");

    let mut request = state
        .http_client
        .get(&target_url)
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
                let is_pdf = bytes.len() > 2 && bytes[0] == 0x25 && bytes[1] == 0x50;
                let is_not_found = bytes.len() < 100
                    && String::from_utf8_lossy(&bytes).contains("Attachment Not Found");

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
                    response =
                        response.header("Content-Disposition", "attachment; filename=\"document.pdf\"");
                }

                response
                    .body(Body::from(bytes.to_vec()))
                    .unwrap_or_else(|_| json_error(500, "Failed to build response"))
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

async fn handle_extract_text(
    state: &ProxyState,
    path: &str,
    params: &QueryParams,
) -> Response<Body> {
    let gd_path = path.replace("/api/gd/extract-text", "");

    let engine = params.get("engine").map(|s| s.as_str()).unwrap_or("auto");
    let api_key = params.get("api_key").map(|s| s.as_str()).unwrap_or("");

    let gd_url = format!(
        "{}/doc-content/svc/doccontent{}",
        GD_API_BASE, gd_path
    );

    let pdf_result = state
        .http_client
        .get(&gd_url)
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

    let pdf_base64 =
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &pdf_bytes);

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

// ─── JPO API Handlers (JP-specific) ─────────────────────────────────

/// GET /api/jpo/status - Check if JPO API is configured
async fn jpo_status_handler(State(state): State<ProxyState>) -> Response<Body> {
    let configured = state.jpo_client.is_some();
    json_ok(&serde_json::json!({
        "configured": configured,
        "office": "JP",
        "source": "JPO API (ip-data.jpo.go.jp)"
    }))
}

/// GET /api/jpo/progress/{app_number} - Get examination progress
async fn jpo_progress_handler(
    State(state): State<ProxyState>,
    Path(app_number): Path<String>,
) -> Response<Body> {
    let jpo = match &state.jpo_client {
        Some(client) => client,
        None => return json_error(503, "JPO API 未配置。请在 .env 文件中设置 JPO_API_USERNAME 和 JPO_API_PASSWORD"),
    };

    match jpo.get_progress(&app_number).await {
        Ok(data) => json_ok(&serde_json::to_value(data).unwrap_or_default()),
        Err(e) => json_error(502, &format!("JPO API 请求失败: {}", e)),
    }
}

/// GET /api/jpo/doc/refusal-reason/{app_number} - Download refusal reason document
async fn jpo_refusal_reason_handler(
    State(state): State<ProxyState>,
    Path(app_number): Path<String>,
) -> Response<Body> {
    let jpo = match &state.jpo_client {
        Some(client) => client,
        None => return json_error(503, "JPO API 未配置"),
    };

    match jpo.get_refusal_reason_doc(&app_number).await {
        Ok(zip_bytes) => {
            // Try to extract text from ZIP, fallback to returning raw ZIP
            match JpoClient::extract_text_from_zip(&zip_bytes) {
                Ok(docs) => {
                    let contents: Vec<serde_json::Value> = docs.iter().map(|d| {
                        serde_json::json!({
                            "filename": d.filename,
                            "content": d.content,
                            "docType": format!("{:?}", d.doc_type),
                        })
                    }).collect();
                    json_ok(&serde_json::json!({
                        "office": "JP",
                        "appNumber": app_number,
                        "docType": "refusal_reason",
                        "documents": contents,
                        "rawSize": zip_bytes.len(),
                    }))
                }
                Err(_) => {
                    // Return raw ZIP as binary if text extraction fails
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, "application/zip")
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Content-Disposition", &format!("attachment; filename=\"jp_refusal_reason_{}.zip\"", app_number))
                        .body(Body::from(zip_bytes))
                        .unwrap_or_else(|_| json_error(500, "Failed to build response"))
                }
            }
        }
        Err(e) => json_error(502, &format!("JPO 拒絶理由通知書下载失败: {}", e)),
    }
}

/// GET /api/jpo/doc/dispatch/{app_number} - Download dispatched documents
async fn jpo_dispatch_handler(
    State(state): State<ProxyState>,
    Path(app_number): Path<String>,
) -> Response<Body> {
    let jpo = match &state.jpo_client {
        Some(client) => client,
        None => return json_error(503, "JPO API 未配置"),
    };

    match jpo.get_dispatch_doc(&app_number).await {
        Ok(zip_bytes) => {
            match JpoClient::extract_text_from_zip(&zip_bytes) {
                Ok(docs) => {
                    let contents: Vec<serde_json::Value> = docs.iter().map(|d| {
                        serde_json::json!({
                            "filename": d.filename,
                            "content": d.content,
                            "docType": format!("{:?}", d.doc_type),
                        })
                    }).collect();
                    json_ok(&serde_json::json!({
                        "office": "JP",
                        "appNumber": app_number,
                        "docType": "dispatch",
                        "documents": contents,
                        "rawSize": zip_bytes.len(),
                    }))
                }
                Err(_) => {
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, "application/zip")
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Content-Disposition", &format!("attachment; filename=\"jp_dispatch_{}.zip\"", app_number))
                        .body(Body::from(zip_bytes))
                        .unwrap_or_else(|_| json_error(500, "Failed to build response"))
                }
            }
        }
        Err(e) => json_error(502, &format!("JPO 発送書類下载失败: {}", e)),
    }
}

/// GET /api/jpo/doc/submission/{app_number} - Download submitted documents
async fn jpo_submission_handler(
    State(state): State<ProxyState>,
    Path(app_number): Path<String>,
) -> Response<Body> {
    let jpo = match &state.jpo_client {
        Some(client) => client,
        None => return json_error(503, "JPO API 未配置"),
    };

    match jpo.get_submission_doc(&app_number).await {
        Ok(zip_bytes) => {
            match JpoClient::extract_text_from_zip(&zip_bytes) {
                Ok(docs) => {
                    let contents: Vec<serde_json::Value> = docs.iter().map(|d| {
                        serde_json::json!({
                            "filename": d.filename,
                            "content": d.content,
                            "docType": format!("{:?}", d.doc_type),
                        })
                    }).collect();
                    json_ok(&serde_json::json!({
                        "office": "JP",
                        "appNumber": app_number,
                        "docType": "submission",
                        "documents": contents,
                        "rawSize": zip_bytes.len(),
                    }))
                }
                Err(_) => {
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, "application/zip")
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Content-Disposition", &format!("attachment; filename=\"jp_submission_{}.zip\"", app_number))
                        .body(Body::from(zip_bytes))
                        .unwrap_or_else(|_| json_error(500, "Failed to build response"))
                }
            }
        }
        Err(e) => json_error(502, &format!("JPO 提出書類下载失败: {}", e)),
    }
}

/// GET /api/jpo/doc/trial/{app_number} - Download trial documents
async fn jpo_trial_handler(
    State(state): State<ProxyState>,
    Path(app_number): Path<String>,
) -> Response<Body> {
    let jpo = match &state.jpo_client {
        Some(client) => client,
        None => return json_error(503, "JPO API 未配置"),
    };

    match jpo.get_trial_doc(&app_number).await {
        Ok(zip_bytes) => {
            match JpoClient::extract_text_from_zip(&zip_bytes) {
                Ok(docs) => {
                    let contents: Vec<serde_json::Value> = docs.iter().map(|d| {
                        serde_json::json!({
                            "filename": d.filename,
                            "content": d.content,
                            "docType": format!("{:?}", d.doc_type),
                        })
                    }).collect();
                    json_ok(&serde_json::json!({
                        "office": "JP",
                        "appNumber": app_number,
                        "docType": "trial",
                        "documents": contents,
                        "rawSize": zip_bytes.len(),
                    }))
                }
                Err(_) => {
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, "application/zip")
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Content-Disposition", &format!("attachment; filename=\"jp_trial_{}.zip\"", app_number))
                        .body(Body::from(zip_bytes))
                        .unwrap_or_else(|_| json_error(500, "Failed to build response"))
                }
            }
        }
        Err(e) => json_error(502, &format!("JPO 審判書類下载失败: {}", e)),
    }
}

// ─── DPMA Handlers (DE-specific) ─────────────────────────────────────

/// GET /api/de/status - Check if DPMA access is available
async fn de_status_handler() -> Response<Body> {
    json_ok(&serde_json::json!({
        "configured": true,
        "office": "DE",
        "source": "DPMAregister (register.dpma.de)"
    }))
}

/// GET /api/de/file-inspection/{file_number} - Get file inspection documents
async fn de_file_inspection_handler(
    State(state): State<ProxyState>,
    Path(file_number): Path<String>,
) -> Response<Body> {
    match state.dpma_client.get_file_inspection(&file_number).await {
        Ok(inspection) => {
            json_ok(&serde_json::to_value(&inspection).unwrap_or_default())
        }
        Err(e) => json_error(502, &format!("DPMA 案卷查阅失败: {}", e)),
    }
}

/// GET /api/de/download/{*path} - Download a specific document from DPMAregister
async fn de_download_handler(
    State(state): State<ProxyState>,
    Path(path): Path<String>,
) -> Response<Body> {
    // Reconstruct the full URL from the path
    let doc_url = if path.starts_with("http") {
        path
    } else {
        format!("https://register.dpma.de/{}", path)
    };

    match state.dpma_client.download_document(&doc_url).await {
        Ok(pdf_bytes) => {
            let is_pdf = pdf_bytes.len() > 2 && pdf_bytes[0] == 0x25 && pdf_bytes[1] == 0x50;
            let content_type = if is_pdf { "application/pdf" } else { "application/octet-stream" };

            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, content_type)
                .header("Access-Control-Allow-Origin", "*")
                .header("Content-Disposition", "attachment; filename=\"de_document.pdf\"")
                .body(Body::from(pdf_bytes))
                .unwrap_or_else(|_| json_error(500, "Failed to build response"))
        }
        Err(e) => json_error(502, &format!("DPMA 文档下载失败: {}", e)),
    }
}

// ─── Utility ──────────────────────────────────────────────────────────

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
