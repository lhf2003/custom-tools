use std::path::{Path, PathBuf};
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
    pub is_dir: bool,
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

/// Decode es.exe output. es.exe writes stdout/stderr in the system ANSI code
/// page (GBK on Chinese Windows), not UTF-8 — decoding it as UTF-8 garbles
/// Chinese filenames into replacement/mojibake text. Try strict UTF-8 first
/// (pure-ASCII output passes through unchanged), then fall back to GBK.
fn decode_es_output(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            let (cow, _, _) = encoding_rs::GBK.decode(bytes);
            cow.into_owned()
        }
    }
}

/// 默认排除的系统目录前缀（这些目录几乎全是系统内部/临时文件，
/// 普通文件搜索场景下只会产生噪音，如 WinSxS 组件存储、Windows Update
/// 下载缓存）。前缀以反斜杠结尾，保证按目录边界精确匹配。
const EXCLUDED_PATH_PREFIXES: &[&str] = &[
    r"C:\Windows\WinSxS\",
    r"C:\Windows\Temp\",
    r"C:\Windows\SoftwareDistribution\Download\",
];

/// Windows 路径大小写不敏感；用 `get(..n)` 保证切在 char 边界上，避免
/// 非 ASCII 路径前缀切到多字节字符中间而 panic。
fn path_has_prefix(path: &str, prefix: &str) -> bool {
    path.get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
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
    let search_query = if query.trim().is_empty() {
        "*"
    } else {
        query.trim()
    };

    log::info!("Everything search query: '{}'", search_query);

    let mut cmd = make_cmd(&es_path);
    cmd.arg("-n")
        .arg(limit.to_string())
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
        log::warn!(
            "es.exe returned error: {}",
            decode_es_output(&output.stderr)
        );
        return Vec::new();
    }

    let stdout = decode_es_output(&output.stdout);
    let mut results = parse_csv_results(&stdout);
    // 过滤系统噪音目录（WinSxS / 系统临时 / 更新缓存）
    let before = results.len();
    results.retain(|r| !EXCLUDED_PATH_PREFIXES.iter().any(|p| path_has_prefix(&r.path, p)));
    if results.len() != before {
        log::info!(
            "Everything filtered {} system-noise results ({} -> {})",
            before - results.len(),
            before,
            results.len()
        );
    }
    results
}

/// Parse es.exe CSV output (with -csv -size -date-modified).
/// First line is the header row and is skipped.
fn parse_csv_results(output: &str) -> Vec<FileResult> {
    let mut lines = output.lines();
    lines.next(); // skip header: "Filename","Size","Date Modified"

    lines
        .filter(|line| !line.trim().is_empty())
        .filter_map(parse_csv_line)
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
    // One stat per result (≤100) to distinguish folders from files — drives the
    // folder icon and the "open containing folder vs open the folder itself"
    // behaviour. Size/mtime still come from the index; this is the only metadata
    // Everything's CSV does not expose directly.
    let is_dir = Path::new(&path_str).is_dir();

    Some(FileResult {
        name,
        path: path_str,
        size,
        modified,
        is_dir,
    })
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
        "%m/%d/%Y %H:%M:%S", // US: 01/15/2024 10:30:25
        "%Y/%m/%d %H:%M:%S", // CN: 2024/01/15 10:30:25
        "%Y-%m-%d %H:%M:%S", // ISO: 2024-01-15 10:30:25
        "%d/%m/%Y %H:%M:%S", // EU: 15/01/2024 10:30:25
    ];

    for fmt in formats {
        if let Ok(dt) = NaiveDateTime::parse_from_str(date_str, fmt) {
            return dt.and_utc().timestamp().max(0) as u64;
        }
    }
    0
}
