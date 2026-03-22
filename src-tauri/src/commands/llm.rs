use crate::commands::settings::SettingsState;
use crate::llm::ChatMessage;
use tauri::State;

/// 调用大模型接口
#[tauri::command]
pub async fn call_llm(
    state: State<'_, SettingsState>,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    let (base_url, api_key, model) = {
        let manager = state.0.lock().map_err(|e| e.to_string())?;
        let s = manager.get_settings();
        (s.llm_base_url, s.llm_api_key, s.llm_model)
    };

    crate::llm::call_llm(&base_url, &api_key, &model, messages).await
}

/// 测试大模型连接
#[tauri::command]
pub async fn test_llm_connection(
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let (base_url, api_key, model) = {
        let manager = state.0.lock().map_err(|e| e.to_string())?;
        let s = manager.get_settings();
        (s.llm_base_url, s.llm_api_key, s.llm_model)
    };

    let messages = vec![ChatMessage {
        role: "user".to_string(),
        content: "Hello! Please reply with 'Connection successful!' only.".to_string(),
    }];

    crate::llm::call_llm(&base_url, &api_key, &model, messages).await
}

/// 流式调用大模型接口，通过事件通道推送 chunk
/// 事件：llm:chunk (String)、llm:done ("")、llm:error (String)
#[tauri::command]
pub async fn call_llm_stream(
    state: State<'_, SettingsState>,
    app_handle: tauri::AppHandle,
    messages: Vec<ChatMessage>,
) -> Result<(), String> {
    let (base_url, api_key, model) = {
        let manager = state.0.lock().map_err(|e| e.to_string())?;
        let s = manager.get_settings();
        (s.llm_base_url, s.llm_api_key, s.llm_model)
    };

    crate::llm::call_llm_stream(&base_url, &api_key, &model, messages, &app_handle).await
}
