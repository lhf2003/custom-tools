//! Web 搜索执行层：复用本地 open-webSearch daemon（Node 进程，npx 懒启动）。
//!
//! 只服务场景聊天通道。进程管理策略：
//! - 懒启动：第一次搜索时才 spawn `npx -y open-websearch@latest serve --port 3721`
//! - 复用：启动前先探活 3721-3723 端口，已有健康 daemon（如上次残留或用户自起）直接用
//! - 退出清理：应用退出时 taskkill 整棵树（cmd→npx→node 三层，只杀顶层会留孤儿）
//! - Node 缺失：spawn 失败返回明确错误文本，模型会转告用户

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::process::Child;

/// open-websearch 包（pin 版本：每次启动不从 registry 拉新版，
/// 防供应链污染，也保证 HTTP API 形状与解析逻辑一致；升级需发版验证）
const OWS_PACKAGE: &str = "open-websearch@2.1.11";
/// daemon 端口探测范围（起点也是首选端口）
const PORT_START: u16 = 3721;
const PORT_END: u16 = 3723;
/// 首次启动等待上限（npx 冷下载 open-websearch 包，可能很慢）
const SPAWN_TIMEOUT_SECS: u64 = 120;
/// 单次搜索请求超时
const SEARCH_TIMEOUT_SECS: u64 = 30;

/// tauri managed state：daemon 句柄（tokio Mutex——持有锁跨 await）
#[derive(Default)]
pub struct WebSearchState {
    daemon: tokio::sync::Mutex<Option<DaemonHandle>>,
    /// daemon pid 的原子镜像：退出清理不走 async 锁
    ///（Exit 回调是同步的，此刻 spawn 可能正持锁下载包，try_lock 会失败留孤儿）
    daemon_pid: std::sync::atomic::AtomicU32,
}

struct DaemonHandle {
    child: Child,
    port: u16,
}

/// web_search 工具入口：参数校验 → 确保 daemon 在跑 → POST /search → 格式化结果。
pub async fn execute_web_search_tool(app_handle: &AppHandle, args: &Value) -> Result<String, String> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("缺少参数 query")?;
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(5)
        .clamp(1, 10);
    let engine = args.get("engine").and_then(|v| v.as_str()).map(str::trim);
    if let Some(e) = engine {
        const ENGINES: [&str; 6] = ["bing", "baidu", "duckduckgo", "brave", "sogou", "startpage"];
        if !ENGINES.contains(&e) {
            return Err(format!(
                "未知引擎「{}」，可选：{}（不填默认 bing）",
                e,
                ENGINES.join(" / ")
            ));
        }
    }

    let base_url = ensure_daemon(app_handle).await?;

    let mut body = serde_json::json!({ "query": query, "limit": limit });
    if let Some(e) = engine {
        body["engines"] = serde_json::json!([e]);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(SEARCH_TIMEOUT_SECS))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{}/search", base_url))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("搜索请求失败: {}", e))?;
    let envelope: Value = resp
        .json()
        .await
        .map_err(|e| format!("搜索响应解析失败: {}", e))?;

    if envelope.get("status").and_then(|v| v.as_str()) != Some("ok") {
        let msg = envelope
            .pointer("/error/message")
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        let hint = envelope
            .get("hint")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        return Err(format!("搜索失败：{} {}", msg, hint).trim().to_string());
    }

    let data = &envelope["data"];
    let results = data
        .get("results")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if results.is_empty() {
        return Ok(format!(
            "搜索「{}」没有找到结果。换个关键词试试（更具体或换个说法）",
            query
        ));
    }

    let engines_used = data
        .get("engines")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|e| e.as_str())
                .collect::<Vec<_>>()
                .join("、")
        })
        .unwrap_or_default();
    let mut out = format!(
        "搜索「{}」得到 {} 条结果（引擎：{}）：\n",
        query,
        results.len(),
        engines_used
    );
    for (i, r) in results.iter().enumerate() {
        let title = r.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let url = r.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let desc: String = r
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .chars()
            .take(200)
            .collect();
        out.push_str(&format!("\n【{}】{}\n    {}\n    {}\n", i + 1, title, url, desc));
    }
    Ok(out)
}

/// 确保 daemon 可用，返回 base_url。顺序：已持有的句柄 → 端口探活 → 新 spawn。
async fn ensure_daemon(app_handle: &AppHandle) -> Result<String, String> {
    let state = app_handle
        .try_state::<WebSearchState>()
        .ok_or("搜索服务状态未初始化")?;
    let mut guard = state.daemon.lock().await;

    // 1. 已持有句柄：确认还活着且健康
    if let Some(handle) = guard.as_mut() {
        let exited = handle.child.try_wait().map(|s| s.is_some()).unwrap_or(true);
        if !exited && health_ok(handle.port).await {
            return Ok(base_url(handle.port));
        }
        // 死了或不健康：弃掉走重启（drop 时 kill_on_drop 回收 cmd 壳）
        *guard = None;
        state.daemon_pid.store(0, std::sync::atomic::Ordering::SeqCst);
    }

    // 2. 端口探活：复用已有 daemon（上次残留 / 用户自起）
    for port in PORT_START..=PORT_END {
        if health_ok(port).await {
            log::info!("open-websearch daemon 已在 {} 端口运行，直接复用", port);
            return Ok(base_url(port));
        }
    }

    // 3. 新 spawn：cmd /c npx（Windows 上 npx 是 .cmd，必须走 cmd 解释）
    let port = PORT_START;
    let _ = app_handle.emit("jarvis:status", "贾维斯在启动搜索服务（首次要下载，稍慢）…");
    log::info!("启动 open-websearch daemon（{}，端口 {}）…", OWS_PACKAGE, port);

    let mut cmd = tokio::process::Command::new("cmd");
    cmd.arg("/c")
        .arg(format!("npx -y {} serve --port {}", OWS_PACKAGE, port))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "启动搜索服务失败：未检测到 cmd 环境".to_string()
        } else {
            format!("启动搜索服务失败: {}", e)
        }
    })?;

    // stdout/stderr 排空记日志（不排的话管道写满会堵死 daemon）
    if let Some(out) = child.stdout.take() {
        tokio::spawn(drain_log(out, "open-websearch"));
    }
    if let Some(err) = child.stderr.take() {
        tokio::spawn(drain_log(err, "open-websearch"));
    }

    // pid 先落原子镜像：哪怕还在等健康检查，退出回调也能整树杀
    let pid = child.id().unwrap_or(0);
    state.daemon_pid.store(pid, std::sync::atomic::Ordering::SeqCst);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(SPAWN_TIMEOUT_SECS);
    loop {
        if health_ok(port).await {
            log::info!("open-websearch daemon 就绪（端口 {}，pid {}）", port, pid);
            *guard = Some(DaemonHandle { child, port });
            return Ok(base_url(port));
        }
        // 进程已退出：多半是 npx 下载失败或端口被占，日志里有细节
        if let Ok(Some(status)) = child.try_wait() {
            state.daemon_pid.store(0, std::sync::atomic::Ordering::SeqCst);
            return Err(format!(
                "搜索服务启动失败（进程已退出，{}）。常见原因：Node.js 未安装、npm registry 不可达、端口 {} 被占用",
                status, port
            ));
        }
        if std::time::Instant::now() >= deadline {
            state.daemon_pid.store(0, std::sync::atomic::Ordering::SeqCst);
            return Err(format!(
                "搜索服务启动超时（{} 秒）。首次运行要经 npm 下载 open-websearch，网络慢时会超时；请检查网络后重试",
                SPAWN_TIMEOUT_SECS
            ));
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
}

async fn drain_log<R: tokio::io::AsyncRead + Unpin>(reader: R, tag: &'static str) {
    use tokio::io::AsyncBufReadExt;
    let mut lines = tokio::io::BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        log::debug!("[{}] {}", tag, line);
    }
}

async fn health_ok(port: u16) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    client
        .get(format!("{}/health", base_url(port)))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

fn base_url(port: u16) -> String {
    format!("http://127.0.0.1:{}", port)
}

/// 应用退出时整树杀掉 daemon（cmd→npx→node 三层，taskkill /T 才杀得干净）。
/// 同步实现 + 原子 pid：RunEvent::Exit 时 tokio 运行时正在拆，
/// 且 spawn 可能正持锁下载包——走 async 锁会拿不到锁留孤儿。
pub fn shutdown_daemon(app_handle: &AppHandle) {
    let Some(state) = app_handle.try_state::<WebSearchState>() else {
        return;
    };
    let pid = state.daemon_pid.swap(0, std::sync::atomic::Ordering::SeqCst);
    if pid == 0 {
        return;
    }
    log::info!("退出清理：taskkill open-websearch daemon（pid {}）", pid);
    let mut cmd = std::process::Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    if let Err(e) = cmd.output() {
        log::warn!("taskkill 搜索 daemon 失败: {}", e);
    }
}
