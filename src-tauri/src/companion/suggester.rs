use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager};

use super::db;

/// 建议类型：剪贴板错误堆栈分析
pub const TYPE_ERROR_ANALYSIS: &str = "error_analysis";
/// 建议类型：长时工作休息提醒
pub const TYPE_LONG_WORK_BREAK: &str = "long_work_break";
/// 建议类型：晨间工作套装（批量启动）
pub const TYPE_WORK_SUITE: &str = "work_suite";

/// Toast 窗口尺寸（与前端卡片尺寸匹配）
const TOAST_WIDTH: f64 = 400.0;
const TOAST_HEIGHT: f64 = 180.0;
/// 距屏幕右/下边缘的间距（逻辑像素）
const EDGE_MARGIN: f64 = 16.0;
const TASKBAR_MARGIN: f64 = 56.0;

/// 创建建议、推送到 toast 窗口并展示。返回建议 id。
pub fn push_suggestion(
    conn: &Connection,
    app_handle: &AppHandle,
    suggestion_type: &str,
    title: &str,
    body: Option<&str>,
    action_payload: Option<&str>,
) -> Result<i64, String> {
    let now = chrono::Local::now().timestamp();
    let suggestion = db::create_suggestion(conn, suggestion_type, title, body, action_payload, now)
        .map_err(|e| format!("创建建议失败: {}", e))?;

    log::info!("Companion 新建议 [{}]: {}", suggestion_type, title);

    show_existing_suggestion(app_handle, &suggestion);

    Ok(suggestion.id)
}

/// 把一条已存在的建议/意图推送到 toast 窗口（情境触发意图时用）
pub fn show_existing_suggestion(app_handle: &AppHandle, suggestion: &db::Suggestion) {
    show_toast_window(app_handle);
    if let Err(e) = app_handle.emit("companion:suggestion", suggestion) {
        log::warn!("emit companion:suggestion 失败: {}", e);
    }
}

pub fn hide_toast_window(app_handle: &AppHandle) {
    if let Some(window) = app_handle.get_webview_window("companion-toast") {
        let _ = window.hide();
    }
}

/// 把 toast 窗口定位到鼠标所在显示器的右下角并显示
fn show_toast_window(app_handle: &AppHandle) {
    let Some(window) = app_handle.get_webview_window("companion-toast") else {
        log::warn!("companion-toast 窗口不存在");
        return;
    };

    if let Some(monitor) = crate::get_monitor_at_cursor(app_handle) {
        let pos = monitor.position();
        let size = monitor.size();
        let scale = monitor.scale_factor();

        let win_w = (TOAST_WIDTH * scale) as i32;
        let win_h = (TOAST_HEIGHT * scale) as i32;
        let x = pos.x + size.width as i32 - win_w - (EDGE_MARGIN * scale) as i32;
        let y = pos.y + size.height as i32 - win_h - (TASKBAR_MARGIN * scale) as i32;

        let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
            width: win_w as u32,
            height: win_h as u32,
        }));
        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
    }

    if let Err(e) = window.show() {
        log::warn!("显示 companion-toast 窗口失败: {}", e);
    }
}

/// 启发式判断一段文本是否像错误堆栈/异常日志。
/// 设计取向：宁可漏判（少打扰），不可误判（像贾维斯一样啰嗦只会被关掉）。
pub fn looks_like_error(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.len() < 40 {
        return false;
    }
    // URL / 文件路径本身常含 error 字样，直接排除单链接
    if trimmed.starts_with("http") && !trimmed.contains('\n') {
        return false;
    }

    // 强特征：各类语言/运行时的标志性异常头
    const STRONG_MARKERS: &[&str] = &[
        "Traceback (most recent call last)",
        "Exception in thread",
        "NullPointerException",
        "StackOverflowError",
        "Segmentation fault",
        "core dumped",
        "Caused by:",
        "panic:",
        "panicked at",
        "thread 'main'",
        "Assertion failed",
        "fatal error:",
        "Uncaught TypeError",
        "Uncaught ReferenceError",
        "Uncaught SyntaxError",
        "Unhandled exception",
        "Access violation",
        "SYSTEM_THREAD_EXCEPTION",
        "IRQL_NOT_LESS_OR_EQUAL",
    ];
    if STRONG_MARKERS.iter().any(|m| trimmed.contains(m)) {
        return true;
    }

    // 弱特征组合：多行 + 错误关键字 + 调用栈帧形态
    let line_count = trimmed.lines().count();
    let has_error_word =
        trimmed.contains("Error") || trimmed.contains("Exception") || trimmed.contains("error:");
    let has_stack_frame = trimmed.contains("\n    at ")
        || trimmed.contains("\n  at ")
        || trimmed.contains(".rs:")
        || trimmed.contains("\", line ")
        || trimmed.contains(".java:")
        || trimmed.contains(".cs:line")
        || trimmed.contains(".ts:");

    line_count >= 3 && has_error_word && has_stack_frame
}

#[cfg(test)]
mod tests {
    use super::looks_like_error;

    #[test]
    fn detects_python_traceback() {
        let text = "Traceback (most recent call last):\n  File \"a.py\", line 1, in <module>\nValueError: bad";
        assert!(looks_like_error(text));
    }

    #[test]
    fn detects_node_stack() {
        let text = "TypeError: undefined is not a function\n    at Object.<anonymous> (a.js:1:1)\n    at Module._compile (node:internal)";
        assert!(looks_like_error(text));
    }

    #[test]
    fn ignores_short_text_and_urls() {
        assert!(!looks_like_error("error"));
        assert!(!looks_like_error("https://example.com/error-page"));
        assert!(!looks_like_error(
            "今天开会讨论一下 error 的处理方案，这个单子比较着急，明天再说"
        ));
    }
}
