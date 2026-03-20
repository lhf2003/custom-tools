use std::path::PathBuf;
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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

/// Create a Command with CREATE_NO_WINDOW on Windows to suppress console flash.
fn make_cmd(path: &PathBuf) -> Command {
    let mut cmd = Command::new(path);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
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
    let output = make_cmd(&es_path).args(["-n", "1", "*"]).output();

    match output {
        Ok(out) if out.status.success() => EverythingStatus::Available,
        _ => EverythingStatus::ServiceNotRunning,
    }
}

/// Search files using Everything CLI.
/// Uses -csv -size -date-modified to read size and mtime from the Everything
/// index directly, avoiding per-file fs::metadata calls.
pub fn search_files(query: &str, limit: usize) -> Vec<FileResult> {
    let es_path = match find_es_exe() {
        Some(p) => p,
        None => return Vec::new(),
    };

    // Empty query → wildcard to show recent files
    let search_query = if query.trim().is_empty() { "*" } else { query.trim() };

    log::info!("Everything search query: '{}'", search_query);

    let mut cmd = make_cmd(&es_path);
    cmd.arg("-n").arg(limit.to_string())
       .arg("-csv")
       .arg("-size")
       .arg("-date-modified");

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
    let results = parse_csv_results(&stdout);
    log::info!("Everything found {} results", results.len());
    results
}

/// Parse es.exe CSV output (with -csv -size -date-modified).
/// First line is the header row and is skipped.
fn parse_csv_results(output: &str) -> Vec<FileResult> {
    let mut lines = output.lines();
    lines.next(); // skip header: "Filename","Size","Date Modified"

    lines
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| parse_csv_line(line))
        .collect()
}

fn parse_csv_line(line: &str) -> Option<FileResult> {
    let fields = split_csv_fields(line);
    if fields.len() < 3 {
        return None;
    }

    let path_str = fields[0].trim().to_string();
    if path_str.is_empty() {
        return None;
    }

    let path = PathBuf::from(&path_str);
    let name = path.file_name()?.to_string_lossy().to_string();
    let size = fields[1].trim().parse::<u64>().unwrap_or(0);
    let modified = parse_date_to_unix(fields[2].trim());

    Some(FileResult { name, path: path_str, size, modified })
}

/// Split a CSV line respecting double-quoted fields (RFC 4180).
fn split_csv_fields(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = line.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            '"' => {
                if in_quotes && chars.peek() == Some(&'"') {
                    // Escaped double-quote inside quoted field
                    chars.next();
                    current.push('"');
                } else {
                    in_quotes = !in_quotes;
                }
            }
            ',' if !in_quotes => {
                fields.push(std::mem::take(&mut current));
            }
            _ => current.push(c),
        }
    }
    fields.push(current);
    fields
}

/// Parse es.exe date string to Unix timestamp.
/// Tries common date formats used by es.exe across different Windows locales.
fn parse_date_to_unix(date_str: &str) -> u64 {
    use chrono::NaiveDateTime;

    let formats = [
        "%m/%d/%Y %H:%M:%S",   // US: 01/15/2024 10:30:25
        "%Y/%m/%d %H:%M:%S",   // CN: 2024/01/15 10:30:25
        "%Y-%m-%d %H:%M:%S",   // ISO: 2024-01-15 10:30:25
        "%d/%m/%Y %H:%M:%S",   // EU: 15/01/2024 10:30:25
    ];

    for fmt in formats {
        if let Ok(dt) = NaiveDateTime::parse_from_str(date_str, fmt) {
            return dt.and_utc().timestamp().max(0) as u64;
        }
    }
    0
}

/// Get Everything version string via es.exe.
pub fn get_version() -> Option<String> {
    let es_path = find_es_exe()?;
    let output = make_cmd(&es_path).arg("-version").output().ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
}
