use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::commands::settings::SettingsState;
use crate::companion::{analyzer, db, suggester, CompanionState};
use crate::db::DatabaseState;

fn open_conn(db_state: &DatabaseState) -> Result<Connection, String> {
    Connection::open(&db_state.0).map_err(|e| format!("打开数据库失败: {}", e))
}

// ── 场所管理（CASE-003：设置页只读列表 + 删除） ────────────────

#[derive(serde::Serialize)]
pub struct CompanionPlaceInfo {
    pub fingerprint: String,
    pub name: String,
    pub created_at: i64,
}

#[tauri::command]
pub fn list_companion_places(
    db_state: State<'_, DatabaseState>,
) -> Result<Vec<CompanionPlaceInfo>, String> {
    Ok(crate::companion::envsense::load_places(&db_state.0)
        .into_iter()
        .map(|p| CompanionPlaceInfo {
            fingerprint: p.fingerprint,
            name: p.name,
            created_at: p.created_at,
        })
        .collect())
}

#[tauri::command]
pub fn delete_companion_place(
    db_state: State<'_, DatabaseState>,
    fingerprint: String,
) -> Result<(), String> {
    crate::companion::envsense::remove_place(&db_state.0, &fingerprint)
}

/// 建议创建到用户点击之间应用可能已更新（Edge/Chrome 旧版本目录被删）——
/// payload 路径失效时按 exe 名从使用记录重解析一条现存的替代路径
fn resolve_launch_path(conn: &Connection, app: &db::LaunchAppItem) -> String {
    if crate::search::path_launchable(&app.path) {
        return app.path.clone();
    }
    let exe = std::path::Path::new(&app.path)
        .file_name()
        .map(|f| f.to_string_lossy().into_owned());
    exe.and_then(|e| {
        crate::companion::analyzer::resolve_app_paths(conn, std::slice::from_ref(&e))
            .into_iter()
            .next()
            .map(|item| item.path)
    })
    .unwrap_or_else(|| app.path.clone())
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
                    let path = resolve_launch_path(&conn, app);
                    // 启动成功才记 usage——失败计数会把失效路径顶得更高，下次还选它
                    if let Err(e) = crate::search::launch_app(&path) {
                        log::warn!("Companion 启动 {} 失败: {}", path, e);
                        continue;
                    }
                    let _ = crate::db::app_usage::record_launch(&conn, &path, &app.name);
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
        } else if let Ok(edit) = serde_json::from_str::<db::ManualEditPayload>(payload_str) {
            if edit.action == "apply_manual_edit" {
                // 手册修改门控（三期）：用户点了接受才走到这——校验+快照+写入
                let app_data = app_handle
                    .path()
                    .app_data_dir()
                    .map_err(|e| e.to_string())?;
                crate::companion::skills::apply_manual_content(
                    &app_data,
                    &edit.name,
                    &edit.new_content,
                )?;
            }
        } else if let Ok(value) = serde_json::from_str::<serde_json::Value>(payload_str) {
            if value["action"].as_str() == Some("open_apps_tab") {
                // 未知应用提醒：打开主窗口 → 切设置页 → 应用 tab 预填搜索
                // （设置是主窗口内 view，先 show 再发两个事件；前端 store 缓存兜底事件先到）
                crate::commands::window::show_window(app_handle.clone()).await?;
                if let Err(e) = app_handle.emit("shortcut:open_module", "settings") {
                    log::warn!("emit shortcut:open_module 失败: {}", e);
                }
                if let Some(process_name) = value["process_name"].as_str() {
                    if let Err(e) = app_handle.emit("settings:open-apps-tab", process_name) {
                        log::warn!("emit settings:open-apps-tab 失败: {}", e);
                    }
                }
            }
        }
    }

    let now = chrono::Local::now().timestamp();
    db::set_suggestion_status(&conn, id, "accepted", now)
        .map_err(|e| format!("更新建议状态失败: {}", e))?;
    crate::companion::emotion::on_suggestion_accepted(&conn, &suggestion.title, now);

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
    crate::companion::emotion::on_suggestion_dismissed(&conn, now);
    suggester::hide_toast_window(&app_handle);
    Ok(())
}

/// toast 页面挂载后补拉待展示建议队列：预创建窗口的页面异步加载，
/// 首次 emit 可能早于监听器注册（事件即发即丢），挂载时主动补拉兜底。
/// 返回整个队列（多条建议逐条展示，不丢前面的）。
#[tauri::command]
pub fn get_pending_companion_toast(
    state: State<suggester::PendingToastState>,
) -> Vec<db::Suggestion> {
    state
        .0
        .lock()
        .ok()
        .map(|mut pending| pending.drain(..).collect())
        .unwrap_or_default()
}

/// toast 前端渲染完成回执：内容首帧就绪后才定位 + show + focus，消除透明空帧。
/// 队列已被前端补拉接管，这里只负责 show，不再改动 pending。
#[tauri::command]
pub fn companion_toast_ready(app_handle: AppHandle) {
    suggester::show_toast_window(&app_handle);
}

// ── 应用描述（设置页「应用」tab） ─────────────────────────────

/// 分页查询应用列表（JOIN app_usage 取启动次数）
#[tauri::command]
pub fn get_app_cache_entries(
    db_state: State<DatabaseState>,
    query: Option<String>,
    sort: Option<String>,
    direction: Option<String>,
    only_unlabeled: Option<bool>,
    offset: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<crate::db::app_cache::AppCacheRow>, String> {
    let conn = open_conn(&db_state)?;
    let sort = sort.unwrap_or_else(|| "launch".to_string());
    let direction =
        direction.unwrap_or_else(|| if sort == "name" { "asc" } else { "desc" }.to_string());
    crate::db::app_cache::query_app_entries(
        &conn,
        query.as_deref(),
        &sort,
        &direction,
        only_unlabeled.unwrap_or(false),
        offset.unwrap_or(0),
        limit.unwrap_or(50).clamp(1, 200),
    )
    .map_err(|e| format!("查询应用列表失败: {}", e))
}

/// 更新单行应用描述（空字符串 = 清空）
#[tauri::command]
pub fn update_app_cache_description(
    db_state: State<DatabaseState>,
    path: String,
    description: String,
) -> Result<(), String> {
    if description.chars().count() > 50 {
        return Err("描述过长（最多 50 字）".to_string());
    }
    let conn = open_conn(&db_state)?;
    crate::db::app_cache::update_description(&conn, &path, description.trim())
        .map_err(|e| format!("更新描述失败: {}", e))
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

/// 手动触发一次增量分析（水位线到当前时刻，返回人话结果）
#[tauri::command]
pub async fn analyze_companion_now(
    db_state: State<'_, DatabaseState>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let db_path = db_state.0.clone();
    analyzer::run_daily_analysis(&app_handle, &db_path).await
}

/// 手动触发一次日报（场景模型版，阻塞执行可能耗时几分钟，返回人话结果）
/// 归属与 0 点调度一致：生成「昨天」的日报
#[tauri::command]
pub async fn run_companion_agent_now(
    db_state: State<'_, DatabaseState>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let db_path = db_state.0.clone();
    let yesterday = (chrono::Local::now() - chrono::Duration::days(1))
        .format("%Y-%m-%d")
        .to_string();
    let db_for_task = db_path.clone();
    let date = yesterday.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let notes_dir = crate::notes::get_default_notes_dir()
            .map_err(|e| format!("获取笔记目录失败: {}", e))?;
        tauri::async_runtime::block_on(crate::companion::analyzer::run_scene_report(
            &app_handle,
            &db_for_task,
            &notes_dir,
            &date,
        ))
    })
    .await
    .map_err(|e| format!("日报线程异常: {}", e))?;
    // 手动生成成功且笔记落盘 → 标记昨日日报完成，避免 0 点调度重复生成
    if result.is_ok() {
        let note_written = crate::notes::get_default_notes_dir()
            .map(|d| {
                d.join(crate::companion::mcp::NOTE_DIR_PREFIX)
                    .join(format!("{}.md", yesterday))
                    .exists()
            })
            .unwrap_or(false);
        if note_written {
            crate::companion::analyzer::save_setting(
                &db_path,
                "companion_last_report_date",
                &yesterday,
            );
            if let Ok(conn) = Connection::open(&db_path) {
                crate::companion::emotion::on_report_done(
                    &conn,
                    &yesterday,
                    chrono::Local::now().timestamp(),
                );
            }
        }
    }
    result
}

// ── 备忘（「记」）─────────────────────────────────────────────

/// 创建一条备忘（launcher「记 xxx」入口），落 memos 表（唯一真源）。
/// 原文立即落库（保真，content 先等于原文），LLM 异步解析后写回
/// 重构正文 + 触发器——解析失败正文兜底为原文，不影响主流程。
#[tauri::command]
pub fn create_companion_intent(
    db_state: State<DatabaseState>,
    app_handle: AppHandle,
    text: String,
) -> Result<i64, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("备忘内容不能为空".to_string());
    }

    let conn = open_conn(&db_state)?;
    let now = chrono::Local::now().timestamp();
    let memo = db::create_memo(&conn, &text, now).map_err(|e| format!("保存备忘失败: {}", e))?;
    let id = memo.id;
    // 原文已落库，通知备忘视图立刻显示（重构正文落库后由解析链路再发一次）
    let _ = app_handle.emit("memo:changed", ());

    // 异步解析（重构正文 + 触发器），不阻塞 launcher 返回
    let db_path = db_state.0.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = analyzer::parse_and_store_triggers(&app_handle, &db_path, id, &text).await {
            log::warn!("备忘 #{} 解析失败（保留原文兜底）: {}", id, e);
        }
    });

    Ok(id)
}

/// 笔记视图：列出备忘（pending 在前，已处置在后）
#[tauri::command]
pub fn list_memos(
    db_state: State<DatabaseState>,
    limit: Option<i64>,
) -> Result<Vec<db::Memo>, String> {
    let conn = open_conn(&db_state)?;
    db::list_memos_for_view(&conn, limit.unwrap_or(200)).map_err(|e| format!("查询备忘失败: {}", e))
}

/// 笔记视图：处置备忘（done / dismissed / 取消勾回 pending）
#[tauri::command]
pub fn set_memo_status(
    db_state: State<DatabaseState>,
    app_handle: AppHandle,
    id: i64,
    status: String,
) -> Result<(), String> {
    if !["pending", "done", "dismissed"].contains(&status.as_str()) {
        return Err(format!("非法备忘状态: {}", status));
    }
    let conn = open_conn(&db_state)?;
    let now = chrono::Local::now().timestamp();
    // 重复备忘需先取整行（内容/规则照抄生成下一次）
    let memo = if status == "done" {
        db::get_memo(&conn, id).ok()
    } else {
        None
    };
    db::set_memo_status(&conn, id, &status, now).map_err(|e| format!("更新备忘状态失败: {}", e))?;
    // 完成即重生下一次 occurrence（due 推到下一周期；失败只记日志，本次完成不回滚）
    if let Some(m) = memo {
        if m.recurrence.is_some() {
            if let Err(e) = db::create_next_recurrence(&conn, &m, now) {
                log::warn!("重复备忘 #{} 生成下一次失败: {}", id, e);
            }
        }
    }
    let _ = app_handle.emit("memo:changed", ());
    Ok(())
}

/// 备忘视图：置顶 / 取消置顶
#[tauri::command]
pub fn set_memo_pinned(
    db_state: State<DatabaseState>,
    app_handle: AppHandle,
    id: i64,
    pinned: bool,
) -> Result<(), String> {
    let conn = open_conn(&db_state)?;
    db::set_memo_pinned(&conn, id, pinned).map_err(|e| format!("更新置顶失败: {}", e))?;
    let _ = app_handle.emit("memo:changed", ());
    Ok(())
}

/// 备忘视图菜单批量处置（「全部标为完成」「清空已完成」）。
/// 迁移白名单仅 pending→done / done→dismissed，其余组合拒绝（防调用方乱迁）。
#[tauri::command]
pub fn bulk_set_memo_status(
    db_state: State<DatabaseState>,
    app_handle: AppHandle,
    from_status: String,
    to_status: String,
) -> Result<usize, String> {
    let allowed = matches!(
        (from_status.as_str(), to_status.as_str()),
        ("pending", "done") | ("done", "dismissed")
    );
    if !allowed {
        return Err(format!("非法批量迁移: {} → {}", from_status, to_status));
    }
    let conn = open_conn(&db_state)?;
    let now = chrono::Local::now().timestamp();
    let n = db::bulk_set_memo_status(&conn, &from_status, &to_status, now)
        .map_err(|e| format!("批量更新备忘状态失败: {}", e))?;
    let _ = app_handle.emit("memo:changed", ());
    Ok(n)
}

// ── 记忆层 ───────────────────────────────────────────────────

/// 列出关于用户的事实记忆（记忆中心全量列表）
#[tauri::command]
pub fn get_companion_memory_facts(
    db_state: State<DatabaseState>,
) -> Result<Vec<db::MemoryFact>, String> {
    let conn = open_conn(&db_state)?;
    db::list_memory_facts(&conn, 500).map_err(|e| format!("查询记忆失败: {}", e))
}

/// 编辑一条事实的文本与分类（记忆中心，写审计）
#[tauri::command]
pub fn update_companion_memory_fact(
    db_state: State<DatabaseState>,
    id: i64,
    fact: String,
    category: String,
) -> Result<(), String> {
    let fact = fact.trim().to_string();
    if fact.is_empty() {
        return Err("事实内容不能为空".to_string());
    }
    let conn = open_conn(&db_state)?;
    let now = chrono::Local::now().timestamp();
    db::update_memory_fact(&conn, id, &fact, &category, "user", now)
        .map_err(|e| format!("更新记忆失败: {}", e))
}

#[tauri::command]
pub fn delete_companion_memory_fact(db_state: State<DatabaseState>, id: i64) -> Result<(), String> {
    let conn = open_conn(&db_state)?;
    let now = chrono::Local::now().timestamp();
    db::delete_memory_fact_audited(&conn, id, "user", now)
        .map_err(|e| format!("删除记忆失败: {}", e))
}

/// 记忆变更审计（记忆中心：单条历史 / 全局最近动态）
#[tauri::command]
pub fn get_companion_memory_fact_events(
    db_state: State<DatabaseState>,
    fact_id: Option<i64>,
    limit: Option<i64>,
) -> Result<Vec<db::MemoryFactEvent>, String> {
    let conn = open_conn(&db_state)?;
    db::list_memory_fact_events(&conn, fact_id, limit.unwrap_or(50))
        .map_err(|e| format!("查询记忆历史失败: {}", e))
}

/// 聊天消息落库后的提取防抖触发（前端每条消息后调用）
#[tauri::command]
pub fn jarvis_recall_poke(
    app_handle: tauri::AppHandle,
    db_state: State<DatabaseState>,
) -> Result<(), String> {
    crate::companion::recall::poke(app_handle, db_state.0.clone());
    Ok(())
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
    set_companion_daily_report,
    "companion_daily_report",
    daily_report,
    bool
);
companion_flag_command!(
    set_companion_monologue,
    "companion_monologue",
    monologue,
    bool
);
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

// ── 进化治理（三期：手册/经验本/态度指引的快照、回滚、在线编辑）──────────────

/// 治理视图的手册条目（schedule 转回文本直接展示）
#[derive(Debug, serde::Serialize)]
pub struct ManualInfo {
    pub name: String,
    pub description: String,
    pub trigger_description: String,
    pub schedule: Option<String>,
    pub enabled: bool,
    /// 依赖工具名清单（SKILL 能力页「能力→工具」映射展示）
    pub tools: Vec<String>,
    /// 内置（随应用播种，不可删不可开关）或导入（custom/，可删可开关）
    pub builtin: bool,
}

fn format_schedule(s: &crate::companion::skills::Schedule) -> String {
    const DOW: [&str; 7] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
    match s {
        crate::companion::skills::Schedule::Daily { times } => {
            let list = times
                .iter()
                .map(|(h, m)| format!("{:02}:{:02}", h, m))
                .collect::<Vec<_>>()
                .join(",");
            format!("daily {}", list)
        }
        crate::companion::skills::Schedule::Weekly {
            weekday,
            hour,
            minute,
        } => format!(
            "weekly {} {:02}:{:02}",
            DOW.get(*weekday as usize).unwrap_or(&"?"),
            hour,
            minute
        ),
    }
}

#[tauri::command]
pub fn list_manuals(app_handle: AppHandle) -> Result<Vec<ManualInfo>, String> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(crate::companion::skills::scan_skills(&app_data)
        .into_iter()
        .filter(|s| !s.builtin)
        .map(|s| ManualInfo {
            name: s.name,
            description: s.description,
            trigger_description: s.trigger_description,
            schedule: s.schedule.as_ref().map(format_schedule),
            enabled: s.enabled,
            tools: s.tools,
            builtin: s.builtin,
        })
        .collect())
}

/// 导入外部 SKILL 手册：写入 custom/ 子目录（frontmatter 规范化、强制 trigger_description、
/// 同名拒绝——细则见 skills::import_skill）。返回导入后的条目。
#[tauri::command]
pub fn import_skill(app_handle: AppHandle, content: String) -> Result<ManualInfo, String> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let s = crate::companion::skills::import_skill(&app_data, &content)?;
    log::info!("导入手册「{}」到 custom/", s.name);
    Ok(ManualInfo {
        name: s.name,
        description: s.description,
        trigger_description: s.trigger_description,
        schedule: s.schedule.as_ref().map(format_schedule),
        enabled: s.enabled,
        tools: s.tools,
        builtin: s.builtin,
    })
}

/// 删除导入的手册（内置不可删；删除前快照，可在备份列表回滚）
#[tauri::command]
pub fn delete_skill(app_handle: AppHandle, name: String) -> Result<(), String> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    crate::companion::skills::delete_skill(&app_data, &name)?;
    log::info!("已删除导入手册「{}」", name);
    Ok(())
}

/// 开关导入的手册（内置不可开关）
#[tauri::command]
pub fn set_skill_enabled(app_handle: AppHandle, name: String, enabled: bool) -> Result<(), String> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    crate::companion::skills::set_skill_enabled(&app_data, &name, enabled)?;
    Ok(())
}

/// AI 起草触发场景描述：导入确认步「让 AI 起草」按钮用。
/// 给手册名/简介/正文，场景模型写一句 trigger_description（source=skill_trigger_draft）。
#[tauri::command]
pub async fn draft_skill_trigger(
    app_handle: AppHandle,
    db_state: State<'_, DatabaseState>,
    name: String,
    description: String,
    body: String,
) -> Result<String, String> {
    let excerpt: String = body.chars().take(800).collect();
    let prompt = format!(
        "为一本 agent 能力手册起草「触发场景描述」。\n手册名：{}\n手册简介：{}\n手册正文（节选）：\n{}\n\n\
         要求：一句话（不超过 60 字），说明用户什么样的意图或说法时应该激活这本手册；\
         如有明显的反例边界，用「；」接一句「……时不要激活」。\
         只输出这句描述本身，不要前后缀、不要引号。",
        name, description, excerpt
    );
    let draft = crate::companion::analyzer::call_scene_model_llm(
        &app_handle,
        &db_state.0,
        prompt,
        crate::llm_provider::models::Scene::Companion,
        "skill_trigger_draft",
    )
    .await?;
    Ok(draft.trim().trim_matches('"').trim_matches('"').to_string())
}

/// MCP 设置页的 server 卡片信息（协议/版本/对外工具名清单）
#[tauri::command]
pub fn get_mcp_server_info() -> crate::companion::mcp::McpServerInfo {
    crate::companion::mcp::server_info()
}

/// 本地 companion MCP 的配置片段（JSON 字符串，供「复制配置」按钮使用）
#[tauri::command]
pub fn get_mcp_config() -> Result<String, String> {
    crate::companion::mcp_config::config_json()
}

// ── 第三方 MCP server（二期：能调 + 能装 + 能管）──────────────────

/// 全部第三方 server（MCP tab 列表；token 不下发，只有 has_token）
#[tauri::command]
pub fn list_external_mcp_servers(
    settings_state: State<SettingsState>,
) -> Result<Vec<crate::companion::mcp_servers::ExternalMcpServerInfo>, String> {
    Ok(crate::companion::mcp_servers::list_infos(&settings_state.0))
}

/// 导入第三方 server（手动配置）：config 为完整 server 配置 JSON（前端表单组装）。
/// slug/传输校验 → 强制连通验证（initialize + tools/list 快照）。
/// 验证失败且 force=false 时报错；前端确认「仍然保存」后以 force=true 重调（存为未连接）。
#[tauri::command]
pub async fn import_external_mcp_server(
    settings_state: State<'_, SettingsState>,
    config: String,
    force: bool,
) -> Result<crate::companion::mcp_servers::ExternalMcpServerInfo, String> {
    let server: crate::companion::mcp_servers::ExternalMcpServer =
        serde_json::from_str(&config).map_err(|e| format!("配置解析失败: {}", e))?;
    crate::companion::mcp_servers::import(&settings_state.0, server, force).await
}

/// 导入第三方 server（JSON 粘贴）：raw 为 Claude Desktop mcpServers 单条目
/// `{"name": {"command"/"url": ...}}`。解析后走同一导入通道（校验 + 验证 + 降级保存）。
#[tauri::command]
pub async fn import_external_mcp_server_json(
    settings_state: State<'_, SettingsState>,
    raw: String,
    force: bool,
) -> Result<crate::companion::mcp_servers::ExternalMcpServerInfo, String> {
    let server = crate::companion::mcp_servers::parse_server_entry(&raw)?;
    crate::companion::mcp_servers::import(&settings_state.0, server, force).await
}

/// 删除第三方 server（连带清理其工具开关残留）
#[tauri::command]
pub fn delete_external_mcp_server(
    settings_state: State<SettingsState>,
    name: String,
) -> Result<(), String> {
    crate::companion::mcp_servers::delete(&settings_state.0, &name)
}

/// server 总开关（关闭 = 其下工具全部不进聊天循环）
#[tauri::command]
pub fn set_external_mcp_server_enabled(
    settings_state: State<SettingsState>,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    crate::companion::mcp_servers::set_enabled(&settings_state.0, &name, enabled)
}

/// 刷新：重连 + 重抓 tools/list 快照（失败保留旧快照，只更新连接状态）
#[tauri::command]
pub async fn refresh_external_mcp_server(
    settings_state: State<'_, SettingsState>,
    name: String,
) -> Result<crate::companion::mcp_servers::ExternalMcpServerInfo, String> {
    crate::companion::mcp_servers::refresh(&settings_state.0, &name).await
}

/// 更新第三方 server 配置（slug 不可改；凭据留空=保持原值、删行=清除）。
/// 保存后重探测刷新快照；验证失败且 force=false 时报错，前端确认后 force 重调。
#[tauri::command]
pub async fn update_external_mcp_server(
    settings_state: State<'_, SettingsState>,
    name: String,
    config: String,
    force: bool,
) -> Result<crate::companion::mcp_servers::ExternalMcpServerInfo, String> {
    let incoming: crate::companion::mcp_servers::ExternalMcpServer =
        serde_json::from_str(&config).map_err(|e| format!("配置解析失败: {}", e))?;
    crate::companion::mcp_servers::update(&settings_state.0, &name, incoming, force).await
}

/// 某 server 的最近调用日志（MCP 设置页日志弹窗，新在前）
#[tauri::command]
pub fn list_mcp_tool_calls(
    db_state: State<DatabaseState>,
    server_name: String,
) -> Result<Vec<crate::companion::db::McpToolCallLog>, String> {
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;
    crate::companion::db::list_mcp_tool_calls(&conn, &server_name, 50)
        .map_err(|e| e.to_string())
}

/// 读手册完整原文（含 frontmatter——编辑器里 schedule/enabled 也可改）
#[tauri::command]
pub fn get_manual(app_handle: AppHandle, name: String) -> Result<String, String> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    crate::companion::skills::load_skill_raw(&app_data, &name)
        .ok_or_else(|| format!("手册「{}」不存在", name))
}

/// 保存手册（内嵌编辑器）：校验 + 快照旧版 + 写入，下一轮扫描生效
#[tauri::command]
pub fn save_manual(app_handle: AppHandle, name: String, content: String) -> Result<(), String> {
    if content.len() > 32 * 1024 {
        return Err("手册内容过长（不超过 32KB）".to_string());
    }
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    crate::companion::skills::apply_manual_content(&app_data, &name, &content)
}

#[tauri::command]
pub fn list_evolution_backups(
    app_handle: AppHandle,
) -> Result<Vec<crate::companion::backup::BackupEntry>, String> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(crate::companion::backup::list_backups(&app_data))
}

/// 回滚到指定备份（回滚前先快照当前版——回滚本身可回滚）
#[tauri::command]
pub fn rollback_evolution_backup(
    app_handle: AppHandle,
    file: String,
    stamp: String,
) -> Result<(), String> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    crate::companion::backup::rollback_backup(&app_data, &file, &stamp)
}

/// 经验本当前容量（字节；治理视图容量条，硬上限 16KB）
#[tauri::command]
pub fn get_evolution_size(app_handle: AppHandle) -> Result<u64, String> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let path = app_data.join("companion").join("evolution.md");
    Ok(std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0))
}

/// 一键整理经验本：场景模型提炼冗余条目（去重/合并/删过时），
/// 保留四小节结构；快照兜底，登记观测 source=evolution_compact。
#[tauri::command]
pub async fn compact_evolution(
    app_handle: AppHandle,
    db_state: State<'_, DatabaseState>,
) -> Result<String, String> {
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let evolution = crate::companion::persona::load_evolution(&app_data);
    if evolution.len() < 14 * 1024 {
        return Ok("经验本还很空，不需要整理".to_string());
    }
    let prompt = format!(
        "整理这本工作经验本：去重、合并同类条目、删掉已被取代的过时经验，\
         保留所有仍有指导价值的条目原意。\
         必须保持原有小节结构（## 标题原样保留），条目格式 - [日期] 内容。\
         只输出整理后的完整经验本正文，不要任何前后缀。\n\n{}",
        evolution
    );
    let compacted = crate::companion::analyzer::call_scene_model_llm(
        &app_handle,
        &db_state.0,
        prompt,
        crate::llm_provider::models::Scene::Companion,
        "evolution_compact",
    )
    .await?;
    // 健全性校验：整理结果必须保留全部既有小节，否则拒绝覆盖
    let mut missing = Vec::new();
    for line in evolution.lines() {
        let line = line.trim_end();
        if line.starts_with("## ") && !compacted.contains(line) {
            missing.push(line);
        }
    }
    if compacted.trim().is_empty() || !missing.is_empty() {
        return Err(format!(
            "整理结果不完整（缺小节: {}），未覆盖原文件",
            missing.join("、")
        ));
    }
    if let Err(e) = crate::companion::backup::backup_file(&app_data, "evolution.md") {
        log::warn!("经验本整理前快照失败: {}", e);
    }
    std::fs::write(app_data.join("companion").join("evolution.md"), &compacted)
        .map_err(|e| format!("写入经验本失败: {}", e))?;
    Ok(format!(
        "整理完成：{} → {}（旧版已备份，可在备份列表回滚）",
        format_bytes(evolution.len()),
        format_bytes(compacted.len())
    ))
}

fn format_bytes(n: usize) -> String {
    if n >= 1024 {
        format!("{:.1}KB", n as f64 / 1024.0)
    } else {
        format!("{}B", n)
    }
}

// ── 工具管理（设置页「工具」页签）────────────────────────────────

/// 设置页工具清单条目
#[derive(Debug, serde::Serialize)]
pub struct CompanionToolInfo {
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub group: String,
    pub group_label: String,
    pub group_description: String,
    /// 核心工具锁定不可关
    pub core: bool,
    /// 对外数据面工具（MCP 通道暴露给外部客户端）
    pub external: bool,
    pub enabled: bool,
}

/// 全部工具（核心 + 扩展 + 第三方 MCP server 工具）及其开关状态
#[tauri::command]
pub fn list_companion_tools(
    settings_state: State<SettingsState>,
) -> Result<Vec<CompanionToolInfo>, String> {
    let disabled: Vec<String> = {
        let manager = settings_state.0.lock().map_err(|e| e.to_string())?;
        serde_json::from_str(&manager.get_settings().disabled_companion_tools).unwrap_or_default()
    };

    let mut infos = crate::companion::tools::all_tool_definitions()
        .into_iter()
        .map(|d| {
            let enabled = d.core || !disabled.iter().any(|n| n == d.name);
            CompanionToolInfo {
                name: d.name.to_string(),
                display_name: d.display_name.to_string(),
                // 工具描述是给模型看的使用指南，太长；设置页只取首行做简介
                description: d.description.lines().next().unwrap_or("").to_string(),
                group: d.group.id().to_string(),
                group_label: d.group.label().to_string(),
                group_description: d.group.description().to_string(),
                core: d.core,
                external: d.external,
                enabled,
            }
        })
        .collect::<Vec<_>>();

    // 第三方 MCP server 工具：按 server 分组追加（group id = "external:{server}"），
    // 工具 tab 渲染为「外部服务」区；开关存 disabled_companion_tools（带前缀全名）。
    // server 总开关关闭时整组仍列出但全部标 disabled——用户能看到「关了什么」
    for server in crate::companion::mcp_servers::load(&settings_state.0) {
        let display = if server.display_name.is_empty() {
            server.name.clone()
        } else {
            server.display_name.clone()
        };
        for tool in &server.tools {
            let full_name =
                crate::companion::mcp_servers::prefixed_tool_name(&server.name, &tool.name);
            infos.push(CompanionToolInfo {
                name: full_name.clone(),
                display_name: tool.name.clone(),
                description: tool.description.lines().next().unwrap_or("").to_string(),
                group: format!("external:{}", server.name),
                group_label: format!("外部服务 · {}", display),
                group_description: if server.enabled {
                    server.url.clone()
                } else {
                    format!("{}（server 已在 MCP 页关闭）", server.url)
                },
                core: false,
                external: false,
                enabled: server.enabled && !disabled.iter().any(|n| n == &full_name),
            });
        }
    }
    Ok(infos)
}

/// 开关一个非核心工具（核心工具调用直接报错；外部工具按前缀解析存在性）
#[tauri::command]
pub fn set_companion_tool_enabled(
    settings_state: State<'_, SettingsState>,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    let defs = crate::companion::tools::all_tool_definitions();
    match defs.iter().find(|d| d.name == name) {
        Some(def) => {
            if def.core {
                return Err(format!("「{}」是核心能力，不允许关闭", def.display_name));
            }
        }
        None => {
            // 内置清单没有 → 按外部工具前缀路由校验（server 存在且快照含该工具）
            let servers = crate::companion::mcp_servers::load(&settings_state.0);
            let resolved = crate::companion::mcp_servers::resolve_prefixed(&servers, &name);
            let valid = resolved
                .map(|(s, tool)| s.tools.iter().any(|t| t.name == tool))
                .unwrap_or(false);
            if !valid {
                return Err(format!("未知工具「{}」", name));
            }
        }
    }

    let manager = settings_state.0.lock().map_err(|e| e.to_string())?;
    let mut disabled: Vec<String> =
        serde_json::from_str(&manager.get_settings().disabled_companion_tools).unwrap_or_default();
    if enabled {
        disabled.retain(|n| n != &name);
    } else if !disabled.iter().any(|n| n == &name) {
        disabled.push(name.clone());
    }
    let json = serde_json::to_string(&disabled).map_err(|e| e.to_string())?;
    manager
        .set_setting("disabled_companion_tools", &json)
        .map_err(|e| format!("保存设置失败: {}", e))?;

    log::info!(
        "工具「{}」已{}",
        name,
        if enabled { "开启" } else { "关闭" }
    );
    Ok(())
}
