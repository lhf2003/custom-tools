use tauri::Manager;
use window_vibrancy::{apply_blur, apply_mica};

/// Apply Windows vibrancy effect (Mica or Blur fallback)
#[cfg(target_os = "windows")]
fn apply_vibrancy_effect(window: &tauri::WebviewWindow) {
    // Try Mica first (Windows 11), fallback to Blur (Windows 10)
    if let Err(e) = apply_mica(window, Some(true)) {
        log::warn!("Failed to apply Mica effect, trying Blur: {}", e);
        if let Err(e) = apply_blur(window, None::<(u8, u8, u8, u8)>) {
            log::warn!("Failed to apply Blur effect: {}", e);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn apply_vibrancy_effect(_window: &tauri::WebviewWindow) {}

/// Position window at top of screen with padding (centered horizontally)
fn position_window_at_top(window: &tauri::WebviewWindow) -> Result<(), String> {
    // First center the window horizontally using built-in center
    window.center().map_err(|e| e.to_string())?;

    // Get current position after centering
    let current_pos = window.outer_position().map_err(|e| e.to_string())?;

    // Get the monitor to calculate top padding
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(window.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("No monitor found")?;

    const TOP_PADDING: i32 = 100; // Distance from top of screen

    // Calculate Y position (from top with padding)
    let y = monitor.position().y + TOP_PADDING;

    // Set position: keep centered X from center(), adjust Y to top
    window
        .set_position(tauri::Position::Physical(tauri::PhysicalPosition {
            x: current_pos.x,
            y,
        }))
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Show and focus the main window (positioned at top, not centered)
#[tauri::command]
pub async fn show_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app_handle.get_webview_window("main") {
        position_window_at_top(&window)?;
        window.show().map_err(|e| e.to_string())?;
        // Apply vibrancy effect after window is shown
        apply_vibrancy_effect(&window);
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
            // Apply vibrancy effect after window is shown
            apply_vibrancy_effect(&window);
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
