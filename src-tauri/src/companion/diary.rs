//! 情感日记与明日关注：贾维斯的「表达通道」私货（Alice #19 双通道隔离）。
//! 日记私有——落 companion/diary/*.md，不做任何 UI 入口（戒条：适当不透明）；
//! 态度指引（attitude.md）与明日关注只注入聊天 prompt，执行通道（分析/日报）不读。
//! 两者都在每晚分析后生成（#18 剧本前置：今晚规划明早），失败只记日志不阻塞链路。

use std::path::{Path, PathBuf};

use chrono::Datelike;
use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::llm_provider::models::Scene;

use super::{analyzer, db, persona};

/// 日记与态度指引的分隔标记（与 diary.md 手册的输出格式约定一致）
const ATTITUDE_SPLIT: &str = "===态度===";
/// 明日关注在 settings 表的两个 key
pub const FOCUS_KEY: &str = "daily_focus";
pub const FOCUS_DATE_KEY: &str = "daily_focus_date";

pub fn run_diary_blocking(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    date: &str,
) -> Result<String, String> {
    tauri::async_runtime::block_on(run_diary(app_handle, db_path, date))
}

/// 生成当晚日记：素材（当日聚合 + 最近聊天 + 今日记忆变更 + 上次态度）→
/// 单次调用两段输出（日记正文 + 态度指引）→ 日记落盘、attitude.md 重写。
pub async fn run_diary(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    date: &str,
) -> Result<String, String> {
    let conn = Connection::open(db_path).map_err(|e| format!("打开数据库失败: {}", e))?;
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;

    let aggregate = analyzer::aggregate_day(&conn, date).unwrap_or_default();
    let recent_chats = user_messages_on(&conn, date, 10);
    // 素材锚定日记所属日期（0 点跑昨天日记时 now 已是次日，不能用「今天」）
    let day_ref = day_ref_ts(date).unwrap_or_else(|| chrono::Local::now().timestamp());
    let fact_events = fact_events_on(&conn, day_ref);
    let last_attitude = persona::load_attitude(&app_data);
    // 当日情绪轨迹（情绪状态机）：日记是它的归档归宿，趋势蒸馏进 attitude
    let mood_track = super::emotion::render_today(&conn, day_ref);

    let chats_text = if recent_chats.is_empty() {
        "（今天没有聊天）".to_string()
    } else {
        recent_chats
            .iter()
            .map(|c| format!("- {}", c))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let events_text = if fact_events.is_empty() {
        "（今天记忆没有变化）".to_string()
    } else {
        fact_events.join("\n")
    };
    let attitude_text = if last_attitude.trim().is_empty() {
        "（还没有写过）".to_string()
    } else {
        last_attitude.trim().to_string()
    };

    let prompt = format!(
        "{persona}\n\n---\n\n{manual}\n\n---\n\n# 今天的素材（{date}，{weekday}）\n\n\
         ## 他的电脑使用\n{aggregate}\n\n\
         ## 今天他对你说的话\n{chats}\n\n\
         ## 今天你记住/修改的关于他的事\n{events}\n\n\
         ## 今天你的心情轨迹\n{moods}\n\n\
         ## 你上次写下的态度指引\n{attitude}",
        persona = persona::load(&app_data),
        manual = super::skills::load_skill_body(&app_data, "diary"),
        date = date,
        weekday = weekday_cn(date),
        aggregate = aggregate,
        chats = chats_text,
        events = events_text,
        moods = mood_track,
        attitude = attitude_text,
    );

    let reply =
        analyzer::call_llm_with_scene(app_handle, db_path, prompt, Scene::Diary, "diary").await?;

    // 防呆：模型没按格式给分隔标记时，整篇存日记、态度指引不动
    let (diary_text, attitude) = match reply.split_once(ATTITUDE_SPLIT) {
        Some((d, a)) => (d.trim().to_string(), a.trim().to_string()),
        None => (reply.trim().to_string(), String::new()),
    };
    if diary_text.is_empty() {
        return Err("日记生成内容为空".to_string());
    }

    let dir = diary_dir(&app_data);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建日记目录失败: {}", e))?;
    std::fs::write(dir.join(format!("{}.md", date)), &diary_text)
        .map_err(|e| format!("写入日记失败: {}", e))?;

    if !attitude.is_empty() {
        // 长度保护：指引是注入聊天的，失控膨胀会直接烧 token
        let trimmed: String = attitude.chars().take(300).collect();
        persona::save_attitude(&app_data, &trimmed)?;
    }

    Ok(format!("日记已写入（{} 字）", diary_text.chars().count()))
}

pub fn run_focus_blocking(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    source_date: &str,
) -> Result<String, String> {
    tauri::async_runtime::block_on(run_focus(app_handle, db_path, source_date))
}

/// 生成「明日关注」：基于记忆 + 活跃意图 + 习惯模式 + source_date 当天使用，
/// 为 source_date 的次日列 3-5 条关注清单，存 settings（晨间卡与聊天注入读取）。
/// 0 点链路传昨天 → 清单面向刚开始的新一天。
async fn run_focus(
    app_handle: &AppHandle,
    db_path: &PathBuf,
    source_date: &str,
) -> Result<String, String> {
    let conn = Connection::open(db_path).map_err(|e| format!("打开数据库失败: {}", e))?;

    let facts = db::list_memory_facts(&conn, 50).unwrap_or_default();
    let facts_text = if facts.is_empty() {
        "（还没有沉淀关于他的事实）".to_string()
    } else {
        facts
            .iter()
            .map(|f| format!("- {}", f.fact))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let intents = db::list_memos_active(&conn).unwrap_or_default();
    let intents_text = if intents.is_empty() {
        "（没有活跃备忘）".to_string()
    } else {
        intents
            .iter()
            .take(8)
            .map(|i| format!("- {}", i.content))
            .collect::<Vec<_>>()
            .join("\n")
    };

    let patterns_text = conn
        .prepare(
            "SELECT description FROM habit_patterns
             WHERE status != 'dismissed' ORDER BY confidence DESC LIMIT 5",
        )
        .and_then(|mut stmt| {
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            Ok(rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
        })
        .map(|list| {
            if list.is_empty() {
                "（还没学到稳定模式）".to_string()
            } else {
                list.iter()
                    .map(|d| format!("- {}", d))
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        })
        .unwrap_or_else(|_| "（模式查询失败）".to_string());

    let aggregate = analyzer::aggregate_day(&conn, source_date).unwrap_or_default();

    let prompt = format!(
        "你是他的私人管家贾维斯。基于以下信息，为明天列 3-5 条「关注」——\n\
         就是明天跟他相处时用得上的上下文：他的项目节点、没做完的事、在追的剧、最近的节奏。\n\
         写法要求（违反任一条就不合格）：\n\
         每条一行、一句话，说人话（「他在追《Loki》，午休可能会看」）；\n\
         禁档案腔/监控腔：「保持既有的…」「通过X进行Y」「合理分配时间」这类措辞一律不许出现；\n\
         是「留意」不是「安排」——不指挥他明天该干什么；\n\
         来自素材，不编造；只输出清单本身。\n\n\
         ## 你记住的他\n{facts}\n\n\
         ## 他的备忘意图\n{intents}\n\n\
         ## 已学到的习惯模式\n{patterns}\n\n\
         ## 他 {source_date} 的电脑使用\n{aggregate}",
        facts = facts_text,
        intents = intents_text,
        patterns = patterns_text,
        source_date = source_date,
        aggregate = aggregate,
    );

    let reply = analyzer::call_companion_llm(app_handle, db_path, prompt, "focus").await?;
    let focus = reply.trim();
    if focus.is_empty() {
        return Err("关注清单生成内容为空".to_string());
    }

    // 清单面向 source_date 的次日（0 点链路传昨天 → 面向今天）
    let target = chrono::NaiveDate::parse_from_str(source_date, "%Y-%m-%d")
        .map(|d| d + chrono::Duration::days(1))
        .map(|d| d.format("%Y-%m-%d").to_string())
        .map_err(|e| format!("source_date 格式错误: {}", e))?;
    analyzer::save_setting(db_path, FOCUS_KEY, focus);
    analyzer::save_setting(db_path, FOCUS_DATE_KEY, &target);

    Ok(format!("明日关注已生成（{} 条）", focus.lines().count()))
}

/// 读取今日有效的关注清单（过期/未生成返回 None）——聊天注入与晨间卡共用
pub fn today_focus(conn: &Connection) -> Option<String> {
    let date: String = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [FOCUS_DATE_KEY],
            |row| row.get(0),
        )
        .ok()?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    if date != today {
        return None;
    }
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        [FOCUS_KEY],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .filter(|v| !v.trim().is_empty())
}

/// 「2026-08-01」→「星期六」：日记素材的星期锚点。
/// 模型靠裸日期推不出星期几，会从聊天内容里瞎猜（08-01 周六的日记
/// 被前一天的「明天周末了」带偏成「周五」的教训）。
fn weekday_cn(date: &str) -> &'static str {
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map(|d| match d.weekday() {
            chrono::Weekday::Mon => "星期一",
            chrono::Weekday::Tue => "星期二",
            chrono::Weekday::Wed => "星期三",
            chrono::Weekday::Thu => "星期四",
            chrono::Weekday::Fri => "星期五",
            chrono::Weekday::Sat => "星期六",
            chrono::Weekday::Sun => "星期日",
        })
        .unwrap_or("")
}

/// 日记所属日期当天的用户聊天消息（时间倒序取回后翻转为正序）。
/// 必须锚定日记日期取数——「最近 N 条」不带日期边界时，前几天的聊天会
/// 原样混进今天的素材，模型分不清话是哪天说的（跨天污染的根因）。
fn user_messages_on(conn: &Connection, date: &str, limit: usize) -> Vec<String> {
    // created_at 是 'YYYY-MM-DD HH:MM:SS' 本地时间文本，字典序即时间序
    let next_day = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .ok()
        .map(|d| d + chrono::Duration::days(1))
        .map(|d| d.format("%Y-%m-%d").to_string());
    let Some(next_day) = next_day else {
        return Vec::new();
    };
    let result = conn.prepare(
        "SELECT m.content, m.content_type FROM chat_messages m
         JOIN chat_sessions s ON s.id = m.session_id
         WHERE m.role = 'user' AND s.mode = 'chat'
           AND m.created_at >= ?1 AND m.created_at < ?2
         ORDER BY m.id DESC LIMIT ?3",
    );
    let mut messages: Vec<(String, String)> = result
        .and_then(|mut stmt| {
            let rows = stmt.query_map(rusqlite::params![date, next_day, limit as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();
    messages.reverse();
    // 单条截断，防某条长消息挤爆日记素材；
    // rich 附件消息先降级为引用标签，附件 JSON 原文不当日记素材
    messages
        .into_iter()
        .map(|(content, content_type)| {
            let text = if content_type == "rich" {
                crate::commands::chat::degrade_rich_to_text(&content)
            } else {
                content
            };
            text.chars().take(100).collect()
        })
        .collect()
}

/// 今日记忆变更摘要（行动 + 内容，供日记感知「我今天新认识了他什么」）
/// 日期标签 → 当天正午时间戳（取正午避开 0 点/夏令时边缘，用于「那一天」的日界计算）
fn day_ref_ts(date: &str) -> Option<i64> {
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .ok()?
        .and_hms_opt(12, 0, 0)?
        .and_local_timezone(chrono::Local)
        .single()
        .map(|t| t.timestamp())
}

fn fact_events_on(conn: &Connection, ref_ts: i64) -> Vec<String> {
    let day_start = chrono::DateTime::from_timestamp(ref_ts, 0)
        .map(|utc| utc.with_timezone(&chrono::Local))
        .and_then(|local| {
            local
                .date_naive()
                .and_hms_opt(0, 0, 0)?
                .and_local_timezone(chrono::Local)
                .single()
        })
        .map(|t| t.timestamp())
        .unwrap_or(0);
    conn.prepare(
        "SELECT action, COALESCE(new_text, old_text, '') FROM memory_fact_events
         WHERE created_at >= ?1 ORDER BY id DESC LIMIT 10",
    )
    .and_then(|mut stmt| {
        let rows = stmt.query_map([day_start], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        Ok(rows
            .filter_map(|r| r.ok())
            .map(|(action, text)| format!("- [{}] {}", action, text))
            .collect())
    })
    .unwrap_or_default()
}

/// 日记目录（companion/diary/）
pub fn diary_dir(app_data: &Path) -> PathBuf {
    app_data.join("companion").join("diary")
}
