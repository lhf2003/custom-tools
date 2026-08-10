use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager};

use super::db;

/// 建议类型：剪贴板错误堆栈分析
pub const TYPE_ERROR_ANALYSIS: &str = "error_analysis";
/// 建议类型：长时工作休息提醒
pub const TYPE_LONG_WORK_BREAK: &str = "long_work_break";
/// 建议类型：晨间工作套装（批量启动）
pub const TYPE_WORK_SUITE: &str = "work_suite";
/// 建议类型：晨间备忘汇总
pub const TYPE_DAILY_DIGEST: &str = "daily_digest";
/// 建议类型：日报已生成通知
pub const TYPE_DAILY_REPORT: &str = "daily_report";
/// 建议类型：已毕业模式自动执行通知
pub const TYPE_AUTO_EXECUTED: &str = "auto_executed";
/// 建议类型：备忘情境触发提醒（忽略弹窗 ≠ 处置备忘）
pub const TYPE_INTENT_REMINDER: &str = "intent_reminder";
/// 建议类型：未知应用提醒（模型回填后仍不认识 → 引导用户去「应用」设置页标注）
pub const TYPE_APP_UNKNOWN: &str = "app_unknown";

/// 纯提示型：accept 无后续动作，看过即终结——
/// 卡片不渲染按钮，推送即落 seen（不依赖前端回调，应用被杀也不留 pending 残渣）。
pub const INFO_TYPES: &[&str] = &[
    TYPE_LONG_WORK_BREAK,
    TYPE_DAILY_DIGEST,
    TYPE_DAILY_REPORT,
    TYPE_AUTO_EXECUTED,
    TYPE_INTENT_REMINDER,
];

/// 待展示建议队列（就绪握手）：emit 后等前端渲染完成回执（companion_toast_ready）才 show——
/// 透明窗口先 show 后渲染会定格/闪出全透明首帧；且 toast 页面异步加载，
/// 首次 emit 可能早于监听器注册（事件即发即丢），前端挂载后经
/// get_pending_companion_toast 补拉本状态兜底。
/// 队列而非单条：分析轮可能连发多条建议（如多个未知应用），连续 push 时不丢前面几条。
#[derive(Default)]
pub struct PendingToastState(pub std::sync::Mutex<std::collections::VecDeque<db::Suggestion>>);

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
    let mut suggestion =
        db::create_suggestion(conn, suggestion_type, title, body, action_payload, now)
            .map_err(|e| format!("创建建议失败: {}", e))?;

    // 纯提示型：推送即落 seen，看过即终结（toast 只负责展示，不回传处置）
    if INFO_TYPES.contains(&suggestion_type) {
        db::set_suggestion_status(conn, suggestion.id, "seen", now)
            .map_err(|e| format!("更新建议状态失败: {}", e))?;
        suggestion.status = "seen".to_string();
        suggestion.acted_at = Some(now);
    }

    log::info!("Companion 新建议 [{}]: {}", suggestion_type, title);

    show_existing_suggestion(app_handle, &suggestion);

    Ok(suggestion.id)
}

/// 创建建议但不弹窗（凌晨分析轮：人不在电脑前，只落建议中心待处理）。
/// 与 push_suggestion 同款落库语义，只是跳过 show_toast_window。
pub fn push_suggestion_silent(
    conn: &Connection,
    suggestion_type: &str,
    title: &str,
    body: Option<&str>,
    action_payload: Option<&str>,
) -> Result<i64, String> {
    let now = chrono::Local::now().timestamp();
    let suggestion =
        db::create_suggestion(conn, suggestion_type, title, body, action_payload, now)
            .map_err(|e| format!("创建建议失败: {}", e))?;
    log::info!("Companion 新建议 [{}]: {}（静默）", suggestion_type, title);
    Ok(suggestion.id)
}

/// 把一条已存在的建议/意图推送到 toast 窗口（情境触发意图时用）。
/// 就绪握手：只落 pending + emit，不直接 show——show 由前端渲染完成回执触发，
/// 否则透明窗口会先呈现全透明首帧，且页面未就绪时 emit 丢失会让透明窗永久滞留。
pub fn show_existing_suggestion(app_handle: &AppHandle, suggestion: &db::Suggestion) {
    // 全屏静音：游戏/全屏视频时不弹陪伴建议（建议仍落库，恢复后可在建议中心查看）
    if crate::game_mode::should_mute(app_handle) {
        return;
    }

    if let Some(state) = app_handle.try_state::<PendingToastState>() {
        if let Ok(mut pending) = state.0.lock() {
            pending.push_back(suggestion.clone());
        }
    }
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
/// （仅在收到前端渲染完成回执后调用——内容首帧已就绪，不会呈现透明空帧）
pub(crate) fn show_toast_window(app_handle: &AppHandle) {
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
    } else {
        // 尝试抢焦点以支持 Esc/Enter 快捷键；后台进程可能被 Windows 焦点锁
        // 拦截，此时自动退化为「点击 toast 后可用键盘」，失败无需处理
        let _ = window.set_focus();
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
