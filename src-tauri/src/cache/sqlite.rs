use rusqlite::{params, Connection};
use std::path::Path;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum CacheError {
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

pub struct CacheStore {
    conn: Connection,
}

impl CacheStore {
    pub fn new(db_path: &Path) -> Result<Self, CacheError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(db_path)?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS api_cache (
               cache_key TEXT PRIMARY KEY,
               office TEXT NOT NULL,
               app_number TEXT NOT NULL,
               data_type TEXT NOT NULL,
               response_data TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               expires_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_cache_key ON api_cache(cache_key);
             CREATE INDEX IF NOT EXISTS idx_expires ON api_cache(expires_at);",
        )?;

        Ok(Self { conn })
    }

    pub fn get(&self, key: &str) -> Option<String> {
        let now = epoch_secs();

        let mut stmt = self
            .conn
            .prepare("SELECT response_data FROM api_cache WHERE cache_key = ?1 AND expires_at > ?2")
            .ok()?;

        stmt.query_row(params![key, now], |row| row.get(0)).ok()
    }

    pub fn set(
        &self,
        key: &str,
        office: &str,
        app_number: &str,
        data_type: &str,
        data: &str,
        ttl_secs: i64,
    ) -> Result<(), CacheError> {
        let now = epoch_secs();
        let expires_at = now + ttl_secs;

        self.conn.execute(
            "INSERT OR REPLACE INTO api_cache (cache_key, office, app_number, data_type, response_data, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![key, office, app_number, data_type, data, now, expires_at],
        )?;
        Ok(())
    }

    pub fn cleanup_expired(&mut self) {
        let now = epoch_secs();
        let _ = self
            .conn
            .execute("DELETE FROM api_cache WHERE expires_at <= ?1", params![now]);
    }

    pub fn make_cache_key(office: &str, app_number: &str, data_type: &str) -> String {
        format!("{}:{}:{}", office, app_number, data_type)
    }
}

fn epoch_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
