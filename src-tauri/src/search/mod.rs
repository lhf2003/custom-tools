use nucleo::pattern::{CaseMatching, Normalization, Pattern};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub mod everything;
pub mod icon;
pub mod registry;
pub mod uwp;
pub mod watcher;

/// Convert Chinese text to pinyin initials
fn to_pinyin_initials(text: &str) -> String {
    rust_pinyin::get_pinyin(text)
}

use crate::db::app_cache::{self, AppCacheEntry};
use crate::db::app_usage::{calculate_frequency_score, AppUsage};
use crate::db::DatabaseState;

/// Parse a Windows shortcut (.lnk) file and return the target path
#[cfg(windows)]
fn parse_shortcut_target(path: &Path) -> Option<String> {
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink, SLGP_RAWPATH};
    use windows_core::Interface;

    // Initialize COM (ignore result since it may already be initialized)
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }

    unsafe {
        // Create ShellLink instance
        let shell_link: IShellLinkW = match CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
        {
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
        if persist_file
            .Load(windows::core::PCWSTR(wide_path.as_ptr()), STGM_READ)
            .is_err()
        {
            return None;
        }

        // Get the target path
        let mut target_path = [0u16; 260];
        let mut find_data: windows::Win32::Storage::FileSystem::WIN32_FIND_DATAW =
            std::mem::zeroed();
        if shell_link
            .GetPath(&mut target_path, &mut find_data, SLGP_RAWPATH.0 as u32)
            .is_err()
        {
            return None;
        }

        // Convert wide string to String
        let len = target_path
            .iter()
            .position(|&c| c == 0)
            .unwrap_or(target_path.len());
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
fn score_app(app: &AppItem, pattern: &Pattern, matcher: &mut nucleo::Matcher) -> Option<u32> {
    let mut buf = Vec::new();
    let name_score = pattern.score(nucleo::Utf32Str::new(&app.name, &mut buf), matcher);
    buf.clear();
    let pinyin_score = if !app.pinyin_initials.is_empty() {
        pattern.score(
            nucleo::Utf32Str::new(&app.pinyin_initials, &mut buf),
            matcher,
        )
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
    /// 全量扫描进行中标记（锁内读写）。用于启动期线程 B 区分
    /// "线程 A 正在扫描（应等待）"与"线程 A 从未开始/已失败（应兜底）"，
    /// 避免两个线程并发执行 collect_all_apps。
    scanning: bool,
    db_state: Option<Arc<DatabaseState>>,
}

impl SearchIndex {
    pub fn new() -> Self {
        Self {
            apps: Vec::new(),
            indexed: false,
            scanning: false,
            db_state: None,
        }
    }

    pub fn with_db(db_state: Arc<DatabaseState>) -> Self {
        Self {
            apps: Vec::new(),
            indexed: false,
            scanning: false,
            db_state: Some(db_state),
        }
    }

    /// Fast load from cache. Returns Ok(true) if the cache was loaded,
    /// Ok(false) if no cache exists (caller should run a full index, preferably
    /// off the main thread — scanning touches the filesystem, registry and
    /// external processes and may block for a long time in bad environments).
    pub fn load_from_cache(&mut self) -> anyhow::Result<bool> {
        if self.indexed {
            return Ok(true);
        }

        // Try to load from database cache
        if let Some(ref db_state) = self.db_state {
            let conn = rusqlite::Connection::open(&db_state.0)?;

            if app_cache::has_cache(&conn)? {
                let entries = app_cache::load_all(&conn)?;
                self.apps = entries.into_iter().map(AppItem::from).collect();
                self.indexed = true;

                log::info!("Loaded {} applications from cache", self.apps.len());
                return Ok(true);
            }
        }

        Ok(false)
    }

    /// Scan all app sources and return the full app list **without touching `self`**.
    /// 设计上允许在不持有索引锁的情况下执行——扫描会触达文件系统/注册表/外部
    /// 进程，在慢速或不可达环境（网络盘、EDR 拦截）中可能长时间阻塞；持锁执行
    /// 会饿死搜索命令与文件监听线程。
    pub fn collect_all_apps(
        db_state: &Option<Arc<DatabaseState>>,
    ) -> anyhow::Result<Vec<AppItem>> {
        let start = std::time::Instant::now();

        let mut apps = Vec::new();
        let mut seen = HashSet::new();

        // System start menu
        let system_start_menu =
            PathBuf::from("C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs");
        scan_dir_if_local(&system_start_menu, &mut apps, &mut seen);

        // User start menu & Desktop shortcuts
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            let user_start_menu = PathBuf::from(user_profile.clone())
                .join("AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs");
            scan_dir_if_local(&user_start_menu, &mut apps, &mut seen);

            let desktop = PathBuf::from(user_profile).join("Desktop");
            scan_dir_if_local(&desktop, &mut apps, &mut seen);
        }

        // Registry apps (green software without Start Menu shortcuts)
        let registry_apps = registry::scan();
        log::info!("Registry scan found {} apps", registry_apps.len());
        for reg_app in registry_apps {
            let key = format!(
                "{}|{}",
                reg_app.name.to_lowercase(),
                reg_app.exe_path.to_lowercase()
            );
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
        let custom_dirs = load_custom_dirs(db_state);
        for dir_path in custom_dirs {
            let dir = PathBuf::from(&dir_path);
            scan_dir_if_local(&dir, &mut apps, &mut seen);
        }

        // Sort by name alphabetically
        apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

        // Update cache
        if let Some(ref db_state) = db_state {
            if let Ok(mut conn) = rusqlite::Connection::open(&db_state.0) {
                let cache_entries: Vec<AppCacheEntry> = apps
                    .iter()
                    .map(|app| {
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
                    })
                    .collect();

                if let Err(e) = app_cache::replace_batch(&mut conn, &cache_entries) {
                    log::warn!("Failed to save cache: {}", e);
                } else {
                    log::info!("Saved {} entries to cache", cache_entries.len());
                }
            }
        }

        log::info!("Collected {} applications in {:?}", apps.len(), start.elapsed());
        Ok(apps)
    }

    /// Replace the in-memory index with apps collected elsewhere (see
    /// `collect_all_apps`). Used to swap in results of an unlocked background scan.
    pub fn apply_indexed_apps(&mut self, apps: Vec<AppItem>) {
        self.apps = apps;
        self.indexed = true;
        self.scanning = false;
    }

    /// 标记一次全量扫描开始（在锁内调用；collect_all_apps 本身不持锁执行）。
    pub fn begin_scan(&mut self) {
        self.scanning = true;
    }

    /// 扫描失败时清除扫描标记，让启动期的兜底线程可以接手。
    pub fn abort_scan(&mut self) {
        self.scanning = false;
    }

    pub fn is_scanning(&self) -> bool {
        self.scanning
    }

    /// 缓存新鲜度阈值：超过该时长没有全量扫描视为陈旧。
    /// Registry/UWP 应用增删只能靠全量扫描感知（watcher 只监听 .lnk），
    /// 陈旧时启动后应触发一次后台刷新，而不是跳过。
    const CACHE_STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

    /// 缓存是否新鲜：以 app_cache 表 MAX(updated_at)（UTC）近似"上次全量
    /// 扫描时间"（save_batch/replace_batch 每次全量扫描都会刷新 updated_at）。
    /// 判断失败或缓存为空时返回不新鲜（保守触发刷新）。
    pub fn is_cache_fresh(&self) -> bool {
        let Some(ref db_state) = self.db_state else {
            return true;
        };
        let Ok(conn) = rusqlite::Connection::open(&db_state.0) else {
            return true;
        };
        let last: Option<String> = conn
            .query_row(
                "SELECT MAX(updated_at) FROM app_cache WHERE is_valid = 1",
                [],
                |row| row.get(0),
            )
            .ok()
            .flatten();
        let Some(last) = last else {
            return false;
        };
        // CURRENT_TIMESTAMP 存储的是 UTC
        let Some(last_utc) =
            chrono::NaiveDateTime::parse_from_str(&last, "%Y-%m-%d %H:%M:%S").ok()
        else {
            return false;
        };
        let elapsed = chrono::Utc::now().naive_utc() - last_utc;
        elapsed < chrono::Duration::from_std(Self::CACHE_STALE_AFTER).unwrap_or_default()
    }

    /// Background refresh - scans directories and updates cache
    pub fn refresh_in_background(&mut self) -> anyhow::Result<()> {
        let apps = Self::collect_all_apps(&self.db_state)?;
        self.apps = apps;
        self.indexed = true;

        log::info!("Refreshed {} applications", self.apps.len());

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
        if let Some((app, target_path)) = parse_shortcut(path) {
            // Check for duplicates
            let key = format!("{}|{}", app.name.to_lowercase(), target_path.to_lowercase());

            // Update in-memory list
            if let Some(existing) = self.apps.iter_mut().find(|a| {
                let existing_target =
                    parse_shortcut_target(Path::new(&a.path)).unwrap_or_else(|| a.path.clone());
                format!(
                    "{}|{}",
                    a.name.to_lowercase(),
                    existing_target.to_lowercase()
                ) == key
            }) {
                *existing = app.clone();
            } else {
                self.apps.push(app.clone());
                self.apps
                    .sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
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
                    log::warn!(
                        "Failed to mark {} as invalid in cache: {}",
                        path.display(),
                        e
                    );
                }
            }
        }

        Ok(())
    }
}

/// 目录递归扫描的最大深度（开始菜单/桌面正常不超过 3 层，限制深度防御异常目录树）
const MAX_SCAN_DEPTH: usize = 5;

/// Scan a local directory for shortcuts. UNC paths are skipped outright — a
/// disconnected network drive can block `read_dir` for tens of seconds.
fn scan_dir_if_local(dir: &Path, apps: &mut Vec<AppItem>, seen: &mut HashSet<String>) {
    if dir.as_os_str().to_string_lossy().starts_with("\\\\") {
        log::warn!("Skipping UNC scan directory: {}", dir.display());
        return;
    }
    if !dir.exists() {
        return;
    }
    if let Err(e) = scan_directory(dir, apps, seen, 0) {
        log::warn!("Failed to scan directory {}: {}", dir.display(), e);
    }
}

fn scan_directory(
    dir: &Path,
    apps: &mut Vec<AppItem>,
    seen: &mut HashSet<String>,
    depth: usize,
) -> anyhow::Result<()> {
    if depth > MAX_SCAN_DEPTH {
        log::warn!("Scan depth limit reached, skipping subtree: {}", dir.display());
        return Ok(());
    }

    let entries = std::fs::read_dir(dir)?;

    for entry in entries.flatten() {
        let path = entry.path();

        // DirEntry::file_type 不跟随链接:跳过 junction/符号链接目录,
        // 避免目录循环导致的无限递归与网络位置递归。
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };

        if file_type.is_dir() && !file_type.is_symlink() {
            // 单个子目录失败(权限/网络超时)不拖垮整个扫描
            if let Err(e) = scan_directory(&path, apps, seen, depth + 1) {
                log::warn!("Failed to scan subdirectory {}: {}", path.display(), e);
            }
        } else if let Some(ext) = path.extension() {
            if ext.eq_ignore_ascii_case("lnk") {
                if let Some((app, target_path)) = parse_shortcut(&path) {
                    // Use target path for deduplication
                    let key =
                        format!("{}|{}", app.name.to_lowercase(), target_path.to_lowercase());
                    if seen.insert(key) {
                        apps.push(app);
                    }
                }
            }
        }
    }

    Ok(())
}

fn parse_shortcut(path: &Path) -> Option<(AppItem, String)> {
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
    let target_path =
        parse_shortcut_target(path).unwrap_or_else(|| path.to_string_lossy().to_string());

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

/// Read custom scan directories from the database settings table.
fn load_custom_dirs(db_state: &Option<Arc<DatabaseState>>) -> Vec<String> {
    let db_state = match db_state {
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

impl SearchIndex {
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

        let usage_map: HashMap<&str, &AppUsage> =
            usages.iter().map(|u| (u.path.as_str(), u)).collect();

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
                        .unwrap_or(0.0)
                        * 0.5; // 50% frequency weight
                    (base_score * 0.5 + freq_bonus, app.clone()) // 50% match weight
                })
            })
            .collect();

        scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        scored.into_iter().map(|(_, app)| app).collect()
    }

    /// Get apps sorted by recency (for empty query)
    pub fn get_recently_used(&self, usages: &[AppUsage]) -> Vec<AppItem> {
        let usage_map: HashMap<&str, &AppUsage> =
            usages.iter().map(|u| (u.path.as_str(), u)).collect();

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
}

impl Default for SearchIndex {
    fn default() -> Self {
        Self::new()
    }
}

/// Launch an application by its shortcut path
#[cfg(windows)]
pub fn launch_app(path: &str) -> anyhow::Result<()> {
    // 通过 explorer.exe 启动应用，而不是直接使用 ShellExecuteW。
    //
    // 原因：在 Windows 上，直接用 ShellExecuteW 启动的进程可能会被包含在
    // Tauri 进程的 Windows Job Object 中。当 Tauri 退出时，Job Object 关闭，
    // 导致所有子进程（包括已启动的第三方应用）被强制终止。
    //
    // 通过 explorer.exe 启动时，新创建的 explorer.exe 进程会将启动请求
    // 委托给已在运行的 Explorer 实例（桌面会话主进程，不在 Tauri 的
    // Job Object 中），然后自身退出。目标应用由现有 Explorer 实例启动，
    // 完全独立于 Tauri 的进程树，不受 Tauri 退出影响。
    //
    // 此方式支持所有路径类型：.exe、.lnk 快捷方式、shell:AppsFolder\...（UWP）。
    std::process::Command::new("explorer.exe")
        .arg(path)
        .spawn()
        .map_err(|e| anyhow::anyhow!("Failed to launch app via explorer: {}", e))?;

    Ok(())
}

#[cfg(not(windows))]
pub fn launch_app(_path: &str) -> anyhow::Result<()> {
    Err(anyhow::anyhow!(
        "Launching apps is only supported on Windows"
    ))
}
