use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use nucleo::pattern::{CaseMatching, Normalization, Pattern};

pub mod everything;
pub mod registry;
pub mod uwp;
pub mod icon;
pub mod watcher;

/// Convert Chinese text to pinyin initials
fn to_pinyin_initials(text: &str) -> String {
    rust_pinyin::get_pinyin(text)
}

use crate::db::app_cache::{self, AppCacheEntry};
use crate::db::app_usage::{AppUsage, calculate_frequency_score};
use crate::db::DatabaseState;

/// Parse a Windows shortcut (.lnk) file and return the target path
#[cfg(windows)]
fn parse_shortcut_target(path: &Path) -> Option<String> {
    use windows::Win32::System::Com::{
        CoInitializeEx, COINIT_APARTMENTTHREADED, CLSCTX_INPROC_SERVER,
        CoCreateInstance, IPersistFile, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink, SLGP_RAWPATH};
    use windows_core::ComInterface;

    // Initialize COM (ignore result since it may already be initialized)
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }

    unsafe {
        // Create ShellLink instance
        let shell_link: IShellLinkW = match CoCreateInstance(
            &ShellLink,
            None,
            CLSCTX_INPROC_SERVER,
        ) {
            Ok(link) => link,
            Err(_) => return None,
        };

        // Get IPersistFile interface and load the shortcut
        let persist_file: IPersistFile = match shell_link.cast() {
            Ok(pf) => pf,
            Err(_) => return None,
        };

        // Convert path to wide string (must be null-terminated)
        let path_str = path.to_string_lossy();
        let wide_path: Vec<u16> = path_str.encode_utf16().chain(std::iter::once(0)).collect();

        // Load the shortcut file with read-only access
        if persist_file.Load(windows::core::PCWSTR(wide_path.as_ptr()), STGM_READ).is_err() {
            return None;
        }

        // Get the target path
        let mut target_path = [0u16; 260];
        let mut find_data: windows::Win32::Storage::FileSystem::WIN32_FIND_DATAW = std::mem::zeroed();
        if shell_link.GetPath(
            &mut target_path,
            &mut find_data,
            SLGP_RAWPATH.0 as u32,
        ).is_err() {
            return None;
        }

        // Convert wide string to String
        let len = target_path.iter().position(|&c| c == 0).unwrap_or(target_path.len());
        let target = String::from_utf16_lossy(&target_path[..len]);

        if target.is_empty() {
            return None;
        }

        Some(target)
    }
}

#[cfg(not(windows))]
fn parse_shortcut_target(_path: &Path) -> Option<String> {
    None
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AppItem {
    pub name: String,
    pub path: String,
    pub icon: Option<String>,
    pub pinyin_initials: String,
}

impl From<AppCacheEntry> for AppItem {
    fn from(entry: AppCacheEntry) -> Self {
        Self {
            name: entry.name,
            path: entry.path,
            icon: None,
            pinyin_initials: entry.pinyin_initials,
        }
    }
}

/// 对单个应用执行模糊匹配，同时尝试名称和拼音首字母，返回两者中的最高分。
fn score_app(
    app: &AppItem,
    pattern: &Pattern,
    matcher: &mut nucleo::Matcher,
) -> Option<u32> {
    let mut buf = Vec::new();
    let name_score = pattern.score(nucleo::Utf32Str::new(&app.name, &mut buf), matcher);
    buf.clear();
    let pinyin_score = if !app.pinyin_initials.is_empty() {
        pattern.score(nucleo::Utf32Str::new(&app.pinyin_initials, &mut buf), matcher)
    } else {
        None
    };
    match (name_score, pinyin_score) {
        (Some(n), Some(p)) => Some(n.max(p)),
        (Some(n), None) => Some(n),
        (None, Some(p)) => Some(p),
        (None, None) => None,
    }
}

pub struct SearchIndex {
    apps: Vec<AppItem>,
    indexed: bool,
    db_state: Option<Arc<DatabaseState>>,
}

impl SearchIndex {
    pub fn new() -> Self {
        Self {
            apps: Vec::new(),
            indexed: false,
            db_state: None,
        }
    }

    pub fn with_db(db_state: Arc<DatabaseState>) -> Self {
        Self {
            apps: Vec::new(),
            indexed: false,
            db_state: Some(db_state),
        }
    }

    /// Fast load from cache, then refresh in background
    pub fn load_from_cache(&mut self) -> anyhow::Result<()> {
        if self.indexed {
            return Ok(());
        }

        // Try to load from database cache
        if let Some(ref db_state) = self.db_state {
            let conn = rusqlite::Connection::open(&db_state.0)?;

            if app_cache::has_cache(&conn)? {
                let entries = app_cache::load_all(&conn)?;
                self.apps = entries.into_iter().map(AppItem::from).collect();
                self.indexed = true;

                log::info!("Loaded {} applications from cache", self.apps.len());
                return Ok(());
            }
        }

        // Fall back to full indexing if no cache
        self.index_apps()
    }

    /// Background refresh - scans directories and updates cache
    pub fn refresh_in_background(&mut self) -> anyhow::Result<()> {
        let start = std::time::Instant::now();

        let mut apps = Vec::new();
        let mut seen = HashSet::new();

        // System start menu
        let system_start_menu = PathBuf::from("C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs");
        if system_start_menu.exists() {
            self.scan_directory(&system_start_menu, &mut apps, &mut seen)?;
        }

        // User start menu
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            let user_start_menu = PathBuf::from(user_profile)
                .join("AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs");
            if user_start_menu.exists() {
                self.scan_directory(&user_start_menu, &mut apps, &mut seen)?;
            }
        }

        // Desktop shortcuts
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            let desktop = PathBuf::from(user_profile).join("Desktop");
            if desktop.exists() {
                self.scan_directory(&desktop, &mut apps, &mut seen)?;
            }
        }

        // Registry apps (green software without Start Menu shortcuts)
        let registry_apps = registry::scan();
        log::info!("Registry scan found {} apps", registry_apps.len());
        for reg_app in registry_apps {
            let key = format!("{}|{}", reg_app.name.to_lowercase(), reg_app.exe_path.to_lowercase());
            if seen.insert(key) {
                let pinyin = to_pinyin_initials(&reg_app.name);
                apps.push(AppItem {
                    name: reg_app.name,
                    path: reg_app.exe_path,
                    icon: None,
                    pinyin_initials: pinyin,
                });
            }
        }

        // UWP apps (Microsoft Store)
        let uwp_apps = uwp::scan();
        log::info!("UWP scan found {} apps", uwp_apps.len());
        for uwp_app in uwp_apps {
            let launch = uwp::launch_path(&uwp_app.app_id);
            let key = format!("{}|{}", uwp_app.name.to_lowercase(), launch.to_lowercase());
            if seen.insert(key) {
                let pinyin = to_pinyin_initials(&uwp_app.name);
                apps.push(AppItem {
                    name: uwp_app.name,
                    path: launch,
                    icon: None,
                    pinyin_initials: pinyin,
                });
            }
        }

        // Custom directories configured by user
        let custom_dirs = self.load_custom_dirs();
        for dir_path in custom_dirs {
            let dir = PathBuf::from(&dir_path);
            if dir.exists() {
                if let Err(e) = self.scan_directory(&dir, &mut apps, &mut seen) {
                    log::warn!("Failed to scan custom dir {}: {}", dir_path, e);
                }
            }
        }

        // Sort by name alphabetically
        apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

        // Update cache
        if let Some(ref db_state) = self.db_state {
            if let Ok(mut conn) = rusqlite::Connection::open(&db_state.0) {
                let cache_entries: Vec<AppCacheEntry> = apps.iter().map(|app| {
                    let target_path = parse_shortcut_target(Path::new(&app.path))
                        .unwrap_or_else(|| app.path.clone());
                    let last_modified = app_cache::get_file_modified(Path::new(&app.path));

                    AppCacheEntry {
                        name: app.name.clone(),
                        path: app.path.clone(),
                        target_path,
                        last_modified,
                        is_valid: true,
                        pinyin_initials: app.pinyin_initials.clone(),
                    }
                }).collect();

                if let Err(e) = app_cache::save_batch(&mut conn, &cache_entries) {
                    log::warn!("Failed to save cache: {}", e);
                } else {
                    log::info!("Saved {} entries to cache", cache_entries.len());
                }
            }
        }

        self.apps = apps;
        self.indexed = true;

        log::info!("Refreshed {} applications in {:?}", self.apps.len(), start.elapsed());

        Ok(())
    }

    /// Full index from scratch (blocking)
    pub fn index_apps(&mut self) -> anyhow::Result<()> {
        if self.indexed {
            return Ok(());
        }

        self.refresh_in_background()
    }

    /// Incremental update for a single file
    pub fn add_or_update_app(&mut self, path: &Path) -> anyhow::Result<()> {
        if let Some((app, target_path)) = self.parse_shortcut(path) {
            // Check for duplicates
            let key = format!("{}|{}", app.name.to_lowercase(), target_path.to_lowercase());

            // Update in-memory list
            if let Some(existing) = self.apps.iter_mut().find(|a| {
                let existing_target = parse_shortcut_target(Path::new(&a.path))
                    .unwrap_or_else(|| a.path.clone());
                format!("{}|{}", a.name.to_lowercase(), existing_target.to_lowercase()) == key
            }) {
                *existing = app.clone();
            } else {
                self.apps.push(app.clone());
                self.apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            }

            // Update database cache
            if let Some(ref db_state) = self.db_state {
                if let Ok(conn) = rusqlite::Connection::open(&db_state.0) {
                    let entry = AppCacheEntry {
                        name: app.name,
                        path: app.path,
                        target_path,
                        last_modified: app_cache::get_file_modified(path),
                        is_valid: true,
                        pinyin_initials: app.pinyin_initials,
                    };

                    if let Err(e) = app_cache::save(&conn, &entry) {
                        log::warn!("Failed to update cache for {}: {}", path.display(), e);
                    }
                }
            }
        }

        Ok(())
    }

    /// Remove app from index
    pub fn remove_app(&mut self, path: &Path) -> anyhow::Result<()> {
        let path_str = path.to_string_lossy().to_string();

        // Remove from in-memory list
        self.apps.retain(|a| a.path != path_str);

        // Mark as invalid in cache
        if let Some(ref db_state) = self.db_state {
            if let Ok(conn) = rusqlite::Connection::open(&db_state.0) {
                if let Err(e) = app_cache::mark_invalid(&conn, &path_str) {
                    log::warn!("Failed to mark {} as invalid in cache: {}", path.display(), e);
                }
            }
        }

        Ok(())
    }

    fn scan_directory(
        &self,
        dir: &Path,
        apps: &mut Vec<AppItem>,
        seen: &mut HashSet<String>,
    ) -> anyhow::Result<()> {
        let entries = std::fs::read_dir(dir)?;

        for entry in entries.flatten() {
            let path = entry.path();

            if path.is_dir() {
                // Recursively scan subdirectories
                self.scan_directory(&path, apps, seen)?;
            } else if let Some(ext) = path.extension() {
                if ext.eq_ignore_ascii_case("lnk") {
                    if let Some((app, target_path)) = self.parse_shortcut(&path) {
                        // Use target path for deduplication
                        let key = format!("{}|{}", app.name.to_lowercase(), target_path.to_lowercase());
                        if seen.insert(key) {
                            apps.push(app);
                        }
                    }
                }
            }
        }

        Ok(())
    }

    fn parse_shortcut(&self, path: &Path) -> Option<(AppItem, String)> {
        let file_stem = path.file_stem()?;
        let name = file_stem.to_string_lossy().to_string();

        // Clean up common suffixes
        let name = name
            .replace(" - 快捷方式", "")
            .replace(" - Shortcut", "")
            .trim()
            .to_string();

        if name.is_empty() {
            return None;
        }

        // Get the target path for deduplication
        let target_path = parse_shortcut_target(path).unwrap_or_else(|| path.to_string_lossy().to_string());

        // Pre-compute pinyin initials for Chinese search support
        let pinyin_initials = to_pinyin_initials(&name);

        let app = AppItem {
            name,
            path: path.to_string_lossy().to_string(),
            icon: None,
            pinyin_initials,
        };

        Some((app, target_path))
    }

    pub fn search(&self, query: &str) -> Vec<AppItem> {
        if query.is_empty() {
            return self.get_all();
        }

        let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
        let mut matcher = nucleo::Matcher::new(nucleo::Config::DEFAULT);

        let mut scored: Vec<(u32, AppItem)> = self
            .apps
            .iter()
            .filter_map(|app| {
                score_app(app, &pattern, &mut matcher).map(|score| (score, app.clone()))
            })
            .collect();

        scored.sort_by(|a, b| b.0.cmp(&a.0));
        scored.into_iter().map(|(_, app)| app).collect()
    }

    /// Search with frequency-based ranking
    pub fn search_with_frequency(&self, query: &str, usages: &[AppUsage]) -> Vec<AppItem> {
        if query.is_empty() {
            return self.get_recently_used(usages);
        }

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let usage_map: HashMap<&str, &AppUsage> = usages
            .iter()
            .map(|u| (u.path.as_str(), u))
            .collect();

        let pattern = Pattern::parse(query, CaseMatching::Smart, Normalization::Smart);
        let mut matcher = nucleo::Matcher::new(nucleo::Config::DEFAULT);

        let mut scored: Vec<(f64, AppItem)> = self
            .apps
            .iter()
            .filter_map(|app| {
                score_app(app, &pattern, &mut matcher).map(|match_score| {
                    let base_score = match_score as f64 / u32::MAX as f64;
                    let freq_bonus = usage_map
                        .get(app.path.as_str())
                        .map(|u| calculate_frequency_score(u, now))
                        .unwrap_or(0.0) * 0.3;
                    (base_score * 0.7 + freq_bonus, app.clone())
                })
            })
            .collect();

        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored.into_iter().map(|(_, app)| app).collect()
    }

    /// Get apps sorted by recency (for empty query)
    pub fn get_recently_used(&self, usages: &[AppUsage]) -> Vec<AppItem> {
        let usage_map: HashMap<&str, &AppUsage> = usages
            .iter()
            .map(|u| (u.path.as_str(), u))
            .collect();

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        // Sort all apps by frequency score
        let mut scored: Vec<(f64, &AppItem)> = self
            .apps
            .iter()
            .map(|app| {
                let score = usage_map
                    .get(app.path.as_str())
                    .map(|u| calculate_frequency_score(u, now))
                    .unwrap_or(0.0);
                (score, app)
            })
            .collect();

        // Sort by score descending
        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

        // Return sorted apps
        scored.into_iter().map(|(_, app)| app.clone()).collect()
    }

    pub fn get_all(&self) -> Vec<AppItem> {
        self.apps.clone()
    }

    pub fn refresh(&mut self) -> anyhow::Result<()> {
        self.indexed = false;
        self.apps.clear();

        // Clear cache and rebuild
        if let Some(ref db_state) = self.db_state {
            if let Ok(conn) = rusqlite::Connection::open(&db_state.0) {
                if let Err(e) = app_cache::clear_all(&conn) {
                    log::warn!("Failed to clear cache: {}", e);
                }
            }
        }

        self.refresh_in_background()
    }

    pub fn is_indexed(&self) -> bool {
        self.indexed
    }

    /// Read custom scan directories from the database settings table.
    fn load_custom_dirs(&self) -> Vec<String> {
        let db_state = match &self.db_state {
            Some(s) => s,
            None => return Vec::new(),
        };

        let conn = match rusqlite::Connection::open(&db_state.0) {
            Ok(c) => c,
            Err(_) => return Vec::new(),
        };

        let result: rusqlite::Result<String> = conn.query_row(
            "SELECT value FROM settings WHERE key = 'custom_scan_dirs'",
            [],
            |row| row.get(0),
        );

        match result {
            Ok(json) => serde_json::from_str(&json).unwrap_or_default(),
            Err(rusqlite::Error::QueryReturnedNoRows) => Vec::new(),
            Err(e) => {
                log::warn!("Failed to load custom_scan_dirs: {}", e);
                Vec::new()
            }
        }
    }
}

impl Default for SearchIndex {
    fn default() -> Self {
        Self::new()
    }
}

/// Launch an application by its shortcut path
#[cfg(windows)]
pub fn launch_app(path: &str) -> anyhow::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    if path.starts_with("shell:") {
        // UWP app: launch via explorer.exe
        Command::new("explorer.exe")
            .arg(path)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()?;
    } else {
        Command::new("cmd")
            .args(["/c", "start", "", path])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()?;
    }

    Ok(())
}

#[cfg(not(windows))]
pub fn launch_app(_path: &str) -> anyhow::Result<()> {
    Err(anyhow::anyhow!("Launching apps is only supported on Windows"))
}
