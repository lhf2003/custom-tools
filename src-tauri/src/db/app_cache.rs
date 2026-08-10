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
            description TEXT DEFAULT '',
            description_reminded_at INTEGER,
            created_at DATETIME DEFAULT (datetime('now', '+8 hours')),
            updated_at DATETIME DEFAULT (datetime('now', '+8 hours'))
        )",
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

    run_migrations(conn)
}

/// 一次性数据迁移（meta 标记幂等，只跑一次）。抽成独立函数便于测试：
/// 测试可手工构造"旧版库"（UTC 时间戳、同名重复行）再执行迁移验证。

/// 迁移 1：同名重复行清理。collect_all_apps 的 lnk 扫描阶段曾漏登记
/// seen_names（2026-08-10 修复），存量库可能残留同名多行——如"暴雪战网"
/// 的 .lnk 行与注册表行并存（lnk 指向 Battle.net Launcher.exe、注册表
/// DisplayIcon 指向 Battle.net.exe，path 主键不同不冲突）。
/// 保留每组同名 rowid 最小的一条（最早入库，全量扫描时 lnk 先于注册表）。
/// 排除 proc: 虚拟行与空 name（虚拟行 name 全为空，会互相误删）。
/// 迁移 2：时间字段 UTC → 北京时区（+8h）。历史写入用 CURRENT_TIMESTAMP
/// 存 UTC，与展示口径差 8 小时；存量行整体后移，避免新旧混存时间线错乱。
/// datetime() 解析失败返回 NULL，COALESCE 回退原值保护异常数据。
fn run_migrations(conn: &Connection) -> Result<()> {
    if conn.execute(
        "INSERT OR IGNORE INTO app_cache_meta (key, value) VALUES ('dedup_apps_by_name', '1')",
        [],
    )? > 0 {
        conn.execute(
            "DELETE FROM app_cache
             WHERE is_valid = 1
               AND name != ''
               AND path NOT LIKE 'proc:%'
               AND path IN (
                   SELECT path FROM (
                       SELECT path, ROW_NUMBER() OVER (
                           PARTITION BY name COLLATE NOCASE ORDER BY rowid
                       ) rn
                       FROM app_cache
                       WHERE is_valid = 1 AND name != '' AND path NOT LIKE 'proc:%'
                   ) WHERE rn > 1
               )",
            [],
        )?;
    }

    if conn.execute(
        "INSERT OR IGNORE INTO app_cache_meta (key, value) VALUES ('timezone_bj_v1', '1')",
        [],
    )? > 0 {
        conn.execute(
            "UPDATE app_cache SET
                created_at = COALESCE(datetime(created_at, '+8 hours'), created_at),
                updated_at = COALESCE(datetime(updated_at, '+8 hours'), updated_at)",
            [],
        )?;
        conn.execute(
            "UPDATE app_cache_meta SET value = datetime(value, '+8 hours')
             WHERE key = 'last_full_scan'",
            [],
        )?;
    }

    Ok(())
}

/// Load all valid apps from cache
/// （排除 proc: 虚拟行——模型回填为无快捷方式进程插入的占位，不能出现在启动器搜索里）
pub fn load_all(conn: &Connection) -> Result<Vec<AppCacheEntry>> {
    let mut stmt = conn.prepare(
        "SELECT path, name, target_path, last_modified, is_valid, pinyin_initials
         FROM app_cache
         WHERE is_valid = 1
           AND path NOT LIKE 'proc:%'
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
/// created_at 显式写入：存量库（2026-08-10 前建表）的 DEFAULT 仍是 UTC，
/// 依赖 DEFAULT 会让 created_at 混入 UTC 行
pub fn save(conn: &Connection, entry: &AppCacheEntry) -> Result<()> {
    conn.execute(
        "INSERT INTO app_cache (path, name, target_path, last_modified, is_valid, pinyin_initials, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
         ON CONFLICT(path) DO UPDATE SET
            name = ?2,
            target_path = ?3,
            last_modified = ?4,
            is_valid = ?5,
            pinyin_initials = ?6,
            updated_at = datetime('now', '+8 hours')",
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
    // proc: 虚拟行整行备份（含 description/description_reminded_at/created_at）：
    // 扫描结果不含虚拟行，DELETE 后不重插则每次全量扫描抹掉描述与提醒标，
    // 模型对同一批未知进程每轮分析重复回填（LLM 成本浪费）
    let mut proc_backup: Vec<(String, String, String, i64, String)> = Vec::new();
    {
        let mut stmt = tx.prepare(
            "SELECT path, target_path, description, description_reminded_at, created_at
             FROM app_cache WHERE path LIKE 'proc:%'",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        for row in rows.flatten() {
            proc_backup.push(row);
        }
    }

    tx.execute("DELETE FROM app_cache", [])?;
    for entry in entries {
        let description = desc_backup.get(&entry.path).cloned().unwrap_or_default();
        tx.execute(
            "INSERT INTO app_cache (path, name, target_path, last_modified, is_valid, pinyin_initials, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
             ON CONFLICT(path) DO UPDATE SET
                name = ?2,
                target_path = ?3,
                last_modified = ?4,
                is_valid = ?5,
                pinyin_initials = ?6,
                description = ?7,
                updated_at = datetime('now', '+8 hours')",
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
    // 重插 proc: 虚拟行（字段与 fill_empty_descriptions 的 INSERT 对齐，created_at 保持原值）
    for (path, target_path, description, reminded_at, created_at) in proc_backup {
        tx.execute(
            "INSERT OR IGNORE INTO app_cache
                (path, name, target_path, last_modified, is_valid, description, description_reminded_at, created_at, updated_at)
             VALUES (?1, '', ?2, 0, 1, ?3, ?4, ?5, datetime('now', '+8 hours'))",
            rusqlite::params![path, target_path, description, reminded_at, created_at],
        )?;
    }

    tx.commit()?;

    // 记录全量扫描完成时间（新鲜度判断的真值源，见 init_table 注释）
    conn.execute(
        "INSERT INTO app_cache_meta (key, value) VALUES ('last_full_scan', datetime('now', '+8 hours'))
         ON CONFLICT(key) DO UPDATE SET value = datetime('now', '+8 hours')",
        [],
    )?;

    Ok(())
}

/// 上次全量扫描时间（北京时间 UTC+8，格式 YYYY-MM-DD HH:MM:SS）；从未全量扫过返回 None
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
            "INSERT INTO app_cache (path, name, target_path, last_modified, is_valid, pinyin_initials, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now', '+8 hours'), datetime('now', '+8 hours'))
             ON CONFLICT(path) DO UPDATE SET
                name = ?2,
                target_path = ?3,
                last_modified = ?4,
                is_valid = ?5,
                pinyin_initials = ?6,
                updated_at = datetime('now', '+8 hours')",
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
        "UPDATE app_cache SET is_valid = 0, updated_at = datetime('now', '+8 hours')
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
    // 注意：边界反斜杠必须写 '\\'（Rust 源码双反斜杠）——写成 '\' 会被转义成
    // 单引号，发给 SQLite 的实际是 = ''，子树边界恒不成立（此前 bug 导致目录
    // 删除时子 .lnk 不被失效，只命中与 dir 完全相等的行）
    conn.execute(
        "UPDATE app_cache SET is_valid = 0, updated_at = datetime('now', '+8 hours')
         WHERE substr(path, 1, length(?1)) = ?1
           AND (length(path) = length(?1) OR substr(path, length(?1) + 1, 1) = '\\')",
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
        "UPDATE app_cache SET description = ?1, updated_at = datetime('now', '+8 hours')
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
/// 无匹配行（进程没有快捷方式、app_cache 无记录）时插入虚拟行（path 前缀 proc:），
/// 否则回填永远静默 0 行——模型填了也白填，下次分析继续当不认识提醒。
pub fn fill_empty_descriptions(
    conn: &Connection,
    process_name: &str,
    description: &str,
) -> Result<usize> {
    let updated = conn.execute(
        "UPDATE app_cache SET description = ?1, updated_at = datetime('now', '+8 hours')
         WHERE is_valid = 1
           AND description = ''
           AND substr(target_path, -length(?2)) COLLATE NOCASE = ?2",
        rusqlite::params![description, process_name],
    )?;
    if updated > 0 {
        return Ok(updated);
    }
    // 进程已有有效行（描述非空 = 用户已标注，UPDATE 未命中属正常）→ 不插虚拟行
    if process_match_count(conn, process_name, "1=1")? > 0 {
        return Ok(0);
    }
    // 完全无行可填：插虚拟行（name 空、target_path 即进程名，进程匹配维度与真实行一致）。
    // 描述已写入 + 打提醒标：下次分析不会重复提醒（description 非空 + reminded 双保险）。
    // 虚拟行只进设置页应用列表（load_all 已过滤 proc: 前缀），不会污染启动器搜索。
    let reminded_at = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "INSERT OR IGNORE INTO app_cache
            (path, name, target_path, last_modified, is_valid, description, description_reminded_at, created_at, updated_at)
         VALUES (?1, '', ?2, 0, 1, ?3, ?4, datetime('now', '+8 hours'), datetime('now', '+8 hours'))",
        rusqlite::params![
            format!("proc:{}", process_name),
            process_name,
            description,
            reminded_at
        ],
    )
}

/// 给进程名匹配的所有行打提醒标记（弹窗/忽略后调用）
pub fn mark_process_reminded(conn: &Connection, process_name: &str) -> Result<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "UPDATE app_cache SET description_reminded_at = ?1, updated_at = datetime('now', '+8 hours')
         WHERE is_valid = 1
           AND substr(target_path, -length(?2)) COLLATE NOCASE = ?2",
        rusqlite::params![now, process_name],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_table(&conn).unwrap();
        conn
    }

    fn insert_row(conn: &Connection, path: &str, target: &str, desc: &str) {
        conn.execute(
            "INSERT INTO app_cache (path, name, target_path, last_modified, is_valid, description)
             VALUES (?1, ?2, ?3, 0, 1, ?4)",
            rusqlite::params![path, "name", target, desc],
        )
        .unwrap();
    }

    fn desc_of(conn: &Connection, path: &str) -> String {
        conn.query_row(
            "SELECT description FROM app_cache WHERE path = ?1",
            [path],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn backfill_updates_existing_empty_row() {
        let conn = setup();
        insert_row(&conn, "a.lnk", r"C:\apps\CorpLink.exe", "");
        let n = fill_empty_descriptions(&conn, "CorpLink.exe", "企业通讯工具").unwrap();
        assert_eq!(n, 1);
        assert_eq!(desc_of(&conn, "a.lnk"), "企业通讯工具");
    }

    #[test]
    fn backfill_does_not_overwrite_user_labeled() {
        let conn = setup();
        insert_row(&conn, "a.lnk", r"C:\apps\CorpLink.exe", "用户手填");
        let n = fill_empty_descriptions(&conn, "CorpLink.exe", "模型描述").unwrap();
        assert_eq!(n, 0, "非空描述不应被覆盖");
        assert_eq!(desc_of(&conn, "a.lnk"), "用户手填");
    }

    #[test]
    fn backfill_inserts_virtual_row_when_no_match() {
        let conn = setup();
        let n = fill_empty_descriptions(&conn, "ghost.exe", "幽灵应用").unwrap();
        assert_eq!(n, 1);
        let row: (String, String, Option<i64>) = conn
            .query_row(
                "SELECT target_path, description, description_reminded_at FROM app_cache WHERE path = 'proc:ghost.exe'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(row.0, "ghost.exe");
        assert_eq!(row.1, "幽灵应用");
        assert!(row.2.is_some(), "虚拟行应打提醒标，防下次重复提醒");
    }

    #[test]
    fn load_all_excludes_virtual_rows() {
        let conn = setup();
        insert_row(&conn, "a.lnk", r"C:\apps\Code.exe", "代码编辑器");
        insert_row(&conn, "proc:ghost.exe", "ghost.exe", "幽灵应用");
        let entries = load_all(&conn).unwrap();
        assert_eq!(entries.len(), 1, "proc: 虚拟行不应出现在搜索索引");
        assert_eq!(entries[0].path, "a.lnk");
    }

    /// mark_invalid_by_prefix：目录子树失效（回归：边界反斜杠曾写成 '\' 被
    /// 转义为单引号，子树前缀永不命中，只删与 dir 完全相等的行）
    #[test]
    fn prefix_invalidation_covers_subtree_and_boundary() {
        let conn = setup();
        insert_row(&conn, r"C:\apps\dir\a.lnk", r"C:\apps\dir\a.exe", "");
        insert_row(&conn, r"C:\apps\dir\sub\b.lnk", r"C:\apps\dir\sub\b.exe", "");
        insert_row(&conn, r"C:\apps\Cursor\c.lnk", r"C:\apps\Cursor\c.exe", "");
        insert_row(&conn, r"C:\apps\Cursor2\d.lnk", r"C:\apps\Cursor2\d.exe", "");

        mark_invalid_by_prefix(&conn, r"C:\apps\dir").unwrap();

        let valid: Vec<String> = conn
            .prepare("SELECT path FROM app_cache WHERE is_valid = 1")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            valid,
            vec![r"C:\apps\Cursor\c.lnk", r"C:\apps\Cursor2\d.lnk"],
            "dir 子树应全部失效，且 Cursor 前缀不得误伤 Cursor2"
        );
    }

    /// 回归：replace_batch 全量重建后 proc: 虚拟行必须保留（描述 + 提醒标），
    /// 否则每次全量扫描抹掉后，模型对同一批未知进程每轮分析重复回填
    #[test]
    fn replace_batch_keeps_virtual_rows() {
        let mut conn = setup();
        insert_row(&conn, "a.lnk", r"C:\apps\Code.exe", "代码编辑器");
        fill_empty_descriptions(&conn, "ghost.exe", "幽灵应用").unwrap();

        // 模拟一次全量扫描：结果不含 proc: 行
        let scanned = vec![AppCacheEntry {
            path: "a.lnk".into(),
            name: "Code".into(),
            target_path: r"C:\apps\Code.exe".into(),
            last_modified: 0,
            is_valid: true,
            pinyin_initials: String::new(),
        }];
        replace_batch(&mut conn, &scanned).unwrap();

        let (desc, reminded): (String, Option<i64>) = conn
            .query_row(
                "SELECT description, description_reminded_at FROM app_cache WHERE path = 'proc:ghost.exe'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(desc, "幽灵应用", "proc: 虚拟行描述应保留");
        assert!(reminded.is_some(), "proc: 虚拟行提醒标应保留，防重复回填");
    }

    // ── 迁移测试（模拟 2026-08-10 前的旧版库：UTC 时间戳 + 同名重复行） ──

    /// 构造旧版库：CURRENT_TIMESTAMP 默认值 + last_full_scan 元信息，
    /// 不跑 init_table（run_migrations 单独调用）。
    fn setup_legacy_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE app_cache (
                path TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                target_path TEXT NOT NULL,
                last_modified INTEGER NOT NULL,
                is_valid BOOLEAN DEFAULT 1,
                pinyin_initials TEXT DEFAULT '',
                description TEXT DEFAULT '',
                description_reminded_at INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "CREATE TABLE app_cache_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO app_cache_meta (key, value) VALUES ('last_full_scan', '2026-08-09 10:00:00')",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn migration_dedups_same_name_keep_earliest() {
        let conn = setup_legacy_db();
        // 两条同名（"暴雪战网"的 lnk 行 + 注册表行，path 主键不同）
        conn.execute(
            "INSERT INTO app_cache (path, name, target_path, last_modified) VALUES (?1, '暴雪战网', ?2, 0), (?3, '暴雪战网', ?4, 0)",
            rusqlite::params![
                r"C:\Users\LHF\Desktop\暴雪战网.lnk",
                r"C:\Battle.net Launcher.exe",
                r"C:\Battle.net.exe",
                r"C:\Battle.net.exe",
            ],
        )
        .unwrap();
        // proc: 虚拟行（name 空，不应参与分组或被误删）
        conn.execute(
            "INSERT INTO app_cache (path, name, target_path, last_modified) VALUES ('proc:ghost.exe', '', 'ghost.exe', 0)",
            [],
        )
        .unwrap();

        run_migrations(&conn).unwrap();

        let dup_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM app_cache WHERE is_valid = 1 AND name = '暴雪战网'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(dup_count, 1, "同名应只剩一行");
        let proc_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM app_cache WHERE path LIKE 'proc:%'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(proc_count, 1, "proc: 虚拟行应保留");
    }

    #[test]
    fn migration_converts_utc_to_beijing() {
        let conn = setup_legacy_db();
        conn.execute(
            "INSERT INTO app_cache (path, name, target_path, last_modified, created_at, updated_at)
             VALUES ('a.lnk', 'A', 'C:\\A.exe', 0, '2026-08-09 10:00:00', '2026-08-09 10:00:00')",
            [],
        )
        .unwrap();

        run_migrations(&conn).unwrap();

        let t: (String, String) = conn
            .query_row(
                "SELECT created_at, updated_at FROM app_cache WHERE path = 'a.lnk'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(t.0, "2026-08-09 18:00:00", "UTC +8h → 北京时间");
        assert_eq!(t.1, "2026-08-09 18:00:00");
        let last: String = conn
            .query_row(
                "SELECT value FROM app_cache_meta WHERE key = 'last_full_scan'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(last, "2026-08-09 18:00:00", "last_full_scan 同步迁移");
    }

    #[test]
    fn migration_is_idempotent() {
        let conn = setup_legacy_db();
        run_migrations(&conn).unwrap();
        // 标记已写 → 二次执行不再迁移：新插的 UTC 行不会被改动
        conn.execute(
            "INSERT INTO app_cache (path, name, target_path, last_modified, created_at)
             VALUES ('b.lnk', 'B', 'C:\\B.exe', 0, '2026-08-09 10:00:00')",
            [],
        )
        .unwrap();
        run_migrations(&conn).unwrap();
        let t: String = conn
            .query_row(
                "SELECT created_at FROM app_cache WHERE path = 'b.lnk'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(t, "2026-08-09 10:00:00", "幂等：二次执行不重复迁移");
    }

    #[test]
    fn writes_use_beijing_timezone() {
        let conn = setup(); // 新版表（DEFAULT 已是 +8）
        save(
            &conn,
            &AppCacheEntry {
                path: "a.lnk".into(),
                name: "A".into(),
                target_path: r"C:\apps\A.exe".into(),
                last_modified: 0,
                is_valid: true,
                pinyin_initials: "a".into(),
            },
        )
        .unwrap();
        let ts: String = conn
            .query_row(
                "SELECT created_at FROM app_cache WHERE path = 'a.lnk'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let written = chrono::NaiveDateTime::parse_from_str(&ts, "%Y-%m-%d %H:%M:%S").unwrap();
        let now_bj = chrono::Utc::now().naive_utc() + chrono::Duration::hours(8);
        let diff = (now_bj - written).num_seconds().abs();
        assert!(diff < 60, "created_at 应为北京时间，偏差 {diff}s");
    }
}
