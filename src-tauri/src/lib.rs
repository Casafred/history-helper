mod api;
mod cache;
#[allow(dead_code)]
mod models;
mod ocr;
mod patent;
mod proxy;

use cache::{CacheStore, DB_FILENAME};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

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

            // Start local API proxy server (only /api/gd/* routes)
            let port = proxy::start_api_proxy();
            eprintln!("[Tauri] API proxy server started on port {}", port);

            // Inject the API base URL into the frontend
            // Use eval to set the variable; the frontend also listens for the 'gd-api-ready' event
            if let Some(window) = app.get_webview_window("main") {
                let inject_js = format!(
                    "window.__GD_API_BASE__ = 'http://127.0.0.1:{}/api/gd'; if(window.onGDApiReady) window.onGDApiReady();",
                    port
                );
                let _ = window.eval(&inject_js);
            }

            // Also emit an event so the frontend can pick it up even if eval ran before JS loaded
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(500));
                let _ = app_handle.emit("gd-api-ready", serde_json::json!({ "port": port }));
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
