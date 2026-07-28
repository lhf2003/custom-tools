//! 统一人格（设定集）与经验本（自进化区）加载：内嵌默认版 + 运行时副本。
//! 首次运行把内嵌默认版播种到应用数据目录 companion/ 下，之后以运行时副本为准
//! （persona 可手动编辑；evolution 由 agent 经 MCP 工具追加），读取失败回退内嵌版。

use std::path::{Path, PathBuf};

/// 内嵌默认设定集（repo 内的权威默认版）
const DEFAULT_PERSONA: &str = include_str!("persona.md");
/// 内嵌默认经验本
const DEFAULT_EVOLUTION: &str = include_str!("evolution.md");
/// 内嵌领域工作手册（贾维斯各项日常工作的任务规则，非分身人格）
const DEFAULT_REPORTER: &str = include_str!("agents/reporter.md");
const DEFAULT_ANALYST: &str = include_str!("agents/analyst.md");
const DEFAULT_RECALL: &str = include_str!("agents/recall.md");
const DEFAULT_DIARY: &str = include_str!("agents/diary.md");

/// 播种（不存在时）并读取运行时副本；失败回退内嵌默认版——人格与经验不能丢。
fn seed_and_load(path: PathBuf, default: &str) -> String {
    if !path.exists() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&path, default);
    }
    std::fs::read_to_string(&path).unwrap_or_else(|_| default.to_string())
}

fn companion_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("companion")
}

/// 加载运行时设定集
pub fn load(app_data_dir: &Path) -> String {
    seed_and_load(companion_dir(app_data_dir).join("persona.md"), DEFAULT_PERSONA)
}

/// 加载运行时经验本（自进化区）
pub fn load_evolution(app_data_dir: &Path) -> String {
    seed_and_load(
        companion_dir(app_data_dir).join("evolution.md"),
        DEFAULT_EVOLUTION,
    )
}

/// 加载领域工作手册（reporter 日报 / analyst 分析 / recall 记忆提取 / diary 日记），同款播种机制
pub fn load_role(app_data_dir: &Path, role: &str) -> String {
    let (filename, default) = match role {
        "reporter" => ("reporter.md", DEFAULT_REPORTER),
        "analyst" => ("analyst.md", DEFAULT_ANALYST),
        "recall" => ("recall.md", DEFAULT_RECALL),
        "diary" => ("diary.md", DEFAULT_DIARY),
        _ => return String::new(),
    };
    seed_and_load(
        companion_dir(app_data_dir).join("agents").join(filename),
        default,
    )
}

/// 读取「近期态度指引」（日记蒸馏产物，注入聊天 prompt）。
/// 不播种——首次日记生成后才出现；不存在时返回空串（聊天注入跳过该段）。
pub fn load_attitude(app_data_dir: &Path) -> String {
    std::fs::read_to_string(companion_dir(app_data_dir).join("attitude.md")).unwrap_or_default()
}

/// 重写「近期态度指引」（覆盖式，日记生成后调用）
pub fn save_attitude(app_data_dir: &Path, content: &str) -> Result<(), String> {
    let dir = companion_dir(app_data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 companion 目录失败: {}", e))?;
    std::fs::write(dir.join("attitude.md"), content).map_err(|e| format!("写入态度指引失败: {}", e))
}

/// 启动时一次性播种全部人格文件（缺失才写，不覆盖用户编辑）。
/// 各 load_* 是懒播种——文件只在对应功能首次运行时出现，
/// 导致 agents/ 目录在重启后残缺；统一在陪伴模块启动时兜底。
pub fn seed_all(app_data_dir: &Path) {
    let _ = load(app_data_dir);
    let _ = load_evolution(app_data_dir);
    for role in ["reporter", "analyst", "recall", "diary"] {
        let _ = load_role(app_data_dir, role);
    }
}
