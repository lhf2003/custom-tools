use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::DatabaseState;

#[derive(Debug, Serialize, Deserialize)]
pub struct ChatHistoryMessage {
    pub id: i64,
    pub role: String,
    pub content: String,
}

/// 创建新会话，返回 session_id
#[tauri::command]
pub fn create_chat_session(
    db_state: State<DatabaseState>,
    mode: String,
) -> Result<i64, String> {
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO chat_sessions (mode) VALUES (?1)",
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
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO chat_messages (session_id, role, content) VALUES (?1, ?2, ?3)",
        params![session_id, role, content],
    )
    .map_err(|e| e.to_string())?;
    // 更新会话的 updated_at
    conn.execute(
        "UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?1",
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
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, role, content FROM chat_messages WHERE session_id = ?1 ORDER BY id ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![session_id], |row| {
            Ok(ChatHistoryMessage {
                id: row.get(0)?,
                role: row.get(1)?,
                content: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// 获取同 mode 下最近一次会话的 id
#[tauri::command]
pub fn get_latest_session(
    db_state: State<DatabaseState>,
    mode: String,
) -> Result<Option<i64>, String> {
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;
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
