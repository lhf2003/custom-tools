//! 场景模型回退聊天通道：Claude Code 未开启时的贾维斯聊天。
//!
//! tool-use 循环：模型经 function calling 调用 companion 数据工具（与 MCP
//! 通道共用 tools.rs 的执行层），拿到数据后再回答。非流式（裁决 D1）：
//! 循环中无法预知哪轮是最终回答，最终结果经 jarvis:chunk 一次性推前端。
//!
//! 降级链（#4：质量下降而非功能消失）：
//!   Claude Code agent → 场景模型+工具 →（模型/API 不支持 tools 时）场景模型纯问答

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use super::{analyzer, chat, tools};
use crate::llm_provider::models::Scene;

/// tool-use 循环上限（每轮都是一次付费调用，防失控）
const MAX_TOOL_ROUNDS: usize = 4;
/// 未摘要消息超过该阈值时触发增量摘要（约 12 轮对话攒一次）
const SUMMARY_THRESHOLD: usize = 24;
/// 摘要后保留的最近原文条数（约 6 轮对话原样进上下文）
const RECENT_KEEP: usize = 12;

/// 回退通道在飞状态：FIFO 排队（与 agent 通道同一语义——
/// 在飞时新消息入队不打断，答完自动发下一条）
#[derive(Clone, Default)]
pub struct JarvisSceneChatState {
    pub in_flight: Arc<Mutex<bool>>,
    pub queue: Arc<Mutex<VecDeque<(i64, String)>>>,
}

/// 在飞标记复位守卫：任务 panic 或提前返回都保证释放 FIFO。
/// 没有它，一次异常会把后续所有消息永久滞留在队列里（表现为
/// 「第一条回复正常，之后既不回显也不落库」）。
struct FlightReset(Arc<Mutex<bool>>);

impl Drop for FlightReset {
    fn drop(&mut self) {
        if let Ok(mut f) = self.0.lock() {
            *f = false;
        }
    }
}

/// 发送一条聊天消息（场景模型回退通道）。
/// 事件契约与 agent 通道一致：jarvis:start / jarvis:status（工具活动）→
/// jarvis:chunk（全文）→ jarvis:done（成本）。
/// assistant 落库由前端在 jarvis:done 监听里完成（与 agent 通道同一约定）。
#[tauri::command]
pub async fn jarvis_chat_send_scene(
    app_handle: AppHandle,
    scene_state: State<'_, JarvisSceneChatState>,
    db_state: State<'_, crate::db::DatabaseState>,
    session_id: i64,
    text: String,
) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("消息不能为空".to_string());
    }
    chat::touch_first_chat_date(&db_state.0);

    // FIFO 排队：在飞则入队，后台循环答完自动续发
    {
        let mut flying = scene_state
            .in_flight
            .lock()
            .map_err(|e| e.to_string())?;
        if *flying {
            if let Ok(mut q) = scene_state.queue.lock() {
                q.push_back((session_id, text));
            }
            let _ = app_handle.emit("jarvis:status", "已排队，等上一条答完…");
            return Ok(());
        }
        *flying = true;
    }

    let state = scene_state.inner().clone();
    let app = app_handle.clone();
    let db_path = db_state.0.clone();
    tauri::async_runtime::spawn(async move {
        // 守卫在任务结束（含 panic 展开）时统一复位 in_flight
        let _flight_reset = FlightReset(state.in_flight.clone());
        let mut current = (session_id, text);
        loop {
            if let Err(e) = run_scene_chat(&app, &db_path, current.0, current.1).await {
                log::warn!("场景模型聊天失败: {}", e);
            }
            let next = state
                .queue
                .lock()
                .ok()
                .and_then(|mut q| q.pop_front());
            match next {
                Some(m) => current = m,
                None => break,
            }
        }
    });
    Ok(())
}

/// 执行一条回退聊天：tool-use 循环（上限 4 轮，每轮登记 llm_call_logs）。
/// 非流式（裁决 D1）：循环中无法预知哪轮是最终回答，最终结果一次性推前端。
async fn run_scene_chat(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    session_id: i64,
    text: String,
) -> Result<(), String> {
    let _ = app_handle.emit("jarvis:start", ());

    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let notes_dir = crate::notes::get_default_notes_dir().map_err(|e| e.to_string())?;

    // 解析陪伴场景模型
    let conn = Connection::open(db_path).map_err(|e| format!("打开数据库失败: {}", e))?;
    let (provider, model, thinking_mode, api_key, used_scene) =
        analyzer::resolve_scene_provider(app_handle, &conn, Scene::Companion)?;
    let provider_type = provider.provider_type.to_string();
    let scene_str = used_scene.to_string();

    // 系统提示：有数据工具版（回退通道升级后与 agent 通道同一套措辞）
    let mut system_prompt = chat::compose_chat_system(
        &app_data,
        db_path,
        true,
        chat::monologue_enabled(app_handle),
    );
    // render_ui 使用偏好引导（只挂场景通道——agent 通道经 MCP 没有这个工具）。
    // 工具描述只说了「能做什么」；模型没有明确偏好时倾向纯文本作答（实测验证），
    // 这里补上硬性规则：数据工具出多条数据 → 必须先卡片后文字
    system_prompt.push_str(
        "\n\n【界面卡片规则】调用数据工具（get_activity_summary、search_clipboard、\n\
         get_habit_patterns、list_memos 等）拿到多条数据后，不要只用文字罗列——必须先调用 render_ui\n\
         把数据渲染成界面卡片给他看，再用一两句文字总结要点。\n\
         纯闲聊、一句话问答直接用文字，不用卡片。",
    );

    // 历史上下文：增量摘要（必要时先压缩旧消息）+ 最近原文。
    // 摘要追加到系统提示末尾（动态内容一律追加，前缀稳定不吃 KV Cache 失效）
    let context = load_context(app_handle, db_path, session_id).await?;
    if !context.summary.is_empty() {
        system_prompt.push_str(&format!("\n\n---\n\n# 此前聊天的摘要\n{}", context.summary));
    }

    // 组装消息：system + 近期历史 + 本轮用户消息
    let mut messages = vec![json!({ "role": "system", "content": system_prompt })];
    for (role, content) in context.recent {
        messages.push(json!({ "role": role, "content": content }));
    }
    messages.push(json!({ "role": "user", "content": text }));

    let tools_json = openai_tools_json();
    let mut total_cost = 0.0f64;
    let mut rounds = 0usize;
    // A2UI：同一轮对话内 render_ui 的 surface 状态（增量更新校验用）与连续失败计数
    let mut a2ui_surfaces: std::collections::HashMap<String, super::a2ui::SurfaceState> =
        Default::default();
    let mut render_ui_failures = 0usize;

    let final_text = loop {
        rounds += 1;
        let started = std::time::Instant::now();
        let result = crate::llm::call_llm_with_tools(
            &provider.base_url,
            &api_key,
            &model.model_id,
            &provider_type,
            messages.clone(),
            tools_json.clone(),
            thinking_mode,
        )
        .await;
        let duration_ms = started.elapsed().as_millis() as u64;

        match result {
            Ok(reply) => {
                let cost = reply.input_tokens as f64 / 1e6
                    * model.input_price_per_m.unwrap_or(0.0)
                    + reply.output_tokens as f64 / 1e6
                        * model.output_price_per_m.unwrap_or(0.0);
                total_cost += cost;
                crate::llm::observe::log_call(
                    db_path,
                    &crate::llm::observe::LlmCallEntry {
                        source: "chat",
                        channel: "scene_model",
                        scene: Some(&scene_str),
                        model: Some(&model.model_id),
                        input_tokens: reply.input_tokens,
                        output_tokens: reply.output_tokens,
                        cost_usd: cost,
                        duration_ms,
                        status: "ok",
                        error: None,
                    },
                );

                if reply.tool_calls.is_empty() {
                    break reply.content;
                }

                // 工具轮：状态提示 + 逐个执行（错误也回传，模型自我纠正）
                let names: Vec<&str> = reply
                    .tool_calls
                    .iter()
                    .map(|c| c.name.as_str())
                    .collect();
                log::info!("场景模型第 {} 轮工具调用: [{}]", rounds, names.join(", "));
                let _ = app_handle.emit(
                    "jarvis:status",
                    format!("贾维斯在翻数据（{}）…", names.join("、")),
                );
                messages.push(crate::llm::assistant_tool_message(&provider_type, &reply));
                for call in &reply.tool_calls {
                    let mut tool_result = if call.name == "render_ui" {
                        match handle_render_ui(
                            app_handle,
                            db_path,
                            session_id,
                            &call.arguments,
                            &mut a2ui_surfaces,
                            &mut render_ui_failures,
                        ) {
                            Ok(ok) => ok,
                            Err(e) => e,
                        }
                    } else {
                        tools::execute_tool(db_path, &notes_dir, &call.name, &call.arguments)
                            .unwrap_or_else(|e| e)
                    };
                    // 数据工具结果尾部追加卡片提醒：工具结果是模型注意力最高的位置，
                    // 系统提示里的偏好引导实测会被忽略（软引导失败后的第二道转向）
                    if matches!(
                        call.name.as_str(),
                        "get_activity_summary" | "search_clipboard" | "get_habit_patterns" | "list_memos"
                    ) {
                        tool_result.push_str(
                            "\n\n（系统提醒：以上是多条数据，按【界面卡片规则】应接着调用 render_ui 渲染成卡片，再用文字总结。）",
                        );
                    }
                    messages.push(crate::llm::tool_result_message(
                        &provider_type,
                        call,
                        &tool_result,
                    ));
                }

                if rounds >= MAX_TOOL_ROUNDS {
                    // 强制收尾：不带 tools 再问一次，模型基于已获信息直接回答
                    messages.push(json!({
                        "role": "user",
                        "content": "（系统提示：工具调用次数已到上限，请基于已经拿到的信息直接回答，不要再调用工具。）"
                    }));
                    let started = std::time::Instant::now();
                    let final_result = crate::llm::call_llm_with_tools(
                        &provider.base_url,
                        &api_key,
                        &model.model_id,
                        &provider_type,
                        messages.clone(),
                        json!([]),
                        thinking_mode,
                    )
                    .await;
                    let duration_ms = started.elapsed().as_millis() as u64;
                    match final_result {
                        Ok(reply) => {
                            let cost = reply.input_tokens as f64 / 1e6
                                * model.input_price_per_m.unwrap_or(0.0)
                                + reply.output_tokens as f64 / 1e6
                                    * model.output_price_per_m.unwrap_or(0.0);
                            total_cost += cost;
                            crate::llm::observe::log_call(
                                db_path,
                                &crate::llm::observe::LlmCallEntry {
                                    source: "chat",
                                    channel: "scene_model",
                                    scene: Some(&scene_str),
                                    model: Some(&model.model_id),
                                    input_tokens: reply.input_tokens,
                                    output_tokens: reply.output_tokens,
                                    cost_usd: cost,
                                    duration_ms,
                                    status: "ok",
                                    error: None,
                                },
                            );
                            break reply.content;
                        }
                        Err(e) => {
                            crate::llm::observe::log_call(
                                db_path,
                                &crate::llm::observe::LlmCallEntry {
                                    source: "chat",
                                    channel: "scene_model",
                                    scene: Some(&scene_str),
                                    model: Some(&model.model_id),
                                    input_tokens: 0,
                                    output_tokens: 0,
                                    cost_usd: 0.0,
                                    duration_ms,
                                    status: "error",
                                    error: Some(&e),
                                },
                            );
                            let _ = app_handle.emit("jarvis:error", e.clone());
                            return Err(e);
                        }
                    }
                }
            }
            Err(e) => {
                crate::llm::observe::log_call(
                    db_path,
                    &crate::llm::observe::LlmCallEntry {
                        source: "chat",
                        channel: "scene_model",
                        scene: Some(&scene_str),
                        model: Some(&model.model_id),
                        input_tokens: 0,
                        output_tokens: 0,
                        cost_usd: 0.0,
                        duration_ms,
                        status: "error",
                        error: Some(&e),
                    },
                );
                // 首轮 4xx：大概率是模型/端点不支持 function calling → 降级纯问答
                if rounds == 1 && e.starts_with("API 错误 4") {
                    log::warn!("场景模型不支持 tools（{}），降级纯问答", e);
                    return plain_fallback(
                        app_handle,
                        db_path,
                        &app_data,
                        &provider,
                        &model,
                        &api_key,
                        &provider_type,
                        &scene_str,
                        thinking_mode,
                        session_id,
                        &text,
                    )
                    .await;
                }
                let _ = app_handle.emit("jarvis:error", e.clone());
                return Err(e);
            }
        }
    };

    // 终态：全文一次性推前端（非流式裁决），assistant 落库由前端 done 监听完成
    let _ = app_handle.emit("jarvis:chunk", final_text);
    let _ = app_handle.emit("jarvis:done", total_cost);
    Ok(())
}

/// render_ui 工具（A2UI）：校验 → emit jarvis:surface → 落库 content_type='a2ui'。
/// 校验失败的原因作为工具结果回喂模型自我纠正；连续失败 2 次后劝退，保文字兜底。
fn handle_render_ui(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    session_id: i64,
    arguments: &serde_json::Value,
    surfaces: &mut std::collections::HashMap<String, super::a2ui::SurfaceState>,
    failures: &mut usize,
) -> Result<String, String> {
    const MAX_RENDER_UI_FAILURES: usize = 2;

    let surface_id = arguments
        .get("surface_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("缺少参数 surface_id".to_string())?;
    let msgs = arguments
        .get("messages")
        .and_then(|v| v.as_array())
        .ok_or("缺少参数 messages（应为 A2UI 消息数组）".to_string())?;

    if let Err(e) = super::a2ui::validate_and_apply(msgs, surface_id, surfaces) {
        *failures += 1;
        if *failures >= MAX_RENDER_UI_FAILURES {
            return Err(format!(
                "界面生成连续失败（{}），请直接用文字回答，不要再调用 render_ui",
                e
            ));
        }
        return Err(format!("A2UI 校验失败：{}。请修正后重试", e));
    }

    let _ = app_handle.emit("jarvis:status", "贾维斯在画界面…");
    let payload = json!({
        "sessionId": session_id,
        "surfaceId": surface_id,
        "messages": msgs,
    });
    let _ = app_handle.emit("jarvis:surface", &payload);

    // 后端直接落库（不同于文字回复由前端 done 落库——界面消息在 tool 循环
    // 中途产生，等 done 时前端已没有上下文判断该存什么）
    if let Ok(conn) = Connection::open(db_path) {
        let content = serde_json::to_string(&payload).unwrap_or_default();
        let _ = conn.execute(
            "INSERT INTO chat_messages (session_id, role, content, content_type, created_at) VALUES (?1, 'assistant', ?2, 'a2ui', datetime('now','localtime'))",
            rusqlite::params![session_id, content],
        );
        let _ = conn.execute(
            "UPDATE chat_sessions SET updated_at = datetime('now','localtime') WHERE id = ?1",
            rusqlite::params![session_id],
        );
    }

    Ok(format!(
        "界面已展示给用户（surface: {}）。用户可能点击其中的按钮或填写表单，届时会以「用户操作」消息的形式回传给你。",
        surface_id
    ))
}

/// 降级纯问答：模型不支持 function calling 时，换无工具措辞的系统提示单次问答。
/// 这是降级链最后一级——贾维斯「失忆但活着」（#4）。
#[allow(clippy::too_many_arguments)]
async fn plain_fallback(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    app_data: &PathBuf,
    provider: &crate::llm_provider::models::Provider,
    model: &crate::llm_provider::models::Model,
    api_key: &str,
    provider_type: &str,
    scene_str: &str,
    thinking_mode: bool,
    session_id: i64,
    text: &str,
) -> Result<(), String> {
    let mut system_prompt = chat::compose_chat_system(
        app_data,
        db_path,
        false,
        chat::monologue_enabled(app_handle),
    );
    let context = load_context(app_handle, db_path, session_id).await?;
    if !context.summary.is_empty() {
        system_prompt.push_str(&format!("\n\n---\n\n# 此前聊天的摘要\n{}", context.summary));
    }
    let mut msgs = vec![crate::llm::ChatMessage {
        role: "system".to_string(),
        content: system_prompt,
        images: None,
    }];
    for (role, content) in context.recent {
        msgs.push(crate::llm::ChatMessage {
            role,
            content,
            images: None,
        });
    }
    msgs.push(crate::llm::ChatMessage {
        role: "user".to_string(),
        content: text.to_string(),
        images: None,
    });

    let started = std::time::Instant::now();
    let result = crate::llm::call_llm(
        &provider.base_url,
        api_key,
        &model.model_id,
        provider_type,
        msgs,
        thinking_mode,
    )
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(reply) => {
            let cost = reply.input_tokens as f64 / 1e6 * model.input_price_per_m.unwrap_or(0.0)
                + reply.output_tokens as f64 / 1e6 * model.output_price_per_m.unwrap_or(0.0);
            crate::llm::observe::log_call(db_path, &crate::llm::observe::LlmCallEntry {
                source: "chat",
                channel: "scene_model",
                scene: Some(scene_str),
                model: Some(&model.model_id),
                input_tokens: reply.input_tokens,
                output_tokens: reply.output_tokens,
                cost_usd: cost,
                duration_ms,
                status: "ok",
                error: None,
            });
            let _ = app_handle.emit("jarvis:chunk", reply.content);
            let _ = app_handle.emit("jarvis:done", cost);
            Ok(())
        }
        Err(e) => {
            crate::llm::observe::log_call(db_path, &crate::llm::observe::LlmCallEntry {
                source: "chat",
                channel: "scene_model",
                scene: Some(scene_str),
                model: Some(&model.model_id),
                input_tokens: 0,
                output_tokens: 0,
                cost_usd: 0.0,
                duration_ms,
                status: "error",
                error: Some(&e),
            });
            let _ = app_handle.emit("jarvis:error", e.clone());
            Err(e)
        }
    }
}

/// 会话上下文：滚动摘要 + 最近原文（组装进系统提示与消息列表）
struct ChatContext {
    summary: String,
    recent: Vec<(String, String)>,
}

/// 读会话上下文；未摘要消息超过阈值时先做增量摘要（rolling summary）。
/// 摘要失败不阻塞聊天——保留旧摘要、全量未摘要原文照带（质量下降而非消失）。
async fn load_context(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    session_id: i64,
) -> Result<ChatContext, String> {
    let (summary, watermark, unsummarized) = {
        let conn = Connection::open(db_path).map_err(|e| format!("打开数据库失败: {}", e))?;
        let (summary, watermark) = conn
            .query_row(
                "SELECT summary, summarized_up_to FROM chat_sessions WHERE id = ?1",
                [session_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
            )
            .unwrap_or((String::new(), 0));
        let mut stmt = conn
            .prepare(
                "SELECT id, role, content, content_type FROM chat_messages
                 WHERE session_id = ?1 AND id > ?2 ORDER BY id ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![session_id, watermark], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        // a2ui 界面消息替换为占位文本：协议 JSON 喂回模型既烧 token 又干扰回答
        let unsummarized: Vec<(i64, String, String)> = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|(id, role, content, content_type)| {
                if content_type == "a2ui" {
                    (id, role, "（向用户展示了一张界面卡片）".to_string())
                } else {
                    (id, role, content)
                }
            })
            .collect();
        (summary, watermark, unsummarized)
    };

    let mut summary = summary;
    let mut summarized_count = 0usize;
    if unsummarized.len() > SUMMARY_THRESHOLD {
        let cut = unsummarized.len() - RECENT_KEEP;
        let chunk = &unsummarized[..cut];
        match summarize_chunk(app_handle, db_path, &summary, chunk).await {
            Ok(new_summary) => {
                let new_watermark = chunk.last().map(|(id, _, _)| *id).unwrap_or(watermark);
                if let Ok(conn) = Connection::open(db_path) {
                    let _ = conn.execute(
                        "UPDATE chat_sessions SET summary = ?1, summarized_up_to = ?2 WHERE id = ?3",
                        rusqlite::params![new_summary, new_watermark, session_id],
                    );
                }
                summary = new_summary;
                summarized_count = cut;
            }
            Err(e) => log::warn!("聊天历史摘要失败（本轮带全量未摘要原文）: {}", e),
        }
    }

    let recent = unsummarized[summarized_count..]
        .iter()
        .map(|(_, role, content)| (role.clone(), content.clone()))
        .collect();
    Ok(ChatContext { summary, recent })
}

/// 把一段旧消息压缩进滚动摘要：旧摘要 + 新增对话 → 新摘要（一次场景模型调用，
/// 登记观测 source=chat_summary——摘要成本在面板可见）。
async fn summarize_chunk(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    old_summary: &str,
    chunk: &[(i64, String, String)],
) -> Result<String, String> {
    let mut dialog = String::new();
    for (_, role, content) in chunk {
        let who = if role == "user" { "他" } else { "你" };
        dialog.push_str(&format!("{}：{}\n", who, content));
    }
    let prompt = format!(
        "把一段聊天记录压缩成摘要，留给未来的自己做上下文。\n\
         要求：200 字以内；保留他提到的事实/偏好/承诺、未完成的约定、重要话题；用「他」指用户、「你」指贾维斯。\n\
         只输出摘要正文，不要任何前后缀。\n\n\
         已有摘要：{}\n\n新增对话：\n{}",
        if old_summary.is_empty() {
            "（无）"
        } else {
            old_summary
        },
        dialog
    );
    analyzer::call_scene_model_llm(
        app_handle,
        db_path,
        prompt,
        Scene::Companion,
        "chat_summary",
    )
    .await
}

/// companion 工具声明转 OpenAI function calling 格式（Ollama 兼容同一格式）。
/// 场景通道比 MCP 通道多一个 render_ui（A2UI 界面渲染，MCP 终端无渲染方）。
fn openai_tools_json() -> serde_json::Value {
    let arr: Vec<serde_json::Value> = tools::scene_tool_definitions()
        .into_iter()
        .map(|d| {
            json!({
                "type": "function",
                "function": {
                    "name": d.name,
                    "description": d.description,
                    "parameters": d.input_schema,
                }
            })
        })
        .collect();
    json!(arr)
}
