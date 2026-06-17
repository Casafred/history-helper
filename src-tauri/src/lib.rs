mod api;
mod cache;
#[allow(dead_code)]
mod models;
mod ocr;
mod patent;

use api::global_dossier::GlobalDossierClient;
use cache::{CacheStore, DB_FILENAME, DEFAULT_TTL_SECS};
use ocr::OcrClient;
use patent::converter::{detect_office, parse_patent_number};
use serde::Serialize;
use std::sync::Mutex;
use tauri::Manager;

struct AppState {
    cache: Mutex<Option<CacheStore>>,
}

#[derive(Serialize, Clone)]
struct CommandResult {
    success: bool,
    data: Option<serde_json::Value>,
    error: Option<String>,
}

impl CommandResult {
    fn ok(data: serde_json::Value) -> Self {
        CommandResult {
            success: true,
            data: Some(data),
            error: None,
        }
    }

    fn err(msg: impl Into<String>) -> Self {
        CommandResult {
            success: false,
            data: None,
            error: Some(msg.into()),
        }
    }
}

#[tauri::command]
async fn convert_patent_number(input: String) -> Result<CommandResult, String> {
    Ok(match parse_patent_number(&input) {
        Ok(pn) => CommandResult::ok(serde_json::to_value(pn).unwrap_or_default()),
        Err(e) => CommandResult::err(e.to_string()),
    })
}

#[tauri::command]
async fn detect_patent_office(input: String) -> Result<CommandResult, String> {
    Ok(match detect_office(&input) {
        Some(office) => CommandResult::ok(serde_json::Value::String(office.to_string())),
        None => CommandResult::err(format!("无法识别专利号格式: {}", input)),
    })
}

#[tauri::command]
async fn fetch_patent(
    input: String,
    query_type: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<CommandResult, String> {
    let pn = match parse_patent_number(&input) {
        Ok(pn) => pn,
        Err(e) => return Ok(CommandResult::err(e.to_string())),
    };

    let office = pn.office.to_string();
    let doc_num = pn.application_number.unwrap_or_else(|| input.clone());
    let qtype = query_type.unwrap_or_else(|| "application".to_string());

    let cache_key = CacheStore::make_cache_key(&office, &doc_num, "patent_data");

    {
        let mut cache_guard = state
            .cache
            .lock()
            .map_err(|e| format!("Cache lock error: {}", e))?;

        if let Some(ref mut cache_store) = *cache_guard {
            if let Some(cached_data) = cache_store.get(&cache_key) {
                if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&cached_data) {
                    if let Some(obj) = val.as_object_mut() {
                        obj.insert("cached".into(), serde_json::Value::Bool(true));
                    }
                    return Ok(CommandResult::ok(val));
                }
            }
        }
    }

    let client = GlobalDossierClient::new();
    let mut result = serde_json::Map::new();
    result.insert("office".into(), serde_json::Value::String(office.clone()));
    result.insert("applicationNumber".into(), serde_json::Value::String(doc_num.clone()));
    result.insert("queryType".into(), serde_json::Value::String(qtype.clone()));
    let mut warnings: Vec<String> = Vec::new();

    match client.get_family(&qtype, &office, &doc_num).await {
        Ok(data) => {
            result.insert("family".into(), data);
        }
        Err(e) => {
            let msg = format!("同族查询失败: {}", e);
            log::warn!("{}", msg);
            warnings.push(msg);
        }
    }

    match client.get_doc_list(&office, &doc_num, "A").await {
        Ok(data) => {
            result.insert("documents".into(), data);
        }
        Err(e) => {
            let msg = format!("文档列表查询失败: {}", e);
            log::warn!("{}", msg);
            warnings.push(msg);
        }
    }

    if !warnings.is_empty() {
        result.insert(
            "warnings".into(),
            serde_json::Value::Array(
                warnings.into_iter().map(serde_json::Value::String).collect(),
            ),
        );
    }

    let result_val = serde_json::Value::Object(result);

    {
        let mut cache_guard = state
            .cache
            .lock()
            .map_err(|e| format!("Cache lock error: {}", e))?;

        if let Some(ref mut cache_store) = *cache_guard {
            if let Ok(serialized) = serde_json::to_string(&result_val) {
                cache_store.set(&cache_key, &office, &doc_num, "patent_data", &serialized, DEFAULT_TTL_SECS);
            }
        }
    }

    Ok(CommandResult::ok(result_val))
}

#[tauri::command]
async fn fetch_family(
    input: String,
    query_type: Option<String>,
) -> Result<CommandResult, String> {
    let pn = match parse_patent_number(&input) {
        Ok(pn) => pn,
        Err(e) => return Ok(CommandResult::err(e.to_string())),
    };

    let office = pn.office.to_string();
    let doc_num = pn.application_number.unwrap_or_else(|| input.clone());
    let qtype = query_type.unwrap_or_else(|| "application".to_string());

    let client = GlobalDossierClient::new();
    match client.get_family(&qtype, &office, &doc_num).await {
        Ok(data) => Ok(CommandResult::ok(data)),
        Err(e) => Ok(CommandResult::err(e.to_string())),
    }
}

#[tauri::command]
async fn fetch_documents(
    input: String,
) -> Result<CommandResult, String> {
    let pn = match parse_patent_number(&input) {
        Ok(pn) => pn,
        Err(e) => return Ok(CommandResult::err(e.to_string())),
    };

    let office = pn.office.to_string();
    let doc_num = pn.application_number.unwrap_or_else(|| input.clone());

    let client = GlobalDossierClient::new();
    match client.get_doc_list(&office, &doc_num, "A").await {
        Ok(data) => Ok(CommandResult::ok(data)),
        Err(e) => Ok(CommandResult::err(e.to_string())),
    }
}

#[tauri::command]
async fn download_document(
    country: String,
    doc_number: String,
    doc_id: String,
    pages: String,
    format: String,
) -> Result<CommandResult, String> {
    let client = GlobalDossierClient::new();
    match client.get_document(&country, &doc_number, &doc_id, &pages, &format).await {
        Ok(data) => {
            let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &data);
            Ok(CommandResult::ok(serde_json::json!({
                "data": encoded,
                "size": data.len(),
            })))
        }
        Err(e) => Ok(CommandResult::err(e.to_string())),
    }
}

#[tauri::command]
async fn batch_fetch_patents(
    inputs: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<CommandResult>, String> {
    let mut results = Vec::with_capacity(inputs.len());
    for input in inputs {
        let result = fetch_patent(input, None, state.clone()).await?;
        results.push(result);
    }
    Ok(results)
}

#[tauri::command]
async fn extract_text(
    country: String,
    doc_number: String,
    doc_id: String,
    pages: String,
    format: String,
    engine: String,
    api_key: String,
) -> Result<CommandResult, String> {
    let client = GlobalDossierClient::new();
    let pdf_bytes = match client
        .get_document(&country, &doc_number, &doc_id, &pages, &format)
        .await
    {
        Ok(data) => data,
        Err(e) => return Ok(CommandResult::err(e.to_string())),
    };

    if pdf_bytes.len() < 100 {
        return Ok(CommandResult::err("下载的文件过小，文档可能暂不可用"));
    }

    let pdf_base64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &pdf_bytes,
    );

    let ocr_client = OcrClient::new();
    let result = ocr_client.extract(&pdf_base64, &engine, &api_key).await;

    match serde_json::to_value(&result) {
        Ok(val) => Ok(CommandResult::ok(val)),
        Err(e) => Ok(CommandResult::err(format!("序列化结果失败: {}", e))),
    }
}

#[tauri::command]
async fn jpo_status() -> Result<CommandResult, String> {
    let configured = api::jpo::JpoClient::is_configured();
    Ok(CommandResult::ok(serde_json::json!({
        "configured": configured,
        "office": "JP",
        "source": "JPO API (ip-data.jpo.go.jp)"
    })))
}

#[tauri::command]
async fn jpo_fetch_progress(app_number: String) -> Result<CommandResult, String> {
    let client = match api::jpo::JpoClient::new() {
        Ok(c) => c,
        Err(e) => return Ok(CommandResult::err(format!("JPO API 未配置: {}", e))),
    };
    match client.get_progress(&app_number).await {
        Ok(data) => Ok(CommandResult::ok(serde_json::to_value(data).unwrap_or_default())),
        Err(e) => Ok(CommandResult::err(format!("JPO 审查经纬查询失败: {}", e))),
    }
}

#[tauri::command]
async fn jpo_fetch_doc(app_number: String, doc_type: String) -> Result<CommandResult, String> {
    let client = match api::jpo::JpoClient::new() {
        Ok(c) => c,
        Err(e) => return Ok(CommandResult::err(format!("JPO API 未配置: {}", e))),
    };

    let zip_bytes = match doc_type.as_str() {
        "refusal_reason" => client.get_refusal_reason_doc(&app_number).await,
        "dispatch" => client.get_dispatch_doc(&app_number).await,
        "submission" => client.get_submission_doc(&app_number).await,
        "trial" => client.get_trial_doc(&app_number).await,
        _ => return Ok(CommandResult::err(format!("未知的文档类型: {}", doc_type))),
    };

    match zip_bytes {
        Ok(bytes) => {
            match api::jpo::JpoClient::extract_text_from_zip(&bytes) {
                Ok(docs) => {
                    let contents: Vec<serde_json::Value> = docs.iter().map(|d| {
                        serde_json::json!({
                            "filename": d.filename,
                            "content": d.content,
                            "docType": format!("{:?}", d.doc_type),
                        })
                    }).collect();
                    Ok(CommandResult::ok(serde_json::json!({
                        "office": "JP",
                        "appNumber": app_number,
                        "docType": doc_type,
                        "documents": contents,
                        "rawSize": bytes.len(),
                    })))
                }
                Err(_) => {
                    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
                    Ok(CommandResult::ok(serde_json::json!({
                        "office": "JP",
                        "appNumber": app_number,
                        "docType": doc_type,
                        "rawData": encoded,
                        "rawSize": bytes.len(),
                        "format": "zip",
                    })))
                }
            }
        }
        Err(e) => Ok(CommandResult::err(format!("JPO 文档下载失败: {}", e))),
    }
}

#[tauri::command]
async fn dpma_status() -> Result<CommandResult, String> {
    Ok(CommandResult::ok(serde_json::json!({
        "configured": true,
        "office": "DE",
        "source": "DPMAregister (register.dpma.de)",
        "note": "注册信息查询可用，案卷查阅(Akteneinsicht)需CAPTCHA无法程序化获取"
    })))
}

#[tauri::command]
async fn dpma_register_info(number: String) -> Result<CommandResult, String> {
    let client = api::dpma::DpmaClient::new();
    match client.get_register_info(&number).await {
        Ok(info) => Ok(CommandResult::ok(serde_json::to_value(&info).unwrap_or_default())),
        Err(e) => Ok(CommandResult::err(format!("DPMA 注册信息查询失败: {}", e))),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Ok(path) = std::env::current_exe() {
        if let Some(dir) = path.parent() {
            let env_path = dir.join(".env");
            if env_path.exists() {
                let _ = dotenv::from_path(&env_path);
            }
        }
    }
    dotenv::dotenv().ok();

    tauri::Builder::default()
        .manage(AppState {
            cache: Mutex::new(None),
        })
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            let db_path = app_data_dir.join(DB_FILENAME);
            match CacheStore::new(&db_path) {
                Ok(cache_store) => {
                    let state = app.state::<AppState>();
                    let mut guard = state.cache.lock().unwrap_or_else(|e: std::sync::PoisonError<_>| e.into_inner());
                    *guard = Some(cache_store);
                }
                Err(e) => {
                    log::error!("Failed to initialize cache: {}", e);
                }
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            convert_patent_number,
            detect_patent_office,
            fetch_patent,
            fetch_family,
            fetch_documents,
            download_document,
            batch_fetch_patents,
            extract_text,
            jpo_status,
            jpo_fetch_progress,
            jpo_fetch_doc,
            dpma_status,
            dpma_register_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
