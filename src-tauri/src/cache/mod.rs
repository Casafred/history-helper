pub mod sqlite;

pub use sqlite::CacheStore;

pub const DEFAULT_TTL_SECS: i64 = 3600;
pub const DB_FILENAME: &str = "cache.db";
