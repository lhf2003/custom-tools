//! 第三方 MCP server 的配置存储与管理（二期 + 补刀：stdio 提前）。
//!
//! 配置存 settings 表 KV `mcp_external_servers`（JSON 数组，裁决 4）；
//! 凭据（headers/env 的值）明文本地存（Claude Desktop 同姿势）且**不出后端**——
//! 给前端的 ExternalMcpServerInfo 只带凭据 key 名（secret_entries）与 has_secret。
//! 传输双形态：http（streamable HTTP）/ stdio（本地子进程，mcp_stdio.rs 执行层）。

use serde_json::Value;
use std::sync::Mutex;

use super::mcp_client::McpHttpClient;
use crate::settings::SettingsManager;

/// settings 表键名
pub const SETTINGS_KEY: &str = "mcp_external_servers";

/// 连接验证失败的稳定错误前缀：前端据以弹「仍然保存」降级确认，
/// 不靠文案子串匹配（CASE-001 M7）
pub const VALIDATION_ERROR_PREFIX: &str = "MCP_VALIDATION:";

/// 键值对（headers/env 保序存储）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
pub struct KeyValue {
    pub key: String,
    #[serde(default)]
    pub value: String,
}

/// 一份第三方 server 配置（tools 为导入/刷新时的 tools/list 快照——聊天的真相源）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExternalMcpServer {
    /// slug 标识（ASCII [a-zA-Z0-9_-]，做工具名前缀，受 OpenAI function name 约束）
    pub name: String,
    #[serde(default)]
    pub display_name: String,
    /// 能力说明（UI 展示与 JSON 导入的 description 字段）
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_transport")]
    pub transport: String,
    /// http 形态：streamable HTTP 地址（/mcp 结尾）
    #[serde(default)]
    pub url: String,
    /// http 形态：请求头（Authorization 等）
    #[serde(default)]
    pub headers: Vec<KeyValue>,
    /// stdio 形态：启动命令（npx/node/python…）
    #[serde(default)]
    pub command: String,
    /// stdio 形态：命令参数
    #[serde(default)]
    pub args: Vec<String>,
    /// stdio 形态：环境变量（显式配置，追加进启动命令）
    #[serde(default)]
    pub env: Vec<KeyValue>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// 最近一次连接验证/刷新是否成功
    #[serde(default)]
    pub connected: bool,
    /// 最近一次失败的人话原因（成功时清空）
    #[serde(default)]
    pub last_error: String,
    #[serde(default)]
    pub tools: Vec<ExternalToolSnapshot>,
}

fn default_transport() -> String {
    "http".to_string()
}

impl Default for ExternalMcpServer {
    fn default() -> Self {
        Self {
            name: String::new(),
            display_name: String::new(),
            description: String::new(),
            transport: default_transport(),
            url: String::new(),
            headers: Vec::new(),
            command: String::new(),
            args: Vec::new(),
            env: Vec::new(),
            enabled: true,
            connected: false,
            last_error: String::new(),
            tools: Vec::new(),
        }
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExternalToolSnapshot {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub input_schema: Value,
}

/// 给前端的 server 视图（凭据值不下发，只有 key 名与 has_secret 标记）
#[derive(Debug, serde::Serialize)]
pub struct ExternalMcpServerInfo {
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub transport: String,
    pub url: String,
    pub command: String,
    pub args: Vec<String>,
    pub enabled: bool,
    pub connected: bool,
    pub last_error: String,
    /// 已配置 http headers 凭据的 key 名（值不下发，按归属拆分——编辑弹窗按 transport 预填）
    pub header_entries: Vec<String>,
    /// 已配置 stdio env 凭据的 key 名（值不下发）
    pub env_entries: Vec<String>,
    pub has_secret: bool,
    pub tools: Vec<ExternalToolBrief>,
}

#[derive(Debug, serde::Serialize)]
pub struct ExternalToolBrief {
    pub name: String,
    pub description: String,
}

impl ExternalMcpServer {
    fn to_info(&self) -> ExternalMcpServerInfo {
        let mut header_entries: Vec<String> = self
            .headers
            .iter()
            .filter(|kv| !kv.key.is_empty())
            .map(|kv| kv.key.clone())
            .collect();
        let mut env_entries: Vec<String> = self
            .env
            .iter()
            .filter(|kv| !kv.key.is_empty())
            .map(|kv| kv.key.clone())
            .collect();
        header_entries.dedup();
        env_entries.dedup();
        ExternalMcpServerInfo {
            name: self.name.clone(),
            display_name: self.display_name.clone(),
            description: self.description.clone(),
            transport: self.transport.clone(),
            url: self.url.clone(),
            command: self.command.clone(),
            args: self.args.clone(),
            enabled: self.enabled,
            connected: self.connected,
            last_error: self.last_error.clone(),
            has_secret: !header_entries.is_empty() || !env_entries.is_empty(),
            header_entries,
            env_entries,
            tools: self
                .tools
                .iter()
                .map(|t| ExternalToolBrief {
                    name: t.name.clone(),
                    description: t.description.clone(),
                })
                .collect(),
        }
    }
}

/// slug 校验：OpenAI function name 允许 `[a-zA-Z0-9_-]`；
/// 额外拒绝含 `__`——它是 server__tool 的分隔符，出现在 server 名里会让前缀路由产生歧义
pub fn is_valid_slug(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.contains("__")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

pub fn load(settings: &Mutex<SettingsManager>) -> Vec<ExternalMcpServer> {
    let Ok(manager) = settings.lock() else {
        return Vec::new();
    };
    serde_json::from_str(&manager.get_settings().mcp_external_servers).unwrap_or_default()
}

fn save(settings: &Mutex<SettingsManager>, servers: &[ExternalMcpServer]) -> Result<(), String> {
    let json = serde_json::to_string(servers).map_err(|e| e.to_string())?;
    let manager = settings.lock().map_err(|e| e.to_string())?;
    manager
        .set_setting(SETTINGS_KEY, &json)
        .map_err(|e| format!("保存配置失败: {}", e))
}

pub fn list_infos(settings: &Mutex<SettingsManager>) -> Vec<ExternalMcpServerInfo> {
    load(settings).iter().map(|s| s.to_info()).collect()
}

/// 配置语义校验（导入/JSON 解析共用）：transport 必填形态检查
fn validate_config(server: &ExternalMcpServer) -> Result<(), String> {
    match server.transport.as_str() {
        "http" => {
            if server.url.trim().is_empty() {
                return Err("HTTP 传输需要填写 server 地址".to_string());
            }
            McpHttpClient::new(&server.url, vec![]).map(|_| ())
        }
        "stdio" => {
            if server.command.trim().is_empty() {
                return Err("stdio 传输需要填写启动命令".to_string());
            }
            // 注入面校验：cmd /c 拼串路径的 command/args 禁 cmd 元字符，
            // env key 必须是合法环境变量名（CASE-001 C1 防御，保存前报错）
            super::mcp_stdio::validate_stdio_config(server)
        }
        other => Err(format!("未知传输类型「{}」（支持 http / stdio）", other)),
    }
}

/// tools/list 响应 → 快照（无合法 name 的条目丢弃）
fn snapshot_tools(raw: Vec<Value>) -> Vec<ExternalToolSnapshot> {
    raw.into_iter()
        .filter_map(|t| {
            let name = t.get("name")?.as_str()?.to_string();
            Some(ExternalToolSnapshot {
                name,
                description: t
                    .get("description")
                    .and_then(|d| d.as_str())
                    .unwrap_or("")
                    .to_string(),
                input_schema: t.get("inputSchema").cloned().unwrap_or(Value::Null),
            })
        })
        .collect()
}

/// 连接验证：按传输分派（http 走 McpHttpClient；stdio 走独立进程 probe 后杀树）。
/// 成功返回工具快照。
async fn probe(server: &ExternalMcpServer) -> Result<Vec<ExternalToolSnapshot>, String> {
    let raw = if server.transport == "stdio" {
        // 同步进程 IO，包进 blocking 避免阻塞 tokio worker
        let s = server.clone();
        tauri::async_runtime::spawn_blocking(move || super::mcp_stdio::probe_stdio(&s))
            .await
            .map_err(|e| format!("stdio 探测任务失败: {}", e))??
    } else {
        let mut client = McpHttpClient::new(
            &server.url,
            server
                .headers
                .iter()
                .map(|kv| (kv.key.clone(), kv.value.clone()))
                .collect(),
        )?;
        client.connect().await?;
        client.list_tools().await?
    };
    Ok(snapshot_tools(raw))
}

/// 导入（手动表单配置）。校验 → 同名拒绝 → 强制连通验证。
/// 验证失败且 force=false → 报错（前端确认「仍然保存」后以 force=true 重调）。
/// 注意：锁不跨 await——校验/读取与保存各自独立加锁（Tauri command 要求 Send）。
pub async fn import(
    settings: &Mutex<SettingsManager>,
    mut server: ExternalMcpServer,
    force: bool,
) -> Result<ExternalMcpServerInfo, String> {
    // 先 trim 再校验：带尾随空格的合法名字不应被误拒（CASE-001 L2）
    server.name = server.name.trim().to_string();
    if !is_valid_slug(&server.name) {
        return Err(format!(
            "标识名「{}」不合法：仅限字母/数字/下划线/连字符，且不能包含连续双下划线",
            server.name
        ));
    }
    server.display_name = server.display_name.trim().to_string();
    server.description = server.description.trim().to_string();
    validate_config(&server)?;
    if load(settings).iter().any(|s| s.name == server.name) {
        return Err(format!("已存在同名 server「{}」，请换个标识名", server.name));
    }

    let (connected, last_error, tools) = match probe(&server).await {
        Ok(tools) => (true, String::new(), tools),
        Err(e) => {
            if !force {
                return Err(format!("{VALIDATION_ERROR_PREFIX}连接验证失败：{}", e));
            }
            (false, e, Vec::new())
        }
    };

    server.connected = connected;
    server.last_error = last_error;
    server.tools = tools;
    let info = server.to_info();
    let mut servers = load(settings);
    servers.push(server);
    save(settings, &servers)?;
    log::info!(
        "第三方 MCP server「{}」已导入（transport={}, connected={}, 工具 {} 个）",
        info.name,
        info.transport,
        info.connected,
        info.tools.len()
    );
    Ok(info)
}

/// 解析 Claude Desktop 格式的 mcpServers 单条目：`{"name": {entry}}`。
/// entry 含 url → http（headers 对象收编）；含 command → stdio（args/env 收编）。
pub fn parse_server_entry(raw: &str) -> Result<ExternalMcpServer, String> {
    let obj: Value = serde_json::from_str(raw).map_err(|e| format!("JSON 解析失败: {}", e))?;
    let map = obj.as_object().ok_or("格式应为 { \"标识名\": { ... } } 的对象")?;
    if map.len() != 1 {
        return Err(format!(
            "一次添加一个 server（当前 JSON 里有 {} 个条目）",
            map.len()
        ));
    }
    let (name, entry) = map.iter().next().unwrap();
    let mut server = ExternalMcpServer {
        name: name.clone(),
        display_name: String::new(),
        description: String::new(),
        transport: default_transport(),
        url: String::new(),
        headers: Vec::new(),
        command: String::new(),
        args: Vec::new(),
        env: Vec::new(),
        enabled: true,
        connected: false,
        last_error: String::new(),
        tools: Vec::new(),
    };
    let kv_from_object = |v: &Value| -> Result<Vec<KeyValue>, String> {
        v.as_object()
            .ok_or("headers/env 必须是键值对象")?
            .iter()
            .map(|(k, val)| {
                Ok(KeyValue {
                    key: k.clone(),
                    value: val.as_str().unwrap_or("").to_string(),
                })
            })
            .collect()
    };
    if let Some(url) = entry.get("url").and_then(|u| u.as_str()) {
        server.transport = "http".to_string();
        server.url = url.to_string();
        if let Some(headers) = entry.get("headers") {
            server.headers = kv_from_object(headers)?;
        }
    } else if let Some(command) = entry.get("command").and_then(|c| c.as_str()) {
        server.transport = "stdio".to_string();
        server.command = command.to_string();
        if let Some(args) = entry.get("args").and_then(|a| a.as_array()) {
            server.args = args
                .iter()
                .map(|a| a.as_str().unwrap_or("").to_string())
                .collect();
        }
        if let Some(env) = entry.get("env") {
            server.env = kv_from_object(env)?;
        }
    } else {
        return Err("条目缺少 url 或 command 字段，无法判定传输类型".to_string());
    }
    if let Some(desc) = entry.get("description").and_then(|d| d.as_str()) {
        server.description = desc.to_string();
    }
    if let Some(enabled) = entry.get("enabled").and_then(|e| e.as_bool()) {
        server.enabled = enabled;
    }
    Ok(server)
}

/// 更新配置（slug 即身份，不可改名）。凭据合并语义：incoming 中 value 为空的
/// key 保留旧值（前端「留空=保持不变」），旧 key 不在 incoming 列表 = 清除该凭据。
/// 保存后重探测刷新快照；stdio 驱逐会话（命令/env 可能已变）。
/// 验证失败且 force=false 时报错（前端确认后 force 重调，与导入同一姿势）。
pub async fn update(
    settings: &Mutex<SettingsManager>,
    name: &str,
    mut incoming: ExternalMcpServer,
    force: bool,
) -> Result<ExternalMcpServerInfo, String> {
    let servers = load(settings);
    let Some(old) = servers.iter().find(|s| s.name == name).cloned() else {
        return Err(format!("server「{}」不存在", name));
    };
    drop(servers);

    // slug 即身份：改名 = 新前缀 = 旧开关/调用日志全部失联，拒绝
    incoming.name = name.to_string();
    incoming.display_name = incoming.display_name.trim().to_string();
    incoming.description = incoming.description.trim().to_string();
    incoming.headers = merge_kv(old.headers.clone(), incoming.headers);
    incoming.env = merge_kv(old.env.clone(), incoming.env);
    validate_config(&incoming)?;

    let (connected, last_error, tools) = match probe(&incoming).await {
        Ok(tools) => (true, String::new(), tools),
        Err(e) => {
            if !force {
                return Err(format!("{VALIDATION_ERROR_PREFIX}连接验证失败：{}", e));
            }
            (false, e, Vec::new())
        }
    };
    incoming.connected = connected;
    incoming.last_error = last_error;
    incoming.tools = tools;
    if incoming.transport == "stdio" {
        super::mcp_stdio::evict(name);
    }
    let info = incoming.to_info();
    let mut servers = load(settings);
    let Some(slot) = servers.iter_mut().find(|s| s.name == name) else {
        return Err(format!("server「{}」不存在", name));
    };
    *slot = incoming;
    save(settings, &servers)?;
    log::info!("第三方 MCP server「{}」配置已更新（connected={}）", name, info.connected);
    Ok(info)
}

/// 凭据合并：新值覆盖；值为空的 key 保留旧值；旧 key 不在 incoming = 清除
fn merge_kv(old: Vec<KeyValue>, incoming: Vec<KeyValue>) -> Vec<KeyValue> {
    let mut out = Vec::new();
    for kv in incoming {
        if kv.key.is_empty() {
            continue;
        }
        if kv.value.is_empty() {
            // 留空 = 保持原值；旧配置没有该 key 则丢弃（无意义空条目）
            if let Some(o) = old.iter().find(|o| o.key == kv.key) {
                out.push(o.clone());
            }
        } else {
            out.push(kv);
        }
    }
    out
}

/// 刷新：重新探测 + 重抓 tools/list 快照。
/// 失败保留旧快照（还能用），只更新 connected/last_error。
/// stdio 成功后驱逐注册表会话（命令/env 可能已变，下次调用重建）。
pub async fn refresh(
    settings: &Mutex<SettingsManager>,
    name: &str,
) -> Result<ExternalMcpServerInfo, String> {
    let servers = load(settings);
    let Some(existing) = servers.iter().find(|s| s.name == name) else {
        return Err(format!("server「{}」不存在", name));
    };
    let snapshot = existing.clone();
    drop(servers);

    let probed = probe(&snapshot).await;

    let mut servers = load(settings);
    let Some(server) = servers.iter_mut().find(|s| s.name == name) else {
        return Err(format!("server「{}」不存在", name));
    };
    match probed {
        Ok(tools) => {
            server.connected = true;
            server.last_error.clear();
            server.tools = tools;
        }
        Err(e) => {
            server.connected = false;
            server.last_error = e;
        }
    }
    if server.transport == "stdio" {
        super::mcp_stdio::evict(&server.name);
    }
    let info = server.to_info();
    save(settings, &servers)?;
    Ok(info)
}

/// 总开关：关闭后其下工具全部不进聊天循环（即使工具级开关开着）。
/// stdio 关闭时驱逐进程（释放资源）。
pub fn set_enabled(
    settings: &Mutex<SettingsManager>,
    name: &str,
    enabled: bool,
) -> Result<(), String> {
    let mut servers = load(settings);
    let Some(server) = servers.iter_mut().find(|s| s.name == name) else {
        return Err(format!("server「{}」不存在", name));
    };
    server.enabled = enabled;
    if !enabled && server.transport == "stdio" {
        super::mcp_stdio::evict(name);
    }
    save(settings, &servers)
}

/// 删除：同时清掉 disabled_companion_tools 里该 server 的工具开关残留
/// （前缀 `name__` 匹配；保留则重导入同名 server 时旧开关复活——行为不确定）。
/// stdio 进程一并驱逐。
pub fn delete(settings: &Mutex<SettingsManager>, name: &str) -> Result<(), String> {
    let mut servers = load(settings);
    let before = servers.len();
    let was_stdio = servers
        .iter()
        .any(|s| s.name == name && s.transport == "stdio");
    servers.retain(|s| s.name != name);
    if servers.len() == before {
        return Err(format!("server「{}」不存在", name));
    }
    save(settings, &servers)?;
    if was_stdio {
        super::mcp_stdio::evict(name);
    }

    let manager = settings.lock().map_err(|e| e.to_string())?;
    let disabled: Vec<String> =
        serde_json::from_str(&manager.get_settings().disabled_companion_tools).unwrap_or_default();
    let kept = purge_disabled_for_server(disabled, name);
    let json = serde_json::to_string(&kept).map_err(|e| e.to_string())?;
    manager
        .set_setting("disabled_companion_tools", &json)
        .map_err(|e| format!("清理工具开关残留失败: {}", e))?;
    log::info!("第三方 MCP server「{}」已删除", name);
    Ok(())
}

/// 过滤掉属于某 server 的禁用项（`{server}__{tool}` 前缀匹配）
fn purge_disabled_for_server(disabled: Vec<String>, server_name: &str) -> Vec<String> {
    let prefix = format!("{}__", server_name);
    disabled
        .into_iter()
        .filter(|t| !t.starts_with(&prefix))
        .collect()
}

// ── 聊天接线：工具合并、前缀路由、调用执行 ──────────────────

/// 外部工具的聊天内全名：`{server}__{tool}`（slug 不含 `__`，前缀切分无歧义）
pub fn prefixed_tool_name(server: &str, tool: &str) -> String {
    format!("{}__{}", server, tool)
}

/// 从 AppHandle 读配置（场景聊天循环用；与 tools::disabled_tools 同一姿势）
pub fn load_from_app(app_handle: &tauri::AppHandle) -> Vec<ExternalMcpServer> {
    use tauri::Manager;
    app_handle
        .try_state::<crate::commands::settings::SettingsState>()
        .map(|s| load(&s.0))
        .unwrap_or_default()
}

/// 前缀路由：解析 `{server}__{tool}` → (server 配置, 工具名)。
/// slug 不允许含 `__`（导入校验），split_once 切第一个即无歧义。
pub fn resolve_prefixed<'a>(
    servers: &'a [ExternalMcpServer],
    prefixed: &str,
) -> Option<(&'a ExternalMcpServer, String)> {
    let (server_name, tool_name) = prefixed.split_once("__")?;
    let server = servers.iter().find(|s| s.name == server_name)?;
    Some((server, tool_name.to_string()))
}

/// 执行外部工具调用。所有结局都转成回给模型的文本（裁决 6：错误文本回模型），
/// 结果一律包裹隔离标记（裁决 3：外部数据不可信）。
/// 每次调用（含拦截与失败）落一行 mcp_tool_calls 日志——MCP 设置页 per-server 日志弹窗。
pub async fn call_external_tool(
    app_handle: &tauri::AppHandle,
    prefixed_name: &str,
    args: Value,
) -> String {
    let started = std::time::Instant::now();
    let servers = load_from_app(app_handle);
    let resolved = resolve_prefixed(&servers, prefixed_name);
    // 日志与隔离标记共用的身份信息（路由失败时退化取前缀段）
    let server_name = resolved
        .as_ref()
        .map(|(s, _)| s.name.clone())
        .unwrap_or_else(|| prefixed_name.split("__").next().unwrap_or("?").to_string());
    let tool_label = resolved
        .as_ref()
        .map(|(_, t)| t.clone())
        .unwrap_or_else(|| "unknown".to_string());
    // 提前 clone 成 owned：match 里的 spawn_blocking 闭包要求 'static，
    // 不能持有 servers 的借用跨 await
    let resolved_owned = resolved.map(|(s, t)| (s.clone(), t.clone()));
    let mut status = "ok";
    let text = match resolved_owned {
        None => {
            status = "error";
            format!("外部工具「{}」无法路由：server 不存在（可能已被删除）", prefixed_name)
        }
        Some((server, tool_name)) => {
            if !server.enabled {
                status = "error";
                format!("外部服务「{}」已停用，工具不可用", server.name)
            } else if super::tools::disabled_tools(app_handle)
                .iter()
                .any(|n| n == prefixed_name)
            {
                // 工具级开关双检：聊天开局合并清单后被关的工具，调用侧仍拦
                status = "error";
                format!("工具「{}」已被用户在设置中关闭", prefixed_name)
            } else if !server.tools.iter().any(|t| t.name == tool_name) {
                status = "error";
                format!(
                    "工具「{}」不在 server「{}」的快照里（server 端可能已变更，可在 MCP 设置页刷新工具）",
                    tool_name, server.name
                )
            } else if server.transport == "stdio" {
                // 同步进程 IO 包 blocking；注册表内自建会话复用
                let s = server.clone();
                let (tool_name, args) = (tool_name.clone(), args.clone());
                let text = tauri::async_runtime::spawn_blocking(move || {
                    super::mcp_stdio::call_stdio_tool(&s, &tool_name, args)
                })
                .await
                .unwrap_or_else(|e| format!("（stdio 执行任务失败：{}）", e));
                if text.starts_with("（stdio server 调用失败") {
                    status = "error";
                }
                text
            } else {
                let headers = server
                    .headers
                    .iter()
                    .map(|kv| (kv.key.clone(), kv.value.clone()))
                    .collect();
                match McpHttpClient::new(&server.url, headers) {
                    Ok(mut client) => match client.connect().await {
                        Ok(_) => match client.call_tool(&tool_name, args).await {
                            Ok(r) => {
                                if r.is_error {
                                    status = "error";
                                    format!("（server 返回错误）\n{}", r.text)
                                } else {
                                    r.text
                                }
                            }
                            Err(e) => {
                                status = "error";
                                format!("（调用失败：{}）", e)
                            }
                        },
                        Err(e) => {
                            status = "error";
                            format!("（连接失败：{}）", e)
                        }
                    },
                    Err(e) => {
                        status = "error";
                        format!("（配置错误：{}）", e)
                    }
                }
            }
        }
    };
    let duration_ms = started.elapsed().as_millis() as i64;
    // 落调用日志（拿不到库/开不了连接不致命——日志是观测，不是主链路；
    // 同步 DB 写包 blocking 不占 tokio worker，busy 最多等 3s——CASE-001 M1）
    use tauri::Manager;
    if let Some(db_path) = app_handle
        .try_state::<crate::db::DatabaseState>()
        .map(|s| s.0.clone())
    {
        let result_len = text.len();
        let log_server = server_name.clone();
        let log_tool = tool_label.clone();
        let log_status = status.to_string();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            if let Ok(conn) = rusqlite::Connection::open(&db_path) {
                let _ = conn.busy_timeout(std::time::Duration::from_secs(3));
                let _ = super::db::insert_mcp_tool_call(
                    &conn,
                    &log_server,
                    &log_tool,
                    &log_status,
                    duration_ms,
                    result_len,
                );
            }
        })
        .await;
    }
    log::info!(
        "外部工具调用 {}（status={}）→ {} 字符，{}ms",
        prefixed_name,
        status,
        text.len(),
        duration_ms
    );
    format!(
        "<external_tool_result server=\"{}\" untrusted>\n{}\n</external_tool_result>",
        server_name, text
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_rules() {
        assert!(is_valid_slug("fetch"));
        assert!(is_valid_slug("my-server_2"));
        assert!(!is_valid_slug(""));
        assert!(!is_valid_slug("中文名"));
        assert!(!is_valid_slug("a b"));
        assert!(!is_valid_slug("a__b"), "双下划线与前缀分隔符冲突");
        assert!(!is_valid_slug(&"x".repeat(65)));
    }

    #[test]
    fn serde_tolerates_minimal_json() {
        // 手编/旧版配置缺字段也能读（default 兜底）
        let servers: Vec<ExternalMcpServer> =
            serde_json::from_str(r#"[{"name":"a","url":"https://x/mcp"}]"#).unwrap();
        assert_eq!(servers[0].transport, "http");
        assert!(servers[0].enabled);
        assert!(!servers[0].connected);
        assert!(servers[0].tools.is_empty());
        assert!(servers[0].headers.is_empty());
    }

    #[test]
    fn snapshot_drops_nameless_entries() {
        let raw = vec![
            serde_json::json!({"name":"ok","description":"d","inputSchema":{"type":"object"}}),
            serde_json::json!({"description":"没名字"}),
        ];
        let snaps = snapshot_tools(raw);
        assert_eq!(snaps.len(), 1);
        assert_eq!(snaps[0].name, "ok");
        assert!(snaps[0].input_schema.is_object());
    }

    #[test]
    fn purge_only_removes_that_server_prefix() {
        let disabled = vec![
            "fetch__get".to_string(),
            "fetch__post".to_string(),
            "web_search".to_string(),   // 内置工具不受影响
            "fetch2__get".to_string(),  // 前缀相似但不等——必须 startswith "fetch__"
        ];
        let kept = purge_disabled_for_server(disabled, "fetch");
        assert_eq!(kept, vec!["web_search", "fetch2__get"]);
    }

    #[test]
    fn info_never_carries_secret_values() {
        let server = ExternalMcpServer {
            name: "a".to_string(),
            display_name: String::new(),
            description: String::new(),
            transport: "http".to_string(),
            url: "https://x/mcp".to_string(),
            headers: vec![KeyValue {
                key: "Authorization".to_string(),
                value: "Bearer secret".to_string(),
            }],
            command: String::new(),
            args: vec![],
            env: vec![],
            enabled: true,
            connected: false,
            last_error: String::new(),
            tools: Vec::new(),
        };
        let json = serde_json::to_value(server.to_info()).unwrap();
        assert_eq!(json["has_secret"], true);
        // 凭据 key 按归属拆分：headers 的 Authorization 只进 header_entries，不进 env_entries
        assert_eq!(json["header_entries"][0], "Authorization");
        assert_eq!(json["env_entries"].as_array().map(Vec::len), Some(0));
        let s = json.to_string();
        assert!(!s.contains("Bearer secret"), "凭据值绝不下发前端");
    }

    #[test]
    fn parse_entry_http_with_headers() {
        let server = parse_server_entry(
            r#"{"fetch": {"url": "https://x.com/mcp", "headers": {"Authorization": "Bearer t"}, "description": "抓取"}}"#,
        )
        .unwrap();
        assert_eq!(server.name, "fetch");
        assert_eq!(server.transport, "http");
        assert_eq!(server.url, "https://x.com/mcp");
        assert_eq!(server.description, "抓取");
        assert_eq!(
            server.headers,
            vec![KeyValue {
                key: "Authorization".to_string(),
                value: "Bearer t".to_string()
            }]
        );
    }

    #[test]
    fn parse_entry_stdio_npx() {
        let server = parse_server_entry(
            r#"{"context7": {"command": "npx", "args": ["-y", "@upstash/context7-mcp", "--api-key", "k"], "env": {"DEBUG": "1"}}}"#,
        )
        .unwrap();
        assert_eq!(server.transport, "stdio");
        assert_eq!(server.command, "npx");
        assert_eq!(server.args.len(), 4);
        assert_eq!(server.env[0].key, "DEBUG");
    }

    #[test]
    fn parse_entry_rejects_multi_and_bare() {
        assert!(parse_server_entry(r#"{"a": {"url": "x"}, "b": {"url": "y"}}"#).is_err());
        assert!(parse_server_entry(r#"{"a": {"nothing": 1}}"#).is_err());
        assert!(parse_server_entry("not json").is_err());
    }

    #[test]
    fn merge_kv_keeps_blank_values_and_drops_removed_keys() {
        let old = vec![
            KeyValue { key: "A".to_string(), value: "old-a".to_string() },
            KeyValue { key: "B".to_string(), value: "old-b".to_string() },
        ];
        // A 留空=保留旧值；B 不在 incoming=清除；C 新值=添加；空 key 丢弃
        let incoming = vec![
            KeyValue { key: "A".to_string(), value: String::new() },
            KeyValue { key: "C".to_string(), value: "new-c".to_string() },
            KeyValue { key: String::new(), value: "x".to_string() },
        ];
        let merged = merge_kv(old, incoming);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].key, "A");
        assert_eq!(merged[0].value, "old-a", "留空保留旧值");
        assert_eq!(merged[1].key, "C");
        assert_eq!(merged[1].value, "new-c");
    }

    #[test]
    fn validate_config_transport_checks() {
        let http = ExternalMcpServer {
            name: "a".to_string(),
            transport: "http".to_string(),
            url: "".to_string(),
            ..Default::default()
        };
        assert!(validate_config(&http).is_err());
        let stdio = ExternalMcpServer {
            name: "b".to_string(),
            transport: "stdio".to_string(),
            command: String::new(),
            ..Default::default()
        };
        assert!(validate_config(&stdio).is_err());
        let bogus = ExternalMcpServer {
            name: "c".to_string(),
            transport: "sse".to_string(),
            ..Default::default()
        };
        assert!(validate_config(&bogus).is_err());
    }
}
