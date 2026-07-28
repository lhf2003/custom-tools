//! 活人感状态机：时间带 × 忙碌度 × 关系阶段 → 一句叙事，注入 prompt 末尾。
//! 状态从系统数据算出来，不靠随机（Alice #18 世界一致性来自状态机）；
//! 只陈述事实，语气让模型自己演绎（#17 叙事式，不写「请温柔一点」这类指令）。

use chrono::Timelike;
use rusqlite::Connection;

/// 关系阶段的起点（首次聊天日期，YYYY-MM-DD，存 settings 表）
pub const FIRST_CHAT_DATE_KEY: &str = "first_chat_date";

/// 时间带标签
fn time_band(hour: u32) -> &'static str {
    match hour {
        5..=8 => "清晨",
        9..=11 => "上午",
        12..=13 => "中午",
        14..=17 => "下午",
        18..=21 => "傍晚",
        _ => "深夜",
    }
}

/// 关系阶段标签（相处天数三档）
fn relationship_stage(days: i64) -> &'static str {
    if days < 7 {
        "新识"
    } else if days < 30 {
        "熟悉"
    } else {
        "老搭档"
    }
}

/// 组装状态叙事句（纯函数，便于单测）。
/// `now` epoch 秒；`open_since` 当前未闭合活动段的开始时间；`first_date` 首次聊天日期。
fn assemble(now: i64, open_since: Option<i64>, first_date: Option<chrono::NaiveDate>) -> String {
    let local = chrono::DateTime::from_timestamp(now, 0)
        .map(|utc| utc.with_timezone(&chrono::Local));
    let Some(local) = local else { return String::new() };

    let mut sentence = format!(
        "现在是{} {}。",
        time_band(local.hour()),
        local.format("%H:%M")
    );

    if let Some(since) = open_since {
        let minutes = (now - since).max(0) / 60;
        if minutes >= 1 {
            let (h, m) = (minutes / 60, minutes % 60);
            let span = if h > 0 {
                format!("{} 小时 {} 分钟", h, m)
            } else {
                format!("{} 分钟", m)
            };
            sentence.push_str(&format!("他已经连续工作 {}。", span));
        }
    }

    if let Some(first) = first_date {
        let days = (local.date_naive() - first).num_days().max(1);
        sentence.push_str(&format!(
            "你们相处 {} 天了，{}。",
            days,
            relationship_stage(days)
        ));
    }

    sentence
}

/// 当前状态叙事句，如「现在是深夜 23:40。他已经连续工作 3 小时 20 分钟。你们相处 42 天了，老搭档。」
/// 无当前活动段时省略忙碌句；还没聊过天时省略关系句。
pub fn current_state_sentence(conn: &Connection, now: i64) -> String {
    let open_since = super::db::current_open_activity(conn)
        .ok()
        .flatten()
        .map(|(_, started)| started);

    let first_date: Option<chrono::NaiveDate> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [FIRST_CHAT_DATE_KEY],
            |row| row.get::<_, String>(0),
        )
        .ok()
        .and_then(|v| chrono::NaiveDate::parse_from_str(&v, "%Y-%m-%d").ok());

    assemble(now, open_since, first_date)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    /// 2026-07-28 指定时刻的本地 epoch 秒（用 Local 反推，免时区硬编码）
    fn ts_at(hour: u32, minute: u32) -> i64 {
        chrono::Local
            .from_local_datetime(
                &chrono::NaiveDate::from_ymd_opt(2026, 7, 28)
                    .unwrap()
                    .and_hms_opt(hour, minute, 0)
                    .unwrap(),
            )
            .single()
            .unwrap()
            .timestamp()
    }

    #[test]
    fn covers_time_bands() {
        assert_eq!(time_band(6), "清晨");
        assert_eq!(time_band(10), "上午");
        assert_eq!(time_band(13), "中午");
        assert_eq!(time_band(15), "下午");
        assert_eq!(time_band(20), "傍晚");
        assert_eq!(time_band(23), "深夜");
        assert_eq!(time_band(2), "深夜");
    }

    #[test]
    fn covers_relationship_stages() {
        assert_eq!(relationship_stage(1), "新识");
        assert_eq!(relationship_stage(6), "新识");
        assert_eq!(relationship_stage(7), "熟悉");
        assert_eq!(relationship_stage(29), "熟悉");
        assert_eq!(relationship_stage(30), "老搭档");
    }

    #[test]
    fn assembles_full_sentence() {
        let now = ts_at(23, 40);
        let since = now - (3 * 60 + 20) * 60;
        let first = chrono::NaiveDate::from_ymd_opt(2026, 6, 16).unwrap(); // 42 天前
        let s = assemble(now, Some(since), Some(first));
        assert!(s.contains("深夜 23:40"), "got: {}", s);
        assert!(s.contains("连续工作 3 小时 20 分钟"), "got: {}", s);
        assert!(s.contains("相处 42 天"), "got: {}", s);
        assert!(s.contains("老搭档"), "got: {}", s);
    }

    #[test]
    fn omits_optional_parts() {
        let now = ts_at(9, 5);
        let s = assemble(now, None, None);
        assert_eq!(s, "现在是上午 09:05。");
    }

    #[test]
    fn skips_work_span_under_one_minute() {
        let now = ts_at(14, 30);
        let s = assemble(now, Some(now - 30), None);
        assert!(!s.contains("连续工作"), "got: {}", s);
    }
}
