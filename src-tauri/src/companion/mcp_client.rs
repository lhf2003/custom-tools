//! 第三方 MCP server 的 HTTP client（streamable HTTP，协议最小子集）。
//!
//! 与 mcp.rs 服务端对称：只实现 initialize / tools/list / tools/call 三个方法
//! （外加 notifications/initialized 通知）。裁决要点（二期设计文档）：
//! - 30s 固定超时、工具结果统一截 16KB（防爆上下文与 token 账单）
//! - 错误文本当工具结果回模型（is_error 透出，由聊天接线层包裹隔离标记）
//! - 老式 SSE 传输（GET 长连 + endpoint 事件，2024-11-05 形态）不支持：
//!   粘贴 /sse 结尾地址时明确报错，引导改用 /mcp streamable 端点
//!
//! streamable HTTP 要点：POST 单端点；响应可以是 application/json 或
//! text/event-stream（SSE 帧流，取匹配 id 的一帧）；initialize 响应可能带
//! Mcp-Session-Id 头，后续请求必须回传；session 失效（404）重初始化一次再试。

use serde_json::{json, Value};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(30);
/// 单个工具结果的最大字节数（超出截断并标注）
const MAX_RESULT_BYTES: usize = 16 * 1024;
/// streamable HTTP 传输由 2025-03-26 版协议引入
const PROTOCOL_VERSION: &str = "2025-03-26";

/// 工具调用结果（text 已截断；is_error 透出 server 侧错误标记）
#[derive(Debug)]
pub struct ToolCallResult {
    pub text: String,
    pub is_error: bool,
}

/// 会话失效需要重初始化（内部错误类型，对外统一 String）
enum RpcError {
    SessionExpired,
    Other(String),
}

impl From<RpcError> for String {
    fn from(e: RpcError) -> String {
        match e {
            RpcError::SessionExpired => "会话失效".to_string(),
            RpcError::Other(m) => m,
        }
    }
}

pub struct McpHttpClient {
    url: String,
    token: Option<String>,
    http: reqwest::Client,
    session_id: Option<String>,
    next_id: u64,
}

impl McpHttpClient {
    /// 构造并做入口校验：仅 http/https；/sse 结尾的老式端点明确拒绝
    pub fn new(url: &str, token: Option<String>) -> Result<Self, String> {
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err("仅支持 http/https 地址".to_string());
        }
        let path = url.split('?').next().unwrap_or(url);
        if path.ends_with("/sse") {
            return Err(
                "这是老式 SSE 端点（长连传输），二期暂不支持；请改用 /mcp 结尾的 streamable HTTP 地址"
                    .to_string(),
            );
        }
        // 统一走 http 工厂：系统代理开关对所有对外请求一致生效
        let http = crate::http::build_client(TIMEOUT)?;
        Ok(Self {
            url: url.to_string(),
            token,
            http,
            session_id: None,
            next_id: 1,
        })
    }

    /// initialize + notifications/initialized。返回 serverInfo（导入验证展示用）
    pub async fn connect(&mut self) -> Result<Value, String> {
        let result = self
            .rpc(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": { "name": "flowhub", "version": env!("CARGO_PKG_VERSION") }
                }),
            )
            .await
            .map_err(String::from)?;
        // 初始化通知无响应体（202），失败不致命——有的 server 不校验
        let _ = self.notify("notifications/initialized").await;
        Ok(result.get("serverInfo").cloned().unwrap_or(Value::Null))
    }

    /// tools/list → 工具数组（原始 JSON，快照由调用方存储）
    pub async fn list_tools(&mut self) -> Result<Vec<Value>, String> {
        let result = self.rpc_auto_reinit("tools/list", json!({})).await?;
        result
            .get("tools")
            .and_then(|t| t.as_array())
            .cloned()
            .ok_or_else(|| "tools/list 响应缺少 tools 数组".to_string())
    }

    /// tools/call：提取 content 文本（多段拼接），统一截断
    pub async fn call_tool(&mut self, name: &str, args: Value) -> Result<ToolCallResult, String> {
        let result = self
            .rpc_auto_reinit("tools/call", json!({ "name": name, "arguments": args }))
            .await?;
        let is_error = result
            .get("isError")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let text = extract_result_text(&result);
        Ok(ToolCallResult {
            text: truncate_tool_result(&text),
            is_error,
        })
    }

    /// 会话失效（托管 server 被回收）时重初始化一次再试——modelscope 空闲回收是已知行为
    async fn rpc_auto_reinit(&mut self, method: &str, params: Value) -> Result<Value, String> {
        match self.rpc(method, params.clone()).await {
            Ok(v) => Ok(v),
            Err(RpcError::SessionExpired) => {
                self.connect().await?;
                self.rpc(method, params).await.map_err(String::from)
            }
            Err(RpcError::Other(m)) => Err(m),
        }
    }

    async fn rpc(&mut self, method: &str, params: Value) -> Result<Value, RpcError> {
        let id = self.next_id;
        self.next_id += 1;
        let body = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let resp = self.post(body).await?;
        if resp.status().as_u16() == 404 && self.session_id.is_some() {
            // 带 session 的 404 = 会话失效（协议约定），触发重初始化
            self.session_id = None;
            return Err(RpcError::SessionExpired);
        }
        let status = resp.status();
        if !status.is_success() {
            let excerpt = resp.text().await.unwrap_or_default();
            return Err(RpcError::Other(format!(
                "HTTP {} {}",
                status.as_u16(),
                excerpt.chars().take(200).collect::<String>()
            )));
        }
        self.capture_session(&resp);
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let body = resp
            .text()
            .await
            .map_err(|e| RpcError::Other(format!("读取响应失败: {}", e)))?;
        parse_response_body(&content_type, &body, id).map_err(RpcError::Other)
    }

    async fn notify(&mut self, method: &str) -> Result<(), RpcError> {
        let body = json!({ "jsonrpc": "2.0", "method": method });
        let resp = self.post(body).await?;
        // 通知：202 Accepted 无响应体即可；404 说明 session 已失效（下一次 rpc 会重建）
        if resp.status().as_u16() == 404 && self.session_id.is_some() {
            self.session_id = None;
            return Err(RpcError::SessionExpired);
        }
        self.capture_session(&resp);
        Ok(())
    }

    async fn post(&self, body: Value) -> Result<reqwest::Response, RpcError> {
        let mut req = self
            .http
            .post(&self.url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(
                reqwest::header::ACCEPT,
                "application/json, text/event-stream",
            )
            .json(&body);
        if let Some(token) = &self.token {
            if !token.is_empty() {
                req = req.bearer_auth(token);
            }
        }
        if let Some(sid) = &self.session_id {
            req = req.header("Mcp-Session-Id", sid.as_str());
        }
        req.send().await.map_err(|e| {
            RpcError::Other(if e.is_timeout() {
                format!("调用超时（{}s）", TIMEOUT.as_secs())
            } else {
                format!("网络请求失败: {}", e)
            })
        })
    }

    fn capture_session(&mut self, resp: &reqwest::Response) {
        if let Some(v) = resp.headers().get("Mcp-Session-Id") {
            if let Ok(s) = v.to_str() {
                self.session_id = Some(s.to_string());
            }
        }
    }
}

/// 提取 tools/call 结果文本：content 数组的 text 段拼接；
/// content 为空但有 structuredContent 时序列化兜底
fn extract_result_text(result: &Value) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if let Some(content) = result.get("content").and_then(|c| c.as_array()) {
        for item in content {
            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = item.get("text").and_then(|t| t.as_str()) {
                    parts.push(t);
                }
            }
        }
    }
    if !parts.is_empty() {
        return parts.join("\n");
    }
    result
        .get("structuredContent")
        .map(|s| serde_json::to_string_pretty(s).unwrap_or_default())
        .unwrap_or_default()
}

/// 截断工具结果到 16KB（按 char boundary 截，标注原始大小）
fn truncate_tool_result(text: &str) -> String {
    if text.len() <= MAX_RESULT_BYTES {
        return text.to_string();
    }
    let mut end = MAX_RESULT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}…\n[结果过长已截断：原始约 {}KB]",
        &text[..end],
        text.len() / 1024
    )
}

/// 解析 streamable HTTP 响应体：application/json 直接解析；
/// text/event-stream 逐帧扫描，取 id 匹配的一帧（容忍 CRLF、注释行、多行 data）
fn parse_response_body(content_type: &str, body: &str, want_id: u64) -> Result<Value, String> {
    if content_type.contains("text/event-stream") {
        for frame in sse_data_frames(body) {
            let Ok(msg) = serde_json::from_str::<Value>(&frame) else {
                continue;
            };
            if msg.get("id").and_then(|v| v.as_u64()) == Some(want_id) {
                return unwrap_rpc_envelope(msg);
            }
        }
        return Err("SSE 响应中没有匹配本请求的帧".to_string());
    }
    let msg: Value =
        serde_json::from_str(body).map_err(|e| format!("响应不是合法 JSON: {}", e))?;
    unwrap_rpc_envelope(msg)
}

/// 收集 SSE 帧的 data 载荷（帧间空行分隔；帧内多行 data 拼接；冒号开头的注释行忽略）
fn sse_data_frames(body: &str) -> Vec<String> {
    let mut frames = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    for line in body.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            if !current.is_empty() {
                frames.push(current.join("\n"));
                current.clear();
            }
        } else if line.starts_with(':') {
            // keepalive 注释
        } else if let Some(data) = line.strip_prefix("data:") {
            current.push(data.strip_prefix(' ').unwrap_or(data));
        }
        // event:/id:/retry: 字段不需要——MCP 只用 message 事件
    }
    if !current.is_empty() {
        frames.push(current.join("\n"));
    }
    frames
}

/// 解 JSON-RPC 信封：error 字段转人话错误，否则取 result
fn unwrap_rpc_envelope(msg: Value) -> Result<Value, String> {
    if let Some(err) = msg.get("error") {
        let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
        let message = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("未知错误");
        return Err(format!("RPC 错误 {}: {}", code, message));
    }
    Ok(msg.get("result").cloned().unwrap_or(Value::Null))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_json_response() {
        let body = r#"{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}"#;
        let v = parse_response_body("application/json", body, 1).unwrap();
        assert!(v.get("tools").unwrap().is_array());
    }

    #[test]
    fn parses_sse_response_picking_matching_id() {
        let body = ": keepalive\n\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":99,\"result\":{}}\n\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n\n";
        let v = parse_response_body("text/event-stream", body, 1).unwrap();
        assert_eq!(v["ok"], true);
    }

    #[test]
    fn tolerates_crlf_and_multiline_data() {
        let body = "data: {\"jsonrpc\":\"2.0\",\r\ndata: \"id\":2,\"result\":{\"x\":1}}\r\n\r\n";
        let v = parse_response_body("text/event-stream; charset=utf-8", body, 2).unwrap();
        assert_eq!(v["x"], 1);
    }

    #[test]
    fn sse_without_matching_frame_errors() {
        let body = "data: {\"jsonrpc\":\"2.0\",\"id\":5,\"result\":{}}\n\n";
        assert!(parse_response_body("text/event-stream", body, 1).is_err());
    }

    #[test]
    fn rpc_error_envelope_becomes_message() {
        let body = r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"Method not found"}}"#;
        let err = parse_response_body("application/json", body, 1).unwrap_err();
        assert!(err.contains("-32601") && err.contains("Method not found"));
    }

    #[test]
    fn truncates_over_limit_at_char_boundary() {
        let short = "短结果";
        assert_eq!(truncate_tool_result(short), short);
        // 多字节字符跨界：16KB 处恰好在某个汉字中间
        let big = "汉".repeat(MAX_RESULT_BYTES); // 每字 3 字节，必跨界
        let out = truncate_tool_result(&big);
        assert!(out.contains("已截断"));
        let kept = out.trim_end_matches(|c| c != '汉');
        assert!(kept.len() <= MAX_RESULT_BYTES);
        assert_eq!(kept.len() % 3, 0, "必须在字符边界截断");
    }

    #[test]
    fn extract_text_joins_parts_and_falls_back_to_structured() {
        let r = json!({"content":[{"type":"text","text":"a"},{"type":"image"},{"type":"text","text":"b"}]});
        assert_eq!(extract_result_text(&r), "a\nb");
        let r2 = json!({"structuredContent":{"temp":25}});
        assert!(extract_result_text(&r2).contains("temp"));
        assert_eq!(extract_result_text(&json!({})), "");
    }

    #[test]
    fn rejects_sse_suffix_and_non_http() {
        assert!(McpHttpClient::new("https://x.com/abc/sse", None).is_err());
        assert!(McpHttpClient::new("ftp://x.com/mcp", None).is_err());
        assert!(McpHttpClient::new("https://x.com/abc/mcp", None).is_ok());
    }
}
