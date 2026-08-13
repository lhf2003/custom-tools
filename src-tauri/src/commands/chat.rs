use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::db::DatabaseState;

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatHistoryMessage {
    pub id: i64,
    pub role: String,
    pub content: String,
    pub content_type: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatSessionSummary {
    pub id: i64,
    pub preview: String,
    pub updated_at: String,
}

/// 创建新会话，返回 session_id
#[tauri::command]
pub fn create_chat_session(db_state: State<DatabaseState>, mode: String) -> Result<i64, String> {
    let conn = crate::db::open_connection(&db_state.0).map_err(|e| e.to_string())?;
    // 显式写本地时间：SQLite CURRENT_TIMESTAMP 是 UTC，与展示口径（北京时间）差 8 小时
    conn.execute(
        "INSERT INTO chat_sessions (mode, created_at, updated_at) VALUES (?1, datetime('now','localtime'), datetime('now','localtime'))",
        params![mode],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

/// 追加一条消息到指定会话
#[tauri::command]
pub fn save_chat_message(
    db_state: State<DatabaseState>,
    session_id: i64,
    role: String,
    content: String,
    content_type: Option<String>,
) -> Result<(), String> {
    let conn = crate::db::open_connection(&db_state.0).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO chat_messages (session_id, role, content, content_type, created_at) VALUES (?1, ?2, ?3, ?4, datetime('now','localtime'))",
        params![session_id, role, content, content_type.as_deref().unwrap_or("markdown")],
    )
    .map_err(|e| e.to_string())?;
    // 更新会话的 updated_at（本地时间，口径同上）
    conn.execute(
        "UPDATE chat_sessions SET updated_at = datetime('now','localtime') WHERE id = ?1",
        params![session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 获取会话的全部消息
#[tauri::command]
pub fn get_session_messages(
    db_state: State<DatabaseState>,
    session_id: i64,
) -> Result<Vec<ChatHistoryMessage>, String> {
    let conn = crate::db::open_connection(&db_state.0).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, role, content, content_type FROM chat_messages WHERE session_id = ?1 ORDER BY id ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![session_id], |row| {
            Ok(ChatHistoryMessage {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
                content_type: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// 获取同 mode 下最近一次会话的 id
#[tauri::command]
pub fn get_latest_session(
    db_state: State<DatabaseState>,
    mode: String,
) -> Result<Option<i64>, String> {
    let conn = crate::db::open_connection(&db_state.0).map_err(|e| e.to_string())?;
    let result = conn.query_row(
        "SELECT id FROM chat_sessions WHERE mode = ?1 ORDER BY updated_at DESC LIMIT 1",
        params![mode],
        |row| row.get::<_, i64>(0),
    );

    match result {
        Ok(id) => Ok(Some(id)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// 列出同 mode 下的历史会话（最近更新倒序，封顶 50 条）。
/// 摘要取首条用户消息；无消息的空会话不进列表。
#[tauri::command]
pub fn list_chat_sessions(
    db_state: State<DatabaseState>,
    mode: String,
) -> Result<Vec<ChatSessionSummary>, String> {
    let conn = crate::db::open_connection(&db_state.0).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT s.id,
                    (SELECT m.content FROM chat_messages m
                      WHERE m.session_id = s.id AND m.role = 'user'
                      ORDER BY m.id ASC LIMIT 1) AS preview,
                    s.updated_at
             FROM chat_sessions s
             WHERE s.mode = ?1
               AND EXISTS (SELECT 1 FROM chat_messages m2 WHERE m2.session_id = s.id)
             ORDER BY s.updated_at DESC
             LIMIT 50",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![mode], |row| {
            Ok(ChatSessionSummary {
                id: row.get(0)?,
                preview: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                updated_at: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

/// 删除会话中最后一条用户消息之后的所有消息（重试上一轮回服用：
/// 文字回复与其 tool 循环中途落的 A2UI 卡片行一并清除，回到「待回答」状态）。
/// 子查询为 NULL（会话里没有用户消息）时 `id > NULL` 不命中任何行，自然空转。
#[tauri::command]
pub fn truncate_chat_after_last_user(
    db_state: State<DatabaseState>,
    session_id: i64,
) -> Result<(), String> {
    let conn = crate::db::open_connection(&db_state.0).map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM chat_messages
         WHERE session_id = ?1
           AND id > (SELECT MAX(id) FROM chat_messages WHERE session_id = ?1 AND role = 'user')",
        params![session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ── 附件消息（rich）协议 ─────────────────────────────────────────────
// DB content JSON: {"text": "...", "images": ["chat_images/<sid>/<hash>.png"],
//                   "files": [{"name": "a.log", "content": "..."}]}
// 前端 ChatView/attachments.ts、scene_chat 重建、recall/diary 降级共用同一协议。

#[derive(serde::Deserialize)]
pub(crate) struct RichContent {
    #[serde(default)]
    pub(crate) text: String,
    #[serde(default)]
    pub(crate) images: Vec<String>,
    #[serde(default)]
    pub(crate) files: Vec<RichFile>,
}

#[derive(serde::Deserialize)]
pub(crate) struct RichFile {
    pub(crate) name: String,
    pub(crate) content: String,
}

/// 解析 rich content JSON；非 rich/结构不符返回 None
pub(crate) fn parse_rich_content(content: &str) -> Option<RichContent> {
    serde_json::from_str::<RichContent>(content).ok()
}

/// rich 消息压扁成纯文本（滚动摘要 / 兜底通道 / 记忆提取 / 日记素材用）：
/// 附件只留引用——图片记数量、文件记名字；全文进摘要会把下游上下文烧爆。
/// 非 JSON 输入原样返回（调用方无需先判 content_type 也安全）。
pub(crate) fn degrade_rich_to_text(content: &str) -> String {
    let Ok(rich) = serde_json::from_str::<RichContent>(content) else {
        return content.to_string();
    };
    let mut tags = Vec::new();
    if !rich.images.is_empty() {
        tags.push(format!("[图片×{}]", rich.images.len()));
    }
    for f in &rich.files {
        tags.push(format!("[文件: {}]", f.name));
    }
    if rich.text.is_empty() {
        tags.join(" ")
    } else if tags.is_empty() {
        rich.text
    } else {
        format!("{}\n{}", rich.text, tags.join(" "))
    }
}

/// 删除会话及其全部消息（连带清理内存里的 A2UI surface 状态与 FIFO 排队消息）
#[tauri::command]
pub fn delete_chat_session(
    db_state: State<DatabaseState>,
    scene_state: State<crate::companion::scene_chat::JarvisSceneChatState>,
    app_handle: AppHandle,
    session_id: i64,
) -> Result<(), String> {
    let conn = crate::db::open_connection(&db_state.0).map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM chat_messages WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM chat_sessions WHERE id = ?1",
        params![session_id],
    )
    .map_err(|e| e.to_string())?;
    if let Ok(mut all) = scene_state.surfaces.lock() {
        all.remove(&session_id);
    }
    // FIFO 里该会话的排队消息一并清掉：否则删除后仍会继续执行，
    // 往已删除的 session_id 落库（外键拦截写入失败，但模型调用已白白消耗）
    if let Ok(mut q) = scene_state.queue.lock() {
        q.retain(|(sid, _)| *sid != session_id);
    }
    // 图片附件目录随会话一并清理（DB 里只剩引用，目录留着即成孤儿文件）
    if let Ok(dir) = chat_images_dir(&app_handle, session_id) {
        let _ = std::fs::remove_dir_all(dir);
    }
    Ok(())
}

// ── 图片附件 ──────────────────────────────────────────────────────────

/// 聊天图片附件目录：<app_data>/chat_images/<session_id>/
fn chat_images_dir(app_handle: &AppHandle, session_id: i64) -> Result<std::path::PathBuf, String> {
    Ok(app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("chat_images")
        .join(session_id.to_string()))
}

/// 图片扩展名白名单（写入边界校验：ext 来自前端，不放行任意后缀落盘）
fn normalize_image_ext(ext: &str) -> Result<&'static str, String> {
    match ext.to_ascii_lowercase().as_str() {
        "png" => Ok("png"),
        "jpg" | "jpeg" => Ok("jpg"),
        "webp" => Ok("webp"),
        "gif" => Ok("gif"),
        other => Err(format!("不支持的图片格式: {}", other)),
    }
}

/// 保存一张聊天图片（前端已完成压缩），返回 DB 里引用的相对路径
/// chat_images/<sid>/<hash>.<ext>。文件名取内容 sha256 前 16 位：
/// 内容寻址，同一张图重复发送/重复保存不重复占盘。
#[tauri::command]
pub fn save_chat_image(
    app_handle: AppHandle,
    session_id: i64,
    bytes: Vec<u8>,
    ext: String,
) -> Result<String, String> {
    let ext = normalize_image_ext(&ext)?;
    let dir = chat_images_dir(&app_handle, session_id)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建图片目录失败: {}", e))?;
    let hash = {
        use sha2::Digest;
        let mut h = sha2::Sha256::new();
        h.update(&bytes);
        format!("{:x}", h.finalize())
    };
    let file_name = format!("{}.{}", &hash[..16], ext);
    let path = dir.join(&file_name);
    if !path.exists() {
        std::fs::write(&path, &bytes).map_err(|e| format!("写入图片失败: {}", e))?;
    }
    Ok(format!("chat_images/{}/{}", session_id, file_name))
}

/// 读图片附件为 base64 data URL。两个调用方：前端历史气泡懒加载、
/// 发送链路组多模态消息。路径限定 app_data/chat_images/ 内，拒绝穿越。
pub(crate) fn read_image_data_url(
    app_handle: &AppHandle,
    rel_path: &str,
) -> Result<String, String> {
    let rel = std::path::Path::new(rel_path);
    if rel.is_absolute()
        || rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("非法图片路径".to_string());
    }
    let app_data = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let root = app_data.join("chat_images");
    let full = app_data.join(rel);
    if !full.starts_with(&root) {
        return Err("非法图片路径".to_string());
    }
    let bytes = std::fs::read(&full).map_err(|e| format!("读取图片失败: {}", e))?;
    let mime = match full.extension().and_then(|e| e.to_str()) {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        _ => "image/jpeg",
    };
    use base64::Engine;
    Ok(format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

/// 前端历史气泡懒加载入口
#[tauri::command]
pub fn read_chat_image(app_handle: AppHandle, path: String) -> Result<String, String> {
    read_image_data_url(&app_handle, &path)
}
