use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_updater::UpdaterExt;

/// 应用数据目录名（必须与 tauri.conf.json 的 identifier 保持一致）。
/// 没有 AppHandle 的模块（watcher 回调、MCP server、panic hook 等）
/// 用 dirs::data_dir().join(APP_DIR_NAME) 推导数据目录，不要散落字面量。
pub const APP_DIR_NAME: &str = "com.flowhub.app";

/// 主数据库文件名
pub const DB_FILE_NAME: &str = "flowhub.db";

/// 获取当前鼠标位置（Windows API）
#[cfg(target_os = "windows")]
pub fn get_cursor_pos() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

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

pub mod clipboard;
pub mod commands;
pub mod companion;
pub mod db;
pub mod llm;
pub mod llm_provider;
pub mod notes;
pub mod password;
pub mod search;
pub mod settings;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();

    tauri::Builder::default()
        // 单实例插件必须最先注册:第二个实例在插件 init 阶段即被拦截退出,
        // 避免它再去抢日志文件/数据库。--mcp-server 模式不走 Tauri Builder,不受影响。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 已有实例在跑:唤起其主窗口(用户双击图标就是想打开它)
            show_main_window(app);
        }))
        // 日志插件紧随单实例之后注册:托盘/updater 等后续初始化失败时才能留下日志
        .plugin(build_log_plugin().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Setup system tray
            setup_system_tray(app.handle())?;

            // Initialize updater plugin (desktop only)
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }

            // Clean up logs older than 30 days in background
            if let Ok(logs_dir) = app.path().app_log_dir() {
                std::thread::spawn(move || {
                    if let Err(e) = cleanup_old_logs(&logs_dir, 30) {
                        log::warn!("Failed to cleanup old logs: {}", e);
                    }
                });
            }

            // Initialize database
            db::init(app.handle())?;
            log::info!("Database initialized");

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

            app.manage(commands::settings::SettingsState(Mutex::new(
                settings_manager,
            )));
            log::info!("Settings manager initialized");

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

            app.manage(commands::settings::ShortcutManagerState(Mutex::new(
                shortcut_manager,
            )));

            // Setup window event handlers (after settings initialized)
            setup_window_handlers(app.handle());

            // Initialize previous focused window state for auto-paste
            app.manage(PreviousFocusedWindow::new());

            // Start clipboard manager
            let suppress_flag = Arc::new(AtomicBool::new(false));
            app.manage(clipboard::ClipboardSuppressFlag(Arc::clone(&suppress_flag)));
            let clipboard_manager =
                clipboard::ClipboardManager::new(app.handle().clone(), suppress_flag).map_err(
                    |e| {
                        log::error!("Failed to create clipboard manager: {}", e);
                        e
                    },
                )?;
            app.manage(Mutex::new(clipboard_manager));
            log::info!("Clipboard manager initialized");

            // Initialize notes manager
            let notes_dir = notes::get_default_notes_dir()
                .unwrap_or_else(|_| app.path().app_data_dir().unwrap().join("notes"));
            std::fs::create_dir_all(&notes_dir).ok();
            let notes_manager = notes::NotesManager::new(notes_dir);
            app.manage(commands::notes::NotesManagerState(Mutex::new(
                notes_manager,
            )));

            // Initialize password manager
            let password_manager = password::PasswordManager::new();
            app.manage(password::PasswordManagerState(Arc::new(password_manager)));

            // Initialize search index with database for caching.
            // 注意:这里只创建空索引并托管状态,首次索引(读缓存/全量扫描)全部在
            // 后台线程执行——扫描会触达文件系统/注册表/外部进程,在慢速或不可达
            // 环境(网络盘、EDR 拦截)可能长时间阻塞,同步跑在主事件循环线程会导致
            // 窗口不显示、托盘菜单不弹、快捷键无响应(整个 UI 消息泵停摆)。
            let db_path = app.path().app_data_dir().unwrap().join(DB_FILE_NAME);
            let db_state = Arc::new(db::DatabaseState(db_path));

            let search_index = search::SearchIndex::with_db(db_state.clone());
            let search_index_arc = Arc::new(Mutex::new(search_index));
            app.manage(commands::search::SearchState(search_index_arc.clone()));

            // Background initial indexing: load cache first, fall back to full scan
            {
                let search_index_for_init = search_index_arc.clone();
                let db_state_for_init = db_state.clone();
                std::thread::spawn(move || {
                    log::info!("Background initial app indexing started");

                    // 缓存加载只读本地 SQLite,毫秒级,持锁无碍
                    let cache_loaded = match search_index_for_init.lock() {
                        Ok(mut idx) => match idx.load_from_cache() {
                            Ok(loaded) => loaded,
                            Err(e) => {
                                log::warn!("Failed to load app cache: {}", e);
                                false
                            }
                        },
                        Err(e) => {
                            log::warn!("Search index lock poisoned: {}", e);
                            false
                        }
                    };

                    if !cache_loaded {
                        // 全量扫描不持锁(可能极慢),完成后再短暂持锁交换结果
                        match search::SearchIndex::collect_all_apps(&Some(db_state_for_init))
                        {
                            Ok(apps) => {
                                let count = apps.len();
                                if let Ok(mut idx) = search_index_for_init.lock() {
                                    idx.apply_indexed_apps(apps);
                                    log::info!(
                                        "Background initial app indexing finished: {} apps",
                                        count
                                    );
                                }
                            }
                            Err(e) => {
                                log::warn!("Background initial app indexing failed: {}", e)
                            }
                        }
                    }
                });
            }

            // Start file watcher in background thread to avoid blocking startup
            let search_index_for_watcher = search_index_arc.clone();
            let db_state_for_watcher = db_state.clone();
            std::thread::spawn(move || {
                if let Err(e) =
                    search::watcher::init_watcher(search_index_for_watcher, db_state_for_watcher)
                {
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

            // Auto check for updates on startup (if enabled) - shown in the in-app UI
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

            // 预创建陪伴建议 Toast 窗口（隐藏），降低建议弹出时的延迟
            {
                let companion_toast = tauri::WebviewWindowBuilder::new(
                    app,
                    "companion-toast",
                    tauri::WebviewUrl::App("/companion-toast.html".into()),
                )
                .title("陪伴建议")
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .shadow(false)
                .focused(false)
                .resizable(false)
                .visible(false)
                .build();

                if let Err(e) = companion_toast {
                    log::warn!("Failed to pre-create companion toast window: {}", e);
                }
            }

            // 启动陪伴模块（窗口活动采集 + 情境建议 + LLM 习惯分析）
            {
                let companion_db_path = app.path().app_data_dir().unwrap().join(DB_FILE_NAME);
                let flags = companion::CompanionFlags {
                    enabled: settings.companion_enabled,
                    paused: settings.companion_paused,
                    retention_days: settings.companion_retention_days as i64,
                    long_work_minutes: settings.companion_long_work_minutes as i64,
                    daily_report: settings.companion_daily_report,
                    monologue: settings.companion_monologue,
                };
                let companion_state = companion::start(app.handle(), companion_db_path, flags);
                app.manage(companion_state);
                app.manage(companion::chat::JarvisChatChild::default());
            }

            log::info!("Application setup completed");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Window commands
            commands::window::show_window,
            commands::window::hide_window,
            commands::window::toggle_window,
            commands::window::resize_window,
            commands::clipboard::get_clipboard_history,
            commands::clipboard::toggle_clipboard_favorite,
            commands::clipboard::delete_clipboard_item,
            commands::clipboard::clear_clipboard_history,
            commands::clipboard::export_clipboard_history,
            commands::clipboard::copy_to_clipboard,
            commands::clipboard::copy_text_to_clipboard,
            commands::clipboard::paste_to_clipboard_item,
            commands::clipboard::get_clipboard_image_base64,
            commands::clipboard::handle_pasted_file,
            commands::clipboard::read_clipboard_image,
            commands::clipboard::read_image_file_as_base64,
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
            commands::password::delete_password_entry,
            commands::search::search_apps,
            commands::search::refresh_apps,
            commands::search::launch_app,
            commands::search::record_app_usage,
            commands::search::extract_app_icon,
            commands::search::get_recent_apps,
            // Everything integration
            commands::search::is_everything_available,
            commands::search::search_everything,
            commands::search::install_everything,
            commands::search::open_file,
            commands::settings::get_settings,
            commands::settings::set_setting,
            commands::settings::reset_settings,
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
            commands::system::save_image_to_path,
            // Updater commands
            commands::updater::check_for_update,
            commands::updater::download_and_install_update,
            // Changelog commands
            commands::changelog::add_changelog,
            commands::changelog::mark_all_changelogs_read,
            commands::changelog::check_version_changelog,
            commands::changelog::cleanup_old_changelogs,
            commands::llm::test_llm_connection,
            commands::llm::call_llm_stream_by_scene,
            commands::llm::get_llm_call_stats,
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
            llm_provider::commands::set_llm_model_price,
            llm_provider::commands::get_scene_configs,
            llm_provider::commands::set_scene_model,
            llm_provider::commands::get_scene_model,
            // Companion commands
            commands::companion::get_companion_suggestions,
            commands::companion::act_on_companion_suggestion,
            commands::companion::dismiss_companion_suggestion,
            commands::companion::get_companion_patterns,
            commands::companion::set_companion_pattern_status,
            commands::companion::get_companion_today_summary,
            commands::companion::clear_companion_activities,
            commands::companion::analyze_companion_now,
            commands::companion::run_companion_agent_now,
            commands::companion::create_companion_intent,
            commands::companion::get_companion_intents,
            commands::companion::get_companion_memory_facts,
            commands::companion::update_companion_memory_fact,
            commands::companion::delete_companion_memory_fact,
            commands::companion::get_companion_memory_fact_events,
            commands::companion::jarvis_recall_poke,
            commands::companion::set_companion_enabled,
            commands::companion::set_companion_paused,
            commands::companion::set_companion_daily_report,
            commands::companion::set_companion_monologue,
            commands::companion::set_companion_retention_days,
            commands::companion::set_companion_long_work_minutes,
            companion::chat::jarvis_chat_send,
            companion::chat::jarvis_chat_cancel,
            companion::chat::jarvis_chat_reset,
            companion::chat::jarvis_agent_available,
            companion::chat::jarvis_chat_system,
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
                if let Some(settings_state) =
                    app_handle_clone.try_state::<commands::settings::SettingsState>()
                {
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
            if h == 0 {
                None
            } else {
                Some(h)
            }
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

            let _ =
                window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
        }

        let _ = window.show();
        let _ = window.set_focus();
        // 通知前端窗口已唤起（用于重置启动器搜索状态）
        let _ = app_handle.emit("window:shown", ());
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

/// Emit the manual update-check result to the frontend (shown as in-app feedback)
fn emit_check_result(
    app_handle: &tauri::AppHandle,
    result: commands::updater::UpdateCheckResult,
) {
    if let Err(e) = app_handle.emit("update-check-result", result) {
        log::warn!("Failed to emit update-check-result event: {}", e);
    }
}

/// Check for updates from tray menu — all results are shown in the in-app UI
async fn check_update_from_tray(app_handle: tauri::AppHandle) {
    let app_version = app_handle.package_info().version.clone();

    let updater = match app_handle.updater() {
        Ok(u) => u,
        Err(e) => {
            log::error!("Failed to get updater: {}", e);
            show_main_window(&app_handle);
            emit_check_result(&app_handle, commands::updater::UpdateCheckResult::Failed);
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            log::info!(
                "Update available: {} (current: {})",
                update.version,
                app_version
            );

            // Cache the update for later install
            if let Some(state) = app_handle.try_state::<commands::updater::PendingUpdate>() {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = Some(update.clone());
                }
            }

            // Show main window so user can see the update UI
            show_main_window(&app_handle);

            // Emit event to frontend to show update UI
            let update_info = commands::updater::UpdateInfo {
                version: update.version.clone(),
                date: update.date.as_ref().map(|d| d.to_string()),
                body: update.body.clone(),
            };
            if let Err(e) = app_handle.emit("update-available", update_info) {
                log::warn!("Failed to emit update-available event: {}", e);
            }
        }
        Ok(None) => {
            log::info!("No update available (current: {})", app_version);
            show_main_window(&app_handle);
            emit_check_result(&app_handle, commands::updater::UpdateCheckResult::Latest);
        }
        Err(e) => {
            log::error!("Update check failed: {}", e);
            show_main_window(&app_handle);
            emit_check_result(&app_handle, commands::updater::UpdateCheckResult::Failed);
        }
    }
}

/// Check for updates on startup — new versions are shown in the in-app UI
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
            log::info!(
                "Update available on startup: {} (current: {})",
                update.version,
                app_version
            );

            // Cache the update for later install
            if let Some(state) = app_handle.try_state::<commands::updater::PendingUpdate>() {
                if let Ok(mut guard) = state.0.lock() {
                    *guard = Some(update.clone());
                }
            }

            // Show main window so user can see the update UI
            show_main_window(&app_handle);

            // Emit event to frontend to show update UI
            let update_info = commands::updater::UpdateInfo {
                version: update.version.clone(),
                date: update.date.as_ref().map(|d| d.to_string()),
                body: update.body.clone(),
            };
            if let Err(e) = app_handle.emit("update-available", update_info) {
                log::warn!("Failed to emit update-available event: {}", e);
            }
        }
        Ok(None) => {
            log::info!("No update available on startup (current: {})", app_version);
        }
        Err(e) => {
            log::warn!("Update check failed on startup: {}", e);
        }
    }
}

/// Remove log files older than the specified number of days.
fn cleanup_old_logs(
    logs_dir: &std::path::Path,
    days: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    let retention = std::time::Duration::from_secs(days * 24 * 60 * 60);
    let now = std::time::SystemTime::now();

    for entry in std::fs::read_dir(logs_dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("log") {
            continue;
        }
        let modified = entry.metadata()?.modified()?;
        if now.duration_since(modified)? > retention {
            if let Err(e) = std::fs::remove_file(&path) {
                eprintln!("Failed to remove old log file {:?}: {}", path, e);
            }
        }
    }
    Ok(())
}

fn setup_system_tray(app_handle: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};

    // Create menu items
    let settings_item = MenuItem::with_id(app_handle, "settings", "设置", true, None::<&str>)?;
    let check_update_item =
        MenuItem::with_id(app_handle, "check_update", "检查更新", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app_handle)?;
    let quit_item = MenuItem::with_id(app_handle, "quit", "退出", true, None::<&str>)?;

    // Create menu
    let menu = Menu::with_items(
        app_handle,
        &[
            &settings_item,
            &separator,
            &check_update_item,
            &separator,
            &quit_item,
        ],
    )?;

    // Build tray icon
    let _tray = tauri::tray::TrayIconBuilder::new()
        .icon(app_handle.default_window_icon().unwrap().clone())
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
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
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button,
                button_state,
                ..
            } = event
            {
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

/// 构建日志插件。日志目录用 TargetKind::LogDir(Tauri 自动解析
/// app_log_dir,Windows 上为 %LOCALAPPDATA%\<identifier>\logs,
/// 注意是 Local 不是 Roaming %APPDATA%),
/// 插件注册在 Builder 链前部,保证后续所有初始化阶段的日志都能落盘。
fn build_log_plugin() -> tauri_plugin_log::Builder {
    let log_level = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };

    tauri_plugin_log::Builder::default()
        .targets([
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                file_name: None,
            }),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
        ])
        .level(log_level)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
        .max_file_size(1_000_000)
        .format(|out, message, record| {
            out.finish(format_args!(
                "[{}] [{}] [{}] {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
                record.level(),
                record.target(),
                message
            ))
        })
}

/// 全局 panic hook:panic 写入日志,并直接落盘到 panic.log 兜底。
/// GUI 子系统应用没有控制台,panic 默认无声无息,用户机器上崩溃完全无法排查。
fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("{}", info);
        log::error!("PANIC: {}", msg);

        // 兜底:logger 可能尚未初始化或已失效,直接追加写文件。
        if let Some(data_dir) = dirs::data_dir() {
            let logs_dir = data_dir.join(APP_DIR_NAME).join("logs");
            if std::fs::create_dir_all(&logs_dir).is_ok() {
                use std::io::Write;
                if let Ok(mut file) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(logs_dir.join("panic.log"))
                {
                    let _ = writeln!(
                        file,
                        "[{}] PANIC: {}",
                        chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
                        msg
                    );
                }
            }
        }
    }));
}
