use std::sync::Mutex;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

/// Cached pending update — populated by check_for_update, consumed by download_and_install_update.
/// Avoids a second HTTP round-trip when the user confirms the install.
pub struct PendingUpdate(pub Mutex<Option<tauri_plugin_updater::Update>>);

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let app_version = app.package_info().version.clone();
    log::info!("Current app version: {}", app_version);

    let updater = app
        .updater()
        .map_err(|e| format!("Failed to get updater: {}", e))?;

    log::info!("Checking for updates...");

    match updater.check().await {
        Ok(Some(update)) => {
            log::info!("Update available: {} (current: {})", update.version, app_version);

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
pub async fn download_and_install_update(
    app: AppHandle,
    on_progress: tauri::ipc::Channel<DownloadProgress>,
) -> Result<(), String> {
    // Take the cached update — no second HTTP check needed
    let update = {
        let state = app
            .try_state::<PendingUpdate>()
            .ok_or("No pending update state found")?;
        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        guard.take().ok_or("No cached update, please check for updates first")?
    };

    update
        .download_and_install(
            |chunk_length, content_length| {
                let _ = on_progress.send(DownloadProgress::Progress {
                    chunk_length,
                    content_length,
                });
            },
            || {
                let _ = on_progress.send(DownloadProgress::Finished);
            },
        )
        .await
        .map_err(|e| format!("Download/install failed: {}", e))?;

    Ok(())
}

#[derive(serde::Serialize, Clone)]
pub struct UpdateInfo {
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
}

#[derive(serde::Serialize, Clone)]
#[serde(tag = "event", content = "data")]
pub enum DownloadProgress {
    Progress {
        chunk_length: usize,
        content_length: Option<u64>,
    },
    Finished,
}
