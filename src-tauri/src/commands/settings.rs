use crate::settings::{AppSettings, SettingsManager, ShortcutConfig, ShortcutManager};
use std::sync::Mutex;
use tauri::{Manager, State};

pub struct SettingsState(pub Mutex<SettingsManager>);
pub struct ShortcutManagerState(pub Mutex<ShortcutManager>);

/// Get all settings
#[tauri::command]
pub fn get_settings(state: State<'_, SettingsState>) -> Result<AppSettings, String> {
    let manager = state.0.lock().map_err(|e| e.to_string())?;
    Ok(manager.get_settings())
}

/// Update a setting
#[tauri::command]
pub fn set_setting(
    state: State<'_, SettingsState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let manager = state.0.lock().map_err(|e| e.to_string())?;
    manager.set_setting(&key, &value).map_err(|e| e.to_string())
}

/// Toggle always on top
#[tauri::command]
pub fn toggle_always_on_top(
    app_handle: tauri::AppHandle,
    state: State<'_, SettingsState>,
) -> Result<bool, String> {
    let manager = state.0.lock().map_err(|e| e.to_string())?;
    let current = manager.is_always_on_top();
    let new_value = !current;

    // Update setting
    manager
        .set_setting("always_on_top", &new_value.to_string())
        .map_err(|e| e.to_string())?;

    // Apply to window
    if let Some(window) = app_handle.get_webview_window("main") {
        window
            .set_always_on_top(new_value)
            .map_err(|e| e.to_string())?;
    }

    Ok(new_value)
}

/// Set window always on top
#[tauri::command]
pub fn set_always_on_top(
    app_handle: tauri::AppHandle,
    state: State<'_, SettingsState>,
    enabled: bool,
) -> Result<(), String> {
    let manager = state.0.lock().map_err(|e| e.to_string())?;

    // Update setting
    manager
        .set_setting("always_on_top", &enabled.to_string())
        .map_err(|e| e.to_string())?;

    // Apply to window
    if let Some(window) = app_handle.get_webview_window("main") {
        window.set_always_on_top(enabled).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Toggle hide on blur
#[tauri::command]
pub fn toggle_hide_on_blur(state: State<'_, SettingsState>) -> Result<bool, String> {
    let manager = state.0.lock().map_err(|e| e.to_string())?;
    let current = manager.should_hide_on_blur();
    let new_value = !current;

    manager
        .set_setting("hide_on_blur", &new_value.to_string())
        .map_err(|e| e.to_string())?;

    Ok(new_value)
}

// ==================== Shortcut Commands ====================

/// Get all shortcut configurations
#[tauri::command]
pub fn get_shortcuts(state: State<'_, ShortcutManagerState>) -> Result<Vec<ShortcutConfig>, String> {
    let manager = state.0.lock().map_err(|e| e.to_string())?;
    Ok(manager.get_all_configs())
}

/// Update a shortcut
#[tauri::command]
pub fn update_shortcut(
    app_handle: tauri::AppHandle,
    state: State<'_, ShortcutManagerState>,
    id: String,
    custom_keys: Option<String>,
    enabled: bool,
) -> Result<(), String> {
    let mut manager = state.0.lock().map_err(|e| e.to_string())?;
    manager.update_shortcut(&id, custom_keys, enabled).map_err(|e| e.to_string())?;

    // Re-register all shortcuts after update
    if let Err(e) = manager.reregister_all(&app_handle) {
        log::warn!("Failed to re-register shortcuts: {}", e);
    }

    Ok(())
}

/// Reset a shortcut to default
#[tauri::command]
pub fn reset_shortcut(
    app_handle: tauri::AppHandle,
    state: State<'_, ShortcutManagerState>,
    id: String,
) -> Result<(), String> {
    let mut manager = state.0.lock().map_err(|e| e.to_string())?;
    manager.reset_shortcut(&id).map_err(|e| e.to_string())?;

    // Re-register all shortcuts after reset
    if let Err(e) = manager.reregister_all(&app_handle) {
        log::warn!("Failed to re-register shortcuts: {}", e);
    }

    Ok(())
}

/// Reset all shortcuts to defaults
#[tauri::command]
pub fn reset_all_shortcuts(
    app_handle: tauri::AppHandle,
    state: State<'_, ShortcutManagerState>,
) -> Result<(), String> {
    let mut manager = state.0.lock().map_err(|e| e.to_string())?;
    manager.reset_all().map_err(|e| e.to_string())?;

    // Re-register all shortcuts after reset
    if let Err(e) = manager.reregister_all(&app_handle) {
        log::warn!("Failed to re-register shortcuts: {}", e);
    }

    Ok(())
}

/// Check if a shortcut conflicts with existing ones
#[tauri::command]
pub fn check_shortcut_conflict(
    state: State<'_, ShortcutManagerState>,
    keys: String,
    exclude_id: Option<String>,
) -> Result<Option<ShortcutConfig>, String> {
    let manager = state.0.lock().map_err(|e| e.to_string())?;
    Ok(manager.check_conflict(&keys, exclude_id.as_deref()).cloned())
}
