//! 统一人格（设定集）与经验本（自进化区）加载：内嵌默认版 + 运行时副本。
//! 首次运行把内嵌默认版播种到应用数据目录 companion/ 下，之后以运行时副本为准
//! （persona 可手动编辑；evolution 由 agent 经 MCP 工具追加），读取失败回退内嵌版。

use std::path::{Path, PathBuf};

/// 内嵌默认设定集（repo 内的权威默认版）
const DEFAULT_PERSONA: &str = include_str!("persona.md");
/// 内嵌默认经验本
const DEFAULT_EVOLUTION: &str = include_str!("evolution.md");
/// 内嵌默认工具编排（工具使用规则 + 专长手册目录说明；手册列表动态拼入）
const DEFAULT_TOOL: &str = include_str!("tool.md");

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

/// 加载运行时工具编排（与 persona 同机制：播种 + 副本为准）
pub fn load_tool(app_data_dir: &Path) -> String {
    seed_and_load(companion_dir(app_data_dir).join("tool.md"), DEFAULT_TOOL)
}

/// 读取「近期态度指引」（日记蒸馏产物，注入聊天 prompt）。
/// 不播种——首次日记生成后才出现；不存在时返回空串（聊天注入跳过该段）。
pub fn load_attitude(app_data_dir: &Path) -> String {
    std::fs::read_to_string(companion_dir(app_data_dir).join("attitude.md")).unwrap_or_default()
}

/// 重写「近期态度指引」（覆盖式，日记生成后调用；写入即快照）
pub fn save_attitude(app_data_dir: &Path, content: &str) -> Result<(), String> {
    let dir = companion_dir(app_data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建 companion 目录失败: {}", e))?;
    if let Err(e) = super::backup::backup_file(app_data_dir, "attitude.md") {
        log::warn!("态度指引快照失败: {}", e);
    }
    std::fs::write(dir.join("attitude.md"), content).map_err(|e| format!("写入态度指引失败: {}", e))
}

/// 启动时一次性播种全部人格文件（缺失才写，不覆盖用户编辑）。
/// 各 load_* 是懒播种——文件只在对应功能首次运行时出现；
/// 统一在陪伴模块启动时兜底。手册播种走 skills::seed_skills（含旧 agents/ 迁移）。
pub fn seed_all(app_data_dir: &Path) {
    let _ = load(app_data_dir);
    let _ = load_tool(app_data_dir);
    let _ = load_evolution(app_data_dir);
    super::skills::seed_skills(app_data_dir);
}
