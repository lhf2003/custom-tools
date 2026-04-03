use tauri::{Manager, Emitter};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_updater::UpdaterExt;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::time::Duration;

/// 获取当前鼠标位置（Windows API）
#[cfg(target_os = "windows")]
pub fn get_cursor_pos() -> Option<(i32, i32)> {
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    use windows::Win32::Foundation::POINT;

    unsafe {
        let mut point = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut point).is_ok() {
            Some((point.x, point.y))
        } else {
            None
        }
    }
}

/// 获取当前鼠标位置（非 Windows 平台返回 None）
#[cfg(not(target_os = "windows"))]
pub fn get_cursor_pos() -> Option<(i32, i32)> {
    None
}

/// 根据鼠标位置找到对应的显示器
#[cfg(target_os = "windows")]
pub fn get_monitor_at_cursor(app_handle: &tauri::AppHandle) -> Option<tauri::Monitor> {
    let cursor_pos = get_cursor_pos()?;
    let monitors = app_handle.available_monitors().ok()?;

    for monitor in monitors {
        let pos = monitor.position();
        let size = monitor.size();

        // 检查鼠标是否在此显示器范围内
        let in_x_range = cursor_pos.0 >= pos.x && cursor_pos.0 < pos.x + size.width as i32;
        let in_y_range = cursor_pos.1 >= pos.y && cursor_pos.1 < pos.y + size.height as i32;

        if in_x_range && in_y_range {
            return Some(monitor);
        }
    }

    // 如果没找到，返回主显示器
    app_handle.primary_monitor().ok().flatten()
}

/// 非 Windows 平台：直接返回主显示器
#[cfg(not(target_os = "windows"))]
pub fn get_monitor_at_cursor(app_handle: &tauri::AppHandle) -> Option<tauri::Monitor> {
    app_handle.primary_monitor().ok().flatten()
}

/// Windows 窗口效果类型
#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy)]
pub enum WindowEffect {
    /// Mica - Windows 11 原生效果（推荐）
    Mica,
    /// Acrylic - Windows 10 v1903+ / Windows 11（但有兼容性问题）
    Acrylic,
    /// Blur - 旧版 Windows 后备方案
    Blur,
    /// 无效果 - 纯 CSS 兜底
    None,
}

#[cfg(target_os = "windows")]
impl WindowEffect {
    /// 根据 Windows 版本选择最佳效果
    pub fn from_windows_version(major: u64, _minor: u64, build: u64) -> Self {
        match (major, build) {
            // Windows 11 (build 22000+)
            // 使用 Mica，因为它在 Win11 上最稳定
            (10, build) if build >= 22000 => WindowEffect::Mica,

            // Windows 10 v1903+ (build 18362+)
            // Acrylic 在 Win10 上工作正常
            (10, build) if build >= 18362 => WindowEffect::Acrylic,

            // Windows 7/8/8.1 或更旧的 Win10
            // 使用简单的 Blur 效果
            _ => WindowEffect::Blur,
        }
    }

    /// 获取效果名称（用于日志）
    pub fn name(&self) -> &'static str {
        match self {
            WindowEffect::Mica => "Mica",
            WindowEffect::Acrylic => "Acrylic",
            WindowEffect::Blur => "Blur",
            WindowEffect::None => "None",
        }
    }
}

/// 应用窗口效果，带降级策略
#[cfg(target_os = "windows")]
pub fn apply_window_effect(
    window: &tauri::WebviewWindow,
    effect: WindowEffect,
) -> Result<(), Box<dyn std::error::Error>> {
    match effect {
        WindowEffect::Mica => {
            // 尝试应用 Mica 效果
            match window_vibrancy::apply_mica(window, Some(true)) {
                Ok(_) => {
                    log::info!("Successfully applied Mica effect");
                    Ok(())
                }
                Err(e) => {
                    log::warn!("Failed to apply Mica effect: {}, falling back to Acrylic", e);
                    // 降级到 Acrylic
                    apply_window_effect(window, WindowEffect::Acrylic)
                }
            }
        }
        WindowEffect::Acrylic => {
            // 尝试应用 Acrylic 效果（使用半透明深色背景）
            match window_vibrancy::apply_acrylic(window, Some((18, 18, 18, 120))) {
                Ok(_) => {
                    log::info!("Successfully applied Acrylic effect");
                    Ok(())
                }
                Err(e) => {
                    log::warn!("Failed to apply Acrylic effect: {}, falling back to Blur", e);
                    // 降级到 Blur
                    apply_window_effect(window, WindowEffect::Blur)
                }
            }
        }
        WindowEffect::Blur => {
            // 尝试应用简单模糊效果
            match window_vibrancy::apply_blur(window, Some((18, 18, 18, 120))) {
                Ok(_) => {
                    log::info!("Successfully applied Blur effect");
                    Ok(())
                }
                Err(e) => {
                    log::warn!("Failed to apply Blur effect: {}, using CSS fallback", e);
                    // 降级到无效果（纯 CSS 兜底）
                    apply_window_effect(window, WindowEffect::None)
                }
            }
        }
        WindowEffect::None => {
            // 不应用任何 OS 级效果，依赖 CSS 样式
            log::info!("Using CSS fallback for window background");
            Ok(())
        }
    }
}

/// 获取 Windows 版本信息
/// 使用 RtlGetVersion 获取真实版本（绕过 app manifest shim）
#[cfg(target_os = "windows")]
pub fn get_windows_version() -> Option<(u64, u64, u64)> {
    use windows::core::PCSTR;
    use windows::Win32::System::LibraryLoader::GetModuleHandleA;
    use windows::Win32::System::LibraryLoader::GetProcAddress;

    // RtlGetVersion 函数签名
    type RtlGetVersionFn = unsafe extern "system" fn(*mut OSVERSIONINFOW) -> i32;

    #[repr(C)]
    #[derive(Debug)]
    struct OSVERSIONINFOW {
        dwOSVersionInfoSize: u32,
        dwMajorVersion: u32,
        dwMinorVersion: u32,
        dwBuildNumber: u32,
        dwPlatformId: u32,
        szCSDVersion: [u16; 128],
    }

    unsafe {
        // 获取 ntdll.dll 模块
        let ntdll = GetModuleHandleA(PCSTR::from_raw("ntdll.dll\0".as_ptr()));
        if ntdll.is_err() {
            log::warn!("Failed to get ntdll.dll handle");
            return None;
        }
        let ntdll = ntdll.unwrap();

        // 获取 RtlGetVersion 函数地址
        let rtl_get_version = GetProcAddress(
            ntdll,
            PCSTR::from_raw("RtlGetVersion\0".as_ptr()),
        );

        if let Some(rtl_get_version) = rtl_get_version {
            let rtl_get_version: RtlGetVersionFn = std::mem::transmute(rtl_get_version);

            let mut osvi: OSVERSIONINFOW = std::mem::zeroed();
            osvi.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;

            let status = rtl_get_version(&mut osvi);
            if status == 0 {
                // STATUS_SUCCESS
                Some((
                    osvi.dwMajorVersion as u64,
                    osvi.dwMinorVersion as u64,
                    osvi.dwBuildNumber as u64,
                ))
            } else {
                log::warn!("RtlGetVersion returned non-success status: {}", status);
                None
            }
        } else {
            log::warn!("Failed to get RtlGetVersion function address");
            None
        }
    }
}


pub mod clipboard;
pub mod commands;
pub mod db;
pub mod llm;
pub mod llm_provider;
pub mod notes;
pub mod password;
pub mod search;
pub mod settings;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .setup(|app| {
            // Setup system tray
            setup_system_tray(app.handle())?;

            // Initialize updater plugin (desktop only)
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            }

            // Initialize logging in debug mode
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Initialize database
            db::init(app.handle())?;

            // Initialize pending update cache (populated by check_for_update)
            app.manage(commands::updater::PendingUpdate(Mutex::new(None)));

            // Initialize settings manager first (needed by window handlers)
            let settings_db_path = app
                .path()
                .app_data_dir()
                .unwrap()
                .join("settings.db")
                .to_string_lossy()
                .to_string();
            let settings_manager = settings::SettingsManager::new(settings_db_path);

            // Apply always_on_top setting to window
            let settings = settings_manager.get_settings();
            if let Some(window) = app.get_webview_window("main") {
                if let Err(e) = window.set_always_on_top(settings.always_on_top) {
                    log::warn!("Failed to set always_on_top: {}", e);
                }

                // Apply OS-level Acrylic blur effect (Windows 10 Fall Creators Update+)
                // 不传颜色参数，由前端 CSS 完全控制背景色
                #[cfg(target_os = "windows")]
                if let Err(e) = window_vibrancy::apply_acrylic(&window, None) {
                    log::warn!("Failed to apply acrylic vibrancy: {}", e);
                }

                // Apply rounded window corners at compositor level (Windows 11+)
                // This clips the Acrylic background to match the visual rounded corners,
                // preventing the gray rectangular fill in the four corners.
                #[cfg(target_os = "windows")]
                {
                    use windows::Win32::Graphics::Dwm::{
                        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
                    };
                    if let Ok(hwnd) = window.hwnd() {
                        let preference = DWMWCP_ROUND;
                        unsafe {
                            if let Err(e) = DwmSetWindowAttribute(
                                hwnd,
                                DWMWA_WINDOW_CORNER_PREFERENCE,
                                &preference as *const _ as *const core::ffi::c_void,
                                std::mem::size_of_val(&preference) as u32,
                            ) {
                                log::warn!("Failed to set rounded window corners: {}", e);
                            }
                        }
                    }
                }
            }

            // Apply startup_launch setting
            let autostart_manager = app.autolaunch();
            let is_enabled = autostart_manager.is_enabled().unwrap_or(false);
            if settings.startup_launch && !is_enabled {
                if let Err(e) = autostart_manager.enable() {
                    log::warn!("Failed to enable autostart: {}", e);
                }
            } else if !settings.startup_launch && is_enabled {
                if let Err(e) = autostart_manager.disable() {
                    log::warn!("Failed to disable autostart: {}", e);
                }
            }

            app.manage(commands::settings::SettingsState(Mutex::new(settings_manager)));

            // Initialize shortcut manager
            let shortcuts_db_path = app
                .path()
                .app_data_dir()
                .unwrap()
                .join("shortcuts.db")
                .to_string_lossy()
                .to_string();
            let shortcut_manager = settings::ShortcutManager::new(shortcuts_db_path);

            // Register all shortcuts from database
            if let Err(e) = shortcut_manager.register_all(app.handle()) {
                log::warn!("Failed to register shortcuts: {}", e);
            }

            app.manage(commands::settings::ShortcutManagerState(Mutex::new(shortcut_manager)));

            // Setup window event handlers (after settings initialized)
            setup_window_handlers(app.handle());

            // Initialize previous focused window state for auto-paste
            app.manage(PreviousFocusedWindow::new());

            // Start clipboard manager
            let suppress_flag = Arc::new(AtomicBool::new(false));
            app.manage(clipboard::ClipboardSuppressFlag(Arc::clone(&suppress_flag)));
            let clipboard_manager = clipboard::ClipboardManager::new(app.handle().clone(), suppress_flag)
                .map_err(|e| {
                    log::error!("Failed to create clipboard manager: {}", e);
                    e
                })?;
            app.manage(Mutex::new(clipboard_manager));

            // Initialize notes manager
            let notes_dir = notes::get_default_notes_dir()
                .unwrap_or_else(|_| app.path().app_data_dir().unwrap().join("notes"));
            std::fs::create_dir_all(&notes_dir).ok();
            let notes_manager = notes::NotesManager::new(notes_dir);
            app.manage(commands::notes::NotesManagerState(Mutex::new(notes_manager)));

            // Initialize password manager
            let password_manager = password::PasswordManager::new();
            app.manage(password::PasswordManagerState(Arc::new(password_manager)));

            // Initialize search index with database for caching
            let db_path = app.path().app_data_dir().unwrap().join("custom-tools.db");
            let db_state = Arc::new(db::DatabaseState(db_path));

            // Create search index with db connection
            let mut search_index = search::SearchIndex::with_db(db_state.clone());

            // Fast load from cache first
            if let Err(e) = search_index.load_from_cache() {
                log::warn!("Failed to load from cache: {}", e);
                // Fall back to full index
                if let Err(e) = search_index.index_apps() {
                    log::warn!("Failed to index apps: {}", e);
                }
            }

            let search_index_arc = Arc::new(Mutex::new(search_index));
            app.manage(commands::search::SearchState(search_index_arc.clone()));

            // Start file watcher in background thread to avoid blocking startup
            let search_index_for_watcher = search_index_arc.clone();
            let db_state_for_watcher = db_state.clone();
            std::thread::spawn(move || {
                if let Err(e) = search::watcher::init_watcher(search_index_for_watcher, db_state_for_watcher) {
                    log::warn!("Failed to start file watcher: {}", e);
                }
            });

            // Background refresh in case cache is stale
            let search_index_for_refresh = search_index_arc.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(2)); // Wait 2 seconds after startup
                if let Ok(mut idx) = search_index_for_refresh.lock() {
                    if let Err(e) = idx.refresh_in_background() {
                        log::warn!("Background refresh failed: {}", e);
                    }
                }
            });

            // Auto check for updates on startup (if enabled) - using system notification
            {
                let app_handle = app.handle().clone();
                let settings_for_update = settings.clone();
                tauri::async_runtime::spawn(async move {
                    // Delay to avoid impacting startup performance
                    tokio::time::sleep(Duration::from_secs(5)).await;

                    if settings_for_update.auto_update {
                        check_update_on_startup(app_handle).await;
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Window commands
            commands::window::get_window_effect,
            commands::window::show_window,
            commands::window::hide_window,
            commands::window::toggle_window,
            commands::window::center_window,
            commands::window::resize_window,
            commands::clipboard::get_clipboard_history,
            commands::clipboard::toggle_clipboard_favorite,
            commands::clipboard::delete_clipboard_item,
            commands::clipboard::clear_clipboard_history,
            commands::clipboard::copy_to_clipboard,
            commands::clipboard::copy_text_to_clipboard,
            commands::clipboard::paste_to_clipboard_item,
            commands::clipboard::get_clipboard_image_base64,
            commands::clipboard::handle_pasted_file,
            commands::clipboard::read_clipboard_image,
            commands::clipboard::read_image_file_as_base64,
            commands::notes::init_notes_manager,
            commands::notes::get_notes_directory,
            commands::notes::get_note_tree,
            commands::notes::read_note,
            commands::notes::save_note,
            commands::notes::create_note,
            commands::notes::rename_note,
            commands::notes::delete_note,
            commands::notes::move_note,
            commands::notes::reorder_notes,
            commands::password::is_password_manager_unlocked,
            commands::password::unlock_password_manager,
            commands::password::lock_password_manager,
            commands::password::get_password_categories,
            commands::password::get_password_entries,
            commands::password::create_password_entry,
            commands::password::get_decrypted_password,
            commands::password::toggle_password_favorite,
            commands::password::delete_password_entry,
            commands::password::create_password_category,
            commands::password::delete_password_category,
            commands::search::index_apps,
            commands::search::search_apps,
            commands::search::refresh_apps,
            commands::search::launch_app,
            commands::search::record_app_usage,
            commands::search::extract_app_icon,
            commands::search::get_recent_apps,
            // Everything integration
            commands::search::is_everything_available,
            commands::search::search_everything,
            commands::search::get_everything_version,
            commands::search::install_everything,
            commands::search::open_file,
            commands::settings::get_settings,
            commands::settings::set_setting,
            commands::settings::toggle_always_on_top,
            commands::settings::set_always_on_top,
            commands::settings::toggle_hide_on_blur,
            commands::settings::toggle_startup_launch,
            commands::settings::set_startup_launch,
            commands::settings::get_shortcuts,
            commands::settings::update_shortcut,
            commands::settings::reset_shortcut,
            commands::settings::reset_all_shortcuts,
            commands::settings::check_shortcut_conflict,
            commands::settings::toggle_auto_update,
            commands::settings::get_custom_scan_dirs,
            commands::settings::set_custom_scan_dirs,
            commands::system::open_external_url,
            commands::system::save_image_to_downloads,
            commands::system::save_image_to_path,
            // Updater commands
            commands::updater::check_for_update,
            commands::updater::download_and_install_update,
            // Changelog commands
            commands::changelog::add_changelog,
            commands::changelog::mark_changelog_read,
            commands::changelog::mark_all_changelogs_read,
            commands::changelog::get_changelogs,
            commands::changelog::check_version_changelog,
            commands::changelog::cleanup_old_changelogs,
            commands::llm::call_llm,
            commands::llm::call_llm_by_scene,
            commands::llm::test_llm_connection,
            commands::llm::call_llm_stream,
            commands::llm::call_llm_stream_by_scene,
            commands::chat::create_chat_session,
            commands::chat::save_chat_message,
            commands::chat::get_session_messages,
            commands::chat::get_latest_session,
            // LLM Provider commands
            llm_provider::commands::get_llm_providers,
            llm_provider::commands::create_llm_provider,
            llm_provider::commands::update_llm_provider,
            llm_provider::commands::delete_llm_provider,
            llm_provider::commands::test_llm_provider_connection,
            llm_provider::commands::get_llm_models,
            llm_provider::commands::fetch_llm_models,
            llm_provider::commands::activate_llm_model,
            llm_provider::commands::deactivate_llm_model,
            llm_provider::commands::get_active_llm_models,
            llm_provider::commands::get_scene_configs,
            llm_provider::commands::set_scene_model,
            llm_provider::commands::get_scene_model,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn setup_window_handlers(app_handle: &tauri::AppHandle) {
    let window = app_handle.get_webview_window("main").unwrap();

    // Flag to prevent hide-on-blur immediately after showing window
    let ignore_blur = Arc::new(AtomicBool::new(false));
    let ignore_blur_clone = ignore_blur.clone();

    // Hide window when it loses focus (if hide_on_blur is enabled)
    let app_handle_clone = app_handle.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(focused) = event {
            if !focused {
                // Skip if we're ignoring blur events (recently shown)
                if ignore_blur_clone.load(Ordering::Relaxed) {
                    return;
                }

                // Check settings and hide if configured
                if let Some(settings_state) = app_handle_clone.try_state::<commands::settings::SettingsState>() {
                    if let Ok(manager) = settings_state.0.lock() {
                        if manager.should_hide_on_blur() {
                            if let Some(window) = app_handle_clone.get_webview_window("main") {
                                let _ = window.hide();
                            }
                        }
                    }
                }
            }
        }
    });

    // Store the ignore_blur flag in app state so toggle_main_window can access it
    app_handle.manage(WindowFocusState { ignore_blur });
}

// State to track window focus behavior
pub struct WindowFocusState {
    ignore_blur: Arc<AtomicBool>,
}

impl WindowFocusState {
    pub fn set_ignore_blur_for(&self, duration: Duration) {
        self.ignore_blur.store(true, Ordering::Relaxed);
        let flag = self.ignore_blur.clone();
        std::thread::spawn(move || {
            std::thread::sleep(duration);
            flag.store(false, Ordering::Relaxed);
        });
    }
}

// State to store the previous focused window for auto-paste
pub struct PreviousFocusedWindow {
    hwnd: Arc<Mutex<isize>>, // 0 means no valid window
}

impl Default for PreviousFocusedWindow {
    fn default() -> Self {
        Self::new()
    }
}

impl PreviousFocusedWindow {
    pub fn new() -> Self {
        Self {
            hwnd: Arc::new(Mutex::new(0)),
        }
    }

    pub fn store(&self, hwnd: isize) {
        if let Ok(mut guard) = self.hwnd.lock() {
            *guard = hwnd;
        }
    }

    pub fn get(&self) -> Option<isize> {
        self.hwnd.lock().ok().and_then(|hwnd| {
            let h = *hwnd;
            if h == 0 { None } else { Some(h) }
        })
    }
}

/// 捕获当前前台窗口的 HWND，存入 PreviousFocusedWindow 状态（用于自动粘贴）。
#[cfg(windows)]
pub(crate) fn capture_prev_window_hwnd(app_handle: &tauri::AppHandle) {
    if let Some(prev_window_state) = app_handle.try_state::<PreviousFocusedWindow>() {
        unsafe {
            use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
            let hwnd = GetForegroundWindow();
            if !hwnd.0.is_null() {
                prev_window_state.store(hwnd.0 as isize);
                log::info!("Captured previous window HWND: {}", hwnd.0 as isize);
            } else {
                log::warn!("GetForegroundWindow returned null, cannot capture");
            }
        }
    } else {
        log::warn!("PreviousFocusedWindow state not found");
    }
}

pub(crate) fn show_main_window(app_handle: &tauri::AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        // Capture the previous focused window for auto-paste functionality
        #[cfg(target_os = "windows")]
        capture_prev_window_hwnd(app_handle);

        // Ignore blur events briefly to prevent immediate re-hide
        if let Some(focus_state) = app_handle.try_state::<WindowFocusState>() {
            focus_state.set_ignore_blur_for(Duration::from_millis(300));
        }

        // 智能检测：在鼠标所在的显示器显示窗口
        const TOP_PADDING: i32 = 100;
        const WINDOW_WIDTH: i32 = 800;

        // 获取鼠标所在的显示器
        let target_monitor = get_monitor_at_cursor(app_handle);

        if let Some(monitor) = target_monitor {
            let monitor_pos = monitor.position();
            let monitor_size = monitor.size();
            let scale_factor = monitor.scale_factor();

            // 修复：将逻辑像素宽度转换为物理像素
            let window_width_physical = (WINDOW_WIDTH as f64 * scale_factor) as i32;

            // 计算窗口居中位置（水平居中，顶部偏移）
            let x = monitor_pos.x + (monitor_size.width as i32 - window_width_physical) / 2;
            let y = monitor_pos.y + TOP_PADDING;

            let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
        }

        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub(crate) fn toggle_main_window(app_handle: &tauri::AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            Ok(false) => {
                show_main_window(app_handle);
            }
            Err(e) => log::error!("Failed to check window visibility: {}", e),
        }
    }
}

/// Send system notification with app icon
#[cfg(target_os = "windows")]
fn send_notification_with_icon(
    app_handle: &tauri::AppHandle,
    title: &str,
    body: &str,
) {
    use tauri_plugin_notification::NotificationExt;

    // Try multiple possible icon locations
    let icon_paths = [
        // Production build paths
        app_handle.path().resource_dir().ok().map(|d| d.join("icons\\icon.ico")),
        app_handle.path().resource_dir().ok().map(|d| d.join("icons\\128x128.png")),
        // Development paths (from src-tauri directory)
        Some(std::path::PathBuf::from("icons\\icon.ico")),
        Some(std::path::PathBuf::from("icons\\128x128.png")),
        Some(std::path::PathBuf::from("src-tauri\\icons\\icon.ico")),
        Some(std::path::PathBuf::from("src-tauri\\icons\\128x128.png")),
    ];

    let mut builder = app_handle.notification().builder();
    builder = builder.title(title).body(body);

    // Try to find and use the first existing icon
    for icon_path in icon_paths.iter().flatten() {
        if icon_path.exists() {
            if let Some(path_str) = icon_path.to_str() {
                log::debug!("Using notification icon: {}", path_str);
                builder = builder.icon(path_str);
                break;
            }
        }
    }

    if let Err(e) = builder.show() {
        log::warn!("Failed to show notification: {}", e);
    }
}

/// Send system notification (non-Windows fallback)
#[cfg(not(target_os = "windows"))]
fn send_notification_with_icon(
    app_handle: &tauri::AppHandle,
    title: &str,
    body: &str,
) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app_handle
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show();
}

/// Check for updates from tray menu and show system notification
async fn check_update_from_tray(app_handle: tauri::AppHandle) {
    let app_version = app_handle.package_info().version.clone();

    let updater = match app_handle.updater() {
        Ok(u) => u,
        Err(e) => {
            log::error!("Failed to get updater: {}", e);
            send_notification_with_icon(&app_handle, "检查更新失败", "无法获取更新服务");
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            log::info!("Update available: {} (current: {})", update.version, app_version);

            // Cache the update for later install
            if let Some(state) = app_handle.try_state::<commands::updater::PendingUpdate>() {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = Some(update.clone());
                }
            }

            // Show main window so user can see the update UI
            toggle_main_window(&app_handle);

            // Emit event to frontend to show update UI
            let update_info = commands::updater::UpdateInfo {
                version: update.version.clone(),
                date: update.date.as_ref().map(|d| d.to_string()),
                body: update.body.clone(),
            };
            if let Err(e) = app_handle.emit("update-available", update_info) {
                log::warn!("Failed to emit update-available event: {}", e);
            }

            // Also show system notification
            let body = update.body.as_deref().unwrap_or("点击通知以安装更新");
            send_notification_with_icon(
                &app_handle,
                &format!("发现新版本: {}", update.version),
                body
            );
        }
        Ok(None) => {
            log::info!("No update available (current: {})", app_version);
            send_notification_with_icon(
                &app_handle,
                "已是最新版本",
                &format!("当前版本: {}", app_version)
            );
        }
        Err(e) => {
            log::error!("Update check failed: {}", e);
            send_notification_with_icon(
                &app_handle,
                "检查更新失败",
                "网络连接错误或更新服务器不可用"
            );
        }
    }
}

/// Check for updates on startup and show system notification
async fn check_update_on_startup(app_handle: tauri::AppHandle) {
    let app_version = app_handle.package_info().version.clone();

    let updater = match app_handle.updater() {
        Ok(u) => u,
        Err(e) => {
            log::error!("Failed to get updater on startup: {}", e);
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            log::info!("Update available on startup: {} (current: {})", update.version, app_version);

            // Cache the update for later install
            if let Some(state) = app_handle.try_state::<commands::updater::PendingUpdate>() {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = Some(update.clone());
                }
            }

            // Show main window so user can see the update UI
            toggle_main_window(&app_handle);

            // Emit event to frontend to show update UI
            let update_info = commands::updater::UpdateInfo {
                version: update.version.clone(),
                date: update.date.as_ref().map(|d| d.to_string()),
                body: update.body.clone(),
            };
            if let Err(e) = app_handle.emit("update-available", update_info) {
                log::warn!("Failed to emit update-available event: {}", e);
            }

            // Also show system notification
            let body = update.body.as_deref().unwrap_or("点击通知以查看更新详情");
            send_notification_with_icon(
                &app_handle,
                &format!("发现新版本: {}", update.version),
                body
            );
        }
        Ok(None) => {
            log::info!("No update available on startup (current: {})", app_version);
        }
        Err(e) => {
            log::warn!("Update check failed on startup: {}", e);
        }
    }
}

fn setup_system_tray(app_handle: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};

    // Create menu items
    let settings_item = MenuItem::with_id(app_handle, "settings", "设置", true, None::<&str>)?;
    let check_update_item = MenuItem::with_id(app_handle, "check_update", "检查更新", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app_handle)?;
    let quit_item = MenuItem::with_id(app_handle, "quit", "退出", true, None::<&str>)?;

    // Create menu
    let menu = Menu::with_items(app_handle, &[&settings_item, &separator, &check_update_item, &separator, &quit_item])?;

    // Build tray icon
    let _tray = tauri::tray::TrayIconBuilder::new()
        .icon(app_handle.default_window_icon().unwrap().clone())
        .menu(&menu)
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
                "settings" => {
                    show_main_window(app);
                    if let Err(e) = app.emit("shortcut:open_module", "settings") {
                        log::warn!("Failed to emit open settings event: {}", e);
                    }
                }
                "check_update" => {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        check_update_from_tray(app_handle).await;
                    });
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click { button, button_state, .. } = event {
                if button == tauri::tray::MouseButton::Left
                    && button_state == tauri::tray::MouseButtonState::Up
                {
                    let app = tray.app_handle();
                    toggle_main_window(app);
                }
            }
        })
        .build(app_handle)?;

    log::info!("System tray icon set up successfully");
    Ok(())
}
