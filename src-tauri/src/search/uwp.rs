//! Enumerate UWP (Microsoft Store) applications via PowerShell Get-StartApps.
//! UWP apps are launched with: explorer.exe "shell:AppsFolder\<AppID>"

use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone)]
pub struct UwpApp {
    pub name: String,
    /// AppUserModelID, e.g. "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"
    pub app_id: String,
}

/// Launch path for a UWP app — pass this to `launch_app()`.
pub fn launch_path(app_id: &str) -> String {
    format!("shell:AppsFolder\\{}", app_id)
}

/// Enumerate installed UWP apps using Get-StartApps.
/// Only returns entries whose AppID contains '!' (UWP package format).
#[cfg(windows)]
pub fn scan() -> Vec<UwpApp> {
    let output = run_powershell(
        "Get-StartApps | Where-Object { $_.AppID -like '*!*' } | \
         Select-Object Name, AppID | ConvertTo-Json -Compress"
    );

    match output {
        Some(json) => parse_json(&json),
        None => Vec::new(),
    }
}

#[cfg(not(windows))]
pub fn scan() -> Vec<UwpApp> {
    Vec::new()
}

fn run_powershell(script: &str) -> Option<String> {
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().ok()?;
    if output.status.success() {
        let result = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if result.is_empty() {
            log::debug!("Get-StartApps returned empty output");
            return None;
        }
        Some(result)
    } else {
        log::warn!(
            "Get-StartApps failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        None
    }
}

fn parse_json(json: &str) -> Vec<UwpApp> {
    // Handle both array and single-object responses
    let arr: Vec<serde_json::Value> = if json.starts_with('[') {
        serde_json::from_str(json).unwrap_or_else(|e| {
            log::warn!("Failed to parse UWP JSON array: {}", e);
            Vec::new()
        })
    } else if json.starts_with('{') {
        serde_json::from_str::<serde_json::Value>(json)
            .map(|v| vec![v])
            .unwrap_or_else(|e| {
                log::warn!("Failed to parse UWP JSON object: {}", e);
                Vec::new()
            })
    } else {
        return Vec::new();
    };

    arr.into_iter()
        .filter_map(|item| {
            let name = item["Name"].as_str()?.trim().to_string();
            let app_id = item["AppID"].as_str()?.trim().to_string();
            if name.is_empty() || app_id.is_empty() {
                return None;
            }
            Some(UwpApp { name, app_id })
        })
        .collect()
}
