use crate::settings::{AppSettings, SettingsManager, ShortcutConfig, ShortcutManager};
use std::sync::Mutex;
use tauri::{Manager, State};
use tauri_plugin_autostart::ManagerExt;

pub struct SettingsState(pub Mutex<SettingsManager>);
pub struct ShortcutManagerState(pub Mutex<ShortcutManager>);

/// Get all settings
#[tauri::command]
pub fn get_settings(state: State<'_, SettingsState>) -> Result<AppSettings, String> {
    let manager = state.0.lock().map_err(|e| e.to_string())?;
    Ok(manager.get_settings())
}

/// Get a single KV setting by key（插件启用状态等通用键）
#[tauri::command]
pub fn get_setting(state: State<'_, SettingsState>, key: String) -> Result<Option<String>, String> {
    let manager = state.0.lock().map_err(|e| e.to_string())?;
    manager.get_setting(&key).map_err(|e| e.to_string())
}

/// Update a setting
#[tauri::command]
pub fn set_setting(
    state: State<'_, SettingsState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let manager = state.0.lock().map_err(|e| e.to_string())?;
    manager
        .set_setting(&key, &value)
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Reset all settings to defaults
#[tauri::command]
pub fn reset_settings(state: State<'_, SettingsState>) -> Result<(), String> {
    let manager = state.0.lock().map_err(|e| e.to_string())?;
    manager.reset_settings().map_err(|e| e.to_string())
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

    log::info!(
        "Toggling always_on_top: current={}, new={}",
        current,
        new_value
    );

    // Update setting
    manager
        .set_setting("always_on_top", &new_value.to_string())
        .map_err(|e| e.to_string())?;

    // Apply to window
    if let Some(window) = app_handle.get_webview_window("main") {
        log::info!("Applying always_on_top={} to window", new_value);
        match window.set_always_on_top(new_value) {
            Ok(_) => log::info!("Successfully set always_on_top to {}", new_value),
            Err(e) => {
                log::error!("Failed to set always_on_top: {}", e);
                return Err(e.to_string());
            }
        }
    } else {
        log::error!("Main window not found");
        return Err("Main window not found".to_string());
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
        window
            .set_always_on_top(enabled)
            .map_err(|e| e.to_string())?;
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

/// Toggle startup launch (auto start on system boot)
#[tauri::command]
pub fn toggle_startup_launch(
    app_handle: tauri::AppHandle,
    state: State<'_, SettingsState>,
) -> Result<bool, String> {
    let manager = state.0.lock().map_err(|e| e.to_string())?;
    let current = manager.get_settings().startup_launch;
    let new_value = !current;

    // Update setting in database
    manager
        .set_setting("startup_launch", &new_value.to_string())
        .map_err(|e| e.to_string())?;

    // Apply to system autostart
    let autostart_manager = app_handle.autolaunch();
    if new_value {
        autostart_manager
            .enable()
            .map_err(|e| format!("Failed to enable autostart: {}", e))?;
        log::info!("Autostart enabled");
    } else {
        autostart_manager
            .disable()
            .map_err(|e| format!("Failed to disable autostart: {}", e))?;
        log::info!("Autostart disabled");
    }

    Ok(new_value)
}

/// Set startup launch directly
#[tauri::command]
pub fn set_startup_launch(
    app_handle: tauri::AppHandle,
    state: State<'_, SettingsState>,
    enabled: bool,
) -> Result<(), String> {
    let manager = state.0.lock().map_err(|e| e.to_string())?;

    // Update setting in database
    manager
        .set_setting("startup_launch", &enabled.to_string())
        .map_err(|e| e.to_string())?;

    // Apply to system autostart
    let autostart_manager = app_handle.autolaunch();
    if enabled {
        autostart_manager
            .enable()
            .map_err(|e| format!("Failed to enable autostart: {}", e))?;
        log::info!("Autostart enabled");
    } else {
        autostart_manager
            .disable()
            .map_err(|e| format!("Failed to disable autostart: {}", e))?;
        log::info!("Autostart disabled");
    }

    Ok(())
}

// ==================== Shortcut Commands ====================

/// Get all shortcut configurations
#[tauri::command]
pub fn get_shortcuts(
    state: State<'_, ShortcutManagerState>,
) -> Result<Vec<ShortcutConfig>, String> {
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
    manager
        .update_shortcut(&id, custom_keys, enabled)
        .map_err(|e| e.to_string())?;

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
    Ok(manager
        .check_conflict(&keys, exclude_id.as_deref())
        .cloned())
}

/// Toggle auto update setting
/// 校验 Claude Code CLI 路径可执行：试跑 --version，返回版本字符串。
/// 保存路径时前端先调它；失败给警告但不阻断保存（四期裁决）。
#[tauri::command]
pub fn validate_claude_cli(path: String) -> Result<String, String> {
    let work = std::env::temp_dir();
    let output = crate::companion::agent::cli_command(&path, &work)
        .arg("--version")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .map_err(|e| format!("无法执行「{}」: {}", path, e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "「{}」执行失败: {}",
            path,
            stderr.chars().take(200).collect::<String>()
        ));
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(if version.is_empty() {
        "可执行（无版本输出）".to_string()
    } else {
        version
    })
}

#[tauri::command]
pub fn toggle_auto_update(state: State<'_, SettingsState>) -> Result<bool, String> {
    let manager = state.0.lock().map_err(|e| e.to_string())?;
    let current = manager.get_settings().auto_update;
    let new_value = !current;

    manager
        .set_setting("auto_update", &new_value.to_string())
        .map_err(|e| e.to_string())?;

    log::info!("Auto update toggled: {} -> {}", current, new_value);

    Ok(new_value)
}

/// 调试模式开关：开 = debug 级日志落盘（含模型调用系统提示词），关 = Info 级。
/// 运行时生效（log 全局闸门），并持久化供下次启动恢复。
#[tauri::command]
pub fn toggle_debug_mode(state: State<'_, SettingsState>) -> Result<bool, String> {
    let manager = state.0.lock().map_err(|e| e.to_string())?;
    let current = manager.get_settings().debug_mode;
    let new_value = !current;

    manager
        .set_setting("debug_mode", &new_value.to_string())
        .map_err(|e| e.to_string())?;

    crate::apply_log_level(new_value);
    log::info!("Debug mode toggled: {} -> {}", current, new_value);

    Ok(new_value)
}

/// 获取自定义扫描目录列表（存在主 DB settings 表中，key = "custom_scan_dirs"）
#[tauri::command]
pub fn get_custom_scan_dirs(
    db_state: tauri::State<'_, crate::db::DatabaseState>,
) -> Result<Vec<String>, String> {
    let conn = rusqlite::Connection::open(&db_state.0).map_err(|e| e.to_string())?;
    let result: rusqlite::Result<String> = conn.query_row(
        "SELECT value FROM settings WHERE key = 'custom_scan_dirs'",
        [],
        |row| row.get(0),
    );
    match result {
        Ok(json) => serde_json::from_str(&json).map_err(|e| e.to_string()),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(Vec::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// 保存自定义扫描目录列表
#[tauri::command]
pub fn set_custom_scan_dirs(
    dirs: Vec<String>,
    db_state: tauri::State<'_, crate::db::DatabaseState>,
) -> Result<(), String> {
    let conn = rusqlite::Connection::open(&db_state.0).map_err(|e| e.to_string())?;
    let json = serde_json::to_string(&dirs).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('custom_scan_dirs', ?1)
         ON CONFLICT(key) DO UPDATE SET value = ?1",
        [&json],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
