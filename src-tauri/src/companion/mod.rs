pub mod a2ui;
pub mod agent;
pub mod analyzer;
pub mod backup;
pub mod chat;
pub mod db;
pub mod diary;
pub mod emotion;
pub mod mcp;
pub mod persona;
pub mod recall;
pub mod scene_chat;
pub mod shell;
pub mod skills;
pub mod state;
pub mod suggester;
pub mod tools;
pub mod watcher;
pub mod websearch;

use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, RwLock};

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use watcher::ForegroundEvent;

/// 运行期开关（AppSettings 持久化字段的运行时镜像，避免每 3s 读库）
#[derive(Debug, Clone)]
pub struct CompanionFlags {
    pub enabled: bool,
    pub paused: bool,
    pub retention_days: i64,
    pub long_work_minutes: i64,
    /// 每日日报开关：关闭后 0 点块只做分析与记忆提取，不生成日报
    pub daily_report: bool,
    /// 内心独白开关：关闭后聊天 prompt 不再带 <aside> 独白段
    pub monologue: bool,
}

impl Default for CompanionFlags {
    fn default() -> Self {
        Self {
            enabled: true,
            paused: false,
            retention_days: 30,
            long_work_minutes: 90,
            daily_report: true,
            monologue: true,
        }
    }
}

/// Tauri managed state
pub struct CompanionState {
    pub flags: Arc<RwLock<CompanionFlags>>,
}

/// 启动陪伴模块的三个后台线程：
/// - watcher：轮询前台窗口
/// - collector：写活动流水 + 情境建议（错误检测、长时提醒）
/// - scheduler：模式匹配（晨间工作套装）、每日 LLM 分析、过期清理
pub fn start(
    app_handle: &AppHandle,
    db_path: PathBuf,
    initial_flags: CompanionFlags,
) -> CompanionState {
    // 启动即播种全部人格文件（persona/evolution/三本手册）：
    // 各 load_* 是懒播种，不兜底的话 agents/ 目录在重启后残缺
    if let Ok(app_data) = app_handle.path().app_data_dir() {
        persona::seed_all(&app_data);
    }

    let flags = Arc::new(RwLock::new(initial_flags));

    let (tx, rx) = mpsc::channel::<ForegroundEvent>();

    let watcher = watcher::WindowWatcher::new(tx);
    std::thread::spawn(move || watcher.run());

    let collector_app = app_handle.clone();
    let collector_db = db_path.clone();
    let collector_flags = Arc::clone(&flags);
    std::thread::spawn(move || {
        run_collector(collector_app, collector_db, rx, collector_flags);
    });

    let scheduler_app = app_handle.clone();
    let scheduler_flags = Arc::clone(&flags);
    std::thread::spawn(move || {
        analyzer::run_scheduler(scheduler_app, db_path, scheduler_flags);
    });

    log::info!("Companion module started");
    CompanionState { flags }
}

fn read_flags(flags: &Arc<RwLock<CompanionFlags>>) -> CompanionFlags {
    flags
        .read()
        .map(|f| f.clone())
        .unwrap_or_else(|_| CompanionFlags::default())
}

/// 全局 Claude Code 开关（「设置 → AI 模型」中配置）。
/// 门控陪伴的日报 agent、LLM 路由与缺报补跑。
pub fn claude_code_enabled(app_handle: &AppHandle) -> bool {
    use tauri::Manager;

    app_handle
        .try_state::<crate::commands::settings::SettingsState>()
        .and_then(|s| {
            s.0.lock()
                .ok()
                .map(|m| m.get_settings().claude_code_enabled)
        })
        .unwrap_or(false)
}

/// 解析 agent 运行配置并启动日报 agent。
/// `date` 为日报目标日期（YYYY-MM-DD）。
/// bin 路径复用设置中的 Claude Code 配置；
/// 工作区使用独立空目录（不继承其他工作区——那里的 CLAUDE.md、
/// .claude hooks 会注入 agent 上下文，且可能含敏感信息）。
pub fn run_agent_with_settings(
    app_handle: &AppHandle,
    db_path: &std::path::Path,
    date: &str,
) -> Result<String, String> {
    use tauri::Manager;

    let settings_state = app_handle
        .try_state::<crate::commands::settings::SettingsState>()
        .ok_or("设置模块未初始化")?;
    let settings = settings_state
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get_settings();

    let notes_dir =
        crate::notes::get_default_notes_dir().map_err(|e| format!("获取笔记目录失败: {}", e))?;

    let work_dir = agent::resolve_work_dir(app_handle, &settings.claude_code_work_dir)?;

    agent::run_daily_report_agent(
        app_handle,
        db_path,
        &notes_dir,
        &settings.claude_code_bin_path,
        &work_dir,
        date,
    )
}

/// 空闲超过该值视为离开（AFK），当前活动段闭合到最后一次活跃时刻
const AFK_THRESHOLD_SECS: i64 = 300;
/// 打开中的活动记录每隔该值刷新一次时长（防止异常退出丢时长）
const HEARTBEAT_INTERVAL_SECS: i64 = 60;
/// 长时工作提醒冷却
const LONG_WORK_COOLDOWN_SECS: i64 = 3600;
/// 错误日志建议冷却
const ERROR_COOLDOWN_SECS: i64 = 1800;
/// 剪贴板检查节流间隔
const CLIPBOARD_CHECK_INTERVAL_SECS: i64 = 9;
/// 意图触发检查节流间隔
const INTENT_CHECK_INTERVAL_SECS: i64 = 9;
/// 意图过期阈值：7 天未动自动降级（不再主动弹，但不删）
const INTENT_EXPIRE_SECS: i64 = 7 * 86400;
/// 触发器解析重试间隔（LLM 暂时不可达时，每小时补一次）
const PARSE_RETRY_INTERVAL_SECS: i64 = 3600;
/// IM 进程特征（③联系人触发只在这些进程下生效）
const IM_PROCESS_HINTS: &[&str] = &[
    "weixin", "wechat", "dingtalk", "lark", "feishu", "qq.exe", "tim.exe",
];

fn fmt_date(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|utc| {
            utc.with_timezone(&chrono::Local)
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_default()
}

/// 备忘是否处于活跃期（未过期、已到 due 日期）
fn memo_is_active(memo: &db::Memo, today: &str, now: i64) -> bool {
    if memo.created_at + INTENT_EXPIRE_SECS < now {
        return false;
    }
    if let Some(due) = &memo.due_date {
        if due.as_str() > today {
            return false;
        }
    }
    true
}

fn run_collector(
    app_handle: AppHandle,
    db_path: PathBuf,
    rx: mpsc::Receiver<ForegroundEvent>,
    flags: Arc<RwLock<CompanionFlags>>,
) {
    // 当前打开的活动段 (row_id, process, title)
    let mut current: Option<(i64, String, String)> = None;
    // 当前进程连续使用的起点（跨标题变化保持，用于长时工作判定）
    let mut current_process = String::new();
    let mut process_since: i64 = 0;

    let mut last_heartbeat: i64 = 0;
    let mut last_long_work_suggest: i64 = 0;
    // 启动时以当前最新剪贴板为基线——历史剪贴板不触发分析，
    // 否则用户昨天复制的错误日志会在今天启动时弹出建议
    let mut last_clipboard_id: i64 = Connection::open(&db_path)
        .ok()
        .and_then(|c| db::latest_clipboard_text(&c).ok().flatten())
        .map(|(id, _)| id)
        .unwrap_or(0);
    let mut last_clipboard_check: i64 = 0;
    let mut last_intent_check: i64 = 0;
    let mut last_parse_retry: i64 = 0;
    // 晨间汇总：每天首次活动时只发一次
    let mut last_digest_date =
        analyzer::load_setting(&db_path, "companion_last_digest_date").unwrap_or_default();

    // 启动清理：闭合关机/崩溃残留的未闭合段（超过 AFK 阈值仍未闭合必为残段），
    // 否则隔夜段会被 current_open_activity 当成「连续工作」起点
    if let Ok(conn) = Connection::open(&db_path) {
        let before = chrono::Local::now().timestamp() - AFK_THRESHOLD_SECS;
        if let Ok(n) = db::close_stale_open_activities(&conn, before) {
            if n > 0 {
                log::info!("Companion 启动清理 {} 条残留活动段", n);
            }
        }
    }

    for event in &rx {
        let f = read_flags(&flags);

        // 暂停/禁用时不采集，并重置当前段（避免恢复后时长虚高）
        if !f.enabled || f.paused {
            current = None;
            current_process.clear();
            continue;
        }

        let conn = match Connection::open(&db_path) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("Companion 打开数据库失败: {}", e);
                continue;
            }
        };

        // AFK：闭合当前段到最后活跃时刻
        if event.idle_secs as i64 > AFK_THRESHOLD_SECS {
            if let Some((row_id, _, _)) = current.take() {
                let end = event.timestamp - event.idle_secs as i64;
                let _ = db::close_activity(&conn, row_id, end);
            }
            current_process.clear();
            continue;
        }

        let same_segment = current
            .as_ref()
            .map(|(_, p, t)| p == &event.process_name && t == &event.window_title)
            .unwrap_or(false);

        if !same_segment {
            if let Some((row_id, _, _)) = current.take() {
                let _ = db::close_activity(&conn, row_id, event.timestamp);
            }
            match db::insert_activity(
                &conn,
                &event.process_name,
                &event.window_title,
                event.timestamp,
            ) {
                Ok(id) => {
                    current = Some((id, event.process_name.clone(), event.window_title.clone()));
                }
                Err(e) => log::warn!("Companion 写入活动失败: {}", e),
            }
            if current_process != event.process_name {
                current_process = event.process_name.clone();
                process_since = event.timestamp;
            }
            last_heartbeat = event.timestamp;
        } else if event.timestamp - last_heartbeat >= HEARTBEAT_INTERVAL_SECS {
            if let Some((row_id, _, _)) = &current {
                let _ = db::close_activity(&conn, *row_id, event.timestamp);
            }
            last_heartbeat = event.timestamp;
        }

        check_long_work(
            &conn,
            &app_handle,
            &f,
            &current_process,
            process_since,
            event.timestamp,
            &mut last_long_work_suggest,
        );

        if event.timestamp - last_clipboard_check >= CLIPBOARD_CHECK_INTERVAL_SECS {
            last_clipboard_check = event.timestamp;
            check_clipboard_error(&conn, &app_handle, event.timestamp, &mut last_clipboard_id);
        }

        if event.timestamp - last_intent_check >= INTENT_CHECK_INTERVAL_SECS {
            last_intent_check = event.timestamp;
            check_morning_digest(
                &conn,
                &app_handle,
                &db_path,
                event.timestamp,
                &mut last_digest_date,
            );
            check_intent_triggers(&conn, &app_handle, &event);
        }

        if event.timestamp - last_parse_retry >= PARSE_RETRY_INTERVAL_SECS {
            last_parse_retry = event.timestamp;
            retry_intent_parse(&conn, &app_handle, &db_path);
        }
    }

    log::info!("Companion collector stopped");
}

/// 同一进程连续使用超过阈值 → 休息提醒（带冷却）
fn check_long_work(
    conn: &Connection,
    app_handle: &AppHandle,
    flags: &CompanionFlags,
    current_process: &str,
    process_since: i64,
    now: i64,
    last_suggest: &mut i64,
) {
    if current_process.is_empty() || process_since == 0 {
        return;
    }
    let continuous = now - process_since;
    if continuous < flags.long_work_minutes.saturating_mul(60) {
        return;
    }
    if now - *last_suggest < LONG_WORK_COOLDOWN_SECS {
        return;
    }
    // 提示型推送即落 seen，去重必须不限状态——近期弹过就不再弹（跨重启兜底）
    let already_pending = db::has_suggestion_since(
        conn,
        suggester::TYPE_LONG_WORK_BREAK,
        now - LONG_WORK_COOLDOWN_SECS,
    )
    .unwrap_or(true);
    if already_pending {
        return;
    }

    let minutes = continuous / 60;
    let title = format!("已连续工作 {} 分钟", minutes);
    let body = format!(
        "在 {} 上连续肝了 {} 分钟了，起来接杯水、走两步。",
        current_process, minutes
    );
    if suggester::push_suggestion(
        conn,
        app_handle,
        suggester::TYPE_LONG_WORK_BREAK,
        &title,
        Some(&body),
        None,
    )
    .is_ok()
    {
        *last_suggest = now;
    }
}

/// 剪贴板出现新的疑似错误堆栈 → 建议 AI 分析（带冷却）
fn check_clipboard_error(
    conn: &Connection,
    app_handle: &AppHandle,
    now: i64,
    last_clipboard_id: &mut i64,
) {
    let Some((clip_id, content)) = db::latest_clipboard_text(conn).unwrap_or(None) else {
        return;
    };
    if clip_id <= *last_clipboard_id {
        return;
    }
    *last_clipboard_id = clip_id;

    if !suggester::looks_like_error(&content) {
        return;
    }
    let already_pending = db::has_pending_suggestion_since(
        conn,
        suggester::TYPE_ERROR_ANALYSIS,
        now - ERROR_COOLDOWN_SECS,
    )
    .unwrap_or(true);
    if already_pending {
        return;
    }

    let preview: String = content.chars().take(120).collect();
    let payload = db::AnalyzePayload {
        action: "analyze".to_string(),
        content,
    };
    let payload_json = serde_json::to_string(&payload).ok();

    let _ = suggester::push_suggestion(
        conn,
        app_handle,
        suggester::TYPE_ERROR_ANALYSIS,
        "检测到错误日志",
        Some(&format!("剪贴板里躺着一段疑似报错：\n{}…", preview)),
        payload_json.as_deref(),
    );
}

/// 晨间汇总：每天首次活动时，把活跃意图汇总成一张卡片（每日仅一次）
fn check_morning_digest(
    conn: &Connection,
    app_handle: &AppHandle,
    db_path: &PathBuf,
    now: i64,
    last_digest_date: &mut String,
) {
    let today = fmt_date(now);
    if *last_digest_date == today {
        return;
    }

    let memos = db::list_memos_active(conn).unwrap_or_default();
    let active: Vec<&db::Memo> = memos
        .iter()
        .filter(|m| memo_is_active(m, &today, now))
        .collect();
    // 没有活跃备忘时不消耗今日额度——稍后记下第一条的当天仍能收到汇总
    if active.is_empty() {
        return;
    }

    *last_digest_date = today.clone();
    analyzer::save_setting(db_path, "companion_last_digest_date", &today);

    let titles: Vec<String> = active.iter().take(3).map(|m| m.content.clone()).collect();
    let suffix = if active.len() > 3 {
        format!("\n…以及另外 {} 条", active.len() - 3)
    } else {
        String::new()
    };
    // 今日关注（昨夜预规划）有效时，晨间卡从纯备忘清单升级为「关注+备忘」
    let body = match diary::today_focus(conn) {
        Some(focus) => format!(
            "今日关注：\n{}\n\n备忘待办 {} 条：\n{}{}",
            focus,
            active.len(),
            titles.join("\n"),
            suffix
        ),
        None => format!(
            "今天有 {} 条备忘待办：\n{}{}",
            active.len(),
            titles.join("\n"),
            suffix
        ),
    };

    let _ = suggester::push_suggestion(
        conn,
        app_handle,
        suggester::TYPE_DAILY_DIGEST,
        "今日备忘",
        Some(&body),
        None,
    );
}

/// 触发器解析重试：LLM 暂时不可达（如断网/VPN 未连）导致解析失败的备忘，
/// 每小时补试一次（每次最多 2 条，避免风暴）
fn retry_intent_parse(conn: &Connection, app_handle: &AppHandle, db_path: &Path) {
    let pending = db::list_memos_unparsed(conn, 2).unwrap_or_default();

    for memo in pending {
        let text = memo.content_raw.clone();
        let app = app_handle.clone();
        let db = db_path.to_path_buf();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = analyzer::parse_and_store_triggers(&app, &db, memo.id, &text).await {
                log::warn!("备忘 #{} 重试解析仍失败: {}", memo.id, e);
            }
        });
    }
}

/// 情境触发匹配：窗口标题命中关键词（②）或 IM 窗口命中联系人（③）
/// 一次事件最多弹一条，同日同条不重复
fn check_intent_triggers(conn: &Connection, app_handle: &AppHandle, event: &ForegroundEvent) {
    let memos = db::list_memos_active(conn).unwrap_or_default();
    if memos.is_empty() {
        return;
    }

    let today = fmt_date(event.timestamp);
    let title_lower = event.window_title.to_lowercase();
    let proc_lower = event.process_name.to_lowercase();
    let is_im = IM_PROCESS_HINTS.iter().any(|h| proc_lower.contains(h));

    for memo in &memos {
        if !memo_is_active(memo, &today, event.timestamp) {
            continue;
        }
        // 同日已触发过不重复
        if memo
            .last_triggered_at
            .map(|t| fmt_date(t) == today)
            .unwrap_or(false)
        {
            continue;
        }
        let Some(trigger_data) = &memo.trigger_data else {
            continue;
        };
        let Ok(triggers) = serde_json::from_str::<db::IntentTriggers>(trigger_data) else {
            continue;
        };

        let keyword_hit = triggers.keywords.iter().any(|k| {
            let kl = k.to_lowercase();
            !kl.is_empty() && title_lower.contains(&kl)
        });

        // ③ 联系人/渠道触发。
        // 现代 IM（微信4.0、钉钉）主窗口标题不含聊天对象，
        // 所以：明确渠道 → 打开该 IM 即触发；未明渠道 → 退回标题含人名
        // （兼容图片/文档预览等标题带人名的场景）
        let contact_hit = is_im
            && (im_channel_matches(triggers.channel.as_deref(), &proc_lower)
                || person_in_title(triggers.person.as_deref(), &title_lower));

        if keyword_hit || contact_hit {
            log::info!(
                "备忘 #{} 情境触发（{}）",
                memo.id,
                if keyword_hit {
                    "关键词"
                } else {
                    "联系人/渠道"
                }
            );
            // 弹窗走系统建议流（intent_reminder）：忽略弹窗 ≠ 处置备忘，
            // memos 状态只有用户在笔记视图明确勾选才变
            let _ = suggester::push_suggestion(
                conn,
                app_handle,
                suggester::TYPE_INTENT_REMINDER,
                &memo.content,
                None,
                None,
            );
            let _ = db::touch_memo_triggered(conn, memo.id, event.timestamp);
            break;
        }
    }
}

/// 意图声明的渠道与当前 IM 进程是否匹配
fn im_channel_matches(channel: Option<&str>, proc_lower: &str) -> bool {
    let Some(ch) = channel else { return false };
    let chl = ch.to_lowercase();
    let wechat = chl.contains("微信") || chl.contains("weixin") || chl.contains("wechat");
    let dingtalk = chl.contains("钉钉") || chl.contains("dingtalk");
    let feishu = chl.contains("飞书") || chl.contains("lark") || chl.contains("feishu");
    let qq = chl == "qq" || chl.contains("qq");

    (wechat && (proc_lower.contains("weixin") || proc_lower.contains("wechat")))
        || (dingtalk && proc_lower.contains("dingtalk"))
        || (feishu && (proc_lower.contains("lark") || proc_lower.contains("feishu")))
        || (qq && proc_lower.contains("qq"))
}

/// 窗口标题是否包含联系人名
fn person_in_title(person: Option<&str>, title_lower: &str) -> bool {
    person
        .map(|p| {
            let pl = p.to_lowercase();
            !pl.is_empty() && title_lower.contains(&pl)
        })
        .unwrap_or(false)
}
