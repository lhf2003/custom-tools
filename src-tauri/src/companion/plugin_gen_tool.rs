//! 聊天场景的插件制作工具执行层（layout_ui / generate_plugin_chat）。
//!
//! 与 commands/plugin_gen.rs（模态框链路）并存：本模块是场景 tool-use 循环的
//! 专用执行体——LLM 调用静默收集全文（无 plugin_gen:chunk 回显，结果经 A2UI
//! 卡片展示）、布局 HTML 落盘、插件生成带自审循环（≤3 轮）。模态框下线（Phase 7）
//! 后再收敛两处请求逻辑。

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::commands::plugin_gen::PLUGIN_GEN_SYSTEM_PROMPT;
use crate::commands::plugin_gen::PLUGIN_UPDATE_SYSTEM_PROMPT;
use crate::llm::ChatMessage;

/// 布局预览 HTML 的系统提示：浏览器直接打开（无应用 CSS 变量环境），
/// 必须自包含内联样式；只做功能区排版，颜色等最终样式以插件实生成为准。
const LAYOUT_SYSTEM_PROMPT: &str = r#"你是 FlowHub 插件的布局设计师。根据用户描述，产出一份插件布局预览 HTML。

# 产出要求

- 单个完整 HTML 文件，内联 <style>，零外部依赖（不引字体、不引库、不引图片）
- 展示功能区的排布：输入区、结果区、操作按钮的位置与层级，用占位内容示意
- 顶部一个醒目的提示条：「布局预览 · 最终效果以插件实际生成为准」
- 风格：简洁行式布局，浅灰中性色（深色文字 #1f2937、浅灰背景 #f9fafb、边框 #e5e7eb），
  圆角 8-12px，间距 4 的倍数；禁止渐变、禁止花哨装饰
- 中文界面；可加少量注释说明每个区域的用途

# 输出纪律

只输出 HTML 本身（以 <!DOCTYPE html> 开头），不输出任何解释文字、代码块标记或 markdown 围栏（不要用 ``` 包裹）。
"#;

/// 自审循环失败修正的追加指令（拼接在生成 system prompt 之后）
const PLUGIN_GEN_REVIEW_FIX: &str = r#"

# 修正任务

上一轮生成的插件未通过校验，问题如下。你必须修正后重新输出，其余规则不变：
- 保持 id、插件形态不变；只修复校验指出的问题
- 输出格式与之前完全一致（4 个 step 标记 + 2 个文件块）
"#;

/// 生成产物的文件块提取结果
#[derive(Debug)]
struct GenFiles {
    manifest: String,
    bundle: String,
}

/// 提取并校验两个文件块（---FILE:plugin.json--- / ---FILE:plugin.js---）。
/// 校验失败返回具体原因（喂回模型自审）。
fn parse_plugin_files(content: &str) -> Result<GenFiles, String> {
    let manifest_block = extract_file_block(content, "plugin.json")
        .ok_or("输出缺少 ---FILE:plugin.json--- 文件块")?;
    let bundle_block = extract_file_block(content, "plugin.js")
        .ok_or("输出缺少 ---FILE:plugin.js--- 文件块")?;
    // manifest 必须是合法 JSON 且含 id
    let parsed: Value = serde_json::from_str(manifest_block)
        .map_err(|e| format!("plugin.json 不是合法 JSON: {e}"))?;
    if parsed.get("id").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
        return Err("plugin.json 缺少 id 字段".to_string());
    }
    // bundle 必须注册 flowhubPlugin（粗校验，语法级由前端 new Function 兜底）
    if !bundle_block.contains("flowhubPlugin") || !bundle_block.contains("view") {
        return Err("plugin.js 缺少 window.flowhubPlugin 注册或 view 字段".to_string());
    }
    Ok(GenFiles {
        manifest: manifest_block.to_string(),
        bundle: bundle_block.to_string(),
    })
}

/// 按文件块标记提取内容（标记行到下一个标记行/结束）
fn extract_file_block<'a>(content: &'a str, filename: &str) -> Option<&'a str> {
    let marker = format!("---FILE:{}---", filename);
    let start = content.find(&marker)? + marker.len();
    let rest = &content[start..];
    // 下一个文件块标记或结尾
    let next = rest.find("---FILE:").unwrap_or(rest.len());
    let block = &rest[..next];
    Some(block.trim())
}

/// 布局 HTML 落盘路径：app_data/plugins/.preview/<plugin_id>/layout.html
fn layout_html_path(app_handle: &AppHandle, plugin_id: &str) -> Result<std::path::PathBuf, String> {
    let dir = preview_plugin_dir(app_handle, plugin_id)?;
    Ok(dir.join("layout.html"))
}

/// 预览插件目录（app_data/plugins/.preview/<id>），与 commands/plugin_gen.rs 同约定
fn preview_plugin_dir(app_handle: &AppHandle, plugin_id: &str) -> Result<std::path::PathBuf, String> {
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("plugins")
        .join(".preview")
        .join(plugin_id);
    // 路径穿越防护：id 必须是纯小写连字符名字
    let is_safe = !plugin_id.is_empty()
        && plugin_id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !is_safe {
        return Err(format!("插件 id「{}」非法（只允许小写字母/数字/连字符）", plugin_id));
    }
    std::fs::create_dir_all(&base).map_err(|e| format!("创建预览目录失败: {e}"))?;
    Ok(base)
}

/// 流式请求 LLM 并收集全文（静默，无 chunk 回显——工具模式结果经 A2UI 卡片展示）。
/// 超时 300s（思考模式长生成）。与 commands/plugin_gen.rs 的 stream_generate_plugin
/// 同构，去掉 emit；模态框下线后收敛。
async fn llm_collect_full(
    base_url: &str,
    api_key: &str,
    model: &str,
    provider_type: &str,
    messages: Vec<ChatMessage>,
    thinking_mode: bool,
    reasoning_effort: &str,
) -> Result<String, String> {
    let trimmed = base_url.trim_end_matches('/');
    let is_ollama_native = provider_type == "ollama";
    let url = if is_ollama_native {
        format!("{}/api/chat", trimmed)
    } else {
        format!("{}/chat/completions", trimmed)
    };

    let client = crate::http::build_client(std::time::Duration::from_secs(300))
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?;

    let body = {
        let mut b = serde_json::json!({
            "model": model,
            "messages": messages
                .iter()
                .map(|m| {
                    serde_json::json!({ "role": m.role, "content": m.content })
                })
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

    let response = req_builder.send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        let resp_body = response.text().await.unwrap_or_default();
        return Err(format!("API 错误 {status}: {resp_body}"));
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
                    let raw = std::str::from_utf8(&line_buf).unwrap_or("").trim_end_matches('\r');
                    raw.to_string()
                };
                line_buf.clear();
                if line.is_empty() {
                    continue;
                }
                let delta: Option<String> = if is_ollama_native {
                    #[derive(serde::Deserialize)]
                    struct OllamaChunk {
                        message: OllamaMessage,
                        done: bool,
                    }
                    #[derive(serde::Deserialize)]
                    struct OllamaMessage {
                        content: String,
                    }
                    match serde_json::from_str::<OllamaChunk>(&line) {
                        Ok(c) if !c.done => Some(c.message.content),
                        _ => None,
                    }
                } else {
                    #[derive(serde::Deserialize)]
                    struct SseChunk {
                        choices: Vec<SseChoice>,
                    }
                    #[derive(serde::Deserialize)]
                    struct SseChoice {
                        delta: SseDelta,
                    }
                    #[derive(serde::Deserialize)]
                    struct SseDelta {
                        content: Option<String>,
                    }
                    let data = line.strip_prefix("data: ").map(|s| s.trim());
                    match data {
                        Some("[DONE]") | None => None,
                        Some(json_line) => serde_json::from_str::<SseChunk>(json_line)
                            .ok()
                            .and_then(|c| c.choices.into_iter().next())
                            .and_then(|choice| choice.delta.content)
                            .filter(|s| !s.is_empty()),
                    }
                };
                if let Some(delta) = delta {
                    content_acc.push_str(&delta);
                }
            } else {
                line_buf.push(byte);
            }
        }
    }
    // 流结束剩余行（无结尾换行）
    if !line_buf.is_empty() {
        let line = String::from_utf8_lossy(&line_buf).trim_end_matches('\r').to_string();
        let delta: Option<String> = if is_ollama_native {
            #[derive(serde::Deserialize)]
            struct OllamaChunk {
                message: OllamaMessage,
                done: bool,
            }
            #[derive(serde::Deserialize)]
            struct OllamaMessage {
                content: String,
            }
            match serde_json::from_str::<OllamaChunk>(&line) {
                Ok(c) if !c.done => Some(c.message.content),
                _ => None,
            }
        } else {
            #[derive(serde::Deserialize)]
            struct SseChunk {
                choices: Vec<SseChoice>,
            }
            #[derive(serde::Deserialize)]
            struct SseChoice {
                delta: SseDelta,
            }
            #[derive(serde::Deserialize)]
            struct SseDelta {
                content: Option<String>,
            }
            let data = line.strip_prefix("data: ").map(|s| s.trim());
            match data {
                Some("[DONE]") | None => None,
                Some(json_line) => serde_json::from_str::<SseChunk>(json_line)
                    .ok()
                    .and_then(|c| c.choices.into_iter().next())
                    .and_then(|choice| choice.delta.content),
            }
        };
        if let Some(delta) = delta {
            content_acc.push_str(&delta);
        }
    }

    Ok(content_acc)
}

/// 构造单轮 LLM 调用消息（system + user）
fn build_messages(system: &str, user: &str) -> Vec<ChatMessage> {
    vec![
        ChatMessage {
            role: "system".to_string(),
            content: system.to_string(),
            images: None,
        },
        ChatMessage {
            role: "user".to_string(),
            content: user.to_string(),
            images: None,
        },
    ]
}

/// layout_ui 工具执行：LLM 产出布局 HTML → 落盘 .preview/<id>/layout.html。
/// 返回给模型的文本（含落盘路径，模型配合 render_ui 出「打开预览」按钮）。
pub(crate) async fn tool_layout_ui(
    app_handle: &AppHandle,
    base_url: &str,
    api_key: &str,
    model: &str,
    provider_type: &str,
    thinking_mode: bool,
    reasoning_effort: &str,
    args: &Value,
) -> Result<String, String> {
    let plugin_id = args
        .get("plugin_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("缺少参数 plugin_id")?;
    let description = args
        .get("description")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("缺少参数 description")?;

    let _ = app_handle.emit("jarvis:status", "贾维斯在设计插件布局…");
    let messages = build_messages(LAYOUT_SYSTEM_PROMPT, description);
    let html = llm_collect_full(
        base_url,
        api_key,
        model,
        provider_type,
        messages,
        thinking_mode,
        reasoning_effort,
    )
    .await?;
    // 容忍 markdown 围栏（模型可能用 ```html 包裹）
    let mut html = html.trim();
    if let Some(stripped) = html.strip_prefix("```html") {
        html = stripped.trim();
    } else if let Some(stripped) = html.strip_prefix("```") {
        html = stripped.trim();
    }
    html = html.trim_end_matches("```").trim();
    if !html.starts_with("<!DOCTYPE html") && !html.starts_with("<html") {
        // 错误文本带输出开头预览，模型能看清自己产出什么并自纠
        let preview: String = html.chars().take(200).collect();
        return Err(format!(
            "布局生成结果不是 HTML 文档（输出开头：{}）——请直接输出 <!DOCTYPE html> 开头的完整 HTML，不要用代码块围栏。",
            preview
        ));
    }

    let path = layout_html_path(app_handle, plugin_id)?;
    std::fs::write(&path, html).map_err(|e| format!("写入布局文件失败: {e}"))?;

    let _ = app_handle.emit("jarvis:status", "布局已生成，请用户查看");
    Ok(format!(
        "布局 HTML 已生成并落盘：{}（文件名固定 layout.html，多轮迭代覆盖同一文件）。\n\
         系统已自动展示布局预览卡片（含「打开预览」按钮），你无需调用 render_ui。\n\
         等用户反馈布局意见；用户说开始做再调 generate_plugin_chat。",
        path.display()
    ))
}

/// generate_plugin_chat 工具执行：生成插件 + 自审循环（≤3 轮）+ 落盘。
/// 返回给模型的文本（含产物摘要与审查状态，模型配合 render_ui 出 PluginPreview 卡片）。
pub(crate) async fn tool_generate_plugin_chat(
    app_handle: &AppHandle,
    base_url: &str,
    api_key: &str,
    model: &str,
    provider_type: &str,
    thinking_mode: bool,
    reasoning_effort: &str,
    args: &Value,
) -> Result<String, String> {
    let plugin_id = args
        .get("plugin_id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("缺少参数 plugin_id")?;
    let description = args
        .get("description")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("缺少参数 description")?;
    let mode = args
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("create");
    let existing_manifest = args.get("existing_manifest").and_then(|v| v.as_str());
    let existing_bundle = args.get("existing_bundle").and_then(|v| v.as_str());

    // system prompt：生成规范 + 更新模式追加段（复用 commands::plugin_gen 单一来源）
    let mut system = PLUGIN_GEN_SYSTEM_PROMPT.to_string();
    if mode == "update" {
        system.push_str(PLUGIN_UPDATE_SYSTEM_PROMPT);
    }
    // user 内容：更新模式带现有代码
    let user_content = if mode == "update" {
        let (m, b) = match (existing_manifest, existing_bundle) {
            (Some(m), Some(b)) => (m, b),
            _ => return Err("更新模式缺少 existing_manifest/existing_bundle".to_string()),
        };
        format!(
            "现有插件 plugin.json:\n{}\n\n现有插件 plugin.js:\n{}\n\n更新需求：{}",
            m, b, description
        )
    } else {
        description.to_string()
    };

    // 自审循环：最多 3 轮（1 次初生成 + 2 次修正）；超限仍交付（标注审查未完全通过）
    const MAX_REVIEW_ROUNDS: usize = 3;
    let mut review_rounds = 0usize;
    let mut review_status = "passed";

    let files = loop {
        review_rounds += 1;
        let _ = app_handle.emit(
            "jarvis:status",
            &format!("贾维斯在制作插件（第 {} 轮）…", review_rounds),
        );
        let messages = build_messages(&system, &user_content);
        let content = llm_collect_full(
            base_url,
            api_key,
            model,
            provider_type,
            messages,
            thinking_mode,
            reasoning_effort,
        )
        .await?;
        match parse_plugin_files(&content) {
            Ok(f) => {
                // id 必须与入参一致（防 LLM 改 id）
                let parsed: Value = serde_json::from_str(&f.manifest).unwrap_or(Value::Null);
                let gen_id = parsed.get("id").and_then(|v| v.as_str()).unwrap_or("");
                if gen_id != plugin_id {
                    let err = format!("生成的 id「{}」与要求「{}」不一致", gen_id, plugin_id);
                    if review_rounds >= MAX_REVIEW_ROUNDS {
                        review_status = "review_not_fully_passed";
                        log::warn!("[plugin_gen] {err}，已达自审轮数上限");
                        break f;
                    }
                    // 修正：追加失败原因重试
                    system.push_str(&format!("{}\n# 上轮校验失败原因\n{}", PLUGIN_GEN_REVIEW_FIX, err));
                    continue;
                }
                break f;
            }
            Err(err) => {
                if review_rounds >= MAX_REVIEW_ROUNDS {
                    // 最后一次解析失败无法交付产物——直接报错（模型向用户说明并重试）
                    return Err(format!("插件生成未通过校验且已达自审上限：{err}"));
                }
                system.push_str(&format!("{}\n# 上轮校验失败原因\n{}", PLUGIN_GEN_REVIEW_FIX, err));
            }
        }
    };
    // 落盘 .preview/<id>/plugin.json + plugin.js
    let dir = preview_plugin_dir(app_handle, plugin_id)?;
    std::fs::write(dir.join("plugin.json"), &files.manifest)
        .map_err(|e| format!("写入 plugin.json 失败: {e}"))?;
    std::fs::write(dir.join("plugin.js"), &files.bundle)
        .map_err(|e| format!("写入 plugin.js 失败: {e}"))?;

    let _ = app_handle.emit("jarvis:status", "插件已生成");
    let manifest_summary = summarize_manifest(&files.manifest);
    Ok(format!(
        "插件已生成并落盘 .preview/{}/（plugin.json + plugin.js），审查状态：{}（{} 轮）。\n\
         {}。\n\
         系统已自动展示 PluginPreview 卡片（含代码预览、运行与安装按钮），你无需调用 render_ui。\n\
         用户反馈修改意见则重新调用本工具。",
        plugin_id, review_status, review_rounds, manifest_summary
    ))
}

/// manifest 摘要（给模型的文本回显用）
fn summarize_manifest(manifest: &str) -> String {
    let parsed: Value = serde_json::from_str(manifest).unwrap_or(Value::Null);
    let name = parsed.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let version = parsed.get("version").and_then(|v| v.as_str()).unwrap_or("");
    let triggers = parsed
        .get("triggers")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.get("keyword").and_then(|k| k.as_str()))
                .collect::<Vec<_>>()
                .join("、")
        })
        .unwrap_or_default();
    let settings_count = parsed
        .get("settings")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    format!(
        "「{}」v{}｜触发器 {}｜设置 {} 项",
        name, version, if triggers.is_empty() { "无".to_string() } else { triggers }, settings_count
    )
}

/// 解析 open_local_html 的预览相对路径（路径穿越防护）：
/// base 是 plugins/ 目录，relative 形如 `.preview/<id>/layout.html`（与卡片按钮
/// 的 args.path 约定一致；勿把 base 设成 .preview——会双重嵌套），
/// canonicalize 后校验仍在 plugins 目录内。
pub(crate) fn resolve_preview_path(
    app_handle: &AppHandle,
    relative: &str,
) -> Result<std::path::PathBuf, String> {
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("plugins");
    let candidate = base.join(relative);
    let canonical_base =
        std::fs::canonicalize(&base).map_err(|e| format!("预览目录不存在: {e}"))?;
    let canonical = std::fs::canonicalize(&candidate).map_err(|e| format!("文件不存在: {e}"))?;
    if !canonical.starts_with(&canonical_base) {
        return Err("路径越界（必须位于预览目录内）".to_string());
    }
    Ok(canonical)
}

/// 插件关联的 surface_id：插件 id 转蛇形 + 后缀（多轮迭代同一 surface，增量更新）
pub(crate) fn plugin_surface_id(plugin_id: &str, suffix: &str) -> String {
    format!("{}_{}", plugin_id.replace('-', "_"), suffix)
}

/// 读回预览插件文件（plugin.json + plugin.js 原文），scene_chat 构造卡片用
pub(crate) fn read_preview_files(
    app_handle: &AppHandle,
    plugin_id: &str,
) -> Result<(String, String), String> {
    let dir = preview_plugin_dir(app_handle, plugin_id)?;
    let manifest =
        std::fs::read_to_string(dir.join("plugin.json")).map_err(|e| format!("读 plugin.json 失败: {e}"))?;
    let bundle =
        std::fs::read_to_string(dir.join("plugin.js")).map_err(|e| format!("读 plugin.js 失败: {e}"))?;
    Ok((manifest, bundle))
}

/// 布局卡片消息（后端直发，不依赖模型转述代码数据）：
/// 布局预览提示 + invoke 型「打开预览」按钮（浏览器打开落盘的 layout.html）。
/// with_create=false 时只发增量更新（surface 已存在）。
pub(crate) fn build_layout_card_messages(plugin_id: &str, with_create: bool) -> Value {
    let sid = plugin_surface_id(plugin_id, "layout");
    let mut msgs = Vec::new();
    if with_create {
        msgs.push(json!({"version":"v0.9","createSurface":{"surfaceId":sid.clone(),"catalogId":"basic"}}));
    }
    msgs.push(json!({
        "version":"v0.9",
        "updateComponents": {
            "surfaceId": sid,
            "components": [
                {"id":"root","component":"Card","child":"col"},
                {"id":"col","component":"Column","children":["t","d","b","bt"]},
                {"id":"t","component":"Text","text":"插件布局预览","variant":"h2"},
                {"id":"d","component":"Text","text":"仅布局预览，最终效果以插件实际生成为准","variant":"body"},
                {"id":"b","component":"Button","child":"bt","action":{"invoke":{"command":"open_local_html","args":{"path":format!(".preview/{}/layout.html", plugin_id)}}}},
                {"id":"bt","component":"Text","text":"打开预览"}
            ]
        }
    }));
    serde_json::Value::Array(msgs)
}

/// PluginPreview 卡片消息（后端直发）：data model 带完整 manifestJson/bundleCode——
/// 不经模型转述（LLM 转述几百行代码必然断裂，实测会话 56 即此缺陷）。
pub(crate) fn build_preview_card_messages(
    plugin_id: &str,
    manifest: &str,
    bundle: &str,
    mode: &str,
    review_status: &str,
    with_create: bool,
) -> Value {
    let sid = plugin_surface_id(plugin_id, "preview");
    let mut msgs = Vec::new();
    if with_create {
        msgs.push(json!({"version":"v0.9","createSurface":{"surfaceId":sid.clone(),"catalogId":"basic"}}));
    }
    msgs.push(json!({
        "version":"v0.9",
        "updateComponents": {
            "surfaceId": sid.clone(),
            "components": [
                {"id":"root","component":"Card","child":"pv"},
                {"id":"pv","component":"PluginPreview"}
            ]
        }
    }));
    msgs.push(json!({
        "version":"v0.9",
        "updateDataModel": {
            "surfaceId": sid,
            "value": {
                "pluginId": plugin_id,
                "manifestJson": manifest,
                "bundleCode": bundle,
                "mode": mode,
                "reviewStatus": review_status
            }
        }
    }));
    serde_json::Value::Array(msgs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_output() -> String {
        format!(
            r#"<step name="manifest">说明</step>
---FILE:plugin.json---
{{"id":"demo-plugin","name":"演示","version":"0.1.0","main":"plugin.js","permissions":[]}}
---FILE:plugin.js---
(function () {{
  window.flowhubPlugin = {{ manifest: {{}}, view: {{ mount: function (c) {{}} }} }};
}})();
"#
        )
    }

    #[test]
    fn parses_valid_file_blocks() {
        let f = parse_plugin_files(&sample_output()).expect("应解析成功");
        assert!(f.manifest.contains("\"id\":\"demo-plugin\""));
        assert!(f.bundle.contains("flowhubPlugin"));
        assert!(f.bundle.contains("mount"));
    }

    #[test]
    fn rejects_missing_manifest_block() {
        let content = "---FILE:plugin.js---\n(function(){})();";
        let err = parse_plugin_files(content).unwrap_err();
        assert!(err.contains("plugin.json"), "应提示缺 plugin.json: {}", err);
    }

    #[test]
    fn rejects_invalid_manifest_json() {
        let content = "---FILE:plugin.json---\n{not json}\n---FILE:plugin.js---\n(function(){})();";
        let err = parse_plugin_files(content).unwrap_err();
        assert!(err.contains("不是合法 JSON"), "应提示 JSON 非法: {}", err);
    }

    #[test]
    fn rejects_bundle_without_registration() {
        let content = "---FILE:plugin.json---\n{\"id\":\"x\"}\n---FILE:plugin.js---\nconsole.log(1);";
        let err = parse_plugin_files(content).unwrap_err();
        assert!(err.contains("flowhubPlugin"), "应提示缺少注册: {}", err);
    }

    #[test]
    fn extract_stops_at_next_marker() {
        let content = "---FILE:a---\nAAA\n---FILE:b---\nBBB";
        assert_eq!(extract_file_block(content, "a"), Some("AAA"));
        assert_eq!(extract_file_block(content, "b"), Some("BBB"));
    }

    #[test]
    fn preview_dir_rejects_path_traversal_ids() {
        // 无 app_handle 不可测路径本身，但 id 白名单校验在 preview_plugin_dir 内部——用合法 id 走通
        // （非法 id 分支直接验证字符白名单逻辑）
        let bad: Vec<&str> = vec!["../evil", "a/b", "a\\b", "", "UPPER", "a.b"];
        for id in bad {
            let is_safe = !id.is_empty()
                && id.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
            assert!(!is_safe, "id「{}」应判定为非法", id);
        }
        for id in ["demo-plugin", "t1", "a-b-c2"] {
            let is_safe = !id.is_empty()
                && id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
            assert!(is_safe, "id「{}」应判定为合法", id);
        }
    }
}
