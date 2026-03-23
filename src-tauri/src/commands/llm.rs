use crate::commands::settings::SettingsState;
use crate::db::DatabaseState;
use crate::llm::ChatMessage;
use crate::llm_provider::crypto::decrypt;
use crate::llm_provider::db::LlmProviderDb;
use crate::llm_provider::models::Scene;
use tauri::{Manager, State};

/// 调用大模型接口（使用旧版设置，兼容模式）
#[tauri::command]
pub async fn call_llm(
    state: State<'_, SettingsState>,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    let (base_url, api_key, model, thinking_mode) = {
        let manager = state.0.lock().map_err(|e| e.to_string())?;
        let s = manager.get_settings();
        (s.llm_base_url, s.llm_api_key, s.llm_model, s.llm_thinking_mode)
    };

    crate::llm::call_llm(&base_url, &api_key, &model, messages, thinking_mode).await
}

/// 根据场景调用大模型接口
#[tauri::command]
pub async fn call_llm_by_scene(
    db_state: State<'_, DatabaseState>,
    app_handle: tauri::AppHandle,
    scene: String,
    messages: Vec<ChatMessage>,
    thinking_mode: bool,
) -> Result<String, String> {
    let scene_enum: Scene = scene.parse().map_err(|e: String| e)?;

    let (base_url, api_key, model) = {
        let db_path = &db_state.0;
        let conn = rusqlite::Connection::open(db_path)
            .map_err(|e| format!("无法连接数据库: {}", e))?;

        let provider_db = LlmProviderDb;
        let (provider, model) = provider_db
            .get_scene_model(&conn, scene_enum)
            .map_err(|e| format!("获取场景模型失败: {}", e))?
            .ok_or_else(|| format!("场景 '{}' 未配置模型", scene))?;

        // 解密 API key
        let api_key = if let Some(encrypted) = provider.api_key_encrypted {
            if encrypted.is_empty() {
                String::new()
            } else {
                decrypt(&encrypted, &app_handle.path().app_data_dir().unwrap_or_default())
                    .map_err(|e| format!("解密 API Key 失败: {}", e))?
            }
        } else {
            String::new()
        };

        (provider.base_url, api_key, model.model_id)
    };

    crate::llm::call_llm(&base_url, &api_key, &model, messages, thinking_mode).await
}

/// 测试大模型连接（使用旧版设置）
#[tauri::command]
pub async fn test_llm_connection(
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let (base_url, api_key, model, thinking_mode) = {
        let manager = state.0.lock().map_err(|e| e.to_string())?;
        let s = manager.get_settings();
        (s.llm_base_url, s.llm_api_key, s.llm_model, s.llm_thinking_mode)
    };

    let messages = vec![ChatMessage {
        role: "user".to_string(),
        content: "Hello! Please reply with 'Connection successful!' only.".to_string(),
    }];

    crate::llm::call_llm(&base_url, &api_key, &model, messages, thinking_mode).await
}

/// 流式调用大模型接口（使用旧版设置，兼容模式）
/// 事件：llm:chunk (String)、llm:done ("")、llm:error (String)
#[tauri::command]
pub async fn call_llm_stream(
    state: State<'_, SettingsState>,
    app_handle: tauri::AppHandle,
    messages: Vec<ChatMessage>,
) -> Result<(), String> {
    let (base_url, api_key, model, thinking_mode) = {
        let manager = state.0.lock().map_err(|e| e.to_string())?;
        let s = manager.get_settings();
        (s.llm_base_url, s.llm_api_key, s.llm_model, s.llm_thinking_mode)
    };

    crate::llm::call_llm_stream(&base_url, &api_key, &model, messages, thinking_mode, &app_handle).await
}

/// 根据场景流式调用大模型接口
#[tauri::command]
pub async fn call_llm_stream_by_scene(
    db_state: State<'_, DatabaseState>,
    app_handle: tauri::AppHandle,
    scene: String,
    messages: Vec<ChatMessage>,
    thinking_mode: bool,
) -> Result<(), String> {
    let scene_enum: Scene = scene.parse().map_err(|e: String| e)?;

    let (base_url, api_key, model) = {
        let db_path = &db_state.0;
        let conn = rusqlite::Connection::open(db_path)
            .map_err(|e| format!("无法连接数据库: {}", e))?;

        let provider_db = LlmProviderDb;
        let (provider, model) = provider_db
            .get_scene_model(&conn, scene_enum)
            .map_err(|e| format!("获取场景模型失败: {}", e))?
            .ok_or_else(|| format!("场景 '{}' 未配置模型", scene))?;

        // 解密 API key
        let api_key = if let Some(encrypted) = provider.api_key_encrypted {
            if encrypted.is_empty() {
                String::new()
            } else {
                decrypt(&encrypted, &app_handle.path().app_data_dir().unwrap_or_default())
                    .map_err(|e| format!("解密 API Key 失败: {}", e))?
            }
        } else {
            String::new()
        };

        (provider.base_url, api_key, model.model_id)
    };

    crate::llm::call_llm_stream(&base_url, &api_key, &model, messages, thinking_mode, &app_handle).await
}
