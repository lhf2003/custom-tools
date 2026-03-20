use std::path::PathBuf;
use std::process::Command;

/// File search result from Everything
#[derive(Debug, Clone, serde::Serialize)]
pub struct FileResult {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified: u64,
}

/// Everything availability status
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EverythingStatus {
    /// es.exe not found
    NotInstalled,
    /// es.exe found but Everything service is not running
    ServiceNotRunning,
    /// Everything is available and service is responding
    Available,
}

/// Find es.exe: checks app's own Everything directory first, then system-wide paths.
/// Called fresh each time so newly installed files are detected immediately.
fn find_es_exe() -> Option<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();

    // Highest priority: app's bundled Everything directory (next to the executable)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            paths.push(dir.join("Everything").join("es.exe"));
        }
    }

    // System-wide installation paths
    paths.extend([
        PathBuf::from(r"C:\Program Files\Everything\es.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Everything\es.exe"),
        PathBuf::from(r"D:\Everything\es.exe"),
        PathBuf::from(r"E:\Everything\es.exe"),
        PathBuf::from(r"F:\Everything\es.exe"),
    ]);

    for path in &paths {
        if path.exists() {
            log::info!("Found es.exe at: {}", path.display());
            return Some(path.clone());
        }
    }

    log::warn!("es.exe not found");
    None
}

/// Returns the target directory for the bundled Everything installation.
pub fn bundled_install_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join("Everything"))
}

/// Check if es.exe exists (does not verify the service is running).
pub fn is_available() -> bool {
    find_es_exe().is_some()
}

/// Check Everything status including whether the IPC service is responding.
pub fn check_status() -> EverythingStatus {
    let es_path = match find_es_exe() {
        Some(p) => p,
        None => return EverythingStatus::NotInstalled,
    };

    // es.exe exits with code 0 when the service is running (even with no results),
    // and non-zero when it cannot connect to the Everything IPC service.
    let output = Command::new(&es_path).args(["-n", "1", "*"]).output();

    match output {
        Ok(out) if out.status.success() => EverythingStatus::Available,
        _ => EverythingStatus::ServiceNotRunning,
    }
}

/// Search files using Everything CLI.
pub fn search_files(query: &str, limit: usize) -> Vec<FileResult> {
    let es_path = match find_es_exe() {
        Some(p) => p,
        None => return Vec::new(),
    };

    // Empty query → wildcard to show recent files
    let search_query = if query.trim().is_empty() { "*" } else { query.trim() };

    log::info!("Everything search query: '{}'", search_query);

    let mut cmd = Command::new(&es_path);
    cmd.arg("-n").arg(limit.to_string());

    // Split by whitespace so "app ext:xls;xlsx" becomes two separate args (AND logic)
    for part in search_query.split_whitespace() {
        cmd.arg(part);
    }

    // Always exclude shortcuts and executables (handled by app launcher instead)
    cmd.arg("!ext:lnk").arg("!ext:exe");

    let output = match cmd.output() {
        Ok(o) => o,
        Err(e) => {
            log::warn!("Failed to execute es.exe: {}", e);
            return Vec::new();
        }
    };

    if !output.status.success() {
        log::warn!("es.exe returned error: {}", String::from_utf8_lossy(&output.stderr));
        return Vec::new();
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let results = parse_results(&stdout);
    log::info!("Everything found {} results", results.len());
    results
}

/// Parse es.exe output (one path per line) into FileResult structs.
fn parse_results(output: &str) -> Vec<FileResult> {
    output
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let path = PathBuf::from(line.trim());
            let name = path.file_name()?.to_string_lossy().to_string();

            let (size, modified) = std::fs::metadata(&path)
                .map(|m| {
                    let size = m.len();
                    let modified = m
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    (size, modified)
                })
                .unwrap_or((0, 0));

            Some(FileResult { name, path: line.trim().to_string(), size, modified })
        })
        .collect()
}

/// Get Everything version string via es.exe.
pub fn get_version() -> Option<String> {
    let es_path = find_es_exe()?;
    let output = Command::new(&es_path).arg("-version").output().ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
}
