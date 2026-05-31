mod api;
mod cache;
#[allow(dead_code)]
mod models;
mod parser;
mod patent;

use api::global_dossier::GlobalDossierClient;
use api::uspto::UsptoClient;
use cache::{CacheStore, DB_FILENAME, DEFAULT_TTL_SECS};
use patent::converter::{detect_office, normalize_us_application_number, parse_patent_number, PatentOffice};
use parser::office_action::{EventCategory, OfficeActionType};
use serde::Serialize;
use std::sync::Mutex;
use tauri::Manager;

struct AppState {
    uspto_client: Mutex<Option<UsptoClient>>,
    gd_token: Mutex<Option<String>>,
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

fn get_or_create_client(state: &AppState) -> Result<UsptoClient, String> {
    let mut guard = state
        .uspto_client
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;

    if guard.is_none() {
        let client = UsptoClient::new().map_err(|e| e.to_string())?;
        *guard = Some(client);
    }

    guard
        .clone()
        .ok_or_else(|| "Failed to create API client".to_string())
}

fn get_gd_client(state: &AppState) -> Result<GlobalDossierClient, String> {
    let guard = state
        .gd_token
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;

    guard
        .as_ref()
        .map(|t| GlobalDossierClient::new(t.clone()))
        .ok_or_else(|| "Global Dossier token not set. Call set_gd_token first.".to_string())
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
        None => CommandResult::err(format!("Unrecognized patent number format: {}", input)),
    })
}

#[tauri::command]
async fn fetch_examination_history(
    app_number: String,
    state: tauri::State<'_, AppState>,
) -> Result<CommandResult, String> {
    let mut warnings: Vec<String> = Vec::new();

    let office = detect_office(&app_number);
    match office {
        Some(PatentOffice::US) => {}
        Some(other) => {
            if other.supports_examination_history() {
                let gd_client = match get_gd_client(&state) {
                    Ok(c) => c,
                    Err(_) => {
                        return Ok(CommandResult::err(format!(
                            "查询 {} 专利需要先登录 Global Dossier（点击「GD 登录」按钮）",
                            other.display_name()
                        )));
                    }
                };

                let normalized = match other {
                    PatentOffice::EP => patent::converter::normalize_ep_application_number(&app_number)
                        .map_err(|e| e.to_string())
                        .ok(),
                    PatentOffice::WO => patent::converter::normalize_wo_application_number(&app_number)
                        .map_err(|e| e.to_string())
                        .ok(),
                    _ => Some(app_number.clone()),
                };

                let doc_num = match normalized {
                    Some(n) => n,
                    None => app_number.clone(),
                };

                let office_code = other.to_string();
                let mut result = serde_json::Map::new();
                result.insert("applicationNumber".into(), serde_json::Value::String(doc_num.clone()));
                result.insert("office".into(), serde_json::Value::String(office_code.clone()));

                match gd_client.get_family("application", &office_code, &doc_num).await {
                    Ok(data) => {
                        result.insert("family".into(), data);
                    }
                    Err(e) => {
                        warnings.push(format!("同族查询失败: {}", e));
                    }
                }

                match gd_client.get_doc_list(&office_code, &doc_num, "A").await {
                    Ok(data) => {
                        result.insert("documents".into(), data);
                    }
                    Err(e) => {
                        warnings.push(format!("文档列表查询失败: {}", e));
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

                return Ok(CommandResult::ok(serde_json::Value::Object(result)));
            } else {
                if let Some(msg) = other.api_unavailable_message() {
                    return Ok(CommandResult::err(msg));
                }
                return Ok(CommandResult::err(format!(
                    "暂不支持 {} 专利局的审查历史查询",
                    other.display_name()
                )));
            }
        }
        None => {
            return Ok(CommandResult::err(format!(
                "无法识别专利号格式: {}，请输入有效的专利申请号",
                app_number
            )));
        }
    }

    let normalized = match normalize_us_application_number(&app_number) {
        Ok(n) => n,
        Err(e) => return Ok(CommandResult::err(e.to_string())),
    };

    let cache_key = CacheStore::make_cache_key("US", &normalized, "examination_history");

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

    let client = match get_or_create_client(&state) {
        Ok(c) => c,
        Err(e) => return Ok(CommandResult::err(e)),
    };

    let mut result = serde_json::Map::new();
    result.insert("applicationNumber".into(), serde_json::Value::String(normalized.clone()));

    match client.get_application(&normalized).await {
        Ok(data) => {
            result.insert("application".into(), serde_json::to_value(data).unwrap_or_default());
        }
        Err(e) => return Ok(CommandResult::err(e.to_string())),
    }

    match client.get_transactions(&normalized).await {
        Ok(data) => {
            let events = data
                .patent_file_wrapper_data_bag
                .and_then(|bag| bag.into_iter().next())
                .and_then(|wrapper| wrapper.event_data_bag);

            if let Some(ref event_list) = events {
                let categorized: Vec<serde_json::Value> = event_list
                    .iter()
                    .map(|e| {
                        let code = e.event_code.as_deref().unwrap_or("");
                        let category = EventCategory::from_event_code(code);
                        let mut map = serde_json::to_value(e).unwrap_or_default();
                        if let Some(obj) = map.as_object_mut() {
                            obj.insert(
                                "eventCategory".into(),
                                serde_json::Value::String(match category {
                                    EventCategory::OfficeAction => "office_action",
                                    EventCategory::ApplicantResponse => "applicant_response",
                                    EventCategory::FeePayment => "fee_payment",
                                    EventCategory::StatusChange => "status_change",
                                    EventCategory::Publication => "publication",
                                    EventCategory::Other => "other",
                                }.into()),
                            );
                        }
                        map
                    })
                    .collect();
                result.insert("events".into(), serde_json::Value::Array(categorized));
            }
        }
        Err(e) => {
            let msg = format!("审查事件查询失败: {}", e);
            log::warn!("{}", msg);
            warnings.push(msg);
        }
    }

    match client.get_documents(&normalized).await {
        Ok(data) => {
            let docs = data.document_bag.unwrap_or_default();
            let office_actions: Vec<serde_json::Value> = docs
                .iter()
                .filter(|d| {
                    matches!(
                        d.document_code.as_deref(),
                        Some("CTNF" | "CTF" | "CTFR" | "REST" | "NTCE" | "EX.Q" | "EX.R")
                    )
                })
                .map(|d| {
                    let code = d.document_code.as_deref().unwrap_or("");
                    let action_type = OfficeActionType::from_document_code(code);
                    let mut map = serde_json::to_value(d).unwrap_or_default();
                    if let Some(obj) = map.as_object_mut() {
                        obj.insert(
                            "officeActionType".into(),
                            serde_json::Value::String(action_type.display_name().into()),
                        );
                    }
                    map
                })
                .collect();
            result.insert("documents".into(), serde_json::to_value(docs).unwrap_or_default());
            result.insert("officeActions".into(), serde_json::Value::Array(office_actions));
        }
        Err(e) => {
            let msg = format!("审查文档查询失败: {}", e);
            log::warn!("{}", msg);
            warnings.push(msg);
        }
    }

    match client.get_continuity(&normalized).await {
        Ok(data) => {
            result.insert("continuity".into(), serde_json::to_value(data).unwrap_or_default());
        }
        Err(e) => {
            let msg = format!("续案信息查询失败: {}", e);
            log::warn!("{}", msg);
            warnings.push(msg);
        }
    }

    match client.get_foreign_priority(&normalized).await {
        Ok(data) => {
            result.insert(
                "foreignPriority".into(),
                serde_json::to_value(data).unwrap_or_default(),
            );
        }
        Err(e) => {
            let msg = format!("外国优先权查询失败: {}", e);
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
                cache_store.set(&cache_key, "US", &normalized, "examination_history", &serialized, DEFAULT_TTL_SECS);
            }
        }
    }

    Ok(CommandResult::ok(result_val))
}

#[tauri::command]
async fn fetch_application(app_number: String, state: tauri::State<'_, AppState>) -> Result<CommandResult, String> {
    let office = detect_office(&app_number);
    if !matches!(office, Some(PatentOffice::US)) {
        return Ok(CommandResult::err("暂不支持该专利号所属专利局的查询，请输入美国专利申请号"));
    }

    let client = match get_or_create_client(&state) {
        Ok(c) => c,
        Err(e) => return Ok(CommandResult::err(e)),
    };

    let normalized = match normalize_us_application_number(&app_number) {
        Ok(n) => n,
        Err(e) => return Ok(CommandResult::err(e.to_string())),
    };

    Ok(match client.get_application(&normalized).await {
        Ok(data) => CommandResult::ok(serde_json::to_value(data).unwrap_or_default()),
        Err(e) => CommandResult::err(e.to_string()),
    })
}

#[tauri::command]
async fn fetch_transactions(
    app_number: String,
    state: tauri::State<'_, AppState>,
) -> Result<CommandResult, String> {
    let office = detect_office(&app_number);
    if !matches!(office, Some(PatentOffice::US)) {
        return Ok(CommandResult::err("暂不支持该专利号所属专利局的查询"));
    }

    let client = match get_or_create_client(&state) {
        Ok(c) => c,
        Err(e) => return Ok(CommandResult::err(e)),
    };

    let normalized = match normalize_us_application_number(&app_number) {
        Ok(n) => n,
        Err(e) => return Ok(CommandResult::err(e.to_string())),
    };

    Ok(match client.get_transactions(&normalized).await {
        Ok(data) => CommandResult::ok(serde_json::to_value(data).unwrap_or_default()),
        Err(e) => CommandResult::err(e.to_string()),
    })
}

#[tauri::command]
async fn fetch_documents(
    app_number: String,
    state: tauri::State<'_, AppState>,
) -> Result<CommandResult, String> {
    let office = detect_office(&app_number);
    if !matches!(office, Some(PatentOffice::US)) {
        return Ok(CommandResult::err("暂不支持该专利号所属专利局的查询"));
    }

    let client = match get_or_create_client(&state) {
        Ok(c) => c,
        Err(e) => return Ok(CommandResult::err(e)),
    };

    let normalized = match normalize_us_application_number(&app_number) {
        Ok(n) => n,
        Err(e) => return Ok(CommandResult::err(e.to_string())),
    };

    Ok(match client.get_documents(&normalized).await {
        Ok(data) => CommandResult::ok(serde_json::to_value(data).unwrap_or_default()),
        Err(e) => CommandResult::err(e.to_string()),
    })
}

#[tauri::command]
async fn fetch_continuity(
    app_number: String,
    state: tauri::State<'_, AppState>,
) -> Result<CommandResult, String> {
    let office = detect_office(&app_number);
    if !matches!(office, Some(PatentOffice::US)) {
        return Ok(CommandResult::err("暂不支持该专利号所属专利局的查询"));
    }

    let client = match get_or_create_client(&state) {
        Ok(c) => c,
        Err(e) => return Ok(CommandResult::err(e)),
    };

    let normalized = match normalize_us_application_number(&app_number) {
        Ok(n) => n,
        Err(e) => return Ok(CommandResult::err(e.to_string())),
    };

    Ok(match client.get_continuity(&normalized).await {
        Ok(data) => CommandResult::ok(serde_json::to_value(data).unwrap_or_default()),
        Err(e) => CommandResult::err(e.to_string()),
    })
}

#[tauri::command]
async fn fetch_foreign_priority(
    app_number: String,
    state: tauri::State<'_, AppState>,
) -> Result<CommandResult, String> {
    let office = detect_office(&app_number);
    if !matches!(office, Some(PatentOffice::US)) {
        return Ok(CommandResult::err("暂不支持该专利号所属专利局的查询"));
    }

    let client = match get_or_create_client(&state) {
        Ok(c) => c,
        Err(e) => return Ok(CommandResult::err(e)),
    };

    let normalized = match normalize_us_application_number(&app_number) {
        Ok(n) => n,
        Err(e) => return Ok(CommandResult::err(e.to_string())),
    };

    Ok(match client.get_foreign_priority(&normalized).await {
        Ok(data) => CommandResult::ok(serde_json::to_value(data).unwrap_or_default()),
        Err(e) => CommandResult::err(e.to_string()),
    })
}

#[tauri::command]
async fn download_document(
    url: String,
    state: tauri::State<'_, AppState>,
) -> Result<CommandResult, String> {
    let client = match get_or_create_client(&state) {
        Ok(c) => c,
        Err(e) => return Ok(CommandResult::err(e)),
    };

    match client.download_file(&url).await {
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
async fn set_gd_token(token: String, state: tauri::State<'_, AppState>) -> Result<CommandResult, String> {
    let mut guard = state
        .gd_token
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    *guard = Some(token);
    Ok(CommandResult::ok(serde_json::json!({"saved": true})))
}

#[tauri::command]
async fn fetch_family(
    type_code: String,
    office_code: String,
    doc_number: String,
    state: tauri::State<'_, AppState>,
) -> Result<CommandResult, String> {
    let client = match get_gd_client(&state) {
        Ok(c) => c,
        Err(e) => return Ok(CommandResult::err(e)),
    };

    match client.get_family(&type_code, &office_code, &doc_number).await {
        Ok(data) => Ok(CommandResult::ok(data)),
        Err(e) => Ok(CommandResult::err(e.to_string())),
    }
}

#[tauri::command]
async fn fetch_gd_doc_list(
    country: String,
    doc_number: String,
    kind_code: String,
    state: tauri::State<'_, AppState>,
) -> Result<CommandResult, String> {
    let client = match get_gd_client(&state) {
        Ok(c) => c,
        Err(e) => return Ok(CommandResult::err(e)),
    };

    match client.get_doc_list(&country, &doc_number, &kind_code).await {
        Ok(data) => Ok(CommandResult::ok(data)),
        Err(e) => Ok(CommandResult::err(e.to_string())),
    }
}

#[tauri::command]
async fn download_gd_document(
    country: String,
    doc_number: String,
    doc_id: String,
    pages: String,
    format: String,
    state: tauri::State<'_, AppState>,
) -> Result<CommandResult, String> {
    let client = match get_gd_client(&state) {
        Ok(c) => c,
        Err(e) => return Ok(CommandResult::err(e)),
    };

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
async fn batch_fetch_examination_history(
    app_numbers: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<CommandResult>, String> {
    let mut results = Vec::with_capacity(app_numbers.len());
    for app_number in app_numbers {
        let result = fetch_examination_history(app_number, state.clone()).await?;
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
            uspto_client: Mutex::new(None),
            gd_token: Mutex::new(None),
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
            fetch_examination_history,
            fetch_application,
            fetch_transactions,
            fetch_documents,
            fetch_continuity,
            fetch_foreign_priority,
            download_document,
            set_gd_token,
            fetch_family,
            fetch_gd_doc_list,
            download_gd_document,
            batch_fetch_examination_history,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
