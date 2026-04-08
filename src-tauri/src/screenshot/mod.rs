use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::Manager;

pub mod commands;
pub mod models;

pub use commands::*;
pub use models::*;

/// 检测点是否在窗口内
pub fn is_point_in_window(window: &WindowBounds, x: i32, y: i32) -> bool {
    x >= window.x
        && x < window.x + window.width as i32
        && y >= window.y
        && y < window.y + window.height as i32
}

/// 获取包含该点的所有窗口（按 Z 序排序，第一个为最顶层）
pub fn get_windows_at_point(windows: &[WindowBounds], x: i32, y: i32) -> Vec<&WindowBounds> {
    windows
        .iter()
        .filter(|w| is_point_in_window(w, x, y))
        .collect()
}

/// 获取截图保存目录（使用剪贴板图片目录）
pub fn get_screenshot_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;

    let screenshot_dir = app_data_dir.join("clipboard-images");

    std::fs::create_dir_all(&screenshot_dir)
        .map_err(|e| format!("Failed to create screenshot dir: {}", e))?;

    Ok(screenshot_dir)
}

/// 生成截图文件名
pub fn generate_screenshot_filename(mode: &ScreenshotMode) -> String {
    let now = chrono::Local::now();
    let mode_str = match mode {
        ScreenshotMode::FullScreen => "full",
        ScreenshotMode::Window => "window",
        ScreenshotMode::Region => "region",
    };

    format!(
        "screenshot-{}-{}.png",
        mode_str,
        now.format("%Y%m%d-%H%M%S-%f")
    )
}

/// 图片转 base64
pub fn image_to_base64(path: &PathBuf) -> Result<String, String> {
    use base64::Engine;

    let image_data = std::fs::read(path)
        .map_err(|e| format!("Failed to read image file: {}", e))?;

    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&image_data)
    ))
}

/// 保存图片到文件
pub fn save_image(image: &image::DynamicImage, path: &PathBuf) -> Result<(), String> {
    image
        .save(path)
        .map_err(|e| format!("Failed to save image: {}", e))?;

    Ok(())
}

/// 裁剪图片
pub fn crop_image(
    image: &image::DynamicImage,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<image::DynamicImage, String> {
    let cropped = image.crop_imm(x, y, width, height);

    Ok(cropped)
}
