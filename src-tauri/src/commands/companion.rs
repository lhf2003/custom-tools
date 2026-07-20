use rusqlite::Connection;
use tauri::{AppHandle, Emitter, State};

use crate::commands::settings::SettingsState;
use crate::companion::{analyzer, db, suggester, CompanionState};
use crate::db::DatabaseState;

fn open_conn(db_state: &DatabaseState) -> Result<Connection, String> {
    Connection::open(&db_state.0).map_err(|e| format!("打开数据库失败: {}", e))
}

// ── 建议 ─────────────────────────────────────────────────────

#[tauri::command]
pub fn get_companion_suggestions(
    db_state: State<DatabaseState>,
    status: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<db::Suggestion>, String> {
    let conn = open_conn(&db_state)?;
    db::list_suggestions(&conn, status.as_deref(), limit.unwrap_or(50))
        .map_err(|e| format!("查询建议失败: {}", e))
}

/// 接受建议：执行动作负载（批量启动 / 送 AI 分析），然后标记已接受
#[tauri::command]
pub async fn act_on_companion_suggestion(
    db_state: State<'_, DatabaseState>,
    app_handle: AppHandle,
    id: i64,
) -> Result<(), String> {
    let conn = open_conn(&db_state)?;
    let suggestion = db::get_suggestion(&conn, id)
        .map_err(|e| format!("查询建议失败: {}", e))?
        .ok_or_else(|| "建议不存在".to_string())?;

    if suggestion.status != "pending" {
        return Ok(());
    }

    if let Some(payload_str) = &suggestion.action_payload {
        if let Ok(launch) = serde_json::from_str::<db::LaunchAppsPayload>(payload_str) {
            if launch.action == "launch_apps" {
                for app in &launch.apps {
                    if let Err(e) = crate::search::launch_app(&app.path) {
                        log::warn!("Companion 启动 {} 失败: {}", app.path, e);
                    }
                    let _ = crate::db::app_usage::record_launch(&conn, &app.path, &app.name);
                }
            }
        } else if let Ok(analyze) = serde_json::from_str::<db::AnalyzePayload>(payload_str) {
            if analyze.action == "analyze" {
                // 打开主窗口并通知前端跳转到 AI 对话（内容由前端预填）
                crate::commands::window::show_window(app_handle.clone()).await?;
                if let Err(e) = app_handle.emit("companion:analyze", analyze.content) {
                    log::warn!("emit companion:analyze 失败: {}", e);
                }
            }
        }
    }

    let now = chrono::Local::now().timestamp();
    db::set_suggestion_status(&conn, id, "accepted", now)
        .map_err(|e| format!("更新建议状态失败: {}", e))?;

    suggester::hide_toast_window(&app_handle);
    Ok(())
}

#[tauri::command]
pub fn dismiss_companion_suggestion(
    db_state: State<DatabaseState>,
    app_handle: AppHandle,
    id: i64,
) -> Result<(), String> {
    let conn = open_conn(&db_state)?;
    let now = chrono::Local::now().timestamp();
    db::set_suggestion_status(&conn, id, "dismissed", now)
        .map_err(|e| format!("更新建议状态失败: {}", e))?;
    suggester::hide_toast_window(&app_handle);
    Ok(())
}

// ── 习惯模式 ─────────────────────────────────────────────────

#[tauri::command]
pub fn get_companion_patterns(
    db_state: State<DatabaseState>,
) -> Result<Vec<db::HabitPattern>, String> {
    let conn = open_conn(&db_state)?;
    db::list_patterns(&conn).map_err(|e| format!("查询模式失败: {}", e))
}

#[tauri::command]
pub fn set_companion_pattern_status(
    db_state: State<DatabaseState>,
    id: i64,
    status: String,
) -> Result<(), String> {
    if !["learning", "confirmed", "dismissed"].contains(&status.as_str()) {
        return Err(format!("非法模式状态: {}", status));
    }
    let conn = open_conn(&db_state)?;
    db::set_pattern_status(&conn, id, &status).map_err(|e| format!("更新模式状态失败: {}", e))
}

// ── 采集数据 ─────────────────────────────────────────────────

/// 今日各进程使用时长（设置页预览用）
#[tauri::command]
pub fn get_companion_today_summary(
    db_state: State<DatabaseState>,
) -> Result<Vec<(String, i64)>, String> {
    let conn = open_conn(&db_state)?;
    let now = chrono::Local::now();
    let day_start = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|d| d.and_local_timezone(chrono::Local).single())
        .map(|d| d.timestamp())
        .unwrap_or(now.timestamp());
    db::process_totals_between(&conn, day_start, now.timestamp())
        .map_err(|e| format!("查询今日统计失败: {}", e))
}

/// 隐私：清空全部采集数据
#[tauri::command]
pub fn clear_companion_activities(db_state: State<DatabaseState>) -> Result<(), String> {
    let conn = open_conn(&db_state)?;
    db::clear_all_activities(&conn).map_err(|e| format!("清空采集数据失败: {}", e))
}

/// 手动触发一次昨日分析（返回人话结果）
#[tauri::command]
pub async fn analyze_companion_now(
    db_state: State<'_, DatabaseState>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let db_path = db_state.0.clone();
    analyzer::run_daily_analysis(&app_handle, &db_path).await
}

/// 手动触发一次日报 agent（阻塞执行，可能耗时几分钟，返回人话结果）
#[tauri::command]
pub async fn run_companion_agent_now(
    db_state: State<'_, DatabaseState>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let db_path = db_state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::companion::run_agent_with_settings(&app_handle, &db_path)
    })
    .await
    .map_err(|e| format!("agent 线程异常: {}", e))?
}

// ── 开关（持久化 + 运行时镜像同步）─────────────────────────────

macro_rules! companion_flag_command {
    ($fn_name:ident, $setting_key:literal, $field:ident, $ty:ty) => {
        #[tauri::command]
        pub fn $fn_name(
            settings_state: State<SettingsState>,
            companion_state: State<CompanionState>,
            value: $ty,
        ) -> Result<(), String> {
            let manager = settings_state.0.lock().map_err(|e| e.to_string())?;
            manager
                .set_setting($setting_key, &value.to_string())
                .map_err(|e| format!("保存设置失败: {}", e))?;
            drop(manager);

            if let Ok(mut flags) = companion_state.flags.write() {
                flags.$field = value as _;
            }
            Ok(())
        }
    };
}

companion_flag_command!(set_companion_enabled, "companion_enabled", enabled, bool);
companion_flag_command!(set_companion_paused, "companion_paused", paused, bool);
companion_flag_command!(
    set_companion_retention_days,
    "companion_retention_days",
    retention_days,
    i64
);
companion_flag_command!(
    set_companion_long_work_minutes,
    "companion_long_work_minutes",
    long_work_minutes,
    i64
);
companion_flag_command!(
    set_companion_agent_enabled,
    "companion_agent_enabled",
    agent_enabled,
    bool
);
