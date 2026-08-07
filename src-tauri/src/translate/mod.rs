use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::clipboard::ClipboardSuppressFlag;
use crate::llm::ChatMessage;
use crate::llm_provider::crypto::decrypt;
use crate::llm_provider::db::LlmProviderDb;
use crate::llm_provider::models::Scene;

/// 流式翻译事件通道（独立于 llm:*，避免与主窗口聊天视图串线）。
/// payload 统一携带递增请求 id，前端只接受最新 id——浮窗与启动器视图
/// 并发翻译时各自按 id 过滤，互不污染。
pub const EVT_START: &str = "translate:start";
pub const EVT_CHUNK: &str = "translate:chunk";
pub const EVT_DONE: &str = "translate:done";
pub const EVT_ERROR: &str = "translate:error";

/// 翻译请求 id（进程内递增，前端以此判断消息是否属于当前请求）
static REQUEST_ID: AtomicU64 = AtomicU64::new(0);

/// 目标语言设置项 KV key（settings 表）
pub const TARGET_LANG_KEY: &str = "translate.target_language";
/// 默认目标语言
pub const DEFAULT_TARGET_LANG: &str = "中文";

/// translate:start payload：翻译开始，浮窗据此渲染原文并进入接收态
#[derive(Debug, Clone, Serialize)]
pub struct TranslateStartPayload {
    pub id: u64,
    pub source: String,
    pub target_lang: String,
}

/// translate:chunk / done / error 的统一壳（字段按需填充）
#[derive(Debug, Clone, Serialize)]
pub struct TranslateEventPayload {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// 翻译专用 system prompt：目标语言插值；硬约束让译文干净可复制
fn build_prompt(target_lang: &str) -> String {
    format!(
        r#"你是专业翻译引擎。将用户提供的文本翻译成{target_lang}。

要求：
- 只输出译文本身，不解释、不打招呼、不附加任何其他内容
- 专有名词、代码片段、数字、URL 原样保留
- 保持原文的分段、列表与标点习惯
- 译文自然通顺，符合{target_lang}表达习惯

用户文本可能包含多段或多语言混合，整体翻译为{target_lang}。"#
    )
}

/// 读取目标语言设置（缺省中文）
pub fn get_target_language(app_handle: &AppHandle) -> String {
    if let Some(settings_state) = app_handle.try_state::<crate::commands::settings::SettingsState>() {
        if let Ok(manager) = settings_state.0.lock() {
            if let Ok(Some(v)) = manager.get_setting(TARGET_LANG_KEY) {
                if !v.trim().is_empty() {
                    return v;
                }
            }
        }
    }
    DEFAULT_TARGET_LANG.to_string()
}

/// 快捷键链路入口（shortcuts.rs 的 handle_shortcut_action 调用，同步返回）。
/// 流程：模拟 Ctrl+C 捕获选区 → 恢复原剪贴板 → 弹浮窗 → 流式翻译。
pub fn trigger_selection_translate(app_handle: &AppHandle) {
    let app_handle = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        match capture_selection_text(&app_handle).await {
            Ok(source) => {
                if source.trim().is_empty() {
                    show_selection_hint(&app_handle);
                    return;
                }
                let target_lang = get_target_language(&app_handle);
                // 先分配请求 id 再弹窗：start/chunk/done 全挂同一 id，前端按最新 id 过滤
                let req_id = REQUEST_ID.fetch_add(1, Ordering::Relaxed) + 1;
                if !show_translate_toast(&app_handle, req_id, &source, &target_lang) {
                    return; // 浮窗缺失（预创建失败）：不空跑 LLM
                }
                if let Err(e) = stream_translate(&app_handle, req_id, &source, &target_lang).await {
                    log::error!("划词翻译失败: {}", e);
                }
            }
            Err(e) => {
                log::warn!("捕获选区失败: {}", e);
                show_selection_hint(&app_handle);
            }
        }
    });
}

/// 启动器视图翻译入口（直接传文本，不碰剪贴板）。
/// target_lang 缺省取设置值；视图可传覆盖值。
/// 立即返回请求 id（流式在后台跑）——前端必须先拿到 id 再收 chunk，
/// 否则整条流会被 id 过滤丢弃（await 到流结束才返回等于永远收不到）。
#[tauri::command]
pub async fn translate_text(
    app_handle: AppHandle,
    text: String,
    target_lang: Option<String>,
) -> Result<u64, String> {
    if text.trim().is_empty() {
        return Err("翻译文本为空".to_string());
    }
    let target_lang = target_lang
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| get_target_language(&app_handle));
    let req_id = REQUEST_ID.fetch_add(1, Ordering::Relaxed) + 1;
    let app = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        // 错误（含场景未配置等前置错误）已由 stream_translate 经 EVT_ERROR 下发，此处只落日志
        if let Err(e) = stream_translate(&app, req_id, &text, &target_lang).await {
            log::error!("视图翻译失败: {}", e);
        }
    });
    Ok(req_id)
}

/// 捕获当前选区文本：备份剪贴板 → 模拟 Ctrl+C → 轮询剪贴板变化 → 恢复原内容。
/// 全程抑制剪贴板历史记录（内部写入不走历史）。
/// 剪贴板无变化（无选区）判为 None→Err，由调用方提示。
async fn capture_selection_text(app_handle: &AppHandle) -> Result<String, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;

    // 1. 备份当前剪贴板。文本优先；无文本时尝试备份图片——否则一次划词翻译
    //    就把用户剪贴板里的截图顶掉了（CF_HDROP 等文件格式插件不支持，放弃备份）
    let backup: String = app_handle.clipboard().read_text().unwrap_or_default();
    let backup_image = if backup.is_empty() {
        app_handle.clipboard().read_image().ok()
    } else {
        None
    };

    // 2. 抑制历史 + 模拟 Ctrl+C（SendInput 注入，异步生效）
    suppress_clipboard(app_handle);
    simulate_ctrl_c();

    // 3. 轮询剪贴板直到内容变化（SendInput 经消息队列注入，需等待；
    //    600ms 无变化判无选区——Word 等重型应用响应 Ctrl+C 较慢，不宜太短）
    let mut selected: Option<String> = None;
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_millis(10)).await;
        let current: String = app_handle.clipboard().read_text().unwrap_or_default();
        if current != backup && !current.trim().is_empty() {
            selected = Some(current);
            break;
        }
    }

    // 4. 恢复原剪贴板内容（同样抑制历史）
    if !backup.is_empty() {
        suppress_clipboard(app_handle);
        if let Err(e) = app_handle.clipboard().write_text(&backup) {
            log::warn!("恢复剪贴板失败: {}", e);
        }
    } else if let Some(img) = backup_image {
        suppress_clipboard(app_handle);
        if let Err(e) = app_handle.clipboard().write_image(&img) {
            log::warn!("恢复剪贴板图片失败: {}", e);
        }
    }

    selected.ok_or_else(|| "未检测到选中文本".to_string())
}

/// 置位剪贴板抑制标记（下一次剪贴板事件不入历史；事件处理器消费后自动清除）
fn suppress_clipboard(app_handle: &AppHandle) {
    if let Some(flag) = app_handle.try_state::<ClipboardSuppressFlag>() {
        flag.suppress();
    }
}

/// 模拟 Ctrl+C（windows crate SendInput）。仅在 Windows 有效；其他平台 no-op。
/// 注入序列：Shift up（若按着）→ Ctrl down → C down → C up（不注入 Ctrl up）。
/// 注入的 keybd 事件异步经消息队列生效，调用方随后轮询剪贴板确认结果。
///
/// 关键：快捷键触发瞬间 Ctrl/Shift 组合键仍物理按下，若直接注入 Ctrl+C 会被
/// 组合成 Ctrl+Shift+C——那正是系统自己的全局快捷键（打开剪贴板），会串台
/// 触发主窗口。必须先抬掉 Shift；Ctrl 保持不动（重复 down 无害，不注入 up
/// 以免提前消费用户仍按着的物理按键状态）。
#[cfg(target_os = "windows")]
fn simulate_ctrl_c() {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, KEYBDINPUT, KEYEVENTF_KEYUP, INPUT, INPUT_0,
        INPUT_KEYBOARD, VK_CONTROL, VK_C, VK_SHIFT,
    };

    let key = |vk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY,
               up: bool| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: 0,
                dwFlags: if up { KEYEVENTF_KEYUP } else { Default::default() },
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };

    unsafe {
        // 返回 i16，高位为 1 表示按键处于按下态（与 lib.rs 的 VK_LBUTTON 检测同款写法）
        let shift_held = GetAsyncKeyState(VK_SHIFT.0 as i32) < 0;

        let mut inputs = Vec::new();
        if shift_held {
            inputs.push(key(VK_SHIFT, true));
        }
        inputs.push(key(VK_CONTROL, false));
        inputs.push(key(VK_C, false));
        inputs.push(key(VK_C, true));
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

/// 非 Windows 平台模拟 Ctrl+C 为 no-op（无选区捕获能力，触发时走提示路径）
#[cfg(not(target_os = "windows"))]
fn simulate_ctrl_c() {}

/// 把浮窗移动到鼠标右下方（贴近选区），越界回收到鼠标左上方。
/// show_translate_toast 与 show_selection_hint 共用。
fn move_toast_near_cursor(window: &tauri::WebviewWindow) {
    // 固定窗口尺寸（与前端卡片匹配）
    const TOAST_WIDTH: f64 = 420.0;
    const TOAST_HEIGHT: f64 = 340.0;
    const OFFSET: f64 = 24.0; // 距鼠标的偏移（逻辑像素）

    let Some((cx, cy)) = crate::get_cursor_pos() else {
        return;
    };
    let Some(monitor) = crate::get_monitor_at_cursor(window.app_handle()) else {
        return;
    };
    let scale = monitor.scale_factor();
    let win_w = (TOAST_WIDTH * scale) as i32;
    let win_h = (TOAST_HEIGHT * scale) as i32;
    let x = cx + (OFFSET * scale) as i32;
    let y = cy + (OFFSET * scale) as i32;

    // 不出屏：越界时回收到鼠标左上方
    let mon_pos = monitor.position();
    let mon_size = monitor.size();
    let max_x = mon_pos.x + mon_size.width as i32 - win_w;
    let max_y = mon_pos.y + mon_size.height as i32 - win_h;
    let x = x.min(max_x.max(mon_pos.x));
    let y = y.min(max_y.max(mon_pos.y));

    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
        width: win_w as u32,
        height: win_h as u32,
    }));
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
}

/// 弹出翻译浮窗并下发 start 事件（原文 + 目标语言）。返回窗口是否存在——
/// 预创建失败时调用方应中止后续流式（跑了 LLM 也无处可显示）。
fn show_translate_toast(app_handle: &AppHandle, req_id: u64, source: &str, target_lang: &str) -> bool {
    let Some(window) = app_handle.get_webview_window("translate-toast") else {
        log::warn!("translate-toast 窗口不存在");
        return false;
    };

    move_toast_near_cursor(&window);

    if let Err(e) = window.show() {
        log::warn!("显示 translate-toast 窗口失败: {}", e);
    } else {
        // 抢焦点以支持 Esc/复制快捷键；被 Windows 焦点锁拦截时退化为点击后可用
        let _ = window.set_focus();
    }

    let _ = app_handle.emit(
        EVT_START,
        TranslateStartPayload {
            id: req_id,
            source: source.to_string(),
            target_lang: target_lang.to_string(),
        },
    );
    true
}

/// 无选区/捕获失败提示：复用浮窗，短显后消失（前端对提示类错误 2s 后自动隐藏）。
/// 提示也分配新请求 id——前端以「id 大于已知最新」识别提示类错误，
/// 若复用旧 id，有历史翻译时提示会被当成普通错误滞留到兜底超时。
fn show_selection_hint(app_handle: &AppHandle) {
    let Some(window) = app_handle.get_webview_window("translate-toast") else {
        return;
    };
    move_toast_near_cursor(&window);
    let _ = window.show();
    let _ = window.set_focus();
    let req_id = REQUEST_ID.fetch_add(1, Ordering::Relaxed) + 1;
    let _ = app_handle.emit(
        EVT_ERROR,
        TranslateEventPayload {
            id: req_id,
            text: None,
            message: Some("未检测到选中文本，请先在目标窗口选中文字".to_string()),
        },
    );
}

/// 翻译请求配置：场景模型 + 提供商 + 密钥，prepare_translate_request 的产物
struct TranslateRequestConfig {
    base_url: String,
    api_key: String,
    model: String,
    provider_type: String,
    thinking_mode: bool,
    reasoning_effort: String,
}

/// 读 Scene::Translate 场景配置，解出请求所需的全部字段（含 API Key 解密）。
/// 前置失败（未配置模型/DB 异常/解密失败）在此集中报错。
fn prepare_translate_request(app_handle: &AppHandle) -> Result<TranslateRequestConfig, String> {
    let app_data = app_handle.path().app_data_dir().unwrap_or_default();
    let conn = rusqlite::Connection::open(app_data.join(crate::DB_FILE_NAME))
        .map_err(|e| format!("无法连接数据库: {e}"))?;
    let provider_db = LlmProviderDb;
    let (provider, model) = provider_db
        .get_scene_model(&conn, Scene::Translate)
        .map_err(|e| format!("获取翻译场景模型失败: {e}"))?
        .ok_or_else(|| "翻译场景未配置模型，请先在「模型设置」中为翻译场景配置模型".to_string())?;
    if model.model_id.is_empty() {
        return Err("模型名称未配置".to_string());
    }
    let thinking_mode = provider_db
        .get_scene_thinking_mode(&conn, Scene::Translate)
        .unwrap_or(false);
    let reasoning_effort = provider_db
        .get_scene_reasoning_effort(&conn, Scene::Translate)
        .unwrap_or_else(|_| "medium".to_string());
    let api_key = match provider.api_key_encrypted {
        Some(encrypted) if !encrypted.is_empty() => {
            decrypt(&encrypted, &app_data).map_err(|e| format!("解密 API Key 失败: {e}"))?
        }
        _ => String::new(),
    };
    Ok(TranslateRequestConfig {
        base_url: provider.base_url,
        api_key,
        model: model.model_id,
        provider_type: provider.provider_type.to_string(),
        thinking_mode,
        reasoning_effort,
    })
}

/// 核心流式翻译：读 Scene::Translate 场景配置 → 组装 prompt → 流式解析并 emit。
/// SSE（OpenAI 兼容）与 NDJSON（Ollama 原生）双格式，骨架同 plugin_gen.rs。
async fn stream_translate(
    app_handle: &AppHandle,
    req_id: u64,
    source: &str,
    target_lang: &str,
) -> Result<(), String> {
    // 前置错误同样经事件下发：视图链路 spawn 后拿不到命令返回值，
    // toast 链路本就只有事件——两条链路都靠 EVT_ERROR 展示失败
    let cfg = match prepare_translate_request(app_handle) {
        Ok(c) => c,
        Err(e) => {
            let _ = app_handle.emit(
                EVT_ERROR,
                TranslateEventPayload { id: req_id, text: None, message: Some(e.clone()) },
            );
            return Err(e);
        }
    };

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: build_prompt(target_lang),
            images: None,
        },
        ChatMessage {
            role: "user".to_string(),
            content: source.to_string(),
            images: None,
        },
    ];

    let started = std::time::Instant::now();
    let result = request_stream(
        app_handle,
        req_id,
        &cfg.base_url,
        &cfg.api_key,
        &cfg.model,
        &cfg.provider_type,
        messages,
        cfg.thinking_mode,
        &cfg.reasoning_effort,
    )
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;

    // 观测登记（channel=scene_model，source=translate，与 llm.rs 场景流式同款降级）
    let scene_str = "translate".to_string();
    let model_for_log = cfg.model.clone();
    crate::llm::observe::log_call(
        &app_handle.path().app_data_dir().unwrap_or_default().join(crate::DB_FILE_NAME),
        &crate::llm::observe::LlmCallEntry {
            source: &scene_str,
            channel: "scene_model",
            scene: Some(&scene_str),
            model: Some(&model_for_log),
            input_tokens: 0,
            cached_input_tokens: 0,
            output_tokens: 0,
            cost_cny: 0.0,
            duration_ms,
            tool_call_count: 0,
            status: if result.is_ok() { "ok" } else { "error" },
            error: result.as_ref().err().map(|s| s.as_str()),
        },
    );

    result
}

/// 流式请求并逐段 emit translate:chunk。超时 300s（思考模式长生成，避免 120s 默认超时截断）。
#[allow(clippy::too_many_arguments)]
async fn request_stream(
    app_handle: &AppHandle,
    req_id: u64,
    base_url: &str,
    api_key: &str,
    model: &str,
    provider_type: &str,
    messages: Vec<ChatMessage>,
    thinking_mode: bool,
    reasoning_effort: &str,
) -> Result<(), String> {
    let emit = |evt: &str, payload: TranslateEventPayload| -> Result<(), String> {
        app_handle.emit(evt, payload).map_err(|e| format!("emit 失败: {e}"))
    };

    let trimmed = base_url.trim_end_matches('/');
    let is_ollama_native = provider_type == "ollama";
    let url = if is_ollama_native {
        format!("{}/api/chat", trimmed)
    } else {
        format!("{}/chat/completions", trimmed)
    };

    let client = crate::http::build_client(Duration::from_secs(300))
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?;

    let body = {
        let mut b = serde_json::json!({
            "model": model,
            "messages": messages
                .iter()
                .map(|m| serde_json::json!({ "role": m.role, "content": m.content }))
                .collect::<Vec<_>>(),
            "stream": true,
        });
        if is_ollama_native {
            b["think"] = serde_json::json!(thinking_mode);
        } else {
            let is_bailian = base_url.contains("bailian") || base_url.contains("aliyun");
            let is_deepseek = base_url.contains("deepseek");
            if is_bailian {
                b["enable_thinking"] = serde_json::json!(thinking_mode);
            } else if is_deepseek {
                b["thinking"] = serde_json::json!({
                    "type": if thinking_mode { "enabled" } else { "disabled" }
                });
                if thinking_mode {
                    b["reasoning_effort"] = serde_json::json!(reasoning_effort);
                }
            } else if thinking_mode {
                b["reasoning_effort"] = serde_json::json!(reasoning_effort);
            }
        }
        b
    };

    let mut req_builder = client.post(&url).json(&body);
    if !api_key.is_empty() {
        req_builder = req_builder.header("Authorization", format!("Bearer {api_key}"));
    }

    let response = req_builder.send().await.map_err(|e| {
        let msg = format!("请求失败: {e}");
        let _ = emit(EVT_ERROR, TranslateEventPayload { id: req_id, text: None, message: Some(msg.clone()) });
        msg
    })?;

    let status = response.status();
    if !status.is_success() {
        let resp_body = response.text().await.unwrap_or_default();
        let err = format!("API 错误 {status}: {resp_body}");
        let _ = emit(EVT_ERROR, TranslateEventPayload { id: req_id, text: None, message: Some(err.clone()) });
        return Err(err);
    }

    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut line_buf: Vec<u8> = Vec::new();
    let mut content_acc = String::new();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("读取流失败: {e}"))?;
        for byte in chunk {
            if byte == b'\n' {
                let line = {
                    let raw = std::str::from_utf8(&line_buf)
                        .unwrap_or("")
                        .trim_end_matches('\r');
                    raw.to_string()
                };
                line_buf.clear();

                if line.is_empty() {
                    continue;
                }

                let delta: Option<String> = if is_ollama_native {
                    match serde_json::from_str::<GenOllamaChunk>(&line) {
                        Ok(c) if !c.done => Some(c.message.content),
                        _ => None,
                    }
                } else {
                    let data = line.strip_prefix("data: ").map(|s| s.trim());
                    match data {
                        Some("[DONE]") | None => None,
                        Some(json_line) => serde_json::from_str::<GenStreamChunk>(json_line)
                            .ok()
                            .and_then(|c| c.choices.into_iter().next())
                            .and_then(|choice| choice.delta.content)
                            .filter(|s| !s.is_empty()),
                    }
                };

                if let Some(delta) = delta {
                    content_acc.push_str(&delta);
                    emit(
                        EVT_CHUNK,
                        TranslateEventPayload { id: req_id, text: Some(delta), message: None },
                    )?;
                }
            } else {
                line_buf.push(byte);
            }
        }
    }

    // 流结束后 line_buf 剩余的最后一行（无结尾换行符的情况）
    if !line_buf.is_empty() {
        let line = String::from_utf8_lossy(&line_buf)
            .trim_end_matches('\r')
            .to_string();
        if is_ollama_native {
            if let Ok(c) = serde_json::from_str::<GenOllamaChunk>(&line) {
                if !c.done {
                    let _ = emit(
                        EVT_CHUNK,
                        TranslateEventPayload { id: req_id, text: Some(c.message.content), message: None },
                    );
                }
            }
        } else if let Some(data) = line.strip_prefix("data: ").map(|s| s.trim()) {
            if data != "[DONE]" {
                if let Ok(c) = serde_json::from_str::<GenStreamChunk>(data) {
                    if let Some(delta) = c.choices.into_iter().next().and_then(|ch| ch.delta.content) {
                        let _ = emit(
                            EVT_CHUNK,
                            TranslateEventPayload { id: req_id, text: Some(delta), message: None },
                        );
                    }
                }
            }
        }
    }

    let _ = emit(EVT_DONE, TranslateEventPayload { id: req_id, text: None, message: None });
    Ok(())
}

/// OpenAI SSE 流式 chunk（与 plugin_gen.rs / llm/mod.rs 同形）
#[derive(Deserialize)]
struct GenStreamChunk {
    choices: Vec<GenChoice>,
}
#[derive(Deserialize)]
struct GenChoice {
    delta: GenDelta,
}
#[derive(Deserialize)]
struct GenDelta {
    content: Option<String>,
}
#[derive(Deserialize)]
struct GenOllamaChunk {
    message: GenOllamaMessage,
    done: bool,
}
#[derive(Deserialize)]
struct GenOllamaMessage {
    content: String,
}
