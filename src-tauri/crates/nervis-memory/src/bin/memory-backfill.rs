//! memory-backfill: 已有数据回填（剪贴板文本 + notes 目录）+ 检索验证 + v1->v2 迁移重 embed
//!
//! 用法:
//!   memory-backfill                      # 回填（常规索引, 哈希去重）
//!   memory-backfill --remigrate          # 二期 N1: 存量 memory_items 全部重 embed（WeMM 2048d）
//!   memory-backfill --search "查询词"     # 检索验证
//! 环境变量: NERVIS_DB_PATH / NERVIS_NOTES_DIR / NERVIS_WEMM_MODEL_DIR / NERVIS_WEMM_PYTHON / NERVIS_WEMM_SERVER

use anyhow::{Context, Result};
use nervis_memory::chunk::{chunk_text, is_indexable, Chunk};
use nervis_memory::sidecar::{MemoryEmbedder, SidecarEmbedder};
use nervis_memory::store::{self, DocMeta, IndexOutcome};
use rusqlite::Connection;
use std::path::PathBuf;

fn data_base() -> Result<PathBuf> {
    Ok(dirs::data_dir().context("无法定位 app_data")?.join("com.flowhub.app"))
}

fn db_path() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("NERVIS_DB_PATH") {
        return Ok(PathBuf::from(p));
    }
    Ok(data_base()?.join("flowhub.db"))
}

fn notes_dir() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("NERVIS_NOTES_DIR") {
        return Ok(PathBuf::from(p));
    }
    Ok(data_base()?.join("notes"))
}

/// 单文档索引: 语义分片 → 增量索引（未变块复用向量零重 embed, CASE-003）
fn index_one(
    conn: &mut Connection,
    embedder: &mut SidecarEmbedder,
    meta: &DocMeta,
    text: &str,
) -> Result<IndexOutcome> {
    if !is_indexable(text) {
        return Ok(IndexOutcome::Indexed { total: 0, embedded: 0 });
    }
    let chunks = chunk_text(meta.title, text);
    if chunks.is_empty() {
        return Ok(IndexOutcome::Indexed { total: 0, embedded: 0 });
    }
    store::index_chunks(conn, meta, chunks, |texts| embedder.embed_documents(texts))
}

fn backfill(conn: &mut Connection, embedder: &mut SidecarEmbedder) -> Result<()> {
    let mut indexed = 0usize;
    let mut skipped = 0usize;

    // 剪贴板文本（不过期: 用户主动数据, D10）
    {
        let mut st = conn.prepare(
            "SELECT id, content, created_at FROM clipboard_history
             WHERE content_type = 'text' AND length(content) >= 30 ORDER BY id",
        )?;
        let rows: Vec<(i64, String, Option<String>)> = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<std::result::Result<_, _>>()?;
        drop(st);

        for (id, content, created_at) in &rows {
            let id_s = id.to_string();
            let title: String = content.chars().take(40).collect();
            let meta = DocMeta {
                source: "clipboard",
                source_ref: Some(&id_s),
                title: Some(title.as_str()),
                created_at: created_at.as_deref(),
                ..Default::default()
            };
            match index_one(conn, embedder, &meta, content)? {
                IndexOutcome::Indexed { total, .. } if total > 0 => indexed += total,
                IndexOutcome::SkippedUnchanged => skipped += 1,
                _ => {}
            }
        }
        println!("clipboard: {} rows scanned", rows.len());
    }

    // notes 目录（不过期）
    let notes = notes_dir()?;
    let mut note_files = Vec::new();
    collect_md(&notes, &mut note_files);
    for path in &note_files {
        let rel = path.strip_prefix(&notes).unwrap_or(path).to_string_lossy().replace('\\', "/");
        let text = std::fs::read_to_string(path).unwrap_or_default();
        let meta = DocMeta {
            source: "note",
            source_ref: Some(&rel),
            title: Some(&rel),
            ..Default::default()
        };
        match index_one(conn, embedder, &meta, &text)? {
            IndexOutcome::Indexed { total, .. } if total > 0 => indexed += total,
            IndexOutcome::SkippedUnchanged => skipped += 1,
            _ => {}
        }
    }
    println!("notes: {} files scanned", note_files.len());

    // 记忆事实（两级流水线的召回底座, D12: 短事实单 chunk 直索引, 不过期）
    {
        let mut st = conn.prepare("SELECT id, fact, created_at FROM memory_facts ORDER BY id")?;
        let rows: Vec<(i64, String, Option<i64>)> = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<std::result::Result<_, _>>()?;
        drop(st);
        for (id, fact, created_at) in &rows {
            let key = format!("fact:{id}");
            let created_s = created_at.and_then(|ts| {
                chrono::DateTime::from_timestamp(ts, 0)
                    .map(|t| t.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M:%S").to_string())
            });
            let meta = DocMeta {
                source: "memory_fact",
                source_ref: Some(&key),
                created_at: created_s.as_deref(),
                ..Default::default()
            };
            let outcome = store::index_chunks(
                conn,
                &meta,
                vec![Chunk { content: fact.clone(), embed_text: fact.clone() }],
                |texts| embedder.embed_documents(texts),
            )?;
            match outcome {
                IndexOutcome::Indexed { total, .. } if total > 0 => indexed += total,
                IndexOutcome::SkippedUnchanged => skipped += 1,
                _ => {}
            }
        }
        println!("memory_facts: {} rows scanned", rows.len());
    }

    let total: i64 = conn.query_row("SELECT COUNT(*) FROM memory_items", [], |r| r.get(0))?;
    println!("done: +{indexed} chunks indexed, {skipped} docs unchanged, memory_items total = {total}");
    Ok(())
}

fn collect_md(dir: &PathBuf, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_md(&p, out);
        } else if p.extension().is_some_and(|x| x == "md") {
            out.push(p);
        }
    }
}

fn run_search(conn: &Connection, embedder: &mut SidecarEmbedder, query: &str) -> Result<()> {
    let emb = embedder.embed_query(query)?;
    let hits = store::search(conn, &emb, 5, None)?;
    println!("query: {query}");
    for (i, h) in hits.iter().enumerate() {
        let snippet: String = h.item.content.chars().take(60).collect();
        println!(
            "  #{} {:.4} [{}] {} | {}",
            i + 1,
            h.score,
            h.item.source,
            h.item.title.as_deref().unwrap_or("-"),
            snippet.replace('\n', " ")
        );
    }
    Ok(())
}

/// v1->v2 迁移：对 memory_items 存量逐批重 embed（WeMM 2048d）。
/// 幂等：中断重跑无妨（INSERT OR REPLACE 按 rowid 覆盖）；全部完成才清 migration_pending。
fn remigrate(conn: &mut Connection, embedder: &mut SidecarEmbedder) -> Result<()> {
    if !store::migration_pending(conn) {
        println!("无待迁移数据（migration_pending != 1），跳过");
        return Ok(());
    }
    let rows: Vec<(i64, String)> = {
        let mut st = conn.prepare("SELECT id, content FROM memory_items ORDER BY id")?;
        let mapped = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        mapped.collect::<std::result::Result<_, _>>()?
    };
    println!("重 embed {} 条（WeMM 2048d）...", rows.len());
    const BATCH: usize = 32;
    let mut done = 0usize;
    for chunk in rows.chunks(BATCH) {
        let texts: Vec<String> = chunk.iter().map(|(_, c)| c.clone()).collect();
        let embs = embedder.embed_documents(&texts)?;
        let tx = conn.transaction()?;
        for ((id, _), emb) in chunk.iter().zip(embs) {
            store::write_vector(&tx, *id, &emb)?;
        }
        tx.commit()?;
        done += chunk.len();
        println!("  {done}/{}", rows.len());
    }
    store::migration_done(conn)?;
    println!("迁移完成：migration_pending 已清除");
    Ok(())
}

fn main() -> Result<()> {
    store::register_vec_extension(); // 必须先于 Connection::open
    let mut embedder = SidecarEmbedder::resolve_default()?;
    let mut conn = Connection::open(db_path()?)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    store::init_memory_tables(&conn)?;

    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--remigrate") {
        return remigrate(&mut conn, &mut embedder);
    }
    match args.iter().position(|a| a == "--search") {
        Some(i) => {
            let q = args.get(i + 1).context("--search 需要查询词")?;
            run_search(&conn, &mut embedder, q)
        }
        None => backfill(&mut conn, &mut embedder),
    }
}
