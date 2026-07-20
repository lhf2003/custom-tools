//! 日报 agent：通过 claude CLI（headless 模式）驱动一个受限 agentic 循环，
//! agent 经 companion MCP server 查询应用数据，生成日报写入笔记模块。

use std::path::Path;
use std::process::{Command, Stdio};

use serde::Deserialize;
use tauri::AppHandle;

use super::suggester;

/// agent 最大轮次（防止失控循环）
const MAX_TURNS: &str = "12";
/// agent 允许的工具白名单（仅 companion MCP 工具）
const ALLOWED_TOOLS: &str = "mcp__companion__*";

#[derive(Debug, Deserialize)]
struct ClaudeCliResult {
    /// "success" | "error_max_turns" | "error_during_execution"
    subtype: Option<String>,
    is_error: Option<bool>,
    result: Option<String>,
    total_cost_usd: Option<f64>,
    num_turns: Option<u32>,
}

/// 运行日报 agent（阻塞式，调用方需放在独立线程）。
/// 成功返回人话摘要；失败返回错误（调用方负责回退到单次 LLM 分析）。
pub fn run_daily_report_agent(
    app_handle: &AppHandle,
    db_path: &Path,
    notes_dir: &Path,
    bin_path: &str,
    work_dir: &Path,
) -> Result<String, String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("获取自身 exe 路径失败: {}", e))?;

    // 生成 MCP 配置文件（内容稳定，每次覆盖写保证路径最新）
    let mcp_config_path = db_path
        .parent()
        .map(|p| p.join("companion-mcp.json"))
        .ok_or("无法确定 MCP 配置路径")?;
    let mcp_config = serde_json::json!({
        "mcpServers": {
            "companion": {
                "command": exe.to_string_lossy(),
                "args": [
                    "--mcp-server",
                    "--db-path", db_path.to_string_lossy(),
                    "--notes-dir", notes_dir.to_string_lossy()
                ]
            }
        }
    });
    std::fs::write(&mcp_config_path, serde_json::to_string_pretty(&mcp_config).unwrap())
        .map_err(|e| format!("写入 MCP 配置失败: {}", e))?;

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let prompt = build_report_prompt(&today);

    log::info!("Companion 日报 agent 启动: {}", bin_path);

    let mut cmd = Command::new(bin_path);
    cmd.arg("-p")
        .arg(&prompt)
        .arg("--mcp-config")
        .arg(&mcp_config_path)
        .arg("--allowedTools")
        .arg(ALLOWED_TOOLS)
        .arg("--output-format")
        .arg("json")
        .arg("--max-turns")
        .arg(MAX_TURNS)
        .current_dir(work_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;
        cmd.creation_flags(CREATE_NO_WINDOW.0);
    }

    let output = cmd
        .output()
        .map_err(|e| format!("执行 claude CLI 失败（{} 是否在 PATH 或配置正确？）: {}", bin_path, e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("claude CLI 退出码异常: {}", stderr.chars().take(500).collect::<String>()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: ClaudeCliResult = serde_json::from_str(stdout.trim())
        .map_err(|e| format!("解析 claude CLI 输出失败: {} — 原始输出: {}", e, stdout.chars().take(300).collect::<String>()))?;

    if parsed.is_error == Some(true) {
        return Err(format!(
            "agent 执行失败（{}）: {}",
            parsed.subtype.as_deref().unwrap_or("unknown"),
            parsed.result.as_deref().unwrap_or("").chars().take(300).collect::<String>()
        ));
    }

    let cost = parsed.total_cost_usd.unwrap_or(0.0);
    let turns = parsed.num_turns.unwrap_or(0);
    let summary = parsed.result.unwrap_or_else(|| "日报已生成".to_string());
    let summary_preview: String = summary.chars().take(200).collect();

    log::info!(
        "Companion 日报 agent 完成: {} 轮, 成本 ${:.4}",
        turns, cost
    );

    // 推送"日报已生成"建议卡片，用户可点击查看
    if let Ok(conn) = rusqlite::Connection::open(db_path) {
        let _ = suggester::push_suggestion(
            &conn,
            app_handle,
            "daily_report",
            "今日日报已生成",
            Some(&summary_preview),
            None,
        );
    }

    Ok(format!(
        "日报 agent 完成（{} 轮，${:.4}）: {}",
        turns, cost, summary_preview
    ))
}

fn build_report_prompt(today: &str) -> String {
    format!(
        "你是我的工作陪伴 agent。请完成「{today}」的工作日报，严格按以下步骤执行：\n\
         1. 调用 get_activity_summary 获取今天的电脑使用聚合（不传 date 参数即是今天）\n\
         2. 调用 search_clipboard（limit 设 15）了解今天复制过的内容主题\n\
         3. 调用 get_habit_patterns 查看已学到的习惯模式\n\
         4. 如果第 1 步返回没有活动记录，直接回复\"今日无数据\"并结束，不要编造内容\n\
         5. 基于以上真实数据写一份简洁的中文日报（Markdown），包含：\n\
            - 今日工作主题（从窗口标题和剪贴板内容推断，一句话）\n\
            - 时间分配（各应用时长）\n\
            - 值得注意的点（亮点或问题，一两句）\n\
            - 明日建议（一两句）\n\
         6. 调用 write_note 把日报写入笔记，filename 用 \"{today}\"\n\
         7. 如果你从数据中发现了一个此前没有的、稳定的工作习惯（比如固定的应用组合），\n\
            调用 create_suggestion 告诉我；没有发现就跳过\n\
         8. 最后用一句话回复日报的核心结论\n\
         注意：所有内容必须基于工具返回的真实数据，不要臆造。",
        today = today
    )
}
