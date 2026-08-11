use std::sync::Mutex;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

/// Cached pending update — populated by check_for_update, consumed by download_and_install_update.
/// Avoids a second HTTP round-trip when the user confirms the install.
pub struct PendingUpdate(pub Mutex<Option<tauri_plugin_updater::Update>>);

/// 构建 updater：每次重新构建并附加「系统代理」配置。
/// 必须用本函数（而非 AppHandle::updater()）——插件注册时构建的 client 是直连的，
/// 不读系统代理；中国网络环境直连 GitHub releases 必失败。开关变更即时生效。
pub fn build_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    app.updater_builder()
        .configure_client(crate::http::apply_system_proxy)
        .build()
        .map_err(|e| format!("Failed to get updater: {}", e))
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let app_version = app.package_info().version.clone();
    log::info!("Current app version: {}", app_version);

    let updater = build_updater(&app)?;

    log::info!("Checking for updates...");

    match updater.check().await {
        Ok(Some(update)) => {
            log::info!(
                "Update available: {} (current: {})",
                update.version,
                app_version
            );

            // Build the info struct first, borrowing the fields
            let info = UpdateInfo {
                version: update.version.clone(),
                date: update.date.as_ref().map(|d| d.to_string()),
                body: update.body.clone(),
            };

            // Cache the full Update object so download_and_install_update can reuse it
            if let Some(state) = app.try_state::<PendingUpdate>() {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = Some(update);
                }
            }

            Ok(Some(info))
        }
        Ok(None) => {
            log::info!("No update available (current: {})", app_version);
            Ok(None)
        }
        Err(e) => {
            log::error!("Update check failed: {}", e);
            Err(format!("Update check failed: {}", e))
        }
    }
}

#[tauri::command]
pub async fn download_and_install_update(app: AppHandle) -> Result<(), String> {
    use tauri::Emitter;

    // Take the cached update — no second HTTP check needed
    let update = {
        let state = app
            .try_state::<PendingUpdate>()
            .ok_or("No pending update state found")?;
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        guard
            .take()
            .ok_or("No cached update, please check for updates first")?
    };

    log::info!(
        "Starting download: {} (url logged by reqwest on connect)",
        update.version
    );

    let chunk_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let bytes_received = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
    let app_for_chunks = app.clone();
    let app_for_finish = app.clone();
    let chunk_count_chunks = chunk_count.clone();
    let bytes_received_chunks = bytes_received.clone();
    let chunk_count_finish = chunk_count.clone();
    let bytes_received_finish = bytes_received.clone();
    update
        .download_and_install(
            move |chunk_length, content_length| {
                let n =
                    chunk_count_chunks.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
                let bytes =
                    bytes_received_chunks.fetch_add(chunk_length as u64, std::sync::atomic::Ordering::Relaxed)
                        + chunk_length as u64;
                if n == 1 || n % 500 == 0 {
                    log::info!(
                        "[download] chunk #{n}, +{chunk_length}B, total {bytes}B, content_length {content_length:?}"
                    );
                }
                // emit 事件流（替代 Channel——后者在 WebView2 透明窗口下投递被静默吞）
                let _ = app_for_chunks.emit(
                    "update-download-progress",
                    DownloadProgress::Progress {
                        chunk_length,
                        content_length,
                    },
                );
            },
            move || {
                log::info!(
                    "[download] finished: {} chunks, {} bytes",
                    chunk_count_finish.load(std::sync::atomic::Ordering::Relaxed),
                    bytes_received_finish.load(std::sync::atomic::Ordering::Relaxed)
                );
                let _ = app_for_finish.emit("update-download-progress", DownloadProgress::Finished);
            },
        )
        .await
        .map_err(|e| {
            log::error!(
                "[download] failed after {} chunks / {} bytes: {}",
                chunk_count.load(std::sync::atomic::Ordering::Relaxed),
                bytes_received.load(std::sync::atomic::Ordering::Relaxed),
                e
            );
            format!("Download/install failed: {}", e)
        })?;

    Ok(())
}

#[derive(serde::Serialize, Clone)]
pub struct UpdateInfo {
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
}

/// Emitted to the frontend when a manual update check finishes without an
/// available update, so the result is shown in the in-app UI instead of a
/// Windows system notification.
#[derive(serde::Serialize, Clone)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UpdateCheckResult {
    Latest,
    Failed,
}

#[derive(serde::Serialize, Clone)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum DownloadProgress {
    Progress {
        chunk_length: usize,
        content_length: Option<u64>,
    },
    Finished,
}
