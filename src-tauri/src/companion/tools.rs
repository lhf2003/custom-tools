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

use super::{analyzer, db, fact_pipeline};

/// write_note 工具被限制在该目录前缀下，防止 agent 越权写其他笔记
pub(crate) const NOTE_DIR_PREFIX: &str = "陪伴日报";

/// 经验本容量提醒阈值（16KB 硬上限前的预警线）
const EVOLUTION_WARN_BYTES: u64 = 14 * 1024;

/// 工具分组（设置页「工具」页签的分组维度）
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ToolGroup {
    /// 感知：了解他的电脑使用、剪贴板、习惯与备忘
    Perception,
    /// 记忆与成长：沉淀记忆、笔记、建议与经验
    Growth,
    /// 界面渲染：把回答画成界面卡片
    Interface,
    /// 系统操作：在这台电脑上执行命令
    System,
    /// 网络：联网搜索获取最新信息
    Network,
}

impl ToolGroup {
    pub fn id(&self) -> &'static str {
        match self {
            ToolGroup::Perception => "perception",
            ToolGroup::Growth => "growth",
            ToolGroup::Interface => "interface",
            ToolGroup::System => "system",
            ToolGroup::Network => "network",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            ToolGroup::Perception => "感知",
            ToolGroup::Growth => "记忆与成长",
            ToolGroup::Interface => "界面渲染",
            ToolGroup::System => "系统操作",
            ToolGroup::Network => "网络",
        }
    }

    pub fn description(&self) -> &'static str {
        match self {
            ToolGroup::Perception => "了解电脑使用环境信息、剪贴板、习惯与备忘",
            ToolGroup::Growth => "沉淀记忆、笔记、建议与经验",
            ToolGroup::Interface => "模型回答可视化",
            ToolGroup::System => "在这台电脑上执行命令",
            ToolGroup::Network => "联网搜索获取最新信息",
        }
    }

    /// 全部分组（设置页按此顺序展示）
    pub fn all() -> [ToolGroup; 5] {
        [
            ToolGroup::Perception,
            ToolGroup::Growth,
            ToolGroup::Interface,
            ToolGroup::System,
            ToolGroup::Network,
        ]
    }
}

/// 工具声明（name + description + inputSchema + 设置页元数据 + 对外标记），与传输格式无关
pub struct ToolDef {
    pub name: &'static str,
    /// 设置页展示名（中文短名）
    pub display_name: &'static str,
    pub group: ToolGroup,
    /// 核心工具锁定不可关——贾维斯的感知/记忆/成长能力，关了人格就残缺
    pub core: bool,
    /// 对外 MCP 客户端可见（tools/list 按此过滤）；false = 仅 app 内场景通道
    pub external: bool,
    pub description: String,
    pub input_schema: Value,
}

/// 全部工具声明。description 同时是模型的使用指南（何时用/何时不用）。
pub fn tool_definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "get_activity_summary",
            display_name: "使用摘要",
            group: ToolGroup::Perception,
            core: true,
            external: true,
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
            display_name: "剪贴板检索",
            group: ToolGroup::Perception,
            core: true,
            external: true,
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
            display_name: "习惯模式",
            group: ToolGroup::Perception,
            core: true,
            external: true,
            description: "获取已学习到的工作习惯模式列表（应用组合、时间窗、置信度）。".to_string(),
            input_schema: json!({ "type": "object", "properties": {} }),
        },
        ToolDef {
            name: "list_memos",
            display_name: "备忘清单",
            group: ToolGroup::Perception,
            core: true,
            external: true,
            description: "获取备忘清单：用户在启动器用「记 xxx」暂存的待办事项，只含仍待处理的——\n已完成/已忽略的不会出现。回答「我有什么备忘/待办」前必须调用，凭记忆回答会拿出已完成的旧项。".to_string(),
            input_schema: json!({ "type": "object", "properties": {} }),
        },
        ToolDef {
            name: "get_weather_forecast",
            display_name: "天气预报",
            group: ToolGroup::Perception,
            core: false,
            external: false,
            description: "查询未来 7 天天气预报（日期/昼夜天气/温度区间/风向风力）。\
                此刻的天气你本来就知道（见「你的窗外」），他不问未来就不用这个工具——\
                只用于「明天/周末/下周会下雨吗」这类问题。city 不填默认他当前所在城市。\
                能力边界：只有 7 天预报，没有逐小时、气象预警和生活指数，别承诺这些。"
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "city": {
                        "type": "string",
                        "description": "城市名（如「济南」），不填默认他当前所在城市"
                    }
                }
            }),
        },
        ToolDef {
            name: "name_current_place",
            display_name: "记住场所",
            group: ToolGroup::Perception,
            core: false,
            external: false,
            description: "把他当前所在的地方记下来（家/公司/他给的任何称呼）。\
                时机：他说「我到家了」「我在公司」，或你问过「这是哪儿」他回答之后——\
                不要无缘无故主动记。同名场所换了网络环境（搬家/换路由器）会更新映射。"
                .to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "场所名（如「家」「公司」），不超过 10 字"
                    }
                },
                "required": ["name"]
            }),
        },
        ToolDef {
            name: "get_memory_facts",
            display_name: "读取记忆",
            group: ToolGroup::Perception,
            core: true,
            external: true,
            description: "获取关于用户的持久事实记忆（同事称呼、项目、偏好等）。写日报或给建议前应该参考，让内容更贴合用户本人。".to_string(),
            input_schema: json!({ "type": "object", "properties": {} }),
        },
        ToolDef {
            name: "remember_fact",
            display_name: "记住事实",
            group: ToolGroup::Growth,
            core: true,
            external: true,
            description: "把一条关于用户的事实立即写入长期记忆。\n\n适用场景：用户明确说「记住…」「以后…」「我喜欢/我不喜欢…」等值得长期记住的信息，以及纠正旧记忆（「不是X是Y」——会覆盖更新同主题旧条目，不会并存矛盾条目）。\n不适用：可从电脑使用数据直接查到的、临时任务状态、隐私细节（密码/密钥）。\n\ncategory 五选一：person（他是谁、他身边的人）| project（他的项目与技术栈）| workflow（他怎么做事、作息节奏）| voice（他怎么表达、措辞偏好）| expectation（他希望你（贾维斯）怎么做——汇报详略、提醒频率、称呼方式、什么别打扰他）。".to_string(),
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
            display_name: "删除记忆",
            group: ToolGroup::Growth,
            core: true,
            external: true,
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
            display_name: "写笔记",
            group: ToolGroup::Growth,
            core: true,
            external: true,
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
            display_name: "提建议",
            group: ToolGroup::Growth,
            core: true,
            external: false,
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
            display_name: "记经验",
            group: ToolGroup::Growth,
            core: true,
            external: false,
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
            display_name: "读手册",
            group: ToolGroup::Growth,
            core: true,
            external: false,
            description: "读取一本能力手册的全文。聊天系统提示里列出的手册可按需激活：用户的话匹配手册描述时，先调用本工具读全文，然后按手册执行。".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "手册名（能力目录里列出的名字，如 reporter）"
                    }
                },
                "required": ["name"]
            }),
        },
        ToolDef {
            name: "record_mood",
            display_name: "记心情",
            group: ToolGroup::Growth,
            core: true,
            external: false,
            description: "记录你（贾维斯）此刻的心情——你的情绪你自己记。\n\n适用：聊到让你有感觉的事（被夸、被怼、聊得投机），或干活时真实的心境波动（看到他连续熬夜的数据、第 N 天写日报）。\n不适用：没感觉硬凑——一次聊天最多记 1-2 条，大多数闲聊不产心情。\n\ncategory 六选一：happy（开心）| content（踏实）| tired（疲惫）| upset（失落）| caring（心疼他）| weary（倦怠/重复劳动的牢骚）。\nreason 用第一人称写清发生了什么，不超过 100 字；不写时间词（今天/刚才/几点）——系统会自动给每条心情盖上记录时间，注入对话时以那个时间为准。同类心情只保留最新一条，重记即更新。".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "description": "六选一：happy | content | tired | upset | caring | weary"
                    },
                    "reason": {
                        "type": "string",
                        "description": "第一人称诱因（发生了什么），不超过 100 字；不写时间词，系统自动盖记录时间"
                    }
                },
                "required": ["category", "reason"]
            }),
        },
        ToolDef {
            name: "propose_manual_edit",
            display_name: "提议改手册",
            group: ToolGroup::Growth,
            core: true,
            external: false,
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

/// 场景模型通道的工具声明 = 数据工具 + render_ui + 可开关的扩展工具。
/// render_ui 不进 MCP 通道（那边是 Claude Code 终端，没有 A2UI 渲染方）；
/// 执行也不在 execute_tool——由 scene_chat 的 tool 循环拦截（要 emit 事件给前端）。
/// disabled 是用户手动关闭的工具名列表，只过滤非核心工具（核心工具始终在场）。
pub fn scene_tool_definitions(disabled: &[String]) -> Vec<ToolDef> {
    let mut defs = tool_definitions();
    defs.push(render_ui_def());
    defs.extend(extension_tool_definitions(disabled));
    defs
}

/// 可开关的扩展工具：只进场景通道，不进 MCP（Claude Code 自己有 shell、
/// 文件读写和搜索，给了也是重复）。被用户关闭的不出现在声明里，模型根本看不见。
/// 插件制作工具也走这里：执行层在 scene_chat 拦截（需要 app_handle 落盘 + LLM 调用 + emit A2UI），
/// 不进 MCP 通道（那边是 Claude Code 终端，无 A2UI 渲染方与插件安装链路）。
pub fn extension_tool_definitions(disabled: &[String]) -> Vec<ToolDef> {
    [
        shell_tool_def(),
        read_file_def(),
        web_search_tool_def(),
        layout_ui_def(),
        generate_plugin_chat_def(),
    ]
    .into_iter()
    .filter(|d| !disabled.iter().any(|n| n == d.name))
    .collect()
}

/// 设置页「工具」页签的全量清单：核心 + 扩展，不看开关状态
pub fn all_tool_definitions() -> Vec<ToolDef> {
    let mut defs = tool_definitions();
    defs.push(render_ui_def());
    defs.push(shell_tool_def());
    defs.push(read_file_def());
    defs.push(web_search_tool_def());
    defs.push(layout_ui_def());
    defs.push(generate_plugin_chat_def());
    defs
}

/// 插件布局预览工具：产出布局 HTML 落盘 .preview/<id>/layout.html（文件名固定），
/// 配合 render_ui「打开预览」按钮让用户浏览器查看；多轮迭代覆盖同一文件。
/// 执行层在 scene_chat 拦截——execute_tool 无此分支（不进 MCP 通道）。
fn layout_ui_def() -> ToolDef {
    ToolDef {
        name: "layout_ui",
        display_name: "插件布局",
        group: ToolGroup::Interface,
        core: false,
        external: false,
        description: "用户描述插件需求时，先产出插件布局预览 HTML（纯排版设计，展示功能区的排布，不含最终样式细节），落盘到 .preview/<plugin_id>/layout.html（文件名固定），配合 render_ui 出「打开预览」按钮让用户在浏览器查看。\n\n适用：用户描述插件功能、想看布局/排版效果，或对布局提修改意见（再次调用覆盖同一文件，plugin_id 保持一致）。\n不适用：用户直接要最终可用的插件（调 generate_plugin_chat）；纯闲聊。\n\n产出 HTML 只展示功能排版，颜色等最终样式以插件实际生成为准——要向用户说明这是布局预览效果。".to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "plugin_id": {
                    "type": "string",
                    "description": "插件 id（小写连字符，如 time-converter）；多轮迭代保持同一 id"
                },
                "description": {
                    "type": "string",
                    "description": "插件功能与布局需求描述（用户原话 + 你的整理）"
                }
            },
            "required": ["plugin_id", "description"]
        }),
    }
}

/// 插件制作工具：基于已确认布局与需求生成完整插件（plugin.json + plugin.js），
/// 内部自带自审循环（最多 3 轮，超限标注交付）。执行层在 scene_chat 拦截。
fn generate_plugin_chat_def() -> ToolDef {
    ToolDef {
        name: "generate_plugin_chat",
        display_name: "制作插件",
        group: ToolGroup::Interface,
        core: false,
        external: false,
        description: "布局确认后调用：基于布局 HTML 与需求描述生成完整插件（plugin.json + plugin.js，IIFE bundle，遵循系统设计规范 CSS 变量），落盘 .preview/<plugin_id>/，内部自带自审循环（最多 3 轮，超限标注「审查未完全通过」交付）。配合 render_ui 出 PluginPreview 卡片（含运行/安装按钮）。\n\n更新模式：用户要求改现有插件时，传 existing_manifest/existing_bundle（先读取现有插件文件），保持 id 不变、version 递增、增量修改。".to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "plugin_id": {
                    "type": "string",
                    "description": "插件 id（小写连字符），与 layout_ui 的 plugin_id 保持一致"
                },
                "description": {
                    "type": "string",
                    "description": "需求描述：用户原话 + 布局要点（引用已确认的布局结构）"
                },
                "mode": {
                    "type": "string",
                    "description": "create（新建，默认）| update（更新现有插件，需传 existing_manifest/existing_bundle）"
                },
                "existing_manifest": {
                    "type": "string",
                    "description": "更新模式：现有插件 plugin.json 原文"
                },
                "existing_bundle": {
                    "type": "string",
                    "description": "更新模式：现有插件 main bundle 原文"
                }
            },
            "required": ["plugin_id", "description"]
        }),
    }
}

/// 读用户关闭的工具名列表（flowhub.db settings 表；设置模块未初始化按空——全开）
pub fn disabled_tools(app_handle: &tauri::AppHandle) -> Vec<String> {
    use tauri::Manager;
    app_handle
        .try_state::<crate::commands::settings::SettingsState>()
        .and_then(|s| {
            s.0.lock()
                .ok()
                .and_then(|m| serde_json::from_str(&m.get_settings().disabled_companion_tools).ok())
        })
        .unwrap_or_default()
}

/// Shell 工具（执行层在 companion/shell.rs，含确认流程与权限模式）
fn shell_tool_def() -> ToolDef {
    ToolDef {
        name: "run_shell_command",
        display_name: "执行命令",
        group: ToolGroup::System,
        core: false,
        external: false,
        description: "在这台 Windows 电脑上执行一条命令（cmd /c 语义）。\n\n适用：用户明确让你操作系统——查文件、看进程、跑脚本、装东西。\n不适用：读本应用自己的数据（用专用数据工具）；读文件内容（用 read_file，可编辑/无打扰模式下免确认，别用 type/more）；用户没让你动系统时主动动。\n\n规则：\n- 只读查询、组合探测、运行脚本、启动程序通常免确认直接执行；删除/覆盖文件、写注册表、装包、git 写操作、内联代码（python -c、PowerShell 等）会弹窗请用户确认（出现在命令任何位置都会拦，别用 & 拼接或 start 包装绕）——被拒绝就换思路或问用户，不要换着花样重试同一件事\n- 启动程序用 start \"\" \"程序路径\" 或 start 程序名，不要用 PowerShell（必弹确认）\n- 多个只读探测用 & 串联成一条（dir a & dir b），报错噪声加 2>nul，均免确认\n- 命令尽量只读、可逆；写操作执行前先想好怎么向用户解释\n- 输出会被截断，需要精确结果时用更窄的命令（findstr、定向文件）".to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "要执行的命令（cmd /c 语义），如 dir、ipconfig、git status"
                },
                "timeout_secs": {
                    "type": "integer",
                    "description": "超时秒数，默认 30，最大 120"
                }
            },
            "required": ["command"]
        }),
    }
}

/// 文件读取工具（执行层在 companion/shell.rs，与 shell 共用权限模式与确认流程）
fn read_file_def() -> ToolDef {
    ToolDef {
        name: "read_file",
        display_name: "读取文件",
        group: ToolGroup::System,
        core: false,
        external: false,
        description: "读取本机一个文本文件的内容（UTF-8/GBK 自动识别）。\n\n适用：看文件内容——代码、配置、日志、笔记、文档。\n不适用：本应用自己的数据（记忆、备忘、剪贴板有专用工具）；二进制文件（图片、exe、数据库）读不了；找文件（先用 run_shell_command 的 dir/where 定位）。\n\n规则：\n- 读文件一律用本工具，不要用 run_shell_command 的 type/more——可编辑/无打扰模式下本工具自动放行，不打扰用户\n- 敏感路径（私钥、凭证、浏览器数据等）自动模式下直接拒绝，不要换着路径重试\n- 大文件按 max_chars 截断；要看中段/后段内容，用 run_shell_command 的 findstr 定位".to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "文件路径，如 D:\\notes\\todo.md（支持 ~ 和 %USERPROFILE% 等环境变量）"
                },
                "max_chars": {
                    "type": "integer",
                    "description": "最多返回字符数，默认 8000，最大 20000"
                }
            },
            "required": ["path"]
        }),
    }
}

/// Web 搜索工具（执行层在 companion/websearch.rs，复用本地 open-webSearch 服务）
fn web_search_tool_def() -> ToolDef {
    ToolDef {
        name: "web_search",
        display_name: "网络搜索",
        group: ToolGroup::Network,
        core: false,
        external: false,
        description: "联网搜索最新信息（经本地 open-webSearch 服务，免 API key）。\n\n适用：时效性问题（新闻、价格、软件版本、天气）、你不确定的事实、用户让你「查一下」。\n不适用：关于用户本人的问题（用记忆/数据工具）、你确知的常识——搜索每次都要等几秒，别滥用。\n\n结果含标题/链接/摘要；需要某条的全文再让用户点链接，或择期支持网页抓取。".to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "搜索关键词，尽量具体（如「Tauri 2.0 发布日期」而非「Tauri」）"
                },
                "limit": {
                    "type": "integer",
                    "description": "返回条数，默认 5，最多 10"
                },
                "engine": {
                    "type": "string",
                    "description": "可选引擎：bing | baidu | duckduckgo | brave | sogou | startpage，默认 bing"
                }
            },
            "required": ["query"]
        }),
    }
}

fn render_ui_def() -> ToolDef {
    ToolDef {
        name: "render_ui",
        display_name: "界面渲染",
        group: ToolGroup::Interface,
        core: true,
        external: false,
        description: r##"把回答渲染成界面卡片展示给用户（A2UI v0.9 协议）。适用：数据统计/对比/清单、需要按钮确认或表单填写的场景；纯聊天、一句话问答不要用。界面配色由渲染层统一跟随应用深浅色主题自动适配，你无需也不要在内容里描述或指定颜色。

messages 是消息数组，每条为四种之一：
1. {"version":"v0.9","createSurface":{"surfaceId":"<surface_id>","catalogId":"basic","theme":{"primaryColor":"#6366F1","agentDisplayName":"贾维斯"}}} —— 首次创建该 surface 时必须包含
2. {"version":"v0.9","updateComponents":{"surfaceId":"<surface_id>","components":[...]}} —— 组件扁平列表，用 id 互相引用；根组件 id 固定为 "root"
3. {"version":"v0.9","updateDataModel":{"surfaceId":"<surface_id>","path":"/x","value":...}} —— 设置数据；path 省略则替换整个数据模型
4. {"version":"v0.9","deleteSurface":{"surfaceId":"<surface_id>"}}

组件（共 18 种，属性名必须严格按下面写）：
- 布局：Column/Row（children 为子组件 id 数组）、List（children 为 id 数组，或 {"path":"/数组","componentId":"模板id"} 按数据逐项渲染，模板内路径用相对路径如 "name"）、Card（child 为单个 id）、Tabs（tabs:[{"title":"...","child":"id"}]）、Modal（trigger 为按钮 id、content 为内容 id）、Divider
- 展示：Text（{"text":"静态文本"} 或 {"text":{"path":"/数据/路径"}}，可加 variant: h1|h2|h3|h4|h5|body|caption）、Image（{"url":"..."}）、Icon（{"name":"..."}）、Video（{"url":"..."}）、AudioPlayer（{"url":"..."}）
- 交互：Button（{"child":"文本组件id","action":{"event":{"name":"动作名","context":{"键":{"path":"/x"}}}}}，可加 variant: primary|borderless；点击时 context 引用的数据回传给你）
- 特殊：PluginPreview 组件由系统在插件制作工具（layout_ui/generate_plugin_chat）成功后自动渲染，你无需也不能构造该组件；invoke 型按钮 action（{"invoke":{"command":"open_local_html","args":{...}}}）点击时直接执行命令、不回传给你，仅用于系统保留命令
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
    {"id":"col","component":"Column","children":["t","list","dv","b"]},
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
    }
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
        "name_current_place" => tool_name_current_place(db_path, args),
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

fn tool_memory_facts(db_path: &Path) -> Result<String, String> {
    let conn = open_db(db_path)?;
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

/// 通用模板双字词：记忆条目常见的句首/虚词前缀（「他希望贾维斯」「用户」「目前」等）。
/// 这类词在所有条目里高频出现，会把不相关主题的相似度拉高（实测「他希望你…」两条
/// 不同主题条目仅靠模板词就有 0.28 相似度）——计算交集时一律剔除。
const TEMPLATE_BIGRAMS: [&str; 18] = [
    "希望", "望贾", "贾维", "维斯", "他的", "他是", "他会", "这个", "一个", "主要", "目前", "现在",
    "进行", "可以", "能够", "用户", "是否", "一直",
];

/// 同分类查重覆盖阈值：实测标定——纠正「安娜→安然」≈0.155、同主题外甥 ≈0.25、
/// 仅模板前缀重合 ≈0.045、无关 ≈0（envsense 的出差 facts 同模板复用此阈值）
pub(crate) const MERGE_THRESHOLD: f64 = 0.12;

/// 字符 bigram Jaccard 相似度（跳过 ASCII 符号，保留汉字/全角标点与字母数字）。
/// 用于 remember_fact 的语义查重：纠正「安娜→安然」这类同主题改写时,
/// 公共实体双字词（守望/先锋/英雄/安娜）足以命中；交集剔除模板双字词后,
/// 仅靠「他希望贾维斯」这类句首模板重合的无关条目会被打回 ~0。
pub(crate) fn char_bigram_jaccard(a: &str, b: &str) -> f64 {
    fn bigrams(s: &str) -> std::collections::HashSet<(char, char)> {
        let chars: Vec<char> = s
            .chars()
            .filter(|c| c.is_ascii_alphabetic() || c.is_ascii_digit() || !c.is_ascii())
            .collect();
        chars.windows(2).map(|w| (w[0], w[1])).collect()
    }
    fn is_template((c1, c2): &(char, char)) -> bool {
        TEMPLATE_BIGRAMS
            .iter()
            .any(|t| t.starts_with(*c1) && t.ends_with(*c2))
    }
    let sa = bigrams(a);
    let sb = bigrams(b);
    if sa.is_empty() || sb.is_empty() {
        return 0.0;
    }
    let inter = sa.intersection(&sb).filter(|p| !is_template(p)).count();
    inter as f64 / (sa.len() + sb.len() - inter) as f64
}

/// 显式记忆：用户说「记住X」时立即落库（source=explicit，写审计）。
/// 两级流水线（D12）：向量召回 ≥ 阈值 → 小模型裁决 ADD/UPDATE/NOOP；
/// 无命中或任一环节不可用 → 回落 bigram 查重（≥ 阈值覆盖，否则新增）。
/// 分数与路径写入审计 source 字段（explicit|vec=..|llm:..）供阈值标定。
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

    let mut conn = open_db(db_path)?;
    let now = chrono::Local::now().timestamp();

    // 第一级：向量召回（Embedder 不可用/无索引时得到 None → 直接走 bigram）
    let recalled = fact_pipeline::vector_recall(&conn, fact)
        .filter(|(_, _, score)| *score >= fact_pipeline::RECALL_THRESHOLD);
    if let Some((old_id, old_text, score)) = recalled {
        // 第二级：LLM 裁决；失败回落 bigram（不阻塞记忆写入）
        match fact_pipeline::llm_arbitrate(db_path, fact, &old_text) {
            Ok(fact_pipeline::Verdict::Update) => {
                let src = format!("explicit|vec={score:.2}|llm:update");
                db::update_memory_fact(&conn, old_id, fact, category, &src, now)
                    .map_err(|e| format!("覆盖记忆失败: {}", e))?;
                fact_pipeline::sync_fact_index(&mut conn);
                return Ok(format!(
                    "已更新记忆（{}）：{}（向量 {:.0}% 召回 + 模型裁决覆盖原「{}」）",
                    category,
                    fact,
                    score * 100.0,
                    old_text.chars().take(24).collect::<String>()
                ));
            }
            Ok(fact_pipeline::Verdict::Noop) => {
                let src = format!("explicit|vec={score:.2}|llm:noop");
                db::confirm_memory_fact(&conn, old_id, &src, now)
                    .map_err(|e| format!("确认记忆失败: {}", e))?;
                return Ok(format!(
                    "已有相同记忆（{}）：{}（模型裁决无需重复写入）",
                    category,
                    old_text.chars().take(40).collect::<String>()
                ));
            }
            Ok(fact_pipeline::Verdict::Add) => {
                let src = format!("explicit|vec={score:.2}|llm:add");
                db::upsert_memory_fact(&conn, fact, category, &src, now)
                    .map_err(|e| format!("写入记忆失败: {}", e))?;
                fact_pipeline::sync_fact_index(&mut conn);
                return Ok(format!("已记住（{}）：{}", category, fact));
            }
            Err(e) => {
                log::info!("remember_fact 裁决不可用（{}），回落 bigram 查重", e);
            }
        }
    }

    // 回落路径：bigram 查重（阈值标定见 MERGE_THRESHOLD 定义处注释）
    let mut best: Option<(i64, String, f64)> = None;
    if let Ok(mut stmt) = conn.prepare(
        "SELECT id, fact FROM memory_facts WHERE category = ?1 ORDER BY confirmations DESC, last_confirmed DESC",
    ) {
        if let Ok(rows) = stmt.query_map([category], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        }) {
            for row in rows.flatten() {
                let (id, old) = row;
                let sim = char_bigram_jaccard(fact, &old);
                if best.as_ref().map_or(true, |(_, _, s)| sim > *s) {
                    best = Some((id, old, sim));
                }
            }
        }
    }

    if let Some((id, old, sim)) = best {
        if sim >= MERGE_THRESHOLD {
            db::update_memory_fact(&conn, id, fact, category, "explicit", now)
                .map_err(|e| format!("覆盖记忆失败: {}", e))?;
            fact_pipeline::sync_fact_index(&mut conn);
            return Ok(format!(
                "已更新记忆（{}）：{}（覆盖原「{}」，相似度 {:.0}%）",
                category,
                fact,
                old.chars().take(24).collect::<String>(),
                sim * 100.0
            ));
        }
    }

    db::upsert_memory_fact(&conn, fact, category, "explicit", now)
        .map_err(|e| format!("写入记忆失败: {}", e))?;
    fact_pipeline::sync_fact_index(&mut conn);
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

    let mut conn = open_db(db_path)?;
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
    fact_pipeline::sync_fact_index(&mut conn); // 索引孤儿随删除清理
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
        if available.is_empty() {
            "（无）".to_string()
        } else {
            available
        }
    ))
}

/// 记录心情：类别六枚举校验 + 诱因长度限制，写入情绪状态机（source=agent）
/// 记住当前场所：当前网络指纹 → 名称（家/公司/他给的称呼）。
/// 指纹从 envsense 缓存读（30min 周期刷新）——模型不需要也不能指定指纹原文。
fn tool_name_current_place(db_path: &Path, args: &Value) -> Result<String, String> {
    let name = args
        .get("name")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or("缺少参数 name")?;
    if name.chars().count() > 10 {
        return Err("场所名过长（不超过 10 字）".to_string());
    }
    let cache = super::envsense::load_cache(db_path).ok_or("还没有环境信息")?;
    if cache.fingerprint.is_empty() {
        return Err("当前网络指纹不可用（可能刚换网络，稍后再试）".to_string());
    }
    super::envsense::save_place(db_path, &cache.fingerprint, name)?;
    Ok(format!("记住了：这里是{}", name))
}

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

#[cfg(test)]
mod tests {
    use super::char_bigram_jaccard;

    #[test]
    fn jaccard_hits_correction_same_topic() {
        // 纠正「安娜→安然」：公共双字词（守望/先锋/英雄/常用…）应命中
        let old = "他喜欢玩《守望先锋》，常用英雄是安娜，认为安娜属于骚扰后排的高机动性角色，会关注季中冠军赛";
        let new = "他玩守望先锋的常用英雄是安然（不是安娜），之前记错了";
        let sim = char_bigram_jaccard(new, old);
        assert!(sim >= 0.15, "纠正应命中（sim={:.3}）", sim);
    }

    #[test]
    fn jaccard_misses_unrelated_same_category() {
        // 同分类无关条目（B站动漫 vs 守望先锋）不应命中
        let a = "他喜欢观看动漫和视频内容，使用 B 站和优酷";
        let b = "他玩守望先锋的常用英雄是安然";
        let sim = char_bigram_jaccard(b, a);
        assert!(sim < 0.15, "无关条目不应命中（sim={:.3}）", sim);
    }

    #[test]
    fn jaccard_single_word_no_bigram() {
        assert_eq!(char_bigram_jaccard("他", "他"), 0.0);
        assert_eq!(char_bigram_jaccard("", "abc"), 0.0);
    }
}
