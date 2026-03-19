use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use sha2::{Digest, Sha256};

use crate::db::DatabaseState;

/// Result type for clipboard read operations
#[derive(Debug, Serialize, Deserialize)]
pub struct ClipboardReadResult {
    pub success: bool,
    pub result_type: String, // "file", "image", "text", "none"
    pub path: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ClipboardItem {
    pub id: i64,
    pub content: String,
    pub content_type: String,
    pub source_app: Option<String>,
    pub is_favorite: bool,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ClipboardQuery {
    pub content_type: Option<String>,
    pub is_favorite: Option<bool>,
    pub search: Option<String>,
    pub limit: Option<i64>,
}

/// Get clipboard history
#[tauri::command]
pub fn get_clipboard_history(
    db_state: State<DatabaseState>,
    query: ClipboardQuery,
) -> Result<Vec<ClipboardItem>, String> {
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    // Build query with optional filters
    let search_pattern = query.search.as_ref().map(|s| format!("%{}%", s));
    let limit = query.limit.unwrap_or(50);

    let mut sql = String::from(
        "SELECT id, content, content_type, source_app, is_favorite, created_at
         FROM clipboard_history WHERE 1=1",
    );

    if query.content_type.is_some() {
        sql.push_str(" AND content_type = ?1");
    }

    if query.is_favorite.is_some() {
        sql.push_str(" AND is_favorite = ?2");
    }

    if search_pattern.is_some() {
        sql.push_str(" AND content LIKE ?3");
    }

    sql.push_str(" ORDER BY created_at DESC LIMIT ?4");

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

    let items = stmt
        .query_map(
            params![
                query.content_type,
                query.is_favorite.map(|b| b as i32),
                search_pattern,
                limit
            ],
            |row| {
                Ok(ClipboardItem {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    content_type: row.get(2)?,
                    source_app: row.get(3)?,
                    is_favorite: row.get::<_, i32>(4)? != 0,
                    created_at: row.get(5)?,
                })
            },
        )
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(items)
}

/// Toggle favorite status
#[tauri::command]
pub fn toggle_clipboard_favorite(
    db_state: State<DatabaseState>,
    id: i64,
) -> Result<bool, String> {
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    conn.execute(
        "UPDATE clipboard_history SET is_favorite = NOT is_favorite WHERE id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;

    let is_favorite: bool = conn
        .query_row(
            "SELECT is_favorite FROM clipboard_history WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    Ok(is_favorite)
}

/// Delete clipboard item
#[tauri::command]
pub fn delete_clipboard_item(db_state: State<DatabaseState>, id: i64) -> Result<(), String> {
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    // Get content type and path for image cleanup
    let (content_type, content): (String, String) = conn
        .query_row(
            "SELECT content_type, content FROM clipboard_history WHERE id = ?1",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|e| e.to_string())?;

    // Delete from database
    conn.execute(
        "DELETE FROM clipboard_history WHERE id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;

    // Cleanup image file if applicable
    if content_type == "image" {
        let _ = std::fs::remove_file(&content);
    }

    Ok(())
}

/// Clear all clipboard history
#[tauri::command]
pub fn clear_clipboard_history(db_state: State<DatabaseState>) -> Result<(), String> {
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    // Get all image paths first
    let mut stmt = conn
        .prepare("SELECT content FROM clipboard_history WHERE content_type = 'image'")
        .map_err(|e| e.to_string())?;

    let image_paths: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    // Delete all records
    conn.execute("DELETE FROM clipboard_history", [])
        .map_err(|e| e.to_string())?;

    // Cleanup image files
    for path in image_paths {
        let _ = std::fs::remove_file(path);
    }

    Ok(())
}

/// Copy clipboard item back to clipboard
#[tauri::command]
pub fn copy_to_clipboard(
    db_state: State<DatabaseState>,
    app_handle: tauri::AppHandle,
    id: i64,
) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;

    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    let (content_type, content): (String, String) = conn
        .query_row(
            "SELECT content_type, content FROM clipboard_history WHERE id = ?1",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|e| e.to_string())?;

    match content_type.as_str() {
        "text" => {
            app_handle
                .clipboard()
                .write_text(content)
                .map_err(|e| e.to_string())?;
        }
        "image" => {
            // Read image file and write to clipboard
            let image_data = std::fs::read(&content).map_err(|e| e.to_string())?;

            #[cfg(windows)]
            {
                copy_image_to_windows_clipboard(&image_data)?;
            }

            #[cfg(not(windows))]
            {
                log::warn!("Image clipboard copy not implemented for non-Windows platforms");
            }
        }
        "file" => {
            // TODO: Implement file list clipboard write
            log::info!("File list copy not yet implemented");
        }
        _ => {}
    }

    // Update usage count and last used time
    let _ = conn.execute(
        "UPDATE clipboard_history SET usage_count = COALESCE(usage_count, 0) + 1, last_used_at = CURRENT_TIMESTAMP WHERE id = ?1",
        params![id],
    );

    Ok(())
}

/// Copy image data to Windows clipboard
#[cfg(windows)]
fn copy_image_to_windows_clipboard(image_data: &[u8]) -> Result<(), String> {
    use windows::Win32::System::DataExchange::{OpenClipboard, CloseClipboard, SetClipboardData, EmptyClipboard};
    use windows::Win32::Foundation::{HWND, HANDLE};
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT};
    use windows::Win32::Graphics::Gdi::BITMAPINFOHEADER;

    unsafe {
        // Open clipboard
        if OpenClipboard(HWND(0)).is_err() {
            return Err("Failed to open clipboard".to_string());
        }

        // Empty clipboard to take ownership
        if EmptyClipboard().is_err() {
            let _ = CloseClipboard();
            return Err("Failed to empty clipboard".to_string());
        }

        // Load image using image crate
        let img = match image::load_from_memory(image_data) {
            Ok(img) => img.to_rgba8(),
            Err(e) => {
                let _ = CloseClipboard();
                return Err(format!("Failed to load image: {}", e));
            }
        };

        let width = img.width() as i32;
        let height = img.height() as i32;

        // Create DIB (Device Independent Bitmap)
        let header_size = std::mem::size_of::<BITMAPINFOHEADER>();
        let pixel_data_size = (width * height * 4) as usize;
        let total_size = header_size + pixel_data_size;

        // Allocate global memory for DIB
        let hglobal = match GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, total_size) {
            Ok(h) => h,
            Err(_) => {
                let _ = CloseClipboard();
                return Err("Failed to allocate global memory".to_string());
            }
        };

        let ptr = GlobalLock(hglobal) as *mut u8;
        if ptr.is_null() {
            let _ = CloseClipboard();
            return Err("Failed to lock global memory".to_string());
        }

        // Write BITMAPINFOHEADER
        let header = ptr as *mut BITMAPINFOHEADER;
        (*header).biSize = header_size as u32;
        (*header).biWidth = width;
        (*header).biHeight = height; // Positive = bottom-up DIB
        (*header).biPlanes = 1;
        (*header).biBitCount = 32;
        (*header).biCompression = 0; // BI_RGB = 0
        (*header).biSizeImage = pixel_data_size as u32;
        (*header).biXPelsPerMeter = 0;
        (*header).biYPelsPerMeter = 0;
        (*header).biClrUsed = 0;
        (*header).biClrImportant = 0;

        // Write pixel data (RGBA to BGRA)
        let pixel_ptr = ptr.add(header_size);
        for y in 0..height {
            for x in 0..width {
                let pixel = img.get_pixel(x as u32, (height - 1 - y) as u32);
                let offset = ((y * width + x) * 4) as usize;
                *pixel_ptr.add(offset) = pixel[2];     // B
                *pixel_ptr.add(offset + 1) = pixel[1]; // G
                *pixel_ptr.add(offset + 2) = pixel[0]; // R
                *pixel_ptr.add(offset + 3) = pixel[3]; // A
            }
        }

        let _ = GlobalUnlock(hglobal);

        // Set CF_DIB data to clipboard
        // Note: After SetClipboardData succeeds, the system owns the memory and we should not free it
        const CF_DIB: u32 = 8;
        let handle = HANDLE(hglobal.0 as isize);
        let result = SetClipboardData(CF_DIB, handle);
        if result.is_err() {
            let _ = CloseClipboard();
            return Err("Failed to set clipboard data".to_string());
        }

        // Close clipboard
        let _ = CloseClipboard();

        log::info!("Image copied to clipboard: {}x{}", width, height);
        Ok(())
    }
}

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

/// Get clipboard image as base64 for preview
#[tauri::command]
pub fn get_clipboard_image_base64(
    db_state: State<DatabaseState>,
    id: i64,
) -> Result<String, String> {
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    let (content_type, content): (String, String) = conn
        .query_row(
            "SELECT content_type, content FROM clipboard_history WHERE id = ?1",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|e| e.to_string())?;

    if content_type != "image" {
        return Err("Item is not an image".to_string());
    }

    // Read image file and convert to base64
    let image_data = std::fs::read(&content).map_err(|e| e.to_string())?;

    // Detect mime type from file extension or content
    let mime_type = if content.ends_with(".png") {
        "image/png"
    } else if content.ends_with(".jpg") || content.ends_with(".jpeg") {
        "image/jpeg"
    } else if content.ends_with(".gif") {
        "image/gif"
    } else if content.ends_with(".webp") {
        "image/webp"
    } else {
        "image/png" // default
    };

    let base64_str = BASE64.encode(&image_data);
    Ok(format!("data:{};base64,{}" , mime_type, base64_str))
}

/// Handle pasted file from file system
#[tauri::command]
pub fn handle_pasted_file(
    db_state: State<DatabaseState>,
    path: String,
) -> Result<(), String> {
    log::info!("Handling pasted file: {}", path);

    // Verify file exists
    if !std::path::Path::new(&path).exists() {
        return Err(format!("File not found: {}", path));
    }

    // Check if it's an image file
    let path_obj = std::path::Path::new(&path);
    let extension = path_obj
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match extension.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" => {
            // Image file - copy to app directory and save to db
            handle_pasted_image_file(db_state, &path)
        }
        _ => {
            // Other file - save as file path
            handle_pasted_generic_file(db_state, &path)
        }
    }
}

fn handle_pasted_image_file(
    db_state: State<DatabaseState>,
    path: &str,
) -> Result<(), String> {
    // Read image data
    let image_data = std::fs::read(path).map_err(|e| e.to_string())?;

    // Calculate hash
    let mut hasher = Sha256::new();
    hasher.update(&image_data);
    let hash = format!("{:x}", hasher.finalize());

    // Save to app data directory
    let app_dir = dirs::data_dir()
        .ok_or("Failed to get data dir")?
        .join("custom-tools")
        .join("clipboard-images");
    std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;

    let file_name = format!("{}.png", &hash[..16]);
    let image_path = app_dir.join(&file_name);

    // Convert to PNG if needed
    if path.to_lowercase().ends_with(".png") {
        std::fs::copy(path, &image_path).map_err(|e| e.to_string())?;
    } else {
        // Convert other formats to PNG
        let img = image::open(path).map_err(|e| e.to_string())?;
        img.save_with_format(&image_path, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
    }

    // Save to database
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO clipboard_history
         (content, content_type, content_hash, source_app, is_favorite, usage_count, created_at)
         VALUES (?1, 'image', ?2, 'FilePaste', 0, 0, CURRENT_TIMESTAMP)
         ON CONFLICT(content_hash) DO UPDATE SET created_at = CURRENT_TIMESTAMP",
        params![image_path.to_string_lossy().to_string(), hash],
    ).map_err(|e| e.to_string())?;

    log::info!("Pasted image file saved: {}", image_path.display());
    Ok(())
}

fn handle_pasted_generic_file(
    db_state: State<DatabaseState>,
    path: &str,
) -> Result<(), String> {
    // Calculate hash of the path
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    let hash = format!("{:x}", hasher.finalize());

    // Save to database
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO clipboard_history
         (content, content_type, content_hash, source_app, is_favorite, usage_count, created_at)
         VALUES (?1, 'file', ?2, 'FilePaste', 0, 0, CURRENT_TIMESTAMP)
         ON CONFLICT(content_hash) DO UPDATE SET created_at = CURRENT_TIMESTAMP",
        params![path.to_string(), hash],
    ).map_err(|e| e.to_string())?;

    log::info!("Pasted file saved: {}", path);
    Ok(())
}

/// Read clipboard image from backend using Windows API
/// This is necessary because browser Clipboard API cannot access DIB format
#[cfg(windows)]
#[tauri::command]
pub fn read_clipboard_image() -> Result<ClipboardReadResult, String> {
    use windows::Win32::System::DataExchange::{OpenClipboard, CloseClipboard};
    use windows::Win32::Foundation::HWND;

    unsafe {
        // Open clipboard (HWND(0) means current process)
        if OpenClipboard(HWND(0)).is_err() {
            return Ok(ClipboardReadResult {
                success: false,
                result_type: "none".to_string(),
                path: None,
                message: Some("Failed to open clipboard".to_string()),
            });
        }

        let result = read_clipboard_content_inner();
        let _ = CloseClipboard();

        result
    }
}

#[cfg(not(windows))]
#[tauri::command]
pub fn read_clipboard_image() -> Result<ClipboardReadResult, String> {
    Ok(ClipboardReadResult {
        success: false,
        result_type: "none".to_string(),
        path: None,
        message: Some("Clipboard image reading is only supported on Windows".to_string()),
    })
}

#[cfg(windows)]
unsafe fn read_clipboard_content_inner() -> Result<ClipboardReadResult, String> {
    use windows::Win32::System::DataExchange::GetClipboardData;
    use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};

    // Clipboard format constants
    const CF_UNICODETEXT: u32 = 13;
    const CF_HDROP: u32 = 15;
    const CF_DIB: u32 = 8;
    const CF_DIBV5: u32 = 17;

    // 1. Try to read file list (CF_HDROP)
    if let Ok(handle) = GetClipboardData(CF_HDROP) {
        if !handle.is_invalid() {
            if let Ok(files) = read_hdrop_data(handle) {
                if !files.is_empty() {
                    return Ok(ClipboardReadResult {
                        success: true,
                        result_type: "file".to_string(),
                        path: Some(files[0].clone()),
                        message: None,
                    });
                }
            }
        }
    }

    // 2. Try to read image (CF_DIB)
    if let Ok(handle) = GetClipboardData(CF_DIB) {
        if !handle.is_invalid() {
            // Convert HANDLE to HGLOBAL (HANDLE is isize, HGLOBAL is *mut c_void)
            let hglobal = windows::Win32::Foundation::HGLOBAL(handle.0 as *mut std::ffi::c_void);
            let ptr = GlobalLock(hglobal);
            if !ptr.is_null() {
                let result = read_dib_data_and_save(ptr);
                let _ = GlobalUnlock(hglobal);

                match result {
                    Ok(path) => {
                        return Ok(ClipboardReadResult {
                            success: true,
                            result_type: "image".to_string(),
                            path: Some(path),
                            message: None,
                        });
                    }
                    Err(e) => {
                        log::warn!("Failed to convert DIB: {}", e);
                    }
                }
            }
        }
    }

    // 3. Try to read DIBV5 (newer format)
    if let Ok(handle) = GetClipboardData(CF_DIBV5) {
        if !handle.is_invalid() {
            log::info!("CF_DIBV5 available but not fully implemented");
            // TODO: Implement DIBV5 reading if needed
        }
    }

    // 4. Check for text (already handled by clipboard watcher)
    if let Ok(handle) = GetClipboardData(CF_UNICODETEXT) {
        if !handle.is_invalid() {
            return Ok(ClipboardReadResult {
                success: true,
                result_type: "text".to_string(),
                path: None,
                message: None,
            });
        }
    }

    Ok(ClipboardReadResult {
        success: false,
        result_type: "none".to_string(),
        path: None,
        message: Some("No supported content found in clipboard".to_string()),
    })
}

#[cfg(windows)]
unsafe fn read_hdrop_data(handle: windows::Win32::Foundation::HANDLE) -> Result<Vec<String>, String> {
    use windows::Win32::UI::Shell::DragQueryFileW;
    use windows::Win32::UI::Shell::HDROP;

    let hdrop = HDROP(handle.0 as isize);
    let file_count = DragQueryFileW(hdrop, 0xFFFFFFFF, None);

    if file_count == 0 {
        return Err("No files in HDROP".to_string());
    }

    let mut files = Vec::new();
    for i in 0..file_count {
        let path_len = DragQueryFileW(hdrop, i, None);
        if path_len == 0 {
            continue;
        }

        let mut buffer = vec![0u16; path_len as usize + 1];
        let chars_copied = DragQueryFileW(hdrop, i, Some(&mut buffer));

        if chars_copied > 0 {
            let path = String::from_utf16_lossy(&buffer[..chars_copied as usize]);
            files.push(path);
        }
    }

    Ok(files)
}

#[cfg(windows)]
unsafe fn read_dib_data_and_save(ptr: *mut std::ffi::c_void) -> Result<String, String> {
    use std::slice;

    // BITMAPINFOHEADER structure
    #[repr(C)]
    struct BITMAPINFOHEADER {
        biSize: u32,
        biWidth: i32,
        biHeight: i32,
        biPlanes: u16,
        biBitCount: u16,
        biCompression: u32,
        biSizeImage: u32,
        biXPelsPerMeter: i32,
        biYPelsPerMeter: i32,
        biClrUsed: u32,
        biClrImportant: u32,
    }

    let header = &*(ptr as *const BITMAPINFOHEADER);

    let width = header.biWidth as u32;
    let height = header.biHeight.abs() as u32;
    let bit_count = header.biBitCount as u32;

    if width == 0 || height == 0 {
        return Err("Invalid image dimensions".to_string());
    }

    let row_size = ((width * bit_count + 31) / 32) * 4;

    // Calculate pixel data offset
    let header_size = header.biSize as usize;
    let color_table_size = if header.biClrUsed > 0 {
        header.biClrUsed as usize * 4
    } else if bit_count <= 8 {
        (1usize << bit_count) * 4
    } else {
        0
    };

    let pixel_data_offset = header_size + color_table_size;
    let pixel_data_ptr = (ptr as *const u8).add(pixel_data_offset);
    let image_size = (row_size * height) as usize;

    // Safety check
    if image_size == 0 || image_size > 100_000_000 { // 100MB limit
        return Err(format!("Invalid image size: {}", image_size));
    }

    let pixel_data = slice::from_raw_parts(pixel_data_ptr, image_size);

    // Convert to RGBA
    let mut rgba_data = Vec::with_capacity((width * height * 4) as usize);
    let is_top_down = header.biHeight < 0;

    for y in 0..height {
        let src_y = if is_top_down { y } else { height - 1 - y };
        let row_start = (src_y * row_size as u32) as usize;

        for x in 0..width {
            let pixel_offset = row_start + (x * (bit_count / 8)) as usize;

            if bit_count == 24 || bit_count == 32 {
                let b = pixel_data[pixel_offset];
                let g = pixel_data[pixel_offset + 1];
                let r = pixel_data[pixel_offset + 2];
                let a = if bit_count == 32 {
                    pixel_data[pixel_offset + 3]
                } else {
                    255
                };

                rgba_data.push(r);
                rgba_data.push(g);
                rgba_data.push(b);
                rgba_data.push(a);
            }
        }
    }

    // Encode as PNG using image crate
    let img = image::RgbaImage::from_raw(width, height, rgba_data)
        .ok_or("Failed to create image from raw data")?;

    // Calculate hash
    let mut png_data = Vec::new();
    {
        let cursor = std::io::Cursor::new(&mut png_data);
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::BufWriter::new(cursor), image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
    }

    let mut hasher = Sha256::new();
    hasher.update(&png_data);
    let hash = format!("{:x}", hasher.finalize());

    // Save to app data directory
    let app_dir = dirs::data_dir()
        .ok_or("Failed to get data dir")?
        .join("custom-tools")
        .join("clipboard-images");
    std::fs::create_dir_all(&app_dir).map_err(|e| e.to_string())?;

    let image_path = app_dir.join(format!("{}.png", &hash[..16]));
    std::fs::write(&image_path, &png_data).map_err(|e| e.to_string())?;

    // Save to database
    let db_dir = app_dir.parent().unwrap();
    let db_path = db_dir.join("clipboard.db");
    let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO clipboard_history
         (content, content_type, content_hash, source_app, is_favorite, usage_count, created_at)
         VALUES (?1, 'image', ?2, 'ScreenshotPaste', 0, 0, CURRENT_TIMESTAMP)
         ON CONFLICT(content_hash) DO UPDATE SET created_at = CURRENT_TIMESTAMP",
        params![image_path.to_string_lossy().to_string(), hash],
    ).map_err(|e| e.to_string())?;

    log::info!("Screenshot saved: {}", image_path.display());
    Ok(image_path.to_string_lossy().to_string())
}

/// Paste clipboard item to previous focused window
/// This copies the item to clipboard, hides the window, and simulates Ctrl+V
#[tauri::command]
pub fn paste_to_clipboard_item(
    db_state: State<DatabaseState>,
    app_handle: tauri::AppHandle,
    id: i64,
) -> Result<(), String> {
    // First copy to clipboard
    copy_to_clipboard(db_state, app_handle.clone(), id)?;

    // Check if auto-paste is enabled
    let auto_paste_enabled = if let Some(settings_state) = app_handle.try_state::<crate::commands::settings::SettingsState>() {
        settings_state.0.lock().map(|mgr| mgr.get_settings().clipboard_auto_paste).unwrap_or(true)
    } else {
        true // Default to enabled if settings not available
    };

    // Get the previous focused window
    let prev_hwnd = app_handle.try_state::<crate::PreviousFocusedWindow>()
        .and_then(|state| state.get());

    // Hide the window first
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.hide();
    }

    // If auto-paste is enabled and we have a valid previous window, try to paste
    if auto_paste_enabled {
        if let Some(hwnd) = prev_hwnd {
            #[cfg(windows)]
            {
                // Small delay to ensure window is hidden and target is ready
                std::thread::sleep(std::time::Duration::from_millis(50));
                unsafe { simulate_paste_to_window(hwnd) };
            }
        } else {
            log::info!("No previous focused window available, only copied to clipboard");
        }
    } else {
        log::info!("Auto-paste is disabled, only copied to clipboard");
    }

    Ok(())
}

/// Simulate Ctrl+V keystrokes to paste clipboard content
/// Uses the ALT-key trick to reliably SetForegroundWindow on Windows
#[cfg(windows)]
unsafe fn simulate_paste_to_window(target_hwnd: isize) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetForegroundWindow, BringWindowToTop, IsWindow, IsWindowVisible
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYBD_EVENT_FLAGS,
        VK_MENU, VK_CONTROL, VK_V
    };
    use windows::Win32::Foundation::HWND;

    // Validate the window still exists
    let hwnd = HWND(target_hwnd);
    if IsWindow(hwnd).as_bool() == false {
        log::warn!("Target window is no longer valid");
        return;
    }

    // Only paste if window is visible (not minimized)
    if !IsWindowVisible(hwnd).as_bool() {
        log::info!("Target window is not visible, skipping paste");
        return;
    }

    // The ALT-key trick: Send ALT keypress to unlock SetForegroundWindow restrictions
    let alt_input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_MENU,
                wScan: 0,
                dwFlags: KEYBD_EVENT_FLAGS(0), // KEYDOWN
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let alt_up_input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_MENU,
                wScan: 0,
                dwFlags: KEYEVENTF_KEYUP,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };

    // Send ALT to unlock foreground window restrictions
    SendInput(&[alt_input, alt_up_input], std::mem::size_of::<INPUT>() as i32);

    // Set the target window to foreground
    if SetForegroundWindow(hwnd).as_bool() {
        log::info!("Successfully set foreground window");
    } else {
        log::warn!("Failed to set foreground window");
    }
    let _ = BringWindowToTop(hwnd);

    // Small delay for focus to take effect
    std::thread::sleep(std::time::Duration::from_millis(50));

    // Create Ctrl+V input sequence
    let ctrl_down = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_CONTROL,
                wScan: 0,
                dwFlags: KEYBD_EVENT_FLAGS(0),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let v_down = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_V,
                wScan: 0,
                dwFlags: KEYBD_EVENT_FLAGS(0),
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let v_up = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_V,
                wScan: 0,
                dwFlags: KEYEVENTF_KEYUP,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };
    let ctrl_up = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_CONTROL,
                wScan: 0,
                dwFlags: KEYEVENTF_KEYUP,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    };

    // Send Ctrl+V
    let inputs = [ctrl_down, v_down, v_up, ctrl_up];
    let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);

    if sent as usize == inputs.len() {
        log::info!("Successfully sent Ctrl+V to paste");
    } else {
        log::warn!("SendInput only sent {} of {} keystrokes", sent, inputs.len());
    }
}

/// Read image file and return as base64 for display
#[tauri::command]
pub fn read_image_file_as_base64(path: String) -> Result<String, String> {
    // Read image file
    let image_data = std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;

    // Detect mime type from file extension
    let mime_type = if path.to_lowercase().ends_with(".png") {
        "image/png"
    } else if path.to_lowercase().ends_with(".jpg") || path.to_lowercase().ends_with(".jpeg") {
        "image/jpeg"
    } else if path.to_lowercase().ends_with(".gif") {
        "image/gif"
    } else if path.to_lowercase().ends_with(".webp") {
        "image/webp"
    } else if path.to_lowercase().ends_with(".bmp") {
        "image/bmp"
    } else {
        "image/png" // default
    };

    // Convert to base64
    let base64_str = BASE64.encode(&image_data);
    Ok(format!("data:{};base64,{}", mime_type, base64_str))
}
