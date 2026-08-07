use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use chrono::{Datelike, Timelike};
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

/// 模式挖掘的默认触发时刻（analyst.md 丢失/无 schedule 字段时回退）——手册丢了分析也不能丢
const DEFAULT_ANALYSIS_SLOTS: [(u32, u32); 4] = [(9, 0), (14, 0), (18, 0), (0, 0)];
/// 日报生成失败后的重试间隔（秒）：0 点块首跑失败后每 30 分钟重试一次，直到笔记落盘
const REPORT_RETRY_SECS: i64 = 1800;
/// 过期数据清理的触发小时（凌晨 3 点后）
const CLEANUP_HOUR: u32 = 3;
/// 会话聚合：相邻同进程记录间隔小于该值则合并
const SESSION_MERGE_GAP_SECS: i64 = 180;
/// 送给 LLM 的聚合文本长度上限（控制 token 成本）
const AGGREGATE_TEXT_CAP: usize = 3500;
/// 增量分析窗口的最大回看时长（水位线异常时兜底，防一次巨型窗口）
const ANALYSIS_MAX_LOOKBACK_SECS: i64 = 7 * 86400;

/// 日报触发时刻：从 reporter.md frontmatter 的 schedule 读（三期调度移交）。
/// Some((时, 分)) = 按此时刻触发（daily 多时刻时取首个）；None = 手册被 enabled:false 禁用，不调度。
/// 文件丢失/无 schedule 字段回退内置 00:00——手册丢了日报也不能丢。
fn reporter_schedule(app_handle: &AppHandle) -> Option<(u32, u32)> {
    const DEFAULT: (u32, u32) = (0, 0);
    let Ok(app_data) = app_handle.path().app_data_dir() else {
        return Some(DEFAULT);
    };
    match super::skills::scan_skills(&app_data)
        .into_iter()
        .find(|s| s.name == "reporter")
    {
        Some(s) if !s.enabled => None,
        Some(s) => match s.schedule {
            Some(super::skills::Schedule::Daily { times }) => {
                times.first().copied().or(Some(DEFAULT))
            }
            _ => Some(DEFAULT),
        },
        None => Some(DEFAULT),
    }
}

/// 模式挖掘触发时刻表：从 analyst.md frontmatter 的 schedule 读（与日报同款调度移交）。
/// Some(时刻表) = 按表触发；None = 手册被 enabled:false 禁用，模式挖掘停摆（0 点链路不受影响）。
/// 文件丢失/无 schedule 字段回退内置 [9, 14, 18, 0]。
fn analyst_schedule(app_handle: &AppHandle) -> Option<Vec<(u32, u32)>> {
    let Ok(app_data) = app_handle.path().app_data_dir() else {
        return Some(DEFAULT_ANALYSIS_SLOTS.to_vec());
    };
    match super::skills::scan_skills(&app_data)
        .into_iter()
        .find(|s| s.name == "analyst")
    {
        Some(s) if !s.enabled => None,
        Some(s) => match s.schedule {
            Some(super::skills::Schedule::Daily { times }) if !times.is_empty() => Some(times),
            _ => Some(DEFAULT_ANALYSIS_SLOTS.to_vec()),
        },
        None => Some(DEFAULT_ANALYSIS_SLOTS.to_vec()),
    }
}

/// 最近一个已到点的 slot key（格式 YYYY-MM-DD#HH）：今天的 slot 时刻已过取今天，否则取昨天。
/// 与 settings 里的 companion_last_analysis_slot 比对防重；错过多个 slot 时只返回最新一个
/// （水位线机制下错过的数据已并入本次窗口，逐个补跑只会重复送同一批数据）。
fn latest_due_slot(now: chrono::DateTime<chrono::Local>, slots: &[(u32, u32)]) -> Option<String> {
    let today = now.date_naive();
    let mut best: Option<(chrono::NaiveDate, u32, u32)> = None;
    for &(h, m) in slots {
        let slot_today = today.and_hms_opt(h, m, 0)?;
        let day = if slot_today > now.naive_local() {
            today.pred_opt()?
        } else {
            today
        };
        let newer = best.map_or(true, |(bd, bh, bm)| {
            day > bd || (day == bd && (h, m) > (bh, bm))
        });
        if newer {
            best = Some((day, h, m));
        }
    }
    best.map(|(d, h, _)| format!("{}#{:02}", d.format("%Y-%m-%d"), h))
}

/// 每周自评（三期建议反馈闭环）：统计近 7 天弹窗处置 → 场景模型提炼 →
/// 写回经验本「弹窗分寸」节（走 append_evolution 同路径：校验+快照，不门控）。
/// 登记观测 source=weekly_review；本周无数据/无新经验时跳过不写。
pub fn run_weekly_review_blocking(
    app_handle: &AppHandle,
    db_path: &PathBuf,
) -> Result<String, String> {
    tauri::async_runtime::block_on(run_weekly_review(app_handle, db_path))
}

async fn run_weekly_review(app_handle: &AppHandle, db_path: &PathBuf) -> Result<String, String> {
    let now = chrono::Local::now().timestamp();
    let stats = {
        let conn = Connection::open(db_path).map_err(|e| format!("打开数据库失败: {}", e))?;
        db::suggestion_stats_since(&conn, now - 7 * 86400, now - 48 * 3600)
            .map_err(|e| format!("统计建议处置失败: {}", e))?
    };
    if stats.is_empty() {
        return Ok("本周没有建议数据，跳过自评".to_string());
    }
    let mut lines = String::new();
    for s in &stats {
        lines.push_str(&format!(
            "- {}: 接受{} 拒绝{} 忽略{} 提示{}\n",
            s.suggestion_type, s.accepted, s.dismissed, s.ignored, s.seen
        ));
    }
    let prompt = format!(
        "你是贾维斯。这是你的弹窗建议最近 7 天的处置数据（他对每条弹窗做了什么）：\n{}\n\
         「忽略」= 弹窗挂了超过 48 小时他没处置；「提示」= 纯通知型不需要处置。\n\
         复盘这些数字，为你的「弹窗分寸」沉淀经验。规则：\n\
         1. 单类型样本（接受+拒绝+忽略）少于 5 条只报数不下结论——小样本不出经验\n\
         2. 接受率高的类型是你的成功案例，也要看见——只盯着被拒绝的会让你越来越保守\n\
         3. 有值得沉淀的写 1-2 条经验，每条一行、说清做什么和为什么（60 字内）；没有就输出「无」\n\
         只输出经验条目本身，不要标题、编号和前后缀。",
        lines
    );
    let result = call_scene_model_llm(
        app_handle,
        db_path,
        prompt,
        Scene::Companion,
        "weekly_review",
    )
    .await?;
    let mut wrote = 0;
    for line in result.lines().take(3) {
        let lesson = line.trim().trim_start_matches(['-', '•', '*', ' ']).trim();
        if lesson.is_empty() || lesson == "无" {
            continue;
        }
        let args = serde_json::json!({ "section": "弹窗分寸", "lesson": lesson });
        match super::tools::execute_tool(
            db_path,
            std::path::Path::new(""),
            "append_evolution",
            &args,
        ) {
            Ok(_) => wrote += 1,
            Err(e) => log::warn!("每周自评写回经验失败（{}）: {}", lesson, e),
        }
    }
    Ok(if wrote == 0 {
        "本周无新经验".to_string()
    } else {
        format!("写回 {} 条弹窗分寸经验", wrote)
    })
}

/// 调度线程：每分钟检查一次
/// - 晨间工作套装/情境联动模式匹配
/// - 分析 slot（analyst.md 时刻表，水位线增量窗口）+ 0 点统一块
///   （recall 兜底 → 日报首跑 → 日记 → 明日关注 → 周日自评，素材归属昨天）
/// - 日报独立重试线（0 点块首跑失败后的保险）
/// - 过期数据清理
pub fn run_scheduler(app_handle: AppHandle, db_path: PathBuf, flags: Arc<RwLock<CompanionFlags>>) {
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
        let yesterday = (now - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();

        if !f.paused {
            if let Err(e) = match_work_suite(&app_handle, &db_path, now.timestamp()) {
                log::warn!("Companion 工作套装匹配失败: {}", e);
            }
            if let Err(e) = match_context_routines(&app_handle, &db_path, now.timestamp()) {
                log::warn!("Companion 情境联动匹配失败: {}", e);
            }
            // 深夜情绪观察：他还在忙时，23 点后记心疼、凌晨记疲惫（内部节流）
            if let Ok(conn) = Connection::open(&db_path) {
                super::emotion::on_late_night(&conn, now.timestamp());
            }
        }

        // ── 分析 slot + 0 点统一块 ──
        // slot 防重：companion_last_analysis_slot（key=YYYY-MM-DD#HH）
        // 链路防重：companion_last_chain_date（每天过 0 点即到期，analyst 手册被禁用也不受影响）
        let slots = analyst_schedule(&app_handle).unwrap_or_default();
        let last_slot = load_setting(&db_path, "companion_last_analysis_slot");
        let due_slot = latest_due_slot(now, &slots).filter(|k| last_slot.as_deref() != Some(k));
        let chain_due =
            load_setting(&db_path, "companion_last_chain_date").as_deref() != Some(&today);

        if due_slot.is_some() || chain_due {
            // 先标记再跑（与既有一致）；日报另有独立的成功后才标记 + 重试线，不受此影响
            if let Some(k) = &due_slot {
                save_setting(&db_path, "companion_last_analysis_slot", k);
            }
            if chain_due {
                save_setting(&db_path, "companion_last_chain_date", &today);
            }
            let app = app_handle.clone();
            let db = db_path.clone();
            let date = yesterday.clone(); // 链路素材归属：昨天（0 点跑时「今天」无数据）
            let run_analysis = due_slot.is_some();
            let daily_report = f.daily_report;
            // agent 调用是阻塞式 subprocess，放独立线程而非 async runtime
            std::thread::spawn(move || {
                // 模式挖掘：水位线增量窗口（内部经 call_companion_llm 路由）
                if run_analysis {
                    match run_daily_analysis_blocking(&app, &db) {
                        Ok(msg) => log::info!("Companion 模式挖掘: {}", msg),
                        Err(e) => log::warn!("Companion 模式挖掘失败: {}", e),
                    }
                }
                if chain_due {
                    // 聊天记忆提取兜底（防抖通道之外的保险，水位已最新则空转）
                    match super::recall::run_recall_blocking(&app, &db) {
                        Ok(msg) => log::info!("Companion 记忆提取兜底: {}", msg),
                        Err(e) => log::warn!("Companion 记忆提取兜底失败: {}", e),
                    }
                    // 日报首跑（昨天）；失败由独立调度线按 REPORT_RETRY_SECS 节流重试
                    // 与重试线互斥：attempt 时间戳新鲜（重试线在途或刚失败）时让位——
                    // app 启动日两条线会同时看到「未完成」，不互斥就重复跑同一份日报
                    let report_done =
                        load_setting(&db, "companion_last_report_date").as_deref() == Some(&date);
                    let last_attempt: i64 = load_setting(&db, "companion_last_report_attempt")
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(0);
                    let attempt_fresh =
                        chrono::Local::now().timestamp() - last_attempt < REPORT_RETRY_SECS;
                    if daily_report && !report_done && !attempt_fresh {
                        run_report_and_mark(&app, &db, &date);
                    }
                    // 情感日记（昨天，私有）与明日关注预规划（面向新一天），失败不阻塞链路
                    match super::diary::run_diary_blocking(&app, &db, &date) {
                        Ok(msg) => log::info!("Companion 情感日记: {}", msg),
                        Err(e) => log::warn!("Companion 情感日记失败: {}", e),
                    }
                    match super::diary::run_focus_blocking(&app, &db, &date) {
                        Ok(msg) => log::info!("Companion 明日关注: {}", msg),
                        Err(e) => log::warn!("Companion 明日关注生成失败: {}", e),
                    }
                    // 每周自评（周日；三期建议反馈闭环）：弹窗处置统计 → 写回「弹窗分寸」
                    if chrono::Local::now().weekday() == chrono::Weekday::Sun {
                        let week_key = chrono::Local::now().format("%G-W%V").to_string();
                        if load_setting(&db, "companion_last_weekly_review_week").as_deref()
                            != Some(week_key.as_str())
                        {
                            save_setting(&db, "companion_last_weekly_review_week", &week_key);
                            match run_weekly_review_blocking(&app, &db) {
                                Ok(msg) => log::info!("Companion 每周自评: {}", msg),
                                Err(e) => log::warn!("Companion 每周自评失败: {}", e),
                            }
                        }
                    }
                }
            });
        }

        // ── 日报独立重试线 ──
        // 首跑归 0 点块；链路今日已跑而日报仍未落盘时，本线才接管（30 分钟节流，
        // 尝试时间戳走 settings 持久化——0 点块在别的线程跑，内存节流状态共享不到）
        let report_done =
            load_setting(&db_path, "companion_last_report_date").as_deref() == Some(&yesterday);
        let chain_ran =
            load_setting(&db_path, "companion_last_chain_date").as_deref() == Some(&today);
        let last_attempt: i64 = load_setting(&db_path, "companion_last_report_attempt")
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let throttle_ok = now.timestamp() - last_attempt >= REPORT_RETRY_SECS;
        // 触发时刻从 reporter.md frontmatter 读（改时间=改文件一行）；
        // 手册被 enabled:false 禁用时不调度；文件丢失回退内置 00:00（手册丢了日报不能丢）
        let report_due = reporter_schedule(&app_handle)
            .map(|(h, m)| now.hour() > h || (now.hour() == h && now.minute() >= m))
            .unwrap_or(false);
        // 日报开关关闭时跳过日报调度（分析与记忆提取不受影响）
        if report_due && !report_done && chain_ran && throttle_ok && f.daily_report {
            let app = app_handle.clone();
            let db = db_path.clone();
            let date = yesterday.clone();
            std::thread::spawn(move || run_report_and_mark(&app, &db, &date));
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
                // 情绪 housekeeping：纪念日（踏实）+ 过期条目清理
                super::emotion::on_milestone(&conn, now.timestamp());
                let _ = super::emotion::cleanup(&conn, now.timestamp());
            }
        }
    }
}

// ── 日报执行与完成标记（0 点块首跑与独立重试线共用）─────────────────────

/// 跑日报并按结果标记完成：笔记真的落盘或明确「当日无数据」才写
/// companion_last_report_date（用户删掉笔记不会重生成——标记仍在）。
/// 尝试时间戳持久化到 settings，供独立重试线跨线程节流。
fn run_report_and_mark(app: &AppHandle, db: &PathBuf, date: &str) {
    save_setting(
        db,
        "companion_last_report_attempt",
        &chrono::Local::now().timestamp().to_string(),
    );
    let cc_enabled = super::claude_code_enabled(app);
    match run_report_with_fallback(app, db, date, cc_enabled) {
        Ok(msg) => {
            let note_written = crate::notes::get_default_notes_dir()
                .map(|d| {
                    d.join(super::mcp::NOTE_DIR_PREFIX)
                        .join(format!("{}.md", date))
                        .exists()
                })
                .unwrap_or(false);
            if note_written || msg.contains("无数据") {
                save_setting(db, "companion_last_report_date", date);
                if let Ok(conn) = Connection::open(db) {
                    super::emotion::on_report_done(&conn, date, chrono::Local::now().timestamp());
                }
                log::info!("Companion 日报完成: {}", msg);
            } else {
                log::warn!("Companion 日报返回成功但笔记未落盘，稍后重试: {}", msg);
            }
        }
        Err(e) => log::warn!("Companion 日报失败（30 分钟后重试）: {}", e),
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
            suggester::TYPE_AUTO_EXECUTED,
            auto_title,
            Some(&body),
            None,
        ) {
            let _ = db::link_suggestion_pattern(conn, sid, pattern.id);
        }
        log::info!(
            "pattern #{} 毕业（接受 {} 次），自动执行",
            pattern.id,
            accepted
        );
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
        match graduation_gate(
            &conn,
            app_handle,
            &pattern,
            &launchable,
            "已为你启动工作模式",
            now_ts,
        ) {
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
        if totals
            .iter()
            .any(|(p, _)| p.eq_ignore_ascii_case(&data.app))
        {
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

/// 分析「上次水位到现在」的活动流水（增量窗口），挖掘习惯模式写入 habit_patterns。
/// 水位线 companion_last_analysis_ts 缺失时初始化为昨天 0 点（与旧「昨日全天」机制衔接，
/// 昨晚没跑过旧机制的话昨天的数据也不漏）。数据不足（<10 条）跳过且不推进水位——
/// 攒到下一 slot 一起分析；水位仅在成功落库后推进。
pub async fn run_daily_analysis(
    app_handle: &AppHandle,
    db_path: &PathBuf,
) -> Result<String, String> {
    let conn = Connection::open(db_path).map_err(|e| format!("打开数据库失败: {}", e))?;

    let now = chrono::Local::now();
    let now_ts = now.timestamp();
    let today_start = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|d| d.and_local_timezone(chrono::Local).single())
        .ok_or("无法计算当日起点")?
        .timestamp();
    let start = load_setting(db_path, "companion_last_analysis_ts")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(today_start - 86400)
        // 水位线异常（未来时间/过旧）兜底：最多回看 7 天，防一次巨型窗口
        .clamp(now_ts - ANALYSIS_MAX_LOOKBACK_SECS, now_ts);

    let activities =
        db::activities_between(&conn, start, now_ts).map_err(|e| format!("读取活动失败: {}", e))?;

    if activities.len() < 10 {
        return Ok(format!(
            "水位以来活动仅 {} 条，数据不足，跳过分析（水位不推进）",
            activities.len()
        ));
    }

    // 本地预聚合：原始流水可能有上千条，先压缩成会话级摘要再送 LLM
    // 跨天窗口按天分节（只有 HH:MM 时分不清是哪天），文本上限随天数放大
    let multi_day = fmt_local(start, "%Y-%m-%d") != fmt_local(now_ts - 1, "%Y-%m-%d");
    let day_count = ((now_ts - start + 86399) / 86400).clamp(1, 7) as usize;
    // 应用标注映射（exe 文件名 → (显示名, 描述)），命中则随进程名拼给 LLM
    let app_labels = crate::db::app_cache::app_label_map(&conn).unwrap_or_default();
    let aggregate_text =
        aggregate_activities(&activities, multi_day, AGGREGATE_TEXT_CAP * day_count, &app_labels);
    let window_label = format!(
        "{} ~ {}",
        fmt_local(start, "%Y-%m-%d %H:%M"),
        fmt_local(now_ts, "%Y-%m-%d %H:%M")
    );
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
        .map(|dir| super::skills::load_skill_body(dir, "analyst"))
        .unwrap_or_default();
    let ve_section = voice_expectation_section(&conn);
    // 已有记忆进 prompt（与 recall 同一渲染）：看不到已有条目就只能不停 add 近义新条
    let existing_facts = super::recall::load_existing_facts(&conn);
    let facts_section = format!(
        "\n\n---\n\n# 已有记忆\n{}",
        super::recall::format_facts_with_ids(&existing_facts)
    );
    let prompt = build_analysis_prompt(
        &persona,
        &evolution,
        &role,
        &window_label,
        &aggregate_text,
        &ve_section,
        &facts_section,
    );

    let reply = call_companion_llm(app_handle, db_path, prompt, "analysis").await?;
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

    // 沉淀个人事实（记忆层）：与 recall 同一套 add/update 语义——
    // target_id 对得上已有记忆才覆盖更新，否则降级为 add（宁多记不丢记）
    let known: std::collections::HashSet<i64> = existing_facts.iter().map(|f| f.id).collect();
    let mut facts_saved = 0;
    let mut facts_updated = 0;
    for f in &parsed.facts {
        let fact = f.fact.trim();
        if fact.is_empty() {
            continue;
        }
        match f.action.as_str() {
            "update" if f.target_id.map(|t| known.contains(&t)).unwrap_or(false) => {
                db::update_memory_fact(
                    &conn,
                    f.target_id.unwrap(),
                    fact,
                    &f.category,
                    "daily_analysis",
                    now_ts,
                )
                .map_err(|e| format!("更新记忆失败: {}", e))?;
                facts_updated += 1;
            }
            _ => {
                db::upsert_memory_fact(&conn, fact, &f.category, "daily_analysis", now_ts)
                    .map_err(|e| format!("保存事实失败: {}", e))?;
                facts_saved += 1;
            }
        }
    }

    // 应用描述回填：模型对摘要中出现、拼接时描述为空的进程给出描述。
    // 只填 description = '' 的行（fill_empty_descriptions 条件约束），
    // 期间用户手动标过的不会被覆盖。
    let mut desc_saved = 0;
    for d in &parsed.app_descriptions {
        match crate::db::app_cache::fill_empty_descriptions(
            &conn,
            d.app.trim(),
            d.description.trim(),
        ) {
            Ok(n) => desc_saved += n,
            Err(e) => log::warn!("应用描述回填失败 {}: {}", d.app, e),
        }
    }

    // 成功落库后推进水位（失败/数据不足都不推进，下次窗口自动顺延合并）
    save_setting(db_path, "companion_last_analysis_ts", &now_ts.to_string());

    // 未知应用提醒：模型回填后仍不认识 → 引导用户去设置页标注
    let reminded = remind_unknown_apps(&conn, app_handle, &activities, &now);

    Ok(format!(
        "窗口 {}：{} 条活动 → 聚合 {} 字符 → {} 个模式 + 事实新增 {} / 更新 {} + 描述回填 {} + 未知应用提醒 {}",
        window_label,
        activities.len(),
        aggregate_text.len(),
        saved,
        facts_saved,
        facts_updated,
        desc_saved,
        reminded
    ))
}

/// 进程名带标注（exe 文件名小写 → (显示名, 描述) 映射，来自 app_cache）。
/// 拼接规则：有 name 有描述 → `proc（name / 描述）`；只有 name → `proc（name）`；
/// name 与进程名雷同（如 name 就是 "Code.exe"）跳过；都没有 → 原样进程名。
fn proc_label(proc: &str, labels: &std::collections::HashMap<String, (String, String)>) -> String {
    let Some((name, desc)) = labels.get(&proc.to_lowercase()) else {
        return proc.to_string();
    };
    let name = name.trim();
    let desc = desc.trim();
    let name_part = if !name.is_empty() && !proc.eq_ignore_ascii_case(name) {
        Some(name)
    } else {
        None
    };
    match (name_part, desc) {
        (Some(n), d) if !d.is_empty() => format!("{}（{} / {}）", proc, n, d),
        (Some(n), _) => format!("{}（{}）", proc, n),
        (None, d) if !d.is_empty() => format!("{}（{}）", proc, d),
        (None, _) => proc.to_string(),
    }
}

/// 未知应用提醒：本次窗口出现过 + 模型回填后描述仍为空 + 未提醒过 →
/// 动作型建议「去标注」；单轮最多 REMIND_LIMIT 个，先打标防重复。
/// 深夜轮（凌晨 3 点前，含 0 点 slot 及其补跑）只落建议中心不弹窗。
fn remind_unknown_apps(
    conn: &Connection,
    app_handle: &AppHandle,
    activities: &[ActivityLog],
    now: &chrono::DateTime<chrono::Local>,
) -> usize {
    const REMIND_LIMIT: usize = 2;

    // 摘要中出现过的进程（进程时长 Top 区覆盖全部出现进程，去重即可）
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for a in activities {
        seen.insert(a.process_name.clone());
    }

    let silent = now.hour() < CLEANUP_HOUR;
    let mut reminded = 0;
    for proc in seen {
        if reminded >= REMIND_LIMIT {
            break;
        }
        if proc.is_empty() || proc.eq_ignore_ascii_case("unknown") {
            continue;
        }
        let all_empty = crate::db::app_cache::process_all_descriptions_empty(conn, &proc)
            .unwrap_or(false);
        let all_reminded =
            crate::db::app_cache::process_all_reminded(conn, &proc).unwrap_or(true); // 查询失败视为已提醒，别打扰
        if !all_empty || all_reminded {
            continue;
        }
        // 先打标再推送（防并发/重试重复弹）
        if let Err(e) = crate::db::app_cache::mark_process_reminded(conn, &proc) {
            log::warn!("标记应用提醒失败 {}: {}", proc, e);
            continue;
        }
        let payload = serde_json::json!({
            "action": "open_apps_tab",
            "process_name": proc,
        })
        .to_string();
        let body =
            "我不认识这个应用。去设置页「应用」给它填一句描述，我就能更懂你的使用习惯了。";
        let result = if silent {
            suggester::push_suggestion_silent(
                conn,
                suggester::TYPE_APP_UNKNOWN,
                &format!("「{}」是做什么的？", proc),
                Some(body),
                Some(&payload),
            )
        } else {
            suggester::push_suggestion(
                conn,
                app_handle,
                suggester::TYPE_APP_UNKNOWN,
                &format!("「{}」是做什么的？", proc),
                Some(body),
                Some(&payload),
            )
        };
        match result {
            Ok(_) => reminded += 1,
            Err(e) => log::warn!("未知应用建议创建失败 {}: {}", proc, e),
        }
    }
    reminded
}

/// 把原始活动流水压缩成会话级摘要文本
pub(crate) fn aggregate_activities(
    activities: &[ActivityLog],
    multi_day: bool,
    text_cap: usize,
    labels: &std::collections::HashMap<String, (String, String)>,
) -> String {
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
        text.push_str(&format!("- {} {:.1}h\n", proc_label(proc, labels), *secs as f64 / 3600.0));
    }

    text.push_str("\n【时间线】\n");
    let mut current_day = String::new();
    for s in &sessions {
        // 短于 60s 的会话视为路过，不进时间线
        if s.end - s.start < 60 {
            continue;
        }
        // 跨天查询按天分节，只有 HH:MM 时分不清是哪天
        if multi_day {
            let day = fmt_local(s.start, "%m-%d");
            if day != current_day {
                text.push_str(&format!("【{}】\n", day));
                current_day = day;
            }
        }
        let title: String = s.title.chars().take(40).collect();
        text.push_str(&format!(
            "{}-{} {}「{}」\n",
            fmt_hm(s.start),
            fmt_hm(s.end),
            proc_label(&s.process, labels),
            title
        ));
        if text.len() > text_cap {
            text.push_str("...(截断)\n");
            break;
        }
    }

    text
}

fn fmt_hm(ts: i64) -> String {
    fmt_local(ts, "%H:%M")
}

fn fmt_local(ts: i64, fmt: &str) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|utc| utc.with_timezone(&chrono::Local).format(fmt).to_string())
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

    let app_labels = crate::db::app_cache::app_label_map(conn).unwrap_or_default();
    Ok(format!(
        "【{} 活动聚合，共 {} 段】\n{}",
        day_label,
        activities.len(),
        aggregate_activities(&activities, false, AGGREGATE_TEXT_CAP, &app_labels)
    ))
}

/// 解析工具传入的时间参数，支持两种格式：
/// - 「YYYY-MM-DD」：is_end=false 取当天 00:00，is_end=true 取次日 00:00（即当天结束）
/// - 「YYYY-MM-DD HH:MM」：取该时刻
///
/// 返回本地时区时间戳；格式非法时返回错误文本，让模型自我纠正。
pub(crate) fn parse_flexible_datetime(s: &str, is_end: bool) -> Result<i64, String> {
    let s = s.trim();
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M") {
        return dt
            .and_local_timezone(chrono::Local)
            .single()
            .map(|d| d.timestamp())
            .ok_or_else(|| format!("无法换算本地时间: {}", s));
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        let d = if is_end {
            d + chrono::Duration::days(1)
        } else {
            d
        };
        return d
            .and_hms_opt(0, 0, 0)
            .and_then(|t| t.and_local_timezone(chrono::Local).single())
            .map(|t| t.timestamp())
            .ok_or_else(|| format!("无法换算本地时间: {}", s));
    }
    Err(format!(
        "时间格式错误（应为 YYYY-MM-DD 或 YYYY-MM-DD HH:MM）: {}",
        s
    ))
}

/// 聚合任意时间窗的活动为摘要文本（供 MCP 工具 get_activity_summary 使用）。
/// 跨天时时间线按天分节；文本上限随天数放大，封顶 7 天份。
pub(crate) fn aggregate_range(conn: &Connection, start: i64, end: i64) -> Result<String, String> {
    let label = format!(
        "{} ~ {}",
        fmt_local(start, "%Y-%m-%d %H:%M"),
        fmt_local(end, "%Y-%m-%d %H:%M")
    );

    let activities =
        db::activities_between(conn, start, end).map_err(|e| format!("读取活动失败: {}", e))?;

    if activities.is_empty() {
        return Ok(format!("{} 没有采集到活动记录", label));
    }

    // 起止落在不同本地日期才算跨天（「昨天 23:00 ~ 今天 01:00」不足 24h 也是跨天）
    let multi_day = fmt_local(start, "%Y-%m-%d") != fmt_local(end - 1, "%Y-%m-%d");
    let day_count = ((end - start + 86399) / 86400).clamp(1, 7) as usize;

    let app_labels = crate::db::app_cache::app_label_map(conn).unwrap_or_default();
    Ok(format!(
        "【{} 活动聚合，共 {} 段】\n{}",
        label,
        activities.len(),
        aggregate_activities(&activities, multi_day, AGGREGATE_TEXT_CAP * day_count, &app_labels)
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
    window_label: &str,
    aggregate_text: &str,
    ve_section: &str,
    facts_section: &str,
) -> String {
    format!(
        "{persona}\n\n---\n\n{evolution}\n\n---\n\n{role}{facts_section}\n\n---\n\n\
         以上是贾维斯的身份设定、经验本、分析工作手册与已有记忆。\n\
         以下是他在 {window_label} 时段电脑使用情况的聚合摘要（进程名 + 窗口标题 + 时段）：\n\n{aggregate_text}{ve_section}",
        persona = persona,
        evolution = evolution,
        role = role,
        facts_section = facts_section,
        window_label = window_label,
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
    #[serde(default)]
    app_descriptions: Vec<LlmAppDescription>,
}

/// 模型回填的应用描述（app 必须用摘要中的进程名原文）
#[derive(Debug, Deserialize)]
struct LlmAppDescription {
    #[serde(default)]
    app: String,
    #[serde(default)]
    description: String,
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
    #[serde(default = "default_fact_action")]
    action: String,
    fact: String,
    #[serde(default = "default_fact_category")]
    category: String,
    #[serde(default)]
    target_id: Option<i64>,
}

fn default_fact_action() -> String {
    "add".to_string()
}

fn default_fact_category() -> String {
    "person".to_string()
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

    // 应用描述回填：app 非空、描述非空且 <= 50 字、不与进程名雷同（防垃圾输出）
    // 「不能瞎猜」由提示词约束，这里只做格式兜底，不评判内容对错
    parsed.app_descriptions.retain(|d| {
        let app = d.app.trim();
        let desc = d.description.trim();
        !app.is_empty()
            && !desc.is_empty()
            && desc.chars().count() <= 50
            && !app.eq_ignore_ascii_case(desc)
    });
    parsed.app_descriptions.truncate(10);

    Ok(parsed)
}

// ── 备忘解析（触发器 + 重构正文）──────────────────────────────

/// 解析结果：重构正文（展示面）+ 触发器（情境匹配索引）
pub struct ParsedMemo {
    pub refined: Option<String>,
    pub triggers: db::IntentTriggers,
}

/// 解析备忘并写回数据库（创建和重试共用的完整链路）。
/// 无论有没有触发器都写回——重构正文本身就是产出；解析失败正文兜底原文。
pub async fn parse_and_store_triggers(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    memo_id: i64,
    text: &str,
) -> Result<(), String> {
    let parsed = parse_memo(app_handle, db_path, text).await?;
    let refined = parsed
        .refined
        .filter(|r| !r.trim().is_empty())
        .unwrap_or_else(|| text.to_string());
    let t = &parsed.triggers;
    let has_triggers = t.due.is_some() || t.person.is_some() || !t.keywords.is_empty();
    let json = if has_triggers {
        Some(serde_json::to_string(t).map_err(|e| e.to_string())?)
    } else {
        None
    };
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    db::update_memo_parse(&conn, memo_id, &refined, json.as_deref(), t.due.as_deref())
        .map_err(|e| format!("写回解析结果失败: {}", e))?;
    log::info!("备忘 #{} 解析成功", memo_id);
    Ok(())
}

/// 用 LLM 解析备忘原文：重构正文（剥时间词/元话、保留人物）+ 触发条件。
/// 失败不致命——调用方保留原文，靠晨间汇总兜底。
/// prompt 注入记忆层事实（如"刘光俊=前端同事"），让解析更懂用户语境。
pub async fn parse_memo(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    text: &str,
) -> Result<ParsedMemo, String> {
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
        "分析下面这条快速记下的备忘，输出重构正文和触发条件。\n\
         只输出 JSON，不要任何其他文字。格式：\n\
         {{\"refined\":\"重构后的备忘正文\",\"due\":\"YYYY-MM-DD 或 null\",\"person\":\"联系人名 或 null\",\"channel\":\"沟通渠道（微信/钉钉/飞书/QQ 等）或 null\",\"keywords\":[\"窗口标题里可能出现的关键词，最多3个\"]}}\n\
         重构规则（refined）：\n\
         1. 用户是快速输入，正文要重构成「要做的事」的最小完整表述：动词+对象+事项。\n\
         2. 删掉时间词（明天/周五/下午等，已进 due）、删掉「提醒我/记得/需要」这类元话。\n\
         3. 保留人物和具体事项——「报价单发了吗」这种剥到看不懂是禁止的。\n\
         4. 例：「明天下午提醒我问张三报价单发了吗」→「问张三报价单发了吗」。原文已足够精炼则原样保留。\n\
         触发规则：\n\
         1. 今天是 {today}。\"明天\"=\"今天+1天\"，\"周五\"=最近的周五，\"下周X\"=下周的星期X。没有明确时间则 due 为 null。\n\
         2. person 只提取明确的人名/称呼（如\"张三\"\"前端小李\"），没有则为 null。\n\
         3. channel 只在明确提到沟通软件时填写。\n\
         4. keywords 提取能识别相关应用/项目/事项的实词（如项目名、\"接口文档\"），不要虚词。没有合适的关键词就给空数组。{facts_context}\n\
         原话：「{text}」",
        today = today,
        facts_context = facts_context,
        text = text
    );

    let reply = call_companion_llm(app_handle, db_path, prompt, "intent_parse").await?;

    let start = reply.find('{').ok_or("解析响应中没有 JSON")?;
    let end = reply.rfind('}').ok_or("解析响应中没有 JSON")?;
    let mut parsed: ParsedMemoJson = serde_json::from_str(&reply[start..=end])
        .map_err(|e| format!("解析备忘 JSON 失败: {}", e))?;

    // 校验 due 格式，非法则丢弃（不影响其他字段）
    if let Some(due) = &parsed.triggers.due {
        if chrono::NaiveDate::parse_from_str(due, "%Y-%m-%d").is_err() {
            parsed.triggers.due = None;
        }
    }
    // 清理空串和无效关键词
    parsed.triggers.person = parsed.triggers.person.filter(|p| !p.trim().is_empty());
    parsed.triggers.channel = parsed.triggers.channel.filter(|c| !c.trim().is_empty());
    parsed.triggers.keywords.retain(|k| !k.trim().is_empty());
    parsed.triggers.keywords.truncate(3);
    // refined 与原文逐字相同则视为无重构（省一次无意义写回的判断留给调用方，这里只归一化）
    parsed.refined = parsed.refined.map(|r| r.trim().to_string());

    Ok(ParsedMemo {
        refined: parsed.refined,
        triggers: parsed.triggers,
    })
}

#[derive(Debug, Deserialize)]
struct ParsedMemoJson {
    #[serde(default)]
    refined: Option<String>,
    #[serde(flatten)]
    triggers: db::IntentTriggers,
}

/// 日报执行（含降级）：CC 开启走 agent，agent 失败就地回退场景模型版——
/// 降级 = 质量下降（无工具、单次成文），不是当天缺报（#4）。
fn run_report_with_fallback(
    app: &AppHandle,
    db: &PathBuf,
    date: &str,
    cc_enabled: bool,
) -> Result<String, String> {
    if cc_enabled {
        match super::run_agent_with_settings(app, db, date) {
            Ok(msg) => return Ok(msg),
            Err(agent_err) => {
                log::warn!("日报 agent 失败，回退场景模型版: {}", agent_err);
            }
        }
    }
    match crate::notes::get_default_notes_dir() {
        Ok(notes_dir) => {
            tauri::async_runtime::block_on(run_scene_report(app, db, &notes_dir, date))
        }
        Err(e) => Err(format!("获取笔记目录失败: {}", e)),
    }
}

/// 场景模型版日报（Claude Code 未开启时的回退）：
/// 数据本地预聚合后内联给模型，单次调用成文，不经 agent/MCP。
/// 调用方需放在 blocking 线程（内部 LLM 路由与文件写入为阻塞操作）。
pub(crate) async fn run_scene_report(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    notes_dir: &Path,
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
    let role = super::skills::load_skill_body(&app_data, "reporter");
    let ve_section = voice_expectation_section(&conn);
    let now_ts = chrono::Local::now().timestamp();
    let state_text = super::state::current_state_sentence(&conn, now_ts);
    let emotion = super::emotion::render_current(&conn, now_ts);
    let emotion_section = if emotion.is_empty() {
        String::new()
    } else {
        format!("\n\n---\n\n# 你此刻的心情\n{}", emotion)
    };
    let prompt = format!(
        "{persona}\n\n---\n\n{evolution}\n\n---\n\n{role}\n\n---\n\n\
         以上是贾维斯的身份设定、经验本与日报工作手册。\n\
         注意：你现在没有数据工具——他昨天的电脑使用聚合已直接给你（见末尾），\n\
         跳过流程中的工具调用步骤，直接完成「写日报」那一步。\n\
         如果内容显示没有活动记录，只回复「当日无数据」。\n\n{aggregate}{ve_section}\n\n---\n\n# 当下状态\n{state_text}{emotion_section}"
    );

    let report = call_companion_llm(app_handle, db_path, prompt, "report").await?;
    if report.contains("当日无数据") {
        return Ok("当日无数据，未生成日报".to_string());
    }

    let relative = format!("{}/{}.md", super::mcp::NOTE_DIR_PREFIX, date);
    let manager = crate::notes::NotesManager::new(notes_dir.to_path_buf());
    manager
        .write_note(&relative, &report)
        .map_err(|e| format!("写入笔记失败: {}", e))?;

    if let Ok(conn2) = Connection::open(db_path) {
        let preview: String = report.chars().take(200).collect();
        let _ = super::suggester::push_suggestion(
            &conn2,
            app_handle,
            super::suggester::TYPE_DAILY_REPORT,
            &format!("{} 日报已生成", date),
            Some(&preview),
            None,
        );
    }
    Ok(format!("日报已生成（场景模型）: {}", relative))
}

/// 陪伴统一 LLM 路由（陪伴场景）:全局 Claude Code 开启 → claude CLI 单次问答
/// （失败自动回退场景模型）；未开启 → 直接用场景模型。
/// `source` 为观测来源标记（analysis/report/recall/diary/intent_parse…），
/// 所有调用统一登记 llm_call_logs（原则：新增调用点必须带着观测出生）。
pub(crate) async fn call_companion_llm(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    prompt: String,
    source: &str,
) -> Result<String, String> {
    call_llm_with_scene(app_handle, db_path, prompt, Scene::Companion, source).await
}

/// 带场景的 LLM 路由：记忆提取等场景有独立模型配置（缺省回退陪伴场景）。
pub(crate) async fn call_llm_with_scene(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    prompt: String,
    scene: Scene,
    source: &str,
) -> Result<String, String> {
    crate::llm::log_prompt(source, &prompt);
    if super::claude_code_enabled(app_handle) {
        let started = std::time::Instant::now();
        let cc_result = run_claude_code_oneshot(app_handle, &prompt).await;
        let duration_ms = started.elapsed().as_millis() as u64;
        match cc_result {
            Ok(reply) => {
                // CC 通道（订阅制）不记成本，只统计 token
                crate::llm::observe::log_call(
                    db_path,
                    &crate::llm::observe::LlmCallEntry {
                        source,
                        channel: "claude_code",
                        scene: None,
                        model: None,
                        input_tokens: reply.input_tokens,
                        cached_input_tokens: reply.cached_input_tokens,
                        output_tokens: reply.output_tokens,
                        cost_cny: 0.0,
                        duration_ms,
                        tool_call_count: 0,
                        status: "ok",
                        error: None,
                    },
                );
                return Ok(reply.text);
            }
            Err(cc_err) => {
                // CC 失败也登记——「Claude Code 挂了多少次」在面板可见
                crate::llm::observe::log_call(
                    db_path,
                    &crate::llm::observe::LlmCallEntry {
                        source,
                        channel: "claude_code",
                        scene: None,
                        model: None,
                        input_tokens: 0,
                        cached_input_tokens: 0,
                        output_tokens: 0,
                        cost_cny: 0.0,
                        duration_ms,
                        tool_call_count: 0,
                        status: "error",
                        error: Some(&cc_err),
                    },
                );
                log::warn!("Claude Code 调用失败，回退场景模型: {}", cc_err);
                return call_scene_model_llm(app_handle, db_path, prompt, scene, source)
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

    call_scene_model_llm(app_handle, db_path, prompt, scene, source).await
}

/// 在 blocking 线程里跑 claude CLI 单次问答（子进程是阻塞 IO，不能占 async runtime）
async fn run_claude_code_oneshot(
    app_handle: &AppHandle,
    prompt: &str,
) -> Result<super::agent::OneshotReply, String> {
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

/// 解析场景模型配置：provider + model + thinking_mode + 解密后的 api_key + 实际场景。
/// 非陪伴场景未单独配置时回退陪伴场景配置（缺省跟随，用户可在模型设置里改绑）。
pub(crate) fn resolve_scene_provider(
    app_handle: &AppHandle,
    conn: &Connection,
    scene: Scene,
) -> Result<
    (
        crate::llm_provider::models::Provider,
        crate::llm_provider::models::Model,
        bool,
        String,
        String,
        Scene,
    ),
    String,
> {
    let provider_db = LlmProviderDb;
    let resolved = provider_db
        .get_scene_model(conn, scene.clone())
        .map_err(|e| format!("获取场景模型失败: {}", e))?
        .map(|(p, m)| (p, m, scene.clone()))
        .or_else(|| {
            if scene == Scene::Companion {
                return None;
            }
            log::info!("场景 {} 未配置模型，回退陪伴场景", scene);
            provider_db
                .get_scene_model(conn, Scene::Companion)
                .ok()
                .flatten()
                .map(|(p, m)| (p, m, Scene::Companion))
        });
    let (provider, model, used_scene) = resolved.ok_or_else(|| {
        "尚未配置 AI 模型，请先在「设置 → AI 模型」中为陪伴场景选择模型".to_string()
    })?;

    let thinking_mode = provider_db
        .get_scene_thinking_mode(conn, used_scene.clone())
        .unwrap_or(false);

    let reasoning_effort = provider_db
        .get_scene_reasoning_effort(conn, used_scene.clone())
        .unwrap_or_else(|_| "medium".to_string());

    let api_key = match &provider.api_key_encrypted {
        Some(encrypted) if !encrypted.is_empty() => {
            let app_data_dir = app_handle.path().app_data_dir().unwrap_or_default();
            decrypt(encrypted, &app_data_dir).map_err(|e| format!("解密 API Key 失败: {}", e))?
        }
        _ => String::new(),
    };

    Ok((provider, model, thinking_mode, reasoning_effort, api_key, used_scene))
}

/// 按场景配置调用场景模型。非陪伴场景未单独配置时，
/// 回退陪伴场景配置（缺省跟随，用户可在模型设置里改绑）。
/// 调用结果（含 token 计量与单价估算）统一登记 llm_call_logs。
pub(crate) async fn call_scene_model_llm(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    prompt: String,
    scene: Scene,
    source: &str,
) -> Result<String, String> {
    let started = std::time::Instant::now();
    let conn = Connection::open(db_path).map_err(|e| format!("打开数据库失败: {}", e))?;

    let (provider, model, thinking_mode, reasoning_effort, api_key, used_scene) =
        resolve_scene_provider(app_handle, &conn, scene)?;

    let messages = vec![ChatMessage {
        role: "user".to_string(),
        content: prompt,
        images: None,
    }];

    let scene_str = used_scene.to_string();
    let result = crate::llm::call_llm(
        &provider.base_url,
        &api_key,
        &model.model_id,
        &provider.provider_type.to_string(),
        messages,
        thinking_mode,
        &reasoning_effort,
    )
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(reply) => {
            // 单价为可选配置：填了才估算金额，未填 cost 记 0（面板只显示 token）
            let cost = reply.input_tokens.saturating_sub(reply.cached_input_tokens) as f64
                / 1e6 * model.input_price_per_m.unwrap_or(0.0)
                + reply.cached_input_tokens as f64 / 1e6
                    * model.cached_input_price_per_m.unwrap_or(0.0)
                + reply.output_tokens as f64 / 1e6 * model.output_price_per_m.unwrap_or(0.0);
            crate::llm::observe::log_call(
                db_path,
                &crate::llm::observe::LlmCallEntry {
                    source,
                    channel: "scene_model",
                    scene: Some(&scene_str),
                    model: Some(&model.model_id),
                    input_tokens: reply.input_tokens,
                    cached_input_tokens: reply.cached_input_tokens,
                    output_tokens: reply.output_tokens,
                    cost_cny: cost,
                    duration_ms,
                    tool_call_count: 0,
                    status: "ok",
                    error: None,
                },
            );
            Ok(reply.content)
        }
        Err(e) => {
            crate::llm::observe::log_call(
                db_path,
                &crate::llm::observe::LlmCallEntry {
                    source,
                    channel: "scene_model",
                    scene: Some(&scene_str),
                    model: Some(&model.model_id),
                    input_tokens: 0,
                    cached_input_tokens: 0,
                    output_tokens: 0,
                    cost_cny: 0.0,
                    duration_ms,
                    tool_call_count: 0,
                    status: "error",
                    error: Some(&e),
                },
            );
            Err(e)
        }
    }
}

/// 按场景配置调用场景模型（流式收集版）：长文本生成（如 AI 排版）走流式接口，
/// 规避非流式在长生成时响应体被服务端/代理截断的问题。观测登记同 call_scene_model_llm；
/// 流式响应不携带 usage，token 计量记 0。
pub(crate) async fn call_scene_model_llm_stream(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    prompt: String,
    scene: Scene,
    source: &str,
) -> Result<String, String> {
    let started = std::time::Instant::now();
    let conn = Connection::open(db_path).map_err(|e| format!("打开数据库失败: {}", e))?;

    let (provider, model, thinking_mode, reasoning_effort, api_key, used_scene) =
        resolve_scene_provider(app_handle, &conn, scene)?;

    let messages = vec![serde_json::json!({
        "role": "user",
        "content": prompt,
    })];

    let scene_str = used_scene.to_string();
    let result = crate::llm::call_llm_stream_collect(
        &provider.base_url,
        &api_key,
        &model.model_id,
        &provider.provider_type.to_string(),
        messages,
        thinking_mode,
        &reasoning_effort,
        std::time::Duration::from_secs(300),
    )
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(content) => {
            crate::llm::observe::log_call(
                db_path,
                &crate::llm::observe::LlmCallEntry {
                    source,
                    channel: "scene_model",
                    scene: Some(&scene_str),
                    model: Some(&model.model_id),
                    input_tokens: 0,
                    cached_input_tokens: 0,
                    output_tokens: 0,
                    cost_cny: 0.0,
                    duration_ms,
                    tool_call_count: 0,
                    status: "ok",
                    error: None,
                },
            );
            Ok(content)
        }
        Err(e) => {
            crate::llm::observe::log_call(
                db_path,
                &crate::llm::observe::LlmCallEntry {
                    source,
                    channel: "scene_model",
                    scene: Some(&scene_str),
                    model: Some(&model.model_id),
                    input_tokens: 0,
                    cached_input_tokens: 0,
                    output_tokens: 0,
                    cost_cny: 0.0,
                    duration_ms,
                    tool_call_count: 0,
                    status: "error",
                    error: Some(&e),
                },
            );
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_dt(s: &str) -> chrono::DateTime<chrono::Local> {
        let ts = parse_flexible_datetime(s, false).unwrap();
        chrono::DateTime::from_timestamp(ts, 0)
            .unwrap()
            .with_timezone(&chrono::Local)
    }

    #[test]
    fn latest_slot_picks_today_when_passed() {
        let now = local_dt("2026-07-31 15:00");
        let slots = [(9, 0), (14, 0), (18, 0), (0, 0)];
        assert_eq!(
            latest_due_slot(now, &slots),
            Some("2026-07-31#14".to_string())
        );
    }

    #[test]
    fn latest_slot_after_midnight_is_zero() {
        let now = local_dt("2026-08-01 00:30");
        let slots = [(9, 0), (14, 0), (18, 0), (0, 0)];
        assert_eq!(
            latest_due_slot(now, &slots),
            Some("2026-08-01#00".to_string())
        );
    }

    #[test]
    fn latest_slot_morning_falls_back_to_yesterday_evening() {
        let now = local_dt("2026-08-01 08:00");
        // 含 0 点 slot 时：今天 #00 已到点
        let slots = [(9, 0), (14, 0), (18, 0), (0, 0)];
        assert_eq!(
            latest_due_slot(now, &slots),
            Some("2026-08-01#00".to_string())
        );
        // 不含 0 点 slot 时：回退昨天最晚的 #18
        let slots_no_zero = [(9, 0), (14, 0), (18, 0)];
        assert_eq!(
            latest_due_slot(now, &slots_no_zero),
            Some("2026-07-31#18".to_string())
        );
    }

    #[test]
    fn latest_slot_at_exact_slot_time() {
        let now = local_dt("2026-07-31 09:00");
        let slots = [(9, 0), (14, 0)];
        assert_eq!(
            latest_due_slot(now, &slots),
            Some("2026-07-31#09".to_string())
        );
    }

    #[test]
    fn latest_slot_empty_table() {
        let now = local_dt("2026-07-31 15:00");
        assert_eq!(latest_due_slot(now, &[]), None);
    }

    fn log(id: i64, process: &str, start: i64, secs: i64) -> ActivityLog {
        ActivityLog {
            id,
            process_name: process.to_string(),
            window_title: "窗口".to_string(),
            started_at: start,
            ended_at: Some(start + secs),
            duration_secs: Some(secs),
        }
    }

    #[test]
    fn parse_date_as_start_is_midnight() {
        let ts = parse_flexible_datetime("2026-07-29", false).unwrap();
        assert_eq!(fmt_local(ts, "%Y-%m-%d %H:%M"), "2026-07-29 00:00");
    }

    #[test]
    fn parse_date_as_end_is_next_midnight() {
        let ts = parse_flexible_datetime("2026-07-29", true).unwrap();
        assert_eq!(fmt_local(ts, "%Y-%m-%d %H:%M"), "2026-07-30 00:00");
    }

    #[test]
    fn parse_datetime_with_minutes() {
        let ts = parse_flexible_datetime("2026-07-29 14:30", false).unwrap();
        assert_eq!(fmt_local(ts, "%Y-%m-%d %H:%M"), "2026-07-29 14:30");
    }

    #[test]
    fn parse_rejects_invalid_input() {
        assert!(parse_flexible_datetime("昨天下午", false).is_err());
        assert!(parse_flexible_datetime("2026-07-29 25:00", false).is_err());
        assert!(parse_flexible_datetime("2026-13-01", false).is_err());
    }

    #[test]
    fn timeline_groups_by_day_when_multi_day() {
        let d1 = parse_flexible_datetime("2026-07-28 23:00", false).unwrap();
        let d2 = parse_flexible_datetime("2026-07-29 09:00", false).unwrap();
        let acts = vec![log(1, "code.exe", d1, 1800), log(2, "chrome.exe", d2, 1800)];
        let text = aggregate_activities(&acts, true, AGGREGATE_TEXT_CAP, &Default::default());
        assert!(text.contains("【07-28】"), "缺第一天分节: {}", text);
        assert!(text.contains("【07-29】"), "缺第二天分节: {}", text);
    }

    #[test]
    fn timeline_has_no_day_headers_when_single_day() {
        let d = parse_flexible_datetime("2026-07-29 09:00", false).unwrap();
        let acts = vec![log(1, "code.exe", d, 1800)];
        let text = aggregate_activities(&acts, false, AGGREGATE_TEXT_CAP, &Default::default());
        assert!(!text.contains("【07-29】"), "单天不应有日期分节: {}", text);
    }

    #[test]
    fn known_apps_append_name_and_description_in_summary() {
        let d = parse_flexible_datetime("2026-07-29 09:00", false).unwrap();
        let acts = vec![log(1, "code.exe", d, 3600)];
        let mut labels = std::collections::HashMap::new();
        labels.insert(
            "code.exe".to_string(),
            ("Visual Studio Code".to_string(), "代码编辑器".to_string()),
        );
        let text = aggregate_activities(&acts, false, AGGREGATE_TEXT_CAP, &labels);
        assert!(
            text.contains("code.exe（Visual Studio Code / 代码编辑器）"),
            "缺显示名与描述拼接: {}",
            text
        );
    }

    #[test]
    fn name_identical_to_process_skips_name_part() {
        let d = parse_flexible_datetime("2026-07-29 09:00", false).unwrap();
        let acts = vec![log(1, "code.exe", d, 3600)];
        let mut labels = std::collections::HashMap::new();
        labels.insert(
            "code.exe".to_string(),
            ("Code.exe".to_string(), "代码编辑器".to_string()),
        );
        let text = aggregate_activities(&acts, false, AGGREGATE_TEXT_CAP, &labels);
        assert!(
            text.contains("code.exe（代码编辑器）") && !text.contains("（Code.exe /"),
            "name 与进程名雷同时应跳过 name: {}",
            text
        );
    }

    #[test]
    fn unknown_apps_keep_bare_process_name() {
        let d = parse_flexible_datetime("2026-07-29 09:00", false).unwrap();
        let acts = vec![log(1, "mystery.exe", d, 3600)];
        let text = aggregate_activities(&acts, false, AGGREGATE_TEXT_CAP, &Default::default());
        assert!(text.contains("- mystery.exe"), "未知进程不应带标注: {}", text);
    }
}
