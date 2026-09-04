//! sqlite-vec 向量库: memory_items 元数据 + memory_vectors vec0 虚拟表，同库 flowhub.db
//!
//! 决策依据 D7/D10/D11 + 二期裁决 CASE-007:
//! - 向量进 flowhub.db, 与 clipboard/notes 同库 JOIN, 暴力扫描规模足够
//! - URL 级去重 + 内容哈希判变更 (D11); CASE-003: plan/commit 增量索引——
//!   哈希对 embed_text 计算，命中块复用向量零重 embed，未变块 rowid/向量不动
//! - 二期 Q9: 全部数据永久保留（推翻一期 90 天滚动）, expires_at 恒 NULL, 保留期配置与滚动清理已撤除
//! - 二期 N0: WeMM-2B 2048 全维（512 截断裸查询不过线弃用）, schema v1->v2 迁移重建 vec 表

use crate::chunk::{content_hash, Chunk};
use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};

/// WeMM-Embedding-2B 全维输出（N0: 2048d+指令 top-3 94%; 换模型时同步改这里并重建 memory_vectors）
pub const EMBEDDING_DIM: usize = 2048;
/// schema 版本: v1=bge 512d + 90 天滚动（一期）; v2=WeMM 2048d + 全永久 + modality（二期 N1）
pub const SCHEMA_VERSION: i64 = 2;
/// 检索过滤时的过取倍数（来源过滤后再截断）
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
    /// 模态: text | image | video（N1 起写入, 老数据迁移默认 text; N2/N3 图片视频用）
    pub modality: String,
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
    /// 模态（默认 text）
    pub modality: Option<&'a str>,
    /// 自定义去重键（默认 url 或 source_ref；N2 主图用 url+"#img" 与正文区分）
    pub dedup_key: Option<&'a str>,
    pub created_at: Option<&'a str>,
    pub expires_at: Option<&'a str>,
}

#[derive(Debug, PartialEq)]
pub enum IndexOutcome {
    /// 全部块哈希命中存量且行数一致, 未触碰（D11 去重）
    SkippedUnchanged,
    /// total: 文档总块数; embedded: 实际重 embed 的块数（增量索引, CASE-003）
    Indexed { total: usize, embedded: usize },
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

/// 建表（vec0 扩展已通过 register_vec_extension 全局注册）+ v1->v2 迁移检查
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
            modality TEXT NOT NULL DEFAULT 'text',
            created_at TEXT,
            indexed_at TEXT NOT NULL,
            expires_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_memory_dedup ON memory_items(source, dedup_key);
        CREATE INDEX IF NOT EXISTS idx_memory_domain ON memory_items(domain);
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
    migrate_schema(conn)?;
    // modality 索引必须在迁移后建：老库的 ALTER ADD COLUMN 发生在 migrate_schema 里，
    // 放主批量会因列不存在报错（老库 CREATE TABLE IF NOT EXISTS 跳过不更新定义）
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_memory_modality ON memory_items(modality);",
    )?;
    Ok(())
}

fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM memory_meta WHERE key = ?1",
        params![key],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO memory_meta(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// v1(bge 512d/90 天滚动) -> v2(WeMM 2048d/全永久/modality)：
/// 旧向量空间不兼容直接 DROP（bge 向量无法迁移, 内容原文在库待重 embed）;
/// expires_at 全清（Q9 全永久, 否则老数据到期会被 search 过滤「被消失」）;
/// 标 migration_pending, 由 backfill 工具重 embed 后清除。
fn migrate_schema(conn: &Connection) -> Result<()> {
    let version: i64 = meta_get(conn, "schema_version")
        .and_then(|v| v.parse().ok())
        .unwrap_or(1);
    if version >= SCHEMA_VERSION {
        return Ok(());
    }

    // 老库补 modality 列（新库 CREATE 已含; ALTER 重复执行报错, 先探测）
    let has_modality: bool = conn
        .prepare("SELECT modality FROM memory_items LIMIT 0")
        .is_ok();
    if !has_modality {
        conn.execute(
            "ALTER TABLE memory_items ADD COLUMN modality TEXT NOT NULL DEFAULT 'text'",
            [],
        )?;
    }

    let item_count: i64 = conn.query_row("SELECT COUNT(*) FROM memory_items", [], |r| r.get(0))?;
    conn.execute_batch(
        "DROP TABLE IF EXISTS memory_vectors;
         UPDATE memory_items SET expires_at = NULL;",
    )?;
    // vec 表由 init 的 CREATE IF NOT EXISTS 在下次调用重建? —— 不行, 本次 init 已建过(512d 旧定义
    // 只存在于 v1 库; v2 代码建表即 2048d)。此处 DROP 的是 v1 旧表, 立即按 v2 定义重建:
    conn.execute_batch(&format!(
        "CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
            embedding float[{EMBEDDING_DIM}]
        );"
    ))?;

    if item_count > 0 {
        meta_set(conn, "migration_pending", "1")?;
    }
    meta_set(conn, "schema_version", &SCHEMA_VERSION.to_string())?;
    Ok(())
}

/// 是否存在待重 embed 的存量数据（v1->v2 迁移后置位）
pub fn migration_pending(conn: &Connection) -> bool {
    meta_get(conn, "migration_pending").as_deref() == Some("1")
}

/// 重 embed 完成后调用：清除待迁移标记
pub fn migration_done(conn: &Connection) -> Result<()> {
    meta_set(conn, "migration_pending", "0")
}

/// 迁移专用：对存量行直接写回向量（绕过 index_document 的哈希去重——
/// v1->v2 内容哈希未变但向量空间已换，去重判定会误跳）
pub fn write_vector(conn: &Connection, rowid: i64, emb: &[f32]) -> Result<()> {
    anyhow::ensure!(
        emb.len() == EMBEDDING_DIM,
        "embedding 维度 {} 与库定义 {} 不符",
        emb.len(),
        EMBEDDING_DIM
    );
    conn.execute(
        "INSERT OR REPLACE INTO memory_vectors(rowid, embedding) VALUES (?1, ?2)",
        params![rowid, emb_to_bytes(emb)],
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

/// popup「最近索引」条目：按基础 url 聚合的页面级统计（画面/字幕段数 + 文本块数）
#[derive(Debug, Clone, Serialize)]
pub struct RecentPage {
    /// 剥离 ?t=/&t= 段级后缀后的页面 url
    pub url: String,
    pub title: Option<String>,
    pub video_segments: i64,
    pub subtitle_segments: i64,
    /// 文本块数（browser 来源非 video 条目：正文块 + 页面主图）
    pub text_chunks: i64,
    pub last_indexed: String,
}

/// 最近索引的页面列表（扩展 popup 仪表盘用）：
/// 画面段（modality=video）与字幕段（source=subtitle）的 url 都带 ?t=/&t= 段级后缀，
/// 按剥离后缀的基础 url 分组聚合，各源只计自己的段数；正文块与主图计 text_chunks。
pub fn recent_pages(conn: &Connection, limit: i64) -> Result<Vec<RecentPage>> {
    let mut st = conn.prepare(
        // RTRIM 尾斜杠归一：BV 页带不带 / 是同一视频（e2e 直发与页面采集会产生两种形态）
        "SELECT
           RTRIM(CASE
             WHEN instr(url, '?t=') > 0 THEN substr(url, 1, instr(url, '?t=') - 1)
             WHEN instr(url, '&t=') > 0 THEN substr(url, 1, instr(url, '&t=') - 1)
             ELSE url
           END, '/') AS base_url,
           MAX(title),
           SUM(CASE WHEN modality = 'video' THEN 1 ELSE 0 END),
           SUM(CASE WHEN source = 'subtitle' THEN 1 ELSE 0 END),
           SUM(CASE WHEN modality != 'video' AND source != 'subtitle' THEN 1 ELSE 0 END),
           MAX(indexed_at)
         FROM memory_items
         WHERE source IN ('browser', 'subtitle')
         GROUP BY base_url
         ORDER BY MAX(indexed_at) DESC
         LIMIT ?1",
    )?;
    let mapped = st.query_map(params![limit], |r| {
        Ok(RecentPage {
            url: r.get(0)?,
            title: r.get(1)?,
            video_segments: r.get(2)?,
            subtitle_segments: r.get(3)?,
            text_chunks: r.get(4)?,
            last_indexed: r.get(5)?,
        })
    })?;
    Ok(mapped.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// 去重键推导：dedup_key > url > source_ref（plan/commit 共用同一推导，保证一致）
pub fn resolve_dedup_key<'a>(meta: &'a DocMeta<'a>) -> Result<&'a str> {
    meta.dedup_key
        .or(meta.url)
        .or(meta.source_ref)
        .context("DocMeta 缺 dedup_key/url/source_ref, 无法去重")
}

/// 增量索引的待索引块（plan_index 输出 / commit_index 输入）
#[derive(Debug)]
pub struct PlannedChunk {
    pub chunk_index: i64,
    /// 入库文本（展示用）
    pub content: String,
    /// embed_text 的 xxh3（标题/overlap 变更同样触发重 embed）
    pub content_hash: String,
    /// embed 输入文本（仅 reuse_rowid=None 的块需要送 embedding）
    pub embed_text: String,
    /// 内容哈希命中存量同 key 块 → 复用该行向量，无需 embed
    pub reuse_rowid: Option<i64>,
}

/// plan（CASE-003 增量索引第一步）：比对存量 (id, content_hash)，按哈希匹配标出可复用块。
/// 同文档内同内容块多次出现按 id 序消费，块移动位置也复用。
pub fn plan_index(
    conn: &Connection,
    source: &str,
    dedup_key: &str,
    chunks: Vec<Chunk>,
) -> Result<Vec<PlannedChunk>> {
    let existing: Vec<(i64, String)> = {
        let mut st = conn.prepare(
            "SELECT id, content_hash FROM memory_items WHERE source = ?1 AND dedup_key = ?2 ORDER BY id",
        )?;
        let mapped = st.query_map(params![source, dedup_key], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        mapped.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let mut pool: HashMap<String, VecDeque<i64>> = HashMap::new();
    for (id, hash) in existing {
        pool.entry(hash).or_default().push_back(id);
    }
    Ok(chunks
        .into_iter()
        .enumerate()
        .map(|(i, c)| {
            let hash = content_hash(&c.embed_text);
            let reuse_rowid = pool.get_mut(&hash).and_then(|q| q.pop_front());
            PlannedChunk {
                chunk_index: i as i64,
                content: c.content,
                content_hash: hash,
                embed_text: c.embed_text,
                reuse_rowid,
            }
        })
        .collect())
}

/// commit（CASE-003 增量索引第二步）：事务内「删旧 / 复用 UPDATE / 新块 INSERT」。
/// embeddings 按 chunk_index 取向量（仅 reuse_rowid=None 的块需要）。
/// 全部块复用且行数一致 → SkippedUnchanged（不触碰 indexed_at）；
/// 复用块刷新元数据但 rowid/向量不动（向量零重算）。
pub fn commit_index(
    conn: &mut Connection,
    meta: &DocMeta,
    planned: Vec<PlannedChunk>,
    embeddings: &HashMap<i64, Vec<f32>>,
) -> Result<IndexOutcome> {
    let dedup_key = resolve_dedup_key(meta)?;

    let existing_ids: Vec<i64> = {
        let mut st = conn.prepare(
            "SELECT id FROM memory_items WHERE source = ?1 AND dedup_key = ?2 ORDER BY id",
        )?;
        let mapped = st.query_map(params![meta.source, dedup_key], |r| r.get(0))?;
        mapped.collect::<std::result::Result<Vec<_>, _>>()?
    };
    let reuse_set: HashSet<i64> = planned.iter().filter_map(|p| p.reuse_rowid).collect();

    let all_reused = planned.len() == existing_ids.len()
        && planned.iter().all(|p| p.reuse_rowid.is_some())
        && existing_ids.iter().all(|id| reuse_set.contains(id));
    if all_reused {
        return Ok(IndexOutcome::SkippedUnchanged);
    }

    let tx = conn.transaction()?;

    // 删不再需要的旧行 + 旧向量
    for id in &existing_ids {
        if !reuse_set.contains(id) {
            tx.execute("DELETE FROM memory_vectors WHERE rowid = ?1", params![id])?;
            tx.execute("DELETE FROM memory_items WHERE id = ?1", params![id])?;
        }
    }

    let now = now_local();
    let modality = meta.modality.unwrap_or("text");
    let mut embedded = 0usize;
    for p in &planned {
        if let Some(rowid) = p.reuse_rowid {
            // 并发兜底：plan 与 commit 之间复用行被外部改动（按 source+dedup_key 隔离实际不可达）
            let still_there: bool = tx
                .query_row(
                    "SELECT COUNT(*) FROM memory_items WHERE id = ?1 AND source = ?2 AND dedup_key = ?3",
                    params![rowid, meta.source, dedup_key],
                    |r| r.get::<_, i64>(0),
                )? > 0;
            anyhow::ensure!(still_there, "复用行 {rowid} 在 plan 后被并发修改，请整体重试");
            // 复用：刷新元数据，rowid/向量不动
            tx.execute(
                "UPDATE memory_items SET chunk_index = ?1, content = ?2, content_hash = ?3,
                     source_ref = ?4, url = ?5, domain = ?6, title = ?7, modality = ?8,
                     created_at = ?9, indexed_at = ?10, expires_at = ?11
                 WHERE id = ?12",
                params![
                    p.chunk_index, p.content, p.content_hash,
                    meta.source_ref, meta.url, meta.domain, meta.title, modality,
                    meta.created_at, now, meta.expires_at, rowid,
                ],
            )?;
        } else {
            let emb = embeddings
                .get(&p.chunk_index)
                .with_context(|| format!("缺 chunk {} 的向量", p.chunk_index))?;
            anyhow::ensure!(
                emb.len() == EMBEDDING_DIM,
                "embedding 维度 {} 与库定义 {} 不符",
                emb.len(),
                EMBEDDING_DIM
            );
            tx.execute(
                "INSERT INTO memory_items
                 (source, source_ref, url, domain, title, dedup_key, chunk_index, content, content_hash, modality, created_at, indexed_at, expires_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                params![
                    meta.source, meta.source_ref, meta.url, meta.domain, meta.title,
                    dedup_key, p.chunk_index, p.content, p.content_hash, modality,
                    meta.created_at, now, meta.expires_at,
                ],
            )?;
            let rowid = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO memory_vectors(rowid, embedding) VALUES (?1, ?2)",
                params![rowid, emb_to_bytes(emb)],
            )?;
            embedded += 1;
        }
    }
    let total = planned.len();
    tx.commit()?;
    Ok(IndexOutcome::Indexed { total, embedded })
}

/// 文本文档一站式索引：plan → 只对变更块 embed（回调）→ commit。
pub fn index_chunks(
    conn: &mut Connection,
    meta: &DocMeta,
    chunks: Vec<Chunk>,
    embed: impl FnOnce(&[String]) -> Result<Vec<Vec<f32>>>,
) -> Result<IndexOutcome> {
    let dedup_key = resolve_dedup_key(meta)?;
    let planned = plan_index(conn, meta.source, dedup_key, chunks)?;
    let texts: Vec<String> = planned
        .iter()
        .filter(|p| p.reuse_rowid.is_none())
        .map(|p| p.embed_text.clone())
        .collect();
    let vectors = if texts.is_empty() {
        Vec::new()
    } else {
        embed(&texts)?
    };
    anyhow::ensure!(
        vectors.len() == texts.len(),
        "embed 返回数量 {} 与请求 {} 不符",
        vectors.len(),
        texts.len()
    );
    let mut embeddings = HashMap::new();
    let mut it = vectors.into_iter();
    for p in &planned {
        if p.reuse_rowid.is_none() {
            embeddings.insert(p.chunk_index, it.next().expect("数量已校验"));
        }
    }
    commit_index(conn, meta, planned, &embeddings)
}

/// 非文本向量单块直索引（视频画面段/主图：向量已由调用方算好）。
/// 单块无增量意义：哈希命中 → SkippedUnchanged；否则替换写入。
pub fn index_single_with_vector(
    conn: &mut Connection,
    meta: &DocMeta,
    content: String,
    vector: Vec<f32>,
) -> Result<IndexOutcome> {
    let dedup_key = resolve_dedup_key(meta)?;
    let planned = plan_index(
        conn,
        meta.source,
        dedup_key,
        vec![Chunk { embed_text: content.clone(), content }],
    )?;
    let mut embeddings = HashMap::new();
    if let Some(p) = planned.first() {
        if p.reuse_rowid.is_none() {
            embeddings.insert(p.chunk_index, vector);
        }
    }
    commit_index(conn, meta, planned, &embeddings)
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
    let mut hits = Vec::with_capacity(k);
    for (rowid, dist) in knn {
        let item = conn.query_row(
            "SELECT id, source, source_ref, url, domain, title, chunk_index, content, content_hash, modality, created_at, indexed_at, expires_at
             FROM memory_items WHERE id = ?1",
            params![rowid],
            |r| {
                Ok(MemoryItem {
                    id: r.get(0)?, source: r.get(1)?, source_ref: r.get(2)?,
                    url: r.get(3)?, domain: r.get(4)?, title: r.get(5)?,
                    chunk_index: r.get(6)?, content: r.get(7)?, content_hash: r.get(8)?,
                    modality: r.get(9)?,
                    created_at: r.get(10)?, indexed_at: r.get(11)?, expires_at: r.get(12)?,
                })
            },
        );
        let Ok(item) = item else { continue };
        // Q9 全永久: 不再做过期过滤（expires_at 迁移时已全清, 新数据恒 NULL）
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

/// 最近索引的条目（知识页空查询浏览态, P3）：按 indexed_at 倒序，同刻按 id 倒序（后入库优先）
pub fn recent_items(conn: &Connection, limit: i64) -> Result<Vec<MemoryItem>> {
    let mut st = conn.prepare(
        "SELECT id, source, source_ref, url, domain, title, chunk_index, content, content_hash, modality, created_at, indexed_at, expires_at
         FROM memory_items ORDER BY indexed_at DESC, id DESC LIMIT ?1",
    )?;
    let mapped = st.query_map(params![limit], |r| {
        Ok(MemoryItem {
            id: r.get(0)?, source: r.get(1)?, source_ref: r.get(2)?,
            url: r.get(3)?, domain: r.get(4)?, title: r.get(5)?,
            chunk_index: r.get(6)?, content: r.get(7)?, content_hash: r.get(8)?,
            modality: r.get(9)?,
            created_at: r.get(10)?, indexed_at: r.get(11)?, expires_at: r.get(12)?,
        })
    })?;
    Ok(mapped.collect::<std::result::Result<Vec<_>, _>>()?)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        register_vec_extension();
        let conn = Connection::open_in_memory().unwrap();
        init_memory_tables(&conn).unwrap();
        conn
    }

    fn chunk(text: &str) -> Chunk {
        Chunk { content: text.into(), embed_text: text.into() }
    }

    fn meta() -> DocMeta<'static> {
        DocMeta { source: "browser", url: Some("https://a.com/x"), ..Default::default() }
    }

    fn fake_emb(seed: f32) -> Vec<f32> {
        vec![seed; EMBEDDING_DIM]
    }

    /// 便捷：plan + 全量假向量 commit（模拟 embed 回调按序给 1.0/2.0/3.0…）
    fn run_index(conn: &mut Connection, chunks: Vec<Chunk>) -> IndexOutcome {
        index_chunks(conn, &meta(), chunks, |texts| {
            Ok(texts.iter().enumerate().map(|(i, _)| fake_emb(i as f32 + 1.0)).collect())
        })
        .unwrap()
    }

    fn rowids(conn: &Connection) -> Vec<i64> {
        let mut st = conn
            .prepare("SELECT id FROM memory_items WHERE source = 'browser' ORDER BY chunk_index")
            .unwrap();
        st.query_map([], |r| r.get(0))
            .unwrap()
            .collect::<std::result::Result<Vec<_>, _>>()
            .unwrap()
    }

    #[test]
    fn fresh_index_writes_all_chunks() {
        let mut conn = setup();
        let outcome = run_index(&mut conn, vec![chunk("甲"), chunk("乙"), chunk("丙")]);
        assert_eq!(outcome, IndexOutcome::Indexed { total: 3, embedded: 3 });
        assert_eq!(rowids(&conn).len(), 3);
    }

    #[test]
    fn unchanged_skips() {
        let mut conn = setup();
        run_index(&mut conn, vec![chunk("甲"), chunk("乙")]);
        let outcome = run_index(&mut conn, vec![chunk("甲"), chunk("乙")]);
        assert_eq!(outcome, IndexOutcome::SkippedUnchanged);
    }

    #[test]
    fn partial_change_reembeds_only_changed_chunk() {
        let mut conn = setup();
        run_index(&mut conn, vec![chunk("甲"), chunk("乙"), chunk("丙")]);
        let before = rowids(&conn);
        let vec_before: Vec<u8> = conn
            .query_row("SELECT embedding FROM memory_vectors WHERE rowid = ?1", [before[0]], |r| {
                r.get(0)
            })
            .unwrap();

        // 改中间一块：embedded=1，首尾块 rowid/向量原样保留
        let outcome = run_index(&mut conn, vec![chunk("甲"), chunk("乙改"), chunk("丙")]);
        assert_eq!(outcome, IndexOutcome::Indexed { total: 3, embedded: 1 });
        let after = rowids(&conn);
        assert_eq!(before[0], after[0], "首块 rowid 应复用");
        assert_eq!(before[2], after[2], "尾块 rowid 应复用");
        let vec_after: Vec<u8> = conn
            .query_row("SELECT embedding FROM memory_vectors WHERE rowid = ?1", [after[0]], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(vec_before, vec_after, "复用块向量不应被触碰");
    }

    #[test]
    fn shrink_removes_stale_rows() {
        let mut conn = setup();
        run_index(&mut conn, vec![chunk("甲"), chunk("乙"), chunk("丙")]);
        let outcome = run_index(&mut conn, vec![chunk("甲"), chunk("丙")]);
        // 结构变更零 embed：丙移动位置仍按哈希复用
        assert_eq!(outcome, IndexOutcome::Indexed { total: 2, embedded: 0 });
        assert_eq!(rowids(&conn).len(), 2);
        let contents: Vec<String> = {
            let mut st = conn
                .prepare("SELECT content FROM memory_items WHERE source = 'browser' ORDER BY chunk_index")
                .unwrap();
            st.query_map([], |r| r.get(0))
                .unwrap()
                .collect::<std::result::Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(contents, vec!["甲".to_string(), "丙".to_string()]);
    }

    #[test]
    fn missing_embedding_errors() {
        let mut conn = setup();
        let planned = plan_index(&conn, "browser", "https://a.com/x", vec![chunk("甲")]).unwrap();
        let result = commit_index(&mut conn, &meta(), planned, &HashMap::new());
        assert!(result.is_err());
    }
}
