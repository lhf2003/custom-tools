use rusqlite::{Connection, Result};
use std::time::{SystemTime, UNIX_EPOCH};

/// Record a file open event (files only — folders are excluded by the caller,
/// the "frequent files" list is about documents/apps, not directories).
pub fn record_open(conn: &Connection, path: &str, name: &str) -> Result<()> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    conn.execute(
        "INSERT INTO file_usage (path, name, open_count, last_opened, updated_at)
         VALUES (?1, ?2, 1, ?3, CURRENT_TIMESTAMP)
         ON CONFLICT(path) DO UPDATE SET
            open_count = open_count + 1,
            last_opened = ?3,
            updated_at = CURRENT_TIMESTAMP",
        rusqlite::params![path, name, now],
    )?;

    Ok(())
}

/// Get top N most frequently opened files (open_count desc, then last_opened desc).
pub fn get_frequent(conn: &Connection, limit: usize) -> Result<Vec<FileUsage>> {
    let mut stmt = conn.prepare(
        "SELECT path, name, open_count, last_opened
         FROM file_usage
         ORDER BY open_count DESC, last_opened DESC
         LIMIT ?1",
    )?;

    let usages = stmt.query_map([limit], |row| {
        Ok(FileUsage {
            path: row.get(0)?,
            name: row.get(1)?,
            open_count: row.get(2)?,
            last_opened: row.get(3)?,
        })
    })?;

    usages.collect::<Result<Vec<_>, _>>()
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct FileUsage {
    pub path: String,
    pub name: String,
    pub open_count: i64,
    pub last_opened: Option<i64>,
}
