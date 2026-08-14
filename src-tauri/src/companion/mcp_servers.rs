//! 第三方 MCP server 的配置存储与管理（二期刀②）。
//!
//! 配置存 settings 表 KV `mcp_external_servers`（JSON 数组，裁决 4）；
//! token 明文本地存（Claude Desktop 同姿势）且**不出后端**——
//! 给前端的 ExternalMcpServerInfo 只带 has_token 标记。
//! transport 字段预留 stdio（三期）。

use serde_json::Value;
use std::sync::Mutex;

use super::mcp_client::McpHttpClient;
use crate::settings::SettingsManager;

/// settings 表键名
pub const SETTINGS_KEY: &str = "mcp_external_servers";

/// 一份第三方 server 配置（tools 为导入/刷新时的 tools/list 快照——聊天的真相源）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExternalMcpServer {
    /// slug 标识（ASCII [a-zA-Z0-9_-]，做工具名前缀，受 OpenAI function name 约束）
    pub name: String,
    #[serde(default)]
    pub display_name: String,
    #[serde(default = "default_transport")]
    pub transport: String,
    pub url: String,
    #[serde(default)]
    pub token: String,
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

/// 给前端的 server 视图（token 不下发，只有 has_token 标记）
#[derive(Debug, serde::Serialize)]
pub struct ExternalMcpServerInfo {
    pub name: String,
    pub display_name: String,
    pub url: String,
    pub enabled: bool,
    pub connected: bool,
    pub last_error: String,
    pub has_token: bool,
    pub tools: Vec<ExternalToolBrief>,
}

#[derive(Debug, serde::Serialize)]
pub struct ExternalToolBrief {
    pub name: String,
    pub description: String,
}

impl ExternalMcpServer {
    fn to_info(&self) -> ExternalMcpServerInfo {
        ExternalMcpServerInfo {
            name: self.name.clone(),
            display_name: self.display_name.clone(),
            url: self.url.clone(),
            enabled: self.enabled,
            connected: self.connected,
            last_error: self.last_error.clone(),
            has_token: !self.token.is_empty(),
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

/// 连接验证：initialize + tools/list 抓快照。成功返回 (serverInfo, 工具快照)
async fn probe(url: &str, token: &str) -> Result<(Value, Vec<ExternalToolSnapshot>), String> {
    let mut client = McpHttpClient::new(url, Some(token.to_string()))?;
    let server_info = client.connect().await?;
    let tools = snapshot_tools(client.list_tools().await?);
    Ok((server_info, tools))
}

/// 导入：slug/URL 校验 → 同名拒绝 → 强制连通验证。
/// 验证失败且 force=false → 报错（前端确认「仍然保存」后以 force=true 重调，
/// 存为 connected=false + last_error）。
/// 注意：锁不跨 await——校验/读取与保存各自独立加锁（Tauri command 要求 Send）。
pub async fn import(
    settings: &Mutex<SettingsManager>,
    name: String,
    display_name: String,
    url: String,
    token: String,
    force: bool,
) -> Result<ExternalMcpServerInfo, String> {
    if !is_valid_slug(&name) {
        return Err(format!(
            "标识名「{}」不合法：仅限字母/数字/下划线/连字符，且不能包含连续双下划线",
            name
        ));
    }
    if load(settings).iter().any(|s| s.name == name) {
        return Err(format!("已存在同名 server「{}」，请换个标识名", name));
    }

    let (connected, last_error, tools) = match probe(&url, &token).await {
        Ok((_, tools)) => (true, String::new(), tools),
        Err(e) => {
            if !force {
                return Err(format!("连接验证失败：{}", e));
            }
            (false, e, Vec::new())
        }
    };

    let server = ExternalMcpServer {
        display_name: display_name.trim().to_string(),
        name: name.clone(),
        transport: default_transport(),
        url: url.trim().to_string(),
        token: token.trim().to_string(),
        enabled: true,
        connected,
        last_error,
        tools,
    };
    let info = server.to_info();
    let mut servers = load(settings);
    servers.push(server);
    save(settings, &servers)?;
    log::info!(
        "第三方 MCP server「{}」已导入（connected={}, 工具 {} 个）",
        name,
        info.connected,
        info.tools.len()
    );
    Ok(info)
}

/// 刷新：重新 initialize + 重抓 tools/list 快照。
/// 失败保留旧快照（还能用），只更新 connected/last_error。
pub async fn refresh(
    settings: &Mutex<SettingsManager>,
    name: &str,
) -> Result<ExternalMcpServerInfo, String> {
    let servers = load(settings);
    let Some(existing) = servers.iter().find(|s| s.name == name) else {
        return Err(format!("server「{}」不存在", name));
    };
    let (url, token) = (existing.url.clone(), existing.token.clone());
    drop(servers);

    let probed = probe(&url, &token).await;

    let mut servers = load(settings);
    let Some(server) = servers.iter_mut().find(|s| s.name == name) else {
        return Err(format!("server「{}」不存在", name));
    };
    match probed {
        Ok((_, tools)) => {
            server.connected = true;
            server.last_error.clear();
            server.tools = tools;
        }
        Err(e) => {
            server.connected = false;
            server.last_error = e;
        }
    }
    let info = server.to_info();
    save(settings, &servers)?;
    Ok(info)
}

/// 总开关：关闭后其下工具全部不进聊天循环（即使工具级开关开着）
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
    save(settings, &servers)
}

/// 删除：同时清掉 disabled_companion_tools 里该 server 的工具开关残留
/// （前缀 `name__` 匹配；保留则重导入同名 server 时旧开关复活——行为不确定）
pub fn delete(settings: &Mutex<SettingsManager>, name: &str) -> Result<(), String> {
    let mut servers = load(settings);
    let before = servers.len();
    servers.retain(|s| s.name != name);
    if servers.len() == before {
        return Err(format!("server「{}」不存在", name));
    }
    save(settings, &servers)?;

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

// ── 聊天接线（刀③）：工具合并、前缀路由、调用执行 ──────────────────

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
/// 每次调用新建会话（initialize→call 共 3 个请求）——无连接池管理负担，
/// 30s 超时兜底；会话复用是性能优化，按需后做。
pub async fn call_external_tool(
    app_handle: &tauri::AppHandle,
    prefixed_name: &str,
    args: Value,
) -> String {
    let servers = load_from_app(app_handle);
    let Some((server, tool_name)) = resolve_prefixed(&servers, prefixed_name) else {
        return format!("外部工具「{}」无法路由：server 不存在（可能已被删除）", prefixed_name);
    };
    if !server.enabled {
        return format!("外部服务「{}」已停用，工具不可用", server.name);
    }
    // 工具级开关双检：聊天开局合并清单后被关的工具，调用侧仍拦
    let disabled = super::tools::disabled_tools(app_handle);
    if disabled.iter().any(|n| n == prefixed_name) {
        return format!("工具「{}」已被用户在设置中关闭", prefixed_name);
    }
    if !server.tools.iter().any(|t| t.name == tool_name) {
        return format!(
            "工具「{}」不在 server「{}」的快照里（server 端可能已变更，可在 MCP 设置页刷新工具）",
            tool_name, server.name
        );
    }

    let text = match McpHttpClient::new(&server.url, Some(server.token.clone())) {
        Ok(mut client) => match client.connect().await {
            Ok(_) => match client.call_tool(&tool_name, args).await {
                Ok(r) => {
                    if r.is_error {
                        format!("（server 返回错误）\n{}", r.text)
                    } else {
                        r.text
                    }
                }
                Err(e) => format!("（调用失败：{}）", e),
            },
            Err(e) => format!("（连接失败：{}）", e),
        },
        Err(e) => format!("（配置错误：{}）", e),
    };
    log::info!(
        "外部工具调用 {}（server={}）→ {} 字符",
        prefixed_name,
        server.name,
        text.len()
    );
    format!(
        "<external_tool_result server=\"{}\" untrusted>\n{}\n</external_tool_result>",
        server.name, text
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
    fn info_never_carries_token() {
        let server = ExternalMcpServer {
            name: "a".to_string(),
            display_name: String::new(),
            transport: "http".to_string(),
            url: "https://x/mcp".to_string(),
            token: "secret".to_string(),
            enabled: true,
            connected: false,
            last_error: String::new(),
            tools: Vec::new(),
        };
        let json = serde_json::to_value(server.to_info()).unwrap();
        assert_eq!(json["has_token"], true);
        assert!(json.get("token").is_none(), "token 绝不下发前端");
    }
}
