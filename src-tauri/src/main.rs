// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // MCP server 模式：claude CLI 以 --mcp-server 启动本 exe 时，
    // 进入 stdio JSON-RPC 模式提供 companion 工具，不启动 GUI
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--mcp-server") {
        // 参数缺省时按统一数据目录推导默认值,避免外部 MCP 配置里
        // 写死的旧路径(如 custom-tools.db)在改名后继续复活已废弃文件
        let data_dir = dirs::data_dir().map(|d| d.join(flowhub_lib::APP_DIR_NAME));
        let db_path = arg_value(&args, "--db-path")
            .filter(|p| !p.is_empty())
            .map(std::path::PathBuf::from)
            .or_else(|| data_dir.as_ref().map(|d| d.join(flowhub_lib::DB_FILE_NAME)));
        let notes_dir = arg_value(&args, "--notes-dir")
            .filter(|p| !p.is_empty())
            .map(std::path::PathBuf::from)
            .or_else(|| data_dir.as_ref().map(|d| d.join("notes")));

        match (db_path, notes_dir) {
            (Some(db), Some(notes)) => {
                flowhub_lib::companion::mcp::run_mcp_server(db, notes);
            }
            _ => {
                eprintln!("[companion-mcp] 无法确定数据目录(dirs::data_dir 不可用且参数缺失)");
                std::process::exit(1);
            }
        }
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
