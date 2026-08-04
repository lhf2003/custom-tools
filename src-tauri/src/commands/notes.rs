use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::Manager;

use crate::companion::analyzer;
use crate::db::DatabaseState;
use crate::notes::{get_default_notes_dir, NoteContent, NoteItem, NotesManager};

// State to store the notes manager
pub struct NotesManagerState(pub Mutex<NotesManager>);

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateNoteRequest {
    pub path: String,
    pub is_folder: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RenameRequest {
    pub old_path: String,
    pub new_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MoveRequest {
    pub source_path: String,
    pub target_folder: String, // empty string means root
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReorderRequest {
    pub parent_path: String, // empty string means root
    pub item_names: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SaveNoteRequest {
    pub path: String,
    pub content: String,
}

/// Get notes directory
#[tauri::command]
pub fn get_notes_directory(app_handle: tauri::AppHandle) -> Result<String, String> {
    let db_state = app_handle.state::<DatabaseState>();
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    let path: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'notes_directory'",
            [],
            |row| row.get(0),
        )
        .ok();

    if let Some(p) = path {
        Ok(p)
    } else {
        let default = get_default_notes_dir().map_err(|e| e.to_string())?;
        Ok(default.to_string_lossy().to_string())
    }
}

/// Get note tree
#[tauri::command]
pub fn get_note_tree(app_handle: tauri::AppHandle) -> Result<Vec<NoteItem>, String> {
    let state = app_handle.state::<NotesManagerState>();
    let manager = state.0.lock().map_err(|e| e.to_string())?;

    manager.build_tree().map_err(|e| e.to_string())
}

/// Read note content
#[tauri::command]
pub fn read_note(app_handle: tauri::AppHandle, path: String) -> Result<NoteContent, String> {
    let state = app_handle.state::<NotesManagerState>();
    let manager = state.0.lock().map_err(|e| e.to_string())?;

    manager.read_note(&path).map_err(|e| e.to_string())
}

/// Save note content
#[tauri::command]
pub fn save_note(app_handle: tauri::AppHandle, request: SaveNoteRequest) -> Result<(), String> {
    let state = app_handle.state::<NotesManagerState>();
    let manager = state.0.lock().map_err(|e| e.to_string())?;

    manager
        .write_note(&request.path, &request.content)
        .map_err(|e| e.to_string())
}

/// Create new note or folder
#[tauri::command]
pub fn create_note(app_handle: tauri::AppHandle, request: CreateNoteRequest) -> Result<(), String> {
    let state = app_handle.state::<NotesManagerState>();
    let manager = state.0.lock().map_err(|e| e.to_string())?;

    if request.is_folder {
        manager.create_folder(&request.path)
    } else {
        manager.create_note(&request.path)
    }
    .map_err(|e| e.to_string())
}

/// Rename note or folder
#[tauri::command]
pub fn rename_note(app_handle: tauri::AppHandle, request: RenameRequest) -> Result<String, String> {
    let state = app_handle.state::<NotesManagerState>();
    let manager = state.0.lock().map_err(|e| e.to_string())?;

    manager
        .rename(&request.old_path, &request.new_name)
        .map_err(|e| e.to_string())
}

/// Delete note or folder
#[tauri::command]
pub fn delete_note(app_handle: tauri::AppHandle, path: String) -> Result<(), String> {
    let state = app_handle.state::<NotesManagerState>();
    let manager = state.0.lock().map_err(|e| e.to_string())?;

    manager.delete(&path).map_err(|e| e.to_string())
}

/// Move note or folder
#[tauri::command]
pub fn move_note(app_handle: tauri::AppHandle, request: MoveRequest) -> Result<String, String> {
    let state = app_handle.state::<NotesManagerState>();
    let manager = state.0.lock().map_err(|e| e.to_string())?;

    manager
        .move_item(&request.source_path, &request.target_folder)
        .map_err(|e| e.to_string())
}

/// Reorder items in a directory
#[tauri::command]
pub fn reorder_notes(app_handle: tauri::AppHandle, request: ReorderRequest) -> Result<(), String> {
    let state = app_handle.state::<NotesManagerState>();
    let manager = state.0.lock().map_err(|e| e.to_string())?;

    manager
        .reorder_items(&request.parent_path, &request.item_names)
        .map_err(|e| e.to_string())
}

/// AI 排版笔记内容（格式规范化 + 润色）。
/// 走场景模型**流式收集**通道（analyzer::call_scene_model_llm_stream）：
/// 长文本生成用流式接口规避非流式响应被截断的问题（"error decoding response body"）。
/// 长度限制 10000 字符：单次生成的输出 ≈ 输入长度，需在模型输出上限内。
#[tauri::command]
pub async fn format_note_content(
    app_handle: tauri::AppHandle,
    content: String,
) -> Result<String, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err("笔记内容为空".to_string());
    }
    if trimmed.chars().count() > 10000 {
        return Err("笔记过长（超过 1 万字），请分段排版".to_string());
    }

    let prompt = format!(
        "你是一位中文 markdown 排版专家。对用户提供的笔记做格式规范化与润色，规则：\n\
         1. 格式：修正 markdown 语法（标题层级连贯、列表/缩进统一、代码块与行内代码正确包裹、表格对齐、空行分隔）\n\
         2. 润色：拆分过长的段落（每段不超过约 200 字）、修正明显语病与错别字、统一中英混排（中英文间加空格）、统一术语用词\n\
         3. 禁止改动：代码内容与注释、URL、数字数据、专有名词、人名、标题主旨\n\
         4. 保留原有标题结构与笔记主题；不新增或删除实质性内容\n\
         5. 直接输出排版后的完整 markdown 正文，不要任何解释、前言或代码块包裹\n\n\
         以下是笔记内容：\n\n{}",
        trimmed
    );

    let db_path = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(crate::DB_FILE_NAME);

    let result = analyzer::call_scene_model_llm_stream(
        &app_handle,
        &db_path,
        prompt,
        crate::llm_provider::models::Scene::Companion,
        "note_format",
    )
    .await?;

    let formatted = result.trim();
    if formatted.is_empty() {
        return Err("AI 排版返回内容为空".to_string());
    }
    Ok(formatted.to_string())
}
