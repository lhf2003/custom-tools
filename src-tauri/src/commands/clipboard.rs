use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::DatabaseState;

#[derive(Debug, Serialize, Deserialize)]
pub struct ClipboardItem {
    pub id: i64,
    pub content: String,
    pub content_type: String,
    pub source_app: Option<String>,
    pub is_favorite: bool,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ClipboardQuery {
    pub content_type: Option<String>,
    pub is_favorite: Option<bool>,
    pub search: Option<String>,
    pub limit: Option<i64>,
}

/// Get clipboard history
#[tauri::command]
pub fn get_clipboard_history(
    db_state: State<DatabaseState>,
    query: ClipboardQuery,
) -> Result<Vec<ClipboardItem>, String> {
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    // Build query with optional filters
    let search_pattern = query.search.as_ref().map(|s| format!("%{}%", s));
    let limit = query.limit.unwrap_or(50);

    let mut sql = String::from(
        "SELECT id, content, content_type, source_app, is_favorite, created_at
         FROM clipboard_history WHERE 1=1",
    );

    if query.content_type.is_some() {
        sql.push_str(" AND content_type = ?1");
    }

    if query.is_favorite.is_some() {
        sql.push_str(" AND is_favorite = ?2");
    }

    if search_pattern.is_some() {
        sql.push_str(" AND content LIKE ?3");
    }

    sql.push_str(" ORDER BY created_at DESC LIMIT ?4");

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

    let items = stmt
        .query_map(
            params![
                query.content_type,
                query.is_favorite.map(|b| b as i32),
                search_pattern,
                limit
            ],
            |row| {
                Ok(ClipboardItem {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    content_type: row.get(2)?,
                    source_app: row.get(3)?,
                    is_favorite: row.get::<_, i32>(4)? != 0,
                    created_at: row.get(5)?,
                })
            },
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(items)
}

/// Toggle favorite status
#[tauri::command]
pub fn toggle_clipboard_favorite(
    db_state: State<DatabaseState>,
    id: i64,
) -> Result<bool, String> {
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE clipboard_history SET is_favorite = NOT is_favorite WHERE id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;

    let is_favorite: bool = conn
        .query_row(
            "SELECT is_favorite FROM clipboard_history WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    Ok(is_favorite)
}

/// Delete clipboard item
#[tauri::command]
pub fn delete_clipboard_item(db_state: State<DatabaseState>, id: i64) -> Result<(), String> {
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    // Get content type and path for image cleanup
    let (content_type, content): (String, String) = conn
        .query_row(
            "SELECT content_type, content FROM clipboard_history WHERE id = ?1",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|e| e.to_string())?;

    // Delete from database
    conn.execute(
        "DELETE FROM clipboard_history WHERE id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;

    // Cleanup image file if applicable
    if content_type == "image" {
        let _ = std::fs::remove_file(&content);
    }

    Ok(())
}

/// Clear all clipboard history
#[tauri::command]
pub fn clear_clipboard_history(db_state: State<DatabaseState>) -> Result<(), String> {
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    // Get all image paths first
    let mut stmt = conn
        .prepare("SELECT content FROM clipboard_history WHERE content_type = 'image'")
        .map_err(|e| e.to_string())?;

    let image_paths: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    // Delete all records
    conn.execute("DELETE FROM clipboard_history", [])
        .map_err(|e| e.to_string())?;

    // Cleanup image files
    for path in image_paths {
        let _ = std::fs::remove_file(path);
    }

    Ok(())
}

/// Copy clipboard item back to clipboard
#[tauri::command]
pub fn copy_to_clipboard(
    db_state: State<DatabaseState>,
    app_handle: tauri::AppHandle,
    id: i64,
) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;

    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    let (content_type, content): (String, String) = conn
        .query_row(
            "SELECT content_type, content FROM clipboard_history WHERE id = ?1",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|e| e.to_string())?;

    match content_type.as_str() {
        "text" => {
            app_handle
                .clipboard()
                .write_text(content)
                .map_err(|e| e.to_string())?;
        }
        "image" => {
            // Read image file and write to clipboard
            let _image_data = std::fs::read(&content).map_err(|e| e.to_string())?;
            // TODO: Implement image clipboard write
            log::info!("Image copy not yet implemented");
        }
        "file" => {
            // TODO: Implement file list clipboard write
            log::info!("File list copy not yet implemented");
        }
        _ => {}
    }

    // Update usage count and last used time
    let _ = conn.execute(
        "UPDATE clipboard_history SET usage_count = COALESCE(usage_count, 0) + 1, last_used_at = CURRENT_TIMESTAMP WHERE id = ?1",
        params![id],
    );

    Ok(())
}

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

/// Get clipboard image as base64 for preview
#[tauri::command]
pub fn get_clipboard_image_base64(
    db_state: State<DatabaseState>,
    id: i64,
) -> Result<String, String> {
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    let (content_type, content): (String, String) = conn
        .query_row(
            "SELECT content_type, content FROM clipboard_history WHERE id = ?1",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|e| e.to_string())?;

    if content_type != "image" {
        return Err("Item is not an image".to_string());
    }

    // Read image file and convert to base64
    let image_data = std::fs::read(&content).map_err(|e| e.to_string())?;

    // Detect mime type from file extension or content
    let mime_type = if content.ends_with(".png") {
        "image/png"
    } else if content.ends_with(".jpg") || content.ends_with(".jpeg") {
        "image/jpeg"
    } else if content.ends_with(".gif") {
        "image/gif"
    } else if content.ends_with(".webp") {
        "image/webp"
    } else {
        "image/png" // default
    };

    let base64_str = BASE64.encode(&image_data);
    Ok(format!("data:{};base64,{}" , mime_type, base64_str))
}
