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
/// 日报生成失败后的重试间隔（秒）：21 点后每 30 分钟重试一次，直到笔记落盘
const REPORT_RETRY_SECS: i64 = 1800;
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
    // 日报上次尝试时间（节流用；成功标记每轮从 DB 现读，不做内存缓存）
    let mut last_report_attempt: Option<i64> = None;

    // 启动时检查昨日日报是否缺报（昨天 21 点时 app 未运行），缺则补跑
    maybe_backfill_report(&app_handle, &db_path, &flags);

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
            if let Err(e) = match_context_routines(&app_handle, &db_path, now.timestamp()) {
                log::warn!("Companion 情境联动匹配失败: {}", e);
            }
        }

        if now.hour() >= DAILY_ANALYSIS_HOUR && last_analysis_date.as_deref() != Some(&today) {
            last_analysis_date = Some(today.clone());
            save_setting(&db_path, "companion_last_analysis_date", &today);
            let app = app_handle.clone();
            let db = db_path.clone();
            // agent 调用是阻塞式 subprocess，放独立线程而非 async runtime
            std::thread::spawn(move || {
                // 模式挖掘每晚固定执行（内部经 call_companion_llm 路由）
                match run_daily_analysis_blocking(&app, &db) {
                    Ok(msg) => log::info!("Companion 每日模式挖掘: {}", msg),
                    Err(e) => log::warn!("Companion 每日模式挖掘失败: {}", e),
                }
                // 聊天记忆提取兜底（防抖通道之外的保险，水位已最新则空转）
                match super::recall::run_recall_blocking(&app, &db) {
                    Ok(msg) => log::info!("Companion 记忆提取兜底: {}", msg),
                    Err(e) => log::warn!("Companion 记忆提取兜底失败: {}", e),
                }
            });
        }

        // 日报独立调度：companion_last_report_date 只在笔记落盘后才写，
        // 失败按 REPORT_RETRY_SECS 节流重试；用户删掉笔记不会重生成（标记仍在）。
        // 每轮从 DB 读标记（成功写入发生在子线程，内存缓存会丢更新）
        let report_done =
            load_setting(&db_path, "companion_last_report_date").as_deref() == Some(&today);
        let throttle_ok = last_report_attempt
            .map(|t| now.timestamp() - t >= REPORT_RETRY_SECS)
            .unwrap_or(true);
        if now.hour() >= DAILY_ANALYSIS_HOUR && !report_done && throttle_ok {
            last_report_attempt = Some(now.timestamp());
            let app = app_handle.clone();
            let db = db_path.clone();
            let date = today.clone();
            let cc_enabled = super::claude_code_enabled(&app_handle);
            // agent 调用是阻塞式 subprocess，放独立线程而非 async runtime
            std::thread::spawn(move || {
                // Claude Code 开启时跑 agent 日报；未开启回退场景模型版日报
                let result = if cc_enabled {
                    super::run_agent_with_settings(&app, &db, &date)
                } else {
                    match crate::notes::get_default_notes_dir() {
                        Ok(notes_dir) => tauri::async_runtime::block_on(run_scene_report(
                            &app, &db, &notes_dir, &date,
                        )),
                        Err(e) => Err(format!("获取笔记目录失败: {}", e)),
                    }
                };
                match result {
                    Ok(msg) => {
                        // 成功判定：笔记真的落盘，或明确「当日无数据」（无需重试的终态）
                        let note_written = crate::notes::get_default_notes_dir()
                            .map(|d| {
                                d.join(super::mcp::NOTE_DIR_PREFIX)
                                    .join(format!("{}.md", date))
                                    .exists()
                            })
                            .unwrap_or(false);
                        if note_written || msg.contains("无数据") {
                            save_setting(&db, "companion_last_report_date", &date);
                            log::info!("Companion 日报完成: {}", msg);
                        } else {
                            log::warn!("Companion 日报返回成功但笔记未落盘，稍后重试: {}", msg);
                        }
                    }
                    Err(e) => log::warn!("Companion 日报失败（30 分钟后重试）: {}", e),
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

// ── 缺报补跑 ─────────────────────────────────────────────

/// 补跑昨日日报：昨天 21 点时 app 未运行（或运行但生成失败）导致缺报时，启动后补一次。
/// 条件：陪伴开启 + 昨日有活动数据 + 昨日笔记不存在 + 今天没补过。
/// 只补昨天一天；Claude Code 开启走 agent，未开启走场景模型版（两者都写日报笔记）。
fn maybe_backfill_report(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    flags: &Arc<RwLock<CompanionFlags>>,
) {
    let f = flags
        .read()
        .map(|f| f.clone())
        .unwrap_or_else(|_| CompanionFlags::default());
    if !f.enabled {
        return;
    }

    let yesterday_dt = chrono::Local::now() - chrono::Duration::days(1);
    let yesterday = yesterday_dt.format("%Y-%m-%d").to_string();

    // 昨日日报已成功过则跳过——标记在即使笔记被用户删掉也不重新生成
    if load_setting(db_path, "companion_last_report_date").as_deref() == Some(&yesterday) {
        return;
    }

    let notes_dir = match crate::notes::get_default_notes_dir() {
        Ok(d) => d,
        Err(e) => {
            log::warn!("补跑日报：获取笔记目录失败: {}", e);
            return;
        }
    };
    let note_path = notes_dir
        .join(super::mcp::NOTE_DIR_PREFIX)
        .join(format!("{}.md", yesterday));
    if note_path.exists() {
        return;
    }

    // 昨日无活动数据则没有可补的内容（app 昨天可能根本没开）
    let day_start = yesterday_dt
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|d| d.and_local_timezone(chrono::Local).single())
        .map(|t| t.timestamp());
    let has_activity = day_start
        .and_then(|start| {
            Connection::open(db_path)
                .ok()
                .and_then(|conn| db::activities_between(&conn, start, start + 86400).ok())
                .map(|a| !a.is_empty())
        })
        .unwrap_or(false);
    if !has_activity {
        return;
    }

    log::info!("昨日日报缺失，补跑 {} 的日报 agent", yesterday);
    let app = app_handle.clone();
    let db = db_path.clone();
    let date = yesterday.clone();
    let cc_enabled = super::claude_code_enabled(app_handle);
    std::thread::spawn(move || {
        // Claude Code 开启 → agent 补跑；未开启 → 场景模型版补跑
        let result = if cc_enabled {
            super::run_agent_with_settings(&app, &db, &date)
        } else {
            tauri::async_runtime::block_on(run_scene_report(&app, &db, &notes_dir, &date))
        };
        match result {
            Ok(msg) => {
                log::info!("补跑日报完成: {}", msg);
                // 只有笔记真的落盘才标记成功——agent 跑完但没写笔记时，下次启动重试
                if note_path.exists() {
                    save_setting(&db, "companion_last_report_date", &date);
                }
            }
            Err(e) => log::warn!("补跑日报失败（下次启动重试）: {}", e),
        }
    });
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

/// LLM 产出的开机启动序列（B3）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartupSequenceData {
    pub apps: Vec<String>,
    #[serde(default)]
    pub description: String,
}

/// LLM 产出的情境习惯：时间 × 状态 → 行为（B3）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextRoutineData {
    pub app: String,
    pub time: String,
    #[serde(default = "default_tolerance")]
    pub tolerance_minutes: u32,
    #[serde(default)]
    pub description: String,
}

fn default_tolerance() -> u32 {
    45
}

// ── 毕业制闸门（B3 第二刀）────────────────────────────────────

enum GateAction {
    /// 继续走请示流程（弹建议卡）
    Ask,
    /// 本次跳过（降频中 / 已停用）
    Skip,
    /// 已毕业并自动执行完毕
    Executed,
}

/// 毕业制：被拒 ≥2 → 停用；被接受 ≥3 → 直接执行+轻告知；被忽略 ≥2 → 隔天降频
fn graduation_gate(
    conn: &Connection,
    app_handle: &AppHandle,
    pattern: &db::HabitPattern,
    launchable: &[db::LaunchAppItem],
    auto_title: &str,
    now_ts: i64,
) -> GateAction {
    let (accepted, dismissed, ignored) =
        db::pattern_vote_counts(conn, pattern.id, now_ts).unwrap_or((0, 0, 0));

    if dismissed >= 2 {
        log::info!("pattern #{} 被拒 {} 次，永久停用", pattern.id, dismissed);
        let _ = db::set_pattern_status(conn, pattern.id, "dismissed");
        return GateAction::Skip;
    }

    if accepted >= 3 {
        for app in launchable {
            if let Err(e) = crate::search::launch_app(&app.path) {
                log::warn!("毕业执行启动 {} 失败: {}", app.path, e);
            }
            let _ = crate::db::app_usage::record_launch(conn, &app.path, &app.name);
        }
        let body = format!(
            "「{}」你已经点头 {} 次了，以后我直接帮你开好。",
            pattern.description, accepted
        );
        if let Ok(sid) = suggester::push_suggestion(
            conn,
            app_handle,
            "auto_executed",
            auto_title,
            Some(&body),
            None,
        ) {
            let _ = db::link_suggestion_pattern(conn, sid, pattern.id);
        }
        log::info!("pattern #{} 毕业（接受 {} 次），自动执行", pattern.id, accepted);
        return GateAction::Executed;
    }

    if ignored >= 2 {
        let last = db::last_pattern_suggestion_at(conn, pattern.id)
            .unwrap_or(None)
            .unwrap_or(0);
        if now_ts - last < 2 * 86400 {
            return GateAction::Skip;
        }
    }

    GateAction::Ask
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
        // app_combo 带时间窗；startup_sequence 用默认晨间启动窗（5:00-12:00）
        let (apps, window) = match pattern.pattern_type.as_str() {
            "app_combo" => {
                let data: ComboPatternData = match serde_json::from_str(&pattern.pattern_data) {
                    Ok(d) => d,
                    Err(_) => continue,
                };
                (data.apps, parse_time_window(&data.time_window))
            }
            "startup_sequence" => {
                let data: StartupSequenceData = match serde_json::from_str(&pattern.pattern_data) {
                    Ok(d) => d,
                    Err(_) => continue,
                };
                (data.apps, Some((5 * 60, 12 * 60)))
            }
            _ => continue,
        };
        if apps.len() < 2 {
            continue;
        }

        let Some((win_start, win_end)) = window else {
            continue;
        };
        // 窗口内或窗口结束后 30 分钟内都算命中
        if now_hm < win_start || now_hm > win_end + 30 {
            continue;
        }

        // 组合内任一应用今天已使用过 → 用户已经自己开始干活了，不打扰
        let totals = db::process_totals_between(&conn, day_start, now_ts).unwrap_or_default();
        let already_active = apps
            .iter()
            .any(|exe| totals.iter().any(|(p, _)| p.eq_ignore_ascii_case(exe)));
        if already_active {
            continue;
        }
        // exe 名 → 可启动路径（从启动器的使用记录里解析）
        let launchable = resolve_app_paths(&conn, &apps);
        if launchable.is_empty() {
            continue;
        }

        // 毕业制闸门：被拒停用 / 已毕业直接执行 / 被忽略降频
        match graduation_gate(&conn, app_handle, &pattern, &launchable, "已为你启动工作模式", now_ts) {
            GateAction::Skip => continue,
            GateAction::Executed => break,
            GateAction::Ask => {}
        }

        let payload = db::LaunchAppsPayload {
            action: "launch_apps".to_string(),
            apps: launchable,
        };
        let payload_json = serde_json::to_string(&payload).ok();
        let names: Vec<&str> = payload.apps.iter().map(|a| a.name.as_str()).collect();

        let sid = suggester::push_suggestion(
            &conn,
            app_handle,
            suggester::TYPE_WORK_SUITE,
            "开启工作模式？",
            Some(&format!(
                "{}。要不要我把 {} 都开好？",
                pattern.description,
                names.join("、")
            )),
            payload_json.as_deref(),
        )?;
        let _ = db::link_suggestion_pattern(&conn, sid, pattern.id);
        break; // 一天最多一条
    }

    Ok(())
}

/// 情境习惯联动：当前时间命中 context_routine 且目标应用未开 → 「要来点 X 吗」（B3）
fn match_context_routines(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    now_ts: i64,
) -> Result<(), String> {
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let routines = db::active_context_routines(&conn).map_err(|e| e.to_string())?;
    if routines.is_empty() {
        return Ok(());
    }

    let day_start = day_start_ts(now_ts);
    let now_hm = minutes_of_day(now_ts);

    for pattern in routines {
        let data: ContextRoutineData = match serde_json::from_str(&pattern.pattern_data) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let Some(target) = parse_hm(&data.time) else {
            continue;
        };
        // 命中区间：[目标时间, 目标时间 + 容忍度]
        if now_hm < target || now_hm > target + data.tolerance_minutes {
            continue;
        }
        // 今日已发过该 pattern 的建议 → 不重复
        if db::has_pattern_suggestion_since(&conn, pattern.id, day_start).unwrap_or(true) {
            continue;
        }
        // 目标应用近期已有活动 → 用户自己开了，不打扰
        let recent_start = now_ts - data.tolerance_minutes as i64 * 60;
        let totals = db::process_totals_between(&conn, recent_start, now_ts).unwrap_or_default();
        if totals.iter().any(|(p, _)| p.eq_ignore_ascii_case(&data.app)) {
            continue;
        }
        // 解析启动路径
        let apps = resolve_app_paths(&conn, std::slice::from_ref(&data.app));
        if apps.is_empty() {
            continue;
        }

        // 毕业制闸门
        let friendly = data.app.trim_end_matches(".exe");
        match graduation_gate(
            &conn,
            app_handle,
            &pattern,
            &apps,
            &format!("已为你打开 {}", friendly),
            now_ts,
        ) {
            GateAction::Skip => continue,
            GateAction::Executed => break,
            GateAction::Ask => {}
        }

        let payload = db::LaunchAppsPayload {
            action: "launch_apps".to_string(),
            apps,
        };
        let payload_json = serde_json::to_string(&payload).ok();
        let body = if data.description.is_empty() {
            format!("这个时间你通常会打开 {}。", friendly)
        } else {
            data.description.clone()
        };

        let sid = suggester::push_suggestion(
            &conn,
            app_handle,
            "context_routine",
            &format!("要来点{}吗？", friendly),
            Some(&body),
            payload_json.as_deref(),
        )?;
        let _ = db::link_suggestion_pattern(&conn, sid, pattern.id);
        break; // 一次最多一条
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
    let dt = chrono::DateTime::from_timestamp(ts, 0).map(|utc| utc.with_timezone(&chrono::Local));
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

/// 读写 settings 键值表（flowhub.db 内的通用 KV，与模块自己的状态共存）
pub(crate) fn load_setting(db_path: &PathBuf, key: &str) -> Option<String> {
    let conn = Connection::open(db_path).ok()?;
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get(0)
    })
    .ok()
}

pub(crate) fn save_setting(db_path: &PathBuf, key: &str, value: &str) {
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
pub async fn run_daily_analysis(
    app_handle: &AppHandle,
    db_path: &PathBuf,
) -> Result<String, String> {
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
        .map(|dir| super::persona::load_role(dir, "analyst"))
        .unwrap_or_default();
    let ve_section = voice_expectation_section(&conn);
    let prompt = build_analysis_prompt(&persona, &evolution, &role, &aggregate_text, &ve_section);

    let reply = call_companion_llm(app_handle, db_path, prompt).await?;
    let parsed = parse_llm_patterns(&reply)?;

    let now_ts = chrono::Local::now().timestamp();
    let mut saved = 0;
    for p in &parsed.patterns {
        let (signature, data_json) = match p.pattern_type.as_str() {
            "app_combo" => {
                let data = ComboPatternData {
                    apps: p.apps.clone(),
                    time_window: p.time_window.clone(),
                    description: p.description.clone(),
                };
                (
                    format!("app_combo:{}", p.apps.join("+")),
                    serde_json::to_string(&data).map_err(|e| e.to_string())?,
                )
            }
            "startup_sequence" => {
                let data = StartupSequenceData {
                    apps: p.apps.clone(),
                    description: p.description.clone(),
                };
                (
                    format!("startup_sequence:{}", p.apps.join("→")),
                    serde_json::to_string(&data).map_err(|e| e.to_string())?,
                )
            }
            "context_routine" => {
                let data = ContextRoutineData {
                    app: p.app.clone(),
                    time: p.time.clone(),
                    tolerance_minutes: p.tolerance_minutes.unwrap_or(45),
                    description: p.description.clone(),
                };
                (
                    format!("context_routine:{}@{}", p.app, p.time),
                    serde_json::to_string(&data).map_err(|e| e.to_string())?,
                )
            }
            _ => continue,
        };
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

    // 沉淀个人事实（记忆层）
    let mut facts_saved = 0;
    for f in &parsed.facts {
        db::upsert_memory_fact(&conn, &f.fact, &f.category, "daily_analysis", now_ts)
            .map_err(|e| format!("保存事实失败: {}", e))?;
        facts_saved += 1;
    }

    Ok(format!(
        "昨日 {} 条活动 → 聚合 {} 字符 → {} 个模式 + {} 条事实",
        activities.len(),
        aggregate_text.len(),
        saved,
        facts_saved
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
        let mergeable = sessions
            .last()
            .map(|s| s.process == a.process_name && start - s.end < SESSION_MERGE_GAP_SECS);
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
        .map(|utc| {
            utc.with_timezone(&chrono::Local)
                .format("%H:%M")
                .to_string()
        })
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

    let activities =
        db::activities_between(conn, start, end).map_err(|e| format!("读取活动失败: {}", e))?;

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

/// 语气相关两维记忆（voice 表达偏好 + expectation 对贾维斯的期望），
/// 追加在日报/分析等产出型 prompt 末尾，让输出贴合他的偏好。无则返回空串。
pub(crate) fn voice_expectation_section(conn: &Connection) -> String {
    let facts = db::list_memory_facts_by_categories(conn, &["voice", "expectation"], 20)
        .unwrap_or_default();
    if facts.is_empty() {
        return String::new();
    }
    let lines = facts
        .iter()
        .map(|f| format!("- ({}) {}", f.category, f.fact))
        .collect::<Vec<_>>()
        .join("\n");
    format!("\n\n---\n\n# 他的表达偏好与对你的期望\n{}", lines)
}

fn build_analysis_prompt(
    persona: &str,
    evolution: &str,
    role: &str,
    aggregate_text: &str,
    ve_section: &str,
) -> String {
    format!(
        "{persona}\n\n---\n\n{evolution}\n\n---\n\n{role}\n\n---\n\n\
         以上是贾维斯的身份设定、经验本与分析工作手册。\n\
         以下是他昨天电脑使用情况的聚合摘要（进程名 + 窗口标题 + 时段）：\n\n{aggregate_text}{ve_section}",
        persona = persona,
        evolution = evolution,
        role = role,
        aggregate_text = aggregate_text,
        ve_section = ve_section
    )
}

#[derive(Debug, Deserialize)]
struct LlmPatternsResponse {
    #[serde(default)]
    patterns: Vec<LlmPattern>,
    #[serde(default)]
    facts: Vec<LlmFact>,
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
    app: String,
    #[serde(default)]
    time: String,
    #[serde(default)]
    tolerance_minutes: Option<u32>,
    #[serde(default)]
    description: String,
    #[serde(default)]
    confidence: f64,
}

#[derive(Debug, Deserialize)]
struct LlmFact {
    fact: String,
    #[serde(default = "default_fact_category")]
    category: String,
}

fn default_fact_category() -> String {
    "general".to_string()
}

fn parse_llm_patterns(reply: &str) -> Result<LlmPatternsResponse, String> {
    // 模型可能裹着 markdown 代码块输出，取第一个 { 到最后一个 } 之间的内容
    let start = reply.find('{').ok_or("LLM 响应中没有 JSON")?;
    let end = reply.rfind('}').ok_or("LLM 响应中没有 JSON")?;
    let json_str = &reply[start..=end];

    let mut parsed: LlmPatternsResponse =
        serde_json::from_str(json_str).map_err(|e| format!("解析 LLM JSON 失败: {}", e))?;

    parsed.patterns.retain(|p| match p.pattern_type.as_str() {
        "app_combo" => p.apps.len() >= 2 && parse_time_window(&p.time_window).is_some(),
        "startup_sequence" => p.apps.len() >= 2,
        "context_routine" => !p.app.is_empty() && parse_hm(&p.time).is_some(),
        _ => false,
    });
    parsed.facts.retain(|f| f.fact.trim().len() >= 4);
    parsed.facts.truncate(3);

    Ok(parsed)
}

// ── 意图触发器解析（B2）──────────────────────────────────────

/// 解析意图触发器并写回数据库（创建和重试共用的完整链路）
pub async fn parse_and_store_triggers(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    intent_id: i64,
    text: &str,
) -> Result<(), String> {
    let triggers = parse_intent_triggers(app_handle, db_path, text).await?;
    let has_triggers =
        triggers.due.is_some() || triggers.person.is_some() || !triggers.keywords.is_empty();
    if !has_triggers {
        return Ok(());
    }
    let json = serde_json::to_string(&triggers).map_err(|e| e.to_string())?;
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    db::update_intent_triggers(&conn, intent_id, &json, triggers.due.as_deref())
        .map_err(|e| format!("写回触发器失败: {}", e))?;
    log::info!("意图 #{} 触发器解析成功", intent_id);
    Ok(())
}

/// 用 LLM 从意图原文解析触发器 {due, person, channel, keywords}。
/// 失败不致命——调用方保留原文，靠晨间汇总兜底。
/// prompt 注入记忆层事实（如"刘光俊=前端同事"），让解析更懂用户语境。
pub async fn parse_intent_triggers(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    text: &str,
) -> Result<db::IntentTriggers, String> {
    let today = chrono::Local::now().format("%Y-%m-%d");

    // 注入记忆层事实（最多 10 条，控制 prompt 长度）
    let facts_context = Connection::open(db_path)
        .ok()
        .and_then(|conn| db::list_memory_facts(&conn, 10).ok())
        .filter(|facts| !facts.is_empty())
        .map(|facts| {
            let lines: Vec<String> = facts.into_iter().map(|f| format!("- {}", f.fact)).collect();
            format!("\n\n关于这个用户，你知道这些事实：\n{}", lines.join("\n"))
        })
        .unwrap_or_default();

    let prompt = format!(
        "从下面这句话中提取触发条件，用于在正确的时机提醒用户。\n\
         只输出 JSON，不要任何其他文字。格式：\n\
         {{\"due\":\"YYYY-MM-DD 或 null\",\"person\":\"联系人名 或 null\",\"channel\":\"沟通渠道（微信/钉钉/飞书/QQ 等）或 null\",\"keywords\":[\"窗口标题里可能出现的关键词，最多3个\"]}}\n\
         规则：\n\
         1. 今天是 {today}。\"明天\"=\"今天+1天\"，\"周五\"=最近的周五，\"下周X\"=下周的星期X。没有明确时间则 due 为 null。\n\
         2. person 只提取明确的人名/称呼（如\"张三\"\"前端小李\"），没有则为 null。\n\
         3. channel 只在明确提到沟通软件时填写。\n\
         4. keywords 提取能识别相关应用/项目/事项的实词（如项目名、\"接口文档\"），不要虚词。没有合适的关键词就给空数组。{facts_context}\n\
         原话：「{text}」",
        today = today,
        facts_context = facts_context,
        text = text
    );

    let reply = call_companion_llm(app_handle, db_path, prompt).await?;

    let start = reply.find('{').ok_or("解析响应中没有 JSON")?;
    let end = reply.rfind('}').ok_or("解析响应中没有 JSON")?;
    let mut triggers: db::IntentTriggers = serde_json::from_str(&reply[start..=end])
        .map_err(|e| format!("解析触发器 JSON 失败: {}", e))?;

    // 校验 due 格式，非法则丢弃（不影响其他字段）
    if let Some(due) = &triggers.due {
        if chrono::NaiveDate::parse_from_str(due, "%Y-%m-%d").is_err() {
            triggers.due = None;
        }
    }
    // 清理空串和无效关键词
    triggers.person = triggers.person.filter(|p| !p.trim().is_empty());
    triggers.channel = triggers.channel.filter(|c| !c.trim().is_empty());
    triggers.keywords.retain(|k| !k.trim().is_empty());
    triggers.keywords.truncate(3);

    Ok(triggers)
}

/// 场景模型版日报（Claude Code 未开启时的回退）：
/// 数据本地预聚合后内联给模型，单次调用成文，不经 agent/MCP。
/// 调用方需放在 blocking 线程（内部 LLM 路由与文件写入为阻塞操作）。
pub(crate) async fn run_scene_report(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    notes_dir: &PathBuf,
    date: &str,
) -> Result<String, String> {
    let conn = Connection::open(db_path).map_err(|e| format!("打开数据库失败: {}", e))?;
    let aggregate = aggregate_day(&conn, date)?;

    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let persona = super::persona::load(&app_data);
    let evolution = super::persona::load_evolution(&app_data);
    let role = super::persona::load_role(&app_data, "reporter");
    let ve_section = voice_expectation_section(&conn);
    let prompt = format!(
        "{persona}\n\n---\n\n{evolution}\n\n---\n\n{role}\n\n---\n\n\
         以上是贾维斯的身份设定、经验本与日报工作手册。\n\
         注意：你现在没有数据工具——他昨天的电脑使用聚合已直接给你（见末尾），\n\
         跳过流程中的工具调用步骤，直接完成「写日报」那一步。\n\
         如果内容显示没有活动记录，只回复「当日无数据」。\n\n{aggregate}{ve_section}"
    );

    let report = call_companion_llm(app_handle, db_path, prompt).await?;
    if report.contains("当日无数据") {
        return Ok("当日无数据，未生成日报".to_string());
    }

    let relative = format!("{}/{}.md", super::mcp::NOTE_DIR_PREFIX, date);
    let manager = crate::notes::NotesManager::new(notes_dir.clone());
    manager
        .write_note(&relative, &report)
        .map_err(|e| format!("写入笔记失败: {}", e))?;

    if let Ok(conn2) = Connection::open(db_path) {
        let preview: String = report.chars().take(200).collect();
        let _ = super::suggester::push_suggestion(
            &conn2,
            app_handle,
            "daily_report",
            &format!("{} 日报已生成", date),
            Some(&preview),
            None,
        );
    }
    Ok(format!("日报已生成（场景模型）: {}", relative))
}

/// 陪伴统一 LLM 路由（陪伴场景）:全局 Claude Code 开启 → claude CLI 单次问答
/// （失败自动回退场景模型）；未开启 → 直接用场景模型。
pub(crate) async fn call_companion_llm(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    prompt: String,
) -> Result<String, String> {
    call_llm_with_scene(app_handle, db_path, prompt, Scene::Companion).await
}

/// 带场景的 LLM 路由：记忆提取等场景有独立模型配置（缺省回退陪伴场景）。
pub(crate) async fn call_llm_with_scene(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    prompt: String,
    scene: Scene,
) -> Result<String, String> {
    if super::claude_code_enabled(app_handle) {
        let cc_result = run_claude_code_oneshot(app_handle, &prompt).await;
        match cc_result {
            Ok(reply) => return Ok(reply),
            Err(cc_err) => {
                log::warn!("Claude Code 调用失败，回退场景模型: {}", cc_err);
                return call_scene_model_llm(app_handle, db_path, prompt, scene)
                    .await
                    .map_err(|scene_err| {
                        format!(
                            "Claude Code 失败（{}）；场景模型也不可用（{}）",
                            cc_err, scene_err
                        )
                    });
            }
        }
    }

    call_scene_model_llm(app_handle, db_path, prompt, scene).await
}

/// 在 blocking 线程里跑 claude CLI 单次问答（子进程是阻塞 IO，不能占 async runtime）
async fn run_claude_code_oneshot(app_handle: &AppHandle, prompt: &str) -> Result<String, String> {
    use tauri::Manager;

    let settings = app_handle
        .try_state::<crate::commands::settings::SettingsState>()
        .ok_or("设置模块未初始化")?
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get_settings();

    let work_dir = super::agent::resolve_work_dir(app_handle, &settings.claude_code_work_dir)?;
    let bin = settings.claude_code_bin_path.clone();
    let prompt_owned = prompt.to_string();

    tauri::async_runtime::spawn_blocking(move || {
        super::agent::run_oneshot(&bin, &work_dir, &prompt_owned)
    })
    .await
    .map_err(|e| format!("claude 线程异常: {}", e))?
}

/// 按场景配置调用场景模型。非陪伴场景未单独配置时，
/// 回退陪伴场景配置（缺省跟随，用户可在模型设置里改绑）。
pub(crate) async fn call_scene_model_llm(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    prompt: String,
    scene: Scene,
) -> Result<String, String> {
    let conn = Connection::open(db_path).map_err(|e| format!("打开数据库失败: {}", e))?;

    let provider_db = LlmProviderDb;
    let resolved = provider_db
        .get_scene_model(&conn, scene.clone())
        .map_err(|e| format!("获取场景模型失败: {}", e))?
        .map(|(p, m)| (p, m, scene.clone()))
        .or_else(|| {
            if scene == Scene::Companion {
                return None;
            }
            log::info!("场景 {} 未配置模型，回退陪伴场景", scene);
            provider_db
                .get_scene_model(&conn, Scene::Companion)
                .ok()
                .flatten()
                .map(|(p, m)| (p, m, Scene::Companion))
        });
    let (provider, model, used_scene) = resolved.ok_or_else(|| {
        "尚未配置 AI 模型，请先在「设置 → AI 模型」中为陪伴场景选择模型".to_string()
    })?;

    let thinking_mode = provider_db
        .get_scene_thinking_mode(&conn, used_scene)
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
