use crate::commands::settings::SettingsState;
use crate::db::DatabaseState;
use crate::llm::observe::{log_call, LlmCallEntry, SourceStat};
use crate::llm::ChatMessage;
use crate::llm_provider::crypto::decrypt;
use crate::llm_provider::db::LlmProviderDb;
use crate::llm_provider::models::Scene;
use tauri::{Manager, State};

/// 测试大模型连接（使用旧版设置）
#[tauri::command]
pub async fn test_llm_connection(
    state: State<'_, SettingsState>,
    db_state: State<'_, DatabaseState>,
) -> Result<String, String> {
    let (base_url, api_key, model, thinking_mode) = {
        let manager = state.0.lock().map_err(|e| e.to_string())?;
        let s = manager.get_settings();
        (
            s.llm_base_url,
            s.llm_api_key,
            s.llm_model,
            s.llm_thinking_mode,
        )
    };

    let messages = vec![ChatMessage {
        role: "user".to_string(),
        content: "Hello! Please reply with 'Connection successful!' only.".to_string(),
        images: None,
    }];

    // 旧版设置：从 base_url 推断 provider_type
    let provider_type = if base_url.contains("ollama") || base_url.contains("11434") {
        "ollama"
    } else {
        "openai"
    };

    let started = std::time::Instant::now();
    let result = crate::llm::call_llm(
        &base_url,
        &api_key,
        &model,
        provider_type,
        messages,
        thinking_mode,
    )
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(reply) => {
            log_call(
                &db_state.0,
                &LlmCallEntry {
                    source: "test",
                    channel: "scene_model",
                    scene: None,
                    model: Some(&model),
                    input_tokens: reply.input_tokens,
                    cached_input_tokens: reply.cached_input_tokens,
                    output_tokens: reply.output_tokens,
                    cost_cny: 0.0,
                    duration_ms,
                    tool_call_count: 0,
                    status: "ok",
                    error: None,
                },
            );
            Ok(reply.content)
        }
        Err(e) => {
            log_call(
                &db_state.0,
                &LlmCallEntry {
                    source: "test",
                    channel: "scene_model",
                    scene: None,
                    model: Some(&model),
                    input_tokens: 0,
                    cached_input_tokens: 0,
                    output_tokens: 0,
                    cost_cny: 0.0,
                    duration_ms,
                    tool_call_count: 0,
                    status: "error",
                    error: Some(&e),
                },
            );
            Err(e)
        }
    }
}

/// 根据场景流式调用大模型接口
#[tauri::command]
pub async fn call_llm_stream_by_scene(
    db_state: State<'_, DatabaseState>,
    app_handle: tauri::AppHandle,
    scene: String,
    messages: Vec<ChatMessage>,
    _thinking_mode: bool,
) -> Result<(), String> {
    let scene_enum: Scene = scene.parse().map_err(|e: String| e)?;

    let (base_url, api_key, model, provider_type, thinking_mode) = {
        let db_path = &db_state.0;
        let conn =
            rusqlite::Connection::open(db_path).map_err(|e| format!("无法连接数据库: {}", e))?;

        let provider_db = LlmProviderDb;
        let (provider, model) = provider_db
            .get_scene_model(&conn, scene_enum.clone())
            .map_err(|e| format!("获取场景模型失败: {}", e))?
            .ok_or_else(|| format!("场景 '{}' 未配置模型", scene))?;

        // 获取场景的 thinking_mode 配置
        let thinking_mode = provider_db
            .get_scene_thinking_mode(&conn, scene_enum.clone())
            .unwrap_or(false);

        // 解密 API key
        let api_key = if let Some(encrypted) = provider.api_key_encrypted {
            if encrypted.is_empty() {
                String::new()
            } else {
                decrypt(
                    &encrypted,
                    &app_handle.path().app_data_dir().unwrap_or_default(),
                )
                .map_err(|e| format!("解密 API Key 失败: {}", e))?
            }
        } else {
            String::new()
        };

        let provider_type_str = provider.provider_type.to_string();

        (
            provider.base_url,
            api_key,
            model.model_id,
            provider_type_str,
            thinking_mode,
        )
    };

    let started = std::time::Instant::now();
    let scene_str = scene_enum.to_string();
    let model_for_log = model.clone();
    let result = crate::llm::call_llm_stream(
        &base_url,
        &api_key,
        &model,
        &provider_type,
        messages,
        thinking_mode,
        &app_handle,
    )
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;

    // 流式通道无法从响应拿 token 用量（OpenAI 流式 usage 需额外协商，兼容性风险），
    // 只登记次数/耗时——诚实的降级，面板按来源分组时该来源 token 显示为 0
    match &result {
        Ok(()) => {
            log_call(
                &db_state.0,
                &LlmCallEntry {
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
                    status: "ok",
                    error: None,
                },
            );
        }
        Err(e) => {
            log_call(
                &db_state.0,
                &LlmCallEntry {
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
                    status: "error",
                    error: Some(e),
                },
            );
        }
    }
    result
}

/// 调用观测面板：按来源聚合的统计（range: today | yesterday | week）
#[tauri::command]
pub fn get_llm_call_stats(
    db_state: State<'_, DatabaseState>,
    range: String,
) -> Result<Vec<SourceStat>, String> {
    let now = chrono::Local::now();
    let today_start = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .ok_or("无法计算今日起点")?
        .and_local_timezone(chrono::Local)
        .single()
        .ok_or("无法计算今日起点时区")?
        .timestamp();

    let (since, until) = match range.as_str() {
        "today" => (today_start, now.timestamp()),
        "yesterday" => (today_start - 86400, today_start),
        "week" => (today_start - 6 * 86400, now.timestamp()),
        _ => return Err(format!("未知统计范围: {}", range)),
    };

    crate::llm::observe::summarize(&db_state.0, since, until)
}
