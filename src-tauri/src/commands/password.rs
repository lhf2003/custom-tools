use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use tauri::State;

use crate::clipboard::ClipboardSuppressFlag;
use crate::db::DatabaseState;
use crate::password::{PasswordCategory, PasswordEntry, PasswordManagerState};

#[derive(Debug, Serialize, Deserialize)]
pub struct UnlockRequest {
    pub master_password: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreatePasswordRequest {
    pub title: String,
    pub username: Option<String>,
    pub password: String,
    pub url: Option<String>,
    pub notes: Option<String>,
    pub category_id: Option<i64>,
}

/// Check if password manager is unlocked
#[tauri::command]
pub fn is_password_manager_unlocked(state: State<PasswordManagerState>) -> Result<bool, String> {
    Ok(state.0.is_unlocked())
}

/// Unlock password manager
#[tauri::command]
pub fn unlock_password_manager(
    state: State<PasswordManagerState>,
    request: UnlockRequest,
) -> Result<bool, String> {
    state
        .0
        .unlock(&request.master_password)
        .map_err(|e| e.to_string())?;

    Ok(true)
}

/// Lock password manager
#[tauri::command]
pub fn lock_password_manager(state: State<PasswordManagerState>) {
    state.0.lock();
}

/// Get all password categories
#[tauri::command]
pub fn get_password_categories(
    db_state: State<DatabaseState>,
) -> Result<Vec<PasswordCategory>, String> {
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, name, icon, color FROM password_categories ORDER BY sort_order, name")
        .map_err(|e| e.to_string())?;

    let categories = stmt
        .query_map([], |row| {
            Ok(PasswordCategory {
                id: row.get(0)?,
                name: row.get(1)?,
                icon: row.get(2)?,
                color: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(categories)
}

/// Get password entries
#[tauri::command]
pub fn get_password_entries(
    db_state: State<DatabaseState>,
    crypto_state: State<PasswordManagerState>,
    category_id: Option<i64>,
    favorite_only: Option<bool>,
    search: Option<String>,
) -> Result<Vec<PasswordEntry>, String> {
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;
    let unlocked = crypto_state.0.is_unlocked();

    let mut sql = String::from(
        "SELECT id, title, username, encrypted_password, url, encrypted_notes,
         category_id, favorite, created_at, updated_at
         FROM password_entries WHERE 1=1",
    );

    if category_id.is_some() {
        sql.push_str(" AND category_id = ?1");
    }

    if favorite_only == Some(true) {
        sql.push_str(" AND favorite = 1");
    }

    if search.is_some() {
        sql.push_str(" AND (title LIKE ?2 OR username LIKE ?2 OR url LIKE ?2)");
    }

    sql.push_str(" ORDER BY favorite DESC, title ASC");

    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(id) = category_id {
        params_vec.push(Box::new(id));
    }

    let search_pattern = search.map(|s| format!("%{}%", s));
    if search_pattern.is_some() {
        params_vec.push(Box::new(search_pattern.clone().unwrap()));
    }

    let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

    let entries = stmt
        .query_map(&param_refs[..], |row| {
            let _encrypted_password: String = row.get(3)?;
            // Return masked password
            let masked_password = "•".repeat(8);

            // Decrypt notes so the detail view never sees ciphertext. Locked
            // vault or a single corrupt note must not fail the whole list.
            let encrypted_notes: Option<String> = row.get(5)?;
            let notes = match (encrypted_notes, unlocked) {
                (Some(enc), true) => match crypto_state.0.decrypt_password(&enc) {
                    Ok(plain) => Some(plain),
                    Err(e) => {
                        eprintln!("[password] Failed to decrypt notes for entry: {}", e);
                        None
                    }
                },
                _ => None,
            };

            Ok(PasswordEntry {
                id: row.get(0)?,
                title: row.get(1)?,
                username: row.get(2)?,
                password: masked_password,
                url: row.get(4)?,
                notes,
                category_id: row.get(6)?,
                favorite: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(entries)
}

/// Create new password entry
#[tauri::command]
pub fn create_password_entry(
    db_state: State<DatabaseState>,
    crypto_state: State<PasswordManagerState>,
    request: CreatePasswordRequest,
) -> Result<i64, String> {
    if !crypto_state.0.is_unlocked() {
        return Err("Password manager is locked".to_string());
    }

    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    // Encrypt password
    let encrypted_password = crypto_state
        .0
        .encrypt_password(&request.password)
        .map_err(|e| e.to_string())?;

    // Encrypt notes if provided
    let encrypted_notes = if let Some(notes) = request.notes {
        Some(
            crypto_state
                .0
                .encrypt_password(&notes)
                .map_err(|e| e.to_string())?,
        )
    } else {
        None
    };

    conn.execute(
        "INSERT INTO password_entries
         (title, username, encrypted_password, url, encrypted_notes, category_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            request.title,
            request.username,
            encrypted_password,
            request.url,
            encrypted_notes,
            request.category_id
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(conn.last_insert_rowid())
}

/// Get decrypted password
#[tauri::command]
pub fn get_decrypted_password(
    db_state: State<DatabaseState>,
    crypto_state: State<PasswordManagerState>,
    id: i64,
) -> Result<String, String> {
    if !crypto_state.0.is_unlocked() {
        return Err("Password manager is locked".to_string());
    }

    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    let encrypted: String = conn
        .query_row(
            "SELECT encrypted_password FROM password_entries WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    let decrypted = crypto_state
        .0
        .decrypt_password(&encrypted)
        .map_err(|e| e.to_string())?;

    // Update usage count and last used
    let _ = conn.execute(
        "UPDATE password_entries SET usage_count = COALESCE(usage_count, 0) + 1,
         last_used_at = CURRENT_TIMESTAMP WHERE id = ?1",
        params![id],
    );

    Ok(decrypted)
}

/// Update an existing password entry (re-encrypts password and notes)
#[tauri::command]
pub fn update_password_entry(
    db_state: State<DatabaseState>,
    crypto_state: State<PasswordManagerState>,
    id: i64,
    request: CreatePasswordRequest,
) -> Result<(), String> {
    if !crypto_state.0.is_unlocked() {
        return Err("Password manager is locked".to_string());
    }

    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    let encrypted_password = crypto_state
        .0
        .encrypt_password(&request.password)
        .map_err(|e| e.to_string())?;

    let encrypted_notes = if let Some(notes) = request.notes {
        if notes.is_empty() {
            None
        } else {
            Some(
                crypto_state
                    .0
                    .encrypt_password(&notes)
                    .map_err(|e| e.to_string())?,
            )
        }
    } else {
        None
    };

    let affected = conn
        .execute(
            "UPDATE password_entries
             SET title = ?1, username = ?2, encrypted_password = ?3, url = ?4,
                 encrypted_notes = ?5, category_id = ?6, updated_at = CURRENT_TIMESTAMP
             WHERE id = ?7",
            params![
                request.title,
                request.username,
                encrypted_password,
                request.url,
                encrypted_notes,
                request.category_id,
                id
            ],
        )
        .map_err(|e| e.to_string())?;

    if affected == 0 {
        return Err(format!("Password entry {} not found", id));
    }

    Ok(())
}

/// Create a new password category
#[tauri::command]
pub fn create_password_category(
    db_state: State<DatabaseState>,
    name: String,
) -> Result<i64, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("分类名称不能为空".to_string());
    }

    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO password_categories (name) VALUES (?1)",
        params![trimmed],
    )
    .map_err(|e| e.to_string())?;

    Ok(conn.last_insert_rowid())
}

/// Toggle favorite flag on a password entry
#[tauri::command]
pub fn toggle_password_favorite(
    db_state: State<DatabaseState>,
    id: i64,
    favorite: bool,
) -> Result<(), String> {
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE password_entries SET favorite = ?1 WHERE id = ?2",
        params![favorite, id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Delete password entry
#[tauri::command]
pub fn delete_password_entry(db_state: State<DatabaseState>, id: i64) -> Result<(), String> {
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    conn.execute("DELETE FROM password_entries WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Copy a password to the system clipboard WITHOUT recording it in clipboard
/// history (unlike `copy_text_to_clipboard`, which always inserts a history
/// entry). After 60s the clipboard is cleared, but only if it still holds
/// this exact password — never clobber whatever the user copied since.
#[tauri::command]
pub fn copy_password_to_clipboard(
    app_handle: tauri::AppHandle,
    suppress_flag: State<ClipboardSuppressFlag>,
    text: String,
) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;

    // Signal the clipboard watcher to skip the event caused by our own write
    suppress_flag.suppress();

    app_handle
        .clipboard()
        .write_text(text.clone())
        .map_err(|e| e.to_string())?;

    let handle = app_handle.clone();
    let flag = suppress_flag.0.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(60));
        let Ok(current) = handle.clipboard().read_text() else {
            return;
        };
        if current == text {
            // Suppress the watcher's event for this clear as well
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
            let _ = handle.clipboard().clear();
        }
    });

    Ok(())
}
