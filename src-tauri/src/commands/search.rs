use crate::db::app_usage;
use crate::db::DatabaseState;
use crate::search::{everything, icon, AppItem, SearchIndex};
use rusqlite::Connection;
use std::path::Path;
use std::sync::{Arc, Mutex};

pub struct SearchState(pub Arc<Mutex<SearchIndex>>);

/// 唤起时校验应用索引的有效性（窗口显示后由 emit_window_shown 触发）：
/// 文件类条目检查存在性（毫秒级），UWP 条目按 10 分钟间隔重扫 Get-StartApps
/// 做 diff——卸载的 Store 应用在下次唤起时即消失，不再依赖 24h 全量扫描。
/// 后台线程执行：PowerShell 重扫可达秒级，不能阻塞窗口显示或搜索。
/// 设计：锁内快照 → 锁外校验 → 锁内移除，锁内只做微秒级操作。
pub fn verify_app_index(state: SearchState) {
    std::thread::spawn(move || {
        // 1. 锁内快照 + UWP 重扫周期判定（微秒级）
        let (snapshot, uwp_rescan) = match state.0.lock() {
            Ok(mut idx) => (idx.get_all(), idx.uwp_verify_due()),
            Err(e) => {
                log::error!("Search index lock poisoned in verify: {}", e);
                return;
            }
        };
        if snapshot.is_empty() {
            return;
        }

        // 2. 锁外校验（文件 stat + 可能的 PowerShell 重扫，毫秒~秒级）
        let stale = SearchIndex::verify_apps_on_disk(&snapshot, uwp_rescan);
        if stale.is_empty() {
            return;
        }

        // 3. 锁内移除（微秒级）
        let mut idx = match state.0.lock() {
            Ok(g) => g,
            Err(e) => {
                log::error!("Search index lock poisoned in verify: {}", e);
                return;
            }
        };
        for p in &stale {
            if let Err(e) = idx.remove_app(Path::new(p)) {
                log::warn!("Failed to remove stale app {}: {}", p, e);
                continue;
            }
            // 连带清理使用记录：已删除应用留在 app_usage 会让"最近使用"
            // 区继续展示它（回车启动失败），且持续污染排序
            let db_conn = idx.db_connection();
            if let Some(conn) = db_conn {
                if let Err(e) = app_usage::delete_by_path(&conn, p) {
                    log::warn!("Failed to delete usage record for {}: {}", p, e);
                }
            }
        }
        log::info!(
            "App index verification removed {} stale entries",
            stale.len()
        );
    });
}

fn get_db_conn(db_state: &tauri::State<'_, DatabaseState>) -> Result<Connection, String> {
    Connection::open(&db_state.0).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_apps(
    query: String,
    state: tauri::State<'_, SearchState>,
    db_state: tauri::State<'_, DatabaseState>,
) -> Result<Vec<AppItem>, String> {
    // try_lock:首次全量索引在后台线程执行,持锁期间这里若用 lock() 会把
    // 主线程(sync command)一起卡死。索引忙时降级返回空结果,前端表现为
    // 暂时无搜索结果,UI 不受影响。
    let index = match state.0.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            log::debug!("Search index busy (initial indexing in progress), returning empty");
            return Ok(Vec::new());
        }
    };
    let conn = get_db_conn(&db_state)?;

    // Get all usage stats
    let usages = app_usage::get_all_usage(&conn).map_err(|e| e.to_string())?;

    let results = if query.is_empty() {
        // Return apps sorted by recency/frequency
        index.get_recently_used(&usages)
    } else {
        // Search with frequency-based ranking
        index.search_with_frequency(&query, &usages)
    };

    // Record search for each result (only for non-empty queries)
    // This helps build usage patterns for better ranking
    if !query.is_empty() {
        // Record first 5 results as relevant to this search
        for app in results.iter().take(5) {
            if let Err(e) = app_usage::record_search(&conn, &app.path, &app.name) {
                log::warn!("Failed to record search for {}: {}", app.name, e);
            }
        }
    }

    Ok(results)
}

#[tauri::command]
pub fn refresh_apps(state: tauri::State<'_, SearchState>) -> Result<(), String> {
    let mut index = match state.0.try_lock() {
        Ok(guard) => guard,
        Err(_) => return Err("索引正在后台更新中,请稍后重试".to_string()),
    };
    index.refresh().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn launch_app(
    path: String,
    name: String,
    db_state: tauri::State<'_, DatabaseState>,
) -> Result<(), String> {
    // Record launch in database
    let conn = get_db_conn(&db_state)?;
    app_usage::record_launch(&conn, &path, &name).map_err(|e| e.to_string())?;

    // Launch the app
    crate::search::launch_app(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn record_app_usage(
    path: String,
    name: String,
    db_state: tauri::State<'_, DatabaseState>,
) -> Result<(), String> {
    // Record usage in database (for built-in tools that don't go through launch_app)
    let conn = get_db_conn(&db_state)?;
    app_usage::record_launch(&conn, &path, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_recent_apps(
    limit: Option<usize>,
    db_state: tauri::State<'_, DatabaseState>,
    state: tauri::State<'_, SearchState>,
) -> Result<Vec<AppItem>, String> {
    // 同 search_apps:索引持锁期间降级返回空,不阻塞主线程
    let index = match state.0.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            log::debug!("Search index busy (initial indexing in progress), returning empty");
            return Ok(Vec::new());
        }
    };
    let conn = get_db_conn(&db_state)?;

    // usages 已按 last_launch DESC 排好序，直接按此顺序输出
    let usages = app_usage::get_recently_used(&conn, limit).map_err(|e| e.to_string())?;

    // 索引内应用 path → AppItem，用于过滤已卸载的外部应用
    let indexed: std::collections::HashMap<String, AppItem> = index
        .get_all()
        .into_iter()
        .map(|app| (app.path.clone(), app))
        .collect();

    let recent_apps: Vec<AppItem> = usages
        .into_iter()
        .filter_map(|u| {
            // 内置工具不在应用索引中，直接放行（不存在"已卸载"）
            if u.path.starts_with("builtin://") {
                return Some(AppItem {
                    name: u.name,
                    path: u.path,
                    icon: None,
                    pinyin_initials: String::new(),
                });
            }
            indexed.get(&u.path).cloned()
        })
        .collect();

    Ok(recent_apps)
}

#[tauri::command]
pub async fn extract_app_icon(path: String) -> Result<Option<String>, String> {
    icon::extract_icon(&path).map_err(|e| e.to_string())
}

// Everything integration commands

#[tauri::command]
pub async fn is_everything_available() -> everything::EverythingStatus {
    tokio::task::spawn_blocking(everything::check_status)
        .await
        .unwrap_or(everything::EverythingStatus::NotInstalled)
}

#[tauri::command]
pub async fn search_everything(query: String, limit: usize) -> Vec<everything::FileResult> {
    tokio::task::spawn_blocking(move || everything::search_files(&query, limit))
        .await
        .unwrap_or_default()
}

/// Download and install Everything client and/or es.exe into the app's own
/// `<exe_dir>/Everything/` directory using a PowerShell script.
///
/// Stable download URLs (voidtools.com). Update versions when new builds are released:
///   Everything portable x64: 1.4.1.1032
///   ES CLI x64:              1.1.0.36
#[tauri::command]
pub async fn install_everything(install_client: bool, install_es: bool) -> Result<(), String> {
    if !install_client && !install_es {
        return Ok(());
    }

    let install_dir = everything::bundled_install_dir().ok_or("无法确定应用安装目录")?;

    std::fs::create_dir_all(&install_dir).map_err(|e| format!("创建目录失败: {}", e))?;

    // Escape single quotes in the path for PowerShell single-quoted strings
    let dest = install_dir.to_string_lossy().replace('\'', "''");

    // Script header: set $dest variable (requires Rust format! for interpolation)
    let mut script = format!(
        "$ErrorActionPreference = 'Stop'\n\
         $ProgressPreference = 'SilentlyContinue'\n\
         $dest = '{}'\n\
         New-Item -ItemType Directory -Force -Path $dest | Out-Null\n",
        dest
    );

    // Helper function: download → validate ZIP magic bytes → extract → verify binary.
    // Uses raw string to avoid backslash/brace escaping issues.
    // $dest is passed as parameter $d to avoid PowerShell scope lookup surprises.
    script.push_str(r#"
$h = @{ 'User-Agent' = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }

function Fetch-AndExtract($url, $tmp, $d, $expect) {
    Write-Output "Downloading $url ..."
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -Headers $h
    # Validate ZIP magic bytes (PK = 0x50 0x4B); catch HTML-instead-of-ZIP silently
    $bytes = [System.IO.File]::ReadAllBytes($tmp)
    if ($bytes.Length -lt 4 -or $bytes[0] -ne 0x50 -or $bytes[1] -ne 0x4B) {
        $preview = [System.Text.Encoding]::UTF8.GetString($bytes[0..[Math]::Min(199, $bytes.Length - 1)])
        Remove-Item $tmp -ErrorAction SilentlyContinue
        throw "下载内容不是有效的 ZIP 文件（可能是服务器错误页面）: $preview"
    }
    Write-Output "Extracting to $d ..."
    Expand-Archive -Path $tmp -DestinationPath $d -Force
    Remove-Item $tmp -ErrorAction SilentlyContinue
    if (-not (Test-Path $expect)) {
        throw "解压完成但未找到预期文件: $expect"
    }
    Write-Output "OK: $expect"
}
"#);

    if install_client {
        script.push_str(
            "Fetch-AndExtract \
             'https://www.voidtools.com/Everything-1.4.1.1032.x64.zip' \
             \"$dest\\ev_tmp.zip\" $dest \"$dest\\Everything.exe\"\n",
        );
    }

    if install_es {
        script.push_str(
            "Fetch-AndExtract \
             'https://www.voidtools.com/ES-1.1.0.36.x64.zip' \
             \"$dest\\es_tmp.zip\" $dest \"$dest\\es.exe\"\n",
        );
    }

    if install_client {
        script.push_str(r#"if (Test-Path "$dest\Everything.exe") {
    Start-Process -FilePath "$dest\Everything.exe" -ArgumentList '-startup','-no-setup-wizard' -WindowStyle Hidden
}
"#);
    }

    tokio::task::spawn_blocking(move || {
        let output = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &script,
            ])
            .output()
            .map_err(|e| format!("无法启动 PowerShell: {}", e))?;

        if output.status.success() {
            Ok(())
        } else {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(format!("{}{}", stdout, stderr).trim().to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn open_file(path: String) -> Result<(), String> {
    // Open file with default application
    if let Err(e) = open::that(&path) {
        log::warn!(
            "Failed to open file with open crate: {}, trying fallback",
            e
        );
        // Fallback to Windows start command
        #[cfg(windows)]
        {
            std::process::Command::new("cmd")
                .args(["/c", "start", "", &path])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(not(windows))]
        {
            return Err("Opening files is only supported on Windows".to_string());
        }
    }
    Ok(())
}
