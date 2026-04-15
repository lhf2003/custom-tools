use super::models::*;
use super::{generate_screenshot_filename, get_screenshot_dir, image_to_base64};
use image::GenericImageView;
use tauri::Manager;

/// 全屏截图（所有显示器）
#[tauri::command]
pub async fn capture_full_screen(app_handle: tauri::AppHandle) -> Result<ScreenshotResult, String> {
    log::info!("Starting full screen capture");

    let screenshot_dir = get_screenshot_dir(&app_handle)?;
    let filename = generate_screenshot_filename(&ScreenshotMode::FullScreen);
    let filepath = screenshot_dir.join(&filename);

    // 使用 xcap 捕获所有显示器
    let monitors = xcap::Monitor::all().map_err(|e| format!("Failed to get monitors: {}", e))?;

    if monitors.is_empty() {
        return Err("No monitors found".to_string());
    }

    // 捕获主显示器（或第一个显示器）
    let target_monitor = monitors.first().ok_or("No monitor available")?;

    let image = target_monitor
        .capture_image()
        .map_err(|e| format!("Failed to capture screen: {}", e))?;

    // 保存图片
    image::DynamicImage::ImageRgba8(image)
        .save(&filepath)
        .map_err(|e| format!("Failed to save screenshot: {}", e))?;

    let width = target_monitor.width().map_err(|e| format!("Failed to get width: {}", e))?;
    let height = target_monitor.height().map_err(|e| format!("Failed to get height: {}", e))?;

    log::info!("Full screen screenshot saved: {}", filepath.display());

    Ok(ScreenshotResult {
        filename,
        filepath: filepath.to_string_lossy().to_string(),
        mode: ScreenshotMode::FullScreen,
        width,
        height,
    })
}

/// 获取可截图窗口列表
#[tauri::command]
pub async fn get_capturable_windows() -> Result<Vec<WindowInfo>, String> {
    log::info!("Getting capturable windows");

    let windows = xcap::Window::all().map_err(|e| format!("Failed to get windows: {}", e))?;

    let mut window_infos: Vec<WindowInfo> = Vec::new();
    for w in windows {
        // 跳过最小化的窗口
        match w.is_minimized() {
            Ok(true) => continue,
            Err(_) => continue,
            _ => {}
        }

        let id = match w.id() {
            Ok(id) => id as u64,
            Err(_) => continue,
        };

        let title = match w.title() {
            Ok(t) => t,
            Err(_) => continue,
        };

        let app_name = match w.app_name() {
            Ok(n) => n,
            Err(_) => continue,
        };

        // 跳过空标题的窗口
        if title.is_empty() {
            continue;
        }

        // 跳过截图遮罩窗口自身，避免前端将其识别为可截图目标
        if title == "截图工具" {
            continue;
        }

        window_infos.push(WindowInfo {
            id,
            title,
            app_name,
            thumbnail: None,
        });
    }

    Ok(window_infos)
}

/// 捕获指定窗口
#[tauri::command]
pub async fn capture_window(
    window_id: u64,
    app_handle: tauri::AppHandle,
) -> Result<ScreenshotResult, String> {
    log::info!("Capturing window: {}", window_id);

    let screenshot_dir = get_screenshot_dir(&app_handle)?;
    let filename = generate_screenshot_filename(&ScreenshotMode::Window);
    let filepath = screenshot_dir.join(&filename);

    // 找到指定窗口
    let windows = xcap::Window::all().map_err(|e| format!("Failed to get windows: {}", e))?;

    let target_window = windows
        .into_iter()
        .find(|w| {
            match w.id() {
                Ok(id) => id as u64 == window_id,
                Err(_) => false,
            }
        })
        .ok_or_else(|| format!("Window with id {} not found", window_id))?;

    let image = target_window
        .capture_image()
        .map_err(|e| format!("Failed to capture window: {}", e))?;

    image::DynamicImage::ImageRgba8(image)
        .save(&filepath)
        .map_err(|e| format!("Failed to save screenshot: {}", e))?;

    let width = target_window.width().map_err(|e| format!("Failed to get width: {}", e))?;
    let height = target_window.height().map_err(|e| format!("Failed to get height: {}", e))?;

    log::info!("Window screenshot saved: {}", filepath.display());

    Ok(ScreenshotResult {
        filename,
        filepath: filepath.to_string_lossy().to_string(),
        mode: ScreenshotMode::Window,
        width,
        height,
    })
}

/// 区域截图
/// 若提供了 background_image_path，则优先从该临时背景图中裁剪，避免重新调用 xcap 捕获
#[tauri::command]
pub async fn capture_region(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    background_image_path: Option<String>,
    monitor_x: Option<i32>,
    monitor_y: Option<i32>,
    app_handle: tauri::AppHandle,
) -> Result<ScreenshotResult, String> {
    log::info!("[capture_region] Starting with params: x={}, y={}, width={}, height={}", x, y, width, height);

    let screenshot_dir = get_screenshot_dir(&app_handle)?;
    let filename = generate_screenshot_filename(&ScreenshotMode::Region);
    let filepath = screenshot_dir.join(&filename);

    let cropped_image = if let Some(bg_path) = background_image_path {
        log::info!("[capture_region] Using provided background image: {}", bg_path);
        let bg_path_buf = std::path::PathBuf::from(&bg_path);
        if bg_path_buf.exists() {
            match image::open(&bg_path_buf) {
                Ok(img) => {
                    let base_x = monitor_x.unwrap_or(0);
                    let base_y = monitor_y.unwrap_or(0);
                    let relative_x = (x - base_x).max(0) as u32;
                    let relative_y = (y - base_y).max(0) as u32;
                    let img_width = img.width();
                    let img_height = img.height();
                    let crop_width = width.min(img_width.saturating_sub(relative_x));
                    let crop_height = height.min(img_height.saturating_sub(relative_y));
                    if crop_width > 0 && crop_height > 0 {
                        image::DynamicImage::ImageRgba8(img.into_rgba8().view(relative_x, relative_y, crop_width, crop_height).to_image())
                    } else {
                        log::warn!("[capture_region] Invalid crop dimensions from background image, falling back to xcap");
                        capture_monitor_and_crop(x, y, width, height).await?
                    }
                }
                Err(e) => {
                    log::warn!("[capture_region] Failed to open background image: {}, falling back to xcap", e);
                    capture_monitor_and_crop(x, y, width, height).await?
                }
            }
        } else {
            log::warn!("[capture_region] Background image does not exist, falling back to xcap");
            capture_monitor_and_crop(x, y, width, height).await?
        }
    } else {
        capture_monitor_and_crop(x, y, width, height).await?
    };

    log::info!("[capture_region] Saving image to {:?}...", filepath);
    cropped_image
        .save(&filepath)
        .map_err(|e| format!("Failed to save screenshot: {}", e))?;

    log::info!("[capture_region] Success! Saved: {:?}", filepath);

    Ok(ScreenshotResult {
        filename,
        filepath: filepath.to_string_lossy().to_string(),
        mode: ScreenshotMode::Region,
        width,
        height,
    })
}

/// 使用 xcap 捕获包含目标区域的显示器，并裁剪出指定区域
async fn capture_monitor_and_crop(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<image::DynamicImage, String> {
    let monitors = xcap::Monitor::all().map_err(|e| format!("Failed to get monitors: {}", e))?;

    let target_monitor = monitors
        .iter()
        .find(|m| {
            let mx = m.x().unwrap_or(0);
            let my = m.y().unwrap_or(0);
            let mw = m.width().unwrap_or(0) as i32;
            let mh = m.height().unwrap_or(0) as i32;
            x >= mx && x < mx + mw && y >= my && y < my + mh
        })
        .or_else(|| monitors.first())
        .ok_or("No monitor available")?;

    let monitor_x = target_monitor.x().unwrap_or(0);
    let monitor_y = target_monitor.y().unwrap_or(0);
    let relative_x = (x - monitor_x) as u32;
    let relative_y = (y - monitor_y) as u32;

    let full_image = target_monitor
        .capture_image()
        .map_err(|e| format!("Failed to capture screen: {}", e))?;

    let cropped = full_image.view(relative_x, relative_y, width, height);
    Ok(image::DynamicImage::ImageRgba8(cropped.to_image()))
}

/// 保存截图并复制到剪贴板（合并命令，减少 IPC 往返）
#[tauri::command]
pub async fn save_and_copy_screenshot(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    background_image_path: Option<String>,
    monitor_x: Option<i32>,
    monitor_y: Option<i32>,
    cleanup_background: Option<bool>,
    app_handle: tauri::AppHandle,
) -> Result<ScreenshotResult, String> {
    let bg_path = background_image_path.clone();
    let should_cleanup = cleanup_background.unwrap_or(false);

    let result = capture_region(
        x, y, width, height,
        background_image_path,
        monitor_x, monitor_y,
        app_handle.clone()
    ).await?;

    let filepath = result.filepath.clone();

    // 复制到剪贴板（使用 spawn_blocking 避免阻塞 async runtime）
    let app_handle_for_clipboard = app_handle.clone();
    let copy_result = tokio::task::spawn_blocking(move || {
        crate::commands::clipboard::copy_file_to_clipboard(app_handle_for_clipboard, filepath)
    }).await;

    if let Err(e) = copy_result {
        log::error!("[save_and_copy_screenshot] Clipboard task panicked: {}", e);
        return Err("保存成功但复制到剪贴板时发生错误".to_string());
    }

    if let Err(e) = copy_result.unwrap() {
        log::error!("[save_and_copy_screenshot] Failed to copy to clipboard: {}", e);
        return Err(format!("保存成功但复制到剪贴板失败: {}", e));
    }

    // 清理临时背景图文件
    if should_cleanup {
        if let Some(path) = bg_path {
            if let Err(e) = std::fs::remove_file(&path) {
                log::warn!("[save_and_copy_screenshot] Failed to remove background file: {}", e);
            } else {
                log::info!("[save_and_copy_screenshot] Removed background file: {}", path);
            }
        }
    }

    Ok(result)
}

/// 图片转 base64
#[tauri::command]
pub async fn screenshot_to_base64(filepath: String) -> Result<String, String> {
    let path = std::path::PathBuf::from(&filepath);
    image_to_base64(&path)
}

/// 获取所有可见窗口的边界信息
#[tauri::command]
pub async fn get_all_windows() -> Result<Vec<WindowBounds>, String> {
    log::info!("Getting all window bounds");

    let windows = xcap::Window::all().map_err(|e| format!("Failed to get windows: {}", e))?;

    let mut window_bounds: Vec<WindowBounds> = Vec::new();
    for w in windows {
        // 跳过最小化的窗口
        let is_minimized = match w.is_minimized() {
            Ok(m) => m,
            Err(_) => continue,
        };

        if is_minimized {
            continue;
        }

        let id = match w.id() {
            Ok(id) => id as u64,
            Err(_) => continue,
        };

        let title = match w.title() {
            Ok(t) => t,
            Err(_) => continue,
        };

        let app_name = match w.app_name() {
            Ok(n) => n,
            Err(_) => continue,
        };

        let x = match w.x() {
            Ok(x) => x,
            Err(_) => continue,
        };

        let y = match w.y() {
            Ok(y) => y,
            Err(_) => continue,
        };

        let width = match w.width() {
            Ok(w) => w,
            Err(_) => continue,
        };

        let height = match w.height() {
            Ok(h) => h,
            Err(_) => continue,
        };

        // 跳过无效窗口（无标题、零尺寸）
        if title.is_empty() || width == 0 || height == 0 {
            continue;
        }

        // 跳过截图遮罩窗口自身，避免前端将其误判为悬停目标
        if title == "截图工具" {
            continue;
        }

        window_bounds.push(WindowBounds {
            id,
            title,
            app_name,
            x,
            y,
            width,
            height,
            is_minimized,
        });
    }

    log::info!("Found {} visible windows", window_bounds.len());
    Ok(window_bounds)
}

/// 获取指定坐标下的窗口
#[tauri::command]
pub async fn get_window_at_point(x: i32, y: i32) -> Result<Option<WindowBounds>, String> {
    let windows = get_all_windows().await?;

    // 找到包含该点的最顶层窗口（按 Z 序，列表前面的通常是顶层）
    let window = windows.into_iter().find(|w| {
        x >= w.x && x < w.x + w.width as i32 && y >= w.y && y < w.y + w.height as i32
    });

    Ok(window)
}

/// 关闭截图遮罩窗口（复用窗口：hide 而非 close）
#[tauri::command]
pub async fn close_screenshot_overlay(app_handle: tauri::AppHandle) -> Result<(), String> {
    log::info!("Hiding screenshot overlay window");

    if let Some(window) = app_handle.get_webview_window("screenshot-overlay") {
        window
            .hide()
            .map_err(|e| format!("Failed to hide overlay window: {}", e))?;
        log::info!("Screenshot overlay window hidden successfully");
    } else {
        log::warn!("Screenshot overlay window not found");
    }

    Ok(())
}

/// 清理截图遮罩层的临时背景图文件
#[tauri::command]
pub async fn cleanup_overlay_background(filepath: String) -> Result<(), String> {
    let path = std::path::PathBuf::from(&filepath);
    if path.exists() {
        if let Err(e) = std::fs::remove_file(&path) {
            log::warn!("Failed to remove overlay background file: {}", e);
        } else {
            log::info!("Removed overlay background file: {}", filepath);
        }
    }
    Ok(())
}

/// OCR 截图识别
#[tauri::command]
pub async fn ocr_screenshot(
    filepath: String,
    prompt: Option<String>,
    model: Option<String>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    use crate::llm::call_llm;

    log::info!("Starting OCR for screenshot: {}", filepath);

    let db_path = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?
        .join("custom-tools.db");

    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| format!("Failed to open database: {}", e))?;

    // 读取图片并转换为 base64
    let base64_image = image_to_base64(&std::path::PathBuf::from(&filepath))?;

    // 获取默认的 OCR 提供商配置（使用 qa 场景的提供商）
    let provider_row: Result<(String, Option<String>, String), rusqlite::Error> = conn.query_row(
        "SELECT p.base_url, p.api_key_encrypted, p.provider_type
         FROM llm_providers p
         JOIN llm_scene_configs sc ON p.id = sc.provider_id
         WHERE sc.scene = 'qa' AND p.is_active = 1
         LIMIT 1",
        [],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
            ))
        },
    );

    let (base_url, api_key_encrypted, provider_type) = match provider_row {
        Ok(row) => row,
        Err(_) => {
            // 如果没有配置，使用默认的 Ollama 配置
            ("http://localhost:11434".to_string(), None, "ollama".to_string())
        }
    };

    // 获取模型
    let model_id = model.unwrap_or_else(|| {
        // 从数据库获取 qa 场景的模型
        conn.query_row(
            "SELECT model_id FROM llm_scene_configs WHERE scene = 'qa'",
            [],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_else(|_| "llama3.2-vision:11b".to_string())
    });

    // 解密 API key
    let api_key = if let Some(key) = api_key_encrypted {
        crate::llm_provider::crypto::decrypt(&key,
            &app_handle.path().app_data_dir().unwrap(),
        )
        .unwrap_or_default()
    } else {
        String::new()
    };

    // 构建消息
    let messages = vec![crate::llm::ChatMessage {
        role: "user".to_string(),
        content: prompt.unwrap_or_else(|| "请识别图片中的文字内容，只返回文字，不要其他解释".to_string()),
        images: Some(vec![base64_image]),
    }];

    // 调用 LLM 进行 OCR
    let result = call_llm(
        &base_url,
        &api_key,
        &model_id,
        &provider_type,
        messages,
        false,
    ).await?;

    log::info!("OCR completed for screenshot: {}", filepath);
    Ok(result)
}
