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

/// 执行 ALTER TABLE ADD COLUMN，仅忽略「列已存在」错误（幂等迁移）
fn add_column_if_missing(conn: &Connection, sql: &str) -> rusqlite::Result<()> {
    match conn.execute(sql, []) {
        Ok(_) => Ok(()),
        Err(e) => {
            if e.to_string().contains("duplicate column name") {
                Ok(())
            } else {
                Err(e)
            }
        }
    }
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
                CHECK (status IN ('pending', 'accepted', 'dismissed')),
            created_at INTEGER NOT NULL,
            acted_at INTEGER
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status, created_at DESC)",
        [],
    )?;

    // Migrations: intent support (B2)
    // 仅忽略「列已存在」错误（重复迁移的预期情况），其他错误（锁定、损坏等）正常上报
    add_column_if_missing(
        conn,
        "ALTER TABLE suggestions ADD COLUMN source TEXT DEFAULT 'system'",
    )?;
    add_column_if_missing(conn, "ALTER TABLE suggestions ADD COLUMN trigger_data TEXT")?;
    add_column_if_missing(conn, "ALTER TABLE suggestions ADD COLUMN due_date TEXT")?;
    add_column_if_missing(
        conn,
        "ALTER TABLE suggestions ADD COLUMN last_triggered_at INTEGER",
    )?;
    // Migrations: 场景联动投票关联（B3）
    add_column_if_missing(
        conn,
        "ALTER TABLE suggestions ADD COLUMN pattern_id INTEGER",
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

    // 记忆分类五维迁移（幂等，每次启动跑、首次后空转）：
    // person/project 保持不变，旧标签归并到新五维
    conn.execute(
        "UPDATE memory_facts SET category = 'workflow' WHERE category = 'general'",
        [],
    )?;
    conn.execute(
        "UPDATE memory_facts SET category = 'voice' WHERE category = 'preference'",
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

/// 当前未闭合的活动段（进程名, 开始时间）；无则 None（AFK 或未采集）
pub fn current_open_activity(conn: &Connection) -> rusqlite::Result<Option<(String, i64)>> {
    conn.query_row(
        "SELECT process_name, started_at FROM activity_log
         WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()
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

/// 创建用户意图（「记」入口）。触发器随后由 LLM 异步解析写回。
pub fn create_intent(conn: &Connection, text: &str, now: i64) -> rusqlite::Result<Suggestion> {
    let title: String = text.chars().take(40).collect();
    conn.execute(
        "INSERT INTO suggestions (suggestion_type, title, body, source, created_at)
         VALUES ('intent', ?1, ?2, 'user', ?3)",
        params![title, text, now],
    )?;
    Ok(Suggestion {
        id: conn.last_insert_rowid(),
        suggestion_type: "intent".to_string(),
        title,
        body: Some(text.to_string()),
        action_payload: None,
        status: "pending".to_string(),
        created_at: now,
        acted_at: None,
        source: Some("user".to_string()),
        trigger_data: None,
        due_date: None,
        last_triggered_at: None,
    })
}

/// LLM 解析完成后写回触发器
pub fn update_intent_triggers(
    conn: &Connection,
    id: i64,
    trigger_data: &str,
    due_date: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE suggestions SET trigger_data = ?2, due_date = ?3 WHERE id = ?1",
        params![id, trigger_data, due_date],
    )?;
    Ok(())
}

/// 待触发的用户意图（情境匹配用）
pub fn pending_intents(conn: &Connection) -> rusqlite::Result<Vec<Suggestion>> {
    let sql = format!(
        "SELECT {} FROM suggestions
         WHERE suggestion_type = 'intent' AND source = 'user' AND status = 'pending'
         ORDER BY created_at ASC",
        SUGGESTION_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], map_suggestion)?;
    rows.collect()
}

pub fn touch_triggered(conn: &Connection, id: i64, now: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE suggestions SET last_triggered_at = ?2 WHERE id = ?1",
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
pub fn last_pattern_suggestion_at(conn: &Connection, pattern_id: i64) -> rusqlite::Result<Option<i64>> {
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

/// 列出用户意图（SQL 层过滤 suggestion_type，limit 语义准确）
pub fn list_intents(conn: &Connection, limit: i64) -> rusqlite::Result<Vec<Suggestion>> {
    let sql = format!(
        "SELECT {} FROM suggestions WHERE suggestion_type = 'intent'
         ORDER BY created_at DESC LIMIT ?1",
        SUGGESTION_COLS
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![limit], map_suggestion)?;
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
    conn.execute(
        "INSERT INTO habit_patterns
            (pattern_type, signature, description, pattern_data, confidence, occurrences, status, first_seen, last_seen)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, 'learning', ?6, ?6)
         ON CONFLICT(signature) DO UPDATE SET
            description = excluded.description,
            pattern_data = excluded.pattern_data,
            confidence = excluded.confidence,
            occurrences = habit_patterns.occurrences + 1,
            last_seen = excluded.last_seen,
            status = CASE
                WHEN habit_patterns.status = 'dismissed' THEN 'dismissed'
                WHEN habit_patterns.occurrences + 1 >= 2 THEN 'confirmed'
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
