use rusqlite::{Connection, Result};
use std::time::SystemTime;

/// App cache entry for fast startup
#[derive(Debug, Clone)]
pub struct AppCacheEntry {
    pub path: String,
    pub name: String,
    pub target_path: String,
    pub last_modified: i64,
    pub is_valid: bool,
    pub pinyin_initials: String,
}

/// Initialize app cache table
pub fn init_table(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_cache (
            path TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            target_path TEXT NOT NULL,
            last_modified INTEGER NOT NULL,
            is_valid BOOLEAN DEFAULT 1,
            pinyin_initials TEXT DEFAULT '',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

    // Migration: add pinyin_initials column if not exists
    let _ = conn.execute(
        "ALTER TABLE app_cache ADD COLUMN pinyin_initials TEXT DEFAULT ''",
        [],
    );

    // Create index for fast lookup
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_app_cache_valid ON app_cache(is_valid)",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_app_cache_target ON app_cache(target_path)",
        [],
    )?;

    Ok(())
}

/// Load all valid apps from cache
pub fn load_all(conn: &Connection) -> Result<Vec<AppCacheEntry>> {
    let mut stmt = conn.prepare(
        "SELECT path, name, target_path, last_modified, is_valid, pinyin_initials
         FROM app_cache
         WHERE is_valid = 1
         ORDER BY name COLLATE NOCASE"
    )?;

    let entries = stmt.query_map([], |row| {
        Ok(AppCacheEntry {
            path: row.get(0)?,
            name: row.get(1)?,
            target_path: row.get(2)?,
            last_modified: row.get(3)?,
            is_valid: row.get(4)?,
            pinyin_initials: row.get(5)?,
        })
    })?;

    entries.collect::<Result<Vec<_>, _>>()
}

/// Save or update a single app entry
pub fn save(conn: &Connection, entry: &AppCacheEntry) -> Result<()> {
    conn.execute(
        "INSERT INTO app_cache (path, name, target_path, last_modified, is_valid, pinyin_initials, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)
         ON CONFLICT(path) DO UPDATE SET
            name = ?2,
            target_path = ?3,
            last_modified = ?4,
            is_valid = ?5,
            pinyin_initials = ?6,
            updated_at = CURRENT_TIMESTAMP",
        [
            &entry.path,
            &entry.name,
            &entry.target_path,
            &entry.last_modified.to_string(),
            &entry.is_valid.to_string(),
            &entry.pinyin_initials,
        ],
    )?;

    Ok(())
}

/// Batch save multiple entries (more efficient)
pub fn save_batch(conn: &mut Connection, entries: &[AppCacheEntry]) -> Result<()> {
    let tx = conn.transaction()?;

    for entry in entries {
        tx.execute(
            "INSERT INTO app_cache (path, name, target_path, last_modified, is_valid, pinyin_initials, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, CURRENT_TIMESTAMP)
             ON CONFLICT(path) DO UPDATE SET
                name = ?2,
                target_path = ?3,
                last_modified = ?4,
                is_valid = ?5,
                pinyin_initials = ?6,
                updated_at = CURRENT_TIMESTAMP",
            [
                &entry.path,
                &entry.name,
                &entry.target_path,
                &entry.last_modified.to_string(),
                &entry.is_valid.to_string(),
                &entry.pinyin_initials,
            ],
        )?;
    }

    tx.commit()
}

/// Mark entries as invalid (soft delete)
pub fn mark_invalid(conn: &Connection, path: &str) -> Result<()> {
    conn.execute(
        "UPDATE app_cache SET is_valid = 0, updated_at = CURRENT_TIMESTAMP WHERE path = ?1",
        [path],
    )?;

    Ok(())
}

/// Delete invalid entries permanently
pub fn cleanup_invalid(conn: &Connection) -> Result<usize> {
    let count = conn.execute(
        "DELETE FROM app_cache WHERE is_valid = 0",
        [],
    )?;

    Ok(count)
}

/// Clear all cache entries
pub fn clear_all(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM app_cache", [])?;
    Ok(())
}

/// Check if cache exists and is not empty
pub fn has_cache(conn: &Connection) -> Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM app_cache WHERE is_valid = 1",
        [],
        |row| row.get(0),
    )?;

    Ok(count > 0)
}

/// Get cache stats
pub fn get_stats(conn: &Connection) -> Result<(usize, usize)> {
    let valid_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM app_cache WHERE is_valid = 1",
        [],
        |row| row.get(0),
    )?;

    let invalid_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM app_cache WHERE is_valid = 0",
        [],
        |row| row.get(0),
    )?;

    Ok((valid_count as usize, invalid_count as usize))
}

/// Get file modification time
pub fn get_file_modified(path: &std::path::Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "Invalid time")))
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
