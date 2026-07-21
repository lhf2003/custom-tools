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
    pub claude_code_bin_path: String,
    pub claude_code_work_dir: String,
    pub companion_enabled: bool,
    pub companion_paused: bool,
    pub companion_retention_days: i32,
    pub companion_long_work_minutes: i32,
    pub companion_agent_enabled: bool,
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
            claude_code_bin_path: "claude".to_string(),
            claude_code_work_dir: String::new(),
            companion_enabled: true,
            companion_paused: false,
            companion_retention_days: 30,
            companion_long_work_minutes: 90,
            companion_agent_enabled: false,
        }
    }
}

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
        let conn = Connection::open(&self.db_path)?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )",
            [],
        )?;

        // Load settings into cache
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
                "companion_agent_enabled" => {
                    if let Ok(v) = value.parse::<bool>() {
                        settings.companion_agent_enabled = v;
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

    /// 重置所有设置为默认值（清空 settings 表并刷新缓存）
    pub fn reset_settings(&self) -> Result<()> {
        let conn = Connection::open(&self.db_path)?;
        conn.execute("DELETE FROM settings", [])?;

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
                "companion_agent_enabled" => {
                    if let Ok(v) = value.parse::<bool>() {
                        cache.companion_agent_enabled = v;
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
