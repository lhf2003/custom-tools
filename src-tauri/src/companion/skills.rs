//! Skill 化手册：companion/skills/ 目录即能力目录。
//! 每手册一个 .md，frontmatter（极简单行 key: value，不引 yaml 依赖）声明元数据：
//!   name（必填，与文件名一致）/ description / trigger_description（有值才进聊天能力目录）
//!   / schedule（daily HH:MM[,HH:MM…] | weekly <mon..sun> HH:MM，可选）/ enabled（缺省 true）
//! 启动时播种；旧 companion/agents/ 目录一次性迁移（内容搬进 skills/ 后整目录删除）。
//! 聊天与调度循环每次现扫目录——用户改文件当轮生效，无需重启。

use std::path::{Path, PathBuf};

/// 内嵌默认手册（repo 权威默认版，frontmatter 头在文件内）
const DEFAULT_REPORTER: &str = include_str!("skills/reporter.md");
const DEFAULT_ANALYST: &str = include_str!("skills/analyst.md");
const DEFAULT_RECALL: &str = include_str!("skills/recall.md");
const DEFAULT_DIARY: &str = include_str!("skills/diary.md");
const DEFAULT_ERROR_ANALYSIS: &str = include_str!("skills/error-analysis.md");

/// (手册名, 内嵌默认版)——播种/迁移/回退共用的单一清单
const EMBEDDED_SKILLS: &[(&str, &str)] = &[
    ("reporter", DEFAULT_REPORTER),
    ("analyst", DEFAULT_ANALYST),
    ("recall", DEFAULT_RECALL),
    ("diary", DEFAULT_DIARY),
    ("error-analysis", DEFAULT_ERROR_ANALYSIS),
];

/// 机器可读触发时刻（weekday 与 chrono num_days_from_monday 对齐：0=周一 … 6=周日）
/// Daily 支持逗号/空格分隔的多个时刻（如 daily 09:00,14:00,18:00,00:00），按时间升序去重。
#[derive(Debug, Clone, PartialEq)]
pub enum Schedule {
    Daily {
        times: Vec<(u32, u32)>,
    },
    Weekly {
        weekday: u32,
        hour: u32,
        minute: u32,
    },
}

/// 一本手册：frontmatter 元数据 + 正文
#[derive(Debug, Clone)]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// 补充触发场景描述；为空 = 手册元数据仍进聊天能力目录，只是没有额外触发提示
    pub trigger_description: String,
    pub schedule: Option<Schedule>,
    pub enabled: bool,
    pub body: String,
}

pub fn skills_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("companion").join("skills")
}

/// 扫描 skills/ 目录建注册表。解析失败的手册跳过并告警——一本坏手册不拖垮整个目录。
pub fn scan_skills(app_data_dir: &Path) -> Vec<Skill> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(skills_dir(app_data_dir)) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let (fields, body) = split_frontmatter(&content);
        match skill_from_fields(&fields, body, &stem) {
            Some(skill) => out.push(skill),
            None => log::warn!(
                "手册 {} frontmatter 无效（缺 name 或与文件名不一致），已跳过",
                path.display()
            ),
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 按名读手册正文（剥 frontmatter）。运行时副本缺失回退内嵌默认版——手册不能丢。
pub fn load_skill_body(app_data_dir: &Path, name: &str) -> String {
    let path = skills_dir(app_data_dir).join(format!("{}.md", name));
    if let Ok(content) = std::fs::read_to_string(&path) {
        return split_frontmatter(&content).1;
    }
    for (n, default) in EMBEDDED_SKILLS {
        if *n == name {
            return split_frontmatter(default).1;
        }
    }
    String::new()
}

/// 按名读手册完整原文（含 frontmatter）——治理视图编辑器用（schedule/enabled 也可编辑）。
pub fn load_skill_raw(app_data_dir: &Path, name: &str) -> Option<String> {
    std::fs::read_to_string(skills_dir(app_data_dir).join(format!("{}.md", name))).ok()
}

/// 应用手册全文（治理视图保存 / 接受修改提案共用）：
/// 校验 frontmatter → 快照旧版 → 写入。下一轮扫描即生效，无需重启。
pub fn apply_manual_content(app_data_dir: &Path, name: &str, content: &str) -> Result<(), String> {
    if name.contains("..") || name.contains(['/', '\\']) || name.is_empty() {
        return Err("非法手册名".to_string());
    }
    let (fields, body) = split_frontmatter(content);
    if body.trim().is_empty() {
        return Err("手册正文不能为空".to_string());
    }
    if skill_from_fields(&fields, body, name).is_none() {
        return Err("frontmatter 无效：name 必填且必须与文件名一致".to_string());
    }
    if let Err(e) = super::backup::backup_file(app_data_dir, &format!("skills/{}.md", name)) {
        log::warn!("手册 {} 快照失败: {}", name, e);
    }
    std::fs::write(
        skills_dir(app_data_dir).join(format!("{}.md", name)),
        content,
    )
    .map_err(|e| format!("写入手册失败: {}", e))
}

/// 启动播种：skills/<name>.md 不存在时写入。
/// 一次性迁移：v0.4 前手册在 companion/agents/——存在则把内容（用户可能有编辑）
/// 前置 frontmatter 搬进 skills/，随后整目录物理删除，不留兼容路径。
pub fn seed_skills(app_data_dir: &Path) {
    let dir = skills_dir(app_data_dir);
    let _ = std::fs::create_dir_all(&dir);
    let legacy = app_data_dir.join("companion").join("agents");
    let legacy_exists = legacy.is_dir();
    for (name, default) in EMBEDDED_SKILLS {
        let target = dir.join(format!("{}.md", name));
        if target.exists() {
            continue;
        }
        let content = if legacy_exists {
            match std::fs::read_to_string(legacy.join(format!("{}.md", name))) {
                Ok(old) => match split_frontmatter_raw(default) {
                    Some((header, _)) => format!("{}\n\n{}", header.trim_end(), old.trim()),
                    None => old,
                },
                Err(_) => default.to_string(),
            }
        } else {
            default.to_string()
        };
        if let Err(e) = std::fs::write(&target, content) {
            log::warn!("播种手册 {} 失败: {}", name, e);
        }
    }
    if legacy_exists {
        let _ = std::fs::remove_dir_all(&legacy);
    }
}

/// 从字段表构建手册；name 必填且与文件名一致，否则视为坏手册。
fn skill_from_fields(fields: &[(String, String)], body: String, stem: &str) -> Option<Skill> {
    let get = |key: &str| {
        fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    let name = get("name");
    if name.is_empty() || name != stem {
        return None;
    }
    let enabled = !get("enabled").eq_ignore_ascii_case("false");
    let schedule_raw = get("schedule");
    let schedule = if schedule_raw.is_empty() {
        None
    } else {
        let parsed = parse_schedule(&schedule_raw);
        if parsed.is_none() {
            log::warn!(
                "手册 {} 的 schedule「{}」无法解析，按无定时处理",
                name,
                schedule_raw
            );
        }
        parsed
    };
    Some(Skill {
        name,
        description: get("description"),
        trigger_description: get("trigger_description"),
        schedule,
        enabled,
        body,
    })
}

/// 拆分 frontmatter：返回 (字段表, 正文)。无/畸形 frontmatter 时字段表为空、正文为全文。
fn split_frontmatter(content: &str) -> (Vec<(String, String)>, String) {
    let Some((header, body)) = split_frontmatter_raw(content) else {
        return (vec![], content.to_string());
    };
    let fields = header
        .lines()
        .filter(|l| l.trim_end_matches('\r').trim() != "---")
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect();
    (fields, body)
}

/// 定位 frontmatter 原始区块：返回 (含首尾 --- 的头部, 正文)。容忍 CRLF。
fn split_frontmatter_raw(content: &str) -> Option<(String, String)> {
    if !content.starts_with("---") {
        return None;
    }
    let mut search_from = 3;
    while let Some(pos) = content[search_from..].find("\n---") {
        let abs = search_from + pos;
        let after = &content[abs + 4..];
        // 闭合行：--- 后只允许换行/回车/空白到行尾
        let line_end = after.find('\n').unwrap_or(after.len());
        if after[..line_end].trim() == "" {
            let header = content[..abs + 4].to_string();
            let body = after[line_end..]
                .trim_start_matches(['\r', '\n'])
                .to_string();
            return Some((header, body));
        }
        search_from = abs + 4;
    }
    None
}

/// 解析 schedule 字段：daily HH:MM[,HH:MM…]（空格分隔亦可）| weekly <mon..sun> HH:MM
fn parse_schedule(s: &str) -> Option<Schedule> {
    let parts: Vec<&str> = s.split_whitespace().collect();
    match parts.as_slice() {
        ["daily", rest @ ..] if !rest.is_empty() => {
            let mut times: Vec<(u32, u32)> = rest
                .join(",")
                .split(',')
                .map(|t| parse_time(t.trim()))
                .collect::<Option<Vec<_>>>()?;
            times.sort_unstable();
            times.dedup();
            (!times.is_empty()).then_some(Schedule::Daily { times })
        }
        ["weekly", dow, time] => {
            let weekday = parse_weekday(dow)?;
            parse_time(time).map(|(hour, minute)| Schedule::Weekly {
                weekday,
                hour,
                minute,
            })
        }
        _ => None,
    }
}

fn parse_time(s: &str) -> Option<(u32, u32)> {
    let (h, m) = s.split_once(':')?;
    let hour: u32 = h.parse().ok()?;
    let minute: u32 = m.parse().ok()?;
    (hour < 24 && minute < 60).then_some((hour, minute))
}

fn parse_weekday(s: &str) -> Option<u32> {
    match s.to_ascii_lowercase().as_str() {
        "mon" => Some(0),
        "tue" => Some(1),
        "wed" => Some(2),
        "thu" => Some(3),
        "fri" => Some(4),
        "sat" => Some(5),
        "sun" => Some(6),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_and_body() {
        let content = "---\nname: reporter\nschedule: daily 21:00\n---\n\n# 正文\n干活";
        let (fields, body) = split_frontmatter(content);
        assert_eq!(fields.len(), 2);
        assert_eq!(fields[0], ("name".to_string(), "reporter".to_string()));
        assert_eq!(body, "# 正文\n干活");
    }

    #[test]
    fn tolerates_crlf_and_missing_frontmatter() {
        let (fields, body) = split_frontmatter("---\r\nname: a\r\n---\r\n正文");
        assert_eq!(fields.len(), 1);
        assert_eq!(body, "正文");
        let (fields2, body2) = split_frontmatter("没有头的文件");
        assert!(fields2.is_empty());
        assert_eq!(body2, "没有头的文件");
    }

    #[test]
    fn value_may_contain_colon() {
        let (fields, _) = split_frontmatter("---\nschedule: daily 21:00\n---\nx");
        assert_eq!(fields[0].1, "daily 21:00");
    }

    #[test]
    fn parses_schedules() {
        assert_eq!(
            parse_schedule("daily 21:00"),
            Some(Schedule::Daily {
                times: vec![(21, 0)]
            })
        );
        assert_eq!(
            parse_schedule("daily 09:00,14:00,18:00,00:00"),
            Some(Schedule::Daily {
                times: vec![(0, 0), (9, 0), (14, 0), (18, 0)]
            })
        );
        // 空格分隔等价；重复时刻去重
        assert_eq!(
            parse_schedule("daily 14:00 09:00 14:00"),
            Some(Schedule::Daily {
                times: vec![(9, 0), (14, 0)]
            })
        );
        assert_eq!(
            parse_schedule("weekly fri 17:30"),
            Some(Schedule::Weekly {
                weekday: 4,
                hour: 17,
                minute: 30
            })
        );
        assert_eq!(parse_schedule("daily 25:00"), None);
        assert_eq!(parse_schedule("daily 09:00,25:00"), None);
        assert_eq!(parse_schedule("daily"), None);
        assert_eq!(parse_schedule("monthly 1 09:00"), None);
        assert_eq!(parse_schedule("garbage"), None);
    }

    #[test]
    fn skill_requires_matching_name() {
        let fields = vec![("name".to_string(), "reporter".to_string())];
        assert!(skill_from_fields(&fields, "正文".into(), "reporter").is_some());
        assert!(skill_from_fields(&fields, "正文".into(), "other").is_none());
        assert!(skill_from_fields(&[], "正文".into(), "reporter").is_none());
    }

    #[test]
    fn enabled_defaults_true() {
        let fields = vec![("name".to_string(), "a".to_string())];
        assert!(
            skill_from_fields(&fields, String::new(), "a")
                .unwrap()
                .enabled
        );
        let off = vec![
            ("name".to_string(), "a".to_string()),
            ("enabled".to_string(), "false".to_string()),
        ];
        assert!(!skill_from_fields(&off, String::new(), "a").unwrap().enabled);
    }
}
