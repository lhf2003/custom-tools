use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Manager, State};

use crate::clipboard::ClipboardSuppressFlag;
use crate::db::DatabaseState;

#[cfg(windows)]
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
#[cfg(windows)]
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
#[cfg(windows)]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MAPVK_VK_TO_VSC, VIRTUAL_KEY, VK_CONTROL, VK_V,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, GetForegroundWindow, GetGUIThreadInfo, GetWindowTextW,
    GetWindowThreadProcessId, GUITHREADINFO, IsWindow, IsWindowVisible, SetForegroundWindow,
};

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
    pub source_exe: Option<String>,
    pub is_favorite: bool,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ClipboardQuery {
    pub content_type: Option<String>,
    pub is_favorite: Option<bool>,
    pub search: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// 按 exe 路径获取应用图标（PNG data URL）。
/// 复用启动器图标链路（IShellItemImageFactory 高清提取 + 内存/磁盘缓存）。
#[tauri::command]
pub fn get_app_icon(exe_path: String) -> Result<Option<String>, String> {
    crate::search::icon::extract_icon(&exe_path).map_err(|e| e.to_string())
}

/// Get clipboard history
#[tauri::command]
pub fn get_clipboard_history(
    db_state: State<DatabaseState>,
    query: ClipboardQuery,
) -> Result<Vec<ClipboardItem>, String> {
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    let search_pattern = query.search.as_ref().map(|s| format!("%{}%", s));
    let limit = query.limit.unwrap_or(50);
    let offset = query.offset.unwrap_or(0);

    let (sql, params_vec) = build_history_query(&query, &search_pattern, &limit, &offset);

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

    let items = stmt
        .query_map(params_vec.as_slice(), |row| {
            Ok(ClipboardItem {
                id: row.get(0)?,
                content: row.get(1)?,
                content_type: row.get(2)?,
                source_app: row.get(3)?,
                source_exe: row.get(4)?,
                is_favorite: row.get::<_, i32>(5)? != 0,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(items)
}

/// 媒体后缀集合（无点号，与前端 src/modules/clipboard/utils.ts 的
/// isImageFile/isAudioFile/isVideoFile 完全一致）。
/// image/audio/video 三个媒体 tab 与 file tab 的排除条件共用，新增后缀只改这里。
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"];
const AUDIO_EXTENSIONS: &[&str] = &["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "opus"];
/// 视频后缀刻意不含 .ts/.mts/.cts——与 TypeScript 源码扩展冲突（开发者剪贴板里
/// 源码出现的概率远高于流媒体分片，误判代价高）；.m2ts 无歧义保留。
const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "rmvb", "rm",
    "3gp", "m2ts",
];

/// 由后缀集合生成 `lower(content) LIKE '%.ext' OR ...` 条件片段（不含外层括号）
fn extension_like_clause(extensions: &[&str]) -> String {
    extensions
        .iter()
        .map(|ext| format!("lower(content) LIKE '%.{}'", ext))
        .collect::<Vec<_>>()
        .join(" OR ")
}

/// 拼接历史查询的 SQL 与有序参数（抽成纯函数以便单测）。
///
/// content_type='image'/'audio'/'video'/'file' 特殊化：
/// 媒体 tab 的语义 = 对应类型 ∪ file 类型中的匹配后缀路径（file tab 则反向排除全部媒体）；
/// 扩展名集合统一取上方常量（与前端 isImageFile/isAudioFile/isVideoFile 一致），
/// 后缀 LIKE 匹配；多路径 content 仅末尾路径参与判断，与前端 endsWith 行为对齐。
/// 合并下推到 SQL 后翻页口径统一，前端不再双查询合并
/// （旧写法 image/file 各查一页再合并截断，offset 口径不一致，会重复/漏条）。
fn build_history_query<'a>(
    query: &'a ClipboardQuery,
    search_pattern: &'a Option<String>,
    limit: &'a i64,
    offset: &'a i64,
) -> (String, Vec<&'a dyn rusqlite::ToSql>) {
    let mut sql = String::from(
        "SELECT id, content, content_type, source_app, source_exe, is_favorite, created_at
         FROM clipboard_history WHERE 1=1",
    );

    let mut param_index = 1;
    let mut params_vec: Vec<&dyn rusqlite::ToSql> = Vec::new();

    if let Some(content_type) = &query.content_type {
        if content_type == "image" {
            // 图片 tab：image 类型 ∪ file 类型中的图片后缀路径
            sql.push_str(&format!(
                " AND (content_type = 'image' OR (content_type = 'file' AND ({})))",
                extension_like_clause(IMAGE_EXTENSIONS)
            ));
        } else if content_type == "audio" {
            // 音频 tab：file 类型中的音频后缀路径
            sql.push_str(&format!(
                " AND (content_type = 'file' AND ({}))",
                extension_like_clause(AUDIO_EXTENSIONS)
            ));
        } else if content_type == "video" {
            // 视频 tab：file 类型中的视频后缀路径
            sql.push_str(&format!(
                " AND (content_type = 'file' AND ({}))",
                extension_like_clause(VIDEO_EXTENSIONS)
            ));
        } else if content_type == "file" {
            // 文件 tab：媒体文件（图片/音频/视频）已有单独分类，这里只留普通文件——
            // 排除全部媒体后缀（多路径 content 按字符串结尾 LIKE 判断，同媒体分支语义）
            let media_likes = [IMAGE_EXTENSIONS, AUDIO_EXTENSIONS, VIDEO_EXTENSIONS]
                .concat()
                .iter()
                .map(|ext| format!("lower(content) LIKE '%.{}'", ext))
                .collect::<Vec<_>>()
                .join(" OR ");
            sql.push_str(&format!(
                " AND content_type = 'file' AND NOT ({})",
                media_likes
            ));
        } else {
            sql.push_str(&format!(" AND content_type = ?{}", param_index));
            params_vec.push(content_type);
            param_index += 1;
        }
    }

    if query.is_favorite.is_some() {
        sql.push_str(&format!(" AND is_favorite = ?{}", param_index));
        params_vec.push(&query.is_favorite);
        param_index += 1;
    }

    if search_pattern.is_some() {
        sql.push_str(&format!(" AND content LIKE ?{}", param_index));
        params_vec.push(search_pattern);
        param_index += 1;
    }

    sql.push_str(&format!(
        " ORDER BY created_at DESC LIMIT ?{} OFFSET ?{}",
        param_index,
        param_index + 1
    ));
    params_vec.push(limit);
    params_vec.push(offset);

    (sql, params_vec)
}

/// Toggle favorite status
#[tauri::command]
pub fn toggle_clipboard_favorite(db_state: State<DatabaseState>, id: i64) -> Result<bool, String> {
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
    let (content_type, content) = get_clipboard_item_for_cleanup(&conn, id)?;

    // Delete from database
    conn.execute("DELETE FROM clipboard_history WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;

    // Cleanup image file if applicable
    cleanup_image_file(&content_type, &content);

    Ok(())
}

/// Clear clipboard history. keep_favorites=true 时仅删除非收藏记录。
/// 同步清理图片文件，并通知前端刷新。返回删除条数。
#[tauri::command]
pub fn clear_clipboard_history(
    db_state: State<DatabaseState>,
    app_handle: tauri::AppHandle,
    keep_favorites: bool,
) -> Result<usize, String> {
    use tauri::Emitter;

    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    // 先收集待删除的图片路径，删库后同步清理文件
    let sql_select = if keep_favorites {
        "SELECT content FROM clipboard_history WHERE content_type = 'image' AND is_favorite = 0"
    } else {
        "SELECT content FROM clipboard_history WHERE content_type = 'image'"
    };
    let mut stmt = conn.prepare(sql_select).map_err(|e| e.to_string())?;
    let image_paths: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let deleted = if keep_favorites {
        conn.execute("DELETE FROM clipboard_history WHERE is_favorite = 0", [])
    } else {
        conn.execute("DELETE FROM clipboard_history", [])
    }
    .map_err(|e| e.to_string())?;

    for path in image_paths {
        cleanup_image_file("image", &path);
    }

    let _ = app_handle.emit("clipboard-updated", ());

    Ok(deleted)
}

/// Export clipboard history to a JSON file. 返回导出条数。
#[tauri::command]
pub fn export_clipboard_history(
    db_state: State<DatabaseState>,
    path: String,
) -> Result<usize, String> {
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT id, content, content_type, source_app, source_exe, is_favorite, created_at
             FROM clipboard_history ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let items = stmt
        .query_map([], |row| {
            Ok(ClipboardItem {
                id: row.get(0)?,
                content: row.get(1)?,
                content_type: row.get(2)?,
                source_app: row.get(3)?,
                source_exe: row.get(4)?,
                is_favorite: row.get::<_, i32>(5)? != 0,
                created_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let count = items.len();
    let json = serde_json::to_string_pretty(&items).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;

    Ok(count)
}

/// Copy clipboard item back to clipboard
#[tauri::command]
pub fn copy_to_clipboard(
    db_state: State<DatabaseState>,
    app_handle: tauri::AppHandle,
    suppress_flag: State<ClipboardSuppressFlag>,
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

    // Signal the clipboard watcher to skip the next event (our own write)
    suppress_flag.suppress();

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
                // Writing didn't happen, clear the flag
                suppress_flag.clear();
            }
        }
        "file" => {
            // TODO: Implement file list clipboard write
            log::info!("File list copy not yet implemented");
            // Writing didn't happen, clear the flag
            suppress_flag.clear();
        }
        _ => {
            suppress_flag.clear();
        }
    }

    // Update usage count, last used time, AND created_at to move item to top
    let _ = conn.execute(
        "UPDATE clipboard_history SET usage_count = COALESCE(usage_count, 0) + 1, last_used_at = CURRENT_TIMESTAMP, created_at = CURRENT_TIMESTAMP WHERE id = ?1",
        params![id],
    );

    Ok(())
}

/// Copy partial text to clipboard and save as new history entry
#[tauri::command]
pub fn copy_text_to_clipboard(
    db_state: State<DatabaseState>,
    app_handle: tauri::AppHandle,
    suppress_flag: State<ClipboardSuppressFlag>,
    text: String,
) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;

    // Signal the clipboard watcher to skip the next event (our own write)
    suppress_flag.suppress();

    // Write text to clipboard
    app_handle
        .clipboard()
        .write_text(text.clone())
        .map_err(|e| e.to_string())?;

    // Save the partial text as a new clipboard history entry
    let conn = Connection::open(&db_state.0).map_err(|e| e.to_string())?;

    // Calculate hash for reference (not for deduplication in partial copy)
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    let hash = format!("{:x}", hasher.finalize());

    // Simple INSERT - partial copies always create new entries
    conn.execute(
        "INSERT INTO clipboard_history
         (content, content_type, content_hash, source_app, is_favorite, usage_count, created_at)
         VALUES (?1, 'text', ?2, 'PartialCopy', 0, 1, CURRENT_TIMESTAMP)",
        params![text, hash],
    )
    .map_err(|e| e.to_string())?;

    log::info!(
        "Partial text copied to clipboard ({} chars): {}",
        text.len(),
        if text.len() > 50 { &text[..50] } else { &text }
    );

    Ok(())
}

/// Copy image data to Windows clipboard
#[cfg(windows)]
fn copy_image_to_windows_clipboard(image_data: &[u8]) -> Result<(), String> {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Graphics::Gdi::BITMAPINFOHEADER;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE, GMEM_ZEROINIT,
    };

    unsafe {
        // Open clipboard
        if OpenClipboard(None).is_err() {
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
                *pixel_ptr.add(offset) = pixel[2]; // B
                *pixel_ptr.add(offset + 1) = pixel[1]; // G
                *pixel_ptr.add(offset + 2) = pixel[0]; // R
                *pixel_ptr.add(offset + 3) = pixel[3]; // A
            }
        }

        let _ = GlobalUnlock(hglobal);

        // Set CF_DIB data to clipboard
        // Note: After SetClipboardData succeeds, the system owns the memory and we should not free it
        const CF_DIB: u32 = 8;
        let handle = HANDLE(hglobal.0);
        let result = SetClipboardData(CF_DIB, Some(handle));
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

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

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
    Ok(format!("data:{};base64,{}", mime_type, base64_str))
}

/// Handle pasted file from file system
#[tauri::command]
pub fn handle_pasted_file(db_state: State<DatabaseState>, path: String) -> Result<(), String> {
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

fn handle_pasted_image_file(db_state: State<DatabaseState>, path: &str) -> Result<(), String> {
    // Read image data
    let image_data = std::fs::read(path).map_err(|e| e.to_string())?;

    // Calculate hash
    let mut hasher = Sha256::new();
    hasher.update(&image_data);
    let hash = format!("{:x}", hasher.finalize());

    // Save to app data directory
    let app_dir = dirs::data_dir()
        .ok_or("Failed to get data dir")?
        .join(crate::APP_DIR_NAME)
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
    )
    .map_err(|e| e.to_string())?;

    log::info!("Pasted image file saved: {}", image_path.display());
    Ok(())
}

fn handle_pasted_generic_file(db_state: State<DatabaseState>, path: &str) -> Result<(), String> {
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
    )
    .map_err(|e| e.to_string())?;

    log::info!("Pasted file saved: {}", path);
    Ok(())
}

/// Read clipboard image from backend using Windows API
/// This is necessary because browser Clipboard API cannot access DIB format
#[cfg(windows)]
#[tauri::command]
pub fn read_clipboard_image() -> Result<ClipboardReadResult, String> {
    use windows::Win32::System::DataExchange::{CloseClipboard, OpenClipboard};

    unsafe {
        // Open clipboard (None means current process)
        if OpenClipboard(None).is_err() {
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
            let hglobal = windows::Win32::Foundation::HGLOBAL(handle.0);
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
unsafe fn read_hdrop_data(
    handle: windows::Win32::Foundation::HANDLE,
) -> Result<Vec<String>, String> {
    use windows::Win32::UI::Shell::DragQueryFileW;
    use windows::Win32::UI::Shell::HDROP;

    let hdrop = HDROP(handle.0);
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

    // BITMAPINFOHEADER structure (mirrors Windows API, field names preserved for clarity)
    #[repr(C)]
    #[allow(non_camel_case_types, non_snake_case)]
    struct BitmapInfoHeader {
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

    let header = &*(ptr as *const BitmapInfoHeader);

    let width = header.biWidth as u32;
    let height = header.biHeight.unsigned_abs();
    let bit_count = header.biBitCount as u32;

    if width == 0 || height == 0 {
        return Err("Invalid image dimensions".to_string());
    }

    let row_size = (width * bit_count).div_ceil(32) * 4;

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
    if image_size == 0 || image_size > 100_000_000 {
        // 100MB limit
        return Err(format!("Invalid image size: {}", image_size));
    }

    let pixel_data = slice::from_raw_parts(pixel_data_ptr, image_size);

    // Convert to RGBA
    let mut rgba_data = Vec::with_capacity((width * height * 4) as usize);
    let is_top_down = header.biHeight < 0;

    for y in 0..height {
        let src_y = if is_top_down { y } else { height - 1 - y };
        let row_start = (src_y * row_size) as usize;

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
            .write_to(
                &mut std::io::BufWriter::new(cursor),
                image::ImageFormat::Png,
            )
            .map_err(|e| e.to_string())?;
    }

    let mut hasher = Sha256::new();
    hasher.update(&png_data);
    let hash = format!("{:x}", hasher.finalize());

    // Save to app data directory
    let app_dir = dirs::data_dir()
        .ok_or("Failed to get data dir")?
        .join(crate::APP_DIR_NAME)
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
    )
    .map_err(|e| e.to_string())?;

    log::info!("Screenshot saved: {}", image_path.display());
    Ok(image_path.to_string_lossy().to_string())
}

/// Paste clipboard item to previous focused window
/// This copies the item to clipboard, hides the window, and simulates Ctrl+V
#[tauri::command]
pub async fn paste_to_clipboard_item(
    db_state: State<'_, DatabaseState>,
    app_handle: tauri::AppHandle,
    suppress_flag: State<'_, ClipboardSuppressFlag>,
    id: i64,
) -> Result<(), String> {
    // First copy to clipboard (suppress_flag is forwarded to avoid duplicate history entry)
    copy_to_clipboard(db_state, app_handle.clone(), suppress_flag, id)?;

    // Check if auto-paste is enabled
    let auto_paste_enabled = if let Some(settings_state) =
        app_handle.try_state::<crate::commands::settings::SettingsState>()
    {
        settings_state
            .0
            .lock()
            .map(|mgr| mgr.get_settings().clipboard_auto_paste)
            .unwrap_or(true)
    } else {
        true // Default to enabled if settings not available
    };

    // Get the previous focused window
    log::info!("Attempting to get previous focused window...");
    let prev_hwnd = app_handle
        .try_state::<crate::PreviousFocusedWindow>()
        .and_then(|state| {
            let hwnd = state.get();
            log::info!(
                "PreviousFocusedWindow state found, get() returned: {:?}",
                hwnd
            );
            hwnd
        });

    log::info!("Final prev_hwnd: {:?}", prev_hwnd);

    // Hide the window first
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.hide();
    }

    // If auto-paste is enabled and we have a valid previous window, try to paste
    if auto_paste_enabled {
        if let Some(hwnd) = prev_hwnd {
            log::info!(
                "Auto-paste enabled, attempting to paste to window: {}",
                hwnd
            );
            #[cfg(windows)]
            {
                // 激活+SendInput 含多段 sleep/轮询（最差约 900ms），放进 blocking
                // 线程池执行，避免阻塞主线程事件循环（全局快捷键/其他命令排队）
                let result = tauri::async_runtime::spawn_blocking(move || {
                    // Small delay to ensure window is hidden and target is ready
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    unsafe { simulate_paste_to_window(hwnd) };
                })
                .await;
                if let Err(e) = result {
                    log::error!("Paste simulation task failed to complete: {}", e);
                }
            }
        } else {
            log::info!("No previous focused window available, only copied to clipboard");
        }
    } else {
        log::info!("Auto-paste is disabled, only copied to clipboard");
    }

    Ok(())
}

/// Simulate Ctrl+V keystrokes to paste clipboard content.
///
/// 两个关键技术点（JetBrains IDE 等 Java AWT 应用对无扫描码的注入按键
/// 会直接丢弃，导致粘贴无效）：
/// 1. 所有按键带真实扫描码（MapVirtualKeyW 转换），而非纯虚拟键码
/// 2. 前台激活：ALT trick + AttachThreadInput 兜底，发送前轮询
///    GetForegroundWindow 确认目标窗口真正拿到前台焦点
#[cfg(windows)]
unsafe fn simulate_paste_to_window(target_hwnd: isize) {
    // Validate the window still exists
    let hwnd = HWND(target_hwnd as *mut _);
    if !IsWindow(Some(hwnd)).as_bool() {
        log::warn!("Target window is no longer valid");
        return;
    }

    // Only paste if window is visible (not minimized)
    if !IsWindowVisible(hwnd).as_bool() {
        log::info!("Target window is not visible, skipping paste");
        return;
    }

    // 诊断：确认目标窗口身份（IDEA 多窗口/弹窗场景下句柄可能不是主窗口）
    let mut title_buf = [0u16; 256];
    let title_len = GetWindowTextW(hwnd, &mut title_buf);
    let title = String::from_utf16_lossy(&title_buf[..title_len as usize]);
    log::info!("Paste target: '{}' (hwnd={})", title, target_hwnd);

    // 虚拟键码 → 真实扫描码：纯虚拟键码（wScan=0）的注入按键在
    // Java AWT（JetBrains IDE）里会被丢弃
    let v_scan = MapVirtualKeyW(VK_V.0 as u32, MAPVK_VK_TO_VSC);
    let ctrl_scan = MapVirtualKeyW(VK_CONTROL.0 as u32, MAPVK_VK_TO_VSC);

    // 激活目标窗口。AttachThreadInput（当前线程 ↔ 目标窗口线程）解锁
    // SetForegroundWindow 的前台权限（AHK WinActivate 同款做法）。
    // 不用 ALT trick——注入的 ALT 有残留风险，会让目标应用进入菜单键模式。
    let cur_thread = GetCurrentThreadId();
    let target_thread = GetWindowThreadProcessId(hwnd, None);
    let mut activated = false;
    if target_thread != 0 {
        let _ = AttachThreadInput(cur_thread, target_thread, true);
        activated = SetForegroundWindow(hwnd).as_bool();
        let _ = AttachThreadInput(cur_thread, target_thread, false);
    }
    if !activated {
        activated = SetForegroundWindow(hwnd).as_bool();
    }
    let _ = BringWindowToTop(hwnd);
    if activated {
        log::info!("Successfully set foreground window");
    } else {
        log::warn!("Failed to set foreground window");
    }

    // 轮询确认前台就绪（IDE 激活慢，固定 sleep 可能不够）
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(300);
    while std::time::Instant::now() < deadline {
        if !IsWindow(Some(hwnd)).as_bool() {
            break; // 目标窗口已销毁，停止空转
        }
        if GetForegroundWindow() == hwnd {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    // 检查前台线程的真实键盘焦点。注意不能用 GetFocus——它只返回调用线程的
    // 焦点窗口，本线程无窗口时恒为 0，是假象。GetGUIThreadInfo 才能拿到
    // 前台窗口线程的实际焦点窗口。
    let fg_thread = GetWindowThreadProcessId(GetForegroundWindow(), None);
    let mut gui = GUITHREADINFO {
        cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    let focus_ok = fg_thread != 0
        && GetGUIThreadInfo(fg_thread, &mut gui).is_ok()
        && !gui.hwndFocus.0.is_null();
    log::info!(
        "Paste preflight: foreground={:?}, focus_hwnd={:?}, focus_ok={}",
        GetForegroundWindow(),
        gui.hwndFocus,
        focus_ok
    );

    // 用户级激活（核心步骤，无条件执行）：点击目标窗口标题栏。
    // SetForegroundWindow 编程激活只产生 WM_ACTIVATE(WA_ACTIVE)，
    // Chromium（VS Code）/Java（IDEA）只有在 WA_CLICKACTIVE（鼠标点击激活）
    // 时才恢复内部键盘焦点——所以 Windows 层焦点正确、Ctrl+V 仍会被吞。
    //
    // 激活方式采用消息级标题栏点击：向目标窗口发送 WM_NCLBUTTONDOWN/UP
    // （wParam=HTCAPTION），系统默认处理触发与真实点击相同的 WA_CLICKACTIVE
    // 激活（AHK 类工具的窗口激活标准做法），但鼠标完全不移动——没有飘移，
    // 也不会误触标题栏上的交互控件（浏览器标签页、微信搜索框、控制按钮）。
    // 无真实鼠标按下时系统检测不到左键状态，不会启动窗口拖拽循环。
    send_nclbutton_click(hwnd);
    // 等待目标窗口成为前台（窗口销毁/挂起导致 SendMessageTimeout 超时时
    // 可能失败，Ctrl+V 仍会发出，记 warn 日志便于排查）
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(150);
    while std::time::Instant::now() < deadline {
        if GetForegroundWindow() == hwnd {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    if GetForegroundWindow() != hwnd {
        log::warn!(
            "Title-bar message click did not bring target to foreground; Ctrl+V will go to the current foreground window"
        );
    }

    // 等窗口完成用户级激活与内部焦点恢复（IDE 激活慢，需留出时间）
    std::thread::sleep(std::time::Duration::from_millis(150));

    // Send Ctrl+V（全部带扫描码）
    let inputs = [
        make_key_input(ctrl_scan, KEYEVENTF_SCANCODE),
        make_key_input(v_scan, KEYEVENTF_SCANCODE),
        make_key_input(v_scan, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP),
        make_key_input(ctrl_scan, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP),
    ];
    let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);

    if sent as usize == inputs.len() {
        log::info!("Successfully sent Ctrl+V to paste");
    } else {
        log::warn!(
            "SendInput only sent {} of {} keystrokes",
            sent,
            inputs.len()
        );
    }
}

/// 消息级标题栏点击：向目标窗口发送 WM_NCLBUTTONDOWN/UP（wParam=HTCAPTION）。
/// 窗口走 DefWindowProc 默认处理时会触发与真实点击相同的 WA_CLICKACTIVE 激活，
/// 但鼠标完全不移动——无飘移、不会误触标题栏交互控件（浏览器标签页/微信搜索框）。
/// 无真实鼠标按下时系统检测不到左键状态，不会启动窗口拖拽循环。
/// 激活是否生效由调用方的前台归属检查确认；失败时不回退真实鼠标点击，
/// Ctrl+V 仍会发出（调用方记 warn 日志）。
#[cfg(windows)]
unsafe fn send_nclbutton_click(hwnd: HWND) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HTCAPTION, SMTO_ABORTIFHUNG, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP,
    };
    let mut result = 0usize;
    let _ = SendMessageTimeoutW(
        hwnd,
        WM_NCLBUTTONDOWN,
        WPARAM(HTCAPTION as usize),
        LPARAM(0),
        SMTO_ABORTIFHUNG,
        100,
        Some(&mut result),
    );
    let _ = SendMessageTimeoutW(
        hwnd,
        WM_NCLBUTTONUP,
        WPARAM(HTCAPTION as usize),
        LPARAM(0),
        SMTO_ABORTIFHUNG,
        100,
        Some(&mut result),
    );
}

/// 构造一个带扫描码的键盘输入事件（wVk 置 0，扫描码模式下由 wScan 表达键位）
#[cfg(windows)]
fn make_key_input(scan_code: u32, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(0),
                wScan: scan_code as u16,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
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

/// Internal delete helper that works with just a connection and id
/// Returns the content_type and content for cleanup purposes
fn get_clipboard_item_for_cleanup(conn: &Connection, id: i64) -> Result<(String, String), String> {
    conn.query_row(
        "SELECT content_type, content FROM clipboard_history WHERE id = ?1",
        params![id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    )
    .map_err(|e| e.to_string())
}

/// Delete image file if content_type is image
/// Logs warnings but does not return error on failure
fn cleanup_image_file(content_type: &str, content: &str) {
    if content_type == "image" {
        if let Err(e) = std::fs::remove_file(content) {
            log::warn!("Failed to delete image file '{}': {}", content, e);
        } else {
            log::info!("Deleted image file: {}", content);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;
    use std::path::PathBuf;

    /// Helper function to create a test database connection
    /// 每个测试使用独立的临时目录，避免并行测试共享同一数据库文件导致主键冲突
    fn create_test_db() -> (Connection, PathBuf) {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let unique = COUNTER.fetch_add(1, Ordering::SeqCst);
        let temp_dir =
            env::temp_dir().join(format!("clipboard_test_{}_{}", std::process::id(), unique));
        fs::create_dir_all(&temp_dir).unwrap();
        let db_path = temp_dir.join("test.db");

        // Create the clipboard_history table
        let conn = Connection::open(&db_path).unwrap();
        conn.execute(
            "CREATE TABLE IF NOT EXISTS clipboard_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL,
                content_type TEXT NOT NULL,
                content_hash TEXT UNIQUE,
                source_app TEXT,
                source_exe TEXT,
                is_favorite INTEGER DEFAULT 0,
                usage_count INTEGER DEFAULT 0,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                last_used_at TEXT
            )",
            [],
        )
        .unwrap();

        (conn, temp_dir)
    }

    #[test]
    fn test_build_history_query_image_merges_image_files() {
        let query = ClipboardQuery {
            content_type: Some("image".to_string()),
            is_favorite: None,
            search: None,
            limit: Some(100),
            offset: Some(0),
        };
        let search_pattern = None;
        let limit = 100_i64;
        let offset = 0_i64;

        let (sql, params) = build_history_query(&query, &search_pattern, &limit, &offset);

        assert!(sql.contains("content_type = 'image' OR"));
        assert!(sql.contains("content_type = 'file'"));
        assert!(sql.contains("lower(content) LIKE '%.png'"));
        assert!(sql.contains("lower(content) LIKE '%.svg'"));
        // image 分支走字面值、不占参数位：参数只剩 limit/offset
        assert_eq!(params.len(), 2);
    }

    #[test]
    fn test_build_history_query_audio_filters_file_extensions() {
        let query = ClipboardQuery {
            content_type: Some("audio".to_string()),
            is_favorite: None,
            search: None,
            limit: Some(100),
            offset: Some(0),
        };
        let (sql, params) = build_history_query(&query, &None, &100, &0);

        assert!(sql.contains("content_type = 'file'"));
        assert!(sql.contains("lower(content) LIKE '%.mp3'"));
        assert!(sql.contains("lower(content) LIKE '%.opus'"));
        assert!(!sql.contains("'image'"));
        // audio 分支走字面值、不占参数位
        assert_eq!(params.len(), 2);
    }

    #[test]
    fn test_build_history_query_video_filters_file_extensions() {
        let query = ClipboardQuery {
            content_type: Some("video".to_string()),
            is_favorite: None,
            search: None,
            limit: Some(100),
            offset: Some(0),
        };
        let (sql, params) = build_history_query(&query, &None, &100, &0);

        assert!(sql.contains("content_type = 'file'"));
        assert!(sql.contains("lower(content) LIKE '%.mp4'"));
        assert!(sql.contains("lower(content) LIKE '%.m2ts'"));
        // 视频分支不含与 TypeScript 源码冲突的扩展
        assert!(!sql.contains("LIKE '%.ts'"));
        assert!(!sql.contains("LIKE '%.mts'"));
        assert_eq!(params.len(), 2);
    }

    #[test]
    fn test_build_history_query_file_excludes_media_extensions() {
        let query = ClipboardQuery {
            content_type: Some("file".to_string()),
            is_favorite: None,
            search: None,
            limit: Some(100),
            offset: Some(0),
        };
        let (sql, params) = build_history_query(&query, &None, &100, &0);

        // 文件 tab 排除有单独分类的媒体：图片/音频/视频后缀
        assert!(sql.contains("content_type = 'file' AND NOT"));
        assert!(sql.contains("LIKE '%.png'"));
        assert!(sql.contains("LIKE '%.mp3'"));
        assert!(sql.contains("LIKE '%.mp4'"));
        assert!(sql.contains("LIKE '%.m2ts'"));
        // 视频排除集合同样不含与 TS 源码冲突的扩展
        assert!(!sql.contains("LIKE '%.ts'"));
        // 普通文件后缀不被排除
        assert!(!sql.contains("LIKE '%.xlsx'"));
        // file 分支走字面值、不占参数位
        assert_eq!(params.len(), 2);
    }

    #[test]
    fn test_build_history_query_sql_executes_on_real_db() {
        let (conn, _temp) = create_test_db();
        // 所有分类分支的 SQL 在真实库上执行——防字符串断言放过括号/字面量错误
        // （曾出现 file 分支多一个右括号导致「获取剪贴板历史失败」，contains 断言全部通过）
        for ct in ["all", "text", "image", "audio", "video", "file", "favorite"] {
            let query = ClipboardQuery {
                content_type: (ct != "all" && ct != "favorite").then(|| ct.to_string()),
                is_favorite: (ct == "favorite").then_some(true),
                search: None,
                limit: Some(100),
                offset: Some(0),
            };
            let (sql, params) = build_history_query(&query, &None, &100, &0);
            conn.execute(&sql, rusqlite::params_from_iter(params))
                .unwrap_or_else(|e| panic!("分类 {ct} 的 SQL 执行失败: {e}\n{sql}"));
        }
    }

    #[test]
    fn test_build_history_query_filters_and_param_order() {
        let query = ClipboardQuery {
            content_type: Some("text".to_string()),
            is_favorite: Some(true),
            search: Some("foo".to_string()),
            limit: Some(100),
            offset: Some(200),
        };
        let search_pattern = Some("%foo%".to_string());
        let limit = 100_i64;
        let offset = 200_i64;

        let (sql, params) = build_history_query(&query, &search_pattern, &limit, &offset);

        assert!(sql.contains("AND content_type = ?1"));
        assert!(sql.contains("AND is_favorite = ?2"));
        assert!(sql.contains("AND content LIKE ?3"));
        assert!(sql.contains("LIMIT ?4 OFFSET ?5"));
        assert_eq!(params.len(), 5);
    }

    #[test]
    fn test_cleanup_image_file_deletes_file() {
        let temp_dir = env::temp_dir().join("clipboard_cleanup_test");
        fs::create_dir_all(&temp_dir).unwrap();
        let image_path = temp_dir.join("test_image.png");
        fs::write(&image_path, "fake image data").unwrap();
        assert!(image_path.exists());

        // Cleanup should delete the file
        cleanup_image_file("image", image_path.to_str().unwrap());

        assert!(!image_path.exists(), "Image file should be deleted");

        // Cleanup temp dir
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_cleanup_image_file_nonexistent_no_panic() {
        // Should not panic when file doesn't exist
        cleanup_image_file("image", "/nonexistent/path/image.png");
    }

    #[test]
    fn test_cleanup_image_file_skips_non_image() {
        let temp_dir = env::temp_dir().join("clipboard_cleanup_test2");
        fs::create_dir_all(&temp_dir).unwrap();
        let file_path = temp_dir.join("some_file.txt");
        fs::write(&file_path, "some text").unwrap();
        assert!(file_path.exists());

        // Cleanup should skip non-image types
        cleanup_image_file("text", file_path.to_str().unwrap());

        // File should still exist
        assert!(file_path.exists(), "Non-image file should not be deleted");

        // Cleanup temp dir
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_get_clipboard_item_for_cleanup() {
        let (conn, _temp_dir) = create_test_db();

        // Insert a test record
        conn.execute(
            "INSERT INTO clipboard_history (content, content_type, content_hash, source_app)
             VALUES ('/path/to/image.png', 'image', 'test_hash', 'TestApp')",
            [],
        )
        .unwrap();

        let id: i64 = conn
            .query_row(
                "SELECT id FROM clipboard_history WHERE content_hash = 'test_hash'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        // Get item for cleanup
        let (content_type, content) = get_clipboard_item_for_cleanup(&conn, id).unwrap();
        assert_eq!(content_type, "image");
        assert_eq!(content, "/path/to/image.png");
    }

    #[test]
    fn test_delete_clipboard_item_integration() {
        let (conn, temp_dir) = create_test_db();

        // Create a test image file
        let image_dir = temp_dir.join("clipboard-images");
        fs::create_dir_all(&image_dir).unwrap();
        let image_path = image_dir.join("test_image.png");
        fs::write(&image_path, "fake image data").unwrap();
        assert!(image_path.exists());

        // Insert an image record
        conn.execute(
            "INSERT INTO clipboard_history (content, content_type, content_hash, source_app)
             VALUES (?1, 'image', 'test_hash', 'TestApp')",
            params![image_path.to_string_lossy().to_string()],
        )
        .unwrap();

        let id: i64 = conn
            .query_row(
                "SELECT id FROM clipboard_history WHERE content_hash = 'test_hash'",
                [],
                |row| row.get(0),
            )
            .unwrap();

        // Get item info before deletion
        let (content_type, content) = get_clipboard_item_for_cleanup(&conn, id).unwrap();

        // Delete from database
        conn.execute("DELETE FROM clipboard_history WHERE id = ?1", params![id])
            .unwrap();

        // Cleanup image file
        cleanup_image_file(&content_type, &content);

        // Verify the image file was deleted
        assert!(!image_path.exists(), "Image file should be deleted");

        // Verify database record is gone
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM clipboard_history WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "Database record should be deleted");
    }

    #[test]
    fn test_cleanup_old_items_by_age_deletes_image_files() {
        let (conn, temp_dir) = create_test_db();

        // Create test image files
        let image_dir = temp_dir.join("clipboard-images");
        fs::create_dir_all(&image_dir).unwrap();
        let old_image_path = image_dir.join("old_image.png");
        let recent_image_path = image_dir.join("recent_image.png");
        fs::write(&old_image_path, "old image data").unwrap();
        fs::write(&recent_image_path, "recent image data").unwrap();

        // Insert an old record (31 days ago)
        conn.execute(
            "INSERT INTO clipboard_history (content, content_type, content_hash, source_app, created_at)
             VALUES (?1, 'image', 'old_hash', 'TestApp', datetime('now', '-31 days'))",
            params![old_image_path.to_string_lossy().to_string()],
        ).unwrap();

        // Insert a recent record (1 day ago)
        conn.execute(
            "INSERT INTO clipboard_history (content, content_type, content_hash, source_app, created_at)
             VALUES (?1, 'image', 'recent_hash', 'TestApp', datetime('now', '-1 day'))",
            params![recent_image_path.to_string_lossy().to_string()],
        ).unwrap();

        // Collect image paths for items older than 30 days
        let mut stmt = conn
            .prepare("SELECT content FROM clipboard_history WHERE content_type = 'image' AND created_at < datetime('now', '-30 days')")
            .unwrap();
        let image_paths: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        // Delete old items (simulating cleanup_old_items behavior)
        let deleted = conn
            .execute(
                "DELETE FROM clipboard_history WHERE created_at < datetime('now', '-30 days')",
                [],
            )
            .unwrap();

        assert_eq!(deleted, 1, "Should delete 1 old item");

        // Cleanup image files
        for path in image_paths {
            cleanup_image_file("image", &path);
        }

        // Verify old image file was deleted
        assert!(!old_image_path.exists(), "Old image file should be deleted");
        // Verify recent image file still exists
        assert!(
            recent_image_path.exists(),
            "Recent image file should not be deleted"
        );
    }

    #[test]
    fn test_cleanup_old_items_by_limit_deletes_image_files() {
        let (conn, temp_dir) = create_test_db();

        // Create test image files
        let image_dir = temp_dir.join("clipboard-images");
        fs::create_dir_all(&image_dir).unwrap();

        // Create 3 image files
        let image_path1 = image_dir.join("image1.png");
        let image_path2 = image_dir.join("image2.png");
        let image_path3 = image_dir.join("image3.png");
        fs::write(&image_path1, "image data 1").unwrap();
        fs::write(&image_path2, "image data 2").unwrap();
        fs::write(&image_path3, "image data 3").unwrap();

        // Insert 3 records with explicit IDs (1 = oldest, 3 = newest)
        conn.execute(
            "INSERT INTO clipboard_history (id, content, content_type, content_hash, source_app, created_at)
             VALUES (1, ?1, 'image', 'hash1', 'TestApp', datetime('now', '-3 days'))",
            params![image_path1.to_string_lossy().to_string()],
        ).unwrap();
        conn.execute(
            "INSERT INTO clipboard_history (id, content, content_type, content_hash, source_app, created_at)
             VALUES (2, ?1, 'image', 'hash2', 'TestApp', datetime('now', '-2 days'))",
            params![image_path2.to_string_lossy().to_string()],
        ).unwrap();
        conn.execute(
            "INSERT INTO clipboard_history (id, content, content_type, content_hash, source_app, created_at)
             VALUES (3, ?1, 'image', 'hash3', 'TestApp', datetime('now', '-1 day'))",
            params![image_path3.to_string_lossy().to_string()],
        ).unwrap();

        // Get the oldest record (id = 1)
        let mut stmt = conn
            .prepare("SELECT content FROM clipboard_history WHERE id = 1")
            .unwrap();
        let paths_to_delete: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        // Delete the oldest record
        let deleted = conn
            .execute("DELETE FROM clipboard_history WHERE id = 1", [])
            .unwrap();

        assert_eq!(deleted, 1, "Should delete 1 oldest item");

        // Cleanup image files
        for path in paths_to_delete {
            cleanup_image_file("image", &path);
        }

        // Verify oldest image file was deleted
        assert!(
            !image_path1.exists(),
            "Oldest image (id=1) should be deleted"
        );
        // Verify other image files still exist
        assert!(image_path2.exists(), "Image id=2 should exist");
        assert!(image_path3.exists(), "Image id=3 should exist");
    }
}
