use rusqlite::{Connection, Result};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

pub mod shortcuts;
pub use shortcuts::{get_default_shortcuts, ShortcutConfig, ShortcutManager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub always_on_top: bool,
    pub hide_on_blur: bool,
    pub startup_launch: bool,
    pub theme: String,
    pub window_opacity: f32,
    pub clipboard_keep_days: i32,
    pub auto_update: bool,
    pub clipboard_auto_paste: bool,
    pub llm_base_url: String,
    pub llm_api_key: String,
    pub llm_model: String,
    pub llm_thinking_mode: bool,
    pub claude_code_enabled: bool,
    pub claude_code_bin_path: String,
    pub claude_code_work_dir: String,
    pub companion_enabled: bool,
    pub companion_paused: bool,
    pub companion_retention_days: i32,
    pub companion_long_work_minutes: i32,
    pub companion_daily_report: bool,
    pub companion_monologue: bool,
    pub debug_mode: bool,
    /// 被手动关闭的陪伴工具名列表（JSON 数组字符串，只含可开关的非核心工具）
    pub disabled_companion_tools: String,
    /// Shell 工具权限模式：confirm_all（每次确认）| accept_edits（预留，同 confirm_all）| unattended（安全命令自动放行）
    pub shell_permission_mode: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            always_on_top: false,
            hide_on_blur: true,
            startup_launch: false,
            theme: "system".to_string(),
            window_opacity: 0.95,
            clipboard_keep_days: 30,
            auto_update: true,
            clipboard_auto_paste: true,
            llm_base_url: "https://api.openai.com/v1".to_string(),
            llm_api_key: String::new(),
            llm_model: "gpt-4o-mini".to_string(),
            llm_thinking_mode: false,
            claude_code_enabled: false,
            claude_code_bin_path: "claude".to_string(),
            claude_code_work_dir: String::new(),
            companion_enabled: true,
            companion_paused: false,
            companion_retention_days: 30,
            companion_long_work_minutes: 90,
            companion_daily_report: true,
            companion_monologue: true,
            debug_mode: false,
            disabled_companion_tools: "[]".to_string(),
            shell_permission_mode: "confirm_all".to_string(),
        }
    }
}

/// SettingsManager 管辖的全部键。settings 表与陪伴模块状态、
/// custom_scan_dirs / notes_directory 共享，reset 只能按此白名单删键——
/// 全表 DELETE 会误删陪伴调度水位和扫描目录配置
const KNOWN_KEYS: [&str; 24] = [
    "always_on_top",
    "hide_on_blur",
    "startup_launch",
    "theme",
    "window_opacity",
    "clipboard_keep_days",
    "auto_update",
    "clipboard_auto_paste",
    "llm_base_url",
    "llm_api_key",
    "llm_model",
    "llm_thinking_mode",
    "claude_code_enabled",
    "claude_code_bin_path",
    "claude_code_work_dir",
    "companion_enabled",
    "companion_paused",
    "companion_retention_days",
    "companion_long_work_minutes",
    "companion_daily_report",
    "companion_monologue",
    "debug_mode",
    "disabled_companion_tools",
    "shell_permission_mode",
];

pub struct SettingsManager {
    db_path: String,
    cache: Mutex<AppSettings>,
}

impl SettingsManager {
    pub fn new(db_path: String) -> Self {
        let manager = Self {
            db_path,
            cache: Mutex::new(AppSettings::default()),
        };
        // Initialize database and load settings
        if let Err(e) = manager.init() {
            log::error!("Failed to initialize settings: {}", e);
        }
        manager
    }

    fn init(&self) -> Result<()> {
        // settings 表结构由 db::init_tables 统一创建（主库 flowhub.db），
        // 这里只负责把行加载进缓存
        let settings = self.load_from_db()?;
        if let Ok(mut cache) = self.cache.lock() {
            *cache = settings;
        }

        Ok(())
    }

    fn load_from_db(&self) -> Result<AppSettings> {
        let conn = Connection::open(&self.db_path)?;
        let mut settings = AppSettings::default();

        let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;

        for (key, value) in rows.flatten() {
            match key.as_str() {
                "always_on_top" => {
                    if let Ok(v) = value.parse::<bool>() {
                        settings.always_on_top = v;
                    }
                }
                "hide_on_blur" => {
                    if let Ok(v) = value.parse::<bool>() {
                        settings.hide_on_blur = v;
                    }
                }
                "startup_launch" => {
                    if let Ok(v) = value.parse::<bool>() {
                        settings.startup_launch = v;
                    }
                }
                "theme" => settings.theme = value,
                "window_opacity" => {
                    if let Ok(v) = value.parse::<f32>() {
                        settings.window_opacity = v.clamp(0.5, 1.0);
                    }
                }
                "clipboard_keep_days" => {
                    if let Ok(v) = value.parse::<i32>() {
                        settings.clipboard_keep_days = v.max(0);
                    }
                }
                "auto_update" => {
                    if let Ok(v) = value.parse::<bool>() {
                        settings.auto_update = v;
                    }
                }
                "clipboard_auto_paste" => {
                    if let Ok(v) = value.parse::<bool>() {
                        settings.clipboard_auto_paste = v;
                    }
                }
                "llm_base_url" => settings.llm_base_url = value,
                "llm_api_key" => settings.llm_api_key = value,
                "llm_model" => settings.llm_model = value,
                "llm_thinking_mode" => {
                    if let Ok(v) = value.parse::<bool>() {
                        settings.llm_thinking_mode = v;
                    }
                }
                "claude_code_enabled" => {
                    if let Ok(v) = value.parse::<bool>() {
                        settings.claude_code_enabled = v;
                    }
                }
                "claude_code_bin_path" => settings.claude_code_bin_path = value,
                "claude_code_work_dir" => settings.claude_code_work_dir = value,
                "companion_enabled" => {
                    if let Ok(v) = value.parse::<bool>() {
                        settings.companion_enabled = v;
                    }
                }
                "companion_paused" => {
                    if let Ok(v) = value.parse::<bool>() {
                        settings.companion_paused = v;
                    }
                }
                "companion_retention_days" => {
                    if let Ok(v) = value.parse::<i32>() {
                        settings.companion_retention_days = v.max(1);
                    }
                }
                "companion_long_work_minutes" => {
                    if let Ok(v) = value.parse::<i32>() {
                        settings.companion_long_work_minutes = v.clamp(15, 480);
                    }
                }
                "companion_daily_report" => {
                    if let Ok(v) = value.parse::<bool>() {
                        settings.companion_daily_report = v;
                    }
                }
                "companion_monologue" => {
                    if let Ok(v) = value.parse::<bool>() {
                        settings.companion_monologue = v;
                    }
                }
                "debug_mode" => {
                    if let Ok(v) = value.parse::<bool>() {
                        settings.debug_mode = v;
                    }
                }
                "disabled_companion_tools" => {
                    // 只接受合法 JSON 数组，坏数据回退空列表（全工具开启）
                    if serde_json::from_str::<Vec<String>>(&value).is_ok() {
                        settings.disabled_companion_tools = value;
                    }
                }
                "shell_permission_mode" => {
                    if ["confirm_all", "accept_edits", "unattended"].contains(&value.as_str()) {
                        settings.shell_permission_mode = value;
                    }
                }
                _ => {}
            }
        }

        Ok(settings)
    }

    pub fn get_settings(&self) -> AppSettings {
        if let Ok(cache) = self.cache.lock() {
            cache.clone()
        } else {
            AppSettings::default()
        }
    }

    /// 重置所有设置为默认值（按白名单删除本模块管辖的键并刷新缓存；
    /// 陪伴模块状态、custom_scan_dirs 等共享同一张 settings 表的键不受影响）
    pub fn reset_settings(&self) -> Result<()> {
        let conn = Connection::open(&self.db_path)?;
        let placeholders = KNOWN_KEYS
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(", ");
        conn.execute(
            &format!("DELETE FROM settings WHERE key IN ({})", placeholders),
            rusqlite::params_from_iter(KNOWN_KEYS.iter()),
        )?;

        if let Ok(mut cache) = self.cache.lock() {
            *cache = AppSettings::default();
        }

        Ok(())
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = Connection::open(&self.db_path)?;

        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            [key, value],
        )?;

        // Update cache
        if let Ok(mut cache) = self.cache.lock() {
            match key {
                "always_on_top" => {
                    if let Ok(v) = value.parse::<bool>() {
                        cache.always_on_top = v;
                    }
                }
                "hide_on_blur" => {
                    if let Ok(v) = value.parse::<bool>() {
                        cache.hide_on_blur = v;
                    }
                }
                "startup_launch" => {
                    if let Ok(v) = value.parse::<bool>() {
                        cache.startup_launch = v;
                    }
                }
                "theme" => cache.theme = value.to_string(),
                "window_opacity" => {
                    if let Ok(v) = value.parse::<f32>() {
                        cache.window_opacity = v.clamp(0.5, 1.0);
                    }
                }
                "clipboard_keep_days" => {
                    if let Ok(v) = value.parse::<i32>() {
                        cache.clipboard_keep_days = v.max(0);
                    }
                }
                "auto_update" => {
                    if let Ok(v) = value.parse::<bool>() {
                        cache.auto_update = v;
                    }
                }
                "clipboard_auto_paste" => {
                    if let Ok(v) = value.parse::<bool>() {
                        cache.clipboard_auto_paste = v;
                    }
                }
                "llm_base_url" => cache.llm_base_url = value.to_string(),
                "llm_api_key" => cache.llm_api_key = value.to_string(),
                "llm_model" => cache.llm_model = value.to_string(),
                "llm_thinking_mode" => {
                    if let Ok(v) = value.parse::<bool>() {
                        cache.llm_thinking_mode = v;
                    }
                }
                "claude_code_enabled" => {
                    if let Ok(v) = value.parse::<bool>() {
                        cache.claude_code_enabled = v;
                    }
                }
                "claude_code_bin_path" => cache.claude_code_bin_path = value.to_string(),
                "claude_code_work_dir" => cache.claude_code_work_dir = value.to_string(),
                "companion_enabled" => {
                    if let Ok(v) = value.parse::<bool>() {
                        cache.companion_enabled = v;
                    }
                }
                "companion_paused" => {
                    if let Ok(v) = value.parse::<bool>() {
                        cache.companion_paused = v;
                    }
                }
                "companion_retention_days" => {
                    if let Ok(v) = value.parse::<i32>() {
                        cache.companion_retention_days = v.max(1);
                    }
                }
                "companion_long_work_minutes" => {
                    if let Ok(v) = value.parse::<i32>() {
                        cache.companion_long_work_minutes = v.clamp(15, 480);
                    }
                }
                "companion_daily_report" => {
                    if let Ok(v) = value.parse::<bool>() {
                        cache.companion_daily_report = v;
                    }
                }
                "companion_monologue" => {
                    if let Ok(v) = value.parse::<bool>() {
                        cache.companion_monologue = v;
                    }
                }
                "debug_mode" => {
                    if let Ok(v) = value.parse::<bool>() {
                        cache.debug_mode = v;
                    }
                }
                "disabled_companion_tools" => {
                    if serde_json::from_str::<Vec<String>>(value).is_ok() {
                        cache.disabled_companion_tools = value.to_string();
                    }
                }
                "shell_permission_mode" => {
                    if ["confirm_all", "accept_edits", "unattended"].contains(&value) {
                        cache.shell_permission_mode = value.to_string();
                    }
                }
                _ => {}
            }
        }

        Ok(())
    }

    pub fn should_hide_on_blur(&self) -> bool {
        self.get_settings().hide_on_blur
    }

    pub fn is_always_on_top(&self) -> bool {
        self.get_settings().always_on_top
    }
}
