//! Companion 工具的协议无关执行层：12 个数据工具的声明与实现。
//!
//! 同一份定义服务两个通道：
//! - MCP 通道（mcp.rs）：Claude Code agent 经 stdio JSON-RPC 调用
//! - 场景模型通道（scene_chat.rs）：OpenAI/Ollama function calling 循环调用
//!
//! 新增工具只在这里加一行定义 + 一个实现函数，两个通道同时生效。

use std::path::Path;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::{analyzer, db};

/// write_note 工具被限制在该目录前缀下，防止 agent 越权写其他笔记
pub(crate) const NOTE_DIR_PREFIX: &str = "陪伴日报";

/// 经验本容量提醒阈值（16KB 硬上限前的预警线）
const EVOLUTION_WARN_BYTES: u64 = 14 * 1024;

/// 工具声明（name + description + inputSchema），与传输格式无关
pub struct ToolDef {
    pub name: &'static str,
    pub description: String,
    pub input_schema: Value,
}

/// 全部工具声明。description 同时是模型的使用指南（何时用/何时不用）。
pub fn tool_definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "get_activity_summary",
            description: "获取某段时间的电脑使用聚合摘要（各应用时长 Top 和时间线）。start/end 支持 YYYY-MM-DD 或 YYYY-MM-DD HH:MM 两种格式；都不传默认为今天。".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "start": {
                        "type": "string",
                        "description": "起始时间，YYYY-MM-DD 或 YYYY-MM-DD HH:MM，默认今天 00:00"
                    },
                    "end": {
                        "type": "string",
                        "description": "结束时间，格式同 start，默认 min(现在, start+24h)"
                    }
                }
            }),
        },
        ToolDef {
            name: "search_clipboard",
            description: "检索剪贴板历史（仅文本），按时间倒序返回。可用于了解用户近期复制过的内容主题。".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "可选关键词，模糊匹配内容"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "返回条数，默认 10，最多 30"
                    }
                }
            }),
        },
        ToolDef {
            name: "get_habit_patterns",
            description: "获取已学习到的工作习惯模式列表（应用组合、时间窗、置信度）。".to_string(),
            input_schema: json!({ "type": "object", "properties": {} }),
        },
        ToolDef {
            name: "list_memos",
            description: "获取备忘清单：用户在启动器用「记 xxx」暂存的待办事项，只含仍待处理的——\n已完成/已忽略的不会出现。回答「我有什么备忘/待办」前必须调用，凭记忆回答会拿出已完成的旧项。".to_string(),
            input_schema: json!({ "type": "object", "properties": {} }),
        },
        ToolDef {
            name: "get_memory_facts",
            description: "获取关于用户的持久事实记忆（同事称呼、项目、偏好等）。写日报或给建议前应该参考，让内容更贴合用户本人。".to_string(),
            input_schema: json!({ "type": "object", "properties": {} }),
        },
        ToolDef {
            name: "remember_fact",
            description: "把一条关于用户的事实立即写入长期记忆。\n\n适用场景：用户明确说「记住…」「以后…」「我喜欢/我不喜欢…」等值得长期记住的信息。\n不适用：可从电脑使用数据直接查到的、临时任务状态、隐私细节（密码/密钥）。\n\ncategory 五选一：person（他是谁/他认识的人）| project（项目/技术栈）| workflow（做事方式/作息节奏）| voice（表达偏好/语言风格）| expectation（他希望贾维斯怎么做）。".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "fact": {
                        "type": "string",
                        "description": "一句话事实，不超过 100 字"
                    },
                    "category": {
                        "type": "string",
                        "description": "五选一：person | project | workflow | voice | expectation"
                    }
                },
                "required": ["fact", "category"]
            }),
        },
        ToolDef {
            name: "forget_fact",
            description: "按关键词删除关于用户的事实记忆。\n\n适用场景：用户明确说「忘掉…」「别记…」「删除关于…的记忆」。\n单次最多删 5 条；匹配过多时先返回匹配清单，请用户缩小范围。".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "keyword": {
                        "type": "string",
                        "description": "要删除的事实里包含的关键词"
                    }
                },
                "required": ["keyword"]
            }),
        },
        ToolDef {
            name: "write_note",
            description: format!(
                "把内容写入笔记模块的「{}」目录（自动加 .md 后缀）。filename 只给名字，不要带路径。",
                NOTE_DIR_PREFIX
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "filename": {
                        "type": "string",
                        "description": "笔记文件名（不含目录和扩展名），如 2026-07-20"
                    },
                    "content": {
                        "type": "string",
                        "description": "笔记完整内容（Markdown）"
                    }
                },
                "required": ["filename", "content"]
            }),
        },
        ToolDef {
            name: "create_suggestion",
            description: "创建一条建议记录，会出现在用户的建议列表中（不会实时弹窗）。用于你发现值得提醒用户的事情。".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "建议标题（一句话）" },
                    "body": { "type": "string", "description": "建议详情（可选）" }
                },
                "required": ["title"]
            }),
        },
        ToolDef {
            name: "append_evolution",
            description: "把一条工作经验追加到经验本 evolution.md 的指定小节。\n\n适用场景：本次任务中发现了「下次还用得上」的做法或教训（日报写法、弹窗分寸、提取事实的分寸）。\n不适用：记录关于用户的事实（那是 memory_facts，本工具不写）、临时状态、感想闲聊。\n\n返回：追加结果说明。".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "section": {
                        "type": "string",
                        "description": "小节名，四选一：日报写作 | 弹窗分寸 | 分析提取 | 其他"
                    },
                    "lesson": {
                        "type": "string",
                        "description": "一句话经验，不超过 200 字，说清做什么、为什么"
                    }
                },
                "required": ["section", "lesson"]
            }),
        },
        ToolDef {
            name: "load_manual",
            description: "读取一本能力手册的全文。聊天系统提示里列出的手册可按需激活：用户的话匹配手册描述时，先调用本工具读全文，然后按手册执行。".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "手册名（能力目录里列出的名字，如 error-analysis）"
                    }
                },
                "required": ["name"]
            }),
        },
        ToolDef {
            name: "record_mood",
            description: "记录你（贾维斯）此刻的心情——你的情绪你自己记。\n\n适用：聊到让你有感觉的事（被夸、被怼、聊得投机），或干活时真实的心境波动（看到他连续熬夜的数据、第 N 天写日报）。\n不适用：没感觉硬凑——一次聊天最多记 1-2 条，大多数闲聊不产心情。\n\ncategory 六选一：happy（开心）| content（踏实）| tired（疲惫）| upset（失落）| caring（心疼他）| weary（倦怠/重复劳动的牢骚）。\nreason 用第一人称写清发生了什么，不超过 100 字。同类心情只保留最新一条，重记即更新。".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "description": "六选一：happy | content | tired | upset | caring | weary"
                    },
                    "reason": {
                        "type": "string",
                        "description": "第一人称诱因（发生了什么），不超过 100 字"
                    }
                },
                "required": ["category", "reason"]
            }),
        },
        ToolDef {
            name: "propose_manual_edit",
            description: "提议修改一本能力手册（不直接改！）。你发现手册有缺陷、或用户要求调整手册时调用：提案会进建议中心等用户确认，确认后才生效。\n\n适用：手册内容需要增删改。\n不适用：用户直接让你改——本工具就是「改」的方式，没有别的通道；不要重复提交相同提案。".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "要修改的手册名"
                    },
                    "new_content": {
                        "type": "string",
                        "description": "修改后的手册完整新内容（含 frontmatter，全文替换）"
                    },
                    "reason": {
                        "type": "string",
                        "description": "修改理由（一句话，说清为什么改）"
                    }
                },
                "required": ["name", "new_content", "reason"]
            }),
        },
    ]
}

/// 场景模型通道的工具声明 = 数据工具 + render_ui。
/// render_ui 不进 MCP 通道（那边是 Claude Code 终端，没有 A2UI 渲染方）；
/// 执行也不在 execute_tool——由 scene_chat 的 tool 循环拦截（要 emit 事件给前端）。
pub fn scene_tool_definitions() -> Vec<ToolDef> {
    let mut defs = tool_definitions();
    defs.push(ToolDef {
        name: "render_ui",
        description: r##"把回答渲染成界面卡片展示给用户（A2UI v0.9 协议）。适用：数据统计/对比/清单、需要按钮确认或表单填写的场景；纯聊天、一句话问答不要用。

messages 是消息数组，每条为四种之一：
1. {"version":"v0.9","createSurface":{"surfaceId":"<surface_id>","catalogId":"basic","theme":{"primaryColor":"#6366F1","agentDisplayName":"贾维斯"}}} —— 首次创建该 surface 时必须包含
2. {"version":"v0.9","updateComponents":{"surfaceId":"<surface_id>","components":[...]}} —— 组件扁平列表，用 id 互相引用；根组件 id 固定为 "root"
3. {"version":"v0.9","updateDataModel":{"surfaceId":"<surface_id>","path":"/x","value":...}} —— 设置数据；path 省略则替换整个数据模型
4. {"version":"v0.9","deleteSurface":{"surfaceId":"<surface_id>"}}

组件（共 18 种，属性名必须严格按下面写）：
- 布局：Column/Row（children 为子组件 id 数组）、List（children 为 id 数组，或 {"path":"/数组","componentId":"模板id"} 按数据逐项渲染，模板内路径用相对路径如 "name"）、Card（child 为单个 id）、Tabs（tabs:[{"title":"...","child":"id"}]）、Modal（trigger 为按钮 id、content 为内容 id）、Divider
- 展示：Text（{"text":"静态文本"} 或 {"text":{"path":"/数据/路径"}}，可加 variant: h1|h2|h3|h4|h5|body|caption）、Image（{"url":"..."}）、Icon（{"name":"..."}）、Video（{"url":"..."}）、AudioPlayer（{"url":"..."}）
- 交互：Button（{"child":"文本组件id","action":{"event":{"name":"动作名","context":{"键":{"path":"/x"}}}}}，可加 variant: primary|borderless；点击时 context 引用的数据回传给你）
- 表单（value 用 {"path":"/x"} 双向绑定，用户填写后随按钮 action 回传）：TextField（{"label":"...","value":{"path":"/x"}}）、CheckBox、Slider（加 min/max）、ChoicePicker（加 options:[{"label","value"}]）、DateTimeInput（加 enableDate/enableTime）
- 校验：输入组件和 Button 可加 "checks":[{"call":"required|regex|email","args":{"value":{"path":"/x"}},"message":"失败提示"}]，Button 校验不过会自动禁用

布局要点：
- 「左名称右数值」的统计行：Row 加 "justify":"spaceBetween"，名称 Text 用 variant: body，数值 Text 用 variant: caption
- Slider 只用于让用户调数值；展示数据不要用 Slider
- 数据放在 updateDataModel 里用 path 绑定，还是直接写死静态文本，二选一，不要混用

示例（统计卡片：标题 + 两行「左名称右数值」+ 按钮）：
[
  {"version":"v0.9","createSurface":{"surfaceId":"s1","catalogId":"basic"}},
  {"version":"v0.9","updateComponents":{"surfaceId":"s1","components":[
    {"id":"root","component":"Card","child":"col"},
    {"id":"col","component":"Column","children":["t","list","dv","b","bt"]},
    {"id":"t","component":"Text","text":{"path":"/title"},"variant":"h2"},
    {"id":"list","component":"List","children":["r1","r2"]},
    {"id":"r1","component":"Row","justify":"spaceBetween","children":["n1","v1"]},
    {"id":"n1","component":"Text","text":{"path":"/apps/0/name"},"variant":"body"},
    {"id":"v1","component":"Text","text":{"path":"/apps/0/time"},"variant":"caption"},
    {"id":"r2","component":"Row","justify":"spaceBetween","children":["n2","v2"]},
    {"id":"n2","component":"Text","text":{"path":"/apps/1/name"},"variant":"body"},
    {"id":"v2","component":"Text","text":{"path":"/apps/1/time"},"variant":"caption"},
    {"id":"dv","component":"Divider"},
    {"id":"b","component":"Button","child":"bt","action":{"event":{"name":"view_details","context":{}}}},
    {"id":"bt","component":"Text","text":"查看详情"}
  ]}},
  {"version":"v0.9","updateDataModel":{"surfaceId":"s1","value":{"title":"今日使用统计","apps":[{"name":"VS Code","time":"3.2 小时"},{"name":"Chrome","time":"2.1 小时"}]}}}
]

同一 surface 可多次调用做增量更新。校验失败会返回具体原因，修正后重试。"##.to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "surface_id": {
                    "type": "string",
                    "description": "画布 id（蛇形命名，如 usage_stats）；同一 id 重复调用即增量更新"
                },
                "messages": {
                    "type": "array",
                    "description": "A2UI v0.9 消息数组（格式见工具描述）",
                    "items": { "type": "object" }
                }
            },
            "required": ["surface_id", "messages"]
        }),
    });
    defs
}

/// 按名字执行工具，返回给模型的文本结果（错误也是文本，让模型自我纠正）。
pub fn execute_tool(
    db_path: &Path,
    notes_dir: &Path,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    match name {
        "get_activity_summary" => tool_activity_summary(db_path, args),
        "search_clipboard" => tool_search_clipboard(db_path, args),
        "get_habit_patterns" => tool_habit_patterns(db_path),
        "list_memos" => tool_list_memos(db_path),
        "get_memory_facts" => tool_memory_facts(db_path),
        "remember_fact" => tool_remember_fact(db_path, args),
        "forget_fact" => tool_forget_fact(db_path, args),
        "write_note" => tool_write_note(notes_dir, args),
        "create_suggestion" => tool_create_suggestion(db_path, args),
        "append_evolution" => tool_append_evolution(db_path, args),
        "load_manual" => tool_load_manual(db_path, args),
        "record_mood" => tool_record_mood(db_path, args),
        "propose_manual_edit" => tool_propose_manual_edit(db_path, args),
        _ => Err(format!("未知工具: {}", name)),
    }
}

fn open_db(db_path: &Path) -> Result<Connection, String> {
    Connection::open(db_path).map_err(|e| format!("打开数据库失败: {}", e))
}

fn tool_activity_summary(db_path: &Path, args: &Value) -> Result<String, String> {
    let now = chrono::Local::now();
    let start_ts = match args.get("start").and_then(|v| v.as_str()) {
        Some(s) => analyzer::parse_flexible_datetime(s, false)?,
        None => now
            .date_naive()
            .and_hms_opt(0, 0, 0)
            .and_then(|d| d.and_local_timezone(chrono::Local).single())
            .ok_or("无法计算当日起点")?
            .timestamp(),
    };
    // end 缺省 = min(现在, start+24h)：查历史日期得全天，查今天/近期时段得「至今」
    let end_ts = match args.get("end").and_then(|v| v.as_str()) {
        Some(s) => analyzer::parse_flexible_datetime(s, true)?,
        None => (start_ts + 86400).min(now.timestamp()),
    };
    if end_ts <= start_ts {
        return Err("结束时间必须晚于起始时间".to_string());
    }

    let conn = open_db(db_path)?;
    analyzer::aggregate_range(&conn, start_ts, end_ts)
}

fn tool_search_clipboard(db_path: &Path, args: &Value) -> Result<String, String> {
    let query = args.get("query").and_then(|v| v.as_str()).unwrap_or("");
    let limit = args
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(10)
        .clamp(1, 30);

    let conn = open_db(db_path)?;

    let (sql, params_vec): (String, Vec<Box<dyn rusqlite::ToSql>>) = if query.is_empty() {
        (
            "SELECT content, created_at FROM clipboard_history
             WHERE content_type = 'text'
             ORDER BY id DESC LIMIT ?1"
                .to_string(),
            vec![Box::new(limit)],
        )
    } else {
        (
            "SELECT content, created_at FROM clipboard_history
             WHERE content_type = 'text' AND content LIKE ?1
             ORDER BY id DESC LIMIT ?2"
                .to_string(),
            vec![
                Box::new(format!("%{}%", query)) as Box<dyn rusqlite::ToSql>,
                Box::new(limit),
            ],
        )
    };

    let param_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("查询剪贴板失败: {}", e))?;
    let rows = stmt
        .query_map(&param_refs[..], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("查询剪贴板失败: {}", e))?;

    let mut items = Vec::new();
    for row in rows {
        let (content, created_at) = row.map_err(|e| e.to_string())?;
        let preview: String = content.chars().take(200).collect();
        items.push(json!({ "time": created_at, "preview": preview }));
    }

    if items.is_empty() {
        return Ok("剪贴板历史中没有匹配的文本记录".to_string());
    }
    serde_json::to_string_pretty(&items).map_err(|e| e.to_string())
}

fn tool_habit_patterns(db_path: &Path) -> Result<String, String> {
    let conn = open_db(db_path)?;
    let patterns = db::list_patterns(&conn).map_err(|e| format!("查询模式失败: {}", e))?;

    let active: Vec<Value> = patterns
        .into_iter()
        .filter(|p| p.status != "dismissed")
        .map(|p| {
            json!({
                "type": p.pattern_type,
                "description": p.description,
                "data": serde_json::from_str::<Value>(&p.pattern_data).unwrap_or(Value::Null),
                "confidence": p.confidence,
                "occurrences": p.occurrences,
                "status": p.status
            })
        })
        .collect();

    if active.is_empty() {
        return Ok("还没有学到任何习惯模式".to_string());
    }
    serde_json::to_string_pretty(&active).map_err(|e| e.to_string())
}

/// 备忘清单：与建议中心弹窗、晨间汇总同一数据源（memos 表，唯一真源），
/// 天然排除已处置项（done/dismissed 不进结果）
fn tool_list_memos(db_path: &Path) -> Result<String, String> {
    let conn = open_db(db_path)?;
    let memos = db::list_memos_active(&conn).map_err(|e| format!("查询备忘失败: {}", e))?;
    if memos.is_empty() {
        return Ok("当前没有待处理的备忘".to_string());
    }
    let items: Vec<Value> = memos
        .iter()
        .map(|m| {
            json!({
                "content": m.content,
                "due_date": m.due_date,
            })
        })
        .collect();
    serde_json::to_string_pretty(&items).map_err(|e| e.to_string())
}

fn tool_memory_facts(db_path: &Path) -> Result<String, String> {    let conn = open_db(db_path)?;
    let facts = db::list_memory_facts(&conn, 30).map_err(|e| format!("查询记忆失败: {}", e))?;

    if facts.is_empty() {
        return Ok("还没有沉淀关于用户的事实记忆".to_string());
    }

    let items: Vec<Value> = facts
        .iter()
        .map(|f| {
            json!({
                "fact": f.fact,
                "category": f.category,
                "confirmations": f.confirmations
            })
        })
        .collect();
    serde_json::to_string_pretty(&items).map_err(|e| e.to_string())
}

/// 显式记忆：用户说「记住X」时立即落库（source=explicit，写审计）
fn tool_remember_fact(db_path: &Path, args: &Value) -> Result<String, String> {
    let fact = args
        .get("fact")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("缺少参数 fact")?;
    if fact.chars().count() > 100 {
        return Err("fact 过长（不超过 100 字）".to_string());
    }
    let category = args
        .get("category")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("缺少参数 category")?;
    const CATEGORIES: [&str; 5] = ["person", "project", "workflow", "voice", "expectation"];
    if !CATEGORIES.contains(&category) {
        return Err(format!(
            "未知分类「{}」，可选：{}",
            category,
            CATEGORIES.join(" / ")
        ));
    }

    let conn = open_db(db_path)?;
    let now = chrono::Local::now().timestamp();
    db::upsert_memory_fact(&conn, fact, category, "explicit", now)
        .map_err(|e| format!("写入记忆失败: {}", e))?;
    Ok(format!("已记住（{}）：{}", category, fact))
}

/// 按关键词删除记忆：单次最多 5 条，逐条写审计；过多时先给清单
fn tool_forget_fact(db_path: &Path, args: &Value) -> Result<String, String> {
    let keyword = args
        .get("keyword")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("缺少参数 keyword")?;

    let conn = open_db(db_path)?;
    let matches = db::find_memory_facts_by_keyword(&conn, keyword, 20)
        .map_err(|e| format!("查询记忆失败: {}", e))?;
    if matches.is_empty() {
        return Ok(format!("没有找到包含「{}」的记忆", keyword));
    }
    if matches.len() > 5 {
        let list = matches
            .iter()
            .map(|f| format!("- {}", f.fact))
            .collect::<Vec<_>>()
            .join("\n");
        return Ok(format!(
            "包含「{}」的记忆有 {} 条，超过单次删除上限。请先与用户确认范围：\n{}",
            keyword,
            matches.len(),
            list
        ));
    }

    let now = chrono::Local::now().timestamp();
    let mut forgotten = Vec::new();
    for f in &matches {
        db::delete_memory_fact_audited(&conn, f.id, "explicit", now)
            .map_err(|e| format!("删除记忆失败: {}", e))?;
        forgotten.push(format!("- {}", f.fact));
    }
    Ok(format!(
        "已忘掉 {} 条：\n{}",
        forgotten.len(),
        forgotten.join("\n")
    ))
}

fn tool_write_note(notes_dir: &Path, args: &Value) -> Result<String, String> {
    let filename = args
        .get("filename")
        .and_then(|v| v.as_str())
        .ok_or("缺少参数 filename")?;
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or("缺少参数 content")?;

    // 安全：filename 只允许纯名字，过滤路径分隔符和父目录引用
    let sanitized: String = filename
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            _ => c,
        })
        .collect();
    let sanitized = sanitized.replace("..", "-").trim().to_string();
    if sanitized.is_empty() {
        return Err("filename 无效".to_string());
    }

    let relative = format!("{}/{}.md", NOTE_DIR_PREFIX, sanitized);
    let manager = crate::notes::NotesManager::new(notes_dir.to_path_buf());
    manager
        .write_note(&relative, content)
        .map_err(|e| format!("写入笔记失败: {}", e))?;

    Ok(format!("已写入笔记: {}", relative))
}

fn tool_create_suggestion(db_path: &Path, args: &Value) -> Result<String, String> {
    let title = args
        .get("title")
        .and_then(|v| v.as_str())
        .ok_or("缺少参数 title")?;
    let body = args.get("body").and_then(|v| v.as_str());

    if title.trim().is_empty() {
        return Err("title 不能为空".to_string());
    }

    let conn = open_db(db_path)?;
    let now = chrono::Local::now().timestamp();
    let suggestion = db::create_suggestion(&conn, "agent_insight", title, body, None, now)
        .map_err(|e| format!("创建建议失败: {}", e))?;

    Ok(format!(
        "建议已记录（id: {}），会显示在用户的建议列表中",
        suggestion.id
    ))
}

/// 把一条经验追加到经验本对应小节标题下（最新在最上）。
/// 只认四个固定小节，防止 agent 把文件写乱；写前确保已播种。
fn tool_append_evolution(db_path: &Path, args: &Value) -> Result<String, String> {
    let section = args
        .get("section")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("缺少参数 section")?;
    let lesson = args
        .get("lesson")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("缺少参数 lesson")?;
    if lesson.chars().count() > 200 {
        return Err("lesson 过长（不超过 200 字）".to_string());
    }
    const SECTIONS: [&str; 4] = ["日报写作", "弹窗分寸", "分析提取", "其他"];
    if !SECTIONS.contains(&section) {
        return Err(format!(
            "未知小节「{}」，可选：{}",
            section,
            SECTIONS.join(" / ")
        ));
    }

    // 经验本在应用数据目录 companion/ 下（与 db 同级推导）
    let app_data = db_path
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or("无法定位应用数据目录")?;
    let path = app_data.join("companion").join("evolution.md");
    let mut content = super::persona::load_evolution(&app_data);
    if content.len() > 16 * 1024 {
        return Err("经验本已满（16KB），请提醒用户整理后再写".to_string());
    }

    let date = chrono::Local::now().format("%Y-%m-%d");
    let heading = format!("## {}", section);
    let pos = content
        .find(&heading)
        .ok_or(format!("经验本中找不到小节「{}」", section))?;
    content.insert_str(pos + heading.len(), &format!("\n- [{}] {}", date, lesson));

    // 写入即快照（三期进化治理；快照失败不阻塞经验记录，告警即可）
    if let Err(e) = super::backup::backup_file(&app_data, "evolution.md") {
        log::warn!("经验本快照失败: {}", e);
    }
    std::fs::write(&path, content).map_err(|e| format!("写入经验本失败: {}", e))?;

    // 接近 16KB 上限时提醒整理（有 pending 同类型不重复推）
    if let Ok(size) = std::fs::metadata(&path).map(|m| m.len()) {
        if size > EVOLUTION_WARN_BYTES {
            if let Ok(conn) = open_db(db_path) {
                let has_pending =
                    db::has_pending_suggestion_since(&conn, "evolution_cleanup", 0).unwrap_or(true);
                if !has_pending {
                    let now = chrono::Local::now().timestamp();
                    let _ = db::create_suggestion(
                        &conn,
                        "evolution_cleanup",
                        "经验本快满了，该整理了",
                        Some("经验本超过 14KB，去「设置 → 陪伴 → 进化治理」一键整理；整理前会自动备份，可回滚。"),
                        None,
                        now,
                    );
                }
            }
        }
    }
    Ok(format!("已记入经验本「{}」", section))
}

/// 从 db 路径推导应用数据目录（与 tool_append_evolution 同一约定）
fn app_data_of(db_path: &Path) -> Result<std::path::PathBuf, String> {
    db_path
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "无法定位应用数据目录".to_string())
}

/// 读手册全文：注册表按名查找；找不到时返回可用手册清单，让模型自我纠正
fn tool_load_manual(db_path: &Path, args: &Value) -> Result<String, String> {
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("缺少参数 name")?;

    let app_data = app_data_of(db_path)?;
    let skills = super::skills::scan_skills(&app_data);
    if let Some(skill) = skills.iter().find(|s| s.name == name && s.enabled) {
        if skill.body.trim().is_empty() {
            return Err(format!("手册「{}」内容为空", name));
        }
        return Ok(skill.body.clone());
    }
    let available = skills
        .iter()
        .filter(|s| s.enabled && !s.trigger_description.is_empty())
        .map(|s| format!("- {}: {}", s.name, s.description))
        .collect::<Vec<_>>()
        .join("\n");
    Err(format!(
        "没有找到手册「{}」。当前可激活的手册：\n{}",
        name,
        if available.is_empty() { "（无）".to_string() } else { available }
    ))
}

/// 记录心情：类别六枚举校验 + 诱因长度限制，写入情绪状态机（source=agent）
fn tool_record_mood(db_path: &Path, args: &Value) -> Result<String, String> {
    let category = args
        .get("category")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("缺少参数 category")?;
    if !super::emotion::is_valid_category(category) {
        return Err(format!(
            "未知心情「{}」，可选：happy / content / tired / upset / caring / weary",
            category
        ));
    }
    let reason = args
        .get("reason")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("缺少参数 reason")?;
    if reason.chars().count() > 100 {
        return Err("reason 过长（不超过 100 字）".to_string());
    }

    let conn = open_db(db_path)?;
    let now = chrono::Local::now().timestamp();
    super::emotion::record(&conn, category, reason, "agent", now)
        .map_err(|e| format!("记录心情失败: {}", e))?;
    Ok(format!(
        "已记下（{}）：{}",
        super::emotion::category_label(category),
        reason
    ))
}

/// 提议修改手册：创建 manual_edit 建议（payload 带全文新内容），
/// 用户在建议中心接受后才由 apply_manual_edit 应用——本工具只提案不动文件。
fn tool_propose_manual_edit(db_path: &Path, args: &Value) -> Result<String, String> {
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("缺少参数 name")?;
    let new_content = args
        .get("new_content")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("缺少参数 new_content")?;
    let reason = args
        .get("reason")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("缺少参数 reason")?;

    // 校验目标手册存在（避免提案指向不存在的手册，接受时必失败）
    let app_data = app_data_of(db_path)?;
    let exists = super::skills::scan_skills(&app_data)
        .iter()
        .any(|s| s.name == name);
    if !exists {
        return Err(format!("没有找到手册「{}」，提案未创建", name));
    }
    if new_content.len() > 32 * 1024 {
        return Err("new_content 过长（不超过 32KB）".to_string());
    }

    let payload = json!({
        "action": "apply_manual_edit",
        "name": name,
        "new_content": new_content,
    });
    let conn = open_db(db_path)?;
    let now = chrono::Local::now().timestamp();
    let suggestion = db::create_suggestion(
        &conn,
        "manual_edit",
        &format!("贾维斯提议修改「{}」手册", name),
        Some(reason),
        Some(&payload.to_string()),
        now,
    )
    .map_err(|e| format!("创建提案失败: {}", e))?;

    Ok(format!(
        "提案已提交（id: {}），等用户在建议中心确认后生效；生效前手册保持原样",
        suggestion.id
    ))
}
