//! Moss 语音服务(platform.mosi.cn):API Key 管理 + 音频转写。
//! Key 加密存 settings 表(复用 llm_provider::crypto,与提供商密钥同套派生);
//! HTTP 走统一工厂(系统代理开关生效),端点契约见
//! docs/analysis/2026-08-12-CASE-001-Moss平台能力调研与语音升级分析_01.md

use std::path::PathBuf;
use std::time::Duration;

use tauri::{AppHandle, Manager, State};

use crate::companion::analyzer;

pub mod tts;

pub(crate) const API_BASE: &str = "https://api.mosi.cn/v1";
/// settings 表里的 Key 密文条目(空串/缺失 = 未配置)
const KEY_SETTING: &str = "moss_api_key_encrypted";
/// 同步转写等待上限:聊天语音一般几十秒;大文件场景走异步任务(未接入)
const TRANSCRIBE_TIMEOUT: Duration = Duration::from_secs(120);

/// 读出并解密 Moss API Key;未配置/解密失败给出可操作的错误文案
pub(crate) fn load_api_key(app_handle: &AppHandle, db_path: &PathBuf) -> Result<String, String> {
    let encrypted = analyzer::load_setting(db_path, KEY_SETTING).unwrap_or_default();
    if encrypted.is_empty() {
        return Err("未配置 Moss API Key,请先在「设置 → AI 模型 → 语音服务」中填写".to_string());
    }
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let key = crate::llm_provider::crypto::decrypt(&encrypted, &app_data)
        .map_err(|e| format!("Moss API Key 解密失败,请在设置中重新填写: {e}"))?;
    if key.is_empty() {
        return Err("Moss API Key 为空,请在设置中重新填写".to_string());
    }
    Ok(key)
}

/// 语音服务是否已配置 Key(前端据此切换引导文案,不回传明文)
#[tauri::command]
pub fn moss_key_status(db_state: State<'_, crate::db::DatabaseState>) -> Result<bool, String> {
    Ok(analyzer::load_setting(&db_state.0, KEY_SETTING)
        .map(|v| !v.is_empty())
        .unwrap_or(false))
}

/// 保存 Moss API Key(加密入 settings 表);空串视为清除
#[tauri::command]
pub fn moss_set_api_key(
    app_handle: AppHandle,
    db_state: State<'_, crate::db::DatabaseState>,
    key: String,
) -> Result<(), String> {
    let key = key.trim().to_string();
    let stored = if key.is_empty() {
        String::new()
    } else {
        let app_data = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?;
        crate::llm_provider::crypto::encrypt(&key, &app_data)?
    };
    analyzer::save_setting(&db_state.0, KEY_SETTING, &stored);
    Ok(())
}

/// 音频转写:录音字节 → moss-transcribe 同步接口 → 文本。
/// file_name 需带扩展名(webm/wav/mp3…),服务端据它识别容器格式。
#[tauri::command]
pub async fn moss_transcribe(
    app_handle: AppHandle,
    db_state: State<'_, crate::db::DatabaseState>,
    audio: Vec<u8>,
    file_name: String,
) -> Result<String, String> {
    if audio.is_empty() {
        return Err("录音数据为空".to_string());
    }
    let api_key = load_api_key(&app_handle, &db_state.0)?;
    let client = crate::http::build_client(TRANSCRIBE_TIMEOUT)?;

    let part = reqwest::multipart::Part::bytes(audio).file_name(file_name);
    let form = reqwest::multipart::Form::new()
        .text("model", "moss-transcribe")
        .text("response_format", "json")
        .part("file", part);

    let resp = client
        .post(format!("{API_BASE}/audio/transcriptions"))
        .header("Authorization", format!("Bearer {api_key}"))
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("转写请求失败: {e}"))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取转写响应失败: {e}"))?;
    if !status.is_success() {
        // 错误体为 JSON(error.message),提取不到则给原文截断
        let msg = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| {
                v.pointer("/error/message")
                    .and_then(|m| m.as_str())
                    .map(String::from)
            })
            .unwrap_or_else(|| body.chars().take(200).collect());
        return Err(format!("转写失败({status}): {msg}"));
    }

    let text = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(String::from))
        .unwrap_or_default();
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("未识别到语音内容".to_string());
    }
    Ok(text)
}
