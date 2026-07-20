use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use chrono::Timelike;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::db::{self, ActivityLog};
use super::suggester;
use super::CompanionFlags;
use crate::llm::ChatMessage;
use crate::llm_provider::crypto::decrypt;
use crate::llm_provider::db::LlmProviderDb;
use crate::llm_provider::models::Scene;

/// 每日 LLM 分析的触发小时（21 点后执行当日分析）
const DAILY_ANALYSIS_HOUR: u32 = 21;
/// 过期数据清理的触发小时（凌晨 3 点后）
const CLEANUP_HOUR: u32 = 3;
/// 会话聚合：相邻同进程记录间隔小于该值则合并
const SESSION_MERGE_GAP_SECS: i64 = 180;
/// 送给 LLM 的聚合文本长度上限（控制 token 成本）
const AGGREGATE_TEXT_CAP: usize = 3500;

/// 调度线程：每分钟检查一次
/// - 晨间工作套装模式匹配
/// - 每日 LLM 分析（到点且今日未跑过，日期持久化到 settings 表防重启重复分析）
/// - 过期数据清理
pub fn run_scheduler(app_handle: AppHandle, db_path: PathBuf, flags: Arc<RwLock<CompanionFlags>>) {
    let mut last_analysis_date: Option<String> =
        load_setting(&db_path, "companion_last_analysis_date");
    let mut last_cleanup_date: Option<String> = None;

    loop {
        std::thread::sleep(Duration::from_secs(60));

        let f = flags
            .read()
            .map(|f| f.clone())
            .unwrap_or_else(|_| CompanionFlags::default());
        if !f.enabled {
            continue;
        }

        let now = chrono::Local::now();
        let today = now.format("%Y-%m-%d").to_string();

        if !f.paused {
            if let Err(e) = match_work_suite(&app_handle, &db_path, now.timestamp()) {
                log::warn!("Companion 工作套装匹配失败: {}", e);
            }
        }

        if now.hour() >= DAILY_ANALYSIS_HOUR && last_analysis_date.as_deref() != Some(&today) {
            last_analysis_date = Some(today.clone());
            save_setting(&db_path, "companion_last_analysis_date", &today);
            let app = app_handle.clone();
            let db = db_path.clone();
            let use_agent = f.agent_enabled;
            // agent 调用是阻塞式 subprocess，放独立线程而非 async runtime
            std::thread::spawn(move || {
                let result = if use_agent {
                    match super::run_agent_with_settings(&app, &db) {
                        Ok(msg) => Ok(format!("agent 日报: {}", msg)),
                        Err(e) => {
                            log::warn!("日报 agent 失败，回退单次 LLM 分析: {}", e);
                            run_daily_analysis_blocking(&app, &db)
                        }
                    }
                } else {
                    run_daily_analysis_blocking(&app, &db)
                };
                match result {
                    Ok(msg) => log::info!("Companion 每日分析: {}", msg),
                    Err(e) => log::warn!("Companion 每日分析失败: {}", e),
                }
            });
        }

        if now.hour() >= CLEANUP_HOUR && last_cleanup_date.as_deref() != Some(&today) {
            last_cleanup_date = Some(today.clone());
            let cutoff = now.timestamp() - f.retention_days * 86400;
            if let Ok(conn) = Connection::open(&db_path) {
                match db::cleanup_activities_older_than(&conn, cutoff) {
                    Ok(n) if n > 0 => log::info!("Companion 清理过期活动记录 {} 条", n),
                    Ok(_) => {}
                    Err(e) => log::warn!("Companion 清理活动记录失败: {}", e),
                }
                let _ = db::cleanup_suggestions_older_than(&conn, cutoff);
            }
        }
    }
}

// ── 晨间工作套装 ─────────────────────────────────────────────

/// LLM 产出的应用组合模式数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComboPatternData {
    pub apps: Vec<String>,
    pub time_window: String,
    #[serde(default)]
    pub description: String,
}

/// 当前时间命中某个已确认的应用组合时间窗，且组合内应用今天还没开过 → 建议一键启动
fn match_work_suite(app_handle: &AppHandle, db_path: &PathBuf, now_ts: i64) -> Result<(), String> {
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    let day_start = day_start_ts(now_ts);
    if db::has_suggestion_since(&conn, suggester::TYPE_WORK_SUITE, day_start).unwrap_or(true) {
        return Ok(());
    }

    let combos = db::active_combo_patterns(&conn).map_err(|e| e.to_string())?;
    if combos.is_empty() {
        return Ok(());
    }

    let now_hm = minutes_of_day(now_ts);

    for pattern in combos {
        let data: ComboPatternData = match serde_json::from_str(&pattern.pattern_data) {
            Ok(d) => d,
            Err(_) => continue,
        };
        if data.apps.len() < 2 {
            continue;
        }

        let Some((win_start, win_end)) = parse_time_window(&data.time_window) else {
            continue;
        };
        // 窗口内或窗口结束后 30 分钟内都算命中
        if now_hm < win_start || now_hm > win_end + 30 {
            continue;
        }

        // 组合内任一应用今天已使用过 → 用户已经自己开始干活了，不打扰
        let totals = db::process_totals_between(&conn, day_start, now_ts).unwrap_or_default();
        let already_active = data
            .apps
            .iter()
            .any(|exe| totals.iter().any(|(p, _)| p.eq_ignore_ascii_case(exe)));
        if already_active {
            continue;
        }

        // exe 名 → 可启动路径（从启动器的使用记录里解析）
        let apps = resolve_app_paths(&conn, &data.apps);
        if apps.is_empty() {
            continue;
        }

        let payload = db::LaunchAppsPayload {
            action: "launch_apps".to_string(),
            apps,
        };
        let payload_json = serde_json::to_string(&payload).ok();
        let names: Vec<&str> = payload.apps.iter().map(|a| a.name.as_str()).collect();

        suggester::push_suggestion(
            &conn,
            app_handle,
            suggester::TYPE_WORK_SUITE,
            "开启工作模式？",
            Some(&format!(
                "{}。要一键启动 {} 吗？",
                pattern.description,
                names.join("、")
            )),
            payload_json.as_deref(),
        )?;
        break; // 一天最多一条
    }

    Ok(())
}

/// 从 app_usage 解析 exe 名到启动路径（取使用次数最多的匹配）
fn resolve_app_paths(conn: &Connection, exes: &[String]) -> Vec<db::LaunchAppItem> {
    let mut items = Vec::new();
    for exe in exes {
        let like = format!("%{}", exe);
        let found = conn
            .query_row(
                "SELECT path, name FROM app_usage
                 WHERE path LIKE ?1
                 ORDER BY launch_count DESC LIMIT 1",
                [&like],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .ok();
        if let Some((path, name)) = found {
            items.push(db::LaunchAppItem { path, name });
        }
    }
    items
}

/// "HH:MM-HH:MM" → (起始分钟数, 结束分钟数)
fn parse_time_window(window: &str) -> Option<(u32, u32)> {
    let (start, end) = window.split_once('-')?;
    Some((parse_hm(start.trim())?, parse_hm(end.trim())?))
}

fn parse_hm(hm: &str) -> Option<u32> {
    let (h, m) = hm.split_once(':')?;
    Some(h.trim().parse::<u32>().ok()? * 60 + m.trim().parse::<u32>().ok()?)
}

fn minutes_of_day(ts: i64) -> u32 {
    let dt = chrono::DateTime::from_timestamp(ts, 0)
        .map(|utc| utc.with_timezone(&chrono::Local));
    dt.map(|d| d.hour() * 60 + d.minute()).unwrap_or(0)
}

fn day_start_ts(ts: i64) -> i64 {
    chrono::DateTime::from_timestamp(ts, 0)
        .and_then(|utc| {
            let local = utc.with_timezone(&chrono::Local);
            local
                .date_naive()
                .and_hms_opt(0, 0, 0)?
                .and_local_timezone(chrono::Local)
                .single()
        })
        .map(|d| d.timestamp())
        .unwrap_or(ts - ts % 86400)
}

/// 读写 settings 键值表（custom-tools.db 内的通用 KV，与模块自己的状态共存）
fn load_setting(db_path: &PathBuf, key: &str) -> Option<String> {
    let conn = Connection::open(db_path).ok()?;
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get(0)
    })
    .ok()
}

fn save_setting(db_path: &PathBuf, key: &str, value: &str) {
    if let Ok(conn) = Connection::open(db_path) {
        let _ = conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            [key, value],
        );
    }
}

// ── 每日 LLM 分析 ────────────────────────────────────────────

/// 阻塞包装：在普通线程里跑异步分析（调度线程/agent 回退路径用）
pub fn run_daily_analysis_blocking(
    app_handle: &AppHandle,
    db_path: &PathBuf,
) -> Result<String, String> {
    tauri::async_runtime::block_on(run_daily_analysis(app_handle, db_path))
}

/// 分析昨日活动流水，挖掘习惯模式写入 habit_patterns。返回人话摘要。
pub async fn run_daily_analysis(app_handle: &AppHandle, db_path: &PathBuf) -> Result<String, String> {
    let conn = Connection::open(db_path).map_err(|e| format!("打开数据库失败: {}", e))?;

    let now = chrono::Local::now();
    let today_start = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|d| d.and_local_timezone(chrono::Local).single())
        .ok_or("无法计算当日起点")?
        .timestamp();
    let yesterday_start = today_start - 86400;

    let activities = db::activities_between(&conn, yesterday_start, today_start)
        .map_err(|e| format!("读取活动失败: {}", e))?;

    if activities.len() < 10 {
        return Ok(format!(
            "昨日活动仅 {} 条，数据不足，跳过分析",
            activities.len()
        ));
    }

    // 本地预聚合：原始流水可能有上千条，先压缩成会话级摘要再送 LLM
    let aggregate_text = aggregate_activities(&activities);
    let prompt = build_analysis_prompt(&aggregate_text);

    let reply = call_chat_scene_llm(app_handle, db_path, prompt).await?;
    let patterns = parse_llm_patterns(&reply)?;

    let now_ts = chrono::Local::now().timestamp();
    let mut saved = 0;
    for p in &patterns {
        let signature = format!("{}:{}", p.pattern_type, p.apps.join("+"));
        let data = ComboPatternData {
            apps: p.apps.clone(),
            time_window: p.time_window.clone(),
            description: p.description.clone(),
        };
        let data_json = serde_json::to_string(&data).map_err(|e| e.to_string())?;
        db::upsert_pattern(
            &conn,
            &p.pattern_type,
            &signature,
            &p.description,
            &data_json,
            p.confidence.clamp(0.0, 1.0),
            now_ts,
        )
        .map_err(|e| format!("保存模式失败: {}", e))?;
        saved += 1;
    }

    Ok(format!(
        "昨日 {} 条活动 → 聚合 {} 字符 → 提炼 {} 个模式",
        activities.len(),
        aggregate_text.len(),
        saved
    ))
}

/// 把原始活动流水压缩成会话级摘要文本
pub(crate) fn aggregate_activities(activities: &[ActivityLog]) -> String {
    struct Session {
        process: String,
        title: String,
        start: i64,
        end: i64,
    }

    // 相邻同进程（间隔 < 3min）合并为会话
    let mut sessions: Vec<Session> = Vec::new();
    for a in activities {
        let start = a.started_at;
        let end = a.ended_at.unwrap_or(a.started_at);
        let mergeable = sessions.last().map(|s| {
            s.process == a.process_name && start - s.end < SESSION_MERGE_GAP_SECS
        });
        if mergeable == Some(true) {
            if let Some(last) = sessions.last_mut() {
                last.end = end;
                last.title = a.window_title.clone();
            }
        } else {
            sessions.push(Session {
                process: a.process_name.clone(),
                title: a.window_title.clone(),
                start,
                end,
            });
        }
    }

    // 进程总时长 Top 10
    let mut totals: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    for s in &sessions {
        *totals.entry(s.process.clone()).or_default() += (s.end - s.start).max(0);
    }
    let mut totals: Vec<(String, i64)> = totals.into_iter().collect();
    totals.sort_by(|a, b| b.1.cmp(&a.1));

    let mut text = String::from("【进程时长 Top】\n");
    for (proc, secs) in totals.iter().take(10) {
        text.push_str(&format!("- {} {:.1}h\n", proc, *secs as f64 / 3600.0));
    }

    text.push_str("\n【时间线】\n");
    for s in &sessions {
        // 短于 60s 的会话视为路过，不进时间线
        if s.end - s.start < 60 {
            continue;
        }
        let title: String = s.title.chars().take(40).collect();
        text.push_str(&format!(
            "{}-{} {}「{}」\n",
            fmt_hm(s.start),
            fmt_hm(s.end),
            s.process,
            title
        ));
        if text.len() > AGGREGATE_TEXT_CAP {
            text.push_str("...(截断)\n");
            break;
        }
    }

    text
}

fn fmt_hm(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|utc| utc.with_timezone(&chrono::Local).format("%H:%M").to_string())
        .unwrap_or_default()
}

/// 聚合某一天的活动为摘要文本（供 MCP 工具 get_activity_summary 使用）
/// day_label 格式 "YYYY-MM-DD"
pub(crate) fn aggregate_day(conn: &Connection, day_label: &str) -> Result<String, String> {
    let naive = chrono::NaiveDate::parse_from_str(day_label, "%Y-%m-%d")
        .map_err(|e| format!("日期格式错误（应为 YYYY-MM-DD）: {}", e))?;
    let start = naive
        .and_hms_opt(0, 0, 0)
        .and_then(|d| d.and_local_timezone(chrono::Local).single())
        .ok_or("无法计算当日起点")?
        .timestamp();
    let end = start + 86400;

    let activities = db::activities_between(conn, start, end)
        .map_err(|e| format!("读取活动失败: {}", e))?;

    if activities.is_empty() {
        return Ok(format!("{} 没有采集到活动记录", day_label));
    }

    Ok(format!(
        "【{} 活动聚合，共 {} 段】\n{}",
        day_label,
        activities.len(),
        aggregate_activities(&activities)
    ))
}

fn build_analysis_prompt(aggregate_text: &str) -> String {
    format!(
        "以下是某位用户昨天电脑使用情况的聚合摘要（进程名 + 窗口标题 + 时段）。\n\
         请从中挖掘「工作启动组合」模式：用户在一天开始工作时，通常会在某个时间窗内先后打开哪些应用。\n\n\
         要求：\n\
         1. 只输出 JSON，不要任何其他文字。格式：\n\
         {{\"patterns\":[{{\"type\":\"app_combo\",\"apps\":[\"Code.exe\",\"chrome.exe\"],\"time_window\":\"09:00-09:45\",\"description\":\"一句话中文描述这个习惯\",\"confidence\":0.7}}]}}\n\
         2. apps 必须使用摘要中出现的进程名原文，不要翻译或改写。\n\
         3. 只保留 apps >= 2 个且置信度 >= 0.5 的模式；没有可靠模式就返回 {{\"patterns\":[]}}。\n\
         4. 最多输出 3 个模式，按置信度降序。\n\
         5. time_window 必须是 \"HH:MM-HH:MM\" 格式。\n\n\
         摘要如下：\n{}",
        aggregate_text
    )
}

#[derive(Debug, Deserialize)]
struct LlmPatternsResponse {
    patterns: Vec<LlmPattern>,
}

#[derive(Debug, Deserialize)]
struct LlmPattern {
    #[serde(rename = "type")]
    pattern_type: String,
    #[serde(default)]
    apps: Vec<String>,
    #[serde(default)]
    time_window: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    confidence: f64,
}

fn parse_llm_patterns(reply: &str) -> Result<Vec<LlmPattern>, String> {
    // 模型可能裹着 markdown 代码块输出，取第一个 { 到最后一个 } 之间的内容
    let start = reply.find('{').ok_or("LLM 响应中没有 JSON")?;
    let end = reply.rfind('}').ok_or("LLM 响应中没有 JSON")?;
    let json_str = &reply[start..=end];

    let parsed: LlmPatternsResponse =
        serde_json::from_str(json_str).map_err(|e| format!("解析 LLM JSON 失败: {}", e))?;

    Ok(parsed
        .patterns
        .into_iter()
        .filter(|p| p.pattern_type == "app_combo" && p.apps.len() >= 2)
        .filter(|p| parse_time_window(&p.time_window).is_some())
        .take(3)
        .collect())
}

/// 复用「闲聊」场景的模型配置调用 LLM（companion 分析不单独占场景位）
async fn call_chat_scene_llm(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    prompt: String,
) -> Result<String, String> {
    let conn = Connection::open(db_path).map_err(|e| format!("打开数据库失败: {}", e))?;

    let provider_db = LlmProviderDb;
    let (provider, model) = provider_db
        .get_scene_model(&conn, Scene::Chat)
        .map_err(|e| format!("获取场景模型失败: {}", e))?
        .ok_or_else(|| "尚未配置 AI 模型，请先在「设置 → AI 模型」中为闲聊场景选择模型".to_string())?;

    let thinking_mode = provider_db
        .get_scene_thinking_mode(&conn, Scene::Chat)
        .unwrap_or(false);

    let api_key = match &provider.api_key_encrypted {
        Some(encrypted) if !encrypted.is_empty() => {
            let app_data_dir = app_handle.path().app_data_dir().unwrap_or_default();
            decrypt(encrypted, &app_data_dir).map_err(|e| format!("解密 API Key 失败: {}", e))?
        }
        _ => String::new(),
    };

    let messages = vec![ChatMessage {
        role: "user".to_string(),
        content: prompt,
        images: None,
    }];

    crate::llm::call_llm(
        &provider.base_url,
        &api_key,
        &model.model_id,
        &provider.provider_type.to_string(),
        messages,
        thinking_mode,
    )
    .await
}
