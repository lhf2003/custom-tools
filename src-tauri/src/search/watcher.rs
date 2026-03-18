use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::sync::mpsc::{channel, Receiver, Sender};

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
    /// Batch update (debounced)
    BatchUpdate,
}

/// File system watcher for Start Menu and Desktop directories
pub struct AppWatcher {
    watcher: RecommendedWatcher,
    event_sender: Sender<WatcherEvent>,
    last_event: Arc<Mutex<Option<Instant>>>,
}

impl AppWatcher {
    /// Start watching application directories
    pub fn start(
        index: Arc<Mutex<SearchIndex>>,
        db_state: Arc<DatabaseState>,
    ) -> anyhow::Result<Self> {
        let (tx, rx) = channel::<WatcherEvent>(100);
        let event_sender = tx.clone();
        let last_event = Arc::new(Mutex::new(None));

        // Clone for closure
        let last_event_clone = last_event.clone();
        let index_clone = index.clone();

        // Create watcher with debounced handler
        let watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            match res {
                Ok(event) => {
                    // Update last event time
                    if let Ok(mut last) = last_event_clone.lock() {
                        *last = Some(Instant::now());
                    }

                    // Process event based on kind
                    match event.kind {
                        notify::EventKind::Create(_) => {
                            for path in &event.paths {
                                if is_lnk_file(path) {
                                    let _ = event_sender.try_send(WatcherEvent::Add(path.clone()));
                                }
                            }
                        }
                        notify::EventKind::Modify(_) => {
                            for path in &event.paths {
                                if is_lnk_file(path) {
                                    let _ = event_sender.try_send(WatcherEvent::Add(path.clone()));
                                }
                            }
                        }
                        notify::EventKind::Remove(_) => {
                            for path in &event.paths {
                                if is_lnk_file(path) {
                                    let _ = event_sender.try_send(WatcherEvent::Remove(path.clone()));
                                }
                            }
                        }
                        _ => {}
                    }

                    // Send batch update signal
                    let _ = event_sender.try_send(WatcherEvent::BatchUpdate);
                }
                Err(e) => {
                    log::warn!("File watcher error: {}", e);
                }
            }
        })?;

        let mut app_watcher = Self {
            watcher,
            event_sender: tx,
            last_event,
        };

        // Watch directories
        app_watcher.watch_directories()?;

        // Start background processor
        tokio::spawn(process_events(index, db_state, rx));

        Ok(app_watcher)
    }

    fn watch_directories(&mut self) -> anyhow::Result<()> {
        // System start menu
        let system_start_menu = PathBuf::from("C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs");
        if system_start_menu.exists() {
            self.watcher.watch(&system_start_menu, RecursiveMode::Recursive)?;
            log::info!("Watching system start menu: {}", system_start_menu.display());
        }

        // User start menu
        if let Ok(user_profile) = std::env::var("USERPROFILE") {
            let user_start_menu = PathBuf::from(user_profile)
                .join("AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs");
            if user_start_menu.exists() {
                self.watcher.watch(&user_start_menu, RecursiveMode::Recursive)?;
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

        Ok(())
    }

    /// Force a full refresh
    pub fn refresh(&self) -> anyhow::Result<()> {
        let _ = self.event_sender.try_send(WatcherEvent::BatchUpdate);
        Ok(())
    }
}

/// Background task to process watcher events with debouncing
async fn process_events(
    index: Arc<Mutex<SearchIndex>>,
    _db_state: Arc<DatabaseState>,
    mut receiver: Receiver<WatcherEvent>,
) {
    let mut pending_adds = Vec::new();
    let mut pending_removes = Vec::new();
    let mut last_update = Instant::now();

    while let Some(event) = receiver.recv().await {
        match event {
            WatcherEvent::Add(path) => {
                pending_adds.push(path);
            }
            WatcherEvent::Remove(path) => {
                pending_removes.push(path);
            }
            WatcherEvent::BatchUpdate => {
                // Check if debounce period has passed
                if last_update.elapsed().as_millis() > DEBOUNCE_MS as u128 {
                    // Process pending changes
                    if let Ok(mut idx) = index.lock() {
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
                    last_update = Instant::now();
                }
            }
        }
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
