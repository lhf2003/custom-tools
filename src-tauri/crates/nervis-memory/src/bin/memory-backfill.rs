//! memory-backfill: 已有数据回填（剪贴板文本 + notes 目录）+ 检索验证
//!
//! 用法:
//!   memory-backfill                      # 回填
//!   memory-backfill --search "查询词"     # 检索验证
//! 环境变量: NERVIS_DB_PATH / NERVIS_MODEL_DIR / NERVIS_NOTES_DIR / ORT_DYLIB_PATH

use anyhow::{Context, Result};
use nervis_memory::chunk::{chunk_text, content_hash, is_indexable};
use nervis_memory::embed::{init_ort, resolve_model_dir, Embedder};
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

/// 单文档索引: 切块 → 批量 embed → 带去重写入
fn index_one(
    conn: &mut Connection,
    embedder: &mut Embedder,
    meta: &DocMeta,
    text: &str,
) -> Result<IndexOutcome> {
    if !is_indexable(text) {
        return Ok(IndexOutcome::Indexed(0));
    }
    let chunks = chunk_text(text);
    let embeddings = embedder.embed_documents(&chunks)?;
    let rows: Vec<_> = chunks
        .iter()
        .enumerate()
        .map(|(i, c)| (i as i64, c.clone(), content_hash(c), embeddings[i].clone()))
        .collect();
    store::index_document(conn, meta, &rows)
}

fn backfill(conn: &mut Connection, embedder: &mut Embedder) -> Result<()> {
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
                IndexOutcome::Indexed(n) if n > 0 => indexed += n,
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
            IndexOutcome::Indexed(n) if n > 0 => indexed += n,
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
            let emb = embedder.embed_documents(std::slice::from_ref(fact))?;
            let row = vec![(0i64, fact.clone(), content_hash(fact), emb[0].clone())];
            match store::index_document(conn, &meta, &row)? {
                IndexOutcome::Indexed(n) if n > 0 => indexed += n,
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

fn run_search(conn: &Connection, embedder: &mut Embedder, query: &str) -> Result<()> {
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

fn main() -> Result<()> {
    store::register_vec_extension(); // 必须先于 Connection::open
    init_ort(None)?;
    let mut embedder = Embedder::new(&resolve_model_dir()?)?;
    let mut conn = Connection::open(db_path()?)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    store::init_memory_tables(&conn)?;

    let args: Vec<String> = std::env::args().collect();
    match args.iter().position(|a| a == "--search") {
        Some(i) => {
            let q = args.get(i + 1).context("--search 需要查询词")?;
            run_search(&conn, &mut embedder, q)
        }
        None => backfill(&mut conn, &mut embedder),
    }
}
