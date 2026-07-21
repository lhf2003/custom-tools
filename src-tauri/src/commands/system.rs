/// Open URL in system default browser
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| format!("Failed to open URL: {}", e))
}

/// Save a base64-encoded PNG image to a caller-specified file path
#[tauri::command]
pub fn save_image_to_path(base64_data: String, path: String) -> Result<(), String> {
    use base64::{engine::general_purpose, Engine as _};

    log::info!(
        "[save_image_to_path] Received base64_data length: {}",
        base64_data.len()
    );
    log::info!("[save_image_to_path] Target path: {}", path);

    let bytes = general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| {
            log::error!("[save_image_to_path] base64 decode failed: {}", e);
            format!("base64 解码失败: {}", e)
        })?;

    log::info!("[save_image_to_path] Decoded {} bytes", bytes.len());

    std::fs::write(&path, &bytes).map_err(|e| {
        log::error!("[save_image_to_path] File write failed: {}", e);
        format!("文件写入失败: {}", e)
    })?;

    log::info!("[save_image_to_path] File saved successfully");
    Ok(())
}
