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
}

impl ShortcutAction {
    pub fn as_str(&self) -> &'static str {
        match self {
            ShortcutAction::ToggleWindow => "toggle_window",
            ShortcutAction::OpenClipboard => "open_clipboard",
            ShortcutAction::OpenNotes => "open_notes",
            ShortcutAction::OpenPasswords => "open_passwords",
            ShortcutAction::OpenSettings => "open_settings",
        }
    }

    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "toggle_window" => Some(ShortcutAction::ToggleWindow),
            "open_clipboard" => Some(ShortcutAction::OpenClipboard),
            "open_notes" => Some(ShortcutAction::OpenNotes),
            "open_passwords" => Some(ShortcutAction::OpenPasswords),
            "open_settings" => Some(ShortcutAction::OpenSettings),
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
            default_keys: "Ctrl+Shift+Space".to_string(),
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
            default_keys: "Ctrl+Shift+,".to_string(),
            custom_keys: None,
            enabled: true,
        },
    ]
}

/// 快捷键管理器
pub struct ShortcutManager {
    db_path: String,
    configs: HashMap<String, ShortcutConfig>,
}

impl ShortcutManager {
    pub fn new(db_path: String) -> Self {
        let mut manager = Self {
            db_path,
            configs: HashMap::new(),
        };

        if let Err(e) = manager.init() {
            log::error!("Failed to initialize shortcuts: {}", e);
        }

        manager
    }

    /// 初始化数据库和加载配置
    fn init(&mut self) -> Result<()> {
        let conn = Connection::open(&self.db_path)?;

        // 创建快捷键表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS shortcuts (
                id TEXT PRIMARY KEY,
                custom_keys TEXT,
                enabled BOOLEAN DEFAULT 1,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // 加载所有配置（默认 + 用户自定义）
        self.load_configs()?;

        Ok(())
    }

    /// 加载配置：默认配置 + 用户自定义覆盖
    fn load_configs(&mut self) -> Result<()> {
        let conn = Connection::open(&self.db_path)?;

        // 从数据库加载用户自定义
        let mut stmt = conn.prepare("SELECT id, custom_keys, enabled FROM shortcuts")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, bool>(2)?,
            ))
        })?;

        let mut user_overrides: HashMap<String, (Option<String>, bool)> = HashMap::new();
        for row in rows {
            if let Ok((id, custom_keys, enabled)) = row {
                user_overrides.insert(id, (custom_keys, enabled));
            }
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
        let mut configs: Vec<_> = self.configs.values().cloned().collect();
        configs.sort_by(|a, b| a.id.cmp(&b.id));
        configs
    }

    /// 获取单个快捷键配置
    pub fn get_config(&self, id: &str) -> Option<ShortcutConfig> {
        self.configs.get(id).cloned()
    }

    /// 更新快捷键
    pub fn update_shortcut(&mut self, id: &str, custom_keys: Option<String>, enabled: bool) -> Result<()> {
        let conn = Connection::open(&self.db_path)?;

        // 验证ID是否存在
        if !self.configs.contains_key(id) {
            return Err(rusqlite::Error::InvalidParameterName(id.to_string()));
        }

        // 更新数据库
        conn.execute(
            "INSERT OR REPLACE INTO shortcuts (id, custom_keys, enabled, updated_at)
             VALUES (?1, ?2, ?3, datetime('now'))",
            [id, custom_keys.as_deref().unwrap_or(""), &enabled.to_string()],
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
        self.configs.values().find(|c| {
            c.enabled
                && c.effective_keys() == keys
                && Some(c.id.as_str()) != exclude_id
        })
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
            if modifiers.is_empty() { None } else { Some(modifiers) },
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

    match action_id {
        "toggle_window" => {
            // 直接处理窗口显示/隐藏
            if let Some(window) = app_handle.get_webview_window("main") {
                match window.is_visible() {
                    Ok(true) => { let _ = window.hide(); }
                    Ok(false) => {
                        const TOP_PADDING: i32 = 100;
                        let _ = window.center();
                        if let Ok(pos) = window.outer_position() {
                            let monitor = window.current_monitor().ok().flatten()
                                .or_else(|| window.primary_monitor().ok().flatten());
                            if let Some(m) = monitor {
                                let y = m.position().y + TOP_PADDING;
                                let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: pos.x, y }));
                            }
                        }
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    Err(e) => log::error!("Failed to check window visibility: {}", e),
                }
            }
        }
        "open_clipboard" => {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app_handle.emit("shortcut:open_module", "clipboard");
        }
        "open_notes" => {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app_handle.emit("shortcut:open_module", "notes");
        }
        "open_passwords" => {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app_handle.emit("shortcut:open_module", "passwords");
        }
        "open_settings" => {
            if let Some(window) = app_handle.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app_handle.emit("shortcut:open_module", "settings");
        }
        _ => {
            log::warn!("Unknown shortcut action: {}", action_id);
        }
    }
}
