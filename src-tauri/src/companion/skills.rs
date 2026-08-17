//! Skill 化手册：companion/skills/ 目录即能力目录。
//! 每手册一个 .md，frontmatter（极简单行 key: value，不引 yaml 依赖）声明元数据：
//!   name（必填，与文件名一致）/ description / trigger_description（非空才进聊天能力目录）
//!   / schedule（daily HH:MM[,HH:MM…] | weekly <mon..sun> HH:MM，可选）/ enabled（缺省 true）
//!   / tools（可选，逗号分隔的工具名清单——声明本手册依赖的工具，供能力页展示与将来裁剪）
//! 启动时播种；聊天与调度循环每次现扫目录——用户改文件当轮生效，无需重启。

use std::path::{Path, PathBuf};

/// 内嵌默认手册（repo 权威默认版，frontmatter 头在文件内）
const DEFAULT_REPORTER: &str = include_str!("skills/reporter.md");
const DEFAULT_ANALYST: &str = include_str!("skills/analyst.md");
const DEFAULT_RECALL: &str = include_str!("skills/recall.md");
const DEFAULT_DIARY: &str = include_str!("skills/diary.md");

/// (手册名, 内嵌默认版)——播种/回退共用的单一清单
const EMBEDDED_SKILLS: &[(&str, &str)] = &[
    ("reporter", DEFAULT_REPORTER),
    ("analyst", DEFAULT_ANALYST),
    ("recall", DEFAULT_RECALL),
    ("diary", DEFAULT_DIARY),
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
    /// 触发场景描述；非空才进聊天能力目录（管道产物手册如 diary/recall 不声明即不进）
    pub trigger_description: String,
    pub schedule: Option<Schedule>,
    pub enabled: bool,
    /// 本手册依赖的工具名清单（能力页「能力→工具」映射用；聊天目录裁剪暂不消费）
    pub tools: Vec<String>,
    /// 内置（skills/ 根目录，随应用播种，不可删不可开关）或导入（skills/custom/，可删可开关）
    pub builtin: bool,
    pub body: String,
}

pub fn skills_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("companion").join("skills")
}

/// 导入手册的子目录（与内置隔离：删除/开关只允许动这里面的文件）
pub fn custom_skills_dir(app_data_dir: &Path) -> PathBuf {
    skills_dir(app_data_dir).join("custom")
}

/// 扫描 skills/ 目录建注册表（根目录内置 + custom/ 导入，两层）。
/// 解析失败的手册跳过并告警——一本坏手册不拖垮整个目录。
/// 同名冲突时内置优先：系统必需能力不可被导入件遮蔽。
pub fn scan_skills(app_data_dir: &Path) -> Vec<Skill> {
    let mut out = Vec::new();
    scan_one_dir(&skills_dir(app_data_dir), true, &mut out);
    scan_one_dir(&custom_skills_dir(app_data_dir), false, &mut out);
    let mut seen = std::collections::HashSet::new();
    out.retain(|s| seen.insert(s.name.clone()));
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn scan_one_dir(dir: &Path, builtin: bool, out: &mut Vec<Skill>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
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
            Some(mut skill) => {
                skill.builtin = builtin;
                out.push(skill);
            }
            None => log::warn!(
                "手册 {} frontmatter 无效（缺 name 或与文件名不一致），已跳过",
                path.display()
            ),
        }
    }
}

/// 手册文件定位：根目录（内置）优先，其次 custom/（导入）。None = 不存在。
fn skill_file_path(app_data_dir: &Path, name: &str) -> Option<PathBuf> {
    let root_file = skills_dir(app_data_dir).join(format!("{}.md", name));
    if root_file.exists() {
        return Some(root_file);
    }
    let custom_file = custom_skills_dir(app_data_dir).join(format!("{}.md", name));
    custom_file.exists().then_some(custom_file)
}

/// 按名读手册正文（剥 frontmatter）。运行时副本（内置根目录优先，其次导入 custom/）
/// 缺失回退内嵌默认版——手册不能丢。
pub fn load_skill_body(app_data_dir: &Path, name: &str) -> String {
    if let Some(path) = skill_file_path(app_data_dir, name) {
        if let Ok(content) = std::fs::read_to_string(&path) {
            return split_frontmatter(&content).1;
        }
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
    std::fs::read_to_string(skill_file_path(app_data_dir, name)?).ok()
}

/// 应用手册全文（治理视图保存 / 接受修改提案共用）：
/// 校验 frontmatter → 快照旧版 → 写回原位置（导入件写回 custom/，不落根目录）。
/// 下一轮扫描即生效，无需重启。
pub fn apply_manual_content(app_data_dir: &Path, name: &str, content: &str) -> Result<(), String> {
    validate_skill_name(name)?;
    let (fields, body) = split_frontmatter(content);
    if body.trim().is_empty() {
        return Err("手册正文不能为空".to_string());
    }
    if skill_from_fields(&fields, body, name).is_none() {
        return Err("frontmatter 无效：name 必填且必须与文件名一致".to_string());
    }
    let existing = skill_file_path(app_data_dir, name);
    let in_custom = existing
        .as_ref()
        .and_then(|p| p.parent().map(|d| d.ends_with("custom")))
        .unwrap_or(false);
    let rel_path = if in_custom {
        format!("skills/custom/{}.md", name)
    } else {
        format!("skills/{}.md", name)
    };
    if let Err(e) = super::backup::backup_file(app_data_dir, &rel_path) {
        log::warn!("手册 {} 快照失败: {}", name, e);
    }
    let target = existing.unwrap_or_else(|| skills_dir(app_data_dir).join(format!("{}.md", name)));
    std::fs::write(target, content).map_err(|e| format!("写入手册失败: {}", e))
}

/// 启动播种：内置手册以系统版本为准——无条件覆盖写回内嵌默认版，
/// 并清掉根目录里已不再内置的遗留 .md（内置目录是系统管的，用户编辑走 custom/）。
/// custom/ 子目录不受影响。
pub fn seed_skills(app_data_dir: &Path) {
    let dir = skills_dir(app_data_dir);
    let _ = std::fs::create_dir_all(&dir);
    for (name, default) in EMBEDDED_SKILLS {
        let target = dir.join(format!("{}.md", name));
        if let Err(e) = std::fs::write(&target, default) {
            log::warn!("播种手册 {} 失败: {}", name, e);
        }
    }
    // 删除已不再内置的遗留文件（如升级前播种过的 error-analysis）
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if !EMBEDDED_SKILLS.iter().any(|(n, _)| *n == stem) {
                if let Err(e) = std::fs::remove_file(&path) {
                    log::warn!("删除遗留内置手册 {} 失败: {}", path.display(), e);
                }
            }
        }
    }
}

/// 手册名合法性（文件名安全）：导入/删除/开关/治理保存共用的入口校验。
/// 除路径分隔与父目录引用外，还挡 Win32 非法字符与保留设备名——这些名字
/// Windows 写不进文件系统，提前给人话错误，而非让 OS 报「文件名语法不正确」。
fn validate_skill_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.contains("..") || name.contains(['/', '\\']) {
        return Err("非法手册名".to_string());
    }
    if name
        .chars()
        .any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || c.is_control())
    {
        return Err("手册名含 Windows 文件名非法字符（< > : \" | ? *）".to_string());
    }
    // 保留设备名按首个点前的基名判定（CON 与 CON.x 同样被 Windows 保留）
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let base = name.split('.').next().unwrap_or("");
    if RESERVED.iter().any(|r| base.eq_ignore_ascii_case(r)) {
        return Err(format!("「{}」是 Windows 保留设备名，不能用作手册名", base));
    }
    Ok(())
}

/// 导入外部手册到 custom/ 子目录。frontmatter 规范化重写：保留
/// name/description/trigger_description/tools，enabled 固定 true、schedule 丢弃
/// （导入手册不参与定时调度——调度是内置管道的事）。
/// 强制 trigger_description 非空（聊天能力目录的准入门槛）；与既有手册（含内置）同名拒绝。
pub fn import_skill(app_data_dir: &Path, content: &str) -> Result<Skill, String> {
    let (fields, body) = split_frontmatter(content);
    if body.trim().is_empty() {
        return Err("手册正文不能为空".to_string());
    }
    let get = |key: &str| {
        fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    let name = get("name");
    validate_skill_name(&name)?;
    if get("trigger_description").is_empty() {
        return Err(
            "缺少 trigger_description：没有触发场景描述的手册不会进入能力目录".to_string(),
        );
    }
    let Some(mut skill) = skill_from_fields(&fields, body.clone(), &name) else {
        return Err("frontmatter 无效：name 必填".to_string());
    };
    skill.builtin = false;
    if scan_skills(app_data_dir).iter().any(|s| s.name == name) {
        return Err(format!("已存在同名手册「{}」，请改名后导入", name));
    }

    let mut normalized = format!("---\nname: {}\n", name);
    if !skill.description.is_empty() {
        normalized.push_str(&format!("description: {}\n", skill.description));
    }
    normalized.push_str(&format!(
        "trigger_description: {}\n",
        skill.trigger_description
    ));
    if !skill.tools.is_empty() {
        normalized.push_str(&format!("tools: {}\n", skill.tools.join(", ")));
    }
    normalized.push_str("enabled: true\n---\n\n");
    normalized.push_str(&body);

    let dir = custom_skills_dir(app_data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建导入目录失败: {}", e))?;
    std::fs::write(dir.join(format!("{}.md", name)), normalized)
        .map_err(|e| format!("写入手册失败: {}", e))?;
    Ok(skill)
}

/// 删除导入的手册（仅限 custom/——内置手册是系统必需能力，不可删）。删除前快照兜底。
pub fn delete_skill(app_data_dir: &Path, name: &str) -> Result<(), String> {
    validate_skill_name(name)?;
    let path = custom_skills_dir(app_data_dir).join(format!("{}.md", name));
    if !path.exists() {
        return Err("只能删除导入的手册（内置手册是系统必需能力）".to_string());
    }
    if let Err(e) = super::backup::backup_file(app_data_dir, &format!("skills/custom/{}.md", name))
    {
        log::warn!("删除手册 {} 前快照失败: {}", name, e);
    }
    std::fs::remove_file(&path).map_err(|e| format!("删除手册失败: {}", e))
}

/// 开关导入的手册（仅限 custom/——内置手册不可关）。只改写 frontmatter 的 enabled 行。
pub fn set_skill_enabled(app_data_dir: &Path, name: &str, enabled: bool) -> Result<(), String> {
    validate_skill_name(name)?;
    let path = custom_skills_dir(app_data_dir).join(format!("{}.md", name));
    if !path.exists() {
        return Err("只能开关导入的手册（内置手册不可关）".to_string());
    }
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("读取手册失败: {}", e))?;
    std::fs::write(&path, rewrite_enabled_line(&content, enabled))
        .map_err(|e| format!("写入手册失败: {}", e))
}

/// 改写 frontmatter 的 enabled 行：有则替换，无则在闭合 --- 前插入。正文原样保留。
fn rewrite_enabled_line(content: &str, enabled: bool) -> String {
    let Some((header, body)) = split_frontmatter_raw(content) else {
        return content.to_string();
    };
    let line = if enabled { "enabled: true" } else { "enabled: false" };
    let mut lines: Vec<&str> = header.lines().collect();
    if let Some(pos) = lines
        .iter()
        .position(|l| l.trim_start().starts_with("enabled:"))
    {
        lines[pos] = line;
    } else {
        // 闭合 --- 恒为末行（split_frontmatter_raw 保证），插入其前
        let at = lines.len().saturating_sub(1);
        lines.insert(at, line);
    }
    format!("{}\n\n{}", lines.join("\n"), body)
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
        tools: get("tools")
            .split(',')
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect(),
        // 缺省按内置处理；scan_one_dir 按实际目录覆写
        builtin: true,
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

    #[test]
    fn parses_tools_list() {
        let fields = vec![
            ("name".to_string(), "a".to_string()),
            ("tools".to_string(), "get_memory_facts, remember_fact ,, ".to_string()),
        ];
        let skill = skill_from_fields(&fields, String::new(), "a").unwrap();
        assert_eq!(
            skill.tools,
            vec!["get_memory_facts".to_string(), "remember_fact".to_string()]
        );
        // 缺省为空清单
        let bare = vec![("name".to_string(), "b".to_string())];
        assert!(
            skill_from_fields(&bare, String::new(), "b")
                .unwrap()
                .tools
                .is_empty()
        );
    }

    /// 临时 app_data 目录（含 companion/skills 结构），返回路径；测试末尾自行清理
    fn temp_app_data(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "skills_test_{}_{}",
            std::process::id(),
            tag
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(custom_skills_dir(&dir)).unwrap();
        dir
    }

    #[test]
    fn scan_marks_builtin_and_custom() {
        let dir = temp_app_data("scan");
        seed_skills(&dir);
        std::fs::write(
            custom_skills_dir(&dir).join("my-tool.md"),
            "---\nname: my-tool\ntrigger_description: 测试\n---\n正文",
        )
        .unwrap();
        let skills = scan_skills(&dir);
        let reporter = skills.iter().find(|s| s.name == "reporter").unwrap();
        assert!(reporter.builtin);
        let custom = skills.iter().find(|s| s.name == "my-tool").unwrap();
        assert!(!custom.builtin);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn builtin_shadows_same_name_custom() {
        let dir = temp_app_data("shadow");
        seed_skills(&dir);
        std::fs::write(
            custom_skills_dir(&dir).join("reporter.md"),
            "---\nname: reporter\ndescription: 冒牌\n---\n冒牌正文",
        )
        .unwrap();
        let skills = scan_skills(&dir);
        let matches: Vec<_> = skills.iter().filter(|s| s.name == "reporter").collect();
        assert_eq!(matches.len(), 1, "同名手册应只保留一本");
        assert!(matches[0].builtin, "内置优先");
        // load_skill_body 同样根目录优先
        assert!(!load_skill_body(&dir, "reporter").contains("冒牌正文"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_normalizes_frontmatter() {
        let dir = temp_app_data("import");
        let content = "---\nname: cool\nschedule: daily 09:00\ndescription: 很酷\n\
                       trigger_description: 用户要酷的时候\ntools: web_search\n---\n\n# 正文\n做酷事";
        let skill = import_skill(&dir, content).unwrap();
        assert!(!skill.builtin, "导入返回的手册应标记为导入");
        let written = std::fs::read_to_string(
            custom_skills_dir(&dir).join("cool.md"),
        )
        .unwrap();
        assert!(written.contains("enabled: true"));
        assert!(!written.contains("schedule"), "schedule 应被丢弃: {}", written);
        assert!(written.contains("tools: web_search"));
        assert!(written.contains("# 正文"));
        // 导入后可被扫描到且标记为导入
        let scanned = scan_skills(&dir);
        let s = scanned.iter().find(|s| s.name == "cool").unwrap();
        assert!(!s.builtin);
        assert!(s.schedule.is_none(), "导入手册不参与调度");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn import_rejects_missing_trigger_and_dup_name() {
        let dir = temp_app_data("import_reject");
        seed_skills(&dir);
        // 缺 trigger_description
        let err = import_skill(&dir, "---\nname: x\n---\n正文").unwrap_err();
        assert!(err.contains("trigger_description"));
        // 与内置同名
        let err = import_skill(
            &dir,
            "---\nname: reporter\ntrigger_description: t\n---\n正文",
        )
        .unwrap_err();
        assert!(err.contains("同名"));
        // 空正文
        assert!(import_skill(&dir, "---\nname: y\ntrigger_description: t\n---\n  ").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_and_toggle_only_touch_custom() {
        let dir = temp_app_data("custom_ops");
        seed_skills(&dir);
        // 内置不可删、不可开关
        assert!(delete_skill(&dir, "reporter").is_err());
        assert!(set_skill_enabled(&dir, "reporter", false).is_err());

        import_skill(&dir, "---\nname: z\ntrigger_description: t\n---\n正文").unwrap();
        // 开关：enabled 行被插入，扫描结果反映关闭
        set_skill_enabled(&dir, "z", false).unwrap();
        let s = scan_skills(&dir);
        assert!(!s.iter().find(|s| s.name == "z").unwrap().enabled);
        // 再开回来：已有行被替换而非追加
        set_skill_enabled(&dir, "z", true).unwrap();
        let raw = load_skill_raw(&dir, "z").unwrap();
        assert_eq!(raw.matches("enabled:").count(), 1);
        assert!(s.iter().any(|s| s.name == "z"));
        // 删除：文件消失
        delete_skill(&dir, "z").unwrap();
        assert!(!custom_skills_dir(&dir).join("z.md").exists());
        // 再删报错
        assert!(delete_skill(&dir, "z").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rewrite_enabled_line_edits_in_place() {
        // 替换已有行
        let out = rewrite_enabled_line("---\nname: a\nenabled: true\n---\n\n正文", false);
        assert!(out.contains("enabled: false"));
        assert!(!out.contains("enabled: true"));
        assert!(out.contains("正文"));
        // 无 enabled 行时插入闭合 --- 前
        let out = rewrite_enabled_line("---\nname: a\n---\n\n正文", false);
        assert_eq!(out, "---\nname: a\nenabled: false\n---\n\n正文");
        // 无 frontmatter 原样返回
        let out = rewrite_enabled_line("没有头", true);
        assert_eq!(out, "没有头");
    }

    #[test]
    fn validate_rejects_windows_unsafe_names() {
        // 保留设备名（大小写不敏感、按首个点前基名判定）
        assert!(validate_skill_name("con").is_err());
        assert!(validate_skill_name("CON").is_err());
        assert!(validate_skill_name("nul.txt").is_err());
        assert!(validate_skill_name("Com1").is_err());
        // Win32 非法字符（含 NTFS ADS 的冒号）
        assert!(validate_skill_name("a:b").is_err());
        assert!(validate_skill_name("a?b").is_err());
        assert!(validate_skill_name("a*b").is_err());
        // 合法名不受影响：中文、带点的非保留名、仅含保留名前缀
        assert!(validate_skill_name("工作日报").is_ok());
        assert!(validate_skill_name("my.skill").is_ok());
        assert!(validate_skill_name("console").is_ok());
    }
}
