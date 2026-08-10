use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager, State};

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

/// toast 页面挂载后补拉待展示建议：预创建窗口的页面异步加载，
/// 首次 emit 可能早于监听器注册（事件即发即丢），挂载时主动补拉兜底
#[tauri::command]
pub fn get_pending_companion_toast(
    state: State<suggester::PendingToastState>,
) -> Option<db::Suggestion> {
    state.0.lock().ok().and_then(|pending| pending.clone())
}

/// toast 前端渲染完成回执：内容首帧就绪后才定位 + show + focus，消除透明空帧
#[tauri::command]
pub fn companion_toast_ready(
    app_handle: AppHandle,
    state: State<suggester::PendingToastState>,
) {
    suggester::show_toast_window(&app_handle);
    if let Ok(mut pending) = state.0.lock() {
        *pending = None;
    }
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

/// 手动触发一次日报 agent（阻塞执行，可能耗时几分钟，返回人话结果）
/// 归属与 0 点调度一致：生成「昨天」的日报
/// 需要先在「设置 → AI 模型」中开启全局 Claude Code
#[tauri::command]
pub async fn run_companion_agent_now(
    db_state: State<'_, DatabaseState>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let db_path = db_state.0.clone();
    let yesterday = (chrono::Local::now() - chrono::Duration::days(1))
        .format("%Y-%m-%d")
        .to_string();
    let cc_off = !crate::companion::claude_code_enabled(&app_handle);
    let db_for_task = db_path.clone();
    let date = yesterday.clone();
    let result = if cc_off {
        // Claude Code 未开启：回退场景模型版日报（陪伴绑定模型）
        tauri::async_runtime::spawn_blocking(move || {
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
        .map_err(|e| format!("agent 线程异常: {}", e))?
    } else {
        tauri::async_runtime::spawn_blocking(move || {
            crate::companion::run_agent_with_settings(&app_handle, &db_for_task, &date)
        })
        .await
        .map_err(|e| format!("agent 线程异常: {}", e))?
    };
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
    id: i64,
    status: String,
) -> Result<(), String> {
    if !["pending", "done", "dismissed"].contains(&status.as_str()) {
        return Err(format!("非法备忘状态: {}", status));
    }
    let conn = open_conn(&db_state)?;
    let now = chrono::Local::now().timestamp();
    db::set_memo_status(&conn, id, &status, now).map_err(|e| format!("更新备忘状态失败: {}", e))
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
        .map(|s| ManualInfo {
            name: s.name,
            description: s.description,
            trigger_description: s.trigger_description,
            schedule: s.schedule.as_ref().map(format_schedule),
            enabled: s.enabled,
        })
        .collect())
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
    pub enabled: bool,
}

/// 全部工具（核心 + 扩展）及其开关状态
#[tauri::command]
pub fn list_companion_tools(
    settings_state: State<SettingsState>,
) -> Result<Vec<CompanionToolInfo>, String> {
    let disabled: Vec<String> = {
        let manager = settings_state.0.lock().map_err(|e| e.to_string())?;
        serde_json::from_str(&manager.get_settings().disabled_companion_tools).unwrap_or_default()
    };

    let infos = crate::companion::tools::all_tool_definitions()
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
                enabled,
            }
        })
        .collect();
    Ok(infos)
}

/// 开关一个非核心工具（核心工具调用直接报错）
#[tauri::command]
pub fn set_companion_tool_enabled(
    settings_state: State<'_, SettingsState>,
    name: String,
    enabled: bool,
) -> Result<(), String> {
    let defs = crate::companion::tools::all_tool_definitions();
    let def = defs
        .iter()
        .find(|d| d.name == name)
        .ok_or_else(|| format!("未知工具「{}」", name))?;
    if def.core {
        return Err(format!("「{}」是核心能力，不允许关闭", def.display_name));
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
