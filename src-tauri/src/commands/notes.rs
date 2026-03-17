use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::Manager;

use crate::db::DatabaseState;
use crate::notes::{NoteContent, NoteItem, NotesManager, get_default_notes_dir};

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

/// Initialize notes manager
#[tauri::command]
pub fn init_notes_manager(
    app_handle: tauri::AppHandle,
    custom_path: Option<String>,
) -> Result<String, String> {
    let notes_dir = if let Some(path) = custom_path {
        std::path::PathBuf::from(path)
    } else {
        // Try to get from settings
        let db_state = app_handle.state::<DatabaseState>();
        let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

        let stored_path: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'notes_directory'",
                [],
                |row| row.get(0),
            )
            .ok();

        if let Some(path) = stored_path {
            std::path::PathBuf::from(path)
        } else {
            get_default_notes_dir().map_err(|e| e.to_string())?
        }
    };

    // Create directory if not exists
    std::fs::create_dir_all(&notes_dir).map_err(|e| e.to_string())?;

    let manager = NotesManager::new(notes_dir.clone());

    // Store or update the manager in state
    if let Some(state) = app_handle.try_state::<NotesManagerState>() {
        if let Ok(mut guard) = state.0.lock() {
            guard.set_root_path(notes_dir.clone());
        }
    } else {
        app_handle.manage(NotesManagerState(Mutex::new(manager)));
    }

    // Save to settings
    let db_state = app_handle.state::<DatabaseState>();
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('notes_directory', ?1)",
        params![notes_dir.to_string_lossy().to_string()],
    ).map_err(|e| e.to_string())?;

    Ok(notes_dir.to_string_lossy().to_string())
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
pub fn read_note(
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<NoteContent, String> {
    let state = app_handle.state::<NotesManagerState>();
    let manager = state.0.lock().map_err(|e| e.to_string())?;

    manager.read_note(&path).map_err(|e| e.to_string())
}

/// Save note content
#[tauri::command]
pub fn save_note(
    app_handle: tauri::AppHandle,
    request: SaveNoteRequest,
) -> Result<(), String> {
    let state = app_handle.state::<NotesManagerState>();
    let manager = state.0.lock().map_err(|e| e.to_string())?;

    manager.write_note(&request.path, &request.content)
        .map_err(|e| e.to_string())
}

/// Create new note or folder
#[tauri::command]
pub fn create_note(
    app_handle: tauri::AppHandle,
    request: CreateNoteRequest,
) -> Result<(), String> {
    let state = app_handle.state::<NotesManagerState>();
    let manager = state.0.lock().map_err(|e| e.to_string())?;

    if request.is_folder {
        manager.create_folder(&request.path)
    } else {
        manager.create_note(&request.path)
    }.map_err(|e| e.to_string())
}

/// Rename note or folder
#[tauri::command]
pub fn rename_note(
    app_handle: tauri::AppHandle,
    request: RenameRequest,
) -> Result<String, String> {
    let state = app_handle.state::<NotesManagerState>();
    let manager = state.0.lock().map_err(|e| e.to_string())?;

    manager.rename(&request.old_path, &request.new_name)
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
pub fn move_note(
    app_handle: tauri::AppHandle,
    request: MoveRequest,
) -> Result<String, String> {
    let state = app_handle.state::<NotesManagerState>();
    let manager = state.0.lock().map_err(|e| e.to_string())?;

    manager.move_item(&request.source_path, &request.target_folder)
        .map_err(|e| e.to_string())
}

/// Reorder items in a directory
#[tauri::command]
pub fn reorder_notes(
    app_handle: tauri::AppHandle,
    request: ReorderRequest,
) -> Result<(), String> {
    let state = app_handle.state::<NotesManagerState>();
    let manager = state.0.lock().map_err(|e| e.to_string())?;

    manager.reorder_items(&request.parent_path, &request.item_names)
        .map_err(|e| e.to_string())
}
