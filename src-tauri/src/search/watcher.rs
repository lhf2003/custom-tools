use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::db::DatabaseState;
use crate::search::SearchIndex;

/// Debounce interval for file system events
const DEBOUNCE_MS: u64 = 500;

/// Message type for watcher events
#[derive(Debug, Clone)]
pub enum WatcherEvent {
    /// File created or modified
    Add(PathBuf),
    /// File removed
    Remove(PathBuf),
    /// Directory removed (all shortcuts under it are stale)
    RemoveDir(PathBuf),
    /// Batch update (debounced)
    BatchUpdate,
}

/// File system watcher for Start Menu and Desktop directories
pub struct AppWatcher {
    #[allow(dead_code)]
    watcher: RecommendedWatcher,
    event_sender: mpsc::Sender<WatcherEvent>,
    db_state: Arc<DatabaseState>,
}

impl AppWatcher {
    /// Start watching application directories
    pub fn start(
        index: Arc<Mutex<SearchIndex>>,
        db_state: Arc<DatabaseState>,
    ) -> anyhow::Result<Self> {
        let (tx, rx) = mpsc::channel::<WatcherEvent>();
        let event_sender = tx.clone();

        // Create watcher with debounced handler
        let watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            match res {
                Ok(event) => {
                    // Process event based on kind
                    match event.kind {
                        notify::EventKind::Create(_) => {
                            for path in &event.paths {
                                if is_lnk_file(path) {
                                    let _ = event_sender.send(WatcherEvent::Add(path.clone()));
                                }
                            }
                        }
                        notify::EventKind::Modify(_) => {
                            for path in &event.paths {
                                if is_lnk_file(path) {
                                    let _ = event_sender.send(WatcherEvent::Add(path.clone()));
                                }
                            }
                        }
                        notify::EventKind::Remove(_) => {
                            for path in &event.paths {
                                if is_lnk_file(path) {
                                    let _ = event_sender.send(WatcherEvent::Remove(path.clone()));
                                } else if path.extension().is_none() {
                                    // 目录被整个删除：ReadDirectoryChangesW 对目录
                                    // 删除只报告目录本身，子 .lnk 不会逐个触发 Remove。
                                    // 无扩展名按目录处理，按前缀批量失效。
                                    let _ = event_sender.send(WatcherEvent::RemoveDir(path.clone()));
                                }
                            }
                        }
                        _ => {}
                    }

                    // Send batch update signal
                    let _ = event_sender.send(WatcherEvent::BatchUpdate);
                }
                Err(e) => {
                    log::warn!("File watcher error: {}", e);
                }
            }
        })?;

        let mut app_watcher = Self {
            watcher,
            event_sender: tx,
            db_state,
        };

        // Watch directories
        app_watcher.watch_directories()?;

        // Start background processor in a separate thread
        thread::spawn(move || {
            process_events(index, rx);
        });

        Ok(app_watcher)
    }

    fn watch_directories(&mut self) -> anyhow::Result<()> {
        // System start menu
        let system_start_menu =
            PathBuf::from("C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs");
        if system_start_menu.exists() {
            self.watcher
                .watch(&system_start_menu, RecursiveMode::Recursive)?;
            log::info!(
                "Watching system start menu: {}",
                system_start_menu.display()
            );
        }

        // User start menu
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            let user_start_menu = PathBuf::from(user_profile)
                .join("AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs");
            if user_start_menu.exists() {
                self.watcher
                    .watch(&user_start_menu, RecursiveMode::Recursive)?;
                log::info!("Watching user start menu: {}", user_start_menu.display());
            }
        }

        // Desktop
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            let desktop = PathBuf::from(user_profile).join("Desktop");
            if desktop.exists() {
                self.watcher.watch(&desktop, RecursiveMode::Recursive)?;
                log::info!("Watching desktop: {}", desktop.display());
            }
        }

        // 自定义扫描目录（数据库 custom_scan_dirs）：没有 watcher 覆盖时，
        // 其中的应用增删只能等 24h 全量扫描——必须纳入监听
        for dir_path in super::load_custom_dirs(&Some(self.db_state.clone())) {
            let dir = PathBuf::from(dir_path);
            if dir.as_os_str().to_string_lossy().starts_with("\\\\") {
                log::warn!("Skipping UNC watch directory: {}", dir.display());
                continue;
            }
            if !dir.exists() {
                continue;
            }
            match self.watcher.watch(&dir, RecursiveMode::Recursive) {
                Ok(()) => log::info!("Watching custom dir: {}", dir.display()),
                Err(e) => log::warn!("Failed to watch custom dir {}: {}", dir.display(), e),
            }
        }

        Ok(())
    }

    /// Force a full refresh
    pub fn refresh(&self) -> anyhow::Result<()> {
        let _ = self.event_sender.send(WatcherEvent::BatchUpdate);
        Ok(())
    }
}

/// Background task to process watcher events with debouncing
fn process_events(index: Arc<Mutex<SearchIndex>>, receiver: mpsc::Receiver<WatcherEvent>) {
    let mut pending_adds = Vec::new();
    let mut pending_removes = Vec::new();
    let mut pending_remove_dirs = Vec::new();
    let mut last_update = Instant::now();

    while let Ok(event) = receiver.recv() {
        match event {
            WatcherEvent::Add(path) => {
                pending_adds.push(path);
            }
            WatcherEvent::Remove(path) => {
                pending_removes.push(path);
            }
            WatcherEvent::RemoveDir(path) => {
                pending_remove_dirs.push(path);
            }
            WatcherEvent::BatchUpdate => {
                // Debounce:事件流可能还在持续,先睡到 debounce 期满合并窗口内的
                // 后续事件,期满后立即落地处理。旧实现 elapsed<=500ms 时既不处理
                // 也不安排后续处理,事件流停止后的变更被无限期冻结——用户复制
                // 单个 .lnk 后永远搜不到新应用,直到下一个文件系统事件到来。
                if last_update.elapsed().as_millis() <= DEBOUNCE_MS as u128 {
                    let remaining = DEBOUNCE_MS as u128 - last_update.elapsed().as_millis();
                    thread::sleep(Duration::from_millis(remaining as u64));
                }

                // Process pending changes
                if let Ok(mut idx) = index.lock() {
                    // 目录删除最先处理：整个目录下所有条目批量失效。之后单文件
                    // Remove/Add 再按自身语义处理（Add 对已删条目会因文件不存在
                    // 解析失败而不产生添加，不会把僵尸条目加回来）。
                    for dir in &pending_remove_dirs {
                        if let Err(e) = idx.remove_app_by_prefix(dir) {
                            log::warn!(
                                "Failed to remove app dir {}: {}",
                                dir.display(),
                                e
                            );
                        } else {
                            log::info!("Removed app dir: {}", dir.display());
                        }
                    }

                    // Handle removals first
                    for path in &pending_removes {
                        if let Err(e) = idx.remove_app(path) {
                            log::warn!("Failed to remove app {}: {}", path.display(), e);
                        } else {
                            log::info!("Removed app: {}", path.display());
                        }
                    }

                    // Handle additions/updates
                    for path in &pending_adds {
                        if let Err(e) = idx.add_or_update_app(path) {
                            log::warn!("Failed to add app {}: {}", path.display(), e);
                        } else {
                            log::info!("Added/updated app: {}", path.display());
                        }
                    }
                }

                pending_adds.clear();
                pending_removes.clear();
                pending_remove_dirs.clear();
                last_update = Instant::now();
            }
        }

        // Small sleep to prevent busy-waiting
        thread::sleep(Duration::from_millis(10));
    }
}

fn is_lnk_file(path: &std::path::Path) -> bool {
    path.extension()
        .map(|ext| ext.eq_ignore_ascii_case("lnk"))
        .unwrap_or(false)
}

/// Initialize file watcher on app startup
pub fn init_watcher(
    index: Arc<Mutex<SearchIndex>>,
    db_state: Arc<DatabaseState>,
) -> anyhow::Result<AppWatcher> {
    AppWatcher::start(index, db_state)
}
