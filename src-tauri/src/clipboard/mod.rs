use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::channel;

mod watcher;

pub use watcher::ClipboardWatcher;

use crate::commands::settings::SettingsState;
use crate::db::DatabaseState;

/// Read the `FileDescription` field from the exe's version resource — this
/// is the display name shown in Explorer (e.g. "Google Chrome").
/// 作为 app_cache 未命中时的名称兜底（绿色软件/无快捷方式应用）。
fn file_description(exe_path: &str) -> Option<String> {
    use std::ffi::c_void;
    use windows::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
    };
    use windows_core::PCWSTR;

    unsafe {
        let path_wide: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();

        // 返回 0 表示失败（无版本资源等）
        let size = GetFileVersionInfoSizeW(PCWSTR(path_wide.as_ptr()), None);
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        if GetFileVersionInfoW(
            PCWSTR(path_wide.as_ptr()),
            None,
            size,
            buf.as_mut_ptr() as *mut c_void,
        )
        .is_err()
        {
            return None;
        }

        // 遍历 Translation 表所有语言/代码页条目（如 040904b0 / 080404b0）。
        // 各语言块的描述可能不同（个别 exe 存在短值块），取最长的作为显示名。
        let mut trans: *mut c_void = std::ptr::null_mut();
        let mut trans_len: u32 = 0;
        if !VerQueryValueW(
            buf.as_ptr() as *const c_void,
            windows_core::w!("\\VarFileInfo\\Translation"),
            &mut trans,
            &mut trans_len,
        )
        .as_bool()
        {
            return None;
        }
        if trans_len < 4 {
            return None;
        }

        let entry_count = trans_len / 4; // 每个条目一个 DWORD [lang, codepage]
        let mut best: Option<String> = None;
        for i in 0..entry_count {
            let lang_cp = *(trans as *const u32).add(i as usize);
            let key = format!(
                "\\StringFileInfo\\{:04x}{:04x}\\FileDescription",
                lang_cp & 0xFFFF,
                lang_cp >> 16
            );
            // 必须 null 结尾：VerQueryValueW 按 null 终止读取子块键名
            let key_wide: Vec<u16> = key.encode_utf16().chain(std::iter::once(0)).collect();

            let mut desc: *mut c_void = std::ptr::null_mut();
            let mut desc_len: u32 = 0;
            if !VerQueryValueW(
                buf.as_ptr() as *const c_void,
                PCWSTR(key_wide.as_ptr()),
                &mut desc,
                &mut desc_len,
            )
            .as_bool()
            {
                continue;
            }
            if desc_len == 0 {
                continue;
            }
            let value_chars = std::slice::from_raw_parts(desc as *const u16, desc_len as usize / 2);
            let end = value_chars
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(value_chars.len());
            let name = String::from_utf16_lossy(&value_chars[..end]).trim().to_string();
            if name.is_empty() {
                continue;
            }
            if best.as_ref().map_or(true, |b| name.len() > b.len()) {
                best = Some(name);
            }
        }
        best
    }
}

/// Shared flag to suppress clipboard recording when the app writes internally.
/// Set to `true` before an internal clipboard write; the event processor clears it.
pub struct ClipboardSuppressFlag(pub Arc<AtomicBool>);

impl ClipboardSuppressFlag {
    /// Store `true` to suppress the next clipboard event.
    pub fn suppress(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    /// Store `false` to clear suppression.
    pub fn clear(&self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

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
    /// 显示名（exe 版本信息的 FileDescription，如 "Google Chrome"）
    pub source_app: Option<String>,
    /// 来源 exe 完整路径（图标由此派生）
    pub source_exe: Option<String>,
}

/// Clipboard manager that handles watching and storing
pub struct ClipboardManager {
    watcher: Arc<Mutex<ClipboardWatcher>>,
}

impl ClipboardManager {
    pub fn new(app_handle: AppHandle, suppress_flag: Arc<AtomicBool>) -> anyhow::Result<Self> {
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
                // Skip recording when this app wrote to clipboard internally
                if suppress_flag.swap(false, Ordering::Relaxed) {
                    log::debug!("Clipboard update suppressed (internal write)");
                    continue;
                }
                if let Err(e) = Self::handle_clipboard_event(&app_handle_clone, event).await {
                    log::error!("Failed to handle clipboard event: {}", e);
                }
            }
        });

        // Cleanup old items on startup
        let app_handle_clone = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            if let Some(db_state) = app_handle_clone.try_state::<DatabaseState>() {
                if let Ok(conn) = rusqlite::Connection::open(&db_state.0) {
                    if let Err(e) = Self::cleanup_old_items(&app_handle_clone, &conn) {
                        log::warn!("Failed to cleanup old clipboard items on startup: {}", e);
                    }
                }
            }
        });

        Ok(Self { watcher })
    }

    async fn handle_clipboard_event(
        app_handle: &AppHandle,
        mut event: ClipboardEvent,
    ) -> anyhow::Result<()> {
        let db_state = app_handle.state::<DatabaseState>();
        let conn = rusqlite::Connection::open(&db_state.0)?;

        // 来源显示名解析（按优先级）：
        // 1. 启动器应用缓存（快捷方式名，如 "Google Chrome"）
        // 2. exe 版本资源的 FileDescription
        // 3. 进程文件主干（如 "chrome"）
        if let Some(exe) = event.source_exe.as_deref() {
            let name = conn
                .query_row(
                    "SELECT name FROM app_cache
                     WHERE target_path = ?1 COLLATE NOCASE AND is_valid = 1
                     LIMIT 1",
                    [exe],
                    |row| row.get::<_, String>(0),
                )
                .ok()
                .or_else(|| file_description(exe))
                .or_else(|| {
                    std::path::Path::new(exe)
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                });
            if let Some(name) = name {
                event.source_app = Some(name);
            }
        }

        match event.content {
            ClipboardContent::Text(text) => {
                if text.trim().is_empty() {
                    return Ok(());
                }

                // Calculate content hash for deduplication
                let hash = Self::calculate_hash(&text);

                // Check if content already exists (within last hour)
                let exists: bool = conn
                    .query_row(
                        "SELECT 1 FROM clipboard_history
                     WHERE content_hash = ?1
                     AND created_at > datetime('now', '-1 hour')
                     LIMIT 1",
                        [&hash],
                        |_| Ok(true),
                    )
                    .unwrap_or(false);

                if exists {
                    log::debug!("Duplicate clipboard content ignored");
                    return Ok(());
                }

                // Insert new clipboard item
                conn.execute(
                    "INSERT INTO clipboard_history
                     (content, content_type, content_hash, source_app, source_exe)
                     VALUES (?1, 'text', ?2, ?3, ?4)",
                    rusqlite::params![
                        &text,
                        &hash,
                        event.source_app.as_deref().unwrap_or("Unknown"),
                        event.source_exe,
                    ],
                )?;

                log::info!("Clipboard text saved, length: {}", text.len());
            }
            ClipboardContent::Image(data) => {
                let hash = Self::calculate_hash(&data);

                // Check if the same image was already saved recently
                let exists: bool = conn
                    .query_row(
                        "SELECT 1 FROM clipboard_history
                     WHERE content_hash = ?1
                     AND created_at > datetime('now', '-1 hour')
                     LIMIT 1",
                        [&hash],
                        |_| Ok(true),
                    )
                    .unwrap_or(false);

                if exists {
                    log::debug!("Duplicate clipboard image ignored");
                    return Ok(());
                }

                // Store image reference (actual image stored in file system)
                let app_dir = dirs::data_dir()
                    .ok_or_else(|| anyhow::anyhow!("Failed to get data dir"))?
                    .join(crate::APP_DIR_NAME)
                    .join("clipboard-images");
                std::fs::create_dir_all(&app_dir)?;

                let image_path = app_dir.join(format!("{}.png", &hash[..16]));
                std::fs::write(&image_path, &data)?;

                conn.execute(
                    "INSERT INTO clipboard_history
                     (content, content_type, content_hash, source_app, source_exe)
                     VALUES (?1, 'image', ?2, ?3, ?4)",
                    [
                        image_path.to_string_lossy().to_string(),
                        hash,
                        event.source_app.as_deref().unwrap_or("Unknown").to_string(),
                        event.source_exe.clone().unwrap_or_default(),
                    ],
                )?;

                log::info!("Clipboard image saved, size: {} bytes", data.len());
            }
            ClipboardContent::FileList(files) => {
                let content = files.join("\n");
                let hash = Self::calculate_hash(&content);

                conn.execute(
                    "INSERT INTO clipboard_history
                     (content, content_type, content_hash, source_app, source_exe)
                     VALUES (?1, 'file', ?2, ?3, ?4)",
                    rusqlite::params![
                        &content,
                        &hash,
                        event.source_app.as_deref().unwrap_or("Unknown"),
                        event.source_exe,
                    ],
                )?;

                log::info!("Clipboard file list saved, count: {}", files.len());
            }
            ClipboardContent::Unknown => {
                log::debug!("Unknown clipboard content type ignored");
            }
        }

        // Clean up old items based on settings
        if let Err(e) = Self::cleanup_old_items(app_handle, &conn) {
            log::warn!("Failed to cleanup old clipboard items: {}", e);
        }

        // Notify frontend that clipboard has been updated
        app_handle.emit("clipboard-updated", ())?;

        Ok(())
    }

    fn calculate_hash<T: AsRef<[u8]>>(data: T) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(data);
        format!("{:x}", hasher.finalize())
    }

    /// Cleanup old clipboard items based on settings
    fn cleanup_old_items(
        app_handle: &AppHandle,
        conn: &rusqlite::Connection,
    ) -> anyhow::Result<()> {
        // Get settings
        let keep_days: i32 = if let Some(settings_state) = app_handle.try_state::<SettingsState>() {
            if let Ok(settings) = settings_state.0.lock() {
                settings.get_settings().clipboard_keep_days
            } else {
                30 // Default: 30 days
            }
        } else {
            30 // Default: 30 days
        };

        // Helper function to collect image paths for deletion
        fn collect_image_paths(
            conn: &rusqlite::Connection,
            query: &str,
            params: &[&dyn rusqlite::ToSql],
        ) -> anyhow::Result<Vec<String>> {
            let mut stmt = conn.prepare(query)?;
            let paths: Vec<String> = stmt
                .query_map(params, |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(paths)
        }

        // If keep_days is 0, keep all items (no cleanup by days)
        // But still keep max 500 items to prevent unlimited growth
        if keep_days == 0 {
            // Collect image paths for items that will be deleted
            let image_paths = collect_image_paths(
                conn,
                "SELECT content FROM clipboard_history
                 WHERE id NOT IN (
                     SELECT id FROM clipboard_history
                     ORDER BY created_at DESC
                     LIMIT 500
                 )
                 AND content_type = 'image'
                 AND is_favorite = 0",
                &[],
            )?;

            let deleted = conn.execute(
                "DELETE FROM clipboard_history
                 WHERE id NOT IN (
                     SELECT id FROM clipboard_history
                     ORDER BY created_at DESC
                     LIMIT 500
                 )
                 AND is_favorite = 0",
                [],
            )?;

            if deleted > 0 {
                log::info!("Cleaned up {} old clipboard items (max 500 limit)", deleted);
            }

            // Cleanup image files
            for path in image_paths {
                if let Err(e) = std::fs::remove_file(&path) {
                    log::warn!("Failed to delete image file '{}': {}", path, e);
                } else {
                    log::info!("Deleted image file: {}", path);
                }
            }

            return Ok(());
        }

        // Delete items older than keep_days
        // Collect image paths first
        let keep_days_str = format!("-{}", keep_days);
        let image_paths_by_age = collect_image_paths(
            conn,
            "SELECT content FROM clipboard_history
             WHERE created_at < datetime('now', ?1 || ' days')
             AND content_type = 'image'
             AND is_favorite = 0",
            &[&keep_days_str as &dyn rusqlite::ToSql],
        )?;

        let deleted = conn.execute(
            "DELETE FROM clipboard_history
             WHERE created_at < datetime('now', ?1 || ' days')
             AND is_favorite = 0",
            [&keep_days_str as &dyn rusqlite::ToSql],
        )?;

        if deleted > 0 {
            log::info!(
                "Cleaned up {} clipboard items older than {} days",
                deleted,
                keep_days
            );
        }

        // Cleanup image files from age-based deletion
        for path in image_paths_by_age {
            if let Err(e) = std::fs::remove_file(&path) {
                log::warn!("Failed to delete image file '{}': {}", path, e);
            } else {
                log::info!("Deleted image file: {}", path);
            }
        }

        // Also apply max 500 limit as safety
        // Collect image paths first
        let image_paths_by_limit = collect_image_paths(
            conn,
            "SELECT content FROM clipboard_history
             WHERE id NOT IN (
                 SELECT id FROM clipboard_history
                 ORDER BY created_at DESC
                 LIMIT 500
             )
             AND content_type = 'image'
             AND is_favorite = 0",
            &[],
        )?;

        let deleted_max = conn.execute(
            "DELETE FROM clipboard_history
             WHERE id NOT IN (
                 SELECT id FROM clipboard_history
                 ORDER BY created_at DESC
                 LIMIT 500
             )
             AND is_favorite = 0",
            [],
        )?;

        if deleted_max > 0 {
            log::info!("Cleaned up {} clipboard items (max 500 limit)", deleted_max);
        }

        // Cleanup image files from limit-based deletion
        for path in image_paths_by_limit {
            if let Err(e) = std::fs::remove_file(&path) {
                log::warn!("Failed to delete image file '{}': {}", path, e);
            } else {
                log::info!("Deleted image file: {}", path);
            }
        }

        Ok(())
    }

    pub fn stop(&self) -> anyhow::Result<()> {
        if let Ok(mut watcher) = self.watcher.lock() {
            watcher.stop()?;
        }
        Ok(())
    }
}
