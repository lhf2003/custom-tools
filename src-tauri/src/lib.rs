use tauri::Manager;
use tauri_plugin_autostart::ManagerExt;
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::time::Duration;

// Tray icon resource ID (must match the one in build.rs if defined there)
const TRAY_ICON_ID: u32 = 1;

pub mod clipboard;
pub mod commands;
pub mod db;
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
            let clipboard_manager = clipboard::ClipboardManager::new(app.handle().clone())
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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            commands::system::open_external_url,
            commands::system::save_image_to_downloads,
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

fn toggle_main_window(app_handle: &tauri::AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            Ok(false) => {
                // Capture the previous focused window before showing our window
                // This is needed for auto-paste functionality
                #[cfg(windows)]
                {
                    log::info!("Attempting to capture previous focused window...");
                    if let Some(prev_window_state) = app_handle.try_state::<PreviousFocusedWindow>() {
                        unsafe {
                            use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
                            let hwnd = GetForegroundWindow();
                            log::info!("GetForegroundWindow returned: {}", hwnd.0);
                            // Store the HWND value (0 is invalid/null)
                            if hwnd.0 != 0 {
                                prev_window_state.store(hwnd.0);
                                log::info!("Captured previous window HWND: {}", hwnd.0);
                            } else {
                                log::warn!("GetForegroundWindow returned null, cannot capture");
                            }
                        }
                    } else {
                        log::warn!("PreviousFocusedWindow state not found, cannot capture HWND");
                    }
                }

                // Set flag to ignore blur events for a short time after showing
                // This prevents the window from immediately hiding due to focus race conditions
                if let Some(focus_state) = app_handle.try_state::<WindowFocusState>() {
                    focus_state.set_ignore_blur_for(Duration::from_millis(300));
                }

                // Position window at top of screen (centered horizontally)
                const TOP_PADDING: i32 = 100;
                let _ = window.center();
                if let Ok(pos) = window.outer_position() {
                    let monitor = window.current_monitor()
                        .ok()
                        .flatten()
                        .or_else(|| window.primary_monitor().ok().flatten());
                    if let Some(m) = monitor {
                        let y = m.position().y + TOP_PADDING;
                        let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: pos.x, y }));
                    }
                }
                let _ = window.show();
                let _ = window.set_focus();
            }
            Err(e) => log::error!("Failed to check window visibility: {}", e),
        }
    }
}

fn setup_system_tray(app_handle: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem};

    // Create menu items
    let show_item = MenuItem::with_id(app_handle, "show", "显示", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app_handle, "quit", "退出", true, None::<&str>)?;

    // Create menu
    let menu = Menu::with_items(app_handle, &[&show_item, &quit_item])?;

    // Build tray icon
    let _tray = tauri::tray::TrayIconBuilder::new()
        .icon(app_handle.default_window_icon().unwrap().clone())
        .menu(&menu)
        .on_menu_event(|app, event| {
            match event.id.as_ref() {
                "show" => {
                    toggle_main_window(app);
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click { button, .. } = event {
                if button == tauri::tray::MouseButton::Left {
                    let app = tray.app_handle();
                    toggle_main_window(app);
                }
            }
        })
        .build(app_handle)?;

    log::info!("System tray icon set up successfully");
    Ok(())
}
