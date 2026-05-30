mod api;
mod models;
mod parser;
mod patent;

use api::uspto::UsptoClient;
use patent::converter::{detect_office, normalize_us_application_number, parse_patent_number};
use serde::Serialize;
use std::sync::Mutex;

struct AppState {
    uspto_client: Mutex<Option<UsptoClient>>,
}

#[derive(Serialize)]
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

#[tauri::command]
async fn convert_patent_number(input: String) -> CommandResult {
    match parse_patent_number(&input) {
        Ok(pn) => CommandResult::ok(serde_json::to_value(pn).unwrap_or_default()),
        Err(e) => CommandResult::err(e.to_string()),
    }
}

#[tauri::command]
async fn detect_patent_office(input: String) -> CommandResult {
    match detect_office(&input) {
        Some(office) => CommandResult::ok(serde_json::Value::String(office.to_string())),
        None => CommandResult::err(format!("Unrecognized patent number format: {}", input)),
    }
}

#[tauri::command]
async fn fetch_application(app_number: String, state: tauri::State<'_, AppState>) -> CommandResult {
    let client = match get_or_create_client(&state) {
        Ok(c) => c,
        Err(e) => return CommandResult::err(e),
    };

    let normalized = match normalize_us_application_number(&app_number) {
        Ok(n) => n,
        Err(e) => return CommandResult::err(e.to_string()),
    };

    match client.get_application(&normalized).await {
        Ok(data) => CommandResult::ok(serde_json::to_value(data).unwrap_or_default()),
        Err(e) => CommandResult::err(e.to_string()),
    }
}

#[tauri::command]
async fn fetch_transactions(
    app_number: String,
    state: tauri::State<'_, AppState>,
) -> CommandResult {
    let client = match get_or_create_client(&state) {
        Ok(c) => c,
        Err(e) => return CommandResult::err(e),
    };

    let normalized = match normalize_us_application_number(&app_number) {
        Ok(n) => n,
        Err(e) => return CommandResult::err(e.to_string()),
    };

    match client.get_transactions(&normalized).await {
        Ok(data) => CommandResult::ok(serde_json::to_value(data).unwrap_or_default()),
        Err(e) => CommandResult::err(e.to_string()),
    }
}

#[tauri::command]
async fn fetch_documents(
    app_number: String,
    state: tauri::State<'_, AppState>,
) -> CommandResult {
    let client = match get_or_create_client(&state) {
        Ok(c) => c,
        Err(e) => return CommandResult::err(e),
    };

    let normalized = match normalize_us_application_number(&app_number) {
        Ok(n) => n,
        Err(e) => return CommandResult::err(e.to_string()),
    };

    match client.get_documents(&normalized).await {
        Ok(data) => CommandResult::ok(serde_json::to_value(data).unwrap_or_default()),
        Err(e) => CommandResult::err(e.to_string()),
    }
}

#[tauri::command]
async fn fetch_continuity(
    app_number: String,
    state: tauri::State<'_, AppState>,
) -> CommandResult {
    let client = match get_or_create_client(&state) {
        Ok(c) => c,
        Err(e) => return CommandResult::err(e),
    };

    let normalized = match normalize_us_application_number(&app_number) {
        Ok(n) => n,
        Err(e) => return CommandResult::err(e.to_string()),
    };

    match client.get_continuity(&normalized).await {
        Ok(data) => CommandResult::ok(serde_json::to_value(data).unwrap_or_default()),
        Err(e) => CommandResult::err(e.to_string()),
    }
}

#[tauri::command]
async fn fetch_foreign_priority(
    app_number: String,
    state: tauri::State<'_, AppState>,
) -> CommandResult {
    let client = match get_or_create_client(&state) {
        Ok(c) => c,
        Err(e) => return CommandResult::err(e),
    };

    let normalized = match normalize_us_application_number(&app_number) {
        Ok(n) => n,
        Err(e) => return CommandResult::err(e.to_string()),
    };

    match client.get_foreign_priority(&normalized).await {
        Ok(data) => CommandResult::ok(serde_json::to_value(data).unwrap_or_default()),
        Err(e) => CommandResult::err(e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    dotenv::dotenv().ok();

    tauri::Builder::default()
        .manage(AppState {
            uspto_client: Mutex::new(None),
        })
        .setup(|app| {
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
            fetch_application,
            fetch_transactions,
            fetch_documents,
            fetch_continuity,
            fetch_foreign_priority,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
