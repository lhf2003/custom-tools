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
    super::ensure_column(
        conn,
        "app_cache",
        "pinyin_initials",
        "ALTER TABLE app_cache ADD COLUMN pinyin_initials TEXT DEFAULT ''",
    )?;

    // 修复存量脏数据：旧版本把 is_valid 绑定为 TEXT 'true'/'false'（Rust bool 的
    // to_string()），查询端全部用整数比较 is_valid = 1/0——TEXT 永不匹配，缓存
    // 从未命中、每次启动全量扫描。把文本转回整数后新代码才能命中缓存。
    conn.execute(
        "UPDATE app_cache SET is_valid = 1 WHERE is_valid = 'true'",
        [],
    )?;
    conn.execute(
        "UPDATE app_cache SET is_valid = 0 WHERE is_valid = 'false'",
        [],
    )?;

    // Create index for fast lookup
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_app_cache_valid ON app_cache(is_valid)",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_app_cache_target ON app_cache(target_path)",
        [],
    )?;

    // 全量扫描元信息：last_full_scan 供新鲜度判断——不能复用 app_cache 表的
    // MAX(updated_at)（watcher 增量更新也刷它，会让全量扫描永不触发）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_cache_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
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
         ORDER BY name COLLATE NOCASE",
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
            &entry.path as &dyn rusqlite::types::ToSql,
            &entry.name,
            &entry.target_path,
            &entry.last_modified.to_string(),
            &if entry.is_valid { "1" } else { "0" },
            &entry.pinyin_initials,
        ],
    )?;

    Ok(())
}

/// 全量替换缓存：事务内清空后重建。
/// collect_all_apps 的语义是"当前集合即缓存全集"——DELETE 全表会清掉已删除
/// 应用的僵尸条目（is_valid=1 永不清理的旧行为会让下次启动原样恢复）。
/// INSERT 用 ON CONFLICT DO UPDATE：entries 内部允许重复 path（Registry 按
/// name|exe_path 去重，同一 exe 不同名条目 path 相同），纯 INSERT 会报
/// UNIQUE constraint failed 导致整个事务回滚、缓存停更——每次启动都判定
/// 缓存陈旧而重复全量扫描。
pub fn replace_batch(conn: &mut Connection, entries: &[AppCacheEntry]) -> Result<()> {
    let tx = conn.transaction()?;

    tx.execute("DELETE FROM app_cache", [])?;
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
                &entry.path as &dyn rusqlite::types::ToSql,
                &entry.name,
                &entry.target_path,
                &entry.last_modified.to_string(),
                &if entry.is_valid { "1" } else { "0" },
                &entry.pinyin_initials,
            ],
        )?;
    }

    tx.commit()?;

    // 记录全量扫描完成时间（新鲜度判断的真值源，见 init_table 注释）
    conn.execute(
        "INSERT INTO app_cache_meta (key, value) VALUES ('last_full_scan', CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = CURRENT_TIMESTAMP",
        [],
    )?;

    Ok(())
}

/// 上次全量扫描时间（UTC，格式同 CURRENT_TIMESTAMP）；从未全量扫过返回 None
pub fn last_full_scan(conn: &Connection) -> Option<String> {
    conn.query_row(
        "SELECT value FROM app_cache_meta WHERE key = 'last_full_scan'",
        [],
        |row| row.get(0),
    )
    .ok()
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
                &entry.path as &dyn rusqlite::types::ToSql,
                &entry.name,
                &entry.target_path,
                &entry.last_modified.to_string(),
                &if entry.is_valid { "1" } else { "0" },
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
    let count = conn.execute("DELETE FROM app_cache WHERE is_valid = 0", [])?;

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
        .and_then(|t| {
            t.duration_since(SystemTime::UNIX_EPOCH)
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "Invalid time"))
        })
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
