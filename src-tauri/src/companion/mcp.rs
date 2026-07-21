//! Companion MCP server：把应用数据能力以 MCP 工具暴露给 Claude Code agent。
//!
//! 协议：MCP over stdio，换行分隔的 JSON-RPC 2.0 消息。
//! 只实现 agent 需要的最小子集：initialize / ping / tools/list / tools/call。
//!
//! 注意：stdout 只允许写协议消息，任何日志必须走 stderr，
//! 否则会破坏与 claude CLI 的协议通信。

use std::io::{BufRead, Write};
use std::path::PathBuf;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::{analyzer, db};

const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "companion";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

/// write_note 工具被限制在该目录前缀下，防止 agent 越权写其他笔记
const NOTE_DIR_PREFIX: &str = "陪伴日报";

/// MCP server 入口：阻塞式读取 stdin 直到 EOF（claude CLI 关闭管道时退出）
pub fn run_mcp_server(db_path: PathBuf, notes_dir: PathBuf) {
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

fn tools_list() -> Value {
    json!({
        "tools": [
            {
                "name": "get_activity_summary",
                "description": "获取某天的电脑使用聚合摘要（各应用时长 Top 和时间线）。不传 date 默认为今天。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "date": {
                            "type": "string",
                            "description": "日期，格式 YYYY-MM-DD，默认今天"
                        }
                    }
                }
            },
            {
                "name": "search_clipboard",
                "description": "检索剪贴板历史（仅文本），按时间倒序返回。可用于了解用户近期复制过的内容主题。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "可选关键词，模糊匹配内容"
                        },
                        "limit": {
                            "type": "integer",
                            "description": "返回条数，默认 10，最多 30"
                        }
                    }
                }
            },
            {
                "name": "get_habit_patterns",
                "description": "获取已学习到的工作习惯模式列表（应用组合、时间窗、置信度）。",
                "inputSchema": { "type": "object", "properties": {} }
            },
            {
                "name": "get_memory_facts",
                "description": "获取关于用户的持久事实记忆（同事称呼、项目、偏好等）。写日报或给建议前应该参考，让内容更贴合用户本人。",
                "inputSchema": { "type": "object", "properties": {} }
            },
            {
                "name": "write_note",
                "description": format!(
                    "把内容写入笔记模块的「{}」目录（自动加 .md 后缀）。filename 只给名字，不要带路径。",
                    NOTE_DIR_PREFIX
                ),
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "filename": {
                            "type": "string",
                            "description": "笔记文件名（不含目录和扩展名），如 2026-07-20"
                        },
                        "content": {
                            "type": "string",
                            "description": "笔记完整内容（Markdown）"
                        }
                    },
                    "required": ["filename", "content"]
                }
            },
            {
                "name": "create_suggestion",
                "description": "创建一条建议记录，会出现在用户的建议列表中（不会实时弹窗）。用于你发现值得提醒用户的事情。",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "description": "建议标题（一句话）" },
                        "body": { "type": "string", "description": "建议详情（可选）" }
                    },
                    "required": ["title"]
                }
            }
        ]
    })
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

        let result = match name {
            "get_activity_summary" => self.tool_activity_summary(&args),
            "search_clipboard" => self.tool_search_clipboard(&args),
            "get_habit_patterns" => self.tool_habit_patterns(),
            "get_memory_facts" => self.tool_memory_facts(),
            "write_note" => self.tool_write_note(&args),
            "create_suggestion" => self.tool_create_suggestion(&args),
            _ => Err(format!("未知工具: {}", name)),
        };

        match result {
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

    fn open_db(&self) -> Result<Connection, String> {
        Connection::open(&self.db_path).map_err(|e| format!("打开数据库失败: {}", e))
    }

    fn tool_activity_summary(&self, args: &Value) -> Result<String, String> {
        let date = args
            .get("date")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| chrono::Local::now().format("%Y-%m-%d").to_string());

        let conn = self.open_db()?;
        analyzer::aggregate_day(&conn, &date)
    }

    fn tool_search_clipboard(&self, args: &Value) -> Result<String, String> {
        let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
        let limit = args
            .get("limit")
            .and_then(|v| v.as_i64())
            .unwrap_or(10)
            .clamp(1, 30);

        let conn = self.open_db()?;

        let (sql, params_vec): (String, Vec<Box<dyn rusqlite::ToSql>>) = if query.is_empty() {
            (
                "SELECT content, created_at FROM clipboard_history
                 WHERE content_type = 'text'
                 ORDER BY id DESC LIMIT ?1"
                    .to_string(),
                vec![Box::new(limit)],
            )
        } else {
            (
                "SELECT content, created_at FROM clipboard_history
                 WHERE content_type = 'text' AND content LIKE ?1
                 ORDER BY id DESC LIMIT ?2"
                    .to_string(),
                vec![
                    Box::new(format!("%{}%", query)) as Box<dyn rusqlite::ToSql>,
                    Box::new(limit),
                ],
            )
        };

        let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("查询剪贴板失败: {}", e))?;
        let rows = stmt
            .query_map(&param_refs[..], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("查询剪贴板失败: {}", e))?;

        let mut items = Vec::new();
        for row in rows {
            let (content, created_at) = row.map_err(|e| e.to_string())?;
            let preview: String = content.chars().take(200).collect();
            items.push(json!({ "time": created_at, "preview": preview }));
        }

        if items.is_empty() {
            return Ok("剪贴板历史中没有匹配的文本记录".to_string());
        }
        serde_json::to_string_pretty(&items).map_err(|e| e.to_string())
    }

    fn tool_habit_patterns(&self) -> Result<String, String> {
        let conn = self.open_db()?;
        let patterns = db::list_patterns(&conn).map_err(|e| format!("查询模式失败: {}", e))?;

        let active: Vec<Value> = patterns
            .into_iter()
            .filter(|p| p.status != "dismissed")
            .map(|p| {
                json!({
                    "type": p.pattern_type,
                    "description": p.description,
                    "data": serde_json::from_str::<Value>(&p.pattern_data).unwrap_or(Value::Null),
                    "confidence": p.confidence,
                    "occurrences": p.occurrences,
                    "status": p.status
                })
            })
            .collect();

        if active.is_empty() {
            return Ok("还没有学到任何习惯模式".to_string());
        }
        serde_json::to_string_pretty(&active).map_err(|e| e.to_string())
    }

    fn tool_memory_facts(&self) -> Result<String, String> {
        let conn = self.open_db()?;
        let facts = db::list_memory_facts(&conn, 30).map_err(|e| format!("查询记忆失败: {}", e))?;

        if facts.is_empty() {
            return Ok("还没有沉淀关于用户的事实记忆".to_string());
        }

        let items: Vec<Value> = facts
            .into_iter()
            .map(|f| {
                json!({
                    "fact": f.fact,
                    "category": f.category,
                    "confirmations": f.confirmations
                })
            })
            .collect();
        serde_json::to_string_pretty(&items).map_err(|e| e.to_string())
    }

    fn tool_write_note(&self, args: &Value) -> Result<String, String> {
        let filename = args
            .get("filename")
            .and_then(|v| v.as_str())
            .ok_or("缺少参数 filename")?;
        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or("缺少参数 content")?;

        // 安全：filename 只允许纯名字，过滤路径分隔符和父目录引用
        let sanitized: String = filename
            .chars()
            .map(|c| match c {
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
                _ => c,
            })
            .collect();
        let sanitized = sanitized.replace("..", "-").trim().to_string();
        if sanitized.is_empty() {
            return Err("filename 无效".to_string());
        }

        let relative = format!("{}/{}.md", NOTE_DIR_PREFIX, sanitized);
        let manager = crate::notes::NotesManager::new(self.notes_dir.clone());
        manager
            .write_note(&relative, content)
            .map_err(|e| format!("写入笔记失败: {}", e))?;

        Ok(format!("已写入笔记: {}", relative))
    }

    fn tool_create_suggestion(&self, args: &Value) -> Result<String, String> {
        let title = args
            .get("title")
            .and_then(|v| v.as_str())
            .ok_or("缺少参数 title")?;
        let body = args.get("body").and_then(|v| v.as_str());

        if title.trim().is_empty() {
            return Err("title 不能为空".to_string());
        }

        let conn = self.open_db()?;
        let now = chrono::Local::now().timestamp();
        let suggestion = db::create_suggestion(&conn, "agent_insight", title, body, None, now)
            .map_err(|e| format!("创建建议失败: {}", e))?;

        Ok(format!(
            "建议已记录（id: {}），会显示在用户的建议列表中",
            suggestion.id
        ))
    }
}
