use crate::llm_provider::crypto::decrypt;
use crate::llm_provider::models::{ModelInfo, Provider, ProviderType};
use serde::Deserialize;
use std::path::Path;

/// 从提供商获取模型列表
pub async fn fetch_models(
    provider: &Provider,
    app_data_dir: &Path,
) -> Result<Vec<ModelInfo>, String> {
    match provider.provider_type {
        ProviderType::Ollama => fetch_ollama_models(provider, app_data_dir).await,
        ProviderType::OpenAi
        | ProviderType::DeepSeek
        | ProviderType::Bailian
        | ProviderType::Custom => fetch_openai_compatible_models(provider, app_data_dir).await,
    }
}

/// Ollama 模型列表响应结构
#[derive(Debug, Deserialize)]
struct OllamaModel {
    name: String,
    #[serde(default)]
    size: Option<i64>,
    #[allow(dead_code)]
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OllamaTagsResponse {
    models: Vec<OllamaModel>,
}

/// 从 Ollama 获取模型列表
/// GET /api/tags
async fn fetch_ollama_models(
    provider: &Provider,
    app_data_dir: &Path,
) -> Result<Vec<ModelInfo>, String> {
    let url = format!("{}/api/tags", provider.base_url.trim_end_matches('/'));

    let client = reqwest::Client::new();
    let mut request = client.get(&url);

    // Ollama 通常不需要 API Key，但如果提供了则解密并添加
    if let Some(api_key_encrypted) = &provider.api_key_encrypted {
        if !api_key_encrypted.is_empty() {
            let api_key = decrypt(api_key_encrypted, app_data_dir)?;
            if !api_key.is_empty() {
                request = request.header("Authorization", format!("Bearer {}", api_key));
            }
        }
    }

    let response = request.send().await.map_err(|e| {
        if e.is_connect() {
            format!(
                "无法连接到 Ollama 服务 ({})。请确认 Ollama 是否已启动。",
                provider.base_url
            )
        } else {
            format!("请求失败: {}", e)
        }
    })?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("API 错误 ({}): {}", status, body));
    }

    let resp: OllamaTagsResponse = response.json().await.map_err(|e| {
        format!("解析响应失败: {}。请确认这是 Ollama 服务地址。", e)
    })?;

    let models: Vec<ModelInfo> = resp
        .models
        .into_iter()
        .map(|m| ModelInfo {
            id: m.name.clone(),
            name: m.name,
            description: m.size.map(|s| format!("Size: {} MB", s / 1024 / 1024)),
        })
        .collect();

    Ok(models)
}

/// OpenAI 兼容 API 模型列表响应结构
#[derive(Debug, Deserialize)]
struct OpenAiModel {
    id: String,
    #[allow(dead_code)]
    #[serde(default)]
    object: Option<String>,
    #[serde(default)]
    owned_by: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiModelsResponse {
    data: Vec<OpenAiModel>,
}

/// 从 OpenAI 兼容 API 获取模型列表
/// GET /models
async fn fetch_openai_compatible_models(
    provider: &Provider,
    app_data_dir: &Path,
) -> Result<Vec<ModelInfo>, String> {
    let url = format!("{}/models", provider.base_url.trim_end_matches('/'));

    let client = reqwest::Client::new();
    let mut request = client.get(&url);

    // OpenAI 兼容 API 通常需要 API Key，需要解密后使用
    if let Some(api_key_encrypted) = &provider.api_key_encrypted {
        if !api_key_encrypted.is_empty() {
            let api_key = decrypt(api_key_encrypted, app_data_dir)?;
            if !api_key.is_empty() {
                request = request.header("Authorization", format!("Bearer {}", api_key));
            }
        }
    }

    let response = request.send().await.map_err(|e| {
        if e.is_connect() {
            format!(
                "无法连接到服务 ({})。请确认地址是否正确。",
                provider.base_url
            )
        } else {
            format!("请求失败: {}", e)
        }
    })?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("API 错误 ({}): {}", status, body));
    }

    let resp: OpenAiModelsResponse = response.json().await.map_err(|e| {
        format!(
            "解析响应失败: {}。请确认这是 OpenAI 兼容 API 地址。",
            e
        )
    })?;

    let models: Vec<ModelInfo> = resp
        .data
        .into_iter()
        .map(|m| ModelInfo {
            id: m.id.clone(),
            name: m.id.clone(),
            description: m.owned_by.map(|o| format!("By: {}", o)),
        })
        .collect();

    Ok(models)
}

/// 测试与提供商的连接
pub async fn test_connection(provider: &Provider, app_data_dir: &Path) -> Result<Vec<ModelInfo>, String> {
    fetch_models(provider, app_data_dir).await
}
