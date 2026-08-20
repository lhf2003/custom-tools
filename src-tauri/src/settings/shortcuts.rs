use rusqlite::{Connection, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// 快捷键配置项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShortcutConfig {
    pub id: String,
    pub name: String,
    pub description: String,
    pub default_keys: String,
    pub custom_keys: Option<String>,
    pub enabled: bool,
}

impl ShortcutConfig {
    /// 获取实际生效的快捷键
    pub fn effective_keys(&self) -> String {
        self.custom_keys
            .clone()
            .filter(|k| !k.is_empty())
            .unwrap_or_else(|| self.default_keys.clone())
    }

    /// 是否使用了自定义快捷键
    pub fn is_custom(&self) -> bool {
        self.custom_keys.is_some()
    }
}

/// 快捷键动作类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ShortcutAction {
    ToggleWindow,
    OpenClipboard,
    OpenNotes,
    OpenPasswords,
    OpenSettings,
    OpenEverything,
    OpenMemo,
    TranslateSelection,
    VoiceInput,
}

impl ShortcutAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            ShortcutAction::ToggleWindow => "toggle_window",
            ShortcutAction::OpenClipboard => "open_clipboard",
            ShortcutAction::OpenNotes => "open_notes",
            ShortcutAction::OpenPasswords => "open_passwords",
            ShortcutAction::OpenSettings => "open_settings",
            ShortcutAction::OpenEverything => "open_everything",
            ShortcutAction::OpenMemo => "open_memo",
            ShortcutAction::TranslateSelection => "translate_selection",
            ShortcutAction::VoiceInput => "voice_input",
        }
    }

    pub fn from_id(s: &str) -> Option<Self> {
        match s {
            "toggle_window" => Some(ShortcutAction::ToggleWindow),
            "open_clipboard" => Some(ShortcutAction::OpenClipboard),
            "open_notes" => Some(ShortcutAction::OpenNotes),
            "open_passwords" => Some(ShortcutAction::OpenPasswords),
            "open_settings" => Some(ShortcutAction::OpenSettings),
            "open_everything" => Some(ShortcutAction::OpenEverything),
            "open_memo" => Some(ShortcutAction::OpenMemo),
            "translate_selection" => Some(ShortcutAction::TranslateSelection),
            "voice_input" => Some(ShortcutAction::VoiceInput),
            _ => None,
        }
    }
}

/// 默认快捷键配置
pub fn get_default_shortcuts() -> Vec<ShortcutConfig> {
    vec![
        ShortcutConfig {
            id: "toggle_window".to_string(),
            name: "呼出搜索".to_string(),
            description: "显示/隐藏主窗口".to_string(),
            default_keys: "Alt+Space".to_string(),
            custom_keys: None,
            enabled: true,
        },
        ShortcutConfig {
            id: "open_clipboard".to_string(),
            name: "打开剪贴板".to_string(),
            description: "快速访问剪贴板历史".to_string(),
            default_keys: "Ctrl+Shift+C".to_string(),
            custom_keys: None,
            enabled: true,
        },
        ShortcutConfig {
            id: "open_notes".to_string(),
            name: "打开笔记".to_string(),
            description: "快速访问 Markdown 笔记".to_string(),
            default_keys: "Ctrl+Shift+N".to_string(),
            custom_keys: None,
            enabled: true,
        },
        ShortcutConfig {
            id: "open_passwords".to_string(),
            name: "打开密码管理".to_string(),
            description: "快速访问密码管理器".to_string(),
            default_keys: "Ctrl+Shift+P".to_string(),
            custom_keys: None,
            enabled: true,
        },
        ShortcutConfig {
            id: "open_settings".to_string(),
            name: "打开设置".to_string(),
            description: "快速访问设置页面".to_string(),
            default_keys: "Ctrl+Shift+S".to_string(),
            custom_keys: None,
            enabled: true,
        },
        ShortcutConfig {
            id: "open_everything".to_string(),
            name: "打开文件搜索".to_string(),
            description: "快速访问文件搜索（Everything）".to_string(),
            default_keys: "Ctrl+Shift+F".to_string(),
            custom_keys: None,
            enabled: true,
        },
        ShortcutConfig {
            id: "open_memo".to_string(),
            name: "打开备忘".to_string(),
            description: "快速访问备忘插件".to_string(),
            default_keys: "Ctrl+Shift+M".to_string(),
            custom_keys: None,
            enabled: true,
        },
        ShortcutConfig {
            id: "translate_selection".to_string(),
            name: "划词翻译".to_string(),
            description: "翻译当前选中的文本".to_string(),
            default_keys: "Ctrl+Shift+T".to_string(),
            custom_keys: None,
            enabled: true,
        },
        ShortcutConfig {
            id: "voice_input".to_string(),
            name: "语音输入".to_string(),
            description: "唤醒全局语音输入浮窗（开始/结束录音）".to_string(),
            default_keys: "Ctrl+Alt+V".to_string(),
            custom_keys: None,
            enabled: true,
        },
    ]
}

/// 外部插件快捷键声明（从 manifest.shortcuts 展开，携带插件 id）
#[derive(Debug, Clone)]
pub struct PluginShortcutConfig {
    pub plugin_id: String,
    pub id: String,
    pub key: String,
    pub label: String,
}

/// 快捷键冲突（OS 注册失败或格式非法；失败不阻塞插件使用，仅标记 + toast）
#[derive(Debug, Clone, Serialize)]
pub struct ShortcutConflict {
    pub plugin_id: String,
    pub shortcut_id: String,
    pub key: String,
    pub reason: String,
}

/// 快捷键管理器
pub struct ShortcutManager {
    db_path: String,
    configs: HashMap<String, ShortcutConfig>,
    /// 已注册的外部插件快捷键（注销时按 Shortcut 逐个 unregister）
    plugin_shortcuts: HashMap<String, Shortcut>,
}

impl ShortcutManager {
    pub fn new(db_path: String) -> Self {
        let mut manager = Self {
            db_path,
            configs: HashMap::new(),
            plugin_shortcuts: HashMap::new(),
        };

        if let Err(e) = manager.init() {
            log::error!("Failed to initialize shortcuts: {}", e);
        }

        manager
    }

    /// 初始化：加载配置（shortcuts 表结构由 db::init_tables 统一创建）
    fn init(&mut self) -> Result<()> {
        self.load_configs()
    }

    /// 加载配置：默认配置 + 用户自定义覆盖
    fn load_configs(&mut self) -> Result<()> {
        let conn = Connection::open(&self.db_path)?;

        // 从数据库加载用户自定义
        let mut stmt = conn.prepare("SELECT id, custom_keys, enabled FROM shortcuts")?;
        let rows = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let custom_keys: Option<String> = row.get(1)?;
            let enabled: bool = row.get(2)?;
            Ok((id, custom_keys, enabled))
        })?;

        let mut user_overrides: HashMap<String, (Option<String>, bool)> = HashMap::new();
        for (id, custom_keys, enabled) in rows.flatten() {
            user_overrides.insert(id, (custom_keys, enabled));
        }

        // 合并默认配置和用户覆盖
        self.configs.clear();
        for mut config in get_default_shortcuts() {
            if let Some((custom_keys, enabled)) = user_overrides.get(&config.id) {
                config.custom_keys = custom_keys.clone();
                config.enabled = *enabled;
            }
            self.configs.insert(config.id.clone(), config);
        }

        Ok(())
    }

    /// 获取所有快捷键配置
    pub fn get_all_configs(&self) -> Vec<ShortcutConfig> {
        const ORDER: &[&str] = &[
            "toggle_window",
            "open_clipboard",
            "open_notes",
            "open_everything",
            "open_memo",
            "open_settings",
            "open_passwords",
            "translate_selection",
        ];
        let mut configs: Vec<_> = self.configs.values().cloned().collect();
        configs.sort_by_key(|c| {
            ORDER
                .iter()
                .position(|&id| id == c.id)
                .unwrap_or(usize::MAX)
        });
        configs
    }

    /// 获取单个快捷键配置
    pub fn get_config(&self, id: &str) -> Option<ShortcutConfig> {
        self.configs.get(id).cloned()
    }

    /// 更新快捷键
    pub fn update_shortcut(
        &mut self,
        id: &str,
        custom_keys: Option<String>,
        enabled: bool,
    ) -> Result<()> {
        let conn = Connection::open(&self.db_path)?;

        // 验证ID是否存在
        if !self.configs.contains_key(id) {
            return Err(rusqlite::Error::InvalidParameterName(id.to_string()));
        }

        // 更新数据库（enabled 存为整数 0/1，custom_keys 为 None 时存 NULL）
        conn.execute(
            "INSERT OR REPLACE INTO shortcuts (id, custom_keys, enabled, updated_at)
             VALUES (?1, ?2, ?3, datetime('now'))",
            rusqlite::params![
                id,
                custom_keys.as_deref().filter(|s| !s.is_empty()),
                enabled as i64
            ],
        )?;

        // 更新内存缓存
        if let Some(config) = self.configs.get_mut(id) {
            config.custom_keys = custom_keys.filter(|k| !k.is_empty());
            config.enabled = enabled;
        }

        Ok(())
    }

    /// 重置快捷键为默认值
    pub fn reset_shortcut(&mut self, id: &str) -> Result<()> {
        let conn = Connection::open(&self.db_path)?;

        // 从数据库删除用户自定义
        conn.execute("DELETE FROM shortcuts WHERE id = ?1", [id])?;

        // 恢复默认值
        if let Some(default) = get_default_shortcuts().into_iter().find(|c| c.id == id) {
            if let Some(config) = self.configs.get_mut(id) {
                config.custom_keys = None;
                config.enabled = default.enabled;
            }
        }

        Ok(())
    }

    /// 重置所有快捷键
    pub fn reset_all(&mut self) -> Result<()> {
        let conn = Connection::open(&self.db_path)?;

        // 清空用户自定义表
        conn.execute("DELETE FROM shortcuts", [])?;

        // 恢复所有默认值
        self.configs.clear();
        for config in get_default_shortcuts() {
            self.configs.insert(config.id.clone(), config);
        }

        Ok(())
    }

    /// 检查快捷键是否已存在（用于冲突检测）
    pub fn check_conflict(&self, keys: &str, exclude_id: Option<&str>) -> Option<&ShortcutConfig> {
        self.configs
            .values()
            .find(|c| c.enabled && c.effective_keys() == keys && Some(c.id.as_str()) != exclude_id)
    }

    /// 注册所有启用的快捷键到系统
    pub fn register_all(&self, app_handle: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        let shortcut_manager = app_handle.global_shortcut();

        for config in self.configs.values() {
            if !config.enabled {
                continue;
            }

            let keys = config.effective_keys();
            if let Ok(shortcut) = parse_shortcut(&keys) {
                let action_id = config.id.clone();
                match shortcut_manager.on_shortcut(shortcut, move |app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        handle_shortcut_action(app, &action_id);
                    }
                }) {
                    Ok(_) => log::info!("Registered shortcut {} for {}", keys, config.id),
                    Err(e) => log::warn!("Failed to register shortcut {}: {}", keys, e),
                }
            } else {
                log::warn!("Invalid shortcut format: {}", keys);
            }
        }

        Ok(())
    }

    /// 注销并重新注册所有快捷键（用于配置更新后）
    pub fn reregister_all(&self, app_handle: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        let shortcut_manager = app_handle.global_shortcut();
        shortcut_manager.unregister_all()?;
        self.register_all(app_handle)?;
        Ok(())
    }

    /// 全量同步外部插件快捷键：注销旧的 → 注册新的（启用插件的 manifest.shortcuts）。
    /// 返回冲突列表（OS 注册失败 / 格式非法），失败不阻塞插件使用，仅标记 + toast。
    pub fn sync_plugin_shortcuts(
        &mut self,
        app_handle: &AppHandle,
        shortcuts: &[PluginShortcutConfig],
    ) -> Vec<ShortcutConflict> {
        let shortcut_manager = app_handle.global_shortcut();

        // 1. 注销全部旧插件快捷键（plugin_shortcuts 只跟踪插件部分，不碰内置）
        for shortcut in self.plugin_shortcuts.drain().map(|(_, s)| s) {
            if let Err(e) = shortcut_manager.unregister(shortcut) {
                log::warn!("Failed to unregister plugin shortcut: {}", e);
            }
        }

        // 2. 注册新的；回调统一 action_id = plugin.<pluginId>（同插件多快捷键共用）
        let mut conflicts = Vec::new();
        for sc in shortcuts {
            let action_id = format!("plugin.{}", sc.plugin_id);
            match parse_shortcut(&sc.key) {
                Ok(shortcut) => {
                    let action_id_clone = action_id.clone();
                    match shortcut_manager.on_shortcut(shortcut.clone(), move |app, _s, event| {
                        if event.state() == ShortcutState::Pressed {
                            handle_shortcut_action(app, &action_id_clone);
                        }
                    }) {
                        Ok(_) => {
                            self.plugin_shortcuts.insert(
                                format!("{}:{}", sc.plugin_id, sc.id),
                                shortcut,
                            );
                            log::info!(
                                "Registered plugin shortcut {} for {}",
                                sc.key,
                                sc.plugin_id
                            );
                        }
                        Err(e) => conflicts.push(ShortcutConflict {
                            plugin_id: sc.plugin_id.clone(),
                            shortcut_id: sc.id.clone(),
                            key: sc.key.clone(),
                            reason: format!("注册失败，快捷键被占用"),
                        }),
                    }
                }
                Err(e) => conflicts.push(ShortcutConflict {
                    plugin_id: sc.plugin_id.clone(),
                    shortcut_id: sc.id.clone(),
                    key: sc.key.clone(),
                    reason: format!("快捷键格式非法: {e}"),
                }),
            }
        }
        conflicts
    }
}

/// 解析快捷键字符串为 Tauri Shortcut
/// 格式: "Ctrl+Shift+Space", "Alt+F4", "Cmd+N"
fn parse_shortcut(keys: &str) -> Result<Shortcut, String> {
    let parts: Vec<&str> = keys.split('+').map(|s| s.trim()).collect();

    let mut modifiers = Modifiers::empty();
    let mut key_code: Option<Code> = None;

    for part in parts {
        let upper = part.to_uppercase();
        match upper.as_str() {
            "CTRL" | "CONTROL" => modifiers |= Modifiers::CONTROL,
            "SHIFT" => modifiers |= Modifiers::SHIFT,
            "ALT" => modifiers |= Modifiers::ALT,
            "CMD" | "COMMAND" | "META" | "SUPER" => modifiers |= Modifiers::META,
            "OPTION" => modifiers |= Modifiers::ALT,
            _ => {
                // 尝试解析为主键
                key_code = Some(parse_key_code(part)?);
            }
        }
    }

    match key_code {
        Some(code) => Ok(Shortcut::new(
            if modifiers.is_empty() {
                None
            } else {
                Some(modifiers)
            },
            code,
        )),
        None => Err(format!("No key code found in: {}", keys)),
    }
}

/// 解析按键字符串为 Code
fn parse_key_code(key: &str) -> Result<Code, String> {
    let upper = key.to_uppercase();

    // 单个字母 A-Z
    if upper.len() == 1 {
        let c = upper.chars().next().unwrap();
        return match c {
            'A' => Ok(Code::KeyA),
            'B' => Ok(Code::KeyB),
            'C' => Ok(Code::KeyC),
            'D' => Ok(Code::KeyD),
            'E' => Ok(Code::KeyE),
            'F' => Ok(Code::KeyF),
            'G' => Ok(Code::KeyG),
            'H' => Ok(Code::KeyH),
            'I' => Ok(Code::KeyI),
            'J' => Ok(Code::KeyJ),
            'K' => Ok(Code::KeyK),
            'L' => Ok(Code::KeyL),
            'M' => Ok(Code::KeyM),
            'N' => Ok(Code::KeyN),
            'O' => Ok(Code::KeyO),
            'P' => Ok(Code::KeyP),
            'Q' => Ok(Code::KeyQ),
            'R' => Ok(Code::KeyR),
            'S' => Ok(Code::KeyS),
            'T' => Ok(Code::KeyT),
            'U' => Ok(Code::KeyU),
            'V' => Ok(Code::KeyV),
            'W' => Ok(Code::KeyW),
            'X' => Ok(Code::KeyX),
            'Y' => Ok(Code::KeyY),
            'Z' => Ok(Code::KeyZ),
            _ => Err(format!("Unknown letter key: {}", key)),
        };
    }

    // 数字 0-9
    if key.len() == 1 && key.chars().next().unwrap().is_ascii_digit() {
        let c = key.chars().next().unwrap();
        return match c {
            '0' => Ok(Code::Digit0),
            '1' => Ok(Code::Digit1),
            '2' => Ok(Code::Digit2),
            '3' => Ok(Code::Digit3),
            '4' => Ok(Code::Digit4),
            '5' => Ok(Code::Digit5),
            '6' => Ok(Code::Digit6),
            '7' => Ok(Code::Digit7),
            '8' => Ok(Code::Digit8),
            '9' => Ok(Code::Digit9),
            _ => Err(format!("Unknown digit key: {}", key)),
        };
    }

    // 功能键 F1-F35
    if upper.starts_with('F') {
        if let Ok(num) = key[1..].parse::<u32>() {
            return match num {
                1 => Ok(Code::F1),
                2 => Ok(Code::F2),
                3 => Ok(Code::F3),
                4 => Ok(Code::F4),
                5 => Ok(Code::F5),
                6 => Ok(Code::F6),
                7 => Ok(Code::F7),
                8 => Ok(Code::F8),
                9 => Ok(Code::F9),
                10 => Ok(Code::F10),
                11 => Ok(Code::F11),
                12 => Ok(Code::F12),
                13 => Ok(Code::F13),
                14 => Ok(Code::F14),
                15 => Ok(Code::F15),
                16 => Ok(Code::F16),
                17 => Ok(Code::F17),
                18 => Ok(Code::F18),
                19 => Ok(Code::F19),
                20 => Ok(Code::F20),
                21 => Ok(Code::F21),
                22 => Ok(Code::F22),
                23 => Ok(Code::F23),
                24 => Ok(Code::F24),
                25 => Ok(Code::F25),
                26 => Ok(Code::F26),
                27 => Ok(Code::F27),
                28 => Ok(Code::F28),
                29 => Ok(Code::F29),
                30 => Ok(Code::F30),
                31 => Ok(Code::F31),
                32 => Ok(Code::F32),
                33 => Ok(Code::F33),
                34 => Ok(Code::F34),
                35 => Ok(Code::F35),
                _ => Err(format!("Function key out of range: {}", key)),
            };
        }
    }

    // 特殊键
    match upper.as_str() {
        "SPACE" | " " => Ok(Code::Space),
        "ENTER" | "RETURN" => Ok(Code::Enter),
        "ESC" | "ESCAPE" => Ok(Code::Escape),
        "TAB" => Ok(Code::Tab),
        "BACKSPACE" | "BACK" => Ok(Code::Backspace),
        "DELETE" | "DEL" => Ok(Code::Delete),
        "INSERT" | "INS" => Ok(Code::Insert),
        "HOME" => Ok(Code::Home),
        "END" => Ok(Code::End),
        "PAGEUP" | "PAGE_UP" | "PGUP" => Ok(Code::PageUp),
        "PAGEDOWN" | "PAGE_DOWN" | "PGDN" => Ok(Code::PageDown),
        "UP" | "ARROWUP" | "ARROW_UP" => Ok(Code::ArrowUp),
        "DOWN" | "ARROWDOWN" | "ARROW_DOWN" => Ok(Code::ArrowDown),
        "LEFT" | "ARROWLEFT" | "ARROW_LEFT" => Ok(Code::ArrowLeft),
        "RIGHT" | "ARROWRIGHT" | "ARROW_RIGHT" => Ok(Code::ArrowRight),
        "COMMA" | "," => Ok(Code::Comma),
        "PERIOD" | "." => Ok(Code::Period),
        "SLASH" | "/" => Ok(Code::Slash),
        "SEMICOLON" | ";" => Ok(Code::Semicolon),
        "QUOTE" | "'" | "\"" => Ok(Code::Quote),
        "BRACKETLEFT" | "[" => Ok(Code::BracketLeft),
        "BRACKETRIGHT" | "]" => Ok(Code::BracketRight),
        "BACKSLASH" | "\\" => Ok(Code::Backslash),
        "BACKQUOTE" | "`" | "~" => Ok(Code::Backquote),
        "MINUS" | "-" => Ok(Code::Minus),
        "EQUAL" | "=" => Ok(Code::Equal),
        _ => Err(format!("Unknown key: {}", key)),
    }
}

/// 处理快捷键动作
fn handle_shortcut_action(app_handle: &AppHandle, action_id: &str) {
    use tauri::Emitter;

    // 全屏静音：前台全屏（游戏/全屏视频）时所有快捷键不响应
    if crate::game_mode::should_mute(app_handle) {
        log::debug!("全屏静音中，忽略快捷键 {}", action_id);
        return;
    }

    match action_id {
        "toggle_window" => {
            // 复用 lib.rs 的 toggle_main_window（含 HWND 捕获、防闪烁、窗口定位）
            crate::toggle_main_window(app_handle);
        }
        // 外部插件快捷键：action_id = plugin.<pluginId>，显示窗口 + 打开插件视图
        action if action.starts_with("plugin.") => {
            let plugin_id = action.trim_start_matches("plugin.").to_string();

            // 捕获前台窗口以支持自动粘贴
            #[cfg(windows)]
            crate::capture_prev_window_hwnd(app_handle);

            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            crate::emit_window_shown(app_handle);
            let _ = app_handle.emit("shortcut:open_module", plugin_id);
        }
        // 划词翻译：捕获选区 → 弹浮窗 → 流式翻译（不碰主窗口，前台焦点留在原应用）
        "translate_selection" => {
            crate::translate::trigger_selection_translate(app_handle);
        }
        // 语音输入：toggle 浮窗录音（不碰主窗口；开始/结束由浮窗前端按状态裁决）
        "voice_input" => {
            crate::voice::toggle(app_handle);
        }
        "open_clipboard" | "open_notes" | "open_passwords" | "open_settings"
        | "open_everything" | "open_memo" => {
            // 捕获前台窗口以支持自动粘贴
            #[cfg(windows)]
            crate::capture_prev_window_hwnd(app_handle);

            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            crate::emit_window_shown(app_handle);
            let module = match action_id {
                "open_clipboard" => "clipboard",
                "open_notes" => "notes",
                "open_passwords" => "passwords",
                "open_settings" => "settings",
                "open_everything" => "everything",
                "open_memo" => "memo",
                _ => "",
            };
            let _ = app_handle.emit("shortcut:open_module", module);
        }
        _ => {
            log::warn!("Unknown shortcut action: {}", action_id);
        }
    }
}
