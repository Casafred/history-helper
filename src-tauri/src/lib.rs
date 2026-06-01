mod api;
mod cache;
#[allow(dead_code)]
mod models;
mod patent;

use api::global_dossier::GlobalDossierClient;
use cache::{CacheStore, DB_FILENAME, DEFAULT_TTL_SECS};
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
) -> Result<CommandResult, String> {
    let pn = match parse_patent_number(&input) {
        Ok(pn) => pn,
        Err(e) => return Ok(CommandResult::err(e.to_string())),
    };

    let office = pn.office.to_string();
    let doc_num = pn.application_number.unwrap_or_else(|| input.clone());

    let client = GlobalDossierClient::new();
    match client.get_family("application", &office, &doc_num).await {
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
        let result = fetch_patent(input, state.clone()).await?;
        results.push(result);
    }
    Ok(results)
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
