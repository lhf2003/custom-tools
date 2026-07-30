//! 情感日记与明日关注：贾维斯的「表达通道」私货（Alice #19 双通道隔离）。
//! 日记私有——落 companion/diary/*.md，不做任何 UI 入口（戒条：适当不透明）；
//! 态度指引（attitude.md）与明日关注只注入聊天 prompt，执行通道（分析/日报）不读。
//! 两者都在每晚分析后生成（#18 剧本前置：今晚规划明早），失败只记日志不阻塞链路。

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::llm_provider::models::Scene;

use super::{analyzer, db, persona};

/// 日记与态度指引的分隔标记（与 diary.md 手册的输出格式约定一致）
const ATTITUDE_SPLIT: &str = "===态度===";
/// 明日关注在 settings 表的两个 key
pub const FOCUS_KEY: &str = "daily_focus";
pub const FOCUS_DATE_KEY: &str = "daily_focus_date";

pub fn run_diary_blocking(app_handle: &AppHandle, db_path: &PathBuf, date: &str) -> Result<String, String> {
    tauri::async_runtime::block_on(run_diary(app_handle, db_path, date))
}

/// 生成当晚日记：素材（当日聚合 + 最近聊天 + 今日记忆变更 + 上次态度）→
/// 单次调用两段输出（日记正文 + 态度指引）→ 日记落盘、attitude.md 重写。
pub async fn run_diary(app_handle: &AppHandle, db_path: &PathBuf, date: &str) -> Result<String, String> {
    let conn = Connection::open(db_path).map_err(|e| format!("打开数据库失败: {}", e))?;
    let app_data = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;

    let aggregate = analyzer::aggregate_day(&conn, date).unwrap_or_default();
    let recent_chats = recent_user_messages(&conn, 10);
    let fact_events = today_fact_events(&conn);
    let last_attitude = persona::load_attitude(&app_data);

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
        "{persona}\n\n---\n\n{manual}\n\n---\n\n# 今天的素材\n\n\
         ## 他的电脑使用（{date}）\n{aggregate}\n\n\
         ## 最近他对你说的话\n{chats}\n\n\
         ## 今天你记住/修改的关于他的事\n{events}\n\n\
         ## 你上次写下的态度指引\n{attitude}",
        persona = persona::load(&app_data),
        manual = super::skills::load_skill_body(&app_data, "diary"),
        date = date,
        aggregate = aggregate,
        chats = chats_text,
        events = events_text,
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

pub fn run_focus_blocking(app_handle: &AppHandle, db_path: &PathBuf) -> Result<String, String> {
    tauri::async_runtime::block_on(run_focus(app_handle, db_path))
}

/// 生成「明日关注」：基于记忆 + 活跃意图 + 习惯模式 + 今日使用，
/// 为明天列 3-5 条关注清单，存 settings（晨间卡与聊天注入读取）。
async fn run_focus(app_handle: &AppHandle, db_path: &PathBuf) -> Result<String, String> {
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
                list.iter().map(|d| format!("- {}", d)).collect::<Vec<_>>().join("\n")
            }
        })
        .unwrap_or_else(|_| "（模式查询失败）".to_string());

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let aggregate = analyzer::aggregate_day(&conn, &today).unwrap_or_default();

    let prompt = format!(
        "你是他的 AI 搭档贾维斯。基于以下信息，为他的明天列出 3-5 条值得关注的事。\n\
         要求：每条一行、一句话、具体不空泛；来自素材，不编造；只输出清单本身。\n\n\
         ## 你记住的他\n{facts}\n\n\
         ## 他的备忘意图\n{intents}\n\n\
         ## 已学到的习惯模式\n{patterns}\n\n\
         ## 他今天的电脑使用\n{aggregate}",
        facts = facts_text,
        intents = intents_text,
        patterns = patterns_text,
        aggregate = aggregate,
    );

    let reply = analyzer::call_companion_llm(app_handle, db_path, prompt, "focus").await?;
    let focus = reply.trim();
    if focus.is_empty() {
        return Err("关注清单生成内容为空".to_string());
    }

    let tomorrow = (chrono::Local::now() + chrono::Duration::days(1))
        .format("%Y-%m-%d")
        .to_string();
    analyzer::save_setting(db_path, FOCUS_KEY, focus);
    analyzer::save_setting(db_path, FOCUS_DATE_KEY, &tomorrow);

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

/// 最近 N 条用户在聊天模式下的消息（时间倒序取回后翻转为正序）
fn recent_user_messages(conn: &Connection, limit: usize) -> Vec<String> {
    let result = conn.prepare(
        "SELECT m.content FROM chat_messages m
         JOIN chat_sessions s ON s.id = m.session_id
         WHERE m.role = 'user' AND s.mode = 'chat'
         ORDER BY m.id DESC LIMIT ?1",
    );
    let mut messages: Vec<String> = result
        .and_then(|mut stmt| {
            let rows = stmt.query_map([limit as i64], |row| row.get::<_, String>(0))?;
            Ok(rows.filter_map(|r| r.ok()).collect())
        })
        .unwrap_or_default();
    messages.reverse();
    // 单条截断，防某条长消息挤爆日记素材
    messages
        .into_iter()
        .map(|m| m.chars().take(100).collect())
        .collect()
}

/// 今日记忆变更摘要（行动 + 内容，供日记感知「我今天新认识了他什么」）
fn today_fact_events(conn: &Connection) -> Vec<String> {
    let day_start = chrono::Local::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|t| t.and_local_timezone(chrono::Local).single())
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
