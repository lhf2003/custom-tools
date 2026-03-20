use crate::db::app_usage;
use crate::db::DatabaseState;
use crate::search::{everything, icon, AppItem, SearchIndex};
use rusqlite::Connection;
use std::sync::{Arc, Mutex};

pub struct SearchState(pub Arc<Mutex<SearchIndex>>);

fn get_db_conn(db_state: &tauri::State<'_, DatabaseState>) -> Result<Connection, String> {
    Connection::open(&db_state.0).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn index_apps(state: tauri::State<'_, SearchState>) -> Result<(), String> {
    let mut index = state.0.lock().map_err(|e| e.to_string())?;
    index.index_apps().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_apps(
    query: String,
    state: tauri::State<'_, SearchState>,
    db_state: tauri::State<'_, DatabaseState>,
) -> Result<Vec<AppItem>, String> {
    let index = state.0.lock().map_err(|e| e.to_string())?;
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
    let mut index = state.0.lock().map_err(|e| e.to_string())?;
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
    limit: usize,
    db_state: tauri::State<'_, DatabaseState>,
    state: tauri::State<'_, SearchState>,
) -> Result<Vec<AppItem>, String> {
    let index = state.0.lock().map_err(|e| e.to_string())?;
    let conn = get_db_conn(&db_state)?;

    let usages = app_usage::get_recently_used(&conn, limit).map_err(|e| e.to_string())?;

    // Map usage records back to AppItems
    let usage_paths: std::collections::HashSet<&str> =
        usages.iter().map(|u| u.path.as_str()).collect();

    // Get all apps and filter by usage
    let all_apps = index.get_all();
    let mut recent_apps: Vec<AppItem> = all_apps
        .into_iter()
        .filter(|app| usage_paths.contains(app.path.as_str()))
        .collect();

    // Sort by last_launch time (from usage records)
    recent_apps.sort_by(|a, b| {
        let a_time = usages
            .iter()
            .find(|u| u.path == a.path)
            .and_then(|u| u.last_launch)
            .unwrap_or(0);
        let b_time = usages
            .iter()
            .find(|u| u.path == b.path)
            .and_then(|u| u.last_launch)
            .unwrap_or(0);
        b_time.cmp(&a_time) // Descending
    });

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

#[tauri::command]
pub async fn get_everything_version() -> Option<String> {
    tokio::task::spawn_blocking(everything::get_version)
        .await
        .unwrap_or(None)
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

    let install_dir = everything::bundled_install_dir()
        .ok_or("无法确定应用安装目录")?;

    std::fs::create_dir_all(&install_dir)
        .map_err(|e| format!("创建目录失败: {}", e))?;

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
             \"$dest\\ev_tmp.zip\" $dest \"$dest\\Everything.exe\"\n"
        );
    }

    if install_es {
        script.push_str(
            "Fetch-AndExtract \
             'https://www.voidtools.com/ES-1.1.0.36.x64.zip' \
             \"$dest\\es_tmp.zip\" $dest \"$dest\\es.exe\"\n"
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
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script])
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
        log::warn!("Failed to open file with open crate: {}, trying fallback", e);
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
