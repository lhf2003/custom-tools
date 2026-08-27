//! sqlite-vec 向量库: memory_items 元数据 + memory_vectors vec0 虚拟表，同库 flowhub.db
//!
//! 决策依据 D7/D10/D11:
//! - 向量进 flowhub.db, 与 clipboard/notes 同库 JOIN, 暴力扫描规模足够
//! - URL 级去重 + 内容哈希判变更 (D11)
//! - 浏览数据 90 天滚动过期物理删除; 剪贴板/笔记 expires_at=NULL 不过期 (D10)

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// bge-small-zh-v1.5 输出维度（换模型时同步改这里并重建 memory_vectors）
pub const EMBEDDING_DIM: usize = 512;
/// 检索过滤时的过取倍数（过期/来源过滤后再截断）
const OVER_FETCH: usize = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryItem {
    pub id: i64,
    pub source: String, // clipboard | note | browser | subtitle | memory_fact
    pub source_ref: Option<String>,
    pub url: Option<String>,
    pub domain: Option<String>,
    pub title: Option<String>,
    pub chunk_index: i64,
    pub content: String,
    pub content_hash: String,
    pub created_at: Option<String>,
    pub indexed_at: String,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SearchHit {
    pub item: MemoryItem,
    /// 余弦相似度（由 vec0 L2 距离换算, 向量已归一化: cos = 1 - d²/2）
    pub score: f32,
}

#[derive(Debug, Default)]
pub struct DocMeta<'a> {
    pub source: &'a str,
    pub source_ref: Option<&'a str>,
    pub url: Option<&'a str>,
    pub domain: Option<&'a str>,
    pub title: Option<&'a str>,
    pub created_at: Option<&'a str>,
    pub expires_at: Option<&'a str>,
}

#[derive(Debug, PartialEq)]
pub enum IndexOutcome {
    /// 内容哈希未变, 跳过（D11 去重）
    SkippedUnchanged,
    /// 实际写入的 chunk 数
    Indexed(usize),
}

pub fn now_local() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn emb_to_bytes(emb: &[f32]) -> Vec<u8> {
    emb.iter().flat_map(|f| f.to_le_bytes()).collect()
}

/// 全局一次性注册 vec0 扩展（sqlite3_auto_extension 对注册之后新打开的连接生效）
/// ⚠️ 必须在打开任何数据库连接之前调用（M3 主进程集成时注意顺序）
pub fn register_vec_extension() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute::<
            *const (),
            unsafe extern "C" fn(
                *mut rusqlite::ffi::sqlite3,
                *mut *const std::ffi::c_char,
                *const rusqlite::ffi::sqlite3_api_routines,
            ) -> std::ffi::c_int,
        >(sqlite_vec::sqlite3_vec_init as *const ())));
    });
}

/// 建表（vec0 扩展已通过 register_vec_extension 全局注册）
pub fn init_memory_tables(conn: &Connection) -> Result<()> {
    register_vec_extension();

    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS memory_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            source_ref TEXT,
            url TEXT,
            domain TEXT,
            title TEXT,
            dedup_key TEXT NOT NULL,
            chunk_index INTEGER NOT NULL DEFAULT 0,
            content TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            created_at TEXT,
            indexed_at TEXT NOT NULL,
            expires_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_memory_dedup ON memory_items(source, dedup_key);
        CREATE INDEX IF NOT EXISTS idx_memory_domain ON memory_items(domain);
        CREATE INDEX IF NOT EXISTS idx_memory_expires ON memory_items(expires_at);
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
            embedding float[{EMBEDDING_DIM}]
        );
        CREATE TABLE IF NOT EXISTS memory_blacklist (
            domain TEXT PRIMARY KEY,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );"
    ))?;
    Ok(())
}

/// 默认保留期（D10：90 天滚动），设置页可改，落 memory_meta
pub const DEFAULT_RETENTION_DAYS: i64 = 90;
const RETENTION_KEY: &str = "retention_days";

/// 读取浏览数据保留期（天）。未配置/非法值回退默认 90
pub fn get_retention_days(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT value FROM memory_meta WHERE key = ?1",
        params![RETENTION_KEY],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .and_then(|v| v.parse::<i64>().ok())
    .filter(|&d| d > 0)
    .unwrap_or(DEFAULT_RETENTION_DAYS)
}

pub fn set_retention_days(conn: &Connection, days: i64) -> Result<()> {
    anyhow::ensure!(days > 0, "保留期必须为正整数天");
    conn.execute(
        "INSERT INTO memory_meta(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![RETENTION_KEY, days.to_string()],
    )?;
    Ok(())
}

/// 黑名单（单真源在 SQLite, D13：扩展 chrome.storage 只是缓存）
pub fn list_blacklist(conn: &Connection) -> Result<Vec<String>> {
    let mut st = conn.prepare("SELECT domain FROM memory_blacklist ORDER BY domain")?;
    let mapped = st.query_map([], |r| r.get::<_, String>(0))?;
    Ok(mapped.collect::<std::result::Result<Vec<_>, _>>()?)
}

pub fn add_blacklist(conn: &Connection, domain: &str) -> Result<()> {
    let domain = domain.trim().trim_start_matches("*.").to_lowercase();
    // 域名字符集白名单：设置页自由输入会原样进扩展 popup 渲染, 堵住标签注入
    anyhow::ensure!(
        !domain.is_empty()
            && domain.contains('.')
            && domain
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'),
        "非法域名: {domain}"
    );
    conn.execute(
        "INSERT OR IGNORE INTO memory_blacklist(domain, created_at) VALUES (?1, ?2)",
        params![domain, now_local()],
    )?;
    Ok(())
}

pub fn remove_blacklist(conn: &Connection, domain: &str) -> Result<usize> {
    let n = conn.execute(
        "DELETE FROM memory_blacklist WHERE domain = ?1",
        params![domain.trim().to_lowercase()],
    )?;
    Ok(n)
}

/// 后缀匹配判定（与扩展 content.js isBlacklisted 同一语义）
pub fn is_blacklisted(conn: &Connection, domain: &str) -> Result<bool> {
    let list = list_blacklist(conn)?;
    let host = domain.to_lowercase();
    Ok(list.iter().any(|d| host == *d || host.ends_with(&format!(".{d}"))))
}

/// 各来源条目统计（隐私仪表盘用）
pub fn source_stats(conn: &Connection) -> Result<Vec<(String, i64)>> {
    let mut st =
        conn.prepare("SELECT source, COUNT(*) FROM memory_items GROUP BY source ORDER BY source")?;
    let mapped = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    Ok(mapped.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// 文档级索引入口: 去重判断 + 变更替换, 事务保证「删旧写新」原子
/// chunks: (chunk_index, content, content_hash, embedding)
pub fn index_document(
    conn: &mut Connection,
    meta: &DocMeta,
    chunks: &[(i64, String, String, Vec<f32>)],
) -> Result<IndexOutcome> {
    let dedup_key = meta
        .url
        .or(meta.source_ref)
        .context("DocMeta 缺 url 与 source_ref, 无法去重")?;

    let tx = conn.transaction()?;

    // 已索引的同 key chunk 哈希
    let existing: Vec<(i64, i64, String)> = {
        let mut st = tx.prepare(
            "SELECT id, chunk_index, content_hash FROM memory_items WHERE source = ?1 AND dedup_key = ?2",
        )?;
        let mapped = st.query_map(params![meta.source, dedup_key], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
        mapped.collect::<std::result::Result<Vec<_>, _>>()?
    };

    let unchanged = existing.len() == chunks.len()
        && chunks.iter().all(|(ci, _, h, _)| {
            existing.iter().any(|(_, eci, eh)| eci == ci && eh == h)
        });
    if unchanged {
        return Ok(IndexOutcome::SkippedUnchanged);
    }

    // 变更: 先删旧向量与旧行, 再写新（同事务）
    for (id, _, _) in &existing {
        tx.execute("DELETE FROM memory_vectors WHERE rowid = ?1", params![id])?;
    }
    tx.execute(
        "DELETE FROM memory_items WHERE source = ?1 AND dedup_key = ?2",
        params![meta.source, dedup_key],
    )?;

    let now = now_local();
    for (ci, content, hash, emb) in chunks {
        if emb.len() != EMBEDDING_DIM {
            anyhow::bail!("embedding 维度 {} 与库定义 {} 不符", emb.len(), EMBEDDING_DIM);
        }
        tx.execute(
            "INSERT INTO memory_items
             (source, source_ref, url, domain, title, dedup_key, chunk_index, content, content_hash, created_at, indexed_at, expires_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                meta.source, meta.source_ref, meta.url, meta.domain, meta.title,
                dedup_key, ci, content, hash, meta.created_at, now, meta.expires_at,
            ],
        )?;
        let rowid = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO memory_vectors(rowid, embedding) VALUES (?1, ?2)",
            params![rowid, emb_to_bytes(emb)],
        )?;
    }
    let n = chunks.len();
    tx.commit()?;
    Ok(IndexOutcome::Indexed(n))
}

/// 语义检索: vec0 KNN → 过滤过期/来源 → 换算余弦分 → JOIN 元数据
pub fn search(
    conn: &Connection,
    query_emb: &[f32],
    k: usize,
    source_filter: Option<&str>,
) -> Result<Vec<SearchHit>> {
    let mut st = conn.prepare(
        "SELECT rowid, distance FROM memory_vectors
         WHERE embedding MATCH ?1 AND k = ?2
         ORDER BY distance",
    )?;
    let knn: Vec<(i64, f64)> = st
        .query_map(params![emb_to_bytes(query_emb), (k * OVER_FETCH) as i64], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .collect::<std::result::Result<_, _>>()?;

    if knn.is_empty() {
        return Ok(vec![]);
    }
    let now = now_local();
    let mut hits = Vec::with_capacity(k);
    for (rowid, dist) in knn {
        let item = conn.query_row(
            "SELECT id, source, source_ref, url, domain, title, chunk_index, content, content_hash, created_at, indexed_at, expires_at
             FROM memory_items WHERE id = ?1",
            params![rowid],
            |r| {
                Ok(MemoryItem {
                    id: r.get(0)?, source: r.get(1)?, source_ref: r.get(2)?,
                    url: r.get(3)?, domain: r.get(4)?, title: r.get(5)?,
                    chunk_index: r.get(6)?, content: r.get(7)?, content_hash: r.get(8)?,
                    created_at: r.get(9)?, indexed_at: r.get(10)?, expires_at: r.get(11)?,
                })
            },
        );
        let Ok(item) = item else { continue };
        if let Some(exp) = &item.expires_at {
            if exp.as_str() <= now.as_str() {
                continue;
            }
        }
        if let Some(sf) = source_filter {
            if item.source != sf {
                continue;
            }
        }
        hits.push(SearchHit {
            item,
            score: (1.0 - dist * dist / 2.0) as f32,
        });
        if hits.len() >= k {
            break;
        }
    }
    Ok(hits)
}

/// 过期物理删除（90 天滚动, D10）。返回删除条数。
pub fn purge_expired(conn: &Connection) -> Result<usize> {
    let now = now_local();
    let ids: Vec<i64> = {
        let mut st = conn.prepare(
            "SELECT id FROM memory_items WHERE expires_at IS NOT NULL AND expires_at <= ?1",
        )?;
        let mapped = st.query_map(params![now], |r| r.get(0))?;
        mapped.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for id in &ids {
        conn.execute("DELETE FROM memory_vectors WHERE rowid = ?1", params![id])?;
    }
    let n = conn.execute(
        "DELETE FROM memory_items WHERE expires_at IS NOT NULL AND expires_at <= ?1",
        params![now],
    )?;
    Ok(n)
}

/// 按域名物理删除（D10 域名级例外）
pub fn delete_by_domain(conn: &Connection, domain: &str) -> Result<usize> {
    let ids: Vec<i64> = {
        let mut st = conn.prepare("SELECT id FROM memory_items WHERE domain = ?1")?;
        let mapped = st.query_map(params![domain], |r| r.get(0))?;
        mapped.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for id in &ids {
        conn.execute("DELETE FROM memory_vectors WHERE rowid = ?1", params![id])?;
    }
    let n = conn.execute("DELETE FROM memory_items WHERE domain = ?1", params![domain])?;
    Ok(n)
}

/// 清空某来源全部索引（D10 一键清除）
pub fn clear_source(conn: &Connection, source: &str) -> Result<usize> {
    let ids: Vec<i64> = {
        let mut st = conn.prepare("SELECT id FROM memory_items WHERE source = ?1")?;
        let mapped = st.query_map(params![source], |r| r.get(0))?;
        mapped.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for id in &ids {
        conn.execute("DELETE FROM memory_vectors WHERE rowid = ?1", params![id])?;
    }
    let n = conn.execute("DELETE FROM memory_items WHERE source = ?1", params![source])?;
    Ok(n)
}
