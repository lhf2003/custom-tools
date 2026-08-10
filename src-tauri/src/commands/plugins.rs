use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::commands::settings::{SettingsState, ShortcutManagerState};
use crate::settings::{PluginShortcutConfig, ShortcutConflict};

/// 外部插件 trigger 声明（启动器前缀路由）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginTrigger {
    pub keyword: String,
    #[serde(default)]
    pub arg_hint: Option<String>,
}

/// 外部插件快捷键声明
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginShortcut {
    pub id: String,
    pub key: String,
    pub label: String,
}

/// 外部插件设置项声明（声明式 schema，主应用自动渲染表单）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginSetting {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub setting_type: String, // text | number | toggle | select
    #[serde(default)]
    pub options: Option<Vec<String>>,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub placeholder: Option<String>,
}

/// 外部插件 manifest（plugin.json），与前端 ExternalPluginManifest 对应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalPluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default = "default_main")]
    pub main: String,
    #[serde(default = "default_runtime")]
    pub runtime: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub triggers: Vec<PluginTrigger>,
    #[serde(default)]
    pub shortcuts: Vec<PluginShortcut>,
    #[serde(default)]
    pub settings: Vec<PluginSetting>,
}

fn default_main() -> String {
    "plugin.js".to_string()
}

fn default_runtime() -> String {
    "frontend".to_string()
}

/// 扫描结果条目：manifest 解析失败时 error 携带原因（前端标记「无效」）
#[derive(Debug, Clone, Serialize)]
pub struct PluginScanItem {
    pub manifest: Option<ExternalPluginManifest>,
    pub error: Option<String>,
    pub dir_path: String,
}

pub(crate) fn plugins_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("plugins");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 插件目录内解析 manifest；目录缺失或 plugin.json 非法 → error
fn scan_plugin_dir(dir: &Path) -> PluginScanItem {
    let dir_path = dir.to_string_lossy().to_string();
    let manifest_path = dir.join("plugin.json");
    let content = match std::fs::read_to_string(&manifest_path) {
        Ok(c) => c,
        Err(e) => {
            return PluginScanItem {
                manifest: None,
                error: Some(format!("读取 plugin.json 失败: {e}")),
                dir_path,
            };
        }
    };
    match serde_json::from_str::<ExternalPluginManifest>(&content) {
        Ok(mut manifest) => {
            // 目录名与 manifest.id 不一致时以 manifest.id 为准，但路径仍用目录
            // （保证 id 唯一性检查在目录名上，避免两个目录声明同一 id）
            manifest.main = if manifest.main.is_empty() {
                default_main()
            } else {
                manifest.main
            };
            PluginScanItem {
                manifest: Some(manifest),
                error: None,
                dir_path,
            }
        }
        Err(e) => PluginScanItem {
            manifest: None,
            error: Some(format!("plugin.json 解析失败: {e}")),
            dir_path,
        },
    }
}

/// 扫描 app_data/plugins/ 下全部插件目录
#[tauri::command]
pub fn scan_plugins(app_handle: AppHandle) -> Result<Vec<PluginScanItem>, String> {
    let dir = plugins_dir(&app_handle)?;
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(out);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        out.push(scan_plugin_dir(&path));
    }
    Ok(out)
}

/// 读取插件 bundle 内容（前端 fetch 后执行 IIFE）。只允许读取插件目录内文件。
/// preview=true 时读 .preview/ 下的试运行 bundle（AI 生成预览用）。
#[tauri::command]
pub fn read_plugin_bundle(
    app_handle: AppHandle,
    plugin_id: String,
    preview: Option<bool>,
) -> Result<String, String> {
    let base = if preview.unwrap_or(false) {
        plugins_dir(&app_handle)?.join(".preview")
    } else {
        plugins_dir(&app_handle)?
    };
    let plugin_dir = base.join(&plugin_id);
    // 路径穿越防护：确认目标在 plugins 目录内
    if !plugin_dir.starts_with(&base) {
        return Err("非法插件路径".to_string());
    }
    let manifest_path = plugin_dir.join("plugin.json");
    let manifest: ExternalPluginManifest =
        serde_json::from_str(&std::fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("plugin.json 解析失败: {e}"))?;
    let bundle_path = plugin_dir.join(&manifest.main);
    std::fs::read_to_string(&bundle_path).map_err(|e| format!("读取 {} 失败: {e}", manifest.main))
}

/// 卸载插件：删除整个插件目录
#[tauri::command]
pub fn uninstall_plugin(app_handle: AppHandle, plugin_id: String) -> Result<(), String> {
    let dir = plugins_dir(&app_handle)?;
    let plugin_dir = dir.join(&plugin_id);
    if !plugin_dir.starts_with(&dir) {
        return Err("非法插件路径".to_string());
    }
    if !plugin_dir.exists() {
        return Err("插件目录不存在".to_string());
    }
    std::fs::remove_dir_all(&plugin_dir).map_err(|e| format!("卸载失败: {e}"))
}

/// 收集启用插件的快捷键声明（应用用户自定义键位覆盖：
/// settings 表 plugins.<id>.shortcut.<shortcut_id> 存在时替代 manifest 默认键）。
/// sync 注册与冲突检测共用，保证两处看到的「生效键位」一致。
pub(crate) fn collect_plugin_shortcuts(
    app_handle: &AppHandle,
    settings_state: &SettingsState,
) -> Result<Vec<PluginShortcutConfig>, String> {
    let items = scan_plugins(app_handle.clone())?;
    let settings = settings_state.0.lock().map_err(|e| e.to_string())?;

    let mut shortcuts = Vec::new();
    for item in items {
        let Some(manifest) = item.manifest else {
            continue;
        };
        // 仅启用插件注册（enabled 状态与市场 tab 同源：settings 表 KV）
        let enabled = settings
            .get_setting(&format!("plugins.{}.enabled", manifest.id))
            .map_err(|e| e.to_string())?
            .as_deref()
            == Some("1");
        if !enabled {
            continue;
        }
        for sc in manifest.shortcuts {
            let custom = settings
                .get_setting(&format!("plugins.{}.shortcut.{}", manifest.id, sc.id))
                .map_err(|e| e.to_string())?
                .filter(|k| !k.is_empty());
            shortcuts.push(PluginShortcutConfig {
                plugin_id: manifest.id.clone(),
                id: sc.id,
                key: custom.unwrap_or(sc.key),
                label: sc.label,
            });
        }
    }
    Ok(shortcuts)
}

/// 同步外部插件快捷键贡献点：扫描启用插件的 manifest.shortcuts → 注销旧的 → 注册新的。
/// 返回冲突列表（OS 注册失败 / 格式非法）；冲突不阻塞插件使用，前端标记 + toast。
#[tauri::command]
pub fn sync_plugin_shortcuts(
    app_handle: AppHandle,
    settings_state: State<'_, SettingsState>,
    shortcut_state: State<'_, ShortcutManagerState>,
) -> Result<Vec<ShortcutConflict>, String> {
    let shortcuts = collect_plugin_shortcuts(&app_handle, &settings_state)?;
    let mut manager = shortcut_state.0.lock().map_err(|e| e.to_string())?;
    Ok(manager.sync_plugin_shortcuts(&app_handle, &shortcuts))
}

/// 更新插件快捷键的自定义键位（None / 空串 = 恢复 manifest 默认），随后全量重同步。
/// 返回重同步后的冲突列表，前端据此刷新行内标记。
#[tauri::command]
pub fn update_plugin_shortcut(
    app_handle: AppHandle,
    settings_state: State<'_, SettingsState>,
    shortcut_state: State<'_, ShortcutManagerState>,
    plugin_id: String,
    shortcut_id: String,
    custom_keys: Option<String>,
) -> Result<Vec<ShortcutConflict>, String> {
    {
        let settings = settings_state.0.lock().map_err(|e| e.to_string())?;
        let key = format!("plugins.{plugin_id}.shortcut.{shortcut_id}");
        match custom_keys.as_deref().filter(|k| !k.is_empty()) {
            Some(k) => settings.set_setting(&key, k).map_err(|e| e.to_string())?,
            None => settings.delete_setting(&key).map_err(|e| e.to_string())?,
        }
    }
    let shortcuts = collect_plugin_shortcuts(&app_handle, &settings_state)?;
    let mut manager = shortcut_state.0.lock().map_err(|e| e.to_string())?;
    Ok(manager.sync_plugin_shortcuts(&app_handle, &shortcuts))
}

