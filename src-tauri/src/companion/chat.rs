//! 贾维斯聊天通道：以 claude CLI 流式协议（stream-json）驱动的 agent 聊天。
//! 每条用户消息 spawn 一次 claude 进程，--resume 串起多轮上下文；
//! 助理文本经 jarvis:chunk 流式推给前端，工具活动经 jarvis:status 提示。

use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::{Arc, Mutex};

use chrono::Datelike;

use rusqlite::Connection;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use super::{analyzer, db, persona};

/// 聊天只开放 companion 数据工具：能查他的电脑使用，但碰不到文件系统
const ALLOWED_TOOLS: &str = "mcp__companion__*";
const MAX_TURNS: &str = "8";
/// claude 会话 id 的持久化 key（跨消息/跨重启续接上下文）
const SESSION_SETTING_KEY: &str = "companion_chat_claude_session";

/// 在飞的聊天状态：子进程句柄 + 待发送队列。
/// FIFO 排队（四期裁决）：在飞时新消息入队不打断，答完自动发下一条。
#[derive(Clone, Default)]
pub struct JarvisChatChild {
    pub child: Arc<Mutex<Option<Child>>>,
    pub queue: Arc<Mutex<VecDeque<String>>>,
}

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
/// with_tools=true 时用 --append-system-prompt 注入 claude agent 通道，
/// 或场景模型回退通道（有数据工具版）；false 为无工具降级措辞。
pub(crate) fn compose_chat_system(app_data: &Path, db_path: &Path, with_tools: bool, monologue: bool) -> String {
    let persona_text = persona::load(app_data);
    let evolution = persona::load_evolution(app_data);
    let conn = Connection::open(db_path).ok();
    let facts = conn
        .as_ref()
        .and_then(|c| db::list_memory_facts(c, 50).ok())
        .unwrap_or_default();
    let facts_text = format_facts_grouped(&facts);
    // 以下动态段全部追加末尾（前缀稳定段不吃 KV Cache 失效）
    let now = chrono::Local::now();
    // 真实时间进提示词——模型本身没有时钟，不知道「现在几点」
    let weekday = match now.weekday().num_days_from_monday() {
        0 => "一",
        1 => "二",
        2 => "三",
        3 => "四",
        4 => "五",
        5 => "六",
        _ => "日",
    };
    let time_text = format!("现在是 {} 周{} {}", now.format("%Y-%m-%d"), weekday, now.format("%H:%M"));
    let state_text = conn
        .as_ref()
        .map(|c| super::state::current_state_sentence(c, now.timestamp()))
        .unwrap_or_default();
    let state_text = if state_text.is_empty() {
        time_text
    } else {
        format!("{}\n{}", time_text, state_text)
    };
    let focus_text = conn
        .as_ref()
        .and_then(super::diary::today_focus)
        .unwrap_or_default();
    let attitude_text = persona::load_attitude(app_data).trim().to_string();
    let channel_rule = if with_tools {
        "涉及他电脑使用的问题（干了什么、各应用用了多久、复制过什么、习惯、日报），\n\
         调用 companion 工具查真实数据回答；查不到就说查不到，不编造。\n\
         问备忘/待办用 list_memos 查（已划掉的不会出现），不要凭记忆列旧项。\n\
         他说「记住…」用 remember_fact 立即记；说「忘掉…」用 forget_fact 删。"
    } else {
        "你现在没有数据工具（Claude Code 未开启）。凭你记住的他和经验回答；\n\
         不知道就说不知道，不编造。"
    };
    // 「性格」措辞（Alice #17）：不是「你可以偶尔…」，而是「你有…的习惯」
    let monologue_rule = if monologue {
        "\n你有内心独白的习惯：偶尔会把一闪而过的真实想法用 <aside>…</aside> 裹起来说——\n\
         那是你的小声嘀咕，不是回答正文的一部分。不是每句话都值得嘀咕，有感觉才说，别硬凑。"
    } else {
        ""
    };
    // 能力目录：有 trigger_description 的手册进聊天提示（每期现扫，改文件当轮生效）。
    // 纯降级通道（with_tools=false）没有 load_manual 工具，不注入。
    let catalog_section = if with_tools {
        let entries: Vec<String> = super::skills::scan_skills(app_data)
            .into_iter()
            .filter(|s| s.enabled && !s.trigger_description.is_empty())
            .map(|s| format!("- {}：{}。{}", s.name, s.description, s.trigger_description))
            .collect();
        if entries.is_empty() {
            String::new()
        } else {
            format!(
                "\n\n---\n\n# 你的能力手册\n\
                 以下手册可按需激活：他说的话匹配描述时，调用 load_manual 读手册全文，然后按手册执行。\n{}",
                entries.join("\n")
            )
        }
    } else {
        String::new()
    };
    let focus_section = if focus_text.is_empty() {
        String::new()
    } else {
        format!("\n\n---\n\n# 你今天的关注\n{}", focus_text)
    };
    let attitude_section = if attitude_text.is_empty() {
        String::new()
    } else {
        format!("\n\n---\n\n# 你近期的心境\n{}", attitude_text)
    };
    format!(
        "{persona}\n\n---\n\n{evolution}\n\n---\n\n# 你记住的他\n{facts}{catalog}\n\n---\n\n\
         现在是「聊天」场合：完整的你，能干活也能接梗。\n{rule}{monologue}\n\n---\n\n# 当下状态\n{state}{focus}{attitude}",
        persona = persona_text,
        evolution = evolution,
        facts = facts_text,
        catalog = catalog_section,
        rule = channel_rule,
        monologue = monologue_rule,
        state = state_text,
        focus = focus_section,
        attitude = attitude_section
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

/// 首次聊天时记下日期（关系阶段起点）；已记录则不动
pub(crate) fn touch_first_chat_date(db_path: &PathBuf) {
    let existing = analyzer::load_setting(db_path, super::state::FIRST_CHAT_DATE_KEY);
    if existing.unwrap_or_default().is_empty() {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        analyzer::save_setting(db_path, super::state::FIRST_CHAT_DATE_KEY, &today);
    }
}

/// 读运行时开关（独白）；陪伴状态未初始化时按默认（开）
pub(crate) fn monologue_enabled(app_handle: &AppHandle) -> bool {
    app_handle
        .try_state::<super::CompanionState>()
        .and_then(|s| s.flags.read().ok().map(|f| f.monologue))
        .unwrap_or(true)
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
    touch_first_chat_date(&db_state.0);
    let monologue = monologue_enabled(&app_handle);
    let app_data = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(compose_chat_system(&app_data, &db_state.0, with_tools, monologue))
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
    touch_first_chat_date(&db_state.0);

    // FIFO 排队（四期裁决）：在飞时新消息入队，答完由收尾逻辑自动发下一条
    let in_flight = chat_child
        .child
        .lock()
        .map(|g| g.is_some())
        .unwrap_or(false);
    if in_flight {
        if let Ok(mut q) = chat_child.queue.lock() {
            q.push_back(text);
        }
        let _ = app_handle.emit("jarvis:status", "已排队，等上一条答完…");
        return Ok(());
    }

    spawn_chat(&app_handle, &chat_child, &db_state.0, text)
}

/// 启动一条聊天子进程（首条与队列续发共用）。
/// 系统提示在发送时现算——排队消息发出时状态/关注/心境都是最新的。
fn spawn_chat(
    app_handle: &AppHandle,
    chat_child: &JarvisChatChild,
    db_path: &PathBuf,
    text: String,
) -> Result<(), String> {
    let settings_state = app_handle
        .try_state::<crate::commands::settings::SettingsState>()
        .ok_or("设置模块未初始化")?;
    let bin = settings_state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get_settings()
        .claude_code_bin_path;
    let work = chat_work_dir(app_handle)?;
    let app_data = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let system_prompt = compose_chat_system(app_data.as_path(), db_path, true, monologue_enabled(app_handle));
    let session = analyzer::load_setting(db_path, SESSION_SETTING_KEY).unwrap_or_default();

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
    if let Ok(mut guard) = chat_child.child.lock() {
        *guard = Some(child);
    }

    // 通知前端新一轮开始（首条与队列续发统一信号，前端据此复位流式状态）
    let _ = app_handle.emit("jarvis:start", ());

    let app_handle2 = app_handle.clone();
    let chat_child2 = chat_child.clone();
    let db_path2 = db_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        stream_chat_process(app_handle2, stdout, chat_child2, db_path2);
    });
    Ok(())
}

/// 读取 claude 进程的 NDJSON 流并转发为前端事件（阻塞，运行于独立线程）
fn stream_chat_process(
    app_handle: AppHandle,
    stdout: std::process::ChildStdout,
    chat_child: JarvisChatChild,
    db_path: PathBuf,
) {
    let reader = BufReader::new(stdout);
    let started = std::time::Instant::now();
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
                let duration_ms = started.elapsed().as_millis() as u64;
                let input_tokens = msg
                    .pointer("/usage/input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let output_tokens = msg
                    .pointer("/usage/output_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cached_input_tokens = msg
                    .pointer("/usage/cache_read_input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                if is_error {
                    let reason = msg
                        .get("result")
                        .and_then(|r| r.as_str())
                        .unwrap_or("agent 执行失败");
                    crate::llm::observe::log_call(&db_path, &crate::llm::observe::LlmCallEntry {
                        source: "chat",
                        channel: "claude_code",
                        scene: None,
                        model: None,
                        input_tokens: 0,
                        cached_input_tokens: 0,
                        output_tokens: 0,
                        cost_usd: 0.0,
                        duration_ms,
                        tool_call_count: 0,
                        status: "error",
                        error: Some(reason),
                    });
                    let _ = app_handle.emit("jarvis:error", reason.to_string());
                } else {
                    crate::llm::observe::log_call(&db_path, &crate::llm::observe::LlmCallEntry {
                        source: "chat",
                        channel: "claude_code",
                        scene: None,
                        model: None,
                        input_tokens,
                        cached_input_tokens,
                        output_tokens,
                        cost_usd: cost,
                        duration_ms,
                        tool_call_count: 0,
                        status: "ok",
                        error: None,
                    });
                    let _ = app_handle.emit("jarvis:done", cost);
                }
            }
            _ => {}
        }
    }

    // 收尾：清掉在飞句柄；异常退出（没收到 result）时给前端一个明确信号
    if let Ok(mut guard) = chat_child.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.wait();
        }
    }
    if !saw_result {
        let _ = app_handle.emit("jarvis:error", "agent 异常结束，请重试");
    }

    // FIFO 续发：队列里有等待的消息就自动发下一条（一条失败不堵死队列）
    let next = chat_child
        .queue
        .lock()
        .ok()
        .and_then(|mut q| q.pop_front());
    if let Some(next_text) = next {
        if let Err(e) = spawn_chat(&app_handle, &chat_child, &db_path, next_text) {
            let _ = app_handle.emit("jarvis:error", format!("发送排队消息失败: {}", e));
        }
    }
}

/// 取消当前在飞的聊天回复（同时清空排队消息）
#[tauri::command]
pub fn jarvis_chat_cancel(chat_child: State<'_, JarvisChatChild>) -> Result<(), String> {
    if let Ok(mut q) = chat_child.queue.lock() {
        q.clear();
    }
    if let Ok(mut guard) = chat_child.child.lock() {
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
