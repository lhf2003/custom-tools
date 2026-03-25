use tauri::Manager;

/// 获取当前窗口效果类型（供前端主动查询）
#[tauri::command]
pub fn get_window_effect() -> String {
    #[cfg(target_os = "windows")]
    {
        match crate::get_windows_version() {
            Some((major, minor, build)) => {
                let effect = crate::WindowEffect::from_windows_version(major, minor, build);
                effect.name().to_string()
            }
            None => "Unknown".to_string(),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        "Unknown".to_string()
    }
}

/// Position window at top of screen with padding on the monitor with cursor
fn position_window_at_top(window: &tauri::WebviewWindow) -> Result<(), String> {
    const TOP_PADDING: i32 = 100;
    const WINDOW_WIDTH: i32 = 800;

    // 获取鼠标所在的显示器
    let app_handle = window.app_handle();
    let target_monitor = crate::get_monitor_at_cursor(app_handle);

    if let Some(monitor) = target_monitor {
        let monitor_pos = monitor.position();
        let monitor_size = monitor.size();
        let scale_factor = monitor.scale_factor();

        // 修复：将逻辑像素宽度转换为物理像素
        let window_width_physical = (WINDOW_WIDTH as f64 * scale_factor) as i32;

        // 计算窗口居中位置（水平居中，顶部偏移）
        let x = monitor_pos.x + (monitor_size.width as i32 - window_width_physical) / 2;
        let y = monitor_pos.y + TOP_PADDING;

        window
            .set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }))
            .map_err(|e| e.to_string())?;
    } else {
        // 回退到默认居中
        window.center().map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Show and focus the main window (positioned at top, not centered)
#[tauri::command]
pub async fn show_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window("main") {
        position_window_at_top(&window)?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Hide the main window
#[tauri::command]
pub async fn hide_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Toggle window visibility (position at top when showing)
#[tauri::command]
pub async fn toggle_window(app_handle: tauri::AppHandle) -> Result<bool, String> {
    if let Some(window) = app_handle.get_webview_window("main") {
        let is_visible = window.is_visible().map_err(|e| e.to_string())?;
        if is_visible {
            window.hide().map_err(|e| e.to_string())?;
            Ok(false)
        } else {
            position_window_at_top(&window)?;
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            Ok(true)
        }
    } else {
        Err("Main window not found".to_string())
    }
}

/// Center the window on screen
#[tauri::command]
pub async fn center_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window("main") {
        window.center().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Resize the window to specified dimensions
/// If width is not provided, defaults to 800px
#[tauri::command]
pub async fn resize_window(
    app_handle: tauri::AppHandle,
    height: u32,
    width: Option<u32>,
) -> Result<(), String> {
    let target_width = width.unwrap_or(800) as f64;
    if let Some(window) = app_handle.get_webview_window("main") {
        window
            .set_size(tauri::Size::Logical(tauri::LogicalSize {
                width: target_width,
                height: height as f64,
            }))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
