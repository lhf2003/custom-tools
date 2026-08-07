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

    // Migration: 应用描述（模型回填 / 用户标注），拼接分析摘要时随进程名带给 LLM
    super::ensure_column(
        conn,
        "app_cache",
        "description",
        "ALTER TABLE app_cache ADD COLUMN description TEXT DEFAULT ''",
    )?;
    // Migration: 未知进程提醒标记（弹过即不再提醒，填了描述后自然失效）
    super::ensure_column(
        conn,
        "app_cache",
        "description_reminded_at",
        "ALTER TABLE app_cache ADD COLUMN description_reminded_at INTEGER",
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

/// 读取缓存中的 UWP 条目（path 以 shell: 开头）。
/// UWP 扫描失败时用于沿用旧条目，避免全量替换把 UWP 应用清空。
pub fn load_uwp_cached(conn: &Connection) -> Result<Vec<AppCacheEntry>> {
    let mut stmt = conn.prepare(
        "SELECT path, name, target_path, last_modified, is_valid, pinyin_initials
         FROM app_cache WHERE path LIKE 'shell:%'",
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

/// 全量替换缓存：事务内清空后重建。
/// collect_all_apps 的语义是"当前集合即缓存全集"——DELETE 全表会清掉已删除
/// 应用的僵尸条目（is_valid=1 永不清理的旧行为会让下次启动原样恢复）。
/// INSERT 用 ON CONFLICT DO UPDATE：entries 内部允许重复 path（Registry 按
/// name|exe_path 去重，同一 exe 不同名条目 path 相同），纯 INSERT 会报
/// UNIQUE constraint failed 导致整个事务回滚、缓存停更——每次启动都判定
/// 缓存陈旧而重复全量扫描。
pub fn replace_batch(conn: &mut Connection, entries: &[AppCacheEntry]) -> Result<()> {
    let tx = conn.transaction()?;

    // DELETE 全表前备份描述映射：description 是用户标注/模型回填的长期元数据，
    // 不能随扫描重建丢失（扫描器构造的 entry 不带 description 概念）
    let mut desc_backup: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    {
        let mut stmt = tx.prepare("SELECT path, description FROM app_cache")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows.flatten() {
            if !row.1.is_empty() {
                desc_backup.insert(row.0, row.1);
            }
        }
    }

    tx.execute("DELETE FROM app_cache", [])?;
    for entry in entries {
        let description = desc_backup.get(&entry.path).cloned().unwrap_or_default();
        tx.execute(
            "INSERT INTO app_cache (path, name, target_path, last_modified, is_valid, pinyin_initials, description, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CURRENT_TIMESTAMP)
             ON CONFLICT(path) DO UPDATE SET
                name = ?2,
                target_path = ?3,
                last_modified = ?4,
                is_valid = ?5,
                pinyin_initials = ?6,
                description = ?7,
                updated_at = CURRENT_TIMESTAMP",
            [
                &entry.path as &dyn rusqlite::types::ToSql,
                &entry.name,
                &entry.target_path,
                &entry.last_modified.to_string(),
                &if entry.is_valid { "1" } else { "0" },
                &entry.pinyin_initials,
                &description,
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
/// COLLATE NOCASE:Windows 路径大小写不敏感,watcher 报告的路径大小写
/// 可能与扫描时存储的不一致,精确比较会静默漏删
pub fn mark_invalid(conn: &Connection, path: &str) -> Result<()> {
    conn.execute(
        "UPDATE app_cache SET is_valid = 0, updated_at = CURRENT_TIMESTAMP
         WHERE path COLLATE NOCASE = ?1",
        [path],
    )?;

    Ok(())
}

/// Mark all entries under a directory prefix as invalid (soft delete).
/// 用于整个目录被删除的场景（卸载程序常直接删掉整个快捷方式文件夹，
/// ReadDirectoryChangesW 只报告目录本身的删除，子 .lnk 不会逐个触发）。
/// 用 substr 前缀比较而非 LIKE——路径中的 `_` 会被 LIKE 当通配符误匹配；
/// 尾部边界判断防止 `...\Cursor` 误伤 `...\Cursor2\`。
pub fn mark_invalid_by_prefix(conn: &Connection, dir: &str) -> Result<()> {
    conn.execute(
        "UPDATE app_cache SET is_valid = 0, updated_at = CURRENT_TIMESTAMP
         WHERE substr(path, 1, length(?1)) = ?1
           AND (length(path) = length(?1) OR substr(path, length(?1) + 1, 1) = '\')",
        [dir],
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

// ── 应用描述（标注/回填/提醒） ────────────────────────────────

/// 应用 tab 行：app_cache + 启动次数（未启动过为 0）
#[derive(Debug, Clone, serde::Serialize)]
pub struct AppCacheRow {
    pub path: String,
    pub name: String,
    pub target_path: String,
    pub description: String,
    pub launch_count: i64,
}

/// 搜索关键词转义 LIKE 通配符（`_` 在路径/文件名里常见，不能当通配符用）
fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// 应用 tab 分页查询。
/// - query: 按 name / target_path 模糊过滤（LIKE，通配符已转义）
/// - sort: "launch"（启动次数）/ "name"（名称）
/// - direction: "asc" / "desc"；非法值回退该列默认方向（launch 降序、name 升序）
/// - only_unlabeled: 只看 description = '' 的行
/// - offset/limit: 分页
pub fn query_app_entries(
    conn: &Connection,
    query: Option<&str>,
    sort: &str,
    direction: &str,
    only_unlabeled: bool,
    offset: i64,
    limit: i64,
) -> Result<Vec<AppCacheRow>> {
    let mut sql = String::from(
        "SELECT c.path, c.name, c.target_path, c.description, COALESCE(u.launch_count, 0)
         FROM app_cache c
         LEFT JOIN app_usage u ON u.path = c.path COLLATE NOCASE
         WHERE c.is_valid = 1",
    );
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

    if let Some(q) = query.filter(|s| !s.trim().is_empty()) {
        let pattern = format!("%{}%", escape_like(q.trim()));
        sql.push_str(" AND (c.name LIKE ? ESCAPE '\\' OR c.target_path LIKE ? ESCAPE '\\')");
        params.push(Box::new(pattern.clone()));
        params.push(Box::new(pattern));
    }
    if only_unlabeled {
        sql.push_str(" AND c.description = ''");
    }

    // 方向校验：非法值回退该列默认方向（launch 降序、name 升序）；次键恒名称升序，次序稳定
    let dir = match (sort, direction) {
        ("launch", "asc") => "ASC",
        ("launch", _) => "DESC",
        ("name", "desc") => "DESC",
        _ => "ASC",
    };
    match sort {
        "name" => sql.push_str(&format!(" ORDER BY c.name COLLATE NOCASE {dir}")),
        _ => sql.push_str(&format!(
            " ORDER BY COALESCE(u.launch_count, 0) {dir}, c.name COLLATE NOCASE"
        )),
    }
    sql.push_str(" LIMIT ? OFFSET ?");
    params.push(Box::new(limit));
    params.push(Box::new(offset));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())), |row| {
        Ok(AppCacheRow {
            path: row.get(0)?,
            name: row.get(1)?,
            target_path: row.get(2)?,
            description: row.get(3)?,
            launch_count: row.get(4)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>()
}

/// 更新单行描述（空字符串 = 清空）
pub fn update_description(conn: &Connection, path: &str, description: &str) -> Result<()> {
    conn.execute(
        "UPDATE app_cache SET description = ?1, updated_at = CURRENT_TIMESTAMP
         WHERE path COLLATE NOCASE = ?2",
        [description, path],
    )?;
    Ok(())
}

/// exe 文件名（小写）→ (显示名, 描述) 映射。供分析聚合拼接：activity_log 的
/// 进程名与 target_path 截断后的文件名 COLLATE NOCASE 匹配，多 lnk 指向同一
/// exe 时后覆盖前（取任一即可）。name 基本恒非空（快捷方式显示名），
/// 与进程名雷同（如 name 就是 "Code.exe"）的由拼接侧跳过，不污染摘要。
pub fn app_label_map(
    conn: &Connection,
) -> Result<std::collections::HashMap<String, (String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT target_path, name, description FROM app_cache WHERE is_valid = 1",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;

    let mut map = std::collections::HashMap::new();
    for row in rows.flatten() {
        // target_path 取最后一个 '\' 之后作为进程名（与 watcher 的进程名同维度）
        if let Some(file_name) = row.0.rsplit('\\').next() {
            if !file_name.is_empty() {
                map.insert(file_name.to_lowercase(), (row.1, row.2));
            }
        }
    }
    Ok(map)
}

/// 进程名匹配行数（substr 尾部匹配 = 最后一段文件名比较，避免 instr 只找第一个 '\'）
fn process_match_count(conn: &Connection, process_name: &str, desc_cond: &str) -> Result<i64> {
    conn.query_row(
        &format!(
            "SELECT COUNT(*) FROM app_cache
             WHERE is_valid = 1
               AND {cond}
               AND substr(target_path, -length(?1)) COLLATE NOCASE = ?1",
            cond = desc_cond
        ),
        [process_name],
        |row| row.get(0),
    )
}

/// 进程名匹配到的所有行是否都已提醒过（弹窗去重：任一行没提醒即可弹）
pub fn process_all_reminded(conn: &Connection, process_name: &str) -> Result<bool> {
    let unreminded = process_match_count(
        conn,
        process_name,
        "description_reminded_at IS NULL",
    )?;
    Ok(unreminded == 0)
}

/// 进程名匹配到的所有行描述是否都为空（提醒判定用：全空才需要提醒）
pub fn process_all_descriptions_empty(conn: &Connection, process_name: &str) -> Result<bool> {
    let described = process_match_count(conn, process_name, "description != ''")?;
    Ok(described == 0)
}

/// 模型回填：仅对描述为空的行写描述（不覆盖用户已有标注），返回受影响行数。
/// 多 lnk 指向同一 exe 时全部同步回填，保持一致。
pub fn fill_empty_descriptions(
    conn: &Connection,
    process_name: &str,
    description: &str,
) -> Result<usize> {
    conn.execute(
        "UPDATE app_cache SET description = ?1, updated_at = CURRENT_TIMESTAMP
         WHERE is_valid = 1
           AND description = ''
           AND substr(target_path, -length(?2)) COLLATE NOCASE = ?2",
        rusqlite::params![description, process_name],
    )
}

/// 给进程名匹配的所有行打提醒标记（弹窗/忽略后调用）
pub fn mark_process_reminded(conn: &Connection, process_name: &str) -> Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "UPDATE app_cache SET description_reminded_at = ?1, updated_at = CURRENT_TIMESTAMP
         WHERE is_valid = 1
           AND substr(target_path, -length(?2)) COLLATE NOCASE = ?2",
        rusqlite::params![now, process_name],
    )?;
    Ok(())
}
