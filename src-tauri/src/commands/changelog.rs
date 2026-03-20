use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri::Manager;

use crate::db::DatabaseState;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ChangelogEntry {
    pub version: String,
    pub release_date: Option<String>,
    pub content: String,
    pub is_read: bool,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VersionCheckResult {
    pub current_version: String,
    pub has_new_version: bool,
    pub unread_changelogs: Vec<ChangelogEntry>,
}

/// Get database connection from app state
fn get_db_connection(app: &AppHandle) -> Result<Connection, String> {
    let db_state = app
        .try_state::<DatabaseState>()
        .ok_or("Database state not found")?;
    Connection::open(&db_state.0).map_err(|e| format!("Failed to open database: {}", e))
}

/// Add or update a changelog entry
#[tauri::command]
pub fn add_changelog(
    app: AppHandle,
    version: String,
    release_date: Option<String>,
    content: String,
) -> Result<(), String> {
    let conn = get_db_connection(&app)?;

    conn.execute(
        "INSERT OR REPLACE INTO changelog (version, release_date, content, is_read, created_at)
         VALUES (?1, ?2, ?3, 0, CURRENT_TIMESTAMP)",
        params![version, release_date, content],
    )
    .map_err(|e| format!("Failed to add changelog: {}", e))?;

    Ok(())
}

/// Mark a changelog as read
#[tauri::command]
pub fn mark_changelog_read(app: AppHandle, version: String) -> Result<(), String> {
    let conn = get_db_connection(&app)?;

    conn.execute(
        "UPDATE changelog SET is_read = 1 WHERE version = ?1",
        params![version],
    )
    .map_err(|e| format!("Failed to mark changelog as read: {}", e))?;

    Ok(())
}

/// Mark all changelogs as read
#[tauri::command]
pub fn mark_all_changelogs_read(app: AppHandle) -> Result<(), String> {
    let conn = get_db_connection(&app)?;

    conn.execute("UPDATE changelog SET is_read = 1", [])
        .map_err(|e| format!("Failed to mark all changelogs as read: {}", e))?;

    Ok(())
}

/// Get all changelog entries, optionally filtered by read status
#[tauri::command]
pub fn get_changelogs(
    app: AppHandle,
    unread_only: Option<bool>,
) -> Result<Vec<ChangelogEntry>, String> {
    let conn = get_db_connection(&app)?;

    let query = match unread_only {
        Some(true) => "SELECT version, release_date, content, is_read, created_at FROM changelog WHERE is_read = 0 ORDER BY created_at DESC",
        Some(false) => "SELECT version, release_date, content, is_read, created_at FROM changelog WHERE is_read = 1 ORDER BY created_at DESC",
        None => "SELECT version, release_date, content, is_read, created_at FROM changelog ORDER BY created_at DESC",
    };

    let mut stmt = conn.prepare(query).map_err(|e| format!("Failed to prepare query: {}", e))?;

    let entries = stmt
        .query_map([], |row| {
            Ok(ChangelogEntry {
                version: row.get(0)?,
                release_date: row.get(1)?,
                content: row.get(2)?,
                is_read: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| format!("Failed to query changelogs: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to collect changelogs: {}", e))?;

    Ok(entries)
}

/// Check if there are unread changelogs for the current version
#[tauri::command]
pub fn check_version_changelog(app: AppHandle) -> Result<VersionCheckResult, String> {
    let current_version = app.package_info().version.to_string();
    let conn = get_db_connection(&app)?;

    // Check if current version has an unread changelog
    let unread_changelogs: Vec<ChangelogEntry> = conn
        .prepare(
            "SELECT version, release_date, content, is_read, created_at FROM changelog
             WHERE version = ?1 AND is_read = 0
             ORDER BY created_at DESC",
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?
        .query_map(params![current_version], |row| {
            Ok(ChangelogEntry {
                version: row.get(0)?,
                release_date: row.get(1)?,
                content: row.get(2)?,
                is_read: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| format!("Failed to query changelog: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to collect changelogs: {}", e))?;

    let has_new_version = !unread_changelogs.is_empty();

    Ok(VersionCheckResult {
        current_version,
        has_new_version,
        unread_changelogs,
    })
}

/// Delete old changelog entries (keep only last N versions)
#[tauri::command]
pub fn cleanup_old_changelogs(app: AppHandle, keep_count: i64) -> Result<(), String> {
    let conn = get_db_connection(&app)?;

    conn.execute(
        "DELETE FROM changelog WHERE version NOT IN (
            SELECT version FROM changelog ORDER BY created_at DESC LIMIT ?1
        )",
        params![keep_count],
    )
    .map_err(|e| format!("Failed to cleanup old changelogs: {}", e))?;

    Ok(())
}
