//! Companion MCP server：把应用数据能力以 MCP 工具暴露给 Claude Code agent。
//!
//! 协议：MCP over stdio，换行分隔的 JSON-RPC 2.0 消息。
//! 只实现 agent 需要的最小子集：initialize / ping / tools/list / tools/call。
//!
//! 工具声明与执行逻辑在 tools.rs（协议无关，场景模型通道共用）；
//! 本文件只做 MCP 协议适配。
//!
//! 注意：stdout 只允许写协议消息，任何日志必须走 stderr，
//! 否则会破坏与 claude CLI 的协议通信。

use std::io::{BufRead, Write};
use std::path::PathBuf;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::{db, tools};

const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "companion";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// write_note 工具的目录前缀限制（定义在 tools.rs，此处 re-export 保持既有引用路径）
pub(crate) use super::tools::NOTE_DIR_PREFIX;

/// MCP server 入口：阻塞式读取 stdin 直到 EOF（claude CLI 关闭管道时退出）
pub fn run_mcp_server(db_path: PathBuf, notes_dir: PathBuf) {
    // vec0 扩展必须先于任何 Connection::open 注册（remember_fact 两级流水线要走向量库）
    nervis_memory::store::register_vec_extension();
    // MCP 模式独立运行（不经过 Tauri 启动流程），需自行确保表结构就绪
    if let Ok(conn) = Connection::open(&db_path) {
        if let Err(e) = db::init_tables(&conn) {
            eprintln!("[companion-mcp] 初始化表结构失败: {}", e);
        }
    }

    let server = McpServer { db_path, notes_dir };

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }

        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("[companion-mcp] 无法解析的消息: {} — {}", e, line);
                continue;
            }
        };

        let method = msg.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let id = msg.get("id").cloned();

        match method {
            "initialize" => {
                let requested = msg
                    .pointer("/params/protocolVersion")
                    .and_then(|v| v.as_str())
                    .unwrap_or(PROTOCOL_VERSION);
                write_response(
                    &mut out,
                    &id,
                    json!({
                        "protocolVersion": requested,
                        "capabilities": { "tools": {} },
                        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION }
                    }),
                );
            }
            "ping" => write_response(&mut out, &id, json!({})),
            "tools/list" => write_response(&mut out, &id, tools_list()),
            "tools/call" => {
                let result = server.handle_tool_call(&msg);
                write_response(&mut out, &id, result);
            }
            // 通知类消息无需响应
            m if id.is_none() => {
                eprintln!("[companion-mcp] 忽略通知: {}", m);
            }
            _ => {
                write_error(
                    &mut out,
                    &id,
                    -32601,
                    &format!("Method not found: {}", method),
                );
            }
        }

        let _ = out.flush();
    }

    eprintln!("[companion-mcp] stdin 关闭，退出");
}

fn write_response(out: &mut impl Write, id: &Option<Value>, result: Value) {
    let Some(id) = id else { return };
    let msg = json!({ "jsonrpc": "2.0", "id": id, "result": result });
    let _ = writeln!(out, "{}", msg);
}

fn write_error(out: &mut impl Write, id: &Option<Value>, code: i64, message: &str) {
    let Some(id) = id else { return };
    let msg = json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    });
    let _ = writeln!(out, "{}", msg);
}

struct McpServer {
    db_path: PathBuf,
    notes_dir: PathBuf,
}

/// MCP 设置页的 server 卡片信息
#[derive(Debug, serde::Serialize)]
pub struct McpServerInfo {
    pub name: String,
    pub version: String,
    pub protocol_version: String,
    /// 对外数据面工具名清单（与 tools/list 暴露的一致）
    pub external_tools: Vec<String>,
}

/// server 卡片信息：常量 + 当前对外工具清单（读 ToolDef 的 external 标记）
pub fn server_info() -> McpServerInfo {
    McpServerInfo {
        name: SERVER_NAME.to_string(),
        version: SERVER_VERSION.to_string(),
        protocol_version: PROTOCOL_VERSION.to_string(),
        external_tools: tools::tool_definitions()
            .into_iter()
            .filter(|d| d.external)
            .map(|d| d.name.to_string())
            .collect(),
    }
}

/// MCP 格式工具清单（由协议无关的 tool_definitions 转换）
fn tools_list() -> Value {
    // 只暴露数据面工具（external 标记）；贾维斯内在状态工具（心情/经验本/
    // 手册治理/建议/读手册）仅 app 内场景通道可用，外部客户端不可见
    let tools: Vec<Value> = tools::tool_definitions()
        .into_iter()
        .filter(|d| d.external)
        .map(|d| {
            json!({
                "name": d.name,
                "description": d.description,
                "inputSchema": d.input_schema,
            })
        })
        .collect();
    json!({ "tools": tools })
}

impl McpServer {
    fn handle_tool_call(&self, msg: &Value) -> Value {
        let name = msg
            .pointer("/params/name")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let args = msg
            .pointer("/params/arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));

        eprintln!("[companion-mcp] tools/call: {}", name);

        // 调用侧同样校验 external——tools/list 的过滤只是「看不见」，
        // 直接按名 call 对内工具必须在这里被挡下（安全边界在调用侧，不在列表侧）
        let allowed = tools::tool_definitions()
            .into_iter()
            .any(|d| d.external && d.name == name);
        if !allowed {
            return json!({
                "content": [{ "type": "text", "text": format!("未知或不对外的工具: {}", name) }],
                "isError": true
            });
        }

        match tools::execute_tool(&self.db_path, &self.notes_dir, name, &args) {
            Ok(text) => json!({
                "content": [{ "type": "text", "text": text }],
                "isError": false
            }),
            Err(e) => json!({
                "content": [{ "type": "text", "text": e }],
                "isError": true
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_list_only_exposes_external() {
        let list = tools_list();
        let names: Vec<&str> = list["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t["name"].as_str())
            .collect();
        assert_eq!(names.len(), 8, "对外工具应为 8 个: {:?}", names);
        assert!(names.contains(&"get_memory_facts"));
        assert!(names.contains(&"write_note"));
        // 内在状态与危险工具绝不对外
        assert!(!names.contains(&"record_mood"));
        assert!(!names.contains(&"append_evolution"));
        assert!(!names.contains(&"run_shell_command"));
    }

    #[test]
    fn call_blocks_internal_tool_by_name() {
        // tools/list 看不见 ≠ 调不到：直接按名 call 对内工具必须被拦
        let server = McpServer {
            db_path: PathBuf::from("nonexistent.db"),
            notes_dir: PathBuf::from("."),
        };
        let msg = json!({"params": {"name": "record_mood", "arguments": {}}});
        let res = server.handle_tool_call(&msg);
        assert_eq!(res["isError"], true);
        assert!(res["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("不对外"));
    }
}
