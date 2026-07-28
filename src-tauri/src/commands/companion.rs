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
/// 需要先在「设置 → AI 模型」中开启全局 Claude Code
#[tauri::command]
pub async fn run_companion_agent_now(
    db_state: State<'_, DatabaseState>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let db_path = db_state.0.clone();
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let cc_off = !crate::companion::claude_code_enabled(&app_handle);
    let db_for_task = db_path.clone();
    let date = today.clone();
    let result = if cc_off {
        // Claude Code 未开启：回退场景模型版日报（陪伴绑定模型）
        tauri::async_runtime::spawn_blocking(move || {
            let notes_dir = crate::notes::get_default_notes_dir()
                .map_err(|e| format!("获取笔记目录失败: {}", e))?;
            tauri::async_runtime::block_on(crate::companion::analyzer::run_scene_report(
                &app_handle, &db_for_task, &notes_dir, &date,
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
    // 手动生成成功且笔记落盘 → 标记今日日报完成，避免 21 点调度重复生成
    if result.is_ok() {
        let note_written = crate::notes::get_default_notes_dir()
            .map(|d| {
                d.join(crate::companion::mcp::NOTE_DIR_PREFIX)
                    .join(format!("{}.md", today))
                    .exists()
            })
            .unwrap_or(false);
        if note_written {
            crate::companion::analyzer::save_setting(
                &db_path,
                "companion_last_report_date",
                &today,
            );
        }
    }
    result
}

// ── 意图（「记」）─────────────────────────────────────────────

/// 创建一条用户意图（launcher「记 xxx」入口）。
/// 原文立即落库（保真），触发器由 LLM 异步解析写回——解析失败不影响原文。
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
    let intent =
        db::create_intent(&conn, &text, now).map_err(|e| format!("保存备忘失败: {}", e))?;
    let id = intent.id;

    // 同步追加到笔记「陪伴日报/备忘.md」，随日报一起沉淀（失败不影响主流程）
    if let Err(e) = append_intent_to_note(&text, now) {
        log::warn!("备忘同步写入笔记失败: {}", e);
    }

    // 异步解析触发器（不阻塞 launcher 返回）
    let db_path = db_state.0.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = analyzer::parse_and_store_triggers(&app_handle, &db_path, id, &text).await {
            log::warn!("意图 #{} 触发器解析失败（保留原文兜底）: {}", id, e);
        }
    });

    Ok(id)
}

/// 备忘在笔记中的落点：与日报同目录（见 companion::mcp::NOTE_DIR_PREFIX），单文件按日期分组沉淀
const INTENT_NOTE_RELATIVE: &str = "陪伴日报/备忘.md";

/// 把「记 xxx」备忘追加到笔记「陪伴日报/备忘.md」。
/// 笔记是查看与归档面；SQLite 仍是提醒触发的数据源（v1 单向写入，状态不回写）。
fn append_intent_to_note(text: &str, now: i64) -> Result<(), String> {
    let notes_dir = crate::notes::get_default_notes_dir().map_err(|e| e.to_string())?;
    let note_exists = notes_dir.join(INTENT_NOTE_RELATIVE).exists();
    let manager = crate::notes::NotesManager::new(notes_dir);

    let dt = chrono::DateTime::from_timestamp(now, 0)
        .ok_or_else(|| "备忘时间戳无效".to_string())?
        .with_timezone(&chrono::Local);
    let heading = format!("## {}", dt.format("%Y-%m-%d"));
    let entry = format!("- [ ] {} {}", dt.format("%H:%M"), text);

    let content = if note_exists {
        // 文件存在但读取失败（编码错误、被占用等）：向上报错，绝不覆盖原文件
        let note = manager
            .read_note(INTENT_NOTE_RELATIVE)
            .map_err(|e| format!("读取备忘笔记失败（原文件未改动）: {}", e))?;
        insert_note_entry(&note.content, &heading, &entry)
    } else {
        format!("# 备忘\n\n{}\n{}\n", heading, entry)
    };
    manager
        .write_note(INTENT_NOTE_RELATIVE, &content)
        .map_err(|e| format!("写入备忘笔记失败: {}", e))
}

/// 将一条备忘插入既有内容：今天的分组已存在则插到组内最前（最新在前），
/// 否则在「# 备忘」标题后新开日期分组（最新日期在最上）。
/// 容忍 UTF-8 BOM 与空文件（视为全新文件）。
fn insert_note_entry(content: &str, heading: &str, entry: &str) -> String {
    let content = content.trim_start_matches('\u{feff}');
    if content.trim().is_empty() {
        return format!("# 备忘\n\n{}\n{}\n", heading, entry);
    }

    let mut lines: Vec<&str> = content.lines().collect();

    if let Some(idx) = lines.iter().position(|l| l.trim() == heading) {
        lines.insert(idx + 1, entry);
    } else {
        let insert_at = lines
            .iter()
            .position(|l| l.starts_with("# "))
            .map(|i| i + 1)
            .unwrap_or(0);
        lines.insert(insert_at, entry);
        lines.insert(insert_at, heading);
        lines.insert(insert_at, "");
    }

    let mut result = lines.join("\n");
    if !result.ends_with('\n') {
        result.push('\n');
    }
    result
}

/// 列出用户意图（备忘的查看/归档面已迁至笔记，此命令保留给后续消费方）
#[tauri::command]
pub fn get_companion_intents(
    db_state: State<DatabaseState>,
    limit: Option<i64>,
) -> Result<Vec<db::Suggestion>, String> {
    let conn = open_conn(&db_state)?;
    db::list_intents(&conn, limit.unwrap_or(100)).map_err(|e| format!("查询备忘失败: {}", e))
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
pub fn delete_companion_memory_fact(
    db_state: State<DatabaseState>,
    id: i64,
) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::insert_note_entry;

    #[test]
    fn insert_into_existing_day_group_puts_newest_first() {
        let content = "# 备忘\n\n## 2026-07-27\n- [ ] 09:00 早前的备忘\n";
        let result = insert_note_entry(content, "## 2026-07-27", "- [ ] 14:30 新备忘");
        assert_eq!(
            result,
            "# 备忘\n\n## 2026-07-27\n- [ ] 14:30 新备忘\n- [ ] 09:00 早前的备忘\n"
        );
    }

    #[test]
    fn insert_new_day_group_after_title() {
        let content = "# 备忘\n\n## 2026-07-26\n- [ ] 18:00 昨天的备忘\n";
        let result = insert_note_entry(content, "## 2026-07-27", "- [ ] 08:15 今天的备忘");
        assert_eq!(
            result,
            "# 备忘\n\n## 2026-07-27\n- [ ] 08:15 今天的备忘\n\n## 2026-07-26\n- [ ] 18:00 昨天的备忘\n"
        );
    }

    #[test]
    fn insert_without_title_prepends_group() {
        let content = "一些用户自己写的内容\n";
        let result = insert_note_entry(content, "## 2026-07-27", "- [ ] 08:15 备忘");
        assert_eq!(
            result,
            "\n## 2026-07-27\n- [ ] 08:15 备忘\n一些用户自己写的内容\n"
        );
    }

    #[test]
    fn insert_strips_utf8_bom_before_matching_title() {
        let content = "\u{feff}# 备忘\n\n## 2026-07-26\n- [ ] 18:00 昨天的备忘\n";
        let result = insert_note_entry(content, "## 2026-07-27", "- [ ] 08:15 今天的备忘");
        assert_eq!(
            result,
            "# 备忘\n\n## 2026-07-27\n- [ ] 08:15 今天的备忘\n\n## 2026-07-26\n- [ ] 18:00 昨天的备忘\n"
        );
    }

    #[test]
    fn insert_into_empty_file_uses_fresh_template() {
        let result = insert_note_entry("  \n", "## 2026-07-27", "- [ ] 08:15 备忘");
        assert_eq!(result, "# 备忘\n\n## 2026-07-27\n- [ ] 08:15 备忘\n");
    }
}
