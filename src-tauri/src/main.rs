// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // MCP server 模式：claude CLI 以 --mcp-server 启动本 exe 时，
    // 进入 stdio JSON-RPC 模式提供 companion 工具，不启动 GUI
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--mcp-server") {
        let db_path = arg_value(&args, "--db-path").unwrap_or_default();
        let notes_dir = arg_value(&args, "--notes-dir").unwrap_or_default();
        if db_path.is_empty() || notes_dir.is_empty() {
            eprintln!("[companion-mcp] 缺少必需参数 --db-path / --notes-dir");
            std::process::exit(1);
        }
        flowhub_lib::companion::mcp::run_mcp_server(db_path.into(), notes_dir.into());
        return;
    }

    flowhub_lib::run();
}

/// 取 --key value 形式的参数值
fn arg_value(args: &[String], key: &str) -> Option<String> {
    args.iter()
        .position(|a| a == key)
        .and_then(|pos| args.get(pos + 1))
        .cloned()
}
