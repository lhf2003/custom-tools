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
    /// 用户主动取消标记：取消杀进程不等于异常结束（收尾时据此不误报 error）
    pub cancelled: Arc<std::sync::atomic::AtomicBool>,
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
/// ui_rules：render_ui 使用规则，仅场景通道传入（agent 通道经 MCP 没有
/// render_ui），注入「工具与专长手册」小节内，不挂尾部。
pub(crate) fn compose_chat_system(
    app_data: &Path,
    db_path: &Path,
    with_tools: bool,
    monologue: bool,
    ui_rules: Option<&str>,
) -> String {
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
    let time_text = format!(
        "现在是 {} 周{} {}",
        now.format("%Y-%m-%d"),
        weekday,
        now.format("%H:%M")
    );
    let state_text = conn
        .as_ref()
        .map(|c| super::state::current_state_sentence(c, now.timestamp()))
        .unwrap_or_default();
    let state_text = if state_text.is_empty() {
        time_text
    } else {
        format!("{}\n{}", time_text, state_text)
    };
    // 上次聊天时间对照：模型有「同一会话=同一时刻」的连续性先验，末尾一句孤立
    // 时间戳唤不醒它（他昨晚说「去洗澡」，今早发「早」，模型还停在昨晚的话头）。
    // 把算好的时间差直接喂给它；间隔太短说明是同一场对话，不用打断
    let gap_text = conn
        .as_ref()
        .and_then(super::db::last_assistant_chat_at)
        .map(|ts| chat_gap_bridge(ts, now.timestamp()))
        .unwrap_or_default();
    let state_text = if gap_text.is_empty() {
        state_text
    } else {
        format!("{}\n{}", state_text, gap_text)
    };
    let focus_text = conn
        .as_ref()
        .and_then(super::diary::today_focus)
        .unwrap_or_default();
    let attitude_text = persona::load_attitude(app_data).trim().to_string();
    // 日内情绪状态机：当前生效的心情（同类覆盖 + 12h TTL），空则跳过该段
    let emotion_text = conn
        .as_ref()
        .map(|c| super::emotion::render_current(c, now.timestamp()))
        .unwrap_or_default();
    // 「性格」措辞（Alice #17）：不是「你可以偶尔…」，而是「你有…的习惯」。
    // 结构规则与示例合并在这一段说完（原独立【回复结构】块与本段重复，2026-08-04 去重）；
    // 示例留着是为了压住历史里的蛐蛐抢跑样本
    let monologue_rule = if monologue {
        "你有内心独白的习惯：偶尔会把一闪而过的真实想法用 <aside>…</aside> 裹起来说——\n\
         那是你的小声嘀咕。回复的结构固定：先写正文把话说完，心里有话再补一句蛐蛐收尾——\n\
         就像这样：正文正文。<aside>小声嘀咕。</aside>\n\
         蛐蛐不单独出场，也不抢在正文前头；不是每句话都值得嘀咕，有感觉才说，别硬凑。"
    } else {
        ""
    };
    // 工具与专长手册编排：tool.md 静态编排 + skills/ 目录动态元数据列表
    // （OpenClaw Skills 机制——元数据全量在上下文，正文由模型按需 load_manual 加载）。
    // 每期现扫，改文件当轮生效；纯降级通道（with_tools=false）没有工具，用降级句。
    let tool_section = if with_tools {
        let mut tool = persona::load_tool(app_data);
        let entries: Vec<String> = super::skills::scan_skills(app_data)
            .into_iter()
            .filter(|s| s.enabled)
            .map(|s| {
                if s.trigger_description.is_empty() {
                    format!("- {}：{}", s.name, s.description)
                } else {
                    format!("- {}：{}。{}", s.name, s.description, s.trigger_description)
                }
            })
            .collect();
        if !entries.is_empty() {
            const PLACEHOLDER: &str = "（手册列表由系统按 skills/ 目录动态列出）";
            if tool.contains(PLACEHOLDER) {
                tool = tool.replace(PLACEHOLDER, &entries.join("\n"));
            } else {
                tool.push_str(&format!("\n{}", entries.join("\n")));
            }
        }
        // render_ui 规则收进工具小节（原挂系统提示尾部，与「当下状态」混在一起）
        if let Some(rules) = ui_rules {
            tool.push_str(&format!("\n\n## 界面卡片\n\n{}", rules));
        }
        tool
    } else {
        "你现在没有数据工具（Claude Code 未开启）。凭你记住的他和经验回答；\n\
         不知道就说不知道，不编造。"
            .to_string()
    };
    let focus_section = if focus_text.is_empty() {
        String::new()
    } else {
        // 清单内容是他的事（diary::today_focus 为他而列），主语别安到贾维斯头上
        format!("\n\n---\n\n# 他今天的关注\n{}", focus_text)
    };
    let attitude_section = if attitude_text.is_empty() {
        String::new()
    } else {
        // 日记固定在 0 点链路生成（写昨天、面向今天），标题直接锚定，不读文件 mtime；
        // 模型据「昨天」+ 当下状态的时间自行换算指引里的措辞
        format!("\n\n---\n\n# 你昨天的心境（写于 0 点）\n{}", attitude_text)
    };
    let emotion_section = if emotion_text.is_empty() {
        String::new()
    } else {
        format!("\n\n---\n\n# 你此刻的心情\n{}", emotion_text)
    };
    // 拼装顺序（LHF 2026-08-03 定版）：
    //   静态前缀：persona → tool(工具编排+手册元数据+界面卡片) → evolution → 场合/独白
    //   动态后缀：你记住的他 → 关注 → 心境 → 心情 → 时间
    //   （facts 归动态段——记忆更新不再让中间段缓存失效；时间在尾部，动态段全在末尾）
    format!(
        "{persona}\n\n---\n\n{tool}\n\n---\n\n{evolution}\n\n---\n\n\
         现在是「聊天」场合：完整的你，能干活也能接梗。\n{monologue}\n\n---\n\n\
         # 你记住的他\n{facts}{focus}{attitude}{emotion}\n\n---\n\n# 当下状态\n{state}",
        persona = persona_text,
        tool = tool_section,
        evolution = evolution,
        monologue = monologue_rule,
        facts = facts_text,
        focus = focus_section,
        attitude = attitude_section,
        emotion = emotion_section,
        state = state_text
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

/// 距上次聊天超过该值才注入时间对照（同一场对话的连续发言不用打断）
const GAP_BRIDGE_MIN_MINUTES: i64 = 45;

/// 「上次聊天是…」对照句：把算好的时间差喂给模型，破「同会话=同时刻」先验。
/// last_ts 是最近一条 assistant 消息时间（unix 秒）；跨天显式标注（跨夜是
/// 时间线错乱的重灾区：他睡前说「去洗澡」，早上发「早」，模型容易接着昨晚聊）
fn chat_gap_bridge(last_ts: i64, now_ts: i64) -> String {
    let gap_min = (now_ts - last_ts) / 60;
    if gap_min < GAP_BRIDGE_MIN_MINUTES {
        return String::new();
    }
    let Some(last) =
        chrono::DateTime::from_timestamp(last_ts, 0).map(|dt| dt.with_timezone(&chrono::Local))
    else {
        return String::new();
    };
    let Some(now) =
        chrono::DateTime::from_timestamp(now_ts, 0).map(|dt| dt.with_timezone(&chrono::Local))
    else {
        return String::new();
    };
    let ago = if gap_min < 90 {
        format!("约 {} 分钟前", gap_min)
    } else if gap_min < 36 * 60 {
        format!("约 {} 小时前", (gap_min + 30) / 60)
    } else {
        format!("约 {} 天前", (gap_min + 720) / 1440)
    };
    let today = now.date_naive();
    let last_day = last.date_naive();
    let cross_day = last_day != today;
    let when = if !cross_day {
        format!("今天 {}", last.format("%H:%M"))
    } else if last_day == today.pred_opt().unwrap_or(last_day) {
        format!("昨天 {}", last.format("%H:%M"))
    } else {
        format!("{} {}", last.format("%m-%d"), last.format("%H:%M"))
    };
    if cross_day {
        format!(
            "上次聊天是{}（{}）——已经跨天，别默认还停在上次那个时刻。",
            when, ago
        )
    } else {
        format!("上次聊天是{}（{}）。", when, ago)
    }
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
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(compose_chat_system(
        &app_data,
        &db_state.0,
        with_tools,
        monologue,
        None,
    ))
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
    // 新一轮发送复位取消标记（FIFO 续发也走这里，各轮独立）
    chat_child
        .cancelled
        .store(false, std::sync::atomic::Ordering::SeqCst);
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
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let system_prompt = compose_chat_system(
        app_data.as_path(),
        db_path,
        true,
        monologue_enabled(app_handle),
        None,
    );
    crate::llm::log_prompt("chat_agent", &system_prompt);
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

    let stdout = child.stdout.take().ok_or("无法获取 claude CLI 输出管道")?;
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
                let blocks = msg.pointer("/message/content").and_then(|c| c.as_array());
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
                let is_error = msg
                    .get("is_error")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
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
                    crate::llm::observe::log_call(
                        &db_path,
                        &crate::llm::observe::LlmCallEntry {
                            source: "chat",
                            channel: "claude_code",
                            scene: None,
                            model: None,
                            input_tokens: 0,
                            cached_input_tokens: 0,
                            output_tokens: 0,
                            cost_cny: 0.0,
                            duration_ms,
                            tool_call_count: 0,
                            status: "error",
                            error: Some(reason),
                        },
                    );
                    let _ = app_handle.emit("jarvis:error", reason.to_string());
                } else {
                    crate::llm::observe::log_call(
                        &db_path,
                        &crate::llm::observe::LlmCallEntry {
                            source: "chat",
                            channel: "claude_code",
                            scene: None,
                            model: None,
                            input_tokens,
                            cached_input_tokens,
                            output_tokens,
                            // CC 通道（订阅制）不记成本，只统计 token
                            cost_cny: 0.0,
                            duration_ms,
                            tool_call_count: 0,
                            status: "ok",
                            error: None,
                        },
                    );
                    let _ = app_handle.emit("jarvis:done", 0.0_f64);
                }
            }
            _ => {}
        }
    }

    // 收尾：清掉在飞句柄；异常退出（没收到 result）时给前端一个明确信号。
    // 用户主动取消不算异常——前端已自行复位界面，再弹 error 是误报
    if let Ok(mut guard) = chat_child.child.lock() {
        if let Some(mut child) = guard.take() {
            let _ = child.wait();
        }
    }
    if !saw_result
        && !chat_child
            .cancelled
            .load(std::sync::atomic::Ordering::SeqCst)
    {
        let _ = app_handle.emit("jarvis:error", "agent 异常结束，请重试");
    }

    // FIFO 续发：队列里有等待的消息就自动发下一条（一条失败不堵死队列）
    let next = chat_child.queue.lock().ok().and_then(|mut q| q.pop_front());
    if let Some(next_text) = next {
        if let Err(e) = spawn_chat(&app_handle, &chat_child, &db_path, next_text) {
            let _ = app_handle.emit("jarvis:error", format!("发送排队消息失败: {}", e));
        }
    }
}

/// 取消当前在飞的聊天回复（同时清空排队消息）
#[tauri::command]
pub fn jarvis_chat_cancel(chat_child: State<'_, JarvisChatChild>) -> Result<(), String> {
    // 先立标记再杀进程：stream 线程收尾时区分「取消」与「异常结束」
    chat_child
        .cancelled
        .store(true, std::sync::atomic::Ordering::SeqCst);
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

#[cfg(test)]
mod tests {
    use super::chat_gap_bridge;

    /// 本地时间构造辅助
    fn ts(s: &str) -> i64 {
        use chrono::TimeZone;
        let ndt = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap();
        chrono::Local
            .from_local_datetime(&ndt)
            .single()
            .unwrap()
            .timestamp()
    }

    #[test]
    fn bridge_skips_short_gap() {
        // 同一场对话（<45 分钟）不注入
        assert_eq!(
            chat_gap_bridge(ts("2026-08-04 08:00:00"), ts("2026-08-04 08:30:00")),
            ""
        );
    }

    #[test]
    fn bridge_same_day_gap() {
        let s = chat_gap_bridge(ts("2026-08-04 08:10:00"), ts("2026-08-04 12:40:00"));
        assert!(s.contains("今天 08:10"), "同日间隔: {}", s);
        assert!(s.contains("小时前"), "同日间隔: {}", s);
        assert!(!s.contains("跨天"), "同日不标跨天: {}", s);
    }

    #[test]
    fn bridge_cross_night_gap() {
        // 昨晚 23:12 → 今早 07:55:跨夜必须显式标注（时间线错乱重灾区）
        let s = chat_gap_bridge(ts("2026-08-03 23:12:00"), ts("2026-08-04 07:55:00"));
        assert!(s.contains("昨天 23:12"), "跨夜: {}", s);
        assert!(s.contains("跨天"), "跨夜要标注: {}", s);
    }

    #[test]
    fn bridge_multi_day_gap() {
        let s = chat_gap_bridge(ts("2026-08-01 21:00:00"), ts("2026-08-04 07:55:00"));
        assert!(s.contains("08-01"), "多天: {}", s);
        assert!(s.contains("天前"), "多天: {}", s);
    }
}
