use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::DatabaseState;
use crate::llm::ChatMessage;
use crate::llm_provider::crypto::decrypt;
use crate::llm_provider::db::LlmProviderDb;
use crate::llm_provider::models::Scene;

/// AI 生成插件的私有 system prompt（只存在于生成调用内部：不进产物、不进 UI、不分发）。
/// 含插件协议规范 + 本系统设计规范提炼（token 名）+ 分步生成指引（步骤标记）+ 安全约束。
const PLUGIN_GEN_SYSTEM_PROMPT: &str = r#"你是 FlowHub（Windows 桌面效率启动器）的插件生成器。根据用户描述，生成一个完整的 FlowHub 外部插件。

# 外部插件格式（IIFE bundle + 全局注册，自包含零依赖）

插件由两个文件组成：
- plugin.json：manifest（元数据 + 贡献点声明）
- plugin.js：IIFE bundle（无任何 import，所有逻辑内联，直接操作 DOM）

## plugin.json 完整 schema（字段必须齐全）

{
  "id": "小写连字符 id，如 time-converter",
  "name": "中文显示名",
  "version": "0.1.0",
  "author": "AI 生成",
  "description": "一句话功能说明",
  "aliases": ["英文搜索别名"],
  "main": "plugin.js",
  "runtime": "frontend",
  "permissions": [],
  "triggers": [{ "keyword": "@前缀", "argHint": "参数提示" }],
  "shortcuts": [{ "id": "open", "key": "Ctrl+Shift+字母", "label": "打开插件" }],
  "settings": [
    { "key": "键", "label": "中文标签", "type": "select", "options": ["选项1"], "default": "选项1" },
    { "key": "键", "label": "中文标签", "type": "number", "default": "1" },
    { "key": "键", "label": "中文标签", "type": "toggle", "default": "1" },
    { "key": "键", "label": "中文标签", "type": "text", "placeholder": "占位提示" }
  ]
}

约束：
- settings.type 只能取 text | number | toggle | select（select 必须提供 options 数组）
- settings 数组为空数组 [] 即可（无配置项时）；shortcuts 同理
- triggers 只在需要启动器前缀唤起时声明；无需求则留空数组

## plugin.js 结构（严格遵守）

(function () {
  function renderView(container, ctx) {
    // 直接操作 container（已挂载的 div），可 innerHTML 或精细 DOM
    // ctx.invoke(cmd, args) 可调用主应用 Tauri command（Promise）
  }
  window.flowhubPlugin = {
    manifest: { /* 与 plugin.json 完全一致的 manifest 对象 */ },
    view: { mount: renderView }
  };
})();

注意：manifest 对象字段必须与 plugin.json 完全一致；代码必须是合法 ES5+ JavaScript；禁止任何外部依赖（不能 import、不能 fetch 外部资源）。

# 本系统设计规范（UI 必须遵循，CSS 变量直接用 var() 引用）

- 背景/表面：主背景 var(--app-bg-primary)；浮层/输入 var(--app-bg-elevated)、var(--app-bg-tertiary)；悬停 var(--app-bg-hover)
- 文字：主 var(--app-text-primary)；次 var(--app-text-secondary)；弱/说明 var(--app-text-tertiary)；占位 var(--app-text-placeholder)
- 边框：var(--app-border-default)、var(--app-border-subtle)
- 状态色：操作/强调蓝 var(--app-status-info)；错误 var(--app-status-error)；警告 var(--app-status-warning)；成功 var(--app-status-success)
- 圆角 8-12px；间距用 4 的倍数；字体继承系统（HarmonyOS Sans SC），不引入外部字体
- 交互：hover 用半透明白纱层（rgba(255,255,255,0.05)）；主操作按钮用 var(--app-status-info) 底 + 白字
- 风格：行式布局、简洁克制；禁止渐变文字、禁止玻璃拟态、禁止卡片套卡片、禁止纯装饰图形

# 分步生成（必须严格按以下步骤链输出，每步用 <step name="...">...</step> 包裹，标记完整出现）

<step name="manifest">用一句话说明 manifest 设计决策（id 选择、triggers/settings/shortcuts 取舍）</step>
<step name="view">用一句话说明视图逻辑（输入解析、数据转换、渲染策略）</step>
<step name="style">用一句话说明样式如何遵循上述设计规范（token 运用）</step>
<step name="verify">自校验声明：plugin.json 字段合法性、bundle 语法自查、manifest 一致性确认</step>

随后输出且仅输出两个文件块（严格以行为分隔符）：

---FILE:plugin.json---
{ 完整 JSON }
---FILE:plugin.js---
( function () { ... } )();

# 安全约束

- permissions 诚实声明（当前一律留空数组）
- 禁止窃取数据、键盘记录、持久化后门等恶意模式；视图只做纯前端数据转换与展示
- 用户输入必须做基本校验（如 Number.isNaN 检查），非法输入给出友好提示

# 输出纪律

- 除上述 4 个 step 标记与 2 个文件块外，不输出任何其他内容
- plugin.js 内 manifest 必须与 plugin.json 逐字段一致
"#;

/// AI 更新模式追加段（仅在 existing_files 存在时拼进 system prompt）。
/// 核心约束：id 不变（否则安装链路拒绝覆盖）、version 递增、基于现有代码增量修改。
const PLUGIN_UPDATE_SYSTEM_PROMPT: &str = r#"

# 更新任务（本次为 AI 更新模式）

用户提供了现有插件的 plugin.json 与 plugin.js，以及一段更新需求。你必须：
- 保持 id 完全不变；version 递增（如 0.1.0 → 0.2.0）
- 基于现有代码增量修改，不要无关重写；沿用既有 settings 键与 shortcuts id（保持用户配置兼容）
- 除需求涉及的改动外，其余 manifest 字段与视图行为保持原样
- 输出格式与上述完全一致（4 个 step 标记 + 2 个文件块），plugin.js 内 manifest 必须与 plugin.json 逐字段一致
"#;

/// 流式响应解析结构（OpenAI SSE / Ollama NDJSON，与 llm/mod.rs 私有结构同形）
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

/// AI 更新时的现有插件文件（plugin.json 原文 + main bundle），作为上下文传给 LLM
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PluginExistingFiles {
    pub manifest: String,
    pub bundle: String,
}

/// 读取正式插件目录的 plugin.json 原文 + main bundle（AI 更新时作为现有代码上下文传给 LLM）。
/// 读原文而非解析后序列化：保留 snake_case 字段名，避免 LLM 模仿 camelCase 输出导致字段丢失。
#[tauri::command]
pub fn read_plugin_files(
    app_handle: AppHandle,
    plugin_id: String,
) -> Result<PluginExistingFiles, String> {
    let base = crate::commands::plugins::plugins_dir(&app_handle)?;
    let plugin_dir = base.join(&plugin_id);
    // 路径穿越防护：确认目标在 plugins 目录内
    if !plugin_dir.starts_with(&base) {
        return Err("非法插件路径".to_string());
    }
    let manifest = std::fs::read_to_string(plugin_dir.join("plugin.json"))
        .map_err(|e| format!("读取 plugin.json 失败: {e}"))?;
    // 解析 main 字段：bundle 文件名可能不是默认 plugin.js
    let parsed: crate::commands::plugins::ExternalPluginManifest =
        serde_json::from_str(&manifest).map_err(|e| format!("plugin.json 解析失败: {e}"))?;
    let bundle = std::fs::read_to_string(plugin_dir.join(&parsed.main))
        .map_err(|e| format!("读取 {} 失败: {e}", parsed.main))?;
    Ok(PluginExistingFiles { manifest, bundle })
}

/// AI 生成插件：复用陪伴场景模型配置（不引入第二套 LLM 配置）。
/// 流式输出——逐段 emit `plugin_gen:chunk`（前端解析步骤标记实时回显），
/// 结束 emit `plugin_gen:done`；command 返回完整生成文本。
/// existing_files 存在时为「AI 更新」模式：基于现有代码生成新版本（id 不变、version 递增）。
#[tauri::command]
pub async fn generate_plugin(
    app_handle: AppHandle,
    db_state: State<'_, DatabaseState>,
    description: String,
    existing_files: Option<PluginExistingFiles>,
) -> Result<String, String> {
    let (base_url, api_key, model, provider_type, thinking_mode, reasoning_effort) = {
        let conn = rusqlite::Connection::open(&db_state.0)
            .map_err(|e| format!("无法连接数据库: {e}"))?;
        let provider_db = LlmProviderDb;
        let (provider, model) = provider_db
            .get_scene_model(&conn, Scene::Companion)
            .map_err(|e| format!("获取陪伴场景模型失败: {e}"))?
            .ok_or_else(|| {
                "陪伴场景未配置模型，请先在「模型设置」中为陪伴场景配置模型后再生成插件"
                    .to_string()
            })?;
        let thinking_mode = provider_db
            .get_scene_thinking_mode(&conn, Scene::Companion)
            .unwrap_or(false);
        let reasoning_effort = provider_db
            .get_scene_reasoning_effort(&conn, Scene::Companion)
            .unwrap_or_else(|_| "medium".to_string());
        let api_key = if let Some(encrypted) = provider.api_key_encrypted {
            if encrypted.is_empty() {
                String::new()
            } else {
                decrypt(
                    &encrypted,
                    &app_handle.path().app_data_dir().unwrap_or_default(),
                )
                .map_err(|e| format!("解密 API Key 失败: {e}"))?
            }
        } else {
            String::new()
        };
        (
            provider.base_url,
            api_key,
            model.model_id,
            provider.provider_type.to_string(),
            thinking_mode,
            reasoning_effort,
        )
    };

    if model.is_empty() {
        return Err("模型名称未配置".to_string());
    }

    // 更新模式：system prompt 追加更新任务段，user message 携带现有代码 + 更新需求
    let system_prompt = match &existing_files {
        Some(_) => format!("{PLUGIN_GEN_SYSTEM_PROMPT}\n{PLUGIN_UPDATE_SYSTEM_PROMPT}"),
        None => PLUGIN_GEN_SYSTEM_PROMPT.to_string(),
    };
    let user_content = match &existing_files {
        Some(files) => format!(
            "现有插件 plugin.json:\n{}\n\n现有插件 plugin.js:\n{}\n\n更新需求：{}",
            files.manifest, files.bundle, description
        ),
        None => description,
    };

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: system_prompt,
            images: None,
        },
        ChatMessage {
            role: "user".to_string(),
            content: user_content,
            images: None,
        },
    ];

    stream_generate_plugin(
        &app_handle,
        &base_url,
        &api_key,
        &model,
        &provider_type,
        messages,
        thinking_mode,
        &reasoning_effort,
    )
    .await
}

/// 流式请求并收集全文。逐行解析 SSE/NDJSON，增量 emit `plugin_gen:chunk`；
/// 超时 300s（思考模式长生成，避免 120s 默认超时截断）。
async fn stream_generate_plugin(
    app_handle: &AppHandle,
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

    // 统一工厂：系统代理开关开启时经系统代理
    let client = crate::http::build_client(Duration::from_secs(300))
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

    let response = req_builder.send().await.map_err(|e| {
        let msg = format!("请求失败: {e}");
        let _ = app_handle.emit("plugin_gen:error", &msg);
        msg
    })?;

    let status = response.status();
    if !status.is_success() {
        let resp_body = response.text().await.unwrap_or_default();
        let err = format!("API 错误 {status}: {resp_body}");
        let _ = app_handle.emit("plugin_gen:error", &err);
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
                    if let Err(e) = app_handle.emit("plugin_gen:chunk", &delta) {
                        let err = format!("emit 失败: {e}");
                        let _ = app_handle.emit("plugin_gen:error", &err);
                        return Err(err);
                    }
                    content_acc.push_str(&delta);
                }
            } else {
                line_buf.push(byte);
            }
        }
    }

    // 处理流结束后 line_buf 中剩余的最后一行（无结尾换行符的情况）
    if !line_buf.is_empty() {
        let line = String::from_utf8_lossy(&line_buf)
            .trim_end_matches('\r')
            .to_string();
        if is_ollama_native {
            if let Ok(c) = serde_json::from_str::<GenOllamaChunk>(&line) {
                if !c.done {
                    let _ = app_handle.emit("plugin_gen:chunk", &c.message.content);
                    content_acc.push_str(&c.message.content);
                }
            }
        } else if let Some(data) = line.strip_prefix("data: ").map(|s| s.trim()) {
            if data != "[DONE]" {
                if let Ok(c) = serde_json::from_str::<GenStreamChunk>(data) {
                    if let Some(delta) = c
                        .choices
                        .into_iter()
                        .next()
                        .and_then(|choice| choice.delta.content)
                    {
                        let _ = app_handle.emit("plugin_gen:chunk", &delta);
                        content_acc.push_str(&delta);
                    }
                }
            }
        }
    }

    let _ = app_handle.emit("plugin_gen:done", "");
    Ok(content_acc)
}

/// 预览插件目录：app_data/plugins/.preview/（试运行用，不列正式列表）
fn preview_dir(app_handle: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("plugins")
        .join(".preview");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 写入预览插件（试运行前落盘，mount 走真实 bundle 加载链路）
#[tauri::command]
pub fn write_plugin_preview(
    app_handle: AppHandle,
    plugin_id: String,
    manifest: String,
    bundle: String,
) -> Result<(), String> {
    let plugin_dir = preview_dir(&app_handle)?.join(&plugin_id);
    let _ = std::fs::remove_dir_all(&plugin_dir);
    std::fs::create_dir_all(&plugin_dir).map_err(|e| e.to_string())?;
    std::fs::write(plugin_dir.join("plugin.json"), manifest).map_err(|e| e.to_string())?;
    std::fs::write(plugin_dir.join("plugin.js"), bundle).map_err(|e| e.to_string())?;
    Ok(())
}

/// 从预览安装到正式目录（复制 + 清理预览）。已存在同名插件时拒绝（避免覆盖）。
#[tauri::command]
pub fn install_preview_plugin(app_handle: AppHandle, plugin_id: String) -> Result<(), String> {
    let preview = preview_dir(&app_handle)?.join(&plugin_id);
    if !preview.exists() {
        return Err("预览插件不存在".to_string());
    }
    let dest = crate::commands::plugins::plugins_dir(&app_handle)?.join(&plugin_id);
    if dest.exists() {
        return Err("同名插件已存在，请先在插件市场卸载旧版本".to_string());
    }
    copy_dir(&preview, &dest).map_err(|e| format!("安装失败: {e}"))?;
    let _ = std::fs::remove_dir_all(&preview);
    Ok(())
}

/// 从预览更新到正式目录（覆盖同名插件，AI 更新模式用）。与 install_preview_plugin 对称：
/// 校验预览存在、正式目录已存在、预览 manifest 的 id 与目标目录一致（防覆盖错插件）；
/// 先清空旧目录再复制（避免新版本删除的文件残留），最后清理预览。
#[tauri::command]
pub fn update_plugin_from_preview(app_handle: AppHandle, plugin_id: String) -> Result<(), String> {
    let preview = preview_dir(&app_handle)?.join(&plugin_id);
    if !preview.exists() {
        return Err("预览插件不存在".to_string());
    }
    // 预览 manifest 的 id 必须与目标插件一致（LLM 可能改 id，前端也校验，Rust 侧兜底）
    let preview_manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(preview.join("plugin.json")).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("预览 plugin.json 解析失败: {e}"))?;
    if preview_manifest.get("id").and_then(|v| v.as_str()) != Some(&plugin_id) {
        return Err("预览插件的 id 与目标插件不一致，拒绝更新".to_string());
    }
    let dest = crate::commands::plugins::plugins_dir(&app_handle)?.join(&plugin_id);
    if !dest.exists() {
        return Err("插件目录不存在，无法更新".to_string());
    }
    // 清空旧目录再复制（copy_dir 的 fs::copy 对已存在文件虽会覆盖，但目录内残留文件不会删）
    std::fs::remove_dir_all(&dest).map_err(|e| format!("清理旧插件失败: {e}"))?;
    copy_dir(&preview, &dest).map_err(|e| format!("更新失败: {e}"))?;
    let _ = std::fs::remove_dir_all(&preview);
    Ok(())
}

/// 清理预览（关闭试运行/预览弹窗时调用）
#[tauri::command]
pub fn clear_plugin_preview(app_handle: AppHandle, plugin_id: String) -> Result<(), String> {
    let dir = preview_dir(&app_handle)?.join(&plugin_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 递归复制目录
fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}
