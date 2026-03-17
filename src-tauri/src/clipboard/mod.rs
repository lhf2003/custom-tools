use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc::channel;

mod watcher;

pub use watcher::ClipboardWatcher;

use crate::db::DatabaseState;

/// Clipboard content types
#[derive(Debug, Clone)]
pub enum ClipboardContent {
    Text(String),
    Image(Vec<u8>),
    FileList(Vec<String>),
    Unknown,
}

/// Clipboard event
#[derive(Debug, Clone)]
pub struct ClipboardEvent {
    pub content: ClipboardContent,
    pub source_app: Option<String>,
}

/// Clipboard manager that handles watching and storing
pub struct ClipboardManager {
    watcher: Arc<Mutex<ClipboardWatcher>>,
    app_handle: AppHandle,
}

impl ClipboardManager {
    pub fn new(app_handle: AppHandle) -> anyhow::Result<Self> {
        let (tx, mut rx) = channel::<ClipboardEvent>(100);

        let watcher = Arc::new(Mutex::new(ClipboardWatcher::new(tx)?));

        // Spawn clipboard watching thread
        let watcher_clone = Arc::clone(&watcher);
        thread::spawn(move || {
            if let Ok(mut watcher) = watcher_clone.lock() {
                if let Err(e) = watcher.run() {
                    log::error!("Clipboard watcher error: {}", e);
                }
            }
        });

        // Spawn event processing task
        let app_handle_clone = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                if let Err(e) = Self::handle_clipboard_event(&app_handle_clone, event).await {
                    log::error!("Failed to handle clipboard event: {}", e);
                }
            }
        });

        Ok(Self {
            watcher,
            app_handle,
        })
    }

    async fn handle_clipboard_event(
        app_handle: &AppHandle,
        event: ClipboardEvent,
    ) -> anyhow::Result<()> {
        let db_state = app_handle.state::<DatabaseState>();
        let conn = rusqlite::Connection::open(&db_state.0)?;

        match event.content {
            ClipboardContent::Text(text) => {
                if text.trim().is_empty() {
                    return Ok(());
                }

                // Calculate content hash for deduplication
                let hash = Self::calculate_hash(&text);

                // Check if content already exists (within last hour)
                let exists: bool = conn.query_row(
                    "SELECT 1 FROM clipboard_history
                     WHERE content_hash = ?1
                     AND created_at > datetime('now', '-1 hour')
                     LIMIT 1",
                    [&hash],
                    |_| Ok(true),
                ).unwrap_or(false);

                if exists {
                    log::debug!("Duplicate clipboard content ignored");
                    return Ok(());
                }

                // Insert new clipboard item
                conn.execute(
                    "INSERT INTO clipboard_history
                     (content, content_type, content_hash, source_app)
                     VALUES (?1, 'text', ?2, ?3)",
                    [
                        &text,
                        &hash,
                        event.source_app.as_deref().unwrap_or("Unknown"),
                    ],
                )?;

                log::info!("Clipboard text saved, length: {}", text.len());
            }
            ClipboardContent::Image(data) => {
                let hash = Self::calculate_hash(&data);

                // Store image reference (actual image stored in file system)
                let app_dir = dirs::data_dir()
                    .ok_or_else(|| anyhow::anyhow!("Failed to get data dir"))?
                    .join("custom-tools")
                    .join("clipboard-images");
                std::fs::create_dir_all(&app_dir)?;

                let image_path = app_dir.join(format!("{}.png", &hash[..16]));
                std::fs::write(&image_path, &data)?;

                conn.execute(
                    "INSERT INTO clipboard_history
                     (content, content_type, content_hash, source_app)
                     VALUES (?1, 'image', ?2, ?3)",
                    [
                        image_path.to_string_lossy().to_string(),
                        hash,
                        event.source_app.as_deref().unwrap_or("Unknown").to_string(),
                    ],
                )?;

                log::info!("Clipboard image saved, size: {} bytes", data.len());
            }
            ClipboardContent::FileList(files) => {
                let content = files.join("\n");
                let hash = Self::calculate_hash(&content);

                conn.execute(
                    "INSERT INTO clipboard_history
                     (content, content_type, content_hash, source_app)
                     VALUES (?1, 'file', ?2, ?3)",
                    [
                        &content,
                        &hash,
                        event.source_app.as_deref().unwrap_or("Unknown"),
                    ],
                )?;

                log::info!("Clipboard file list saved, count: {}", files.len());
            }
            ClipboardContent::Unknown => {
                log::debug!("Unknown clipboard content type ignored");
            }
        }

        // Clean up old items (keep only last 100)
        let _ = conn.execute(
            "DELETE FROM clipboard_history
             WHERE id NOT IN (
                 SELECT id FROM clipboard_history
                 ORDER BY created_at DESC
                 LIMIT 100
             )",
            [],
        );

        Ok(())
    }

    fn calculate_hash<T: AsRef<[u8]>>(data: T) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(data);
        format!("{:x}", hasher.finalize())
    }

    pub fn stop(&self) -> anyhow::Result<()> {
        if let Ok(mut watcher) = self.watcher.lock() {
            watcher.stop()?;
        }
        Ok(())
    }
}
