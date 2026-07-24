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
         Select-Object Name, AppID | ConvertTo-Json -Compress",
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
    use std::io::Read;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    /// 子进程最长存活时间。企业 EDR/组策略可能挂起 powershell.exe,
    /// 无超时等待会永久阻塞调用线程。
    const POWERSHELL_TIMEOUT: Duration = Duration::from_secs(10);

    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            log::warn!("Failed to spawn powershell: {}", e);
            return None;
        }
    };

    // stdout/stderr 各起一个读取线程:输出超过 pipe 缓冲(64KB)时子进程会
    // 阻塞在写管道上,不持续读取的话 try_wait 永远等不到退出。
    let mut stdout_pipe = child.stdout.take()?;
    let stdout_reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout_pipe.read_to_string(&mut buf);
        buf
    });
    let mut stderr_pipe = child.stderr.take()?;
    let stderr_reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stderr_pipe.read_to_string(&mut buf);
        buf
    });

    let deadline = Instant::now() + POWERSHELL_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    log::warn!(
                        "Get-StartApps timed out after {:?}, powershell killed",
                        POWERSHELL_TIMEOUT
                    );
                    let _ = stdout_reader.join();
                    let _ = stderr_reader.join();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                log::warn!("Failed waiting on powershell: {}", e);
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return None;
            }
        }
    };

    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();

    if status.success() {
        let result = stdout.trim().to_string();
        if result.is_empty() {
            log::debug!("Get-StartApps returned empty output");
            return None;
        }
        Some(result)
    } else {
        log::warn!("Get-StartApps failed: {}", stderr.trim());
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
