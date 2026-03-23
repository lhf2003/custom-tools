use anyhow::{anyhow, Result};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use once_cell::sync::Lazy;
use lru::LruCache;
use xxhash_rust::xxh3::xxh3_64;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

const ICON_SIZE: i32 = 256;  // 高清图标尺寸

const MEMORY_CACHE_SIZE: usize = 100;
const DISK_CACHE_DAYS: u64 = 7;

/// 内存缓存: (path_hash, mod_time) -> base64_png
static MEMORY_CACHE: Lazy<Mutex<LruCache<(u64, u64), String>>> =
    Lazy::new(|| Mutex::new(LruCache::new(MEMORY_CACHE_SIZE.try_into().unwrap())));

/// 获取磁盘缓存目录
fn get_cache_dir() -> Result<PathBuf> {
    let app_data = dirs::data_local_dir()
        .ok_or_else(|| anyhow!("Failed to get local data dir"))?
        .join("custom-tools")
        .join("icon-cache");

    if !app_data.exists() {
        fs::create_dir_all(&app_data)?;
    }

    Ok(app_data)
}

/// 计算文件路径和修改时间的哈希
fn compute_cache_key(path: &str, mod_time: u64) -> String {
    let hash = xxh3_64(format!("{}:{}", path, mod_time).as_bytes());
    format!("{:016x}", hash)
}

/// 获取文件的修改时间
fn get_file_mod_time(path: &str) -> Result<u64> {
    let metadata = fs::metadata(path)?;
    let mod_time = metadata.modified()?;
    let duration = mod_time.duration_since(std::time::UNIX_EPOCH)?;
    Ok(duration.as_secs())
}

/// 检查磁盘缓存是否有效（7天内）
fn is_disk_cache_valid(cache_path: &Path) -> bool {
    if !cache_path.exists() {
        return false;
    }

    match fs::metadata(cache_path) {
        Ok(metadata) => {
            if let Ok(modified) = metadata.modified() {
                if let Ok(elapsed) = modified.elapsed() {
                    return elapsed.as_secs() < DISK_CACHE_DAYS * 24 * 60 * 60;
                }
            }
        }
        Err(_) => return false,
    }

    false
}

/// 从磁盘缓存读取
fn read_disk_cache(cache_key: &str) -> Result<String> {
    let cache_dir = get_cache_dir()?;
    let cache_path = cache_dir.join(format!("{}.png", cache_key));

    if !is_disk_cache_valid(&cache_path) {
        return Err(anyhow!("Cache expired or not found"));
    }

    let data = fs::read(&cache_path)?;
    let base64_str = BASE64.encode(&data);
    Ok(format!("data:image/png;base64,{}", base64_str))
}

/// 写入磁盘缓存
fn write_disk_cache(cache_key: &str, png_data: &[u8]) -> Result<()> {
    let cache_dir = get_cache_dir()?;
    let cache_path = cache_dir.join(format!("{}.png", cache_key));
    fs::write(cache_path, png_data)?;
    Ok(())
}

/// 提取图标主入口
#[cfg(windows)]
pub fn extract_icon(path: &str) -> Result<Option<String>> {
    // 1. 获取文件修改时间
    let mod_time = get_file_mod_time(path).unwrap_or_default();

    let path_hash = xxh3_64(path.as_bytes());

    // 2. 检查内存缓存
    {
        let mut cache = MEMORY_CACHE.lock().map_err(|e| anyhow!("Lock error: {}", e))?;
        if let Some(cached) = cache.get(&(path_hash, mod_time)) {
            log::debug!("Icon memory cache hit: {}", path);
            return Ok(Some(cached.clone()));
        }
    }

    // 3. 检查磁盘缓存
    let cache_key = compute_cache_key(path, mod_time);
    if let Ok(cached) = read_disk_cache(&cache_key) {
        log::debug!("Icon disk cache hit: {}", path);
        // 回填内存缓存
        let mut cache = MEMORY_CACHE.lock().map_err(|e| anyhow!("Lock error: {}", e))?;
        cache.put((path_hash, mod_time), cached.clone());
        return Ok(Some(cached));
    }

    // 4. 实时提取图标
    log::debug!("Extracting icon: {}", path);
    let png_data = extract_icon_to_png(path)?;

    if png_data.is_empty() {
        return Ok(None);
    }

    // 5. 写入缓存
    let base64_str = format!("data:image/png;base64,{}", BASE64.encode(&png_data));

    // 写入磁盘缓存
    if let Err(e) = write_disk_cache(&cache_key, &png_data) {
        log::warn!("Failed to write disk cache: {}", e);
    }

    // 写入内存缓存
    {
        let mut cache = MEMORY_CACHE.lock().map_err(|e| anyhow!("Lock error: {}", e))?;
        cache.put((path_hash, mod_time), base64_str.clone());
    }

    Ok(Some(base64_str))
}

#[cfg(not(windows))]
pub fn extract_icon(_path: &str) -> Result<Option<String>> {
    Ok(None)
}

/// 提取图标主入口：尝试 IShellItemImageFactory，失败则回退到 ExtractIconExW
#[cfg(windows)]
fn extract_icon_to_png(path: &str) -> Result<Vec<u8>> {
    // 优先使用 IShellItemImageFactory 获取 256x256 高清图标
    match extract_icon_highres(path) {
        Ok(data) => Ok(data),
        Err(e) => {
            log::debug!("Highres icon extraction failed: {}, falling back", e);
            extract_icon_fallback(path)
        }
    }
}

/// 使用 IShellItemImageFactory 获取 256x256 高清图标
#[cfg(windows)]
fn extract_icon_highres(path: &str) -> Result<Vec<u8>> {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{SHCreateItemFromParsingName, IShellItemImageFactory, SIIGBF_RESIZETOFIT};
    use windows::Win32::Graphics::Gdi::{HBITMAP, DeleteObject};
    use windows::core::PCWSTR;

    let path_wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        // 初始化 COM
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        // 创建 ShellItem 并获取 IShellItemImageFactory 接口
        let image_factory: IShellItemImageFactory = SHCreateItemFromParsingName(
            PCWSTR(path_wide.as_ptr()),
            None,
        )?;

        // 请求 256x256 图标
        let size = ICON_SIZE;
        let hbitmap: HBITMAP = image_factory.GetImage(
            windows::Win32::Foundation::SIZE { cx: size, cy: size },
            SIIGBF_RESIZETOFIT,
        )?;

        // 将 HBITMAP 转为 PNG
        let png_data = hbitmap_to_png(hbitmap)?;

        // 清理
        let _ = DeleteObject(hbitmap.into());

        Ok(png_data)
    }
}

/// 后备方案：使用 ExtractIconExW 获取图标
#[cfg(windows)]
fn extract_icon_fallback(path: &str) -> Result<Vec<u8>> {
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC,
        BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, BITMAP,
        GetObjectW,
    };
    use windows::Win32::UI::Shell::ExtractIconExW;
    use windows::Win32::UI::WindowsAndMessaging::{
        DestroyIcon, GetIconInfo, HICON, ICONINFO,
    };
    use windows::core::PCWSTR;

    let path_wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        // 1. 获取图标数量
        let icon_count = ExtractIconExW(
            PCWSTR(path_wide.as_ptr()),
            -1,
            None,
            None,
            0,
        );

        if icon_count == 0 {
            return extract_icon_shgetfileinfo(path);
        }

        // 2. 提取大图标
        let mut hicon: HICON = HICON(std::ptr::null_mut());
        let extracted = ExtractIconExW(
            PCWSTR(path_wide.as_ptr()),
            0,
            Some(&mut hicon),
            None,
            1,
        );

        if extracted == 0 || hicon.0.is_null() {
            return extract_icon_shgetfileinfo(path);
        }

        // 3. 获取图标信息
        let mut icon_info: ICONINFO = std::mem::zeroed();
        if GetIconInfo(hicon, &mut icon_info).is_err() {
            let _ = DestroyIcon(hicon);
            return extract_icon_shgetfileinfo(path);
        }

        // 4. 创建内存 DC
        let hdc_screen = GetDC(None);
        let hdc_mem = CreateCompatibleDC(Some(hdc_screen));

        if hdc_mem.is_invalid() {
            let _ = DeleteObject(icon_info.hbmMask.into());
            let _ = DeleteObject(icon_info.hbmColor.into());
            let _ = DestroyIcon(hicon);
            let _ = ReleaseDC(None, hdc_screen);
            return Err(anyhow!("Failed to create memory DC"));
        }

        // 5. 获取图标位图尺寸
        let mut bmp: BITMAP = std::mem::zeroed();
        GetObjectW(
            icon_info.hbmColor.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut _ as *mut _),
        );

        let width = bmp.bmWidth;
        let height = bmp.bmHeight;

        // 6. 设置 BITMAPINFO 提取 RGBA 数据
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [std::mem::zeroed(); 1],
        };

        // 7. 提取位图数据
        let buf_size = (width * height * 4) as usize;
        let mut buffer: Vec<u8> = vec![0; buf_size];

        let bits_copied = GetDIBits(
            hdc_mem,
            icon_info.hbmColor,
            0,
            height as u32,
            Some(buffer.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        // 8. 清理资源
        let _ = DeleteDC(hdc_mem);
        let _ = DeleteObject(icon_info.hbmMask.into());
        let _ = DeleteObject(icon_info.hbmColor.into());
        let _ = DestroyIcon(hicon);
        let _ = ReleaseDC(None, hdc_screen);

        if bits_copied == 0 {
            return Err(anyhow!("Failed to get DIBits"));
        }

        // 9. BGRA -> RGBA 转换
        for chunk in buffer.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }

        // 10. 转为 PNG
        let img = image::ImageBuffer::<image::Rgba<u8>, _>::from_raw(
            width as u32,
            height.unsigned_abs(),
            buffer,
        ).ok_or_else(|| anyhow!("Failed to create image buffer"))?;

        let mut png_data = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png_data), image::ImageFormat::Png)?;

        Ok(png_data)
    }
}

/// 将 HBITMAP 转换为 PNG 数据（使用 image crate）
#[cfg(windows)]
fn hbitmap_to_png(hbitmap: windows::Win32::Graphics::Gdi::HBITMAP) -> Result<Vec<u8>> {
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, GetDC, GetDIBits, ReleaseDC,
        BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, BITMAP, GetObjectW,
    };

    unsafe {
        let hdc_screen = GetDC(None);
        let hdc_mem = CreateCompatibleDC(Some(hdc_screen));

        // 获取位图信息
        let mut bmp: BITMAP = std::mem::zeroed();
        GetObjectW(
            hbitmap.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut _ as *mut _),
        );

        let width = bmp.bmWidth;
        let height = bmp.bmHeight.abs();

        // 准备 BITMAPINFO
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height, // 负数表示从上到下
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [std::mem::zeroed(); 1],
        };

        // 提取像素数据
        let buf_size = (width * height * 4) as usize;
        let mut buffer: Vec<u8> = vec![0; buf_size];

        GetDIBits(
            hdc_mem,
            hbitmap,
            0,
            height as u32,
            Some(buffer.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        // 清理
        let _ = DeleteDC(hdc_mem);
        let _ = ReleaseDC(None, hdc_screen);

        // BGRA -> RGBA
        for chunk in buffer.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }

        // 转为 PNG
        let img = image::ImageBuffer::<image::Rgba<u8>, _>::from_raw(
            width as u32,
            height as u32,
            buffer,
        ).ok_or_else(|| anyhow!("Failed to create image buffer"))?;

        let mut png_data = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png_data), image::ImageFormat::Png)?;

        Ok(png_data)
    }
}

/// 后备方案：使用 SHGetFileInfo 提取图标
#[cfg(windows)]
fn extract_icon_shgetfileinfo(path: &str) -> Result<Vec<u8>> {
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC,
        SelectObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
    };
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, DrawIconEx, GetIconInfo, ICONINFO, DI_NORMAL};
    use windows::core::PCWSTR;

    let path_wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        // 获取图标
        let mut shfi: windows::Win32::UI::Shell::SHFILEINFOW = std::mem::zeroed();
        let result = SHGetFileInfoW(
            PCWSTR(path_wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut shfi),
            std::mem::size_of::<windows::Win32::UI::Shell::SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );

        if result == 0 || shfi.hIcon.0.is_null() {
            return Err(anyhow!("SHGetFileInfo failed"));
        }

        let hicon = shfi.hIcon;

        // 获取图标信息
        let mut icon_info: ICONINFO = std::mem::zeroed();
        if GetIconInfo(hicon, &mut icon_info).is_err() {
            let _ = DestroyIcon(hicon);
            return Err(anyhow!("GetIconInfo failed"));
        }

        // 创建内存 DC
        let hdc_screen = GetDC(None);
        let hdc_mem = CreateCompatibleDC(Some(hdc_screen));

        // 创建 48x48 DIB section
        let mut bmi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: ICON_SIZE,
                biHeight: -ICON_SIZE,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0,
                biSizeImage: 0,
                biXPelsPerMeter: 0,
                biYPelsPerMeter: 0,
                biClrUsed: 0,
                biClrImportant: 0,
            },
            bmiColors: [std::mem::zeroed(); 1],
        };

        let mut bits: *mut u8 = std::ptr::null_mut();
        let hbm = windows::Win32::Graphics::Gdi::CreateDIBSection(
            Some(hdc_mem),
            &bmi,
            DIB_RGB_COLORS,
            &mut bits as *mut _ as *mut *mut _,
            None,
            0,
        )?;

        let old_bm = SelectObject(hdc_mem, hbm.into());

        // 绘制图标（缩放到 48x48）
        let _ = DrawIconEx(
            hdc_mem,
            0,
            0,
            hicon,
            ICON_SIZE,
            ICON_SIZE,
            0,
            None,
            DI_NORMAL,
        );

        // 提取像素数据
        let size = (ICON_SIZE * ICON_SIZE * 4) as usize;
        let mut bitmap_data: Vec<u8> = vec![0; size];

        GetDIBits(
            hdc_mem,
            hbm,
            0,
            ICON_SIZE as u32,
            Some(bitmap_data.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        // 清理
        let _ = SelectObject(hdc_mem, old_bm);
        let _ = DeleteObject(hbm.into());
        let _ = DeleteDC(hdc_mem);
        let _ = DeleteObject(icon_info.hbmMask.into());
        let _ = DeleteObject(icon_info.hbmColor.into());
        let _ = DestroyIcon(hicon);
        let _ = ReleaseDC(None, hdc_screen);

        // BGRA -> RGBA
        for chunk in bitmap_data.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }

        // 转为 PNG
        let img = image::ImageBuffer::<image::Rgba<u8>, _>::from_raw(
            ICON_SIZE as u32,
            ICON_SIZE as u32,
            bitmap_data,
        ).ok_or_else(|| anyhow!("Failed to create image buffer"))?;

        let mut png_data = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png_data), image::ImageFormat::Png)?;

        Ok(png_data)
    }
}

/// 清理过期缓存文件
pub fn cleanup_old_cache() -> Result<()> {
    let cache_dir = get_cache_dir()?;
    let entries = fs::read_dir(cache_dir)?;

    let max_age = std::time::Duration::from_secs(DISK_CACHE_DAYS * 24 * 60 * 60);
    let now = std::time::SystemTime::now();

    for entry in entries.flatten() {
        if let Ok(metadata) = entry.metadata() {
            if let Ok(modified) = metadata.modified() {
                if let Ok(age) = now.duration_since(modified) {
                    if age > max_age {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }
        }
    }

    Ok(())
}

/// 获取缓存统计
pub fn get_cache_stats() -> Result<CacheStats> {
    let cache_dir = get_cache_dir()?;
    let mut file_count = 0;
    let mut total_size = 0u64;

    for entry in fs::read_dir(cache_dir)?.flatten() {
        if let Ok(metadata) = entry.metadata() {
            file_count += 1;
            total_size += metadata.len();
        }
    }

    let memory_count = MEMORY_CACHE
        .lock()
        .map(|c| c.len())
        .unwrap_or(0);

    Ok(CacheStats {
        disk_file_count: file_count,
        disk_total_size_bytes: total_size,
        memory_cached_count: memory_count,
    })
}

#[derive(Debug, serde::Serialize)]
pub struct CacheStats {
    pub disk_file_count: usize,
    pub disk_total_size_bytes: u64,
    pub memory_cached_count: usize,
}
