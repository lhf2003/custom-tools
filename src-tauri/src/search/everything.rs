use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

/// Everything CLI path cache
static ES_EXE_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

/// File search result from Everything
#[derive(Debug, Clone, serde::Serialize)]
pub struct FileResult {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified: u64,
}

/// Check if Everything is installed and available
pub fn is_available() -> bool {
    ES_EXE_PATH
        .get_or_init(|| find_es_exe())
        .is_some()
}

/// Find es.exe in common locations
fn find_es_exe() -> Option<PathBuf> {
    // Common installation paths - only check fixed paths for performance
    let possible_paths = [
        r"C:\Program Files\Everything\es.exe",
        r"C:\Program Files (x86)\Everything\es.exe",
        r"D:\Everything\es.exe",
        r"E:\Everything\es.exe",
        r"F:\Everything\es.exe",
    ];

    for path in &possible_paths {
        let pb = PathBuf::from(path);
        if pb.exists() {
            log::info!("Found es.exe at: {}", pb.display());
            return Some(pb);
        }
    }

    log::warn!("es.exe not found in common locations: {:?}", possible_paths);
    None
}

/// Search files using Everything CLI
pub fn search_files(query: &str, limit: usize) -> Vec<FileResult> {
    let es_path = match ES_EXE_PATH.get_or_init(find_es_exe).as_ref() {
        Some(path) => path,
        None => return Vec::new(),
    };

    // Build search query
    // If query is empty, search for all files (use * wildcard)
    let search_query = if query.trim().is_empty() {
        "*"
    } else {
        query.trim()
    };

    log::info!("Everything search query: '{}'", search_query);

    // Build command: es.exe -n 20 query terms... !ext:lnk !ext:exe
    // -n: limit results
    // Multiple arguments are AND-ed together by Everything
    // Exclude .lnk and .exe files to avoid conflict with app search
    //
    // IMPORTANT: Do NOT use -s with space-separated query.
    // "app ext:xls;xlsx" becomes literal match "app ext:xls;xlsx" (not AND logic)
    // Instead, pass each part as separate arg: es.exe app "ext:xls;xlsx;csv"
    let mut cmd = Command::new(es_path);
    cmd.arg("-n").arg(&limit.to_string());

    // Split query by spaces and add as separate arguments
    // This ensures "app ext:xls;xlsx;csv" becomes two args: "app" and "ext:xls;xlsx;csv"
    for part in search_query.split_whitespace() {
        cmd.arg(part);
    }

    // Always exclude .lnk and .exe
    cmd.arg("!ext:lnk").arg("!ext:exe");

    let output = match cmd.output()
    {
        Ok(output) => output,
        Err(e) => {
            log::warn!("Failed to execute es.exe: {}", e);
            return Vec::new();
        }
    };

    if !output.status.success() {
        log::warn!("es.exe returned error: {}", String::from_utf8_lossy(&output.stderr));
        return Vec::new();
    }

    // Parse output (one path per line)
    let stdout = String::from_utf8_lossy(&output.stdout);
    let results = parse_results(&stdout);
    log::info!("Everything found {} results", results.len());
    results
}

/// Parse es.exe output into FileResult structs
fn parse_results(output: &str) -> Vec<FileResult> {
    output
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let path = PathBuf::from(line.trim());
            let name = path.file_name()?.to_string_lossy().to_string();

            // Get file metadata if possible
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

            Some(FileResult {
                name,
                path: line.trim().to_string(),
                size,
                modified,
            })
        })
        .collect()
}

/// Get Everything version
pub fn get_version() -> Option<String> {
    let es_path = ES_EXE_PATH.get_or_init(find_es_exe).as_ref()?;

    let output = Command::new(es_path)
        .arg("-version")
        .output()
        .ok()?;

    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
}

/// Check if Everything service is running
pub fn is_service_running() -> bool {
    // Try to search for a test file to verify service is running
    let results = search_files("test", 1);
    !results.is_empty() || is_available()
}

/// Format file size for display
pub fn format_size(size: u64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
    if size == 0 {
        return "0 B".to_string();
    }

    let size_f = size as f64;
    let unit_idx = (size_f.log10() / 1024_f64.log10()) as usize;
    let unit_idx = unit_idx.min(UNITS.len() - 1);

    let size_in_unit = size_f / 1024_f64.powi(unit_idx as i32);
    format!("{:.1} {}", size_in_unit, UNITS[unit_idx])
}

/// Format timestamp for display
pub fn format_time(timestamp: u64) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let diff = now.saturating_sub(timestamp);

    if diff < 60 {
        "just now".to_string()
    } else if diff < 3600 {
        format!("{} min ago", diff / 60)
    } else if diff < 86400 {
        format!("{} hours ago", diff / 3600)
    } else if diff < 604800 {
        format!("{} days ago", diff / 86400)
    } else {
        let datetime = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(timestamp);
        let date: chrono::DateTime<chrono::Local> = datetime.into();
        date.format("%Y-%m-%d").to_string()
    }
}
