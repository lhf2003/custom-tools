//! 日报 agent：通过 claude CLI（headless 模式）驱动一个受限 agentic 循环，
//! agent 经 companion MCP server 查询应用数据，生成日报写入笔记模块。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Deserialize;
use tauri::{AppHandle, Manager};

use super::suggester;

/// agent 最大轮次（防止失控循环）
const MAX_TURNS: &str = "12";
/// agent 允许的工具白名单（仅 companion MCP 工具）
const ALLOWED_TOOLS: &str = "mcp__companion__*";
/// claude 用户配置中注册的 MCP 服务器名
const MCP_SERVER_NAME: &str = "companion";

#[derive(Debug, Deserialize)]
struct ClaudeCliResult {
    /// "success" | "error_max_turns" | "error_during_execution"
    subtype: Option<String>,
    is_error: Option<bool>,
    result: Option<String>,
    total_cost_usd: Option<f64>,
    num_turns: Option<u32>,
    usage: Option<ClaudeCliUsage>,
}

/// CLI result JSON 里的 token 用量（字段缺省容错为 0）
#[derive(Debug, Deserialize)]
struct ClaudeCliUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

/// 单次问答的计量回执（观测登记用）
pub struct OneshotReply {
    pub text: String,
    pub cost_usd: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// 运行日报 agent（阻塞式，调用方需放在独立线程）。
/// `date` 为日报目标日期（YYYY-MM-DD），通常是今天，补跑时为过去某天。
/// 成功返回人话摘要；失败返回错误（调用方负责回退到单次 LLM 分析）。
pub fn run_daily_report_agent(
    app_handle: &AppHandle,
    db_path: &Path,
    notes_dir: &Path,
    bin_path: &str,
    work_dir: &Path,
    date: &str,
) -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("获取自身 exe 路径失败: {}", e))?;

    // 确保 companion MCP server 已注册到 claude 用户配置
    // （--mcp-config 在本版本 CLI 下不生效，用户级注册是唯一可靠通道）
    ensure_mcp_registered(bin_path, &exe, db_path, notes_dir)?;

    let app_data = app_handle.path().app_data_dir().ok();
    let persona = app_data
        .as_ref()
        .map(|dir| super::persona::load(dir))
        .unwrap_or_default();
    let evolution = app_data
        .as_ref()
        .map(|dir| super::persona::load_evolution(dir))
        .unwrap_or_default();
    let role = app_data
        .as_ref()
        .map(|dir| super::persona::load_role(dir, "reporter"))
        .unwrap_or_default();
    // 语气两维（表达偏好 + 对贾维斯的期望）注入日报 prompt，让成文贴合他本人
    let (ve_section, state_text) = rusqlite::Connection::open(db_path)
        .ok()
        .map(|conn| {
            (
                super::analyzer::voice_expectation_section(&conn),
                super::state::current_state_sentence(&conn, chrono::Local::now().timestamp()),
            )
        })
        .unwrap_or_default();
    let prompt = build_report_prompt(&persona, &evolution, &role, date, &ve_section, &state_text);

    log::info!("Companion 日报 agent 启动: {}", bin_path);
    let started = std::time::Instant::now();

    let mut cmd = cli_command(bin_path, work_dir);
    cmd.arg("-p")
        .arg(&prompt)
        .arg("--allowedTools")
        .arg(ALLOWED_TOOLS)
        .arg("--output-format")
        .arg("json")
        .arg("--max-turns")
        .arg(MAX_TURNS);

    let output = cmd.output().map_err(|e| {
        format!(
            "执行 claude CLI 失败（{} 是否在 PATH 或配置正确？）: {}",
            bin_path, e
        )
    })?;

    let parsed = parse_cli_output(&output)?;
    let duration_ms = started.elapsed().as_millis() as u64;

    if parsed.is_error == Some(true) {
        let reason = format!(
            "agent 执行失败（{}）: {}",
            parsed.subtype.as_deref().unwrap_or("unknown"),
            parsed
                .result
                .as_deref()
                .unwrap_or("")
                .chars()
                .take(300)
                .collect::<String>()
        );
        crate::llm::observe::log_call(db_path, &crate::llm::observe::LlmCallEntry {
            source: "report",
            channel: "claude_code",
            scene: None,
            model: None,
            input_tokens: 0,
            output_tokens: 0,
            cost_usd: 0.0,
            duration_ms,
            status: "error",
            error: Some(&reason),
        });
        return Err(reason);
    }

    let cost = parsed.total_cost_usd.unwrap_or(0.0);
    let turns = parsed.num_turns.unwrap_or(0);
    let summary = parsed.result.unwrap_or_else(|| "日报已生成".to_string());
    let summary_preview: String = summary.chars().take(200).collect();

    let (input_tokens, output_tokens) = parsed
        .usage
        .map(|u| (u.input_tokens.unwrap_or(0), u.output_tokens.unwrap_or(0)))
        .unwrap_or((0, 0));
    crate::llm::observe::log_call(db_path, &crate::llm::observe::LlmCallEntry {
        source: "report",
        channel: "claude_code",
        scene: None,
        model: None,
        input_tokens,
        output_tokens,
        cost_usd: cost,
        duration_ms,
        status: "ok",
        error: None,
    });

    log::info!("Companion 日报 agent 完成: {} 轮, 成本 ${:.4}", turns, cost);

    // 推送"日报已生成"建议卡片，用户可点击查看
    if let Ok(conn) = rusqlite::Connection::open(db_path) {
        let _ = suggester::push_suggestion(
            &conn,
            app_handle,
            suggester::TYPE_DAILY_REPORT,
            &format!("{} 日报已生成", date),
            Some(&summary_preview),
            None,
        );
    }

    Ok(format!(
        "日报 agent 完成（{} 轮，${:.4}）: {}",
        turns, cost, summary_preview
    ))
}

/// 构建 claude CLI 子进程（headless、无窗口、管道输出）。
/// ENABLE_TOOL_SEARCH=false 是关键：禁用 ToolSearch 延迟加载，
/// 否则 MCP 工具在 headless 会话中不可见。
pub(crate) fn cli_command(bin_path: &str, work_dir: &Path) -> Command {
    let mut cmd = Command::new(bin_path);
    cmd.env("ENABLE_TOOL_SEARCH", "false")
        .current_dir(work_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;
        cmd.creation_flags(CREATE_NO_WINDOW.0);
    }

    cmd
}

/// 解析 claude CLI 的 JSON 输出（进程级错误在这里，业务级 is_error 由调用方判断）
fn parse_cli_output(output: &std::process::Output) -> Result<ClaudeCliResult, String> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "claude CLI 退出码异常: {}",
            stderr.chars().take(500).collect::<String>()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim()).map_err(|e| {
        format!(
            "解析 claude CLI 输出失败: {} — 原始输出: {}",
            e,
            stdout.chars().take(300).collect::<String>()
        )
    })
}

/// Claude Code 单次问答：禁工具、单轮，返回 result 文本与计量。
/// 用于陪伴的模式挖掘/意图解析等「一问一答」场景（不做 MCP 注册）。
pub fn run_oneshot(bin_path: &str, work_dir: &Path, prompt: &str) -> Result<OneshotReply, String> {
    let mut cmd = cli_command(bin_path, work_dir);
    cmd.arg("-p")
        .arg(prompt)
        .arg("--allowedTools")
        .arg("")
        .arg("--output-format")
        .arg("json")
        .arg("--max-turns")
        .arg("1");

    let output = cmd.output().map_err(|e| {
        format!(
            "执行 claude CLI 失败（{} 是否在 PATH 或配置正确？）: {}",
            bin_path, e
        )
    })?;

    let parsed = parse_cli_output(&output)?;

    if parsed.is_error == Some(true) {
        return Err(format!(
            "claude 单次问答失败（{}）: {}",
            parsed.subtype.as_deref().unwrap_or("unknown"),
            parsed
                .result
                .as_deref()
                .unwrap_or("")
                .chars()
                .take(300)
                .collect::<String>()
        ));
    }

    let usage = parsed.usage;
    Ok(OneshotReply {
        text: parsed
            .result
            .ok_or_else(|| "claude 未返回结果".to_string())?,
        cost_usd: parsed.total_cost_usd.unwrap_or(0.0),
        input_tokens: usage.as_ref().and_then(|u| u.input_tokens).unwrap_or(0),
        output_tokens: usage.and_then(|u| u.output_tokens).unwrap_or(0),
    })
}

/// 解析 Claude Code 工作目录：配置了用配置值，否则默认 app_data_dir/companion-agent。
/// 默认目录独立为空——不继承用户工作区（那里的 CLAUDE.md、.claude hooks
/// 会注入 agent 上下文，且可能含敏感信息）。
pub fn resolve_work_dir(app_handle: &AppHandle, configured: &str) -> Result<PathBuf, String> {
    use tauri::Manager;

    let dir = if configured.trim().is_empty() {
        app_handle
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("companion-agent")
    } else {
        PathBuf::from(configured.trim())
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 agent 工作区失败: {}", e))?;
    Ok(dir)
}

/// 检查 claude 用户配置中是否已有 companion MCP server，没有则注册。
/// 注册是一次性副作用（写入 ~/.claude.json），之后所有 claude 会话
/// （包括交互式）都能使用 companion 工具。
/// 加固：注册失败（CLI 冷启动、~/.claude.json 文件锁等）重试 3 次再放弃。
fn ensure_mcp_registered(
    bin_path: &str,
    exe: &Path,
    db_path: &Path,
    notes_dir: &Path,
) -> Result<(), String> {
    let mut last_err = String::new();
    for attempt in 1..=3 {
        match ensure_mcp_registered_once(bin_path, exe, db_path, notes_dir) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last_err = e;
                log::warn!("companion MCP 注册第 {} 次失败: {}", attempt, last_err);
                if attempt < 3 {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                }
            }
        }
    }
    Err(format!("MCP 注册重试 3 次均失败: {}", last_err))
}

/// ensure_mcp_registered 的单次尝试（list 检查 → 过期移除 → add）
fn ensure_mcp_registered_once(
    bin_path: &str,
    exe: &Path,
    db_path: &Path,
    notes_dir: &Path,
) -> Result<(), String> {
    // `claude mcp list` 会健康检查所有服务器（包括我们的），顺带验证可用性
    let list_output = Command::new(bin_path)
        .args(["mcp", "list"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("执行 claude mcp list 失败: {}", e))?;

    let list_stdout = String::from_utf8_lossy(&list_output.stdout);
    let exe_str = exe.to_string_lossy().replace('\\', "/");
    let db_str = db_path.to_string_lossy().replace('\\', "/");
    let notes_str = notes_dir.to_string_lossy().replace('\\', "/");
    let existing = list_stdout
        .lines()
        .find(|l| l.starts_with(&format!("{}:", MCP_SERVER_NAME)));

    match existing {
        // 已注册且 exe 与数据参数都指向当前路径 → 直接用
        Some(line)
            if line.contains(&exe_str)
                && line.contains(&db_str)
                && line.contains(&notes_str) =>
        {
            return Ok(())
        }
        // 已注册但路径过期（dev/prod 切换、数据目录迁移）→ 先移除再重新注册
        Some(_) => {
            log::info!("companion MCP 注册路径过期，重新注册");
            let _ = Command::new(bin_path)
                .args(["mcp", "remove", MCP_SERVER_NAME])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .output();
        }
        None => {}
    }

    log::info!("注册 companion MCP server 到 claude 用户配置");
    let add_output = Command::new(bin_path)
        .args(["mcp", "add", MCP_SERVER_NAME, "--scope", "user", "--"])
        .arg(&exe_str)
        .arg("--mcp-server")
        .arg("--db-path")
        .arg(db_path.to_string_lossy().replace('\\', "/"))
        .arg("--notes-dir")
        .arg(notes_dir.to_string_lossy().replace('\\', "/"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("执行 claude mcp add 失败: {}", e))?;

    if !add_output.status.success() {
        let stderr = String::from_utf8_lossy(&add_output.stderr);
        return Err(format!(
            "注册 MCP server 失败: {}",
            stderr.chars().take(300).collect::<String>()
        ));
    }

    Ok(())
}

fn build_report_prompt(persona: &str, evolution: &str, role: &str, date: &str, ve_section: &str, state_text: &str) -> String {
    format!(
        "{persona}\n\n---\n\n{evolution}\n\n---\n\n{role}{ve_section}\n\n---\n\n\
         以上是贾维斯的身份设定、经验本与日报工作手册。请完成「{date}」的工作日报。\n\n---\n\n# 当下状态\n{state}",
        persona = persona,
        evolution = evolution,
        role = role,
        ve_section = ve_section,
        date = date,
        state = state_text
    )
}
