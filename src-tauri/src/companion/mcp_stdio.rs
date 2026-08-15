//! 第三方 stdio MCP server 的进程执行层（补刀 B）。
//!
//! 形态：per-server 长驻子进程（lazy spawn），stdin 行写 JSON-RPC 请求、
//! stdout 行读响应——与 mcp.rs 服务端同一协议。进程崩溃/管道断开后
//! 下次调用自动重建；应用退出（RunEvent::Exit）同步整树 taskkill。
//!
//! Windows 要点（血泪经验，见 shell.rs 与 websearch.rs 先例）：
//! - 命令解析：`npx`/`uvx` 这类 PATH 上的 .cmd shim 必须 cmd /c 包裹，
//!   裸 spawn 会失败；带路径或 .exe 结尾的直接 spawn
//! - 杀进程：child.kill() 只杀壳层（cmd），孙进程（npx→node）会留孤儿，
//!   必须 taskkill /PID /T /F 整树杀
//! - stderr 管道必须消费：piped 不读会写满 64KB 阻塞死子进程；走 null()
//!   最简单（日志丢失可接受，错误都走 stdout 的 JSON-RPC error）
//! - 命令串拼接：cmd /c 串用 raw_arg 原样直传（不能用 .arg()，MSVCRT 转义
//!   cmd 不认——shell.rs 同姿势），含空白段内层引号包裹；cmd 元字符
//!   （" & | < > ^ % ( ) 换行）一律拒绝进串——它们会改变解析语义
//!   （CASE-001 C1：配置注入即任意命令执行，已实测）。env 走
//!   Command::env 注入，完全不进命令串
//! - 读超时：stdout 交给 per-session 持久读线程（有界通道送行），rpc 侧
//!   recv_timeout 实现总超时；超时先杀树再返回——进程死后读线程因 EOF
//!   自然收线，不存在 join 挂起（thread::scope 会 join 阻塞读线程，
//!   卡死进程反被永久挂起——CASE-001 C2）

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::mcp_servers::ExternalMcpServer;

/// 单次 stdio RPC 的总读超时（与 HTTP 通道一致）
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// 单行响应字节上限（超长行截断后协议错位，由跳过上限兜底杀树重建）
const MAX_LINE_BYTES: u64 = 1024 * 1024;
/// 连续跳过的不匹配行上限（banner/通知/错位行）
const MAX_SKIP_LINES: usize = 50;
const PROTOCOL_VERSION: &str = "2025-03-26";

/// cmd 命令串中会改变解析语义的字符：引号开关引号态，& | < > ^ 是分隔/
/// 重定向，% 变量展开，( ) 分组，换行分隔命令。这些字符不允许出现在
/// cmd /c 拼串里（env 走 Command::env 不经命令串，不受此限）。
const CMD_META_CHARS: &[char] = &['"', '&', '|', '<', '>', '^', '%', '(', ')', '\r', '\n'];

/// 校验 token 能否安全放进 cmd /s /c 命令串（配置校验层与拼串层双重调用）
pub fn validate_cmd_token(token: &str) -> Result<(), String> {
    if let Some(c) = token.chars().find(|c| CMD_META_CHARS.contains(c)) {
        return Err(format!(
            "包含 cmd 特殊字符「{c}」：stdio 启动命令不支持该字符，请改用 .exe 完整路径直接启动"
        ));
    }
    Ok(())
}

/// 校验 server 的 stdio 启动配置能否安全 spawn：
/// 走 cmd /c 拼串路径（.cmd/.bat/裸命令）时才需要字符校验；
/// 带路径/.exe 直接 spawn 的 args 逐参数传递不经 shell，任意字符安全。
/// env key 必须是合法环境变量名。
pub fn validate_stdio_config(server: &ExternalMcpServer) -> Result<(), String> {
    let (_program, wrapped) = resolve_command(&server.command);
    if wrapped {
        build_command_line(&server.command, &server.args)?;
    }
    for kv in &server.env {
        if !kv.key.is_empty() && (kv.key.contains('=') || kv.key.contains('\0')) {
            return Err(format!("环境变量名「{}」不合法", kv.key));
        }
    }
    Ok(())
}

/// 全局进程注册表：server name → 会话（std::sync::Mutex 串行调用——每 server
/// 同一时刻只允许一个请求在飞，简单且避免 stdin 写交错）
static REGISTRY: std::sync::OnceLock<Mutex<HashMap<String, StdioSession>>> =
    std::sync::OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, StdioSession>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 一个长驻会话：子进程句柄 + 持久读线程的行接收端 + 初始化状态 + 请求计数
struct StdioSession {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    /// 持久读线程送来的行（Ok=一行；Err=读取失败；EOF 时发送端 drop）
    rx: std::sync::mpsc::Receiver<Result<String, String>>,
    initialized: bool,
    next_id: u64,
}

/// 决定 Windows 下如何启动命令：(可执行程序, 是否 cmd /c 包裹)
fn resolve_command(command: &str) -> (String, bool) {
    let lower = command.to_lowercase();
    let is_script = lower.ends_with(".cmd") || lower.ends_with(".bat");
    let has_path = command.contains('\\') || command.contains('/');
    let is_exe = lower.ends_with(".exe");
    // PATH 上的 .cmd/.bat shim（npx/uvx）与裸命令（无扩展名、无路径）都走 cmd /c；
    // 显式 .exe 或带路径的（含 node.exe/python.exe）直接 spawn
    if is_script || (!has_path && !is_exe) {
        ("cmd".to_string(), true)
    } else {
        (command.to_string(), false)
    }
}

/// 拼 cmd /c 命令串：command+args 空格连接，含空白的段内层引号包裹保真。
/// 所有段先过元字符校验（内嵌引号/分隔符会破坏引号结构 → 报错而不是冒险拼）。
fn build_command_line(command: &str, args: &[String]) -> Result<String, String> {
    validate_cmd_token(command)?;
    let mut full = String::new();
    for token in std::iter::once(command).chain(args.iter().map(|s| s.as_str())) {
        validate_cmd_token(token)?;
        if !full.is_empty() {
            full.push(' ');
        }
        if token.chars().any(|c| c.is_whitespace()) {
            full.push('"');
            full.push_str(token);
            full.push('"');
        } else {
            full.push_str(token);
        }
    }
    Ok(full)
}

/// 探活/初始化握手 + tools/list（导入验证与刷新用）。失败时返回人话错误；
/// 所有路径（含失败）统一杀树，不留孤儿进程。
pub fn probe_stdio(server: &ExternalMcpServer) -> Result<Vec<Value>, String> {
    let mut session = spawn_session(server).map_err(|e| format!("启动失败：{}", e))?;
    session
        .rpc(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "flowhub", "version": env!("CARGO_PKG_VERSION") }
            }),
        )
        .map_err(|e| {
            session.kill_tree();
            format!("initialize 失败：{}", e)
        })?;
    if let Err(e) = session.notify("notifications/initialized") {
        log::debug!("stdio MCP server 初始化通知发送失败：{}", e);
    }
    let tools = session
        .rpc("tools/list", json!({}))
        .map_err(|e| {
            session.kill_tree();
            format!("tools/list 失败：{}", e)
        })?;
    session.kill_tree();
    tools
        .get("tools")
        .and_then(|t| t.as_array())
        .cloned()
        .ok_or_else(|| "tools/list 响应缺少 tools 数组".to_string())
}

/// 聊天链路调用：从注册表取/建会话，串行执行一次 tools/call。
/// 错误转文本（与 HTTP 通道同一失败语义：文本回模型）。
pub fn call_stdio_tool(server: &ExternalMcpServer, tool_name: &str, args: Value) -> String {
    let result = (|| -> Result<String, String> {
        let mut registry = registry().lock().map_err(|e| e.to_string())?;
        let session = match registry.get_mut(&server.name) {
            Some(s) => s,
            None => {
                let s = spawn_session(server)?;
                registry.insert(server.name.clone(), s);
                registry.get_mut(&server.name).unwrap()
            }
        };
        let do_call = |session: &mut StdioSession| -> Result<String, String> {
            if !session.initialized {
                session
                    .rpc(
                        "initialize",
                        json!({
                            "protocolVersion": PROTOCOL_VERSION,
                            "capabilities": {},
                            "clientInfo": { "name": "flowhub", "version": env!("CARGO_PKG_VERSION") }
                        }),
                    )?;
                if let Err(e) = session.notify("notifications/initialized") {
                    log::debug!("stdio MCP server 初始化通知发送失败：{}", e);
                }
                session.initialized = true;
            }
            let result = session.rpc("tools/call", json!({ "name": tool_name, "arguments": args }))?;
            let is_error = result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false);
            let text = super::mcp_client::extract_result_text(&result);
            let text = super::mcp_client::truncate_tool_result(&text);
            Ok(if is_error {
                format!("（server 返回错误）\n{}", text)
            } else {
                text
            })
        };
        // 会话死了（进程退出/管道断开/协议错乱）→ 杀树重建后重试一次
        match do_call(session) {
            Ok(text) => Ok(text),
            Err(_) => {
                session.kill_tree();
                let new_session = spawn_session(server)?;
                *session = new_session;
                do_call(session).map_err(|e2| format!("重建会话后仍失败：{}", e2))
            }
        }
    })();
    match result {
        Ok(text) => text,
        Err(e) => format!("（stdio server 调用失败：{}）", e),
    }
}

/// spawn 子进程：cmd /c 包裹逻辑 + CREATE_NO_WINDOW + stdin/stdout 管道、
/// stderr 丢弃；env 一律经 Command::env 注入（不进命令串）。
fn spawn_session(server: &ExternalMcpServer) -> Result<StdioSession, String> {
    let (program, wrapped) = resolve_command(&server.command);
    let mut cmd = std::process::Command::new(&program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if wrapped {
            // 命令串 raw_arg 原样直传（手工包最外层引号，/s 让 cmd 剥外层后逐字执行）
            let full = build_command_line(&server.command, &server.args)?;
            cmd.arg("/s").arg("/c").raw_arg(format!("\"{}\"", full));
        } else {
            cmd.args(&server.args);
        }
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        cmd.args(&server.args);
    }
    #[cfg(windows)]
    {
        // 最小暴露（CASE-001 M11）：第三方进程不继承宿主全量环境——shell 级
        // 密钥（GITHUB_TOKEN/云 AK 等）不外泄给任意 npx 包。只注入运行必需
        // 的系统变量；额外依赖的变量在 env 配置里显式声明。
        const KEEP_ENV: &[&str] = &[
            "PATH", "SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT",
            "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE",
            "HOMEPATH", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
        ];
        cmd.env_clear();
        for key in KEEP_ENV {
            if let Ok(v) = std::env::var(key) {
                cmd.env(key, v);
            }
        }
    }
    for kv in &server.env {
        if kv.key.is_empty() {
            continue;
        }
        if kv.key.contains('=') || kv.key.contains('\0') {
            return Err(format!("环境变量名「{}」不合法", kv.key));
        }
        cmd.env(&kv.key, &kv.value);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // stderr 走 null()：piped 不消费会写满阻塞子进程；JSON-RPC error 都走 stdout
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("spawn 失败: {}", e))?;
    let stdin = child.stdin.take().ok_or("无法取得 stdin")?;
    let stdout = child.stdout.take().ok_or("无法取得 stdout")?;
    // 持久读线程：stdout 所有权进线程，行经有界通道（背压防超长输出吃内存）送 rpc。
    // 线程独立于请求生命周期——rpc 超时杀进程后 EOF 自然收线，无 join 挂起；
    // 单行超 MAX_LINE_BYTES 截断（协议错位由 rpc 跳过上限兜底）。
    let (tx, rx) = std::sync::mpsc::sync_channel(64);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = String::new();
            let n = match reader.by_ref().take(MAX_LINE_BYTES).read_line(&mut line) {
                Ok(n) => n,
                Err(e) => {
                    let _ = tx.send(Err(format!("读取响应流失败: {}", e)));
                    break;
                }
            };
            if n == 0 {
                break; // EOF：进程退出，发送端 drop，rpc 侧收 RecvError
            }
            if tx.send(Ok(line)).is_err() {
                break; // 会话已销毁
            }
        }
    });
    log::info!("stdio MCP server「{}」已启动（pid {}）", server.name, child.id());
    Ok(StdioSession {
        child,
        stdin,
        rx,
        initialized: false,
        next_id: 1,
    })
}

impl StdioSession {
    /// 单次 JSON-RPC：写一行请求，循环收行直到匹配本请求 id（banner/通知/
    /// 错位行跳过，上限 MAX_SKIP_LINES）。总超时 READ_TIMEOUT，超时/流错误
    /// 先杀树再返回——进程死后读线程因 EOF 退出，不会悬挂。
    fn rpc(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.write_line(&msg.to_string())?;

        let deadline = Instant::now() + READ_TIMEOUT;
        let mut skipped = 0usize;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                self.kill_tree();
                return Err(format!("调用超时（{}s）", READ_TIMEOUT.as_secs()));
            }
            let line = match self.rx.recv_timeout(remaining) {
                Ok(Ok(line)) => line,
                Ok(Err(e)) => {
                    self.kill_tree();
                    return Err(e);
                }
                Err(_) => {
                    self.kill_tree();
                    return Err("server 进程已退出（stdout EOF）".to_string());
                }
            };
            let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else {
                skipped += 1;
                if skipped > MAX_SKIP_LINES {
                    self.kill_tree();
                    return Err(format!("连续 {MAX_SKIP_LINES} 行响应无法解析，判定协议错乱"));
                }
                continue;
            };
            if msg.get("id").and_then(|v| v.as_u64()) == Some(id) {
                return super::mcp_client::unwrap_rpc_envelope(msg);
            }
            // 通知/无 id/其他请求的行——跳过
            skipped += 1;
            if skipped > MAX_SKIP_LINES {
                self.kill_tree();
                return Err(format!("连续 {MAX_SKIP_LINES} 行响应未匹配请求 id，判定协议错乱"));
            }
        }
    }

    fn notify(&mut self, method: &str) -> Result<(), String> {
        let msg = json!({ "jsonrpc": "2.0", "method": method });
        self.write_line(&msg.to_string())
    }

    fn write_line(&mut self, line: &str) -> Result<(), String> {
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.write_all(b"\n"))
            .and_then(|_| self.stdin.flush())
            .map_err(|e| format!("写入请求失败（进程可能已退出）: {}", e))
    }

    /// 整树杀进程（cmd→npx→node 孙进程一并），随后 close stdin 让句柄释放。
    /// 杀失败不致命（进程可能已自己退出）；rpc 超时/错误路径也走这里。
    fn kill_tree(&mut self) {
        let pid = self.child.id();
        log::info!("清理 stdio MCP server 进程树（pid {}）", pid);
        #[cfg(windows)]
        {
            let mut cmd = std::process::Command::new("taskkill");
            cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
            let _ = cmd.output();
            let _ = self.child.wait();
        }
        #[cfg(not(windows))]
        {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        let _ = self.stdin.flush();
    }
}

/// 驱逐指定 server 的长驻进程（配置变更/删除/停用后调用；下次调用自动重建）
pub fn evict(server_name: &str) {
    let Ok(mut registry) = registry().lock() else {
        return;
    };
    if let Some(mut session) = registry.remove(server_name) {
        session.kill_tree();
        log::info!("stdio MCP server「{}」会话已驱逐", server_name);
    }
}

/// 应用退出清理：同步杀全部注册进程树（RunEvent::Exit 时 tokio 运行时正在拆，
/// 只能走同步路径——与 websearch::shutdown_daemon 同姿势）。
pub fn shutdown_all() {
    let Ok(mut registry) = registry().lock() else {
        return;
    };
    let count = registry.len();
    for session in registry.values_mut() {
        session.kill_tree();
    }
    registry.clear();
    if count > 0 {
        log::info!("退出清理：已杀 {} 个 stdio MCP server 进程树", count);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_command_rules() {
        // PATH 上的 .cmd shim → cmd 包裹
        assert_eq!(resolve_command("npx"), ("cmd".to_string(), true));
        assert_eq!(resolve_command("npx.cmd"), ("cmd".to_string(), true));
        assert_eq!(resolve_command("uvx"), ("cmd".to_string(), true));
        // 显式 exe 或带路径 → 直接 spawn
        assert_eq!(resolve_command("node"), ("cmd".to_string(), true));
        assert_eq!(resolve_command("node.exe"), ("node.exe".to_string(), false));
        assert_eq!(
            resolve_command("C:\\tools\\node.exe"),
            ("C:\\tools\\node.exe".to_string(), false)
        );
    }

    #[test]
    fn command_line_quotes_tokens_with_whitespace() {
        let full = build_command_line(
            "npx",
            &["-y".to_string(), "a b".to_string(), "--k=v".to_string()],
        )
        .unwrap();
        assert_eq!(full, "npx -y \"a b\" --k=v");
        // command 本身含空格（带路径 .cmd）同样包裹
        let full = build_command_line("C:\\my tools\\s.cmd", &[]).unwrap();
        assert_eq!(full, "\"C:\\my tools\\s.cmd\"");
    }

    #[test]
    fn command_line_rejects_cmd_meta_chars() {
        // CASE-001 C1 三个实测注入构造全部拒绝
        assert!(build_command_line("npx", &["\"x\"&whoami&\"\"".to_string()]).is_err());
        assert!(build_command_line("npx", &["-y".to_string(), "x|calc".to_string()]).is_err());
        assert!(build_command_line("npx", &["100%".to_string()]).is_err());
        assert!(build_command_line("npx", &["a^b".to_string()]).is_err());
        assert!(build_command_line("npx", &["(x)".to_string()]).is_err());
        // 正常参数放行（含 = 与 - 合法）
        assert!(
            build_command_line(
                "npx",
                &["-y".to_string(), "@scope/pkg".to_string(), "a=b".to_string()],
            )
            .is_ok()
        );
    }

    #[test]
    fn wrapped_cmd_preserves_quoted_space_arg_on_real_cmd() {
        // 真实 cmd：raw_arg + 内层引号保真（含空格段不被 MSVCRT 转义肢解）
        let full = build_command_line("echo", &["D:\\my data".to_string()]).unwrap();
        let mut cmd = std::process::Command::new("cmd");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.arg("/s").arg("/c").raw_arg(format!("\"{}\"", full));
        }
        let out = cmd.output().expect("spawn cmd 失败");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            stdout.contains("\"D:\\my data\""),
            "实际输出: {:?}",
            stdout
        );
    }
}
