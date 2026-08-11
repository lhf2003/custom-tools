use std::sync::Mutex;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;
use url::Url;

/// Cached pending update — populated by check_for_update, consumed by download_and_install_update.
/// Avoids a second HTTP round-trip when the user confirms the install.
pub struct PendingUpdate(pub Mutex<Option<tauri_plugin_updater::Update>>);

/// 构建 updater：每次重新构建并附加「系统代理」配置。
/// 必须用本函数（而非 AppHandle::updater()）——插件注册时构建的 client 是直连的，
/// 不读系统代理；中国网络环境直连 GitHub releases 必失败。开关变更即时生效。
///
/// connect_timeout(8s)：endpoints 按序 fallback（官方 → 镜像）时，官方直连被墙
/// 需快速失败，否则 20s+ 才轮到镜像，检查体验不可接受。
pub fn build_updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    app.updater_builder()
        .configure_client(|builder| {
            crate::http::apply_system_proxy(builder).connect_timeout(Duration::from_secs(8))
        })
        .build()
        .map_err(|e| format!("Failed to get updater: {}", e))
}

/// 关闭系统代理时，把 GitHub 下载 URL 重写为镜像源（纯函数，可单测）。
/// 语义：开代理 → 原样走 GitHub（快且稳）；关代理 → 镜像兜底。
/// 镜像转发 latest.json 内容不变（url 仍是 GitHub 绝对地址），故在 check 成功后、
/// 缓存 PendingUpdate 前重写一次即可，下载与签名校验（基于文件内容）不受影响。
/// 非 github.com 域名原样返回（latest.json 理论上是 GitHub 地址，防御性判断）。
const MIRROR_PREFIX: &str = "https://gh-proxy.com/";

fn mirror_download_url(url: &Url, proxy_enabled: bool) -> Url {
    if proxy_enabled || url.host_str() != Some("github.com") {
        return url.clone();
    }
    Url::parse(&format!("{MIRROR_PREFIX}{url}")).unwrap_or_else(|_| url.clone())
}

/// 统一入口：把 Update 的下载 URL 按代理开关重写为镜像（关代理走 gh-proxy.com），
/// 缓存到 PendingUpdate 供 download_and_install_update 复用，并构造前端展示信息。
/// 命令（关于我们 tab）、托盘菜单、启动自动检查三条路径共用，保证行为一致。
pub fn cache_update(app: &AppHandle, mut update: tauri_plugin_updater::Update) -> UpdateInfo {
    let (proxy_enabled, _) = crate::http::current_proxy_config();
    update.download_url = mirror_download_url(&update.download_url, proxy_enabled);

    // 先 clone 出展示字段再 move 进缓存（update 为插件类型无法不可变重建，就地替换字段）
    let info = UpdateInfo {
        version: update.version.clone(),
        date: update.date.as_ref().map(|d| d.to_string()),
        body: update.body.clone(),
    };

    if let Some(state) = app.try_state::<PendingUpdate>() {
        if let Ok(mut guard) = state.0.lock() {
            *guard = Some(update);
        }
    }

    info
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

            // 重写下载 URL（关代理走镜像）+ 缓存 + 构造展示信息，与启动/托盘路径共用
            let info = cache_update(&app, update);

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

#[cfg(test)]
mod tests {
    use super::*;

    fn github_url() -> Url {
        Url::parse("https://github.com/lhf2003/custom-tools/releases/download/v0.5.4/FlowHub_0.5.4_x64-setup.exe")
            .unwrap()
    }

    #[test]
    fn mirror_keeps_url_when_proxy_enabled() {
        let url = github_url();
        let rewritten = mirror_download_url(&url, true);
        assert_eq!(rewritten, url, "开代理时走 GitHub 直连，不得重写");
    }

    #[test]
    fn mirror_rewrites_github_when_proxy_disabled() {
        let url = github_url();
        let rewritten = mirror_download_url(&url, false);
        assert_eq!(rewritten.host_str(), Some("gh-proxy.com"));
        assert_eq!(
            rewritten.as_str(),
            "https://gh-proxy.com/https://github.com/lhf2003/custom-tools/releases/download/v0.5.4/FlowHub_0.5.4_x64-setup.exe"
        );
    }

    #[test]
    fn mirror_keeps_non_github_url() {
        let url = Url::parse("https://example.com/app-setup.exe").unwrap();
        let rewritten = mirror_download_url(&url, false);
        assert_eq!(rewritten, url, "非 github.com 域名不重写（防御）");
    }

    #[test]
    fn mirror_does_not_double_wrap() {
        // latest.json 理论上是 GitHub 绝对地址，但若已带镜像前缀不应重复嵌套
        let url = Url::parse("https://gh-proxy.com/https://github.com/lhf2003/custom-tools/releases/download/v0.5.4/a.exe")
            .unwrap();
        let rewritten = mirror_download_url(&url, false);
        assert_eq!(rewritten, url);
    }
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
