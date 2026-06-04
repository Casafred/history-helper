mod api;
mod cache;
#[allow(dead_code)]
mod models;
mod ocr;
mod patent;
mod proxy;

use cache::{CacheStore, DB_FILENAME};
use std::sync::Mutex;
use tauri::Manager;

struct AppState {
    cache: Mutex<Option<CacheStore>>,
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
            // Initialize cache
            let app_data_dir = match app.path().app_data_dir() {
                Ok(dir) => dir,
                Err(e) => {
                    eprintln!("[Tauri] Failed to get app data dir: {}", e);
                    return Ok(());
                }
            };
            let db_path = app_data_dir.join(DB_FILENAME);
            match CacheStore::new(&db_path) {
                Ok(cache_store) => {
                    let state = app.state::<AppState>();
                    let mut guard = state.cache.lock().unwrap_or_else(|e: std::sync::PoisonError<_>| e.into_inner());
                    *guard = Some(cache_store);
                }
                Err(e) => {
                    eprintln!("[Tauri] Failed to initialize cache: {}", e);
                }
            }

            if cfg!(debug_assertions) {
                let _ = app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                );
            }

            // Start local API proxy server (GD + JPO + DPMA routes)
            let port = proxy::start_api_proxy();
            eprintln!("[Tauri] API proxy server started on port {}", port);

            // Store the port so the frontend can retrieve it via a Tauri command
            app.manage(ApiPort(port));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_api_port])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

struct ApiPort(u16);

#[tauri::command]
fn get_api_port(api_port: tauri::State<ApiPort>) -> Result<u16, String> {
    Ok(api_port.0)
}
