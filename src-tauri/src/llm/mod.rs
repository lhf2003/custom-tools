use serde::{Deserialize, Serialize};
use tauri::Emitter;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<&'a str>,
}

#[derive(Debug, Serialize)]
struct OllamaChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<serde_json::Map<String, serde_json::Value>>,
}

// OpenAI 格式响应（非流式）
#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

#[derive(Debug, Deserialize)]
struct OpenAiResponse {
    choices: Vec<ChatChoice>,
}

// Ollama 原生 /api/chat 格式响应（非流式）
#[derive(Debug, Deserialize)]
struct OllamaResponse {
    message: ChatMessage,
}

// OpenAI streaming chunk 结构
#[derive(Debug, Deserialize)]
struct StreamDelta {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StreamChoice {
    delta: StreamDelta,
}

#[derive(Debug, Deserialize)]
struct StreamChunk {
    choices: Vec<StreamChoice>,
}

// Ollama streaming chunk 结构
#[derive(Debug, Deserialize)]
struct OllamaStreamChunk {
    message: ChatMessage,
    done: bool,
}

pub async fn call_llm(
    base_url: &str,
    api_key: &str,
    model: &str,
    messages: Vec<ChatMessage>,
    thinking_mode: bool,
) -> Result<String, String> {
    if model.is_empty() {
        return Err("模型名称未配置".to_string());
    }

    let trimmed = base_url.trim_end_matches('/');
    // 以 /api/chat 结尾时使用 Ollama 原生格式，否则追加 /chat/completions 使用 OpenAI 格式
    let is_ollama_native = trimmed.ends_with("/api/chat");
    let url = if is_ollama_native {
        trimmed.to_string()
    } else {
        format!("{}/chat/completions", trimmed)
    };

    let client = reqwest::Client::new();

    let mut req_builder = if is_ollama_native {
        // Ollama 使用原生格式
        let options = if thinking_mode {
            let mut opts = serde_json::Map::new();
            opts.insert("temperature".to_string(), serde_json::json!(0.7));
            opts.insert("num_ctx".to_string(), serde_json::json!(8192));
            Some(opts)
        } else {
            None
        };
        let request = OllamaChatRequest {
            model,
            messages: &messages,
            stream: false,
            options,
        };
        client.post(&url).json(&request)
    } else {
        // OpenAI 兼容格式
        let request = ChatRequest {
            model,
            messages: &messages,
            stream: false,
            reasoning_effort: if thinking_mode { Some("medium") } else { None },
        };
        client.post(&url).json(&request)
    };
    if !api_key.is_empty() {
        req_builder = req_builder.header("Authorization", format!("Bearer {}", api_key));
    }

    let response = req_builder
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("API 错误 {}: {}", status, body));
    }

    if is_ollama_native {
        let resp: OllamaResponse = response
            .json()
            .await
            .map_err(|e| format!("解析响应失败: {}", e))?;
        Ok(resp.message.content)
    } else {
        let resp: OpenAiResponse = response
            .json()
            .await
            .map_err(|e| format!("解析响应失败: {}", e))?;
        resp.choices
            .into_iter()
            .next()
            .map(|c| c.message.content)
            .ok_or_else(|| "LLM 返回了空响应".to_string())
    }
}

pub async fn call_llm_stream(
    base_url: &str,
    api_key: &str,
    model: &str,
    messages: Vec<ChatMessage>,
    thinking_mode: bool,
    app_handle: &tauri::AppHandle,
) -> Result<(), String> {
    if model.is_empty() {
        let err = "模型名称未配置".to_string();
        let _ = app_handle.emit("llm:error", &err);
        return Err(err);
    }

    let trimmed = base_url.trim_end_matches('/');
    let is_ollama_native = trimmed.ends_with("/api/chat");
    let url = if is_ollama_native {
        trimmed.to_string()
    } else {
        format!("{}/chat/completions", trimmed)
    };

    let client = reqwest::Client::new();

    let req_builder = if is_ollama_native {
        // Ollama 使用原生格式
        let options = if thinking_mode {
            let mut opts = serde_json::Map::new();
            opts.insert("temperature".to_string(), serde_json::json!(0.7));
            opts.insert("num_ctx".to_string(), serde_json::json!(8192));
            Some(opts)
        } else {
            None
        };
        let request = OllamaChatRequest {
            model,
            messages: &messages,
            stream: true,
            options,
        };
        let mut builder = client.post(&url).json(&request);
        if !api_key.is_empty() {
            builder = builder.header("Authorization", format!("Bearer {}", api_key));
        }
        builder
    } else {
        // OpenAI 兼容格式
        let request = ChatRequest {
            model,
            messages: &messages,
            stream: true,
            reasoning_effort: if thinking_mode { Some("medium") } else { None },
        };
        let mut builder = client.post(&url).json(&request);
        if !api_key.is_empty() {
            builder = builder.header("Authorization", format!("Bearer {}", api_key));
        }
        builder
    };

    let response = req_builder
        .send()
        .await
        .map_err(|e| {
            let msg = format!("请求失败: {}", e);
            let _ = app_handle.emit("llm:error", &msg);
            msg
        })?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let err = format!("API 错误 {}: {}", status, body);
        let _ = app_handle.emit("llm:error", &err);
        return Err(err);
    }

    // 使用 bytes_stream() 按字节流读取，手动按换行符切分行
    use futures_util::StreamExt;

    let mut stream = response.bytes_stream();
    let mut line_buf: Vec<u8> = Vec::new();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| {
            let msg = format!("读取流失败: {}", e);
            let _ = app_handle.emit("llm:error", &msg);
            msg
        })?;

        for byte in chunk {
            if byte == b'\n' {
                // 处理一行（去掉末尾可能的 \r）
                let line = {
                    let raw = std::str::from_utf8(&line_buf).unwrap_or("").trim_end_matches('\r');
                    raw.to_string()
                };
                line_buf.clear();

                if line.is_empty() {
                    continue;
                }

                if is_ollama_native {
                    // Ollama NDJSON 格式：每行是完整 JSON
                    match serde_json::from_str::<OllamaStreamChunk>(&line) {
                        Ok(chunk_data) => {
                            let content = &chunk_data.message.content;
                            if !content.is_empty() {
                                if let Err(e) = app_handle.emit("llm:chunk", content) {
                                    let err = format!("emit 失败: {}", e);
                                    let _ = app_handle.emit("llm:error", &err);
                                    return Err(err);
                                }
                            }
                            if chunk_data.done {
                                let _ = app_handle.emit("llm:done", "");
                                return Ok(());
                            }
                        }
                        Err(e) => {
                            log::warn!("无法解析 Ollama chunk: {} — 行内容: {}", e, line);
                        }
                    }
                } else {
                    // OpenAI SSE 格式：行以 "data: " 开头
                    let data = if let Some(rest) = line.strip_prefix("data: ") {
                        rest.trim()
                    } else {
                        continue;
                    };

                    if data == "[DONE]" {
                        let _ = app_handle.emit("llm:done", "");
                        return Ok(());
                    }

                    match serde_json::from_str::<StreamChunk>(data) {
                        Ok(chunk_data) => {
                            if let Some(choice) = chunk_data.choices.into_iter().next() {
                                if let Some(content) = choice.delta.content {
                                    if !content.is_empty() {
                                        if let Err(e) = app_handle.emit("llm:chunk", &content) {
                                            let err = format!("emit 失败: {}", e);
                                            let _ = app_handle.emit("llm:error", &err);
                                            return Err(err);
                                        }
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            log::warn!("无法解析 OpenAI chunk: {} — 行内容: {}", e, data);
                        }
                    }
                }
            } else {
                line_buf.push(byte);
            }
        }
    }

    // 处理流结束后 line_buf 中剩余的最后一行（无结尾换行符的情况）
    if !line_buf.is_empty() {
        let line = std::str::from_utf8(&line_buf).unwrap_or("").trim_end_matches('\r').to_string();
        if !line.is_empty() && is_ollama_native {
            if let Ok(chunk_data) = serde_json::from_str::<OllamaStreamChunk>(&line) {
                let content = &chunk_data.message.content;
                if !content.is_empty() {
                    let _ = app_handle.emit("llm:chunk", content);
                }
            }
        }
    }

    // 流正常结束，若 Ollama 未发 done:true，也触发完成事件
    let _ = app_handle.emit("llm:done", "");
    Ok(())
}
