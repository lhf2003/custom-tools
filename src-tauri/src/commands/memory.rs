//! 记忆检索命令（M3: 启动器语义分组 + `s ` 前缀全量模式）
//! 设计: docs/architecture/2026-08-27-CASE-001-多模态记忆检索系统设计_01.md D5
//!
//! 延迟预算: embed ~10ms + vec0 暴力扫描 ~10ms, spawn_blocking 不阻塞主线程。
//! Embedder 懒加载（首次检索时加载 95MB 模型, 之后常驻内存 ~150MB, 在 300MB 预算内）。

use crate::db::DatabaseState;
use nervis_memory::embed::{resolve_model_dir, Embedder};
use nervis_memory::store;
use rusqlite::Connection;
use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

/// Embedder 懒加载容器（ort Session 非 Sync, Mutex 兜底；Arc 供 spawn_blocking 持有）
pub struct MemoryEmbedderState(pub std::sync::Arc<Mutex<Option<Embedder>>>);

#[derive(Serialize)]
pub struct MemoryHitDto {
    pub id: i64,
    pub source: String,
    pub title: Option<String>,
    pub url: Option<String>,
    pub domain: Option<String>,
    pub snippet: String,
    pub score: f32,
    pub created_at: Option<String>,
    pub indexed_at: String,
}

#[derive(Serialize)]
pub struct MemoryOpenResult {
    /// opened_url: 已在后端打开浏览器 | copy_content: 前端复制 content | open_note: 前端跳笔记
    pub action: String,
    pub content: Option<String>,
    pub source_ref: Option<String>,
}

#[tauri::command]
pub async fn memory_search(
    query: String,
    k: Option<usize>,
    state: State<'_, MemoryEmbedderState>,
    db: State<'_, DatabaseState>,
) -> Result<Vec<MemoryHitDto>, String> {
    let db_path = db.0.clone();
    let embedder_arc = state.0.clone();
    tokio::task::spawn_blocking(move || {
        nervis_memory::embed::init_ort(None).map_err(|e| e.to_string())?;

        let mut guard = embedder_arc.lock().map_err(|e| format!("embedder lock: {e}"))?;
        if guard.is_none() {
            let dir = resolve_model_dir().map_err(|e| e.to_string())?;
            *guard = Some(Embedder::new(&dir).map_err(|e| e.to_string())?);
        }
        let embedder = guard.as_mut().expect("embedder just initialized");
        let emb = embedder.embed_query(&query).map_err(|e| e.to_string())?;
        drop(guard); // 检索不占用 embedder 锁

        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        let hits = store::search(&conn, &emb, k.unwrap_or(5), None).map_err(|e| e.to_string())?;
        Ok(hits
            .into_iter()
            .map(|h| MemoryHitDto {
                id: h.item.id,
                source: h.item.source,
                title: h.item.title,
                url: h.item.url,
                domain: h.item.domain,
                snippet: h.item.content.chars().take(120).collect(),
                score: h.score,
                created_at: h.item.created_at,
                indexed_at: h.item.indexed_at,
            })
            .collect())
    })
    .await
    .map_err(|e| format!("memory_search join: {e}"))?
}

#[tauri::command]
pub async fn memory_open(id: i64, db: State<'_, DatabaseState>) -> Result<MemoryOpenResult, String> {
    let db_path = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        let row = conn.query_row(
            "SELECT source, url, content, source_ref FROM memory_items WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            },
        );
        let (source, url, content, source_ref) = match row {
            Ok(v) => v,
            Err(rusqlite::Error::QueryReturnedNoRows) => return Err("记忆条目不存在".to_string()),
            Err(e) => return Err(e.to_string()),
        };

        match source.as_str() {
            // 浏览页/字幕段: 后端直接开浏览器（字幕 url 自带 #t= 秒级锚点）
            "browser" | "subtitle" => {
                let url = url.ok_or("该条目没有 URL")?;
                open::that(&url).map_err(|e| format!("打开链接失败: {e}"))?;
                Ok(MemoryOpenResult { action: "opened_url".into(), content: None, source_ref: None })
            }
            // 笔记: 前端跳笔记视图
            "note" => Ok(MemoryOpenResult { action: "open_note".into(), content: None, source_ref }),
            // 剪贴板及其他: 内容交回前端复制
            _ => Ok(MemoryOpenResult { action: "copy_content".into(), content: Some(content), source_ref }),
        }
    })
    .await
    .map_err(|e| format!("memory_open join: {e}"))?
}

// ---------- M4: 隐私控制（黑名单/保留期/一键清除/统计, SQLite 单真源） ----------

#[tauri::command]
pub async fn memory_get_blacklist(db: State<'_, DatabaseState>) -> Result<Vec<String>, String> {
    let db_path = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        store::list_blacklist(&conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("memory_get_blacklist join: {e}"))?
}

/// 拉黑域名：入库 + 物理清除该域存量索引（与扩展「不再索引此站点」同一语义, D10）
#[tauri::command]
pub async fn memory_add_blacklist(
    domain: String,
    db: State<'_, DatabaseState>,
) -> Result<Vec<String>, String> {
    let db_path = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        store::add_blacklist(&conn, &domain).map_err(|e| e.to_string())?;
        store::delete_by_domain(&conn, &domain).map_err(|e| e.to_string())?;
        store::list_blacklist(&conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("memory_add_blacklist join: {e}"))?
}

#[tauri::command]
pub async fn memory_remove_blacklist(
    domain: String,
    db: State<'_, DatabaseState>,
) -> Result<Vec<String>, String> {
    let db_path = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        store::remove_blacklist(&conn, &domain).map_err(|e| e.to_string())?;
        store::list_blacklist(&conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("memory_remove_blacklist join: {e}"))?
}

#[tauri::command]
pub async fn memory_get_retention(db: State<'_, DatabaseState>) -> Result<i64, String> {
    let db_path = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        Ok(store::get_retention_days(&conn))
    })
    .await
    .map_err(|e| format!("memory_get_retention join: {e}"))?
}

#[tauri::command]
pub async fn memory_set_retention(days: i64, db: State<'_, DatabaseState>) -> Result<(), String> {
    let db_path = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        store::set_retention_days(&conn, days).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("memory_set_retention join: {e}"))?
}

/// 一键清除浏览索引（页面 + 字幕, 剪贴板/笔记/记忆不受影响, D10）
#[tauri::command]
pub async fn memory_clear_browsing(db: State<'_, DatabaseState>) -> Result<usize, String> {
    let db_path = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        let n = store::clear_source(&conn, "browser").map_err(|e| e.to_string())?
            + store::clear_source(&conn, "subtitle").map_err(|e| e.to_string())?;
        Ok(n)
    })
    .await
    .map_err(|e| format!("memory_clear_browsing join: {e}"))?
}

/// 各来源条目统计（隐私仪表盘）
#[tauri::command]
pub async fn memory_source_stats(db: State<'_, DatabaseState>) -> Result<Vec<(String, i64)>, String> {
    let db_path = db.0.clone();
    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        store::source_stats(&conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("memory_source_stats join: {e}"))?
}

/// 过期浏览数据物理清除（启动 + 24h 周期调用, D10 滚动删除的执行点）
pub fn purge_expired_now(db_path: &std::path::Path) {
    match Connection::open(db_path)
        .map_err(|e| e.to_string())
        .and_then(|conn| store::purge_expired(&conn).map_err(|e| e.to_string()))
    {
        Ok(n) if n > 0 => log::info!("记忆库过期清理: 物理删除 {} 条", n),
        Ok(_) => {}
        Err(e) => log::warn!("记忆库过期清理失败: {}", e),
    }
}
