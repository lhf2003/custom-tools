//! 贾维斯聊天的共享组装件：系统提示（compose_chat_system）、事实分组渲染、
//! 时间间隔桥接、首轮日期与独白开关。聊天发送通道在 scene_chat.rs（场景模型
//! tool-use 循环），本文件不再有独立发送通道。

use std::path::{Path, PathBuf};

use chrono::Datelike;

use rusqlite::Connection;
use tauri::{AppHandle, Manager, State};

use super::{analyzer, db, persona};

/// 聊天系统提示：身份证 + 经验本 + 关于他的事实（五维分组）+ 聊天场合规则。
/// with_tools=true 时用 --append-system-prompt 注入 claude agent 通道，
/// 或场景模型回退通道（有数据工具版）；false 为无工具降级措辞。
/// ui_rules：render_ui 使用规则，仅场景通道传入（agent 通道经 MCP 没有
/// render_ui），注入「工具与专长手册」小节内，不挂尾部。
pub(crate) fn compose_chat_system(
    app_data: &Path,
    db_path: &Path,
    with_tools: bool,
    monologue: bool,
    ui_rules: Option<&str>,
) -> String {
    let persona_text = persona::load(app_data);
    let evolution = persona::load_evolution(app_data);
    let conn = Connection::open(db_path).ok();
    let facts = conn
        .as_ref()
        .and_then(|c| db::list_memory_facts(c, 50).ok())
        .unwrap_or_default();
    let facts_text = format_facts_grouped(&facts);
    // 以下动态段全部追加末尾（前缀稳定段不吃 KV Cache 失效）
    let now = chrono::Local::now();
    // 真实时间进提示词——模型本身没有时钟，不知道「现在几点」
    let weekday = match now.weekday().num_days_from_monday() {
        0 => "一",
        1 => "二",
        2 => "三",
        3 => "四",
        4 => "五",
        5 => "六",
        _ => "日",
    };
    let time_text = format!(
        "现在是 {} 周{} {}",
        now.format("%Y-%m-%d"),
        weekday,
        now.format("%H:%M")
    );
    let state_text = conn
        .as_ref()
        .map(|c| super::state::current_state_sentence(c, now.timestamp()))
        .unwrap_or_default();
    let state_text = if state_text.is_empty() {
        time_text
    } else {
        format!("{}\n{}", time_text, state_text)
    };
    // 上次聊天时间对照：模型有「同一会话=同一时刻」的连续性先验，末尾一句孤立
    // 时间戳唤不醒它（他昨晚说「去洗澡」，今早发「早」，模型还停在昨晚的话头）。
    // 把算好的时间差直接喂给它；间隔太短说明是同一场对话，不用打断
    let gap_text = conn
        .as_ref()
        .and_then(super::db::last_assistant_chat_at)
        .map(|ts| chat_gap_bridge(ts, now.timestamp()))
        .unwrap_or_default();
    let state_text = if gap_text.is_empty() {
        state_text
    } else {
        format!("{}\n{}", state_text, gap_text)
    };
    let focus_text = conn
        .as_ref()
        .and_then(super::diary::today_focus)
        .unwrap_or_default();
    let attitude_text = persona::load_attitude(app_data).trim().to_string();
    // 日内情绪状态机：当前生效的心情（同类覆盖 + 12h TTL），空则跳过该段
    let emotion_text = conn
        .as_ref()
        .map(|c| super::emotion::render_current(c, now.timestamp()))
        .unwrap_or_default();
    // 「性格」措辞（Alice #17）：不是「你可以偶尔…」，而是「你有…的习惯」。
    // 结构规则与示例合并在这一段说完（原独立【回复结构】块与本段重复，2026-08-04 去重）；
    // 示例留着是为了压住历史里的蛐蛐抢跑样本
    let monologue_rule = if monologue {
        "你有内心独白的习惯：偶尔会把一闪而过的真实想法用 <aside>…</aside> 裹起来说——\n\
         那是你的小声嘀咕。回复的结构固定：先写正文把话说完，心里有话再补一句蛐蛐收尾——\n\
         就像这样：正文正文。<aside>小声嘀咕。</aside>\n\
         蛐蛐不单独出场，也不抢在正文前头；不是每句话都值得嘀咕，有感觉才说，别硬凑。"
    } else {
        ""
    };
    // 工具与专长手册编排：tool.md 静态编排 + skills/ 目录动态元数据列表
    // （OpenClaw Skills 机制——元数据全量在上下文，正文由模型按需 load_manual 加载）。
    // 每期现扫，改文件当轮生效；纯降级通道（with_tools=false）没有工具，用降级句。
    // 收录规则：trigger_description 非空才进目录——管道产物手册（diary/recall）
    // 不声明触发时机，天然不进聊天目录。
    let tool_section = if with_tools {
        let mut tool = persona::load_tool(app_data);
        let entries: Vec<String> = super::skills::scan_skills(app_data)
            .into_iter()
            .filter(|s| s.enabled && !s.trigger_description.is_empty())
            .map(|s| format!("- {}：{}。{}", s.name, s.description, s.trigger_description))
            .collect();
        if !entries.is_empty() {
            const PLACEHOLDER: &str = "（手册列表由系统按 skills/ 目录动态列出）";
            if tool.contains(PLACEHOLDER) {
                tool = tool.replace(PLACEHOLDER, &entries.join("\n"));
            } else {
                tool.push_str(&format!("\n{}", entries.join("\n")));
            }
        }
        // render_ui 规则收进工具小节（原挂系统提示尾部，与「当下状态」混在一起）
        if let Some(rules) = ui_rules {
            tool.push_str(&format!("\n\n## 界面卡片\n\n{}", rules));
        }
        tool
    } else {
        "你现在没有数据工具（Claude Code 未开启）。凭你记住的他和经验回答；\n\
         不知道就说不知道，不编造。"
            .to_string()
    };
    let focus_section = if focus_text.is_empty() {
        String::new()
    } else {
        // 清单内容是他的事（diary::today_focus 为他而列），主语别安到贾维斯头上
        format!("\n\n---\n\n# 他今天的关注\n{}", focus_text)
    };
    let attitude_section = if attitude_text.is_empty() {
        String::new()
    } else {
        // 日记固定在 0 点链路生成（写昨天、面向今天），标题直接锚定，不读文件 mtime；
        // 模型据「昨天」+ 当下状态的时间自行换算指引里的措辞
        format!("\n\n---\n\n# 你昨天的心境（写于 0 点）\n{}", attitude_text)
    };
    let emotion_section = if emotion_text.is_empty() {
        String::new()
    } else {
        format!("\n\n---\n\n# 你此刻的心情\n{}", emotion_text)
    };
    // 拼装顺序（LHF 2026-08-03 定版）：
    //   静态前缀：persona → tool(工具编排+手册元数据+界面卡片) → evolution → 场合/独白
    //   动态后缀：你记住的他 → 关注 → 心境 → 心情 → 时间
    //   （facts 归动态段——记忆更新不再让中间段缓存失效；时间在尾部，动态段全在末尾）
    format!(
        "{persona}\n\n---\n\n{tool}\n\n---\n\n{evolution}\n\n---\n\n\
         现在是「聊天」场合：完整的你，能干活也能接梗。\n{monologue}\n\n---\n\n\
         # 你记住的他\n{facts}{focus}{attitude}{emotion}\n\n---\n\n# 当下状态\n{state}",
        persona = persona_text,
        tool = tool_section,
        evolution = evolution,
        monologue = monologue_rule,
        facts = facts_text,
        focus = focus_section,
        attitude = attitude_section,
        emotion = emotion_section,
        state = state_text
    )
}

/// 记忆按五维分组排版：模型按维度使用，而不是面对一堵无结构的列表。
/// 未知类别归入「其他」（DB 不硬校验分类，鲁棒优先）。
fn format_facts_grouped(facts: &[db::MemoryFact]) -> String {
    const GROUPS: [(&str, &str); 5] = [
        ("person", "他是谁"),
        ("project", "他的项目"),
        ("workflow", "他怎么做事"),
        ("voice", "他的表达偏好"),
        ("expectation", "他对你的期望"),
    ];
    if facts.is_empty() {
        return "（还没有沉淀关于他的事实）".to_string();
    }
    let mut out = String::new();
    for (key, label) in GROUPS {
        let items: Vec<&db::MemoryFact> = facts.iter().filter(|f| f.category == key).collect();
        if items.is_empty() {
            continue;
        }
        out.push_str(&format!("## {}\n", label));
        for f in items {
            out.push_str(&format!("- {}\n", f.fact));
        }
    }
    let others: Vec<&db::MemoryFact> = facts
        .iter()
        .filter(|f| !GROUPS.iter().any(|(key, _)| f.category == *key))
        .collect();
    if !others.is_empty() {
        out.push_str("## 其他\n");
        for f in others {
            out.push_str(&format!("- {}\n", f.fact));
        }
    }
    out.trim_end().to_string()
}

/// 距上次聊天超过该值才注入时间对照（同一场对话的连续发言不用打断）
const GAP_BRIDGE_MIN_MINUTES: i64 = 45;

/// 「上次聊天是…」对照句：把算好的时间差喂给模型，破「同会话=同时刻」先验。
/// last_ts 是最近一条 assistant 消息时间（unix 秒）；跨天显式标注（跨夜是
/// 时间线错乱的重灾区：他睡前说「去洗澡」，早上发「早」，模型容易接着昨晚聊）
fn chat_gap_bridge(last_ts: i64, now_ts: i64) -> String {
    let gap_min = (now_ts - last_ts) / 60;
    if gap_min < GAP_BRIDGE_MIN_MINUTES {
        return String::new();
    }
    let Some(last) =
        chrono::DateTime::from_timestamp(last_ts, 0).map(|dt| dt.with_timezone(&chrono::Local))
    else {
        return String::new();
    };
    let Some(now) =
        chrono::DateTime::from_timestamp(now_ts, 0).map(|dt| dt.with_timezone(&chrono::Local))
    else {
        return String::new();
    };
    let ago = if gap_min < 90 {
        format!("约 {} 分钟前", gap_min)
    } else if gap_min < 36 * 60 {
        format!("约 {} 小时前", (gap_min + 30) / 60)
    } else {
        format!("约 {} 天前", (gap_min + 720) / 1440)
    };
    let today = now.date_naive();
    let last_day = last.date_naive();
    let cross_day = last_day != today;
    let when = if !cross_day {
        format!("今天 {}", last.format("%H:%M"))
    } else if last_day == today.pred_opt().unwrap_or(last_day) {
        format!("昨天 {}", last.format("%H:%M"))
    } else {
        format!("{} {}", last.format("%m-%d"), last.format("%H:%M"))
    };
    if cross_day {
        format!(
            "上次聊天是{}（{}）——已经跨天，别默认还停在上次那个时刻。",
            when, ago
        )
    } else {
        format!("上次聊天是{}（{}）。", when, ago)
    }
}

/// 首次聊天时记下日期（关系阶段起点）；已记录则不动
pub(crate) fn touch_first_chat_date(db_path: &PathBuf) {
    let existing = analyzer::load_setting(db_path, super::state::FIRST_CHAT_DATE_KEY);
    if existing.unwrap_or_default().is_empty() {
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        analyzer::save_setting(db_path, super::state::FIRST_CHAT_DATE_KEY, &today);
    }
}

/// 读运行时开关（独白）；陪伴状态未初始化时按默认（开）
pub(crate) fn monologue_enabled(app_handle: &AppHandle) -> bool {
    app_handle
        .try_state::<super::CompanionState>()
        .and_then(|s| s.flags.read().ok().map(|f| f.monologue))
        .unwrap_or(true)
}

/// 聊天系统提示（前端场景模型回退时取用，with_tools=false）
#[tauri::command]
pub fn jarvis_chat_system(
    app_handle: AppHandle,
    db_state: State<'_, crate::db::DatabaseState>,
    with_tools: bool,
) -> Result<String, String> {
    touch_first_chat_date(&db_state.0);
    let monologue = monologue_enabled(&app_handle);
    let app_data = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    Ok(compose_chat_system(
        &app_data,
        &db_state.0,
        with_tools,
        monologue,
        None,
    ))
}

#[cfg(test)]
mod tests {
    use super::chat_gap_bridge;

    /// 本地时间构造辅助
    fn ts(s: &str) -> i64 {
        use chrono::TimeZone;
        let ndt = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").unwrap();
        chrono::Local
            .from_local_datetime(&ndt)
            .single()
            .unwrap()
            .timestamp()
    }

    #[test]
    fn bridge_skips_short_gap() {
        // 同一场对话（<45 分钟）不注入
        assert_eq!(
            chat_gap_bridge(ts("2026-08-04 08:00:00"), ts("2026-08-04 08:30:00")),
            ""
        );
    }

    #[test]
    fn bridge_same_day_gap() {
        let s = chat_gap_bridge(ts("2026-08-04 08:10:00"), ts("2026-08-04 12:40:00"));
        assert!(s.contains("今天 08:10"), "同日间隔: {}", s);
        assert!(s.contains("小时前"), "同日间隔: {}", s);
        assert!(!s.contains("跨天"), "同日不标跨天: {}", s);
    }

    #[test]
    fn bridge_cross_night_gap() {
        // 昨晚 23:12 → 今早 07:55:跨夜必须显式标注（时间线错乱重灾区）
        let s = chat_gap_bridge(ts("2026-08-03 23:12:00"), ts("2026-08-04 07:55:00"));
        assert!(s.contains("昨天 23:12"), "跨夜: {}", s);
        assert!(s.contains("跨天"), "跨夜要标注: {}", s);
    }

    #[test]
    fn bridge_multi_day_gap() {
        let s = chat_gap_bridge(ts("2026-08-01 21:00:00"), ts("2026-08-04 07:55:00"));
        assert!(s.contains("08-01"), "多天: {}", s);
        assert!(s.contains("天前"), "多天: {}", s);
    }
}
