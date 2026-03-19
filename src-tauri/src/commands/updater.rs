use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    use tauri::Manager;

    let app_version = app.package_info().version.clone();
    log::info!("Current app version: {}", app_version);

    let updater = app
        .updater()
        .map_err(|e| format!("Failed to get updater: {}", e))?;

    log::info!("Checking for updates...");

    match updater.check().await {
        Ok(Some(update)) => {
            log::info!("Update available: {} (current: {})", update.version, app_version);
            Ok(Some(UpdateInfo {
                version: update.version,
                date: update.date.map(|d| d.to_string()),
                body: update.body,
            }))
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
    let updater = app
        .updater()
        .map_err(|e| format!("Failed to get updater: {}", e))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("Update check failed: {}", e))?
        .ok_or("No update available")?;

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
