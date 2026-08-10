//! 全屏静音检测：前台应用为全屏（游戏、全屏视频）时，快捷键与弹窗整体静音。
//!
//! 双路检测（Windows）：
//! 1. `SHQueryUserNotificationState` 返回 `QUNS_RUNNING_D3D_FULL_SCREEN` → 独占全屏（D3D 游戏）；
//! 2. 前台窗口 rect 完全覆盖所在显示器 rcMonitor → 无边框窗口全屏
//!    （无边框游戏、全屏视频）。最大化窗口用 `IsZoomed` 显式排除——
//!    副显示器无任务栏/任务栏自动隐藏时，最大化窗口的 rect 同样铺满整屏，
//!    仅靠矩形比较会把普通窗口误判为全屏。
//!
//! 检测是实时的：每次 should_mute 调用直接查 Win32 API（毫秒级），
//! 无需轮询线程，也没有「进入/退出全屏」的状态同步窗口。

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager};

/// 全屏静音状态：enabled 是设置开关（运行时由设置页切换）。
pub struct GameModeState {
    enabled: AtomicBool,
}

impl GameModeState {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled: AtomicBool::new(enabled),
        }
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }
}

/// 当前是否应静音：开关开启 且 前台为全屏应用。
/// 供快捷键回调与浮窗展示处查询，无锁，可在任意线程安全调用。
pub fn should_mute(app_handle: &AppHandle) -> bool {
    match app_handle.try_state::<GameModeState>() {
        Some(state) if state.is_enabled() => is_fullscreen_foreground(),
        _ => false,
    }
}

/// 检测前台窗口是否为全屏（Windows）。
#[cfg(target_os = "windows")]
pub fn is_fullscreen_foreground() -> bool {
    use windows::Win32::Foundation::RECT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows::Win32::UI::Shell::{SHQueryUserNotificationState, QUNS_RUNNING_D3D_FULL_SCREEN};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowRect, IsZoomed,
    };

    unsafe {
        // 1. 独占全屏（D3D 游戏独占模式）
        if let Ok(state) = SHQueryUserNotificationState() {
            if state == QUNS_RUNNING_D3D_FULL_SCREEN {
                return true;
            }
        }

        // 2. 无边框全屏：前台窗口 rect 完全覆盖所在显示器（含任务栏区域）
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return false;
        }

        // 最大化窗口（WM_MAXIMIZE）不是全屏：副屏无任务栏/任务栏自动隐藏时
        // 其 rect 与显示器一致，必须显式排除，否则普通窗口会被误判为全屏。
        // 无边框全屏窗口从不处于最大化状态，此检查不影响真全屏的识别。
        if IsZoomed(hwnd).as_bool() {
            return false;
        }

        // 桌面本体（Progman/WorkerW）不是全屏应用：Win+D 后它是前台窗口，
        // 单屏时 rect 恰好等于显示器矩形，必须按窗口类名排除。
        let mut class_buf = [0u16; 256];
        let class_len = GetClassNameW(hwnd, &mut class_buf);
        if class_len > 0 {
            let class_name = String::from_utf16_lossy(&class_buf[..class_len as usize]);
            if class_name == "Progman" || class_name == "WorkerW" {
                return false;
            }
        }

        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return false;
        }

        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        if monitor.0.is_null() {
            return false;
        }

        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        // GetMonitorInfoW 返回裸 BOOL（非 Result），失败（0）按非全屏处理
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return false;
        }

        let m = info.rcMonitor;

        // 窗口必须完全覆盖显示器（含任务栏区域）——无边框全屏的标志
        let covers_monitor = rect.left <= m.left
            && rect.top <= m.top
            && rect.right >= m.right
            && rect.bottom >= m.bottom;
        if !covers_monitor {
            return false;
        }

        // 尺寸需与显示器基本一致（±5%）：排除虚拟屏矩形（多屏桌面 Win+D）与
        // 跨屏窗口——它们的 rect 比单个显示器大得多，不是单屏全屏。
        let win_w = rect.right - rect.left;
        let win_h = rect.bottom - rect.top;
        let mon_w = m.right - m.left;
        let mon_h = m.bottom - m.top;
        let w_ratio = win_w as f64 / mon_w as f64;
        let h_ratio = win_h as f64 / mon_h as f64;
        w_ratio <= 1.05 && h_ratio <= 1.05
    }
}

#[cfg(not(target_os = "windows"))]
pub fn is_fullscreen_foreground() -> bool {
    false
}
