//! Scan Windows registry for installed applications.
//! Reads HKLM + HKCU Uninstall keys to find apps that don't have Start Menu shortcuts.

#[cfg(windows)]
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
#[cfg(windows)]
use winreg::RegKey;

#[derive(Debug, Clone)]
pub struct RegistryApp {
    pub name: String,
    /// Absolute path to the main executable (from DisplayIcon or resolved from InstallLocation)
    pub exe_path: String,
}

/// Scan all three Uninstall hives and return deduplicated app list.
#[cfg(windows)]
pub fn scan() -> Vec<RegistryApp> {
    let mut apps = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let hives: &[(_, &str)] = &[
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        (HKEY_CURRENT_USER,  r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
    ];

    for (root, path) in hives {
        let hive = match RegKey::predef(*root).open_subkey_with_flags(path, KEY_READ) {
            Ok(k) => k,
            Err(_) => continue,
        };

        for subkey_name in hive.enum_keys().flatten() {
            let subkey = match hive.open_subkey_with_flags(&subkey_name, KEY_READ) {
                Ok(k) => k,
                Err(e) => { log::debug!("Registry: skip subkey {}: {}", subkey_name, e); continue; }
            };

            let name: String = match subkey.get_value("DisplayName") {
                Ok(n) => n,
                Err(_) => continue, // no display name → skip
            };

            let name = name.trim().to_string();
            if name.is_empty() || is_system_component(&subkey) {
                continue;
            }

            let exe_path = match resolve_exe_path(&subkey) {
                Some(p) => p,
                None => continue, // can't find executable → skip
            };

            // Dedup by lowercase name
            let key = name.to_lowercase();
            if seen.insert(key) {
                apps.push(RegistryApp { name, exe_path });
            }
        }
    }

    apps
}

#[cfg(not(windows))]
pub fn scan() -> Vec<RegistryApp> {
    Vec::new()
}

/// Returns true for Windows system entries that should not appear in search results.
#[cfg(windows)]
fn is_system_component(key: &RegKey) -> bool {
    let is_sys: u32 = key.get_value("SystemComponent").unwrap_or(0);
    let release_type: String = key.get_value("ReleaseType").unwrap_or_default();
    is_sys != 0
        || release_type == "Update"
        || release_type == "Hotfix"
}

/// Try to extract an absolute exe path.
/// Priority: DisplayIcon → InstallLocation main exe → InstallLocation itself.
#[cfg(windows)]
fn resolve_exe_path(key: &RegKey) -> Option<String> {
    // DisplayIcon is usually "C:\path\app.exe" or "C:\path\app.exe,0"
    if let Ok(icon) = key.get_value::<String, _>("DisplayIcon") {
        let icon = icon.trim().trim_matches('"');
        // Strip ",N" icon-index suffix
        let icon = if let Some(pos) = icon.rfind(',') {
            let suffix = &icon[pos + 1..];
            if suffix.chars().all(|c| c.is_ascii_digit() || c == '-') {
                &icon[..pos]
            } else {
                icon
            }
        } else {
            icon
        };
        let icon = icon.trim().trim_matches('"').to_string();
        if icon.to_lowercase().ends_with(".exe") && std::path::Path::new(&icon).exists() {
            return Some(icon);
        }
    }

    // Fallback: look for a single .exe in InstallLocation
    if let Ok(location) = key.get_value::<String, _>("InstallLocation") {
        let location = location.trim().trim_matches('"').to_string();
        if location.is_empty() {
            return None;
        }
        let dir = std::path::Path::new(&location);
        if let Ok(entries) = std::fs::read_dir(dir) {
            let exes: Vec<_> = entries
                .flatten()
                .filter(|e| {
                    e.path()
                        .extension()
                        .map(|ext| ext.eq_ignore_ascii_case("exe"))
                        .unwrap_or(false)
                })
                .collect();
            if exes.len() == 1 {
                if let Some(p) = exes[0].path().to_str() {
                    return Some(p.to_string());
                }
            }
        }
    }

    None
}
