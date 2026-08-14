//! Claude Code 的 companion MCP 注册管理（检测 + 自愈）。
//!
//! 背景：~/.claude.json 的 mcpServers.companion 是外部 MCP 客户端使用
//! 贾维斯数据工具的入口。注册信息会腐烂——exe 重装路径漂移、args 里
//! 写死的旧数据路径在改名后复活废弃文件（custom-tools.db 空库坑）。
//!
//! 自愈策略：期望注册只带 --mcp-server，数据路径由 exe 启动时经
//! main.rs 的缺省逻辑自行推导（dirs::data_dir + 编译期常量）——
//! 参数越少，漂移面越小。

use serde_json::{json, Value};
use std::path::PathBuf;

/// 注册状态（MCP 设置页展示）
#[derive(serde::Serialize)]
pub struct McpRegistrationStatus {
    /// ~/.claude.json 里存在 companion 条目
    pub registered: bool,
    /// 条目与期望形态一致（command 指向本 exe，args 只含 --mcp-server）
    pub correct: bool,
    /// 人话描述（未注册 / 漂移点 / 正常）
    pub detail: String,
}

fn claude_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|d| d.join(".claude.json"))
}

/// 期望的注册条目。command 统一正斜杠（与 Claude Code 自家写法一致）。
fn expected_entry() -> Value {
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    json!({
        "type": "stdio",
        "command": exe,
        "args": ["--mcp-server"]
    })
}

/// 比对一条注册与期望形态，返回漂移点列表（空 = 一致）
fn drift_points(entry: &Value) -> Vec<String> {
    let expected = expected_entry();
    let mut drift = Vec::new();
    let actual_cmd = entry.get("command").and_then(|v| v.as_str()).unwrap_or("");
    let expected_cmd = expected.get("command").and_then(|v| v.as_str()).unwrap_or("");
    if actual_cmd.replace('\\', "/") != expected_cmd {
        drift.push(format!("command 指向「{}」而非当前 exe", actual_cmd));
    }
    let default_args = json!([]);
    let actual_args = entry.get("args").unwrap_or(&default_args);
    if actual_args != expected.get("args").unwrap() {
        drift.push("args 携带多余参数（数据路径应由 exe 自行推导）".to_string());
    }
    drift
}

/// 检测注册状态
pub fn check() -> McpRegistrationStatus {
    let Some(path) = claude_config_path() else {
        return McpRegistrationStatus {
            registered: false,
            correct: false,
            detail: "无法定位用户主目录".to_string(),
        };
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return McpRegistrationStatus {
            registered: false,
            correct: false,
            detail: "~/.claude.json 不存在（Claude Code 未安装或未运行过）".to_string(),
        };
    };
    let Ok(cfg) = serde_json::from_str::<Value>(&raw) else {
        return McpRegistrationStatus {
            registered: false,
            correct: false,
            detail: "~/.claude.json 解析失败（文件损坏？）".to_string(),
        };
    };
    let entry = cfg
        .get("mcpServers")
        .and_then(|m| m.get("companion"))
        .cloned();
    match entry {
        None => McpRegistrationStatus {
            registered: false,
            correct: false,
            detail: "未注册：mcpServers 下没有 companion 条目".to_string(),
        },
        Some(e) => {
            let drift = drift_points(&e);
            McpRegistrationStatus {
                registered: true,
                correct: drift.is_empty(),
                detail: if drift.is_empty() {
                    "注册正常".to_string()
                } else {
                    format!("注册漂移：{}", drift.join("；"))
                },
            }
        }
    }
}

/// 一键修复：备份原文件后写入期望注册（其他 MCP server 与配置原样保留）。
/// 返回人话结果。
pub fn fix() -> Result<String, String> {
    let path = claude_config_path().ok_or("无法定位用户主目录")?;
    fix_at(&path)
}

/// fix 的工作函数（路径注入以便单测）
fn fix_at(path: &std::path::Path) -> Result<String, String> {
    let mut cfg: Value = match std::fs::read_to_string(path) {
        Ok(raw) => {
            let v: Value =
                serde_json::from_str(&raw).map_err(|e| format!("配置文件解析失败: {}", e))?;
            // serde_json 的可变字符串索引会把非 object 根静默替换成空对象——
            // 根损坏时继续写等于冲掉用户整个 Claude 配置，必须拒绝、由人介入
            if !v.is_object() {
                return Err(
                    "配置文件根节点不是 JSON 对象（文件可能被手工损坏），未做任何改动，请人工检查"
                        .to_string(),
                );
            }
            v
        }
        Err(_) => json!({}),
    };
    // 修复前备份（滚动单份即可——这是自愈通道，不是版本管理）
    if path.exists() {
        let bak = path.with_extension(format!(
            "json.bak-{}",
            chrono::Local::now().format("%Y%m%d%H%M%S")
        ));
        std::fs::copy(path, &bak).map_err(|e| format!("备份失败: {}", e))?;
    }
    if cfg.get("mcpServers").is_none() {
        cfg["mcpServers"] = json!({});
    }
    cfg["mcpServers"]["companion"] = expected_entry();
    let out = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    // 先写临时文件再换位：截断式直写在中途崩溃时会留下半个 JSON（整个 Claude 配置损坏）。
    // Windows 的 rename 不覆盖已存在目标，只能先删后换——缝隙期崩溃 → 文件缺失但
    // 可从 .bak 恢复，好过留下半个坏 JSON
    let tmp = path.with_extension("json.flowhub-tmp");
    std::fs::write(&tmp, &out).map_err(|e| format!("写入临时文件失败: {}", e))?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| format!("替换配置失败: {}", e))?;
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("替换配置失败: {}", e))?;
    Ok("已修复：companion 注册指向当前安装，数据路径由程序自行推导".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drift_detects_stale_args() {
        // 空库坑的形态：command 正确但 args 写死了废弃 db 路径
        let entry = json!({
            "type": "stdio",
            "command": expected_entry().get("command").unwrap().as_str().unwrap(),
            "args": ["--mcp-server", "--db-path", "C:/old/custom-tools.db"]
        });
        let drift = drift_points(&entry);
        assert_eq!(drift.len(), 1);
        assert!(drift[0].contains("多余参数"));
    }

    #[test]
    fn drift_accepts_expected_shape() {
        assert!(drift_points(&expected_entry()).is_empty());
    }

    fn temp_config(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "mcp_register_test_{}_{}",
            std::process::id(),
            tag
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(".claude.json")
    }

    #[test]
    fn fix_preserves_other_keys_and_servers() {
        let path = temp_config("fix_ok");
        std::fs::write(
            &path,
            r#"{"other": 1, "mcpServers": {"foo": {"type": "stdio", "command": "x"}}}"#,
        )
        .unwrap();
        fix_at(&path).unwrap();
        let fixed: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(fixed["other"], json!(1), "无关键保留");
        assert!(fixed["mcpServers"]["foo"].is_object(), "其他 server 保留");
        assert_eq!(
            fixed["mcpServers"]["companion"]["args"],
            json!(["--mcp-server"])
        );
        assert_eq!(
            fixed["mcpServers"]["companion"]["command"],
            expected_entry()["command"]
        );
        // 备份一份、临时文件不残留
        let dir = path.parent().unwrap();
        let baks: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".bak-"))
            .collect();
        assert_eq!(baks.len(), 1);
        assert!(!dir.join(".claude.json.flowhub-tmp").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn fix_rejects_non_object_root_without_touching_file() {
        let path = temp_config("fix_bad_root");
        std::fs::write(&path, "[1,2,3]").unwrap();
        let err = fix_at(&path).unwrap_err();
        assert!(err.contains("不是 JSON 对象"), "err: {}", err);
        // 文件原样未动
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "[1,2,3]");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn fix_creates_config_when_missing() {
        let path = temp_config("fix_missing");
        fix_at(&path).unwrap();
        let fixed: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            fixed["mcpServers"]["companion"]["args"],
            json!(["--mcp-server"])
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
