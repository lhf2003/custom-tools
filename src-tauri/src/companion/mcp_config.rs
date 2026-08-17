//! 本地 companion MCP 的配置片段生成。
//!
//! 为「复制配置」按钮提供 mcpServers.companion 条目 JSON，用户可粘贴进
//! Claude Code / 其他 MCP 客户端的配置文件。command 统一正斜杠（与
//! Claude Code 自家写法一致），数据路径由 exe 启动时经 main.rs 的缺省
//! 逻辑自行推导（参数越少，漂移面越小）。

use serde_json::{json, Value};

/// 期望的配置条目：command 指向当前 exe，args 只带 --mcp-server。
fn expected_entry() -> Result<Value, String> {
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .map_err(|e| format!("获取程序路径失败: {e}"))?;
    Ok(json!({
        "type": "stdio",
        "command": exe,
        "args": ["--mcp-server"]
    }))
}

/// 本地 companion MCP 的配置片段（JSON，可直接粘贴进 mcpServers）。
pub fn config_json() -> Result<String, String> {
    serde_json::to_string_pretty(&json!({
        "mcpServers": { "companion": expected_entry()? }
    }))
    .map_err(|e| format!("生成配置失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_json_wraps_companion_entry() {
        let cfg: Value = serde_json::from_str(&config_json().unwrap()).unwrap();
        assert!(cfg["mcpServers"]["companion"].is_object());
        assert_eq!(cfg["mcpServers"]["companion"]["type"], "stdio");
        assert_eq!(
            cfg["mcpServers"]["companion"]["args"],
            json!(["--mcp-server"])
        );
        assert!(!cfg["mcpServers"]["companion"]["command"]
            .as_str()
            .unwrap()
            .is_empty());
    }
}
