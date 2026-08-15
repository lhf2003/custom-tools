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

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;

use super::mcp_servers::ExternalMcpServer;

/// 单次 stdio RPC 的读超时
const READ_TIMEOUT: Duration = Duration::from_secs(30);
const PROTOCOL_VERSION: &str = "2025-03-26";

/// 全局进程注册表：server name → 会话（std::sync::Mutex 串行调用——每 server
/// 同一时刻只允许一个请求在飞，简单且避免 stdin 写交错）
static REGISTRY: std::sync::LazyLock<Mutex<HashMap<String, StdioSession>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// 一个长驻会话：子进程句柄 + 初始化状态 + 请求计数
struct StdioSession {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
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

/// 组装 spawn 参数：cmd /c 包裹时命令与参数整体拼成一条 /s /c 串（引号保真，
/// 与 shell.rs 同一姿势）
fn spawn_args(command: &str, args: &[String], env: &[super::mcp_servers::KeyValue]) -> (String, Vec<String>) {
    let (program, wrapped) = resolve_command(command);
    if !wrapped {
        return (program, args.to_vec());
    }
    // env 的 set 语句拼在命令**前面**（cmd 依次执行，先后顺序决定环境是否生效）
    let mut full = String::new();
    for kv in env {
        full.push_str(&format!("set \"{}={}\"&&", kv.key, kv.value));
    }
    full.push_str(command);
    for a in args {
        full.push(' ');
        full.push_str(a);
    }
    (program, vec!["/s".to_string(), "/c".to_string(), full])
}

/// 探活/初始化握手 + tools/list（导入验证与刷新用）。失败时返回人话错误。
pub fn probe_stdio(server: &ExternalMcpServer) -> Result<Vec<Value>, String> {
    let mut session = spawn_session(server).map_err(|e| format!("启动失败：{}", e))?;
    let result = match session.rpc("initialize", json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": { "name": "flowhub", "version": env!("CARGO_PKG_VERSION") }
    })) {
        Ok(r) => r,
        Err(e) => return Err(format!("initialize 失败：{}", e)),
    };
    let _ = session.notify("notifications/initialized");
    let tools = session
        .rpc("tools/list", json!({}))
        .map_err(|e| format!("tools/list 失败：{}", e))?;
    session.kill_tree();
    let _ = result;
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
        let mut registry = REGISTRY.lock().map_err(|e| e.to_string())?;
        let session = match registry.get_mut(&server.name) {
            Some(s) => s,
            None => {
                let s = spawn_session(server)?;
                registry.insert(server.name.clone(), s);
                registry.get_mut(&server.name).unwrap()
            }
        };
        let mut do_call = |session: &mut StdioSession| -> Result<String, String> {
            if !session.initialized {
                session.rpc("initialize", json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": { "name": "flowhub", "version": env!("CARGO_PKG_VERSION") }
                }))?;
                let _ = session.notify("notifications/initialized");
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
        // 会话死了（进程退出/管道断开）→ 杀树重建后重试一次
        match do_call(session) {
            Ok(text) => Ok(text),
            Err(e) => {
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

/// spawn 子进程：cmd /c 包裹逻辑 + CREATE_NO_WINDOW + stdin/stdout 管道、stderr 丢弃
fn spawn_session(server: &ExternalMcpServer) -> Result<StdioSession, String> {
    let (program, args) = spawn_args(&server.command, &server.args, &server.env);
    let mut cmd = std::process::Command::new(&program);
    cmd.args(&args)
        .stdin(Stdio::piped())
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
    log::info!("stdio MCP server「{}」已启动（pid {}）", server.name, child.id());
    Ok(StdioSession {
        child,
        stdin,
        stdout: BufReader::new(stdout),
        initialized: false,
        next_id: 1,
    })
}

impl StdioSession {
    /// 单次 JSON-RPC：写一行请求，读一行响应。读超时（READ_TIMEOUT）用
    /// 独立线程 + 通道实现（同步 BufRead 无超时 API）。
    fn rpc(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.write_line(&msg.to_string())?;

        // 读超时：子进程卡死（死锁/下载）不能拖死聊天工具轮
        let mut reader = &mut self.stdout;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(move || {
                let mut line = String::new();
                let r = reader.read_line(&mut line).map(|n| (n, line));
                let _ = tx.send(r);
            });
            match rx.recv_timeout(READ_TIMEOUT) {
                Ok(Ok((0, _))) => Err("server 进程已退出（stdout EOF）".to_string()),
                Ok(Ok((_, line))) => {
                    let msg: Value = serde_json::from_str(line.trim())
                        .map_err(|e| format!("响应不是合法 JSON: {}", e))?;
                    Ok(msg)
                }
                Ok(Err(e)) => Err(format!("读取响应失败: {}", e)),
                Err(_) => Err(format!("调用超时（{}s）", READ_TIMEOUT.as_secs())),
            }
        })
        .and_then(|msg| super::mcp_client::unwrap_rpc_envelope(msg))
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
    /// 杀失败不致命（进程可能已自己退出）。
    fn kill_tree(&mut self) {
        let pid = self.child.id();
        log::info!("清理 stdio MCP server 进程树（pid {}）", pid);
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let _ = cmd.output();
        let _ = self.child.wait();
        let _ = self.stdin.flush();
    }
}

/// 驱逐指定 server 的长驻进程（配置变更/删除/停用后调用；下次调用自动重建）
pub fn evict(server_name: &str) {
    let Ok(mut registry) = REGISTRY.lock() else {
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
    let Ok(mut registry) = REGISTRY.lock() else {
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
    fn spawn_args_wraps_cmd_with_quotes_preserved() {
        let (program, args) = spawn_args(
            "npx",
            &["-y".to_string(), "@x/y".to_string(), "--k".to_string(), "a b".to_string()],
            &[],
        );
        assert_eq!(program, "cmd");
        assert_eq!(args[0], "/s");
        assert_eq!(args[1], "/c");
        // 参数原样拼进命令串（含空格的参数保真）
        assert_eq!(args[2], "npx -y @x/y --k a b");
    }

    #[test]
    fn spawn_args_direct_exe_passthrough() {
        let (program, args) = spawn_args("node.exe", &["a.js".to_string()], &[]);
        assert_eq!(program, "node.exe");
        assert_eq!(args, vec!["a.js"]);
    }

    #[test]
    fn spawn_args_prepends_env_assignments() {
        let env = vec![crate::companion::mcp_servers::KeyValue {
            key: "API_KEY".to_string(),
            value: "abc".to_string(),
        }];
        let (_, args) = spawn_args("npx", &["-y".to_string()], &env);
        // set 必须在命令前：cmd 依次执行，后置的 set 对子命令不生效
        assert_eq!(args[2], "set \"API_KEY=abc\"&&npx -y");
    }
}
