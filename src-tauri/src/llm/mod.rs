use serde::{Deserialize, Serialize};
use tauri::Emitter;

pub mod observe;

/// LLM HTTP 客户端：必须显式带超时——reqwest 默认无超时，
/// 一次挂起的请求会把场景聊天 FIFO 的 in_flight 永久卡住（后续消息全部滞留队列）
fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// 非流式调用的计量回执：content 之外带回 token 用量（观测登记用）
#[derive(Debug, Clone)]
pub struct LlmReply {
    pub content: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<String>>,
}

// ── function calling（tool-use 循环）─────────────────────────

/// 统一的工具调用请求（OpenAI/Ollama 双格式解析后归一到这里）
#[derive(Debug, Clone)]
pub struct ToolCall {
    /// OpenAI 原生 id；Ollama 没有 id，解析时按序号生成（回显消息要用）
    pub id: String,
    pub name: String,
    /// 解析后的参数对象（OpenAI 给的是 JSON 字符串，已 parse；失败为空对象）
    pub arguments: serde_json::Value,
}

/// 带工具的非流式调用回执：content 与 tool_calls 可能同时存在（边想边调）
#[derive(Debug, Clone)]
pub struct ToolReply {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Deserialize)]
struct OpenAiToolCall {
    id: String,
    function: OpenAiFunctionCall,
}

#[derive(Debug, Deserialize)]
struct OpenAiFunctionCall {
    name: String,
    /// OpenAI 格式的参数是 JSON 字符串
    arguments: String,
}

#[derive(Debug, Deserialize)]
struct OllamaToolCall {
    function: OllamaFunctionCall,
}

#[derive(Debug, Deserialize)]
struct OllamaFunctionCall {
    name: String,
    /// Ollama 格式的参数直接是对象
    arguments: serde_json::Value,
}

/// 组装 assistant 的 tool_calls 回显消息（下一轮请求要带上，格式按通道分）
pub fn assistant_tool_message(provider_type: &str, reply: &ToolReply) -> serde_json::Value {
    if provider_type == "ollama" {
        let calls: Vec<serde_json::Value> = reply
            .tool_calls
            .iter()
            .map(|c| {
                serde_json::json!({
                    "function": { "name": c.name, "arguments": c.arguments }
                })
            })
            .collect();
        serde_json::json!({
            "role": "assistant",
            "content": reply.content,
            "tool_calls": calls,
        })
    } else {
        let calls: Vec<serde_json::Value> = reply
            .tool_calls
            .iter()
            .map(|c| {
                serde_json::json!({
                    "id": c.id,
                    "type": "function",
                    "function": {
                        "name": c.name,
                        "arguments": c.arguments.to_string(),
                    }
                })
            })
            .collect();
        serde_json::json!({
            "role": "assistant",
            "content": if reply.content.is_empty() { serde_json::Value::Null } else { serde_json::json!(reply.content) },
            "tool_calls": calls,
        })
    }
}

/// 组装 tool 结果消息（OpenAI 用 tool_call_id 配对，Ollama 用 name）
pub fn tool_result_message(provider_type: &str, call: &ToolCall, result: &str) -> serde_json::Value {
    if provider_type == "ollama" {
        serde_json::json!({
            "role": "tool",
            "name": call.name,
            "content": result,
        })
    } else {
        serde_json::json!({
            "role": "tool",
            "tool_call_id": call.id,
            "content": result,
        })
    }
}

/// 带工具的非流式调用：messages 由调用方按格式组装（异构消息），
/// tools 为 OpenAI 格式数组（Ollama 兼容同一格式）。
/// 模型/API 不支持 function calling 时会以 API 错误返回，由调用方降级。
pub async fn call_llm_with_tools(
    base_url: &str,
    api_key: &str,
    model: &str,
    provider_type: &str,
    messages: Vec<serde_json::Value>,
    tools: serde_json::Value,
    thinking_mode: bool,
) -> Result<ToolReply, String> {
    if model.is_empty() {
        return Err("模型名称未配置".to_string());
    }

    let trimmed = base_url.trim_end_matches('/');
    let is_ollama_native = provider_type == "ollama";
    let url = if is_ollama_native {
        format!("{}/api/chat", trimmed)
    } else {
        format!("{}/chat/completions", trimmed)
    };

    let client = http_client();

    let mut body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": false,
    });
    // 空工具数组不下发（部分端点对空数组报错；空 = 纯问答强制收尾轮）
    let has_tools = tools
        .as_array()
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    if has_tools {
        body["tools"] = tools;
    }
    if is_ollama_native {
        body["think"] = serde_json::json!(thinking_mode);
    } else {
        let is_bailian = base_url.contains("bailian") || base_url.contains("aliyun");
        if is_bailian {
            body["enable_thinking"] = serde_json::json!(thinking_mode);
        } else if thinking_mode {
            body["reasoning_effort"] = serde_json::json!("medium");
        }
    }

    let mut req_builder = client.post(&url).json(&body);
    if !api_key.is_empty() {
        req_builder = req_builder.header("Authorization", format!("Bearer {}", api_key));
    }

    let response = req_builder
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = response.status();
    if !status.is_success() {
        let resp_body = response.text().await.unwrap_or_default();
        return Err(format!("API 错误 {}: {}", status, resp_body));
    }

    let raw: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    if is_ollama_native {
        let msg = raw.get("message").cloned().unwrap_or(serde_json::Value::Null);
        let content = msg
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        let tool_calls = msg
            .get("tool_calls")
            .and_then(|t| t.as_array())
            .map(|arr| {
                arr.iter()
                    .enumerate()
                    .filter_map(|(i, t)| {
                        serde_json::from_value::<OllamaToolCall>(t.clone())
                            .ok()
                            .map(|c| ToolCall {
                                id: format!("call_{}", i),
                                name: c.function.name,
                                arguments: c.function.arguments,
                            })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(ToolReply {
            content,
            tool_calls,
            input_tokens: raw
                .get("prompt_eval_count")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            output_tokens: raw.get("eval_count").and_then(|v| v.as_u64()).unwrap_or(0),
        })
    } else {
        let choice = raw
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .cloned()
            .ok_or("LLM 返回了空响应")?;
        let msg = choice.get("message").cloned().unwrap_or(serde_json::Value::Null);
        let content = msg
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string();
        let tool_calls = msg
            .get("tool_calls")
            .and_then(|t| t.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| {
                        serde_json::from_value::<OpenAiToolCall>(t.clone())
                            .ok()
                            .map(|c| ToolCall {
                                id: c.id,
                                name: c.function.name,
                                arguments: serde_json::from_str(&c.function.arguments)
                                    .unwrap_or(serde_json::json!({})),
                            })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(ToolReply {
            content,
            tool_calls,
            input_tokens: raw
                .pointer("/usage/prompt_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            output_tokens: raw
                .pointer("/usage/completion_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
        })
    }
}

#[derive(Debug, Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<&'a str>,
    /// 百炼扩展参数（enable_thinking 等）。必须 flatten 到请求体顶层——
    /// extra_body 嵌套是 OpenAI Python SDK 的写法，百炼 HTTP API 不认该字段。
    #[serde(flatten)]
    extra_body: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Serialize)]
struct OllamaChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<serde_json::Map<String, serde_json::Value>>,
    think: bool,
}

// OpenAI 格式响应（非流式）
#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

/// OpenAI usage 字段（部分中转端点可能缺省，容错为 0）
#[derive(Debug, Deserialize, Default)]
struct OpenAiUsage {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct OpenAiResponse {
    choices: Vec<ChatChoice>,
    usage: Option<OpenAiUsage>,
}

// Ollama 原生 /api/chat 格式响应（非流式）
#[derive(Debug, Deserialize)]
struct OllamaResponse {
    message: ChatMessage,
    /// Ollama 的 token 计量字段（缺省容错为 0）
    prompt_eval_count: Option<u64>,
    eval_count: Option<u64>,
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
    provider_type: &str,
    messages: Vec<ChatMessage>,
    thinking_mode: bool,
) -> Result<LlmReply, String> {
    if model.is_empty() {
        return Err("模型名称未配置".to_string());
    }

    let trimmed = base_url.trim_end_matches('/');
    // 提供商类型为 ollama 时使用 Ollama 原生格式，否则使用 OpenAI 兼容格式
    let is_ollama_native = provider_type == "ollama";
    let url = if is_ollama_native {
        format!("{}/api/chat", trimmed)
    } else {
        format!("{}/chat/completions", trimmed)
    };

    let client = http_client();

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
            think: thinking_mode,
        };
        client.post(&url).json(&request)
    } else {
        // OpenAI 兼容格式
        // 检测是否为百炼平台
        let is_bailian = base_url.contains("bailian") || base_url.contains("aliyun");
        // 百炼 qwen3.x 默认开启思考（实测：不传参也产生 reasoning tokens），
        // 必须显式传递开关状态——关闭时传 false 压制默认思考，
        // 避免日报/分析等长 prompt 场景耗时与费用翻倍
        let extra_body = if is_bailian {
            let mut body = serde_json::Map::new();
            body.insert(
                "enable_thinking".to_string(),
                serde_json::json!(thinking_mode),
            );
            Some(body)
        } else {
            None
        };
        let request = ChatRequest {
            model,
            messages: &messages,
            stream: false,
            reasoning_effort: if thinking_mode && !is_bailian {
                Some("medium")
            } else {
                None
            },
            extra_body,
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
        Ok(LlmReply {
            content: resp.message.content,
            input_tokens: resp.prompt_eval_count.unwrap_or(0),
            output_tokens: resp.eval_count.unwrap_or(0),
        })
    } else {
        let resp: OpenAiResponse = response
            .json()
            .await
            .map_err(|e| format!("解析响应失败: {}", e))?;
        let usage = resp.usage.unwrap_or_default();
        resp.choices
            .into_iter()
            .next()
            .map(|c| LlmReply {
                content: c.message.content,
                input_tokens: usage.prompt_tokens.unwrap_or(0),
                output_tokens: usage.completion_tokens.unwrap_or(0),
            })
            .ok_or_else(|| "LLM 返回了空响应".to_string())
    }
}

pub async fn call_llm_stream(
    base_url: &str,
    api_key: &str,
    model: &str,
    provider_type: &str,
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
    let is_ollama_native = provider_type == "ollama";
    let url = if is_ollama_native {
        format!("{}/api/chat", trimmed)
    } else {
        format!("{}/chat/completions", trimmed)
    };

    let client = http_client();

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
            think: thinking_mode,
        };
        let mut builder = client.post(&url).json(&request);
        if !api_key.is_empty() {
            builder = builder.header("Authorization", format!("Bearer {}", api_key));
        }
        builder
    } else {
        // OpenAI 兼容格式
        // 检测是否为百炼平台
        let is_bailian = base_url.contains("bailian") || base_url.contains("aliyun");
        // 同 call_llm：百炼默认思考需显式压制/开启，参数经 flatten 到顶层
        let extra_body = if is_bailian {
            let mut body = serde_json::Map::new();
            body.insert(
                "enable_thinking".to_string(),
                serde_json::json!(thinking_mode),
            );
            Some(body)
        } else {
            None
        };
        let request = ChatRequest {
            model,
            messages: &messages,
            stream: true,
            reasoning_effort: if thinking_mode && !is_bailian {
                Some("medium")
            } else {
                None
            },
            extra_body,
        };
        let mut builder = client.post(&url).json(&request);
        if !api_key.is_empty() {
            builder = builder.header("Authorization", format!("Bearer {}", api_key));
        }
        builder
    };

    let response = req_builder.send().await.map_err(|e| {
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
                    let raw = std::str::from_utf8(&line_buf)
                        .unwrap_or("")
                        .trim_end_matches('\r');
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
        let line = std::str::from_utf8(&line_buf)
            .unwrap_or("")
            .trim_end_matches('\r')
            .to_string();
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
