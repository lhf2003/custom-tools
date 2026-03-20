/// Open URL in system default browser
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    open::that(&url).map_err(|e| format!("Failed to open URL: {}", e))
}

/// Save a base64-encoded PNG image to the user's Downloads folder
#[tauri::command]
pub fn save_image_to_downloads(base64_data: String, filename: String) -> Result<String, String> {
    use base64::{engine::general_purpose, Engine as _};

    let bytes = general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| format!("base64 解码失败: {}", e))?;

    let download_dir = dirs::download_dir()
        .ok_or_else(|| "无法获取下载目录".to_string())?;

    let file_path = download_dir.join(&filename);

    std::fs::write(&file_path, &bytes)
        .map_err(|e| format!("文件写入失败: {}", e))?;

    Ok(file_path.to_string_lossy().to_string())
}
