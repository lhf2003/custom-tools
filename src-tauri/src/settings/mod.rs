use rusqlite::{Connection, Result};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;

pub mod shortcuts;
pub use shortcuts::{ShortcutConfig, ShortcutManager, get_default_shortcuts};

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
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            always_on_top: false,  // 默认不置顶
            hide_on_blur: true,    // 默认点击外部隐藏
            startup_launch: false,
            theme: "system".to_string(),
            window_opacity: 0.95,
            clipboard_keep_days: 30,  // 默认保存30天
            auto_update: true,  // 默认开启自动更新
            clipboard_auto_paste: true,  // 默认开启自动粘贴
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

        for row in rows {
            if let Ok((key, value)) = row {
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
                    _ => {}
                }
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
