use crate::settings::{AppSettings, SettingsManager, ShortcutConfig, ShortcutManager};
use std::sync::Mutex;
use tauri::{Manager, State};
use tauri_plugin_autostart::ManagerExt;

pub struct SettingsState(pub Mutex<SettingsManager>);
pub struct ShortcutManagerState(pub Mutex<ShortcutManager>);

/// Get all settings（敏感字段脱敏——CASE-001 裁决 4「token 不出后端」）：
/// 第三方 MCP token 只经 list_external_mcp_servers 的 has_token 通道进前端，
/// 此处整串置空；llm_api_key 留尾 4 位掩码（设置页写回走 set_setting 专用命令）
#[tauri::command]
pub fn get_settings(state: State<'_, SettingsState>) -> Result<AppSettings, String> {
    let manager = state.0.lock().map_err(|e| e.to_string())?;
    let mut settings = manager.get_settings();
    settings.mcp_external_servers.clear();
    settings.llm_api_key = mask_secret(&settings.llm_api_key);
    Ok(settings)
}

/// 密钥掩码：空串原样；非空只留尾 4 位（不足 4 位整体隐藏）
fn mask_secret(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().collect();
    match chars.len() {
        0 => String::new(),
        1..=4 => "••••••".to_string(),
        _ => format!("••••••{}", chars[chars.len() - 4..].iter().collect::<String>()),
    }
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

/// 冲突检测结果：只需冲突项名称供前端提示（内置与插件快捷键统一为此轻量结构）
#[derive(Debug, Clone, serde::Serialize)]
pub struct ShortcutConflictInfo {
    pub name: String,
}

/// Check if a shortcut conflicts with existing ones
#[tauri::command]
pub fn check_shortcut_conflict(
    app_handle: tauri::AppHandle,
    state: State<'_, ShortcutManagerState>,
    settings_state: State<'_, SettingsState>,
    keys: String,
    exclude_id: Option<String>,
) -> Result<Option<ShortcutConflictInfo>, String> {
    let manager = state.0.lock().map_err(|e| e.to_string())?;
    // 内置快捷键：exclude_id 命中内置 id 时排除自身
    if let Some(config) = manager.check_conflict(&keys, exclude_id.as_deref()) {
        return Ok(Some(ShortcutConflictInfo {
            name: config.name.clone(),
        }));
    }
    drop(manager);

    // 外部插件快捷键：exclude_id 形如 plugin.<pluginId>.<shortcutId> 时排除自身
    let exclude_plugin = exclude_id
        .as_deref()
        .and_then(|id| id.strip_prefix("plugin."));
    let shortcuts = crate::commands::plugins::collect_plugin_shortcuts(&app_handle, &settings_state)?;
    for sc in shortcuts {
        if sc.key != keys {
            continue;
        }
        let self_id = format!("{}.{}", sc.plugin_id, sc.id);
        if exclude_plugin == Some(self_id.as_str()) {
            continue;
        }
        return Ok(Some(ShortcutConflictInfo { name: sc.label }));
    }
    Ok(None)
}

/// Toggle auto update setting
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

/// 全屏静音开关：开 = 前台全屏（游戏/全屏视频）时禁用快捷键与弹窗。
/// 持久化到设置，并同步运行时 GameModeState（should_mute 实时读取）。
#[tauri::command]
pub fn toggle_game_mode_mute(
    app_handle: tauri::AppHandle,
    state: State<'_, SettingsState>,
) -> Result<bool, String> {
    let manager = state.0.lock().map_err(|e| e.to_string())?;
    let current = manager.get_settings().game_mode_mute;
    let new_value = !current;

    manager
        .set_setting("game_mode_mute", &new_value.to_string())
        .map_err(|e| e.to_string())?;

    if let Some(game_mode) = app_handle.try_state::<crate::game_mode::GameModeState>() {
        game_mode.set_enabled(new_value);
    } else {
        log::warn!("GameModeState 未托管，运行时静音开关未同步（DB 已更新，重启后生效）");
    }
    log::info!("Game mode mute toggled: {} -> {}", current, new_value);

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
