// PatentLens 缓存模块 - Copyright (c) 2026 Alfred Shi. All rights reserved.
// __PATENTLENS_COPYRIGHT__: Alfred Shi - Internal Use Only
pub mod sqlite;

pub use sqlite::CacheStore;

pub const DEFAULT_TTL_SECS: i64 = 3600;
pub const DB_FILENAME: &str = "cache.db";
