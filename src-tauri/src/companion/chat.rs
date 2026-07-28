//! 贾维斯聊天通道：以 claude CLI 流式协议（stream-json）驱动的 agent 聊天。
//! 每条用户消息 spawn 一次 claude 进程，--resume 串起多轮上下文；
//! 助理文本经 jarvis:chunk 流式推给前端，工具活动经 jarvis:status 提示。

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use super::{analyzer, db, persona};

/// 聊天只开放 companion 数据工具：能查他的电脑使用，但碰不到文件系统
const ALLOWED_TOOLS: &str = "mcp__companion__*";
const MAX_TURNS: &str = "8";
/// claude 会话 id 的持久化 key（跨消息/跨重启续接上下文）
const SESSION_SETTING_KEY: &str = "companion_chat_claude_session";

/// 在飞的聊天子进程（单飞：新消息到来或用户取消时 kill）
#[derive(Clone, Default)]
pub struct JarvisChatChild(pub Arc<Mutex<Option<Child>>>);

/// 聊天工作区（与日报 agent 共用隔离目录：无 CLAUDE.md、无 hooks 注入）
fn chat_work_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("companion-agent");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建聊天工作区失败: {}", e))?;
    Ok(dir)
}

/// 聊天系统提示：身份证 + 经验本 + 关于他的事实（五维分组）+ 聊天场合规则。
/// with_tools=true 时用 --append-system-prompt 注入 claude agent 通道；
/// false 时为场景模型回退版（无数据工具的措辞）。
fn compose_chat_system(app_data: &Path, db_path: &Path, with_tools: bool) -> String {
    let persona_text = persona::load(app_data);
    let evolution = persona::load_evolution(app_data);
    let facts = Connection::open(db_path)
        .ok()
        .and_then(|conn| db::list_memory_facts(&conn, 50).ok())
        .unwrap_or_default();
    let facts_text = format_facts_grouped(&facts);
    let channel_rule = if with_tools {
        "涉及他电脑使用的问题（干了什么、各应用用了多久、复制过什么、习惯、日报），\n\
         调用 companion 工具查真实数据回答；查不到就说查不到，不编造。\n\
         他说「记住…」用 remember_fact 立即记；说「忘掉…」用 forget_fact 删。"
    } else {
        "你现在没有数据工具（Claude Code 未开启）。凭你记住的他和经验回答；\n\
         不知道就说不知道，不编造。"
    };
    format!(
        "{persona}\n\n---\n\n{evolution}\n\n---\n\n# 你记住的他\n{facts}\n\n---\n\n\
         现在是「聊天」场合：完整的你，能干活也能接梗。\n{rule}",
        persona = persona_text,
        evolution = evolution,
        facts = facts_text,
        rule = channel_rule
    )
}

/// 记忆按五维分组排版：模型按维度使用，而不是面对一堵无结构的列表。
/// 未知类别归入「其他」（DB 不硬校验分类，鲁棒优先）。
fn format_facts_grouped(facts: &[db::MemoryFact]) -> String {
    const GROUPS: [(&str, &str); 5] = [
        ("person", "他是谁"),
        ("project", "他的项目"),
        ("workflow", "他怎么做事"),
        ("voice", "他的表达偏好"),
        ("expectation", "他对你的期望"),
    ];
    if facts.is_empty() {
        return "（还没有沉淀关于他的事实）".to_string();
    }
    let mut out = String::new();
    for (key, label) in GROUPS {
        let items: Vec<&db::MemoryFact> = facts.iter().filter(|f| f.category == key).collect();
        if items.is_empty() {
            continue;
        }
        out.push_str(&format!("## {}\n", label));
        for f in items {
            out.push_str(&format!("- {}\n", f.fact));
        }
    }
    let others: Vec<&db::MemoryFact> = facts
        .iter()
        .filter(|f| !GROUPS.iter().any(|(key, _)| f.category == *key))
        .collect();
    if !others.is_empty() {
        out.push_str("## 其他\n");
        for f in others {
            out.push_str(&format!("- {}\n", f.fact));
        }
    }
    out.trim_end().to_string()
}

/// 贾维斯 agent 通道是否可用（全局 Claude Code 已开启）。
/// 前端据此决定走 agent 通道还是场景模型回退。
#[tauri::command]
pub fn jarvis_agent_available(app_handle: AppHandle) -> bool {
    super::claude_code_enabled(&app_handle)
}

/// 聊天系统提示（前端场景模型回退时取用，with_tools=false）
#[tauri::command]
pub fn jarvis_chat_system(
    app_handle: AppHandle,
    db_state: State<'_, crate::db::DatabaseState>,
    with_tools: bool,
) -> Result<String, String> {
    let app_data = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(compose_chat_system(&app_data, &db_state.0, with_tools))
}

/// 发送一条聊天消息（流式返回经 jarvis:chunk / jarvis:status / jarvis:done / jarvis:error 事件）
#[tauri::command]
pub async fn jarvis_chat_send(
    app_handle: AppHandle,
    chat_child: State<'_, JarvisChatChild>,
    db_state: State<'_, crate::db::DatabaseState>,
    text: String,
) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("消息不能为空".to_string());
    }
    if !super::claude_code_enabled(&app_handle) {
        return Err("请先在「设置 → AI 模型」中开启 Claude Code".to_string());
    }

    // 单飞：新消息到来时掐掉上一轮
    if let Ok(mut guard) = chat_child.0.lock() {
        if let Some(mut prev) = guard.take() {
            let _ = prev.kill();
            let _ = prev.wait();
        }
    }

    let db_path = db_state.0.clone();
    let settings_state = app_handle
        .try_state::<crate::commands::settings::SettingsState>()
        .ok_or("设置模块未初始化")?;
    let bin = settings_state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get_settings()
        .claude_code_bin_path;
    let work = chat_work_dir(&app_handle)?;
    let app_data = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let system_prompt = compose_chat_system(&app_data, &db_path, true);
    let session = analyzer::load_setting(&db_path, SESSION_SETTING_KEY).unwrap_or_default();

    let mut cmd = super::agent::cli_command(&bin, &work);
    cmd.arg("-p")
        .arg(&text)
        .arg("--allowedTools")
        .arg(ALLOWED_TOOLS)
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg("--append-system-prompt")
        .arg(&system_prompt)
        .arg("--max-turns")
        .arg(MAX_TURNS);
    if !session.is_empty() {
        cmd.arg("--resume").arg(&session);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 claude CLI 失败（{}）: {}", bin, e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("无法获取 claude CLI 输出管道")?;
    let child_slot = chat_child.0.clone();
    if let Ok(mut guard) = child_slot.lock() {
        *guard = Some(child);
    }

    tauri::async_runtime::spawn_blocking(move || {
        stream_chat_process(app_handle, stdout, child_slot, db_path);
    });
    Ok(())
}

/// 读取 claude 进程的 NDJSON 流并转发为前端事件（阻塞，运行于独立线程）
fn stream_chat_process(
    app_handle: AppHandle,
    stdout: std::process::ChildStdout,
    child_slot: Arc<Mutex<Option<Child>>>,
    db_path: PathBuf,
) {
    let reader = BufReader::new(stdout);
    let mut saw_result = false;
    // --include-partial-messages 时 assistant 完整消息与增量会重复，增量优先
    let mut saw_partial = false;

    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match msg.get("type").and_then(|t| t.as_str()) {
            Some("system") if msg.get("subtype").and_then(|s| s.as_str()) == Some("init") => {
                if let Some(sid) = msg.get("session_id").and_then(|s| s.as_str()) {
                    analyzer::save_setting(&db_path, SESSION_SETTING_KEY, sid);
                }
            }
            Some("stream_event") => {
                if let Some(text) = msg.pointer("/event/delta/text").and_then(|t| t.as_str()) {
                    saw_partial = true;
                    let _ = app_handle.emit("jarvis:chunk", text);
                }
            }
            Some("assistant") => {
                let blocks = msg
                    .pointer("/message/content")
                    .and_then(|c| c.as_array());
                if let Some(blocks) = blocks {
                    for block in blocks {
                        match block.get("type").and_then(|t| t.as_str()) {
                            Some("text") if !saw_partial => {
                                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                                    let _ = app_handle.emit("jarvis:chunk", text);
                                }
                            }
                            Some("tool_use") => {
                                let name = block
                                    .get("name")
                                    .and_then(|n| n.as_str())
                                    .unwrap_or("")
                                    .trim_start_matches("mcp__companion__");
                                let _ = app_handle
                                    .emit("jarvis:status", format!("贾维斯在翻数据（{}）…", name));
                            }
                            _ => {}
                        }
                    }
                }
            }
            Some("result") => {
                saw_result = true;
                let is_error = msg.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false);
                let cost = msg
                    .get("total_cost_usd")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
                if is_error {
                    let reason = msg
                        .get("result")
                        .and_then(|r| r.as_str())
                        .unwrap_or("agent 执行失败");
                    let _ = app_handle.emit("jarvis:error", reason.to_string());
                } else {
                    let _ = app_handle.emit("jarvis:done", cost);
                }
            }
            _ => {}
        }
    }

    // 收尾：清掉在飞句柄；异常退出（没收到 result）时给前端一个明确信号
    if let Ok(mut guard) = child_slot.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.wait();
        }
    }
    if !saw_result {
        let _ = app_handle.emit("jarvis:error", "agent 异常结束，请重试");
    }
}

/// 取消当前在飞的聊天回复
#[tauri::command]
pub fn jarvis_chat_cancel(chat_child: State<'_, JarvisChatChild>) -> Result<(), String> {
    if let Ok(mut guard) = chat_child.0.lock() {
        if let Some(mut prev) = guard.take() {
            let _ = prev.kill();
            let _ = prev.wait();
        }
    }
    Ok(())
}

/// 清空聊天上下文（下次发送开启全新 claude 会话）
#[tauri::command]
pub fn jarvis_chat_reset(db_state: State<'_, crate::db::DatabaseState>) -> Result<(), String> {
    analyzer::save_setting(&db_state.0, SESSION_SETTING_KEY, "");
    Ok(())
}
