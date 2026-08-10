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

/// Get-StartApps 返回 0 条后的重试间隔。
/// 开机自启时 Start Menu 的 AppX 数据可能尚未就绪,Get-StartApps 偶发返回
/// 0 条/空输出——等待片刻重试一次,排除瞬时状态,避免「0 条」被当成
/// 「确实没有 UWP」而清空缓存。
const SCAN_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(2);

/// Enumerate installed UWP apps using Get-StartApps.
/// Only returns entries whose AppID contains '!' (UWP package format).
///
/// 返回 Err 表示「扫描失败」（powershell 超时/不可用/输出解析失败）——调用方
/// 必须与「确实没有 UWP 应用」区分开：失败时沿用缓存旧条目，否则全量替换
/// 会把所有 UWP 应用从缓存里清空（Get-StartApps 被 EDR/组策略挂起即全灭）。
///
/// 首次扫描返回 0 条时视为可疑（数据未就绪等瞬时状态），等待
/// SCAN_RETRY_DELAY 后重试一次再返回。重试后仍为 0 条由调用方决定
/// 是否接受——0 条与「确实没有」在结果上等价,但调用方若有缓存可
/// 沿用,应优先沿用。
#[cfg(windows)]
pub fn scan() -> Result<Vec<UwpApp>, String> {
    match scan_once() {
        Ok(apps) if apps.is_empty() => {
            log::warn!(
                "Get-StartApps 首次返回 0 条，等待 {:?} 后重试一次",
                SCAN_RETRY_DELAY
            );
            std::thread::sleep(SCAN_RETRY_DELAY);
            scan_once()
        }
        other => other,
    }
}

#[cfg(windows)]
fn scan_once() -> Result<Vec<UwpApp>, String> {
    // 必须显式把管道输出编码设为 UTF-8：PowerShell 5.1 默认按 OEM 代码页
    // （中文系统 = GBK）向管道写字节，Rust 按 UTF-8 读会遇第一个中文应用名
    // 解码失败 → 整个输出被丢弃 → 假性「empty output」→ UWP 应用全灭
    let output = run_powershell(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
         Get-StartApps | Where-Object { $_.AppID -like '*!*' } | \
         Select-Object Name, AppID | ConvertTo-Json -Compress",
    );

    match output {
        Some(json) => parse_json(&json),
        None => Err("Get-StartApps 执行失败（超时或不可用）".to_string()),
    }
}

#[cfg(not(windows))]
pub fn scan() -> Result<Vec<UwpApp>, String> {
    Ok(Vec::new())
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
    // 读取用 read_to_end + 宽容解码：read_to_string 遇非 UTF-8 字节整个
    // 返回 Err 导致输出静默丢失（8/1 起 UWP 全灭的根因，见 scan 注释）。
    let mut stdout_pipe = child.stdout.take()?;
    let stdout_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        match String::from_utf8(buf) {
            Ok(s) => s,
            Err(e) => {
                log::warn!(
                    "powershell 输出非 UTF-8（{}），宽容解码，中文内容可能乱码",
                    e.utf8_error()
                );
                String::from_utf8_lossy(e.as_bytes()).into_owned()
            }
        }
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

/// 解析失败视为扫描失败（Err），成功但无条目视为确实没有（Ok 空）
fn parse_json(json: &str) -> Result<Vec<UwpApp>, String> {
    // Handle both array and single-object responses
    let arr: Vec<serde_json::Value> = if json.starts_with('[') {
        serde_json::from_str(json).map_err(|e| format!("解析 UWP JSON 数组失败: {}", e))?
    } else if json.starts_with('{') {
        serde_json::from_str::<serde_json::Value>(json)
            .map(|v| vec![v])
            .map_err(|e| format!("解析 UWP JSON 对象失败: {}", e))?
    } else {
        return Err("Get-StartApps 输出不是 JSON".to_string());
    };

    Ok(arr
        .into_iter()
        .filter_map(|item| {
            let name = item["Name"].as_str()?.trim().to_string();
            let app_id = item["AppID"].as_str()?.trim().to_string();
            if name.is_empty() || app_id.is_empty() {
                return None;
            }
            Some(UwpApp { name, app_id })
        })
        .collect())
}
