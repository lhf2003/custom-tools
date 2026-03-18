use crate::db::app_usage;
use crate::db::DatabaseState;
use crate::search::{icon, AppItem, SearchIndex};
use rusqlite::Connection;
use std::sync::Mutex;

pub struct SearchState(pub Mutex<SearchIndex>);

fn get_db_conn(db_state: &tauri::State<'_, DatabaseState>) -> Result<Connection, String> {
    Connection::open(&db_state.0).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn index_apps(state: tauri::State<'_, SearchState>) -> Result<(), String> {
    let mut index = state.0.lock().map_err(|e| e.to_string())?;
    index.index_apps().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_apps(
    query: String,
    state: tauri::State<'_, SearchState>,
    db_state: tauri::State<'_, DatabaseState>,
) -> Result<Vec<AppItem>, String> {
    let index = state.0.lock().map_err(|e| e.to_string())?;
    let conn = get_db_conn(&db_state)?;

    // Get all usage stats
    let usages = app_usage::get_all_usage(&conn).map_err(|e| e.to_string())?;

    let results = if query.is_empty() {
        // Return apps sorted by recency/frequency
        index.get_recently_used(&usages)
    } else {
        // Search with frequency-based ranking
        index.search_with_frequency(&query, &usages)
    };

    // Record search for each result (only for non-empty queries)
    // This helps build usage patterns for better ranking
    if !query.is_empty() {
        // Record first 5 results as relevant to this search
        for app in results.iter().take(5) {
            if let Err(e) = app_usage::record_search(&conn, &app.path, &app.name) {
                log::warn!("Failed to record search for {}: {}", app.name, e);
            }
        }
    }

    Ok(results)
}

#[tauri::command]
pub fn refresh_apps(state: tauri::State<'_, SearchState>) -> Result<(), String> {
    let mut index = state.0.lock().map_err(|e| e.to_string())?;
    index.refresh().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn launch_app(
    path: String,
    name: String,
    db_state: tauri::State<'_, DatabaseState>,
) -> Result<(), String> {
    // Record launch in database
    let conn = get_db_conn(&db_state)?;
    app_usage::record_launch(&conn, &path, &name).map_err(|e| e.to_string())?;

    // Launch the app
    crate::search::launch_app(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_recent_apps(
    limit: usize,
    db_state: tauri::State<'_, DatabaseState>,
    state: tauri::State<'_, SearchState>,
) -> Result<Vec<AppItem>, String> {
    let index = state.0.lock().map_err(|e| e.to_string())?;
    let conn = get_db_conn(&db_state)?;

    let usages = app_usage::get_recently_used(&conn, limit).map_err(|e| e.to_string())?;

    // Map usage records back to AppItems
    let usage_paths: std::collections::HashSet<&str> =
        usages.iter().map(|u| u.path.as_str()).collect();

    // Get all apps and filter by usage
    let all_apps = index.get_all();
    let mut recent_apps: Vec<AppItem> = all_apps
        .into_iter()
        .filter(|app| usage_paths.contains(app.path.as_str()))
        .collect();

    // Sort by last_launch time (from usage records)
    recent_apps.sort_by(|a, b| {
        let a_time = usages
            .iter()
            .find(|u| u.path == a.path)
            .and_then(|u| u.last_launch)
            .unwrap_or(0);
        let b_time = usages
            .iter()
            .find(|u| u.path == b.path)
            .and_then(|u| u.last_launch)
            .unwrap_or(0);
        b_time.cmp(&a_time) // Descending
    });

    Ok(recent_apps)
}

#[tauri::command]
pub async fn extract_app_icon(path: String) -> Result<Option<String>, String> {
    icon::extract_icon(&path).map_err(|e| e.to_string())
}
