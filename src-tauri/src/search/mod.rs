use nucleo::pattern::{CaseMatching, Normalization, Pattern};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub mod everything;
pub mod icon;
pub mod registry;
pub mod system_features;
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
    /// 上次 UWP 条目全量重扫时间。Get-StartApps 走 PowerShell 进程
    /// （数百毫秒~秒级），唤起时校验不能每次都跑，按间隔节流。
    last_uwp_verify: Option<std::time::Instant>,
}

impl SearchIndex {
    pub fn new() -> Self {
        Self {
            apps: Vec::new(),
            indexed: false,
            scanning: false,
            db_state: None,
            last_uwp_verify: None,
        }
    }

    pub fn with_db(db_state: Arc<DatabaseState>) -> Self {
        Self {
            apps: Vec::new(),
            indexed: false,
            scanning: false,
            db_state: Some(db_state),
            last_uwp_verify: None,
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
                self.merge_system_features();

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
    pub fn collect_all_apps(db_state: &Option<Arc<DatabaseState>>) -> anyhow::Result<Vec<AppItem>> {
        let start = std::time::Instant::now();

        let mut apps = Vec::new();
        // 双重去重（修复跨来源重复，如"暴雪战网"的两条记录）：
        // - seen_targets: 按解析后的目标路径去重——同一 exe 的多个快捷方式/
        //   来源（"向日葵远程控制.lnk" 与 "卸载向日葵远程控制.lnk" 同指
        //   AweSun.exe）只保留先到的 .lnk；
        // - seen_names: 按名称去重——同应用的不同 exe（.lnk 指向
        //   Battle.net Launcher.exe、注册表指向 Battle.net.exe）只保留
        //   先到的 .lnk。name 维度有误杀同名不同应用的风险（罕见），
        //   换来的收益是搜索结果不再出现"两个一模一样的应用"。
        let mut seen_targets = HashSet::new();
        let mut seen_names = HashSet::new();

        // System start menu
        let system_start_menu =
            PathBuf::from("C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs");
        scan_dir_if_local(&system_start_menu, &mut apps, &mut seen_targets, &mut seen_names);

        // User start menu & Desktop shortcuts
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            let user_start_menu = PathBuf::from(user_profile.clone())
                .join("AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs");
            scan_dir_if_local(
                &user_start_menu,
                &mut apps,
                &mut seen_targets,
                &mut seen_names,
            );

            let desktop = PathBuf::from(user_profile).join("Desktop");
            scan_dir_if_local(&desktop, &mut apps, &mut seen_targets, &mut seen_names);
        }

        // Registry apps (green software without Start Menu shortcuts)。
        // 与 .lnk 目标重复（同一应用）或同名（同应用不同 exe）都跳过——
        // .lnk 先扫描，来源优先级上 .lnk 胜出，保证启动行为与开始菜单一致。
        let registry_apps = registry::scan();
        log::info!("Registry scan found {} apps", registry_apps.len());
        for reg_app in registry_apps {
            let target_key = reg_app.exe_path.to_lowercase();
            if !seen_targets.contains(&target_key)
                && seen_names.insert(reg_app.name.to_lowercase())
            {
                seen_targets.insert(target_key);
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
        match uwp::scan() {
            Ok(uwp_apps) if !uwp_apps.is_empty() => {
                log::info!("UWP scan found {} apps", uwp_apps.len());
                for uwp_app in uwp_apps {
                    let launch = uwp::launch_path(&uwp_app.app_id);
                    let target_key = launch.to_lowercase();
                    if !seen_targets.contains(&target_key)
                        && seen_names.insert(uwp_app.name.to_lowercase())
                    {
                        seen_targets.insert(target_key);
                        let pinyin = to_pinyin_initials(&uwp_app.name);
                        apps.push(AppItem {
                            name: uwp_app.name,
                            path: launch,
                            icon: None,
                            pinyin_initials: pinyin,
                        });
                    }
                }
            }
            Ok(_empty) => {
                // 扫描返回 0 条（重试后仍为 0）≠ 确实没有 UWP 应用：
                // Get-StartApps 偶发空输出（开机时 Start Menu 数据未就绪等），
                // 若缓存中还有上次扫描的 UWP 条目则沿用——否则 replace_batch
                // 的全量替换会把 UWP 应用全部清空（8/10 事故根因）。
                log::warn!("UWP 扫描返回 0 条（重试后仍为 0），沿用缓存中已有的 UWP 条目");
                merge_uwp_cached(db_state, &mut apps, &mut seen_targets, &mut seen_names);
            }
            Err(e) => {
                // 扫描失败 ≠ 确实没有 UWP 应用：沿用缓存旧条目，
                // 否则 replace_batch 的全量替换会把 UWP 应用全部清空
                log::warn!("UWP 扫描失败（{}），沿用缓存中已有的 UWP 条目", e);
                merge_uwp_cached(db_state, &mut apps, &mut seen_targets, &mut seen_names);
            }
        }

        // Custom directories configured by user
        let custom_dirs = load_custom_dirs(db_state);
        for dir_path in custom_dirs {
            let dir = PathBuf::from(&dir_path);
            scan_dir_if_local(&dir, &mut apps, &mut seen_targets, &mut seen_names);
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

        log::info!(
            "Collected {} applications in {:?}",
            apps.len(),
            start.elapsed()
        );
        Ok(apps)
    }

    /// Replace the in-memory index with apps collected elsewhere (see
    /// `collect_all_apps`). Used to swap in results of an unlocked background scan.
    pub fn apply_indexed_apps(&mut self, apps: Vec<AppItem>) {
        self.apps = apps;
        self.indexed = true;
        self.scanning = false;
        self.merge_system_features();
    }

    /// 合入 Windows 系统功能（ms-settings 设置页）到内存索引。
    /// 静态清单不进缓存（无缓存意义），每次索引就绪（缓存加载/全量扫描/
    /// 后台刷新）后调用——设置页条目由此常驻索引，不依赖文件系统与外部
    /// 进程，也无需 watcher。按 name 去重：同 URI 可有多条（如"已安装的
    /// 应用"与"卸载应用"同指 ms-settings:appsfeatures，不同搜索词都要命中）。
    pub fn merge_system_features(&mut self) {
        let mut seen: HashSet<String> = self.apps.iter().map(|a| a.name.clone()).collect();
        for feat in system_features::scan() {
            if seen.insert(feat.name.to_string()) {
                self.apps.push(AppItem {
                    name: feat.name.to_string(),
                    path: feat.uri.to_string(),
                    icon: None,
                    pinyin_initials: to_pinyin_initials(feat.name),
                });
            }
        }
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

    /// 缓存是否新鲜：以 app_cache_meta.last_full_scan（UTC）为准——不能用
    /// app_cache 表 MAX(updated_at)（watcher 增量更新也会刷新它，全量扫描
    /// 会永不触发）。判断失败或从未全量扫过一律视为不新鲜（保守触发刷新：
    /// 多扫一次的代价远低于索引长期陈旧）。
    pub fn is_cache_fresh(&self) -> bool {
        let Some(ref db_state) = self.db_state else {
            return false;
        };
        let Ok(conn) = rusqlite::Connection::open(&db_state.0) else {
            return false;
        };
        let Some(last) = crate::db::app_cache::last_full_scan(&conn) else {
            return false;
        };
        // last_full_scan 存北京时间（UTC+8），解析后换算回 UTC 再比较
        let Some(last_utc) = chrono::NaiveDateTime::parse_from_str(&last, "%Y-%m-%d %H:%M:%S").ok()
        else {
            return false;
        };
        let last_utc = last_utc - chrono::Duration::hours(8);
        let elapsed = chrono::Utc::now().naive_utc() - last_utc;
        elapsed < chrono::Duration::from_std(Self::CACHE_STALE_AFTER).unwrap_or_default()
    }

    /// Background refresh - scans directories and updates cache
    pub fn refresh_in_background(&mut self) -> anyhow::Result<()> {
        let apps = Self::collect_all_apps(&self.db_state)?;
        self.apps = apps;
        self.indexed = true;
        self.merge_system_features();

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
            // 去重与 collect_all_apps 一致：先按目标路径找已有条目（更新），
            // 再按名称找（同名跳过——同应用不同 exe 不新增），否则新增。
            let target_key = target_path.to_lowercase();

            // Update in-memory list
            if let Some(existing) = self.apps.iter_mut().find(|a| {
                let existing_target =
                    parse_shortcut_target(Path::new(&a.path)).unwrap_or_else(|| a.path.clone());
                existing_target.to_lowercase() == target_key
            }) {
                *existing = app.clone();
            } else if !self
                .apps
                .iter()
                .any(|a| a.name.eq_ignore_ascii_case(&app.name))
            {
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
        // eq_ignore_ascii_case:Windows 路径大小写不敏感,watcher 报告的
        // 路径大小写可能与扫描时存储的不一致,精确比较会静默漏删
        self.apps.retain(|a| !a.path.eq_ignore_ascii_case(&path_str));

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

    /// Remove all apps under a directory (whole-folder deletion).
    /// 卸载程序常直接删除整个快捷方式文件夹,ReadDirectoryChangesW 只报告
    /// 目录本身的删除、子 .lnk 不会逐个触发 Remove——按路径前缀批量失效。
    /// 边界判断:目录 `...\Cursor` 只命中其下的条目,不误伤 `...\Cursor2\`。
    pub fn remove_app_by_prefix(&mut self, dir: &Path) -> anyhow::Result<()> {
        let prefix = dir.to_string_lossy().to_lowercase();
        let prefix_len = prefix.len();

        self.apps.retain(|a| {
            let p = a.path.to_lowercase();
            !(p.starts_with(&prefix)
                && (p.len() == prefix_len || p[prefix_len..].starts_with('\\')))
        });

        if let Some(ref db_state) = self.db_state {
            if let Ok(conn) = rusqlite::Connection::open(&db_state.0) {
                if let Err(e) = app_cache::mark_invalid_by_prefix(&conn, &dir.to_string_lossy()) {
                    log::warn!(
                        "Failed to mark {} subtree as invalid in cache: {}",
                        dir.display(),
                        e
                    );
                }
            }
        }

        Ok(())
    }

    /// UWP 条目全量重扫的最短间隔。Get-StartApps 每次启动 PowerShell 进程,
    /// 在慢环境可达秒级——唤起校验不能每次都跑,间隔内 UWP 条目跳过校验。
    const UWP_VERIFY_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10 * 60);

    /// 查询 UWP 条目是否到期该重扫（锁内调用,微秒级）。到期则更新计时。
    pub fn uwp_verify_due(&mut self) -> bool {
        let due = self
            .last_uwp_verify
            .map_or(true, |t| t.elapsed() >= Self::UWP_VERIFY_INTERVAL);
        if due {
            self.last_uwp_verify = Some(std::time::Instant::now());
        }
        due
    }

    /// 校验条目是否仍然有效。纯函数:不持锁、不碰 self,由调用方在锁外执行。
    ///
    /// - `shell:AppsFolder\` 前缀（UWP 条目）:文件系统不存在该路径,只能重扫
    ///   Get-StartApps 做 diff;`uwp_rescan` 为 false 时跳过（未到期）;
    /// - 其他条目（.lnk / 注册表来源的 .exe）:文件存在性检查,毫秒级;
    /// - UNC 路径跳过:断网网络盘上 stat 会阻塞数秒,与扫描侧行为一致。
    ///
    /// 返回失效条目的 path 列表。
    pub fn verify_apps_on_disk(apps: &[AppItem], uwp_rescan: bool) -> Vec<String> {
        // UWP 校验：扫描失败（Err）与返回空集（Ok(0)）都视为不可信——
        // 不该因扫描失败误判卸载，与 collect_all_apps 的「失败沿用缓存」同一
        // 原则。空集若被当作「确实没有」，会把缓存里所有 UWP 条目判为失效
        // 删除（Get-StartApps 偶发空输出），因此仅在扫描成功且非空时执行 diff。
        let uwp_valid: Option<HashSet<String>> = if uwp_rescan {
            uwp::scan()
                .ok()
                .filter(|apps| !apps.is_empty())
                .map(|apps| apps.iter().map(|u| uwp::launch_path(&u.app_id)).collect())
        } else {
            Some(HashSet::new())
        };

        apps.iter()
            .filter_map(|app| {
                let p = &app.path;
                if p.starts_with("shell:AppsFolder\\") {
                    match uwp_valid {
                        Some(ref valid) if !valid.contains(p) => Some(p.clone()),
                        _ => None,
                    }
                } else if p.starts_with("\\\\") {
                    None
                } else if p.starts_with("ms-settings:") {
                    // 系统功能条目（ms-settings URI）：非文件路径，
                    // Path::exists() 恒为 false，必须跳过否则被误删
                    None
                } else if !Path::new(p).exists() {
                    Some(p.clone())
                } else {
                    None
                }
            })
            .collect()
    }
}

/// 目录递归扫描的最大深度（开始菜单/桌面正常不超过 3 层，限制深度防御异常目录树）
const MAX_SCAN_DEPTH: usize = 5;

/// Scan a local directory for shortcuts. UNC paths are skipped outright — a
/// disconnected network drive can block `read_dir` for tens of seconds.
fn scan_dir_if_local(
    dir: &Path,
    apps: &mut Vec<AppItem>,
    seen_targets: &mut HashSet<String>,
    seen_names: &mut HashSet<String>,
) {
    if dir.as_os_str().to_string_lossy().starts_with("\\\\") {
        log::warn!("Skipping UNC scan directory: {}", dir.display());
        return;
    }
    if !dir.exists() {
        return;
    }
    if let Err(e) = scan_directory(dir, apps, seen_targets, seen_names, 0) {
        log::warn!("Failed to scan directory {}: {}", dir.display(), e);
    }
}

fn scan_directory(
    dir: &Path,
    apps: &mut Vec<AppItem>,
    seen_targets: &mut HashSet<String>,
    seen_names: &mut HashSet<String>,
    depth: usize,
) -> anyhow::Result<()> {
    if depth > MAX_SCAN_DEPTH {
        log::warn!(
            "Scan depth limit reached, skipping subtree: {}",
            dir.display()
        );
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
            if let Err(e) = scan_directory(&path, apps, seen_targets, seen_names, depth + 1) {
                log::warn!("Failed to scan subdirectory {}: {}", path.display(), e);
            }
        } else if let Some(ext) = path.extension() {
            if ext.eq_ignore_ascii_case("lnk") {
                if let Some((app, target_path)) = parse_shortcut(&path) {
                    // 双重去重与 collect_all_apps 顶层语义一致：
                    // - target：同一 exe 的多个快捷方式（如"向日葵远程控制.lnk"
                    //   与"卸载向日葵远程控制.lnk"）只保留先扫到的条目；
                    // - name：进入结果集的名字必须登记 seen_names——否则注册表/
                    //   UWP 来源的同名条目（如"暴雪战网"的 .lnk 指向
                    //   Battle.net Launcher.exe、注册表指向 Battle.net.exe）会
                    //   双双通过，app_cache 出现同名两行。
                    let key = target_path.to_lowercase();
                    if seen_targets.insert(key) && seen_names.insert(app.name.to_lowercase()) {
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

/// 从缓存加载 UWP 条目并入结果集（UWP 扫描失败/返回 0 条时沿用旧条目）。
/// 沿用与「确实没有 UWP」的差别在于：缓存里可能有上次扫描留下的条目，
/// 若直接返回空结果,调用方的 replace_batch 全量替换会把它们清空。
fn merge_uwp_cached(
    db_state: &Option<Arc<DatabaseState>>,
    apps: &mut Vec<AppItem>,
    seen_targets: &mut HashSet<String>,
    seen_names: &mut HashSet<String>,
) {
    let Some(ref db_state) = db_state else {
        return;
    };
    let Ok(conn) = rusqlite::Connection::open(&db_state.0) else {
        return;
    };
    let Ok(entries) = app_cache::load_uwp_cached(&conn) else {
        return;
    };
    for entry in entries {
        let target_key = entry.path.to_lowercase();
        if !seen_targets.contains(&target_key) && seen_names.insert(entry.name.to_lowercase()) {
            seen_targets.insert(target_key);
            apps.push(AppItem {
                name: entry.name,
                path: entry.path,
                icon: None,
                pinyin_initials: entry.pinyin_initials,
            });
        }
    }
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

    /// 打开索引关联的数据库连接（供调用方连带清理其他表，如 app_usage）。
    pub fn db_connection(&self) -> Option<rusqlite::Connection> {
        self.db_state
            .as_ref()
            .and_then(|s| rusqlite::Connection::open(&s.0).ok())
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
