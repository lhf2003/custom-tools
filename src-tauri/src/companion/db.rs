use chrono::Datelike;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// 一条前台窗口活动记录（连续使用同一进程+标题的时段）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityLog {
    pub id: i64,
    pub process_name: String,
    pub window_title: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub duration_secs: Option<i64>,
}

/// LLM 挖掘出的工作习惯模式
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HabitPattern {
    pub id: i64,
    pub pattern_type: String,
    pub signature: String,
    pub description: String,
    pub pattern_data: String,
    pub confidence: f64,
    pub occurrences: i64,
    pub status: String,
    pub first_seen: i64,
    pub last_seen: i64,
}

/// 一段增量分析窗口的叙事小结（analyst 产出，日报/日记/明日关注复用）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeriodSummary {
    pub id: i64,
    pub window_start: i64,
    pub window_end: i64,
    pub summary: String,
    pub activity_count: i64,
    pub created_at: i64,
}

/// 一条主动建议 / 一条用户意图（统一 suggestion 流）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Suggestion {
    pub id: i64,
    pub suggestion_type: String,
    pub title: String,
    pub body: Option<String>,
    pub action_payload: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub acted_at: Option<i64>,
    /// 来源："system"（系统建议）| "user"（用户暂存的意图）
    pub source: Option<String>,
    /// 意图触发器 JSON（IntentTriggers）
    pub trigger_data: Option<String>,
    /// 意图到期日 YYYY-MM-DD（到期前不参与情境触发）
    pub due_date: Option<String>,
    /// 上次情境触发时间（避免同日重复打扰）
    pub last_triggered_at: Option<i64>,
}

/// 意图触发器（由 LLM 从原文解析，仅作索引，原文永保真）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IntentTriggers {
    #[serde(default)]
    pub due: Option<String>,
    #[serde(default)]
    pub person: Option<String>,
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
}

/// 一条备忘（memos 表——备忘唯一真源；suggestions 表只装系统建议/通知流）
///
/// 设计裁决（2026-07-29 拷问定稿）：
/// - 双文本：content_raw 原文保真永不动；content 是 LLM 重构的展示文本
///   （剥时间词/「提醒我」元话、保留人物，解析失败兜底=原文）
/// - 三态状态机：pending → done（完成）/ dismissed（忽略），acted_at 记处置时间
/// - 7 天未动降级是查询时逻辑（created_at 判断），不进状态机
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Memo {
    pub id: i64,
    pub content: String,
    pub content_raw: String,
    pub status: String,
    pub acted_at: Option<i64>,
    /// 到期日 YYYY-MM-DD（到期前不进主动面）
    pub due_date: Option<String>,
    /// 触发器 JSON（IntentTriggers），LLM 异步写回
    pub trigger_data: Option<String>,
    /// 上次情境触发时间（同日不重复弹）
    pub last_triggered_at: Option<i64>,
    /// 置顶（展示面 pinned 组在最上；done 后保留标记，勾回 pending 复活）
    pub pinned: bool,
    /// 到期通知 one-shot 标记：晨间汇总展示或 tick 捡漏提醒后落时间，不再重复弹
    pub due_notified_at: Option<i64>,
    /// 分类标签（封闭集单标签，LLM 解析时归类；存量备忘为 NULL）
    pub tag: Option<String>,
    /// 重复规则：daily / weekly:1-7（1=周一…7=周日），完成后自动生成下一次
    pub recurrence: Option<String>,
    pub created_at: i64,
}

/// 建议动作负载：批量启动应用（工作套装）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchAppsPayload {
    pub action: String, // 固定 "launch_apps"
    pub apps: Vec<LaunchAppItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LaunchAppItem {
    pub path: String,
    pub name: String,
}

/// 建议动作负载：发送内容到 AI 对话分析
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyzePayload {
    pub action: String, // 固定 "analyze"
    pub content: String,
}

/// 建议动作负载：应用手册修改提案（manual_edit 建议接受时执行）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManualEditPayload {
    pub action: String, // 固定 "apply_manual_edit"
    pub name: String,
    pub new_content: String,
}

pub fn init_tables(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS activity_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            process_name TEXT NOT NULL,
            window_title TEXT NOT NULL DEFAULT '',
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            duration_secs INTEGER
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_activity_started ON activity_log(started_at)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_activity_process ON activity_log(process_name)",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS habit_patterns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pattern_type TEXT NOT NULL,
            signature TEXT NOT NULL UNIQUE,
            description TEXT NOT NULL,
            pattern_data TEXT NOT NULL,
            confidence REAL DEFAULT 0,
            occurrences INTEGER DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'learning'
                CHECK (status IN ('learning', 'confirmed', 'dismissed')),
            first_seen INTEGER NOT NULL,
            last_seen INTEGER NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS suggestions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            suggestion_type TEXT NOT NULL,
            title TEXT NOT NULL,
            body TEXT,
            action_payload TEXT,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'dismissed', 'seen')),
            created_at INTEGER NOT NULL,
            acted_at INTEGER,
            source TEXT DEFAULT 'system',
            trigger_data TEXT,
            due_date TEXT,
            last_triggered_at INTEGER,
            pattern_id INTEGER
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status, created_at DESC)",
        [],
    )?;

    // memos：备忘唯一真源（2026-07-29 重构，从 suggestions.intent 分家）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS memos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            content_raw TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'done', 'dismissed')),
            acted_at INTEGER,
            due_date TEXT,
            trigger_data TEXT,
            last_triggered_at INTEGER,
            pinned INTEGER NOT NULL DEFAULT 0,
            due_notified_at INTEGER,
            tag TEXT,
            recurrence TEXT,
            created_at INTEGER NOT NULL
        )",
        [],
    )?;
    // 幂等迁移：旧库补列（PRAGMA 探列，缺失才 ALTER）
    ensure_memo_column(conn, "pinned", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_memo_column(conn, "due_notified_at", "INTEGER")?;
    ensure_memo_column(conn, "tag", "TEXT")?;
    ensure_memo_column(conn, "recurrence", "TEXT")?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memos_status ON memos(status, created_at DESC)",
        [],
    )?;

    // 个人记忆层：关于用户的持久事实（B3）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS memory_facts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fact TEXT NOT NULL UNIQUE,
            category TEXT NOT NULL DEFAULT 'general',
            source TEXT NOT NULL DEFAULT 'analysis',
            confirmations INTEGER DEFAULT 1,
            created_at INTEGER NOT NULL,
            last_confirmed INTEGER NOT NULL
        )",
        [],
    )?;

    // 记忆变更审计：每条事实的创建/确认/覆盖/删除都留痕（记忆中心可追溯）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS memory_fact_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fact_id INTEGER,
            action TEXT NOT NULL CHECK (action IN ('add','confirm','update','delete')),
            old_text TEXT,
            new_text TEXT,
            category TEXT,
            source TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_memory_fact_events_fact
         ON memory_fact_events(fact_id, id DESC)",
        [],
    )?;

    // 日内情绪状态机：贾维斯自己的心情条目（五期）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS emotion_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT NOT NULL
                CHECK (category IN ('happy','content','tired','upset','caring','weary')),
            reason TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'agent',
            created_at INTEGER NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_emotion_entries_created
         ON emotion_entries(created_at)",
        [],
    )?;

    // 时段小结：analyst 每次增量分析的叙事沉淀（日报/日记/明日关注的复用素材）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS period_summaries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            window_start INTEGER NOT NULL,
            window_end INTEGER NOT NULL,
            summary TEXT NOT NULL,
            activity_count INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_period_summaries_window
         ON period_summaries(window_start)",
        [],
    )?;

    // 第三方 MCP 工具调用日志（MCP 设置页 per-server 日志弹窗）
    conn.execute(
        "CREATE TABLE IF NOT EXISTS mcp_tool_calls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            server_name TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'ok',
            duration_ms INTEGER NOT NULL DEFAULT 0,
            result_len INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_server
         ON mcp_tool_calls(server_name, id DESC)",
        [],
    )?;

    Ok(())
}

// ── activity_log ─────────────────────────────────────────────

pub fn insert_activity(
    conn: &Connection,
    process_name: &str,
    window_title: &str,
    started_at: i64,
) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO activity_log (process_name, window_title, started_at) VALUES (?1, ?2, ?3)",
        params![process_name, window_title, started_at],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 闭合一条活动记录（或心跳刷新 ended_at/duration）
pub fn close_activity(conn: &Connection, id: i64, ended_at: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE activity_log
         SET ended_at = ?2,
             duration_secs = MAX(0, ?2 - started_at)
         WHERE id = ?1",
        params![id, ended_at],
    )?;
    Ok(())
}

/// 当前未闭合的活动段（进程名, 开始时间）；无则 None（AFK 或未采集）。
/// 未闭合但开始于 5 分钟前的视为关机/崩溃残留残段，不当作当前段（启动清理外的兜底）。
pub fn current_open_activity(
    conn: &Connection,
    now: i64,
) -> rusqlite::Result<Option<(String, i64)>> {
    conn.query_row(
        "SELECT process_name, started_at FROM activity_log
         WHERE ended_at IS NULL AND started_at >= ?1
         ORDER BY started_at DESC LIMIT 1",
        [now - super::AFK_THRESHOLD_SECS],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
}

/// 闭合开始于 `before` 之前的未闭合段（0 时长），用于启动时清理关机残留，
/// 避免隔夜残段被当成「连续工作」起点或污染时间线统计。返回清理条数。
pub fn close_stale_open_activities(
    conn: &Connection,
    before: i64,
) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE activity_log
         SET ended_at = started_at, duration_secs = 0
         WHERE ended_at IS NULL AND started_at < ?1",
        [before],
    )
}

/// 查询某时间范围内的活动记录（按开始时间升序）
pub fn activities_between(
    conn: &Connection,
    start: i64,
    end: i64,
) -> rusqlite::Result<Vec<ActivityLog>> {
    let mut stmt = conn.prepare(
        "SELECT id, process_name, window_title, started_at, ended_at, duration_secs
         FROM activity_log
         WHERE started_at >= ?1 AND started_at < ?2
         ORDER BY started_at ASC",
    )?;
    let rows = stmt.query_map(params![start, end], |row| {
        Ok(ActivityLog {
            id: row.get(0)?,
            process_name: row.get(1)?,
            window_title: row.get(2)?,
            started_at: row.get(3)?,
            ended_at: row.get(4)?,
            duration_secs: row.get(5)?,
        })
    })?;
    rows.collect()
}

/// 今日各进程累计时长（秒），按时长降序
pub fn process_totals_between(
    conn: &Connection,
    start: i64,
    end: i64,
) -> rusqlite::Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT process_name, SUM(COALESCE(duration_secs, 0)) AS total
         FROM activity_log
         WHERE started_at >= ?1 AND started_at < ?2
         GROUP BY process_name
         ORDER BY total DESC",
    )?;
    let rows = stmt.query_map(params![start, end], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    rows.collect()
}

pub fn cleanup_activities_older_than(conn: &Connection, cutoff: i64) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM activity_log WHERE started_at < ?1",
        params![cutoff],
    )
}

pub fn cleanup_suggestions_older_than(conn: &Connection, cutoff: i64) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM suggestions WHERE created_at < ?1 AND status != 'pending'",
        params![cutoff],
    )
}

// ── period_summaries ─────────────────────────────────────────

pub fn insert_period_summary(
    conn: &Connection,
    window_start: i64,
    window_end: i64,
    summary: &str,
    activity_count: i64,
    created_at: i64,
) -> rusqlite::Result<i64> {
    conn.execute(
        "INSERT INTO period_summaries (window_start, window_end, summary, activity_count, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![window_start, window_end, summary, activity_count, created_at],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 窗口起点落在 [start, end) 内的时段小结（按窗口起点升序）。
/// 归属按 window_start：0 点 slot 的窗口（18:00-24:00）起点在昨天，归昨天。
pub fn period_summaries_between(
    conn: &Connection,
    start: i64,
    end: i64,
) -> rusqlite::Result<Vec<PeriodSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, window_start, window_end, summary, activity_count, created_at
         FROM period_summaries
         WHERE window_start >= ?1 AND window_start < ?2
         ORDER BY window_start ASC",
    )?;
    let rows = stmt.query_map(params![start, end], |row| {
        Ok(PeriodSummary {
            id: row.get(0)?,
            window_start: row.get(1)?,
            window_end: row.get(2)?,
            summary: row.get(3)?,
            activity_count: row.get(4)?,
            created_at: row.get(5)?,
        })
    })?;
    rows.collect()
}

pub fn cleanup_period_summaries_older_than(
    conn: &Connection,
    cutoff: i64,
) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM period_summaries WHERE window_start < ?1",
        params![cutoff],
    )
}

// ── suggestions ──────────────────────────────────────────────

const SUGGESTION_COLS: &str =
    "id, suggestion_type, title, body, action_payload, status, created_at, acted_at,
     source, trigger_data, due_date, last_triggered_at";

fn map_suggestion(row: &rusqlite::Row) -> rusqlite::Result<Suggestion> {
    Ok(Suggestion {
        id: row.get(0)?,
        suggestion_type: row.get(1)?,
        title: row.get(2)?,
        body: row.get(3)?,
        action_payload: row.get(4)?,
        status: row.get(5)?,
        created_at: row.get(6)?,
        acted_at: row.get(7)?,
        source: row.get(8)?,
        trigger_data: row.get(9)?,
        due_date: row.get(10)?,
        last_triggered_at: row.get(11)?,
    })
}

pub fn create_suggestion(
    conn: &Connection,
    suggestion_type: &str,
    title: &str,
    body: Option<&str>,
    action_payload: Option<&str>,
    now: i64,
) -> rusqlite::Result<Suggestion> {
    conn.execute(
        "INSERT INTO suggestions (suggestion_type, title, body, action_payload, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![suggestion_type, title, body, action_payload, now],
    )?;
    Ok(Suggestion {
        id: conn.last_insert_rowid(),
        suggestion_type: suggestion_type.to_string(),
        title: title.to_string(),
        body: body.map(|s| s.to_string()),
        action_payload: action_payload.map(|s| s.to_string()),
        status: "pending".to_string(),
        created_at: now,
        acted_at: None,
        source: Some("system".to_string()),
        trigger_data: None,
        due_date: None,
        last_triggered_at: None,
    })
}

// ── memos（备忘唯一真源）─────────────────────────────────────

/// 幂等迁移：memos 表补列（PRAGMA 探列，缺失才 ALTER；与 db/mod.rs 的既有先例同法）
fn ensure_memo_column(conn: &Connection, name: &str, ddl: &str) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(memos)")?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    if !columns.iter().any(|c| c == name) {
        conn.execute(&format!("ALTER TABLE memos ADD COLUMN {} {}", name, ddl), [])?;
    }
    Ok(())
}

const MEMO_COLS: &str =
    "id, content, content_raw, status, acted_at, due_date, trigger_data, last_triggered_at, pinned, due_notified_at, tag, recurrence, created_at";

fn map_memo(row: &rusqlite::Row) -> rusqlite::Result<Memo> {
    Ok(Memo {
        id: row.get(0)?,
        content: row.get(1)?,
        content_raw: row.get(2)?,
        status: row.get(3)?,
        acted_at: row.get(4)?,
        due_date: row.get(5)?,
        trigger_data: row.get(6)?,
        last_triggered_at: row.get(7)?,
        pinned: row.get(8)?,
        due_notified_at: row.get(9)?,
        tag: row.get(10)?,
        recurrence: row.get(11)?,
        created_at: row.get(12)?,
    })
}

/// 创建备忘：content 先等于原文，LLM 解析成功后写回重构文本（失败兜底=原文）
pub fn create_memo(conn: &Connection, raw: &str, now: i64) -> rusqlite::Result<Memo> {
    conn.execute(
        "INSERT INTO memos (content, content_raw, created_at) VALUES (?1, ?2, ?3)",
        params![raw, raw, now],
    )?;
    Ok(Memo {
        id: conn.last_insert_rowid(),
        content: raw.to_string(),
        content_raw: raw.to_string(),
        status: "pending".to_string(),
        acted_at: None,
        due_date: None,
        trigger_data: None,
        last_triggered_at: None,
        pinned: false,
        due_notified_at: None,
        tag: None,
        recurrence: None,
        created_at: now,
    })
}

/// LLM 解析完成写回：重构正文 + 触发器 + 到期日 + 标签 + 重复规则（一次写全，避免半更新状态）
pub fn update_memo_parse(
    conn: &Connection,
    id: i64,
    content: &str,
    trigger_data: Option<&str>,
    due_date: Option<&str>,
    tag: Option<&str>,
    recurrence: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE memos SET content = ?2, trigger_data = ?3, due_date = ?4, tag = ?5, recurrence = ?6 WHERE id = ?1",
        params![id, content, trigger_data, due_date, tag, recurrence],
    )?;
    Ok(())
}

/// 处置备忘（done / dismissed / 回 pending），acted_at 仅处置态落时间。
/// 返回实际发生迁移的行数：重复处置同一状态为 0（命令层据此跳过重复备忘重生）
pub fn set_memo_status(conn: &Connection, id: i64, status: &str, now: i64) -> rusqlite::Result<usize> {
    let acted: Option<i64> = if status == "pending" { None } else { Some(now) };
    conn.execute(
        "UPDATE memos SET status = ?2, acted_at = ?3 WHERE id = ?1 AND status != ?2",
        params![id, status, acted],
    )
}

/// 批量处置备忘（菜单「全部标为完成」「清空已完成」）：单条 UPDATE，
/// 迁移白名单在命令层收窄，这里只贯彻 acted_at 语义（处置态落时间、回 pending 清空）
pub fn bulk_set_memo_status(
    conn: &Connection,
    from_status: &str,
    to_status: &str,
    now: i64,
) -> rusqlite::Result<usize> {
    let acted: Option<i64> = if to_status == "pending" { None } else { Some(now) };
    conn.execute(
        "UPDATE memos SET status = ?2, acted_at = ?3 WHERE status = ?1",
        params![from_status, to_status, acted],
    )
}

/// 置顶/取消置顶（视图 pin 按钮）
pub fn set_memo_pinned(conn: &Connection, id: i64, pinned: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE memos SET pinned = ?2 WHERE id = ?1",
        params![id, pinned],
    )?;
    Ok(())
}

/// 单条查询（重复重生等需要整行的场景）
pub fn get_memo(conn: &Connection, id: i64) -> rusqlite::Result<Memo> {
    let sql = format!("SELECT {} FROM memos WHERE id = ?1", MEMO_COLS);
    conn.query_row(&sql, params![id], map_memo)
}

/// 待办中的重复备忘（批量完成时用于重生下一次，需在批量 UPDATE 前捞取）
pub fn list_pending_recurring(conn: &Connection) -> rusqlite::Result<Vec<Memo>> {
    let sql = format!(
        "SELECT {} FROM memos WHERE status = 'pending' AND recurrence IS NOT NULL",
        MEMO_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], map_memo)?;
    rows.collect()
}

/// 重复规则的下一次到期：daily → 明天；weekly:N（1=周一…7=周日）→ 往后下一个周 N
/// （今天即周 N 则取下周——今天这条刚完成）
fn next_due_date(today: chrono::NaiveDate, recurrence: &str) -> Option<chrono::NaiveDate> {
    if recurrence == "daily" {
        return Some(today + chrono::Duration::days(1));
    }
    let target: u32 = recurrence.strip_prefix("weekly:")?.parse().ok()?;
    if !(1..=7).contains(&target) {
        return None;
    }
    let current = today.weekday().num_days_from_monday() + 1; // 1..=7
    let delta = if target > current {
        target - current
    } else {
        7 - (current - target)
    };
    Some(today + chrono::Duration::days(delta as i64))
}

/// 重复备忘完成时生成下一次 occurrence：内容/原文/标签/触发器/规则/置顶状态照抄
/// （钉在桌面便签的重复备忘，完成一次后下一次仍在桌面；取消钉当前一条即整链退出），
/// due 推到下一周期；通知与处置状态全新（新行即新审计段，历史 occurrence 自然留痕）
pub fn create_next_recurrence(
    conn: &Connection,
    memo: &Memo,
    now: i64,
) -> rusqlite::Result<()> {
    let Some(recurrence) = memo.recurrence.as_deref() else {
        return Ok(());
    };
    let today = chrono::DateTime::from_timestamp(now, 0)
        .map(|utc| utc.with_timezone(&chrono::Local).date_naive());
    let next = today.and_then(|t| next_due_date(t, recurrence));
    let Some(next) = next else {
        return Ok(());
    };
    let due = next.format("%Y-%m-%d").to_string();
    conn.execute(
        "INSERT INTO memos (content, content_raw, due_date, trigger_data, tag, recurrence, pinned, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            memo.content,
            memo.content_raw,
            due,
            memo.trigger_data,
            memo.tag,
            memo.recurrence,
            memo.pinned,
            now
        ],
    )?;
    Ok(())
}

/// 标记到期提醒已发（晨间汇总展示 / tick 捡漏后调用，one-shot）
pub fn mark_memos_due_notified(
    conn: &Connection,
    ids: &[i64],
    now: i64,
) -> rusqlite::Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "UPDATE memos SET due_notified_at = ?1 WHERE id IN ({})",
        placeholders
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(now)];
    for id in ids {
        param_values.push(Box::new(*id));
    }
    let refs: Vec<&dyn rusqlite::types::ToSql> =
        param_values.iter().map(|p| p.as_ref()).collect();
    stmt.execute(refs.as_slice())?;
    Ok(())
}

/// tick 捡漏：今天已到期（含逾期）但尚未提醒过的 pending 备忘
/// （晨间汇总已展示的会被标记，天然不重复）
pub fn list_memos_due_unnotified(conn: &Connection, today: &str) -> rusqlite::Result<Vec<Memo>> {
    let sql = format!(
        "SELECT {} FROM memos
         WHERE status = 'pending' AND due_date IS NOT NULL AND due_date <= ?1
           AND due_notified_at IS NULL
         ORDER BY due_date ASC, created_at DESC",
        MEMO_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![today], map_memo)?;
    rows.collect()
}

/// 主动面用的待处理备忘（晨间汇总/情境触发/list_memos 工具共用）。
/// 7 天降级与 due 过滤在调用方做（与展示面「全部 pending」口径区分）
pub fn list_memos_active(conn: &Connection) -> rusqlite::Result<Vec<Memo>> {
    let sql = format!(
        "SELECT {} FROM memos WHERE status = 'pending' ORDER BY created_at ASC",
        MEMO_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], map_memo)?;
    rows.collect()
}

/// 备忘视图用：pending 在前（置顶优先、其余旧→新），已处置在后（新处置在前），封顶 limit
pub fn list_memos_for_view(conn: &Connection, limit: i64) -> rusqlite::Result<Vec<Memo>> {
    let sql = format!(
        "SELECT {} FROM memos
         ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
                  CASE WHEN status = 'pending' THEN -pinned ELSE 0 END,
                  CASE WHEN status = 'pending' THEN created_at ELSE -created_at END
         LIMIT ?1",
        MEMO_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![limit], map_memo)?;
    rows.collect()
}

/// 触发器尚未解析的 pending 备忘（重试补解析用）
pub fn list_memos_unparsed(conn: &Connection, limit: i64) -> rusqlite::Result<Vec<Memo>> {
    let sql = format!(
        "SELECT {} FROM memos WHERE status = 'pending' AND trigger_data IS NULL
         ORDER BY created_at ASC LIMIT ?1",
        MEMO_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![limit], map_memo)?;
    rows.collect()
}

pub fn touch_memo_triggered(conn: &Connection, id: i64, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE memos SET last_triggered_at = ?2 WHERE id = ?1",
        params![id, now],
    )?;
    Ok(())
}

/// 关联建议到行为链模式（毕业制投票数据）
pub fn link_suggestion_pattern(
    conn: &Connection,
    id: i64,
    pattern_id: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE suggestions SET pattern_id = ?2 WHERE id = ?1",
        params![id, pattern_id],
    )?;
    Ok(())
}

// ── memory_facts（个人记忆层）────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryFact {
    pub id: i64,
    pub fact: String,
    pub category: String,
    pub source: String,
    pub confirmations: i64,
    pub created_at: i64,
    pub last_confirmed: i64,
}

/// 一条记忆变更审计事件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryFactEvent {
    pub id: i64,
    pub fact_id: Option<i64>,
    pub action: String,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    pub category: Option<String>,
    pub source: String,
    pub created_at: i64,
}

/// 一条待写入的记忆审计事件（log_fact_event 的参数包，避免超长参数列表）
struct FactEvent<'a> {
    fact_id: Option<i64>,
    action: &'a str,
    old_text: Option<&'a str>,
    new_text: Option<&'a str>,
    category: Option<&'a str>,
    source: &'a str,
    now: i64,
}

/// 写一条记忆审计事件（内部工具，所有记忆写路径共用）
fn log_fact_event(conn: &Connection, event: FactEvent) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO memory_fact_events (fact_id, action, old_text, new_text, category, source, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            event.fact_id,
            event.action,
            event.old_text,
            event.new_text,
            event.category,
            event.source,
            event.now
        ],
    )?;
    Ok(())
}

/// 幂等写入事实：已存在则累计确认次数。新增/确认都写审计事件。
pub fn upsert_memory_fact(
    conn: &Connection,
    fact: &str,
    category: &str,
    source: &str,
    now: i64,
) -> rusqlite::Result<()> {
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id FROM memory_facts WHERE fact = ?1",
            params![fact],
            |row| row.get(0),
        )
        .optional()?;

    match existing {
        Some(id) => {
            conn.execute(
                "UPDATE memory_facts SET confirmations = confirmations + 1, last_confirmed = ?2
                 WHERE id = ?1",
                params![id, now],
            )?;
            log_fact_event(
                conn,
                FactEvent {
                    fact_id: Some(id),
                    action: "confirm",
                    old_text: None,
                    new_text: Some(fact),
                    category: Some(category),
                    source,
                    now,
                },
            )?;
        }
        None => {
            conn.execute(
                "INSERT INTO memory_facts (fact, category, source, confirmations, created_at, last_confirmed)
                 VALUES (?1, ?2, ?3, 1, ?4, ?4)",
                params![fact, category, source, now],
            )?;
            let id = conn.last_insert_rowid();
            log_fact_event(
                conn,
                FactEvent {
                    fact_id: Some(id),
                    action: "add",
                    old_text: None,
                    new_text: Some(fact),
                    category: Some(category),
                    source,
                    now,
                },
            )?;
        }
    }
    Ok(())
}

/// 按 id 确认一条事实（两级流水线 NOOP 裁决：语义重复不写入, 只累计确认）
pub fn confirm_memory_fact(
    conn: &Connection,
    id: i64,
    source: &str,
    now: i64,
) -> rusqlite::Result<()> {
    let text: Option<String> = conn
        .query_row(
            "SELECT fact FROM memory_facts WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(text) = text else { return Ok(()) };
    conn.execute(
        "UPDATE memory_facts SET confirmations = confirmations + 1, last_confirmed = ?2 WHERE id = ?1",
        params![id, now],
    )?;
    log_fact_event(
        conn,
        FactEvent {
            fact_id: Some(id),
            action: "confirm",
            old_text: None,
            new_text: Some(&text),
            category: None,
            source,
            now,
        },
    )?;
    Ok(())
}

/// 覆盖一条事实的文本与分类（提取管道 update 动作 / 用户编辑），confirmations 保留
pub fn update_memory_fact(
    conn: &Connection,
    id: i64,
    new_fact: &str,
    new_category: &str,
    source: &str,
    now: i64,
) -> rusqlite::Result<()> {
    let old: Option<(String, String)> = conn
        .query_row(
            "SELECT fact, category FROM memory_facts WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((old_fact, _old_category)) = old else {
        return Ok(());
    };
    conn.execute(
        "UPDATE memory_facts SET fact = ?2, category = ?3, last_confirmed = ?4 WHERE id = ?1",
        params![id, new_fact, new_category, now],
    )?;
    log_fact_event(
        conn,
        FactEvent {
            fact_id: Some(id),
            action: "update",
            old_text: Some(&old_fact),
            new_text: Some(new_fact),
            category: Some(new_category),
            source,
            now,
        },
    )?;
    Ok(())
}

/// 删除一条事实并写审计（事件存文本快照，历史不随删除丢失）
pub fn delete_memory_fact_audited(
    conn: &Connection,
    id: i64,
    source: &str,
    now: i64,
) -> rusqlite::Result<()> {
    let old: Option<(String, String)> = conn
        .query_row(
            "SELECT fact, category FROM memory_facts WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((old_fact, old_category)) = old {
        conn.execute("DELETE FROM memory_facts WHERE id = ?1", params![id])?;
        log_fact_event(
            conn,
            FactEvent {
                fact_id: Some(id),
                action: "delete",
                old_text: Some(&old_fact),
                new_text: None,
                category: Some(&old_category),
                source,
                now,
            },
        )?;
    }
    Ok(())
}

pub fn list_memory_facts(conn: &Connection, limit: i64) -> rusqlite::Result<Vec<MemoryFact>> {
    let mut stmt = conn.prepare(
        "SELECT id, fact, category, source, confirmations, created_at, last_confirmed
         FROM memory_facts
         ORDER BY confirmations DESC, last_confirmed DESC
         LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit], |row| {
        Ok(MemoryFact {
            id: row.get(0)?,
            fact: row.get(1)?,
            category: row.get(2)?,
            source: row.get(3)?,
            confirmations: row.get(4)?,
            created_at: row.get(5)?,
            last_confirmed: row.get(6)?,
        })
    })?;
    rows.collect()
}

/// 按分类维度取事实（日报/分析选维注入用），按确认度降序
pub fn list_memory_facts_by_categories(
    conn: &Connection,
    categories: &[&str],
    limit: i64,
) -> rusqlite::Result<Vec<MemoryFact>> {
    if categories.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = categories
        .iter()
        .enumerate()
        .map(|(i, _)| format!("?{}", i + 2))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT id, fact, category, source, confirmations, created_at, last_confirmed
         FROM memory_facts
         WHERE category IN ({})
         ORDER BY confirmations DESC, last_confirmed DESC
         LIMIT ?1",
        placeholders
    );
    let mut stmt = conn.prepare(&sql)?;
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(limit)];
    for c in categories {
        params_vec.push(Box::new(c.to_string()));
    }
    let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
    let rows = stmt.query_map(&param_refs[..], |row| {
        Ok(MemoryFact {
            id: row.get(0)?,
            fact: row.get(1)?,
            category: row.get(2)?,
            source: row.get(3)?,
            confirmations: row.get(4)?,
            created_at: row.get(5)?,
            last_confirmed: row.get(6)?,
        })
    })?;
    rows.collect()
}

/// 关键词匹配的事实 id 列表（forget_fact 工具用），按确认度降序
pub fn find_memory_facts_by_keyword(
    conn: &Connection,
    keyword: &str,
    limit: i64,
) -> rusqlite::Result<Vec<MemoryFact>> {
    let mut stmt = conn.prepare(
        "SELECT id, fact, category, source, confirmations, created_at, last_confirmed
         FROM memory_facts
         WHERE fact LIKE ?1
         ORDER BY confirmations DESC, last_confirmed DESC
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![format!("%{}%", keyword), limit], |row| {
        Ok(MemoryFact {
            id: row.get(0)?,
            fact: row.get(1)?,
            category: row.get(2)?,
            source: row.get(3)?,
            confirmations: row.get(4)?,
            created_at: row.get(5)?,
            last_confirmed: row.get(6)?,
        })
    })?;
    rows.collect()
}

/// 查询记忆审计事件；fact_id 为 None 时取全局最近事件
pub fn list_memory_fact_events(
    conn: &Connection,
    fact_id: Option<i64>,
    limit: i64,
) -> rusqlite::Result<Vec<MemoryFactEvent>> {
    let map_row = |row: &rusqlite::Row| {
        Ok(MemoryFactEvent {
            id: row.get(0)?,
            fact_id: row.get(1)?,
            action: row.get(2)?,
            old_text: row.get(3)?,
            new_text: row.get(4)?,
            category: row.get(5)?,
            source: row.get(6)?,
            created_at: row.get(7)?,
        })
    };
    match fact_id {
        Some(fid) => {
            let mut stmt = conn.prepare(
                "SELECT id, fact_id, action, old_text, new_text, category, source, created_at
                 FROM memory_fact_events
                 WHERE fact_id = ?1
                 ORDER BY id DESC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![fid, limit], map_row)?;
            rows.collect()
        }
        None => {
            let mut stmt = conn.prepare(
                "SELECT id, fact_id, action, old_text, new_text, category, source, created_at
                 FROM memory_fact_events
                 ORDER BY id DESC LIMIT ?1",
            )?;
            let rows = stmt.query_map(params![limit], map_row)?;
            rows.collect()
        }
    }
}

pub fn get_suggestion(conn: &Connection, id: i64) -> rusqlite::Result<Option<Suggestion>> {
    let sql = format!("SELECT {} FROM suggestions WHERE id = ?1", SUGGESTION_COLS);
    conn.query_row(&sql, params![id], map_suggestion).optional()
}

/// 某类型在某时间点之后是否已有未过期建议（用于冷却去重）
pub fn has_pending_suggestion_since(
    conn: &Connection,
    suggestion_type: &str,
    since: i64,
) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM suggestions
         WHERE suggestion_type = ?1 AND status = 'pending' AND created_at >= ?2",
        params![suggestion_type, since],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// 某类型今天是否已创建过建议（不管状态，避免一天内反复打扰）
pub fn has_suggestion_since(
    conn: &Connection,
    suggestion_type: &str,
    since: i64,
) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM suggestions
         WHERE suggestion_type = ?1 AND created_at >= ?2",
        params![suggestion_type, since],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// 某 pattern 关联的建议今天是否已发过（情境联动去重）
pub fn has_pattern_suggestion_since(
    conn: &Connection,
    pattern_id: i64,
    since: i64,
) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM suggestions
         WHERE pattern_id = ?1 AND created_at >= ?2",
        params![pattern_id, since],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// 今日是否已为该应用（exe 名）推过情境建议。
/// 同一应用可能被学出多个时间点的 context_routine pattern（如 12:00/12:03/12:04），
/// 按 pattern 去重挡不住它们连发——同一应用一天只打扰一次。
/// payload JSON 里的启动路径必含 exe 名，用 LIKE 匹配即可；
/// exe 名含 _ 时通配符误判方向是「以为推过」→ 少推，方向安全，不做 ESCAPE。
pub fn has_routine_suggestion_for_app_since(
    conn: &Connection,
    exe: &str,
    since: i64,
) -> rusqlite::Result<bool> {
    let like = format!("%{}%", exe);
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM suggestions
         WHERE suggestion_type = 'context_routine'
           AND action_payload LIKE ?1
           AND created_at >= ?2",
        params![like, since],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// 毕业制投票统计：(接受数, 拒绝数, 忽略数)
/// 忽略 = pending 且创建超过 1 天（看过没动手）
pub fn pattern_vote_counts(
    conn: &Connection,
    pattern_id: i64,
    now: i64,
) -> rusqlite::Result<(i64, i64, i64)> {
    // 只统计请示类建议（auto_executed 轻告知不计入投票）
    let accepted: i64 = conn.query_row(
        "SELECT COUNT(*) FROM suggestions WHERE pattern_id = ?1 AND status = 'accepted'
         AND suggestion_type IN ('work_suite', 'context_routine')",
        params![pattern_id],
        |r| r.get(0),
    )?;
    let dismissed: i64 = conn.query_row(
        "SELECT COUNT(*) FROM suggestions WHERE pattern_id = ?1 AND status = 'dismissed'
         AND suggestion_type IN ('work_suite', 'context_routine')",
        params![pattern_id],
        |r| r.get(0),
    )?;
    let ignored: i64 = conn.query_row(
        "SELECT COUNT(*) FROM suggestions WHERE pattern_id = ?1 AND status = 'pending' AND created_at < ?2
         AND suggestion_type IN ('work_suite', 'context_routine')",
        params![pattern_id, now - 86400],
        |r| r.get(0),
    )?;
    Ok((accepted, dismissed, ignored))
}

/// 查询某 pattern 最近一次建议时间（降频判断用）
pub fn last_pattern_suggestion_at(
    conn: &Connection,
    pattern_id: i64,
) -> rusqlite::Result<Option<i64>> {
    conn.query_row(
        "SELECT MAX(created_at) FROM suggestions WHERE pattern_id = ?1",
        params![pattern_id],
        |r| r.get(0),
    )
    .optional()
    .map(|v| v.flatten())
}

pub fn list_suggestions(
    conn: &Connection,
    status: Option<&str>,
    limit: i64,
) -> rusqlite::Result<Vec<Suggestion>> {
    let (sql, params_vec): (String, Vec<Box<dyn rusqlite::ToSql>>) = match status {
        Some(s) => (
            format!(
                "SELECT {} FROM suggestions WHERE status = ?1
                 ORDER BY created_at DESC LIMIT ?2",
                SUGGESTION_COLS
            ),
            vec![
                Box::new(s.to_string()) as Box<dyn rusqlite::ToSql>,
                Box::new(limit),
            ],
        ),
        None => (
            format!(
                "SELECT {} FROM suggestions
                 ORDER BY created_at DESC LIMIT ?1",
                SUGGESTION_COLS
            ),
            vec![Box::new(limit)],
        ),
    };

    let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(&param_refs[..], map_suggestion)?;
    rows.collect()
}

/// 一类建议的处置统计（每周自评用）
#[derive(Debug, Clone, Serialize)]
pub struct SuggestionTypeStats {
    pub suggestion_type: String,
    pub accepted: i64,
    pub dismissed: i64,
    pub ignored: i64,
    pub seen: i64,
}

/// 统计 since_ts 以来的建议处置，按类型分组。
/// ignored = 至今仍 pending 且创建早于 ignore_before（挂了 48h 没点=无声的忽略）；
/// 近 48h 的 pending 不计入（还没来得及处置，不是信号）。
pub fn suggestion_stats_since(
    conn: &Connection,
    since_ts: i64,
    ignore_before: i64,
) -> rusqlite::Result<Vec<SuggestionTypeStats>> {
    let mut stmt = conn.prepare(
        "SELECT suggestion_type,
                SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END),
                SUM(CASE WHEN status = 'pending' AND created_at < ?2 THEN 1 ELSE 0 END),
                SUM(CASE WHEN status = 'seen' THEN 1 ELSE 0 END)
         FROM suggestions
         WHERE created_at >= ?1
         GROUP BY suggestion_type
         ORDER BY suggestion_type",
    )?;
    let rows = stmt.query_map(params![since_ts, ignore_before], |r| {
        Ok(SuggestionTypeStats {
            suggestion_type: r.get(0)?,
            accepted: r.get(1)?,
            dismissed: r.get(2)?,
            ignored: r.get(3)?,
            seen: r.get(4)?,
        })
    })?;
    rows.collect()
}

pub fn set_suggestion_status(
    conn: &Connection,
    id: i64,
    status: &str,
    acted_at: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE suggestions SET status = ?2, acted_at = ?3 WHERE id = ?1",
        params![id, status, acted_at],
    )?;
    Ok(())
}

// ── habit_patterns ───────────────────────────────────────────

/// 按 signature 幂等写入模式：已存在则累加出现次数并刷新置信度
pub fn upsert_pattern(
    conn: &Connection,
    pattern_type: &str,
    signature: &str,
    description: &str,
    pattern_data: &str,
    confidence: f64,
    now: i64,
) -> rusqlite::Result<()> {
    // 同一天内重复 sighting 只刷新不计数（分段分析下守住「occurrences = 天数、2 天确认」语义）
    conn.execute(
        "INSERT INTO habit_patterns
            (pattern_type, signature, description, pattern_data, confidence, occurrences, status, first_seen, last_seen)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, 'learning', ?6, ?6)
         ON CONFLICT(signature) DO UPDATE SET
            description = excluded.description,
            pattern_data = excluded.pattern_data,
            confidence = excluded.confidence,
            occurrences = habit_patterns.occurrences + CASE
                WHEN date(habit_patterns.last_seen, 'unixepoch', 'localtime') =
                     date(excluded.last_seen, 'unixepoch', 'localtime') THEN 0
                ELSE 1
            END,
            last_seen = excluded.last_seen,
            status = CASE
                WHEN habit_patterns.status = 'dismissed' THEN 'dismissed'
                WHEN habit_patterns.occurrences + CASE
                    WHEN date(habit_patterns.last_seen, 'unixepoch', 'localtime') =
                         date(excluded.last_seen, 'unixepoch', 'localtime') THEN 0
                    ELSE 1
                END >= 2 THEN 'confirmed'
                ELSE habit_patterns.status
            END",
        params![pattern_type, signature, description, pattern_data, confidence, now],
    )?;
    Ok(())
}

pub fn list_patterns(conn: &Connection) -> rusqlite::Result<Vec<HabitPattern>> {
    let mut stmt = conn.prepare(
        "SELECT id, pattern_type, signature, description, pattern_data,
                confidence, occurrences, status, first_seen, last_seen
         FROM habit_patterns
         ORDER BY last_seen DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(HabitPattern {
            id: row.get(0)?,
            pattern_type: row.get(1)?,
            signature: row.get(2)?,
            description: row.get(3)?,
            pattern_data: row.get(4)?,
            confidence: row.get(5)?,
            occurrences: row.get(6)?,
            status: row.get(7)?,
            first_seen: row.get(8)?,
            last_seen: row.get(9)?,
        })
    })?;
    rows.collect()
}

/// 未被用户忽略的应用组合/启动序列模式（供晨间工作套装匹配）
pub fn active_combo_patterns(conn: &Connection) -> rusqlite::Result<Vec<HabitPattern>> {
    let mut stmt = conn.prepare(
        "SELECT id, pattern_type, signature, description, pattern_data,
                confidence, occurrences, status, first_seen, last_seen
         FROM habit_patterns
         WHERE pattern_type IN ('app_combo', 'startup_sequence') AND status != 'dismissed'
         ORDER BY confidence DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(HabitPattern {
            id: row.get(0)?,
            pattern_type: row.get(1)?,
            signature: row.get(2)?,
            description: row.get(3)?,
            pattern_data: row.get(4)?,
            confidence: row.get(5)?,
            occurrences: row.get(6)?,
            status: row.get(7)?,
            first_seen: row.get(8)?,
            last_seen: row.get(9)?,
        })
    })?;
    rows.collect()
}

pub fn set_pattern_status(conn: &Connection, id: i64, status: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE habit_patterns SET status = ?2 WHERE id = ?1",
        params![id, status],
    )?;
    Ok(())
}

/// 合并一个 pattern 簇（姊妹 pattern 收编）：
/// 被吸收行的投票历史（suggestions.pattern_id）重定向到 keeper——
/// 用户对小时间点 pattern 的投票本来就是投给「同一个习惯」的，合并后
/// 毕业/停用进度随之归并；随后聚合 keeper 字段并删除被吸收行（事务）。
/// occurrences 取簇内 max 而非求和：同一天多个姊妹 pattern 各计一次，
/// 求和会虚增确认/毕业速度。
#[allow(clippy::too_many_arguments)]
pub fn merge_pattern_cluster(
    conn: &mut Connection,
    keeper_id: i64,
    absorbed_ids: &[i64],
    pattern_data: &str,
    confidence: f64,
    occurrences: i64,
    first_seen: i64,
    last_seen: i64,
) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    for id in absorbed_ids {
        tx.execute(
            "UPDATE suggestions SET pattern_id = ?1 WHERE pattern_id = ?2",
            params![keeper_id, id],
        )?;
    }
    tx.execute(
        "UPDATE habit_patterns
         SET pattern_data = ?2, confidence = ?3, occurrences = ?4,
             first_seen = ?5, last_seen = ?6
         WHERE id = ?1",
        params![keeper_id, pattern_data, confidence, occurrences, first_seen, last_seen],
    )?;
    for id in absorbed_ids {
        tx.execute("DELETE FROM habit_patterns WHERE id = ?1", params![id])?;
    }
    tx.commit()
}

/// 未被忽略的情境习惯模式（B3 情境联动匹配用）
pub fn active_context_routines(conn: &Connection) -> rusqlite::Result<Vec<HabitPattern>> {
    let mut stmt = conn.prepare(
        "SELECT id, pattern_type, signature, description, pattern_data,
                confidence, occurrences, status, first_seen, last_seen
         FROM habit_patterns
         WHERE pattern_type = 'context_routine' AND status != 'dismissed'
         ORDER BY confidence DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(HabitPattern {
            id: row.get(0)?,
            pattern_type: row.get(1)?,
            signature: row.get(2)?,
            description: row.get(3)?,
            pattern_data: row.get(4)?,
            confidence: row.get(5)?,
            occurrences: row.get(6)?,
            status: row.get(7)?,
            first_seen: row.get(8)?,
            last_seen: row.get(9)?,
        })
    })?;
    rows.collect()
}

// ── 跨模块只读：剪贴板最新文本（错误堆栈检测用）────────────────

pub fn latest_clipboard_text(conn: &Connection) -> rusqlite::Result<Option<(i64, String)>> {
    conn.query_row(
        "SELECT id, content FROM clipboard_history
         WHERE content_type = 'text'
         ORDER BY id DESC LIMIT 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
}

// ── 隐私：清空采集数据 ───────────────────────────────────────

pub fn clear_all_activities(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM activity_log", [])?;
    Ok(())
}

/// 最近一条 assistant 聊天消息的时间（unix 秒，本地时区）；无记录返回 None。
/// 供聊天系统提示词拼「距上次聊天 X」的时间对照（chat.rs::chat_gap_bridge）
pub fn last_assistant_chat_at(conn: &Connection) -> Option<i64> {
    let raw: String = conn
        .query_row(
            "SELECT created_at FROM chat_messages WHERE role = 'assistant' ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok()?;
    let ndt = chrono::NaiveDateTime::parse_from_str(&raw, "%Y-%m-%d %H:%M:%S").ok()?;
    chrono::TimeZone::from_local_datetime(&chrono::Local, &ndt)
        .single()
        .map(|dt| dt.timestamp())
}

// ── 第三方 MCP 工具调用日志 ───────────────────────────────────

/// 一条外部工具调用记录（MCP 设置页日志弹窗）
#[derive(Debug, serde::Serialize)]
pub struct McpToolCallLog {
    pub id: i64,
    pub tool_name: String,
    /// ok | error（连接失败/server 报错/路由失败等）
    pub status: String,
    pub duration_ms: i64,
    pub result_len: i64,
    pub created_at: i64,
}

/// 每 server 最多保留的调用记录数（超出删最旧——CASE-001 M2 保留策略）
const MCP_TOOL_CALL_KEEP: i64 = 500;

/// 写入一条调用记录（成功与失败都记——日志的本职是反映真实调用流），
/// 并裁剪到每 server 最近 MCP_TOOL_CALL_KEEP 条防表无限膨胀
pub fn insert_mcp_tool_call(
    conn: &Connection,
    server_name: &str,
    tool_name: &str,
    status: &str,
    duration_ms: i64,
    result_len: usize,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO mcp_tool_calls (server_name, tool_name, status, duration_ms, result_len, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            server_name,
            tool_name,
            status,
            duration_ms,
            result_len as i64,
            chrono::Local::now().timestamp()
        ],
    )?;
    conn.execute(
        "DELETE FROM mcp_tool_calls WHERE server_name = ?1 AND id NOT IN (
             SELECT id FROM mcp_tool_calls WHERE server_name = ?1 ORDER BY id DESC LIMIT ?2
         )",
        rusqlite::params![server_name, MCP_TOOL_CALL_KEEP],
    )?;
    Ok(())
}

/// 某 server 的最近调用记录（新在前，最多 limit 条）
pub fn list_mcp_tool_calls(
    conn: &Connection,
    server_name: &str,
    limit: i64,
) -> rusqlite::Result<Vec<McpToolCallLog>> {
    let mut stmt = conn.prepare(
        "SELECT id, tool_name, status, duration_ms, result_len, created_at
         FROM mcp_tool_calls WHERE server_name = ?1
         ORDER BY id DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![server_name, limit], |r| {
        Ok(McpToolCallLog {
            id: r.get(0)?,
            tool_name: r.get(1)?,
            status: r.get(2)?,
            duration_ms: r.get(3)?,
            result_len: r.get(4)?,
            created_at: r.get(5)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE habit_patterns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                pattern_type TEXT NOT NULL,
                signature TEXT NOT NULL UNIQUE,
                description TEXT NOT NULL,
                pattern_data TEXT NOT NULL,
                confidence REAL DEFAULT 0,
                occurrences INTEGER DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'learning'
                    CHECK (status IN ('learning', 'confirmed', 'dismissed')),
                first_seen INTEGER NOT NULL,
                last_seen INTEGER NOT NULL
            )",
        )
        .unwrap();
        conn
    }

    fn day_ts(days_after_epoch: i64, hour: i64) -> i64 {
        (days_after_epoch * 24 + hour) * 3600
    }

    fn occurrences_and_status(conn: &Connection) -> (i64, String) {
        conn.query_row(
            "SELECT occurrences, status FROM habit_patterns WHERE signature = 's'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    fn activity_setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE activity_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                process_name TEXT NOT NULL,
                window_title TEXT NOT NULL DEFAULT '',
                started_at INTEGER NOT NULL,
                ended_at INTEGER,
                duration_secs INTEGER
            )",
        )
        .unwrap();
        conn
    }

    fn insert_open(conn: &Connection, process: &str, started_at: i64) -> i64 {
        conn.execute(
            "INSERT INTO activity_log (process_name, started_at) VALUES (?1, ?2)",
            params![process, started_at],
        )
        .unwrap();
        conn.last_insert_rowid()
    }

    #[test]
    fn stale_open_activity_ignored_by_current_open() {
        let conn = activity_setup();
        // 隔夜残段：10 小时前开始，未闭合
        insert_open(&conn, "msedge.exe", -10 * 3600);
        // 当前段：2 分钟前开始，未闭合
        insert_open(&conn, "code.exe", -120);
        let found = current_open_activity(&conn, 0).unwrap().unwrap();
        assert_eq!(
            found,
            ("code.exe".to_string(), -120),
            "残段不应被当作当前段"
        );
    }

    #[test]
    fn stale_open_activities_closed_on_startup() {
        let conn = activity_setup();
        insert_open(&conn, "msedge.exe", -10 * 3600); // 隔夜残段
        insert_open(&conn, "code.exe", -120); // 新鲜段
        let n = close_stale_open_activities(&conn, -super::super::AFK_THRESHOLD_SECS).unwrap();
        assert_eq!(n, 1, "只应清理残段");
        let leftovers: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM activity_log WHERE ended_at IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(leftovers, 1, "新鲜段应保持未闭合");
    }

    fn period_setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE period_summaries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                window_start INTEGER NOT NULL,
                window_end INTEGER NOT NULL,
                summary TEXT NOT NULL,
                activity_count INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            )",
        )
        .unwrap();
        conn
    }

    #[test]
    fn period_summaries_between_filters_by_window_start() {
        let conn = period_setup();
        insert_period_summary(&conn, 1000, 2000, "段内", 10, 2000).unwrap();
        insert_period_summary(&conn, 5000, 6000, "段外", 5, 6000).unwrap();
        let list = period_summaries_between(&conn, 0, 3000).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].summary, "段内");
        assert_eq!(list[0].activity_count, 10);
    }

    #[test]
    fn period_summaries_cleanup_goes_by_window_start() {
        let conn = period_setup();
        insert_period_summary(&conn, 1000, 2000, "旧", 10, 2000).unwrap();
        insert_period_summary(&conn, 9000, 10000, "新", 10, 10000).unwrap();
        let n = cleanup_period_summaries_older_than(&conn, 5000).unwrap();
        assert_eq!(n, 1);
        let list = period_summaries_between(&conn, 0, i64::MAX).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].summary, "新");
    }

    #[test]
    fn same_day_repeat_sighting_does_not_count() {        let conn = setup();
        // 取 UTC 正午起相邻两小时（本地 20:00/21:00），确保任意时区下都在同一本地日
        let d1_09 = day_ts(20000, 12);
        let d1_14 = day_ts(20000, 13);
        upsert_pattern(&conn, "app_combo", "s", "描述", "{}", 0.7, d1_09).unwrap();
        // 同一天第二个时段再命中：occurrences 不加，状态不推进
        upsert_pattern(&conn, "app_combo", "s", "描述", "{}", 0.8, d1_14).unwrap();
        assert_eq!(occurrences_and_status(&conn), (1, "learning".to_string()));
    }

    #[test]
    fn cross_day_sighting_counts_and_confirms() {
        let conn = setup();
        // 取 UTC 正午（本地 20:00），确保任意时区下都落在相邻两个本地日
        let d1 = day_ts(20000, 12);
        let d2 = day_ts(20001, 12);
        upsert_pattern(&conn, "app_combo", "s", "描述", "{}", 0.7, d1).unwrap();
        upsert_pattern(&conn, "app_combo", "s", "描述", "{}", 0.7, d2).unwrap();
        assert_eq!(occurrences_and_status(&conn), (2, "confirmed".to_string()));
    }

    // ── 重复备忘：日期计算与 occurrence 重生 ─────────────────────

    fn memo_setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_tables(&conn).unwrap();
        conn
    }

    #[test]
    fn next_due_date_daily_and_weekly_rules() {
        // 2026-08-17 是周一，便于手算核对
        let mon = chrono::NaiveDate::from_ymd_opt(2026, 8, 17).unwrap();
        let fri = chrono::NaiveDate::from_ymd_opt(2026, 8, 21).unwrap();
        // daily → 明天
        assert_eq!(
            next_due_date(mon, "daily"),
            chrono::NaiveDate::from_ymd_opt(2026, 8, 18)
        );
        // weekly:5（周五）从周一 → 本周五
        assert_eq!(
            next_due_date(mon, "weekly:5"),
            chrono::NaiveDate::from_ymd_opt(2026, 8, 21)
        );
        // weekly:1（周一）当天即周 N → 下周一
        assert_eq!(
            next_due_date(mon, "weekly:1"),
            chrono::NaiveDate::from_ymd_opt(2026, 8, 24)
        );
        // weekly:3（周三）从周五 → 下周三
        assert_eq!(
            next_due_date(fri, "weekly:3"),
            chrono::NaiveDate::from_ymd_opt(2026, 8, 26)
        );
        // 集外规则丢弃
        assert_eq!(next_due_date(mon, "weekly:0"), None);
        assert_eq!(next_due_date(mon, "weekly:8"), None);
        assert_eq!(next_due_date(mon, "monthly"), None);
    }

    #[test]
    fn set_memo_status_reports_actual_transition() {
        let conn = memo_setup();
        let now = day_ts(20000, 12);
        let memo = create_memo(&conn, "喝水", now).unwrap();
        assert_eq!(set_memo_status(&conn, memo.id, "done", now).unwrap(), 1);
        // 重复处置同一状态：无迁移返回 0（命令层据此跳过重生，防重复勾选复制条目）
        assert_eq!(set_memo_status(&conn, memo.id, "done", now).unwrap(), 0);
        assert_eq!(set_memo_status(&conn, memo.id, "pending", now).unwrap(), 1);
    }

    #[test]
    fn list_pending_recurring_filters_done_and_plain() {
        let conn = memo_setup();
        let now = day_ts(20000, 12);
        let daily = create_memo(&conn, "每天喝水", now).unwrap();
        update_memo_parse(&conn, daily.id, "每天喝水", None, None, None, Some("daily")).unwrap();
        create_memo(&conn, "一次性", now).unwrap();
        let done_daily = create_memo(&conn, "已完成的重复", now).unwrap();
        update_memo_parse(
            &conn,
            done_daily.id,
            "已完成的重复",
            None,
            None,
            None,
            Some("daily"),
        )
        .unwrap();
        set_memo_status(&conn, done_daily.id, "done", now).unwrap();
        let ids: Vec<i64> = list_pending_recurring(&conn)
            .unwrap()
            .iter()
            .map(|m| m.id)
            .collect();
        assert_eq!(ids, vec![daily.id], "只应列出待办中的重复备忘");
    }

    #[test]
    fn next_recurrence_inherits_pinned_and_rule() {
        let conn = memo_setup();
        // UTC 正午落库，任意时区下都是同一个本地日
        let now = day_ts(20000, 12);
        let memo = create_memo(&conn, "每天喝水", now).unwrap();
        update_memo_parse(&conn, memo.id, "每天喝水", None, None, None, Some("daily")).unwrap();
        set_memo_pinned(&conn, memo.id, true).unwrap();
        create_next_recurrence(&conn, &get_memo(&conn, memo.id).unwrap(), now).unwrap();

        let next: Memo = conn
            .query_row(
                &format!("SELECT {} FROM memos WHERE id != ?1", MEMO_COLS),
                params![memo.id],
                map_memo,
            )
            .unwrap();
        assert!(next.pinned, "钉住的重复备忘，下一次应继承置顶状态");
        assert_eq!(next.recurrence.as_deref(), Some("daily"));
        assert_eq!(next.status, "pending");
        let today = chrono::DateTime::from_timestamp(now, 0)
            .unwrap()
            .with_timezone(&chrono::Local)
            .date_naive();
        let expected_due = (today + chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
        assert_eq!(next.due_date.as_deref(), Some(expected_due.as_str()));
    }
}
