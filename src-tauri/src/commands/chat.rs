use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

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
) -> Result<(), String> {
    let conn = crate::db::open_connection(&db_state.0).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO chat_messages (session_id, role, content, created_at) VALUES (?1, ?2, ?3, datetime('now','localtime'))",
        params![session_id, role, content],
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

/// 删除会话及其全部消息（连带清理内存里的 A2UI surface 状态与 FIFO 排队消息）
#[tauri::command]
pub fn delete_chat_session(
    db_state: State<DatabaseState>,
    scene_state: State<crate::companion::scene_chat::JarvisSceneChatState>,
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
    Ok(())
}
