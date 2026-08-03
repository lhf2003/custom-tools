//! Shell 工具执行层：权限模式 + 用户确认 + 进程执行。
//!
//! 只服务场景聊天通道（scene_chat.rs tool 循环特判调用），不进 MCP——
//! Claude Code 自己有 shell。
//!
//! 安全模型（设置页「工具」页签可配，settings 键 shell_permission_mode）：
//! - confirm_all（默认）：每条命令执行前都要用户在聊天里点头
//! - accept_edits：预留档位（对齐 Claude Code 权限语义），当前没有文件类工具，
//!   行为同 confirm_all
//! - unattended：安全命令自动放行——只读首词白名单（dir/ipconfig 等）+
//!   子命令级白名单（git status/npm list 等只读组合），其余仍需确认
//!
//! 灾难命令硬拒绝清单不受权限模式影响，用户确认也救不回来。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

/// 等待用户确认的 pending 表：confirm_id → 放行通道（tauri managed state）
#[derive(Default)]
pub struct ShellConfirmState {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<bool>>>>,
}

/// 确认等待超时：用户不点视为拒绝（防 tool 循环吊死）
const CONFIRM_TIMEOUT_SECS: u64 = 120;
/// 命令执行默认/最大超时
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 120;
/// 输出截断阈值（防烧 token）
const MAX_OUTPUT_CHARS: usize = 6000;

/// 硬拒绝：单 token 即灾难的命令（token 去可执行后缀后匹配，防 format.com 绕过）
const DENY_TOKENS: &[&str] = &["diskpart", "shutdown", "bcdedit", "takeown", "icacls", "format"];

/// 无打扰模式自动放行的只读命令首词（且整串不含 | & > < ` 等壳元字符）
const SAFE_COMMANDS: &[&str] = &[
    "dir", "type", "echo", "where", "whoami", "hostname", "ver", "vol", "ipconfig", "ping",
    "nslookup", "tasklist", "systeminfo", "tree", "findstr", "find", "more",
];

/// 子命令级白名单：带写能力的命令，只在子命令明确只读时放行
const SAFE_GIT_SUBS: &[&str] = &[
    "status", "log", "diff", "show", "blame", "ls-files", "shortlog", "describe", "rev-parse",
];
const SAFE_NPM_SUBS: &[&str] = &[
    "list", "ls", "outdated", "view", "info", "doctor", "ping", "--version", "-v",
];
const SAFE_PIP_SUBS: &[&str] = &["list", "show", "freeze", "--version", "-V"];
const SAFE_CARGO_SUBS: &[&str] = &["tree", "search", "--version", "-V"];
const SAFE_WINGET_SUBS: &[&str] = &["list", "search", "show", "--version", "-v"];
/// 版本查询类（node/python/rustc/java 等）：java 是单横线 -version，都收
const SAFE_VERSION_SUBS: &[&str] = &["--version", "-v", "-V", "-version", "version"];

/// run_shell_command 工具入口：消毒 → 校验 → 权限闸门 → 执行。
/// 返回值直接作为工具结果喂给模型（错误也是文本，让模型自我纠正）。
pub async fn execute_shell_tool(app_handle: &AppHandle, args: &Value) -> Result<String, String> {
    let command = args
        .get("command")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("缺少参数 command")?;
    let timeout_secs = args
        .get("timeout_secs")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_TIMEOUT_SECS)
        .clamp(1, MAX_TIMEOUT_SECS);

    // 消毒：控制字符一律拒绝——
    // 换行/回车在 cmd 里能分隔命令（normalize 会压成空格，首词白名单被打穿）；
    // 双向覆盖字符（U+202A-202E、U+2066-2069）让确认弹窗显示的与实际执行的不一致
    if command.chars().any(|c| {
        c.is_control() || ('\u{202a}'..='\u{202e}').contains(&c) || ('\u{2066}'..='\u{2069}').contains(&c)
    }) {
        return Err("命令包含控制字符（换行/双向覆盖等），已拒绝执行".to_string());
    }

    // 硬拒绝：任何模式都不放行
    if let Some(reason) = hard_deny_reason(command) {
        return Err(format!(
            "该命令命中安全策略硬拒绝（{}）：任何模式下都不允许执行",
            reason
        ));
    }

    let mode = permission_mode(app_handle);
    let need_confirm = match mode.as_str() {
        // accept_edits 预留：当前无文件类工具，行为同 confirm_all
        "confirm_all" | "accept_edits" => true,
        "unattended" => !is_safe_readonly(&normalize(command)),
        _ => true,
    };

    if need_confirm && !confirm_with_user(app_handle, command).await {
        return Ok("用户拒绝了这条命令，没有执行。换个思路，或直接问他想怎么做。".to_string());
    }

    run_command(command, timeout_secs).await
}

/// 命令归一化：小写 + 连续空白压成单空格（提高名单匹配命中率）
fn normalize(command: &str) -> String {
    command
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// token 归一化：去引号与可执行后缀（防 reg.exe / format.com 绕过子串匹配）
fn normalize_token(token: &str) -> &str {
    let t = token.trim_matches(|c| c == '"' || c == '\'');
    for suffix in [".exe", ".com", ".cmd", ".bat"] {
        if let Some(stripped) = t.strip_suffix(suffix) {
            return stripped;
        }
    }
    t
}

/// 灾难命令硬拒绝：token 级匹配（与参数顺序无关）
fn hard_deny_reason(command: &str) -> Option<&'static str> {
    let lower = command.to_lowercase();
    let tokens: Vec<&str> = lower.split_whitespace().map(normalize_token).collect();
    if tokens.is_empty() {
        return None;
    }
    // 单 token 灾难命令（任意位置——它出现即意图明确）
    if tokens.iter().any(|t| DENY_TOKENS.contains(t)) {
        return Some("格式化/关机/权限篡改类系统命令");
    }
    let first = tokens[0];
    let has = |pat: &str| tokens.contains(&pat);
    if (first == "del" || first == "rd" || first == "rmdir") && has("/s") {
        return Some("递归删除目录（del/rd /s）");
    }
    if first == "reg" && has("delete") {
        return Some("删除注册表项（reg delete）");
    }
    if first == "net" && (has("user") || has("localgroup")) {
        return Some("账户/用户组操作（net user/localgroup）");
    }
    if first == "cipher" && has("/w") {
        return Some("磁盘剩余空间擦除（cipher /w）");
    }
    if first == "rm" && (has("-rf") || has("-fr")) {
        return Some("强制递归删除（rm -rf）");
    }
    None
}

/// 只读安全判定：整串无壳元字符（防 dir && del 拼接），且命中
/// 首词白名单 或 子命令级白名单（git/npm 等有写能力的命令只看只读子命令）
fn is_safe_readonly(normalized: &str) -> bool {
    if normalized
        .chars()
        .any(|c| matches!(c, '|' | '&' | '>' | '<' | '`'))
    {
        return false;
    }
    let tokens: Vec<&str> = normalized.split_whitespace().collect();
    let first = tokens.first().copied().unwrap_or("");
    if SAFE_COMMANDS.contains(&first) {
        return true;
    }
    let second = tokens.get(1).copied().unwrap_or("");
    match first {
        "git" => {
            SAFE_GIT_SUBS.contains(&second)
                // 裸列表命令：git branch / remote / tag 不带参才是只读（带参可能创建/删除）
                || (tokens.len() == 2 && matches!(second, "branch" | "remote" | "tag"))
        }
        "npm" => SAFE_NPM_SUBS.contains(&second),
        "pip" => SAFE_PIP_SUBS.contains(&second),
        "cargo" => SAFE_CARGO_SUBS.contains(&second),
        "winget" => SAFE_WINGET_SUBS.contains(&second),
        "go" => matches!(second, "version" | "env"),
        "node" | "python" | "python3" | "rustc" | "java" | "javac" => {
            SAFE_VERSION_SUBS.contains(&second)
        }
        _ => false,
    }
}

fn permission_mode(app_handle: &AppHandle) -> String {
    app_handle
        .try_state::<crate::commands::settings::SettingsState>()
        .and_then(|s| {
            s.0.lock()
                .ok()
                .map(|m| m.get_settings().shell_permission_mode.clone())
        })
        .unwrap_or_else(|| "confirm_all".to_string())
}

/// 发起用户确认：emit 事件给聊天前端，等允许/拒绝（超时按拒绝）。
/// 返回 true = 用户允许执行。
async fn confirm_with_user(app_handle: &AppHandle, command: &str) -> bool {
    let Some(state) = app_handle.try_state::<ShellConfirmState>() else {
        log::warn!("ShellConfirmState 未初始化，拒绝执行");
        return false;
    };

    let confirm_id = format!("{:016x}", rand::random::<u64>());
    let (tx, rx) = oneshot::channel::<bool>();
    if let Ok(mut pending) = state.pending.lock() {
        pending.insert(confirm_id.clone(), tx);
    } else {
        return false;
    }

    let _ = app_handle.emit(
        "jarvis:shell-confirm",
        serde_json::json!({ "id": confirm_id, "command": command }),
    );
    let _ = app_handle.emit("jarvis:status", "等你确认命令…");

    let allowed = matches!(
        tokio::time::timeout(std::time::Duration::from_secs(CONFIRM_TIMEOUT_SECS), rx).await,
        Ok(Ok(true))
    );

    // 兜底清理（正常路径 resolve 时已移除）
    if let Ok(mut pending) = state.pending.lock() {
        pending.remove(&confirm_id);
    }
    allowed
}

/// 执行命令：cmd /c + UTF-8 代码页（中文 Windows 默认 GBK，不切页输出必乱码），
/// 超时强杀（kill_on_drop 保证 timeout 路径上子进程被回收）。
async fn run_command(command: &str, timeout_secs: u64) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new("cmd");
    cmd.arg("/c")
        .arg(format!("chcp 65001>nul & {}", command))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn().map_err(|e| format!("无法启动 cmd: {}", e))?;

    match tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        child.wait_with_output(),
    )
    .await
    {
        Ok(Ok(out)) => {
            let stdout = truncate(String::from_utf8_lossy(&out.stdout).trim());
            let stderr = truncate(String::from_utf8_lossy(&out.stderr).trim());
            let code = out.status.code().unwrap_or(-1);
            let mut result = format!("退出码：{}", code);
            if !stdout.is_empty() {
                result.push_str(&format!("\n输出：\n{}", stdout));
            }
            if !stderr.is_empty() {
                result.push_str(&format!("\n错误输出：\n{}", stderr));
            }
            if stdout.is_empty() && stderr.is_empty() {
                result.push_str("\n（无输出）");
            }
            Ok(result)
        }
        Ok(Err(e)) => Err(format!("命令执行失败: {}", e)),
        Err(_) => Err(format!(
            "命令超过 {} 秒未结束，已强制终止。需要更长时间请显式调大 timeout_secs",
            timeout_secs
        )),
    }
}

fn truncate(s: &str) -> String {
    if s.chars().count() <= MAX_OUTPUT_CHARS {
        return s.to_string();
    }
    let kept: String = s.chars().take(MAX_OUTPUT_CHARS).collect();
    format!("{}\n…（输出过长，已截断）", kept)
}

/// 前端确认回执：允许/拒绝（tauri command，聊天弹窗按钮调用）
#[tauri::command]
pub fn resolve_shell_confirm(
    state: tauri::State<'_, ShellConfirmState>,
    id: String,
    allow: bool,
) -> Result<(), String> {
    let tx = state
        .pending
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    match tx {
        Some(tx) => {
            let _ = tx.send(allow);
            Ok(())
        }
        // 超时已被清理：静默成功（用户晚点了，结果与拒绝一致）
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hard_deny_blocks_catastrophic() {
        // 直接命中
        assert!(hard_deny_reason("format c: /q").is_some());
        assert!(hard_deny_reason("shutdown /s /t 0").is_some());
        assert!(hard_deny_reason("del /s /q c:\\temp").is_some());
        assert!(hard_deny_reason("rd /s c:\\build").is_some());
        assert!(hard_deny_reason("reg delete HKLM\\Software /f").is_some());
        assert!(hard_deny_reason("net user admin pass /add").is_some());
        assert!(hard_deny_reason("rm -rf /").is_some());
        assert!(hard_deny_reason("cipher /w:c:\\").is_some() == false); // /w 带盘符合并非独立 token，走确认
        assert!(hard_deny_reason("cipher /w c:\\").is_some());
        // 大小写不敏感
        assert!(hard_deny_reason("DEL /S /Q c:\\temp").is_some());
        assert!(hard_deny_reason("Format C:").is_some());
    }

    #[test]
    fn hard_deny_resists_bypass() {
        // .exe/.com 后缀绕过
        assert!(hard_deny_reason("reg.exe delete HKLM\\Software").is_some());
        assert!(hard_deny_reason("format.com c:").is_some());
        // 参数顺序绕过
        assert!(hard_deny_reason("del /f /s /q c:\\temp").is_some());
        assert!(hard_deny_reason("rd /q /s c:\\build").is_some());
        // 引号包裹
        assert!(hard_deny_reason("\"del\" /s c:\\temp").is_some());
    }

    #[test]
    fn hard_deny_allows_normal() {
        assert!(hard_deny_reason("dir").is_none());
        assert!(hard_deny_reason("git status").is_none());
        assert!(hard_deny_reason("npm install").is_none());
        assert!(hard_deny_reason("del report.tmp").is_none()); // 单文件删除走确认，不硬拒
        assert!(hard_deny_reason("echo hello > a.txt").is_none());
        assert!(hard_deny_reason("type package.json").is_none());
    }

    #[test]
    fn safe_readonly_rules() {
        // 白名单首词 + 无元字符才放行
        assert!(is_safe_readonly(&normalize("dir")));
        assert!(is_safe_readonly(&normalize("ipconfig /all")));
        assert!(is_safe_readonly(&normalize("tasklist")));
        assert!(!is_safe_readonly(&normalize("dir && del x")));
        assert!(!is_safe_readonly(&normalize("dir > out.txt")));
    }

    #[test]
    fn safe_readonly_subcommand_rules() {
        // git 只读子命令放行
        assert!(is_safe_readonly(&normalize("git status")));
        assert!(is_safe_readonly(&normalize("git log --oneline -10")));
        assert!(is_safe_readonly(&normalize("git diff HEAD~1")));
        assert!(is_safe_readonly(&normalize("git branch"))); // 裸命令 = 列表
        // git 写子命令/带参 branch 不放行
        assert!(!is_safe_readonly(&normalize("git branch -d feature")));
        assert!(!is_safe_readonly(&normalize("git reset --hard")));
        assert!(!is_safe_readonly(&normalize("git checkout main")));
        // npm/pip/cargo/winget 只读组合
        assert!(is_safe_readonly(&normalize("npm list")));
        assert!(is_safe_readonly(&normalize("npm view open-websearch version")));
        assert!(is_safe_readonly(&normalize("pip list")));
        assert!(is_safe_readonly(&normalize("cargo tree")));
        assert!(is_safe_readonly(&normalize("winget search powertoys")));
        assert!(!is_safe_readonly(&normalize("npm install")));
        // 版本查询类
        assert!(is_safe_readonly(&normalize("node --version")));
        assert!(is_safe_readonly(&normalize("python --version")));
        assert!(is_safe_readonly(&normalize("java -version")));
        // node -e 可执行任意 JS，绝不能放行
        assert!(!is_safe_readonly(&normalize("node -e \"require('fs').rmSync('x')\"")));
        assert!(!is_safe_readonly(&normalize("python -c \"import os\"")));
    }

    #[test]
    fn sanitize_rejects_control_chars() {
        // 换行注入（unattended 绕过攻击）
        let attack = "dir\ndel /f /q c:\\important";
        assert!(attack.chars().any(|c| c.is_control()));
        // 双向覆盖（确认弹窗视觉欺骗）
        let bidi = "dir \u{202e}txt";
        assert!(bidi.chars().any(|c| ('\u{202a}'..='\u{202e}').contains(&c)));
        // 正常命令不含
        assert!(!"dir /b".chars().any(|c| c.is_control()));
    }
}
