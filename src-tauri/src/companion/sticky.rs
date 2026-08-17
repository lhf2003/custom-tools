//! 桌面便签小窗：显示 pinned 备忘（可勾选完成），与主视图经 memo:changed 事件双向同步。
//! 施工规范（既有裁决）：capabilities 授予 event.listen；透明窗禁常驻阴影（前端只 border）；
//! data-tauri-drag-region 只挂头部小把手（挂根容器会杀死滚动）。

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

pub const STICKY_LABEL: &str = "memo-sticky";
const SETTING_ENABLED: &str = "memo_sticky.enabled";
const SETTING_POS: &str = "memo_sticky.pos";
const STICKY_W: f64 = 300.0;
const STICKY_H: f64 = 360.0;
/// 高度自适应钳制区间：下限保空态美观，上限超出后列表内部滚动
const STICKY_MIN_H: f64 = 160.0;
const STICKY_MAX_H: f64 = 480.0;

/// 预创建（隐藏）：与 toast 窗口同范式；显隐由启动恢复 / 菜单开关决定
pub fn preload_window(app: &AppHandle) {
    let result = WebviewWindowBuilder::new(
        app,
        STICKY_LABEL,
        WebviewUrl::App("/memo-sticky.html".into()),
    )
    .title("备忘便签")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false)
    .resizable(false)
    .inner_size(STICKY_W, STICKY_H)
    .visible(false)
    .build();
    if let Err(e) = result {
        log::warn!("Failed to pre-create memo sticky window: {}", e);
    }
}

fn read_setting(app: &AppHandle, key: &str) -> Option<String> {
    let state = app.try_state::<crate::commands::settings::SettingsState>()?;
    let manager = state.0.lock().ok()?;
    manager.get_setting(key).ok().flatten()
}

fn write_setting(app: &AppHandle, key: &str, value: &str) {
    if let Some(state) = app.try_state::<crate::commands::settings::SettingsState>() {
        if let Ok(manager) = state.0.lock() {
            let _ = manager.set_setting(key, value);
        }
    }
}

/// 上次拖拽落点（"x,y"）；没有则不挪（首次用系统默认位置）
fn saved_position(app: &AppHandle) -> Option<PhysicalPosition<i32>> {
    let raw = read_setting(app, SETTING_POS)?;
    let mut parts = raw.split(',');
    let x = parts.next()?.parse().ok()?;
    let y = parts.next()?.parse().ok()?;
    Some(PhysicalPosition::new(x, y))
}

fn show_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window(STICKY_LABEL) else {
        return;
    };
    if let Some(pos) = saved_position(app) {
        let _ = win.set_position(clamp_to_screen(app, &win, pos));
    }
    let _ = win.show();
}

/// 回放拖拽落点前按显示器钳制：外接屏拔除后落点可能出界，
/// 收拢到最近显示器的可视区内（右/下侧留出窗口自身尺寸）
fn clamp_to_screen(
    app: &AppHandle,
    win: &tauri::WebviewWindow,
    pos: PhysicalPosition<i32>,
) -> PhysicalPosition<i32> {
    let monitor = win
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| app.monitor_from_point(pos.x as f64, pos.y as f64).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return pos;
    };
    let scale = monitor.scale_factor();
    let win_size = win
        .outer_size()
        .unwrap_or(tauri::PhysicalSize::new(STICKY_W as u32, STICKY_H as u32));
    let w = (win_size.width as f64 * scale) as i32;
    let h = (win_size.height as f64 * scale) as i32;
    let mpos = *monitor.position();
    let msize = *monitor.size();
    let x = if msize.width as i32 <= w {
        mpos.x
    } else {
        pos.x.clamp(mpos.x, mpos.x + msize.width as i32 - w)
    };
    let y = if msize.height as i32 <= h {
        mpos.y
    } else {
        pos.y.clamp(mpos.y, mpos.y + msize.height as i32 - h)
    };
    PhysicalPosition::new(x, y)
}

/// 启动恢复：上次退出时便签开着则直接显示
pub fn restore_on_startup(app: &AppHandle) {
    if read_setting(app, SETTING_ENABLED).as_deref() == Some("1") {
        show_window(app);
    }
}

/// 显隐统一入口（nav 菜单开关 / 便签自己的关闭按钮）：
/// 落盘 + 显隐 + 广播（菜单文案跨窗口同步）
fn set_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    write_setting(app, SETTING_ENABLED, if enabled { "1" } else { "0" });
    if enabled {
        show_window(app);
    } else if let Some(win) = app.get_webview_window(STICKY_LABEL) {
        let _ = win.hide();
    }
    let _ = app.emit("memo-sticky:toggled", enabled);
    Ok(())
}

#[tauri::command]
pub fn set_memo_sticky_enabled(app_handle: AppHandle, enabled: bool) -> Result<(), String> {
    set_enabled(&app_handle, enabled)
}

/// 拖拽结束落点持久化（前端 tauri://move 节流上报）
#[tauri::command]
pub fn save_memo_sticky_position(app_handle: AppHandle, x: i32, y: i32) -> Result<(), String> {
    write_setting(&app_handle, SETTING_POS, &format!("{},{}", x, y));
    Ok(())
}

/// 高度随行数自适应：前端量出内容自然高度上报，这里钳制区间后调窗。
/// 宽度恒定 300；逻辑像素（前端 CSS px 即逻辑值，DPI 由 LogicalSize 承担）。
#[tauri::command]
pub fn set_memo_sticky_height(app_handle: AppHandle, height: f64) -> Result<(), String> {
    let Some(win) = app_handle.get_webview_window(STICKY_LABEL) else {
        return Ok(());
    };
    let h = height.clamp(STICKY_MIN_H, STICKY_MAX_H);
    win.set_size(tauri::Size::Logical(tauri::LogicalSize::new(STICKY_W, h)))
        .map_err(|e| format!("调整便签窗高度失败: {}", e))
}
