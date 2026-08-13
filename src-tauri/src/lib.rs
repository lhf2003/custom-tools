use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;

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
pub mod game_mode;
pub mod http;
pub mod llm;
pub mod llm_provider;
pub mod moss;
pub mod notes;
pub mod password;
pub mod search;
pub mod settings;
pub mod translate;
pub mod voice;

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
            // 统一 HTTP 客户端工厂：系统代理开关在 build_client 中读取（MCP 模式无 setup，句柄缺失时退化直连）
            http::init(app.handle().clone());

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

            // 内置历史更新日志（幂等，仅补缺失版本）
            if let Err(e) = commands::changelog::seed_history(app.handle()) {
                log::warn!("Failed to seed changelog history: {e}");
            }

            // Initialize pending update cache (populated by check_for_update)
            app.manage(commands::updater::PendingUpdate(Mutex::new(None)));

            // Initialize settings manager first (needed by window handlers)
            // 设置/快捷键与主库共用一个 flowhub.db（settings/shortcuts 两张表）
            let main_db_path = app
                .path()
                .app_data_dir()
                .unwrap()
                .join(DB_FILE_NAME)
                .to_string_lossy()
                .to_string();
            let settings_manager = settings::SettingsManager::new(main_db_path.clone());

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

            // 全屏静音状态（游戏/全屏视频时禁用快捷键与弹窗），开关随设置持久化
            app.manage(game_mode::GameModeState::new(settings.game_mode_mute));

            // 调试模式：恢复运行时日志级别闸门（prompt 日志等 debug 级输出的总开关）
            apply_log_level(settings.debug_mode);

            // Initialize shortcut manager（与主库共用 flowhub.db）
            let shortcut_manager = settings::ShortcutManager::new(main_db_path);

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
                        // 全量扫描不持锁(可能极慢),完成后再短暂持锁交换结果。
                        // 扫描前先在锁内置 scanning 标记,让线程 B 知道"扫描进行中"
                        // 应等待而非并发扫描。
                        if let Ok(mut idx) = search_index_for_init.lock() {
                            idx.begin_scan();
                        }
                        match search::SearchIndex::collect_all_apps(&Some(db_state_for_init)) {
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
                                log::warn!("Background initial app indexing failed: {}", e);
                                // 清除扫描标记,让线程 B 可以兜底扫描
                                if let Ok(mut idx) = search_index_for_init.lock() {
                                    idx.abort_scan();
                                }
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

            // 启动期索引兜底线程（防缓存过期 + 兜底全量扫描）。
            // 职责按场景区分，避免 Registry/UWP 扫描执行两次：
            // 1. 线程 A 正在扫描（scanning=true）→ 等待其完成，不并发扫描；
            // 2. 缓存已就绪且新鲜（<24h）→ 跳过；
            // 3. 缓存已就绪但陈旧（≥24h）→ 后台刷新一次——Registry/UWP 应用
            //    增删只能靠全量扫描感知（watcher 只监听 .lnk），必须保留这条路径；
            // 4. 线程 A 从未开始/已失败（indexed=false 且不在扫描）→ 兜底全量扫描。
            let search_index_for_refresh = search_index_arc.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(2)); // Wait 2 seconds after startup

                // 等待线程 A 的扫描结束：500ms 轮询一次，最多 60 次（30s）。
                // 超时是极端慢速环境的兜底——此时自己扫描避免索引永远为空。
                let mut waited = 0u32;
                loop {
                    let scanning = match search_index_for_refresh.lock() {
                        Ok(idx) => idx.is_scanning(),
                        Err(e) => {
                            log::error!("Search index lock poisoned: {}", e);
                            return;
                        }
                    };
                    if !scanning {
                        break;
                    }
                    waited += 1;
                    if waited >= 60 {
                        log::error!(
                            "Initial indexing still in progress after 30s, falling back to own scan"
                        );
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }

                let mut idx = match search_index_for_refresh.lock() {
                    Ok(idx) => idx,
                    Err(e) => {
                        log::error!("Search index lock poisoned: {}", e);
                        return;
                    }
                };
                if idx.is_indexed() {
                    if idx.is_cache_fresh() {
                        log::info!("Index ready and cache fresh, skipping background refresh");
                        return;
                    }
                    log::info!("Cache is stale, refreshing applications in background");
                } else {
                    log::info!("Index not ready after initial indexing, falling back to full scan");
                }
                if let Err(e) = idx.refresh_in_background() {
                    log::warn!("Background refresh failed: {}", e);
                }
            });

            // Auto check for updates on startup (if enabled) - shown in the in-app UI
            {
                let app_handle = app.handle().clone();
                let settings_for_update = settings.clone();
                tauri::async_runtime::spawn(async move {
                    // Delay to avoid impacting startup performance
                    tokio::time::sleep(Duration::from_secs(5)).await;

                    // 优先完成上次「稍后安装」遗留的已下载更新（不依赖 auto_update：
                    // 用户已同意安装）。命中安装时进程直接退出，后续检查不再执行。
                    commands::updater::maybe_install_pending_update(&app_handle).await;

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

            // 预创建划词翻译浮窗（隐藏），降低触发时的弹出延迟。透明置顶无边框小窗，
            // 展示/定位逻辑在 translate 模块（get_cursor_pos + get_monitor_at_cursor）。
            {
                let translate_toast = tauri::WebviewWindowBuilder::new(
                    app,
                    "translate-toast",
                    tauri::WebviewUrl::App("/translate-toast.html".into()),
                )
                .title("划词翻译")
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .shadow(false)
                .focused(false)
                .resizable(false)
                .visible(false)
                .build();

                if let Err(e) = translate_toast {
                    log::warn!("Failed to pre-create translate toast window: {}", e);
                }
                app.manage(translate::PendingTranslateToast::default());
            }

            // 预创建全局语音输入浮窗（隐藏）:Ctrl+Alt+V 唤醒录音,范式同划词翻译浮窗
            voice::preload_window(app);
            app.manage(voice::VoiceToastState::default());

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
                app.manage(companion::suggester::PendingToastState::default());
                app.manage(companion::chat::JarvisChatChild::default());
                app.manage(companion::scene_chat::JarvisSceneChatState::default());
                app.manage(companion::websearch::WebSearchState::default());
            }

            // Moss 语音播报:当前播报句柄(音频流按次开关,跟随系统默认设备)
            app.manage(moss::tts::TtsState::new());

            log::info!("Application setup completed");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::asset::allow_asset_file,
            // Window commands
            commands::window::show_window,
            commands::window::hide_window,
            commands::window::toggle_window,
            commands::window::resize_window,
            commands::window::set_blur_hold,
            commands::clipboard::get_clipboard_history,
            commands::clipboard::get_app_icon,
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
            commands::clipboard::read_clipboard_text,
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
            commands::notes::format_note_content,
            commands::plugins::scan_plugins,
            commands::plugins::read_plugin_bundle,
            commands::plugins::uninstall_plugin,
            commands::plugins::sync_plugin_shortcuts,
            commands::plugins::update_plugin_shortcut,
            // 插件制作已迁聊天页工具链路（layout_ui/generate_plugin_chat 直接 fs 落盘）；
            // 保留安装/更新（PluginPreview 卡片 invoke 直调）与读文件（更新模式 prefill 组装）
            commands::plugin_gen::read_plugin_files,
            commands::plugin_gen::install_preview_plugin,
            commands::plugin_gen::update_plugin_from_preview,
            commands::plugin_gen::open_local_html,
            // 划词翻译
            translate::translate_text,
            translate::get_pending_translate_toast,
            translate::translate_toast_ready,
            commands::password::is_password_manager_unlocked,
            commands::password::unlock_password_manager,
            commands::password::lock_password_manager,
            commands::password::get_password_categories,
            commands::password::get_password_entries,
            commands::password::create_password_entry,
            commands::password::update_password_entry,
            commands::password::create_password_category,
            commands::password::delete_password_category,
            commands::password::get_decrypted_password,
            commands::password::delete_password_entry,
            commands::password::copy_password_to_clipboard,
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
            commands::settings::get_setting,
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
            commands::settings::toggle_debug_mode,
            commands::settings::toggle_game_mode_mute,
            commands::settings::validate_claude_cli,
            commands::settings::get_custom_scan_dirs,
            commands::settings::set_custom_scan_dirs,
            commands::system::open_external_url,
            commands::system::save_image_to_path,
            // Updater commands
            commands::updater::check_for_update,
            commands::updater::download_update,
            commands::updater::install_downloaded_update,
            // Changelog commands
            commands::changelog::add_changelog,
            commands::changelog::mark_all_changelogs_read,
            commands::changelog::check_version_changelog,
            commands::changelog::cleanup_old_changelogs,
            commands::changelog::sync_releases_changelog,
            commands::changelog::list_changelogs,
            commands::llm::test_llm_connection,
            commands::llm::call_llm_stream_by_scene,
            commands::llm::get_llm_call_stats,
            // Stats commands（设置页「统计」页签）
            commands::stats::get_llm_observability,
            commands::stats::get_llm_call_logs,
            commands::stats::get_llm_observe_options,
            commands::stats::get_local_data_stats,
            commands::stats::cleanup_app_logs,
            commands::stats::cleanup_icon_cache,
            commands::chat::create_chat_session,
            commands::chat::save_chat_message,
            commands::chat::get_session_messages,
            commands::chat::get_latest_session,
            commands::chat::list_chat_sessions,
            commands::chat::delete_chat_session,
            commands::chat::truncate_chat_after_last_user,
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
            // Moss 语音服务(Key 管理 + 音频转写)
            moss::moss_key_status,
            moss::moss_set_api_key,
            moss::moss_transcribe,
            // Moss 流式 TTS 播报
            moss::tts::moss_tts_speak,
            moss::tts::moss_tts_stop,
            // 全局语音输入浮窗
            voice::voice_take_pending_toggle,
            voice::voice_bar_ready,
            voice::voice_set_phase,
            voice::voice_send_to_chat,
            // Companion commands
            commands::companion::get_companion_suggestions,
            commands::companion::act_on_companion_suggestion,
            commands::companion::dismiss_companion_suggestion,
            commands::companion::get_pending_companion_toast,
            commands::companion::companion_toast_ready,
            commands::companion::get_app_cache_entries,
            commands::companion::update_app_cache_description,
            commands::companion::list_manuals,
            commands::companion::get_manual,
            commands::companion::save_manual,
            commands::companion::list_evolution_backups,
            commands::companion::rollback_evolution_backup,
            commands::companion::get_evolution_size,
            commands::companion::compact_evolution,
            commands::companion::get_companion_patterns,
            commands::companion::set_companion_pattern_status,
            commands::companion::get_companion_today_summary,
            commands::companion::clear_companion_activities,
            commands::companion::analyze_companion_now,
            commands::companion::run_companion_agent_now,
            commands::companion::create_companion_intent,
            commands::companion::list_memos,
            commands::companion::set_memo_status,
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
            companion::scene_chat::jarvis_chat_send_scene,
            companion::chat::jarvis_chat_cancel,
            companion::chat::jarvis_chat_reset,
            companion::chat::jarvis_agent_available,
            companion::chat::jarvis_chat_system,
            commands::companion::list_companion_tools,
            commands::companion::set_companion_tool_enabled,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 退出时整树清理搜索 daemon（cmd→npx→node，不杀会留孤儿进程）
            if matches!(event, tauri::RunEvent::Exit) {
                companion::websearch::shutdown_daemon(app_handle);
            }
        });
}

fn setup_window_handlers(app_handle: &tauri::AppHandle) {
    let window = app_handle.get_webview_window("main").unwrap();

    // Flag to prevent hide-on-blur immediately after showing window
    let ignore_blur = Arc::new(AtomicBool::new(false));
    let ignore_blur_clone = ignore_blur.clone();

    // 引导教学等场景的显式失焦挂起（前端 set_blur_hold 开/关）：
    // 与上方 300ms 定时 ignore 正交，避免定时线程提前复位教学挂起
    let blur_hold = Arc::new(AtomicBool::new(false));
    let blur_hold_clone = blur_hold.clone();

    // Hide window when it loses focus (if hide_on_blur is enabled)
    let app_handle_clone = app_handle.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(focused) = event {
            if !focused {
                // Skip if we're ignoring blur events (recently shown or explicitly held)
                if ignore_blur_clone.load(Ordering::Relaxed) || blur_hold_clone.load(Ordering::Relaxed) {
                    return;
                }

                // 拖拽窗口期间（左键按住）OS 会产生焦点抖动，这不是真实失焦。
                // 按住左键时用户不可能在点别的窗口，直接跳过，避免窗口被拖没。
                #[cfg(windows)]
                {
                    use windows::Win32::UI::Input::KeyboardAndMouse::{
                        GetAsyncKeyState, VK_LBUTTON,
                    };
                    if unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } < 0 {
                        return;
                    }
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
    app_handle.manage(WindowFocusState { ignore_blur, blur_hold });

    // 划词翻译浮窗：失焦即隐藏（点外部 = 看完译文走人）。窗口无边框透明，
    // 不做 ignore_blur 处理——浮窗必须即时响应失焦，否则会滞留在屏幕上。
    if let Some(toast) = app_handle.get_webview_window("translate-toast") {
        let toast_inner = toast.clone();
        toast.on_window_event(move |event| {
            if let tauri::WindowEvent::Focused(focused) = event {
                if !focused {
                    let _ = toast_inner.hide();
                }
            }
        });
    }
}

// State to track window focus behavior
pub struct WindowFocusState {
    ignore_blur: Arc<AtomicBool>,
    /// 显式失焦挂起（引导教学期间由前端开/关）；内存态不落盘，进程退出自然复位
    blur_hold: Arc<AtomicBool>,
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

    pub fn set_blur_hold(&self, hold: bool) {
        self.blur_hold.store(hold, Ordering::Relaxed);
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
        emit_window_shown(app_handle);
    }
}

/// 唤起窗口后统一通知前端（所有"窗口显示"路径的收口），并触发应用索引
/// 有效性校验——被删除的应用（含卸载的 Store 应用/绿色软件、删掉的快捷方式
/// 文件夹）在下次唤起时即从索引移除，不再依赖 24h 全量扫描兜底。
/// 校验在后台线程执行，不阻塞窗口显示与搜索。
pub(crate) fn emit_window_shown(app_handle: &tauri::AppHandle) {
    use tauri::Emitter;

    // 通知前端窗口已唤起（用于重置启动器搜索状态）
    let _ = app_handle.emit("window:shown", ());

    if let Some(state) = app_handle.try_state::<commands::search::SearchState>() {
        commands::search::verify_app_index(commands::search::SearchState(state.0.clone()));
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
fn emit_check_result(app_handle: &tauri::AppHandle, result: commands::updater::UpdateCheckResult) {
    if let Err(e) = app_handle.emit("update-check-result", result) {
        log::warn!("Failed to emit update-check-result event: {}", e);
    }
}

/// Check for updates from tray menu — all results are shown in the in-app UI
async fn check_update_from_tray(app_handle: tauri::AppHandle) {
    let app_version = app_handle.package_info().version.clone();

    // build_updater 附加系统代理（插件注册的 client 直连，不读代理）
    let updater = match commands::updater::build_updater(&app_handle) {
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

            // 重写下载 URL（关代理走镜像）+ 缓存 + 构造展示信息（与命令/启动路径共用）
            let update_info = commands::updater::cache_update(&app_handle, update);

            // Show main window so user can see the update UI
            show_main_window(&app_handle);

            // Emit event to frontend to show update UI
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

    let updater = match commands::updater::build_updater(&app_handle) {
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

            // 重写下载 URL（关代理走镜像）+ 缓存 + 构造展示信息（与命令/托盘路径共用）
            let update_info = commands::updater::cache_update(&app_handle, update);

            // Show main window so user can see the update UI
            show_main_window(&app_handle);

            // Emit event to frontend to show update UI
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

/// 运行时日志级别闸门：调试模式开 = Debug（含 prompt 日志），关 = Info。
/// log crate 的全局 max_level 是唯一闸门——插件（build_log_plugin）级别恒为
/// Debug，不再做第二道过滤，否则 release 构建会把 debug 记录丢弃在插件内部。
pub fn apply_log_level(debug: bool) {
    log::set_max_level(if debug {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    });
}

/// 构建日志插件。日志目录用 TargetKind::LogDir(Tauri 自动解析
/// app_log_dir,Windows 上为 %LOCALAPPDATA%\<identifier>\logs,
/// 注意是 Local 不是 Roaming %APPDATA%),
/// 插件注册在 Builder 链前部,保证后续所有初始化阶段的日志都能落盘。
///
/// 插件过滤级别恒为 Debug——真正的开关是运行时 apply_log_level(settings.debug_mode)
/// 的全局闸门。若此处用 cfg!(debug_assertions) 区分，release 构建的 fern dispatch
/// 会以 Info 丢弃 debug 记录（插件内部有独立于 log crate 的第二道过滤），
/// 导致安装版设置里开调试模式也无 debug 日志落盘。
/// debug_mode 默认 false 时全局闸门为 Info，log::debug! 在宏内短路，敏感日志不落盘。
fn build_log_plugin() -> tauri_plugin_log::Builder {
    let log_level = log::LevelFilter::Debug;

    tauri_plugin_log::Builder::default()
        .targets([
            tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
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
        // 目录必须与日志插件(TargetKind::LogDir → %LOCALAPPDATA%\<identifier>\logs)
        // 一致——旧实现用 dirs::data_dir() 推导到 %APPDATA%(Roaming),panic.log
        // 与主日志分处两处,且不在 cleanup_old_logs 的清理范围内。
        let base_dir = std::env::var("LOCALAPPDATA")
            .ok()
            .map(std::path::PathBuf::from)
            .or_else(dirs::data_dir);
        if let Some(base_dir) = base_dir {
            let logs_dir = base_dir.join(APP_DIR_NAME).join("logs");
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
