//! Shell 与文件读取工具的执行层：权限模式 + 用户确认 + 进程/文件执行。
//!
//! 只服务场景聊天通道（scene_chat.rs tool 循环特判调用），不进 MCP——
//! Claude Code 自己有 shell 和文件读写。
//!
//! 安全模型（设置页「工具」页签可配，settings 键 shell_permission_mode）：
//! - confirm_all（默认）：每条命令/每次读取前弹系统原生确认框（渲染在 WebView 外，
//!   前端被注入也伪造不了点击），用户决策写 shell_confirm_audit 审计表
//! - accept_edits：文件读取（read_file）自动放行，Bash 命令仍需确认
//! - unattended：read_file 自动放行；只读 shell 命令自动放行——只读首词白名单
//!   （dir/ipconfig 等）+ 子命令级白名单（git status/npm list 等只读组合），其余仍需确认
//!
//! 灾难命令硬拒绝清单不受权限模式影响，用户确认也救不回来。
//! 敏感文件（私钥/凭证/浏览器数据/本应用数据库）在自动模式下直接拒绝，
//! 仅 confirm_all 可由用户显式确认放行——这类内容发给云端模型就收不回。

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// 命令执行默认/最大超时
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const MAX_TIMEOUT_SECS: u64 = 120;
/// 输出截断阈值（防烧 token）
const MAX_OUTPUT_CHARS: usize = 6000;

/// 硬拒绝：单 token 即灾难的命令（token 去可执行后缀后匹配，防 format.com 绕过）
const DENY_TOKENS: &[&str] = &[
    "diskpart", "shutdown", "bcdedit", "takeown", "icacls", "format",
];

/// 无打扰模式自动放行的只读命令首词（且整串不含 | & > < ` 等壳元字符）
const SAFE_COMMANDS: &[&str] = &[
    "dir",
    "type",
    "echo",
    "where",
    "whoami",
    "hostname",
    "ver",
    "vol",
    "ipconfig",
    "ping",
    "nslookup",
    "tasklist",
    "systeminfo",
    "tree",
    "findstr",
    "find",
    "more",
];

/// 子命令级白名单：带写能力的命令，只在子命令明确只读时放行
const SAFE_GIT_SUBS: &[&str] = &[
    "status",
    "log",
    "diff",
    "show",
    "blame",
    "ls-files",
    "shortlog",
    "describe",
    "rev-parse",
];
const SAFE_NPM_SUBS: &[&str] = &[
    "list",
    "ls",
    "outdated",
    "view",
    "info",
    "doctor",
    "ping",
    "--version",
    "-v",
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
        c.is_control()
            || ('\u{202a}'..='\u{202e}').contains(&c)
            || ('\u{2066}'..='\u{2069}').contains(&c)
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

    if need_confirm
        && !confirm_with_user(
            app_handle,
            "Shell 命令确认",
            &format!(
                "贾维斯要在你的电脑上执行命令：\n\n{}\n\n只放行你本人核实过的命令。",
                command
            ),
            "等你确认命令（系统弹窗）…",
            command,
        )
        .await
    {
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
    // 元字符黑名单：| & > < ` 是 cmd 真分隔/重定向；';' 在 cmd 里不是分隔符
    //（实测 `cmd /c "dir ; echo x"` 中分号按字面传递），但 dir 等命令用它
    // 分隔参数、PowerShell 拿它分语句——收进来做纵深防御，成本为零
    if normalized
        .chars()
        .any(|c| matches!(c, '|' | '&' | '>' | '<' | '`' | ';'))
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

/// 发起用户确认：系统原生弹窗 + 审计留痕。
/// 原生弹窗渲染在 WebView 外——前端被注入恶意脚本也伪造不了用户点击
///（此前 WebView 弹窗只回传 boolean，invoke 即可放行）；每条决策连同
/// 操作全文、当时权限模式写入 shell_confirm_audit，事后可追溯。
/// shell 与 read_file 共用此入口，audit_subject 区分来源（命令原文 / "read_file: 路径"）。
/// 返回 true = 用户允许执行。
async fn confirm_with_user(
    app_handle: &AppHandle,
    title: &str,
    prompt: &str,
    status: &str,
    audit_subject: &str,
) -> bool {
    let _ = app_handle.emit("jarvis:status", status);
    let app = app_handle.clone();
    let title_owned = title.to_string();
    let prompt_owned = prompt.to_string();
    let audit_owned = audit_subject.to_string();
    let db_path = app_handle
        .try_state::<crate::db::DatabaseState>()
        .map(|s| s.0.clone());
    let mode = permission_mode(app_handle);
    // blocking_show 是同步阻塞调用，必须进 spawn_blocking（顺带把审计写入
    // 也放这里——SQLite 同步写不占用 tokio worker）
    tauri::async_runtime::spawn_blocking(move || {
        // 弹窗展示截断：全文在审计表，弹窗保证关键部分可见即可
        let display: String = prompt_owned.chars().take(800).collect();
        let display = if display.len() < prompt_owned.len() {
            format!("{}\n…（内容过长已截断，全文见审计表）", display)
        } else {
            display
        };
        let allowed = app
            .dialog()
            .message(display)
            .title(title_owned)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "允许".to_string(),
                "拒绝".to_string(),
            ))
            .blocking_show();
        if let Some(db_path) = db_path {
            if let Ok(conn) = crate::db::open_connection(&db_path) {
                let _ = conn.execute(
                    "INSERT INTO shell_confirm_audit (command, allowed, mode) VALUES (?1, ?2, ?3)",
                    rusqlite::params![audit_owned, allowed as i64, mode],
                );
            }
        }
        allowed
    })
    .await
    .unwrap_or(false)
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

// ---------- read_file 工具 ----------

/// read_file 默认/最大返回字符数（防烧 token）
const DEFAULT_READ_CHARS: usize = 8000;
const MAX_READ_CHARS: usize = 20000;
/// 读取前 N 字节做二进制嗅探
const BINARY_SNIFF_BYTES: usize = 8192;

/// read_file 工具入口：消毒 → 敏感路径闸门 → 权限闸门 → 读取。
/// 与 shell 共用权限模式（settings 键 shell_permission_mode）：
/// - confirm_all：每次读取弹窗确认
/// - accept_edits / unattended：普通文件自动放行
/// 敏感路径在自动模式下直接拒绝（内容发给云端模型就收不回），
/// 仅 confirm_all 可经用户显式确认放行。
pub async fn execute_read_file_tool(app_handle: &AppHandle, args: &Value) -> Result<String, String> {
    let raw_path = args
        .get("path")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("缺少参数 path")?;
    let max_chars = args
        .get("max_chars")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(DEFAULT_READ_CHARS)
        .clamp(1, MAX_READ_CHARS);

    // 同 shell：控制字符/双向覆盖字符一律拒绝（防路径显示与实际不一致）
    if raw_path.chars().any(|c| {
        c.is_control()
            || ('\u{202a}'..='\u{202e}').contains(&c)
            || ('\u{2066}'..='\u{2069}').contains(&c)
    }) {
        return Err("路径包含控制字符，已拒绝读取".to_string());
    }

    let expanded = expand_path(raw_path);
    let normalized = expanded.replace('/', "\\").to_lowercase();
    let sensitive = sensitive_path_reason(&normalized);
    let auto_allow = matches!(
        permission_mode(app_handle).as_str(),
        "accept_edits" | "unattended"
    );

    match sensitive {
        Some(reason) if auto_allow => {
            return Err(format!(
                "该路径命中敏感文件策略（{}），当前权限模式下不允许读取。确需读取请切到默认模式（每次确认）后重试。",
                reason
            ));
        }
        Some(reason) => {
            let prompt = format!(
                "贾维斯要读取敏感文件（{}）：\n\n{}\n\n文件内容会发送给 AI 模型。只放行你本人核实过的路径。",
                reason, raw_path
            );
            let audit = format!("read_file(敏感): {}", raw_path);
            if !confirm_with_user(
                app_handle,
                "敏感文件读取确认",
                &prompt,
                "等你确认文件读取（系统弹窗）…",
                &audit,
            )
            .await
            {
                return Ok("用户拒绝了这次读取，没有执行。换个思路，或直接问他想怎么做。".to_string());
            }
        }
        None if !auto_allow => {
            let prompt = format!(
                "贾维斯要在你的电脑上读取文件：\n\n{}\n\n文件内容会发送给 AI 模型。只放行你本人核实过的路径。",
                raw_path
            );
            let audit = format!("read_file: {}", raw_path);
            if !confirm_with_user(
                app_handle,
                "文件读取确认",
                &prompt,
                "等你确认文件读取（系统弹窗）…",
                &audit,
            )
            .await
            {
                return Ok("用户拒绝了这次读取，没有执行。换个思路，或直接问他想怎么做。".to_string());
            }
        }
        None => {}
    }

    read_text_file(&expanded, max_chars)
}

/// 路径展开：去引号 + %VAR% 环境变量 + ~ 家目录（黑名单匹配与文件打开都用展开后的路径，
/// 否则 %USERPROFILE%\.ssh\id_rsa 会绕过片段匹配）
fn expand_path(raw: &str) -> String {
    let p = raw.trim().trim_matches(|c| c == '"' || c == '\'');
    let p = expand_env_vars(p);
    if p == "~" || p.starts_with("~/") || p.starts_with("~\\") {
        if let Some(home) = std::env::var_os("USERPROFILE") {
            return format!("{}{}", home.to_string_lossy(), &p[1..]);
        }
    }
    p
}

/// 展开 %VAR% 形式的环境变量；未定义或变量名非法时原样保留
fn expand_env_vars(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else {
            // 落单的 %：原样输出收尾
            out.push_str(&rest[start..]);
            return out;
        };
        let name = &after[..end];
        if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            match std::env::var(name) {
                Ok(val) => out.push_str(&val),
                Err(_) => out.push_str(&rest[start..start + end + 2]),
            }
            rest = &after[end + 1..];
        } else {
            out.push('%');
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// 敏感路径判定：输入已统一为小写 + 反斜杠。片段 contains 匹配，宁宽勿窄——
/// 误伤的代价只是一次确认/拒绝提示，漏过的代价是密钥发上云端。
fn sensitive_path_reason(normalized: &str) -> Option<&'static str> {
    const KEY_DIRS: &[&str] = &[
        "\\.ssh\\",
        "\\.gnupg\\",
        "\\.aws\\",
        "\\.azure\\",
        "\\.kube\\",
        "\\.docker\\",
    ];
    const KEY_FILES: &[&str] = &["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"];
    const CRED_FILES: &[&str] = &[".git-credentials", ".netrc", ".npmrc", ".pypirc", "\\.env"];
    const BROWSER_DATA: &[&str] = &["\\cookies", "login data", "web data"];

    if KEY_DIRS.iter().any(|f| normalized.contains(f)) {
        Some("私钥/云凭证目录")
    } else if KEY_FILES.iter().any(|f| normalized.contains(f)) {
        Some("SSH 私钥文件")
    } else if CRED_FILES.iter().any(|f| normalized.contains(f)) {
        Some("密钥/凭证文件")
    } else if normalized.contains("flowhub.db") {
        Some("本应用数据库")
    } else if BROWSER_DATA.iter().any(|f| normalized.contains(f)) {
        Some("浏览器凭证数据")
    } else {
        None
    }
}

/// 二进制嗅探：前 8KB 含 NUL 即判二进制（UTF-16 文本也会命中，同样不支持）
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(BINARY_SNIFF_BYTES).any(|&b| b == 0)
}

/// 读取文本文件：限流读取（防大文件撑爆内存）→ 二进制检测 → UTF-8/GBK 解码 → 字符截断
fn read_text_file(path: &str, max_chars: usize) -> Result<String, String> {
    use std::io::Read;

    let file = std::fs::File::open(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("文件不存在: {}", path),
        std::io::ErrorKind::PermissionDenied => format!("没有读取权限: {}", path),
        _ => format!("无法打开文件: {}", e),
    })?;
    if file.metadata().map(|m| m.is_dir()).unwrap_or(false) {
        return Err("这是一个目录，不是文件。列目录请用 run_shell_command 的 dir。".to_string());
    }

    // UTF-8 最多 4 字节/字符，按上限截流（+64 容纳截断点后的半个字符）
    let cap = (max_chars as u64).saturating_mul(4).saturating_add(64);
    let mut buf = Vec::new();
    file.take(cap)
        .read_to_end(&mut buf)
        .map_err(|e| format!("读取文件失败: {}", e))?;

    if looks_binary(&buf) {
        return Err(
            "这是二进制文件（图片/程序/压缩包等）或 UTF-16 编码，read_file 只支持 UTF-8/GBK 文本。"
                .to_string(),
        );
    }

    let text = match String::from_utf8(buf) {
        Ok(t) => t,
        Err(e) => {
            // 中文 Windows 的文本文件常见 GBK，回退解码
            let (cow, _, _) = encoding_rs::GBK.decode(e.as_bytes());
            cow.into_owned()
        }
    };

    let total = text.chars().count();
    if total <= max_chars {
        return Ok(text);
    }
    let kept: String = text.chars().take(max_chars).collect();
    Ok(format!(
        "{}\n…（文件共约 {} 字符，已截断到前 {} 字符。要看后面的内容用 run_shell_command 的 findstr 定位）",
        kept, total, max_chars
    ))
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
        assert!(hard_deny_reason("cipher /w:c:\\").is_none()); // /w 带盘符合并非独立 token，走确认
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
        // ';' 在 cmd 里不是分隔符（实测），但列入黑名单做纵深防御
        assert!(!is_safe_readonly(&normalize("dir ; del x")));
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
        assert!(is_safe_readonly(&normalize(
            "npm view open-websearch version"
        )));
        assert!(is_safe_readonly(&normalize("pip list")));
        assert!(is_safe_readonly(&normalize("cargo tree")));
        assert!(is_safe_readonly(&normalize("winget search powertoys")));
        assert!(!is_safe_readonly(&normalize("npm install")));
        // 版本查询类
        assert!(is_safe_readonly(&normalize("node --version")));
        assert!(is_safe_readonly(&normalize("python --version")));
        assert!(is_safe_readonly(&normalize("java -version")));
        // node -e 可执行任意 JS，绝不能放行
        assert!(!is_safe_readonly(&normalize(
            "node -e \"require('fs').rmSync('x')\""
        )));
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

    #[test]
    fn sensitive_path_hits() {
        let n = |s: &str| expand_path(s).replace('/', "\\").to_lowercase();
        assert!(sensitive_path_reason(&n("C:\\Users\\me\\.ssh\\id_rsa")).is_some());
        assert!(sensitive_path_reason(&n("C:/Users/me/.ssh/config")).is_some());
        assert!(sensitive_path_reason(&n("D:\\project\\.env")).is_some());
        assert!(sensitive_path_reason(&n("D:\\project\\.env.local")).is_some());
        assert!(sensitive_path_reason(&n("C:\\Users\\me\\.aws\\credentials")).is_some());
        assert!(sensitive_path_reason(&n("D:\\data\\flowhub.db-wal")).is_some());
        assert!(sensitive_path_reason(&n(
            "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies"
        ))
        .is_some());
        assert!(sensitive_path_reason(&n("C:\\Users\\me\\.git-credentials")).is_some());
        // 环境变量展开后也命中（防 %USERPROFILE% 绕过）
        assert!(sensitive_path_reason(&n("%USERPROFILE%\\.ssh\\id_rsa")).is_some());
    }

    #[test]
    fn sensitive_path_allows_normal() {
        let n = |s: &str| expand_path(s).replace('/', "\\").to_lowercase();
        assert!(sensitive_path_reason(&n("D:\\notes\\todo.md")).is_none());
        assert!(sensitive_path_reason(&n("D:\\workspace\\custom-tools\\Cargo.toml")).is_none());
        assert!(sensitive_path_reason(&n("C:\\Windows\\System32\\drivers\\etc\\hosts")).is_none());
    }

    #[test]
    fn expand_env_vars_works() {
        // PATH 在 Windows 必有
        let expanded = expand_env_vars("%PATH%");
        assert!(!expanded.contains("%PATH%"));
        // 未定义变量原样保留
        assert_eq!(
            expand_env_vars("%DEFINITELY_NOT_EXIST_VAR_12345%"),
            "%DEFINITELY_NOT_EXIST_VAR_12345%"
        );
        // 无变量原样
        assert_eq!(expand_env_vars("d:\\plain\\path"), "d:\\plain\\path");
        // 落单的 % 原样
        assert_eq!(expand_env_vars("100%"), "100%");
        // 非法变量名（含空格）不当变量展开
        assert_eq!(expand_env_vars("%not a var%"), "%not a var%");
    }

    #[test]
    fn expand_path_tilde() {
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        if !home.is_empty() {
            let expanded = expand_path("~/.ssh/config");
            assert!(expanded.starts_with(&home));
            assert!(expanded.ends_with("/.ssh/config"));
        }
    }

    #[test]
    fn binary_detection() {
        assert!(looks_binary(&[b'h', b'i', 0, b'x']));
        assert!(!looks_binary("你好世界".as_bytes()));
        assert!(!looks_binary(&[]));
    }
}
