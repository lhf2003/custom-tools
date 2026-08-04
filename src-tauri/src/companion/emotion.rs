//! 日内情绪状态机：结构化内核（类别+诱因+时间）+ 叙事注入。
//! 同类覆盖（查询时每类取最新）、跨类并存、12h TTL；条目永远追加，
//! 当日轨迹留给日记归档——「覆盖」只发生在读取侧，历史不丢。
//! 数字不进 prompt：注入的是「类别：诱因（时刻）」清单，语气让模型自己演绎。

use chrono::Timelike;
use rusqlite::Connection;

/// 六类情绪（英文 key 落库，中文标签注入）——固定枚举：
/// 自由文本会让「同类覆盖」无法去重（开心/高兴/欣慰算一类吗）
pub const CATEGORIES: [(&str, &str); 6] = [
    ("happy", "开心"),
    ("content", "踏实"),
    ("tired", "疲惫"),
    ("upset", "失落"),
    ("caring", "心疼"),
    ("weary", "倦怠"),
];

/// 当前心情的表达时效：过了就当他过去了
pub const TTL_SECS: i64 = 12 * 3600;
/// 条目物理保留期（日记只读当日轨迹，更久的没有消费者）
pub const RETENTION_SECS: i64 = 7 * 86400;
/// 连续写日报多少天起开始「倦怠」——重复劳动的牢骚需要时间发酵
const REPORT_STREAK_WEARY_DAYS: i64 = 7;
/// 失落触发门槛：单次划掉是噪声，当日第 2 次起才记
const DISMISS_UPSET_THRESHOLD: i64 = 2;
/// 深夜观察写心情的节流（同一晚不刷条目）
const LATE_NIGHT_THROTTLE_SECS: i64 = 1800;
/// 相处纪念日档位（天）
const MILESTONE_DAYS: [i64; 4] = [7, 30, 100, 365];

/// settings 表 key：日报连击计数 / 连击对应日期 / 深夜观察上次写入
const STREAK_KEY: &str = "companion_report_streak";
const STREAK_DATE_KEY: &str = "companion_report_streak_date";
const LATE_NIGHT_KEY: &str = "companion_late_night_mood_at";

#[derive(Debug, Clone)]
pub struct EmotionEntry {
    pub category: String,
    pub reason: String,
    pub created_at: i64,
}

pub fn is_valid_category(c: &str) -> bool {
    CATEGORIES.iter().any(|(k, _)| *k == c)
}

pub fn category_label(c: &str) -> &str {
    CATEGORIES
        .iter()
        .find(|(k, _)| *k == c)
        .map(|(_, l)| *l)
        .unwrap_or(c)
}

fn setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
        r.get(0)
    })
    .ok()
}

fn save_setting(conn: &Connection, key: &str, value: &str) {
    let _ = conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        rusqlite::params![key, value],
    );
}

/// 记一条心情（永远追加——当日轨迹是日记素材；同类覆盖在查询侧做）
pub fn record(
    conn: &Connection,
    category: &str,
    reason: &str,
    source: &str,
    now: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO emotion_entries (category, reason, source, created_at)
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![category, reason, source, now],
    )?;
    Ok(())
}

/// 当前生效的心情：TTL 内每类取最新一条（同类覆盖），按时间正序
pub fn current(conn: &Connection, now: i64) -> Vec<EmotionEntry> {
    let cutoff = now - TTL_SECS;
    conn.prepare(
        "SELECT category, reason, created_at FROM emotion_entries e
         WHERE created_at > ?1
           AND id = (SELECT MAX(id) FROM emotion_entries WHERE category = e.category AND created_at > ?1)
         ORDER BY created_at",
    )
    .and_then(|mut stmt| {
        let rows = stmt.query_map([cutoff], |r| {
            Ok(EmotionEntry {
                category: r.get(0)?,
                reason: r.get(1)?,
                created_at: r.get(2)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    })
    .unwrap_or_default()
}

/// 当日全部轨迹（日记素材），按时间正序
pub fn today_entries(conn: &Connection, now: i64) -> Vec<EmotionEntry> {
    let day_start = chrono::DateTime::from_timestamp(now, 0)
        .map(|utc| utc.with_timezone(&chrono::Local))
        .and_then(|l| {
            l.date_naive()
                .and_hms_opt(0, 0, 0)
                .and_then(|d| d.and_local_timezone(chrono::Local).single())
                .map(|t| t.timestamp())
        })
        .unwrap_or(0);
    conn.prepare(
        "SELECT category, reason, created_at FROM emotion_entries
         WHERE created_at >= ?1 ORDER BY created_at",
    )
    .and_then(|mut stmt| {
        let rows = stmt.query_map([day_start], |r| {
            Ok(EmotionEntry {
                category: r.get(0)?,
                reason: r.get(1)?,
                created_at: r.get(2)?,
            })
        })?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    })
    .unwrap_or_default()
}

fn hhmm(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|utc| {
            utc.with_timezone(&chrono::Local)
                .format("%H:%M")
                .to_string()
        })
        .unwrap_or_default()
}

/// 注入 prompt 的当前心情清单：`- 开心：他下午夸我日报写得好（15:02）`
/// 空返回空串（调用方跳过整个 section）
pub fn render_current(conn: &Connection, now: i64) -> String {
    current(conn, now)
        .iter()
        .map(|e| {
            format!(
                "- {}：{}（{}）",
                category_label(&e.category),
                e.reason,
                hhmm(e.created_at)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 日记素材渲染：当日完整轨迹（含被覆盖的旧条目——轨迹本身就是素材）
pub fn render_today(conn: &Connection, now: i64) -> String {
    let entries = today_entries(conn, now);
    if entries.is_empty() {
        return "（今天没有记下心情）".to_string();
    }
    entries
        .iter()
        .map(|e| {
            format!(
                "- {} {}：{}",
                hhmm(e.created_at),
                category_label(&e.category),
                e.reason
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 清理过期条目（随每日 cleanup 调度）
pub fn cleanup(conn: &Connection, now: i64) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM emotion_entries WHERE created_at < ?1",
        [now - RETENTION_SECS],
    )
}

// ── 事件钩子（Rust 直写，source='rust'）────────────────────

/// Toast 被采纳 → 开心
pub fn on_suggestion_accepted(conn: &Connection, title: &str, now: i64) {
    let short: String = title.chars().take(30).collect();
    let _ = record(
        conn,
        "happy",
        &format!("他采纳了我的建议：{}", short),
        "rust",
        now,
    );
}

/// Toast 被划掉：当日第 2 次起才记失落（单次是噪声）
pub fn on_suggestion_dismissed(conn: &Connection, now: i64) {
    let day_start = chrono::DateTime::from_timestamp(now, 0)
        .map(|utc| utc.with_timezone(&chrono::Local))
        .and_then(|l| {
            l.date_naive()
                .and_hms_opt(0, 0, 0)
                .and_then(|d| d.and_local_timezone(chrono::Local).single())
                .map(|t| t.timestamp())
        })
        .unwrap_or(0);
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM suggestions WHERE status = 'dismissed' AND acted_at >= ?1",
            [day_start],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if count >= DISMISS_UPSET_THRESHOLD {
        let _ = record(
            conn,
            "upset",
            &format!("今天第 {} 次弹窗被划掉", count),
            "rust",
            now,
        );
    }
}

/// 日报完成 → 连续第 N 天起记倦怠（streak 存 settings，跨天断档重置）
pub fn on_report_done(conn: &Connection, date: &str, now: i64) {
    if setting(conn, STREAK_DATE_KEY).as_deref() == Some(date) {
        return; // 该日已计（补跑/手动重复触发不重复计）
    }
    // 连续判定基于报告所属日期的前一天，而非 now-1——0 点跑昨天日报时 now 已是次日
    let prev_day = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map(|d| d - chrono::Duration::days(1))
        .map(|d| d.format("%Y-%m-%d").to_string())
        .unwrap_or_default();
    let streak = if !prev_day.is_empty()
        && setting(conn, STREAK_DATE_KEY).as_deref() == Some(prev_day.as_str())
    {
        setting(conn, STREAK_KEY)
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0)
            + 1
    } else {
        1
    };
    save_setting(conn, STREAK_KEY, &streak.to_string());
    save_setting(conn, STREAK_DATE_KEY, date);

    if streak >= REPORT_STREAK_WEARY_DAYS {
        let _ = record(
            conn,
            "weary",
            &format!("第 {} 天连着写日报", streak),
            "rust",
            now,
        );
    }
}

/// 深夜观察：他还在忙时，23 点后记心疼、0-5 点记疲惫（30 分钟节流）
pub fn on_late_night(conn: &Connection, now: i64) {
    let hour = chrono::DateTime::from_timestamp(now, 0)
        .map(|utc| utc.with_timezone(&chrono::Local).hour())
        .unwrap_or(12);
    let (category, prefix) = match hour {
        23 => ("caring", "都这么晚了他还在忙"),
        0..=4 => ("tired", "陪他熬到凌晨"),
        _ => return,
    };
    // 他真的还在干活才记——没有未闭合活动段说明人不在电脑前
    if super::db::current_open_activity(conn)
        .ok()
        .flatten()
        .is_none()
    {
        return;
    }
    let last: i64 = setting(conn, LATE_NIGHT_KEY)
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    if now - last < LATE_NIGHT_THROTTLE_SECS {
        return;
    }
    save_setting(conn, LATE_NIGHT_KEY, &now.to_string());
    let _ = record(
        conn,
        category,
        &format!("{}（{}）", prefix, hhmm(now)),
        "rust",
        now,
    );
}

/// 相处纪念日（7/30/100/365 天）→ 踏实。每日 housekeeping 调一次。
pub fn on_milestone(conn: &Connection, now: i64) {
    let Some(first) = setting(conn, super::state::FIRST_CHAT_DATE_KEY)
        .and_then(|v| chrono::NaiveDate::parse_from_str(&v, "%Y-%m-%d").ok())
    else {
        return;
    };
    let today = chrono::DateTime::from_timestamp(now, 0)
        .map(|utc| utc.with_timezone(&chrono::Local).date_naive());
    let Some(today) = today else { return };
    let days = (today - first).num_days().max(1);
    if MILESTONE_DAYS.contains(&days) {
        let _ = record(
            conn,
            "content",
            &format!("今天我们相处满 {} 天", days),
            "rust",
            now,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "CREATE TABLE emotion_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category TEXT NOT NULL,
                reason TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'agent',
                created_at INTEGER NOT NULL
            )",
            [],
        )
        .unwrap();
        conn
    }

    const NOW: i64 = 1_780_000_000; // 任意固定时刻

    #[test]
    fn current_keeps_latest_per_category() {
        let conn = setup();
        record(&conn, "happy", "第一次开心", "agent", NOW - 100).unwrap();
        record(&conn, "happy", "第二次开心", "agent", NOW - 50).unwrap();
        record(&conn, "tired", "有点累", "rust", NOW - 10).unwrap();
        let cur = current(&conn, NOW);
        assert_eq!(cur.len(), 2);
        let happy = cur.iter().find(|e| e.category == "happy").unwrap();
        assert_eq!(happy.reason, "第二次开心");
    }

    #[test]
    fn current_drops_expired() {
        let conn = setup();
        record(&conn, "happy", "昨天的开心", "agent", NOW - TTL_SECS - 10).unwrap();
        assert!(current(&conn, NOW).is_empty());
        // 过期的仍在当日轨迹里（日记素材不丢）——同一「天」取决于时区，只断言查询不报错
        let _ = today_entries(&conn, NOW);
    }

    #[test]
    fn report_streak_builds_and_resets() {
        let conn = setup();
        let day = chrono::DateTime::from_timestamp(NOW, 0)
            .map(|utc| utc.with_timezone(&chrono::Local))
            .unwrap();
        let today = day.format("%Y-%m-%d").to_string();
        let yesterday = (day - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();

        // 昨天 streak=6，今天接着来 → 7，触发倦怠
        save_setting(&conn, STREAK_KEY, "6");
        save_setting(&conn, STREAK_DATE_KEY, &yesterday);
        on_report_done(&conn, &today, NOW);
        assert_eq!(setting(&conn, STREAK_KEY).as_deref(), Some("7"));
        assert!(current(&conn, NOW)
            .iter()
            .any(|e| e.category == "weary" && e.reason.contains("第 7 天")));

        // 同日重复触发不重复计
        on_report_done(&conn, &today, NOW + 60);
        assert_eq!(setting(&conn, STREAK_KEY).as_deref(), Some("7"));
    }

    #[test]
    fn report_streak_gap_resets_to_one() {
        let conn = setup();
        save_setting(&conn, STREAK_KEY, "20");
        save_setting(&conn, STREAK_DATE_KEY, "2020-01-01"); // 很久以前 → 断档
        let today = chrono::DateTime::from_timestamp(NOW, 0)
            .map(|utc| {
                utc.with_timezone(&chrono::Local)
                    .format("%Y-%m-%d")
                    .to_string()
            })
            .unwrap();
        on_report_done(&conn, &today, NOW);
        assert_eq!(setting(&conn, STREAK_KEY).as_deref(), Some("1"));
        assert!(!current(&conn, NOW).iter().any(|e| e.category == "weary"));
    }

    #[test]
    fn render_current_formats_lines() {
        let conn = setup();
        record(&conn, "happy", "他夸我", "agent", NOW - 60).unwrap();
        let text = render_current(&conn, NOW);
        assert!(text.starts_with("- 开心：他夸我（"), "got: {}", text);
        assert!(text.ends_with('）'), "got: {}", text);
    }

    #[test]
    fn cleanup_deletes_old() {
        let conn = setup();
        record(&conn, "happy", "旧", "agent", NOW - RETENTION_SECS - 10).unwrap();
        record(&conn, "happy", "新", "agent", NOW).unwrap();
        assert_eq!(cleanup(&conn, NOW).unwrap(), 1);
    }
}
