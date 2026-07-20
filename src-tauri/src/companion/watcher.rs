use std::sync::mpsc::Sender;
use std::time::Duration;

/// 一次前台窗口采样结果
#[derive(Debug, Clone)]
pub struct ForegroundEvent {
    /// 进程可执行文件名（如 "Code.exe"）
    pub process_name: String,
    /// 窗口标题（可能为空）
    pub window_title: String,
    /// 采样时间（unix 秒）
    pub timestamp: i64,
    /// 用户距离上次输入的空闲秒数（用于 AFK 判定）
    pub idle_secs: u32,
}

/// 活跃窗口 watcher：每 POLL_INTERVAL 轮询一次前台窗口。
///
/// 技术选型说明：用轮询而非 SetWinEventHook——
/// EVENT_SYSTEM_FOREGROUND 只在窗口切换时触发，捕获不到同一窗口内的标题变化
/// （典型如浏览器标签页切换）；3 秒轮询两者都能覆盖，且无需消息循环，更简单安全。
pub struct WindowWatcher {
    sender: Sender<ForegroundEvent>,
}

const POLL_INTERVAL: Duration = Duration::from_secs(3);

impl WindowWatcher {
    pub fn new(sender: Sender<ForegroundEvent>) -> Self {
        Self { sender }
    }

    pub fn run(&self) {
        log::info!("Companion window watcher started (poll every {}s)", POLL_INTERVAL.as_secs());
        loop {
            if let Some(event) = poll_foreground() {
                if self.sender.send(event).is_err() {
                    log::info!("Companion window watcher: receiver dropped, stopping");
                    break;
                }
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }
}

#[cfg(windows)]
fn poll_foreground() -> Option<ForegroundEvent> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

    let hwnd: HWND = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return None;
    }

    // 跳过本应用自身（启动器窗口不算用户工作环境）
    let pid = get_window_pid(hwnd)?;
    if pid == std::process::id() {
        return None;
    }

    let process_name = get_process_name(pid).unwrap_or_else(|| "unknown".to_string());
    let window_title = get_window_title(hwnd);
    let idle_secs = get_idle_secs();

    Some(ForegroundEvent {
        process_name,
        window_title,
        timestamp: chrono::Local::now().timestamp(),
        idle_secs,
    })
}

#[cfg(not(windows))]
fn poll_foreground() -> Option<ForegroundEvent> {
    None
}

#[cfg(windows)]
fn get_window_pid(hwnd: windows::Win32::Foundation::HWND) -> Option<u32> {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    let mut pid: u32 = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    if pid == 0 {
        None
    } else {
        Some(pid)
    }
}

#[cfg(windows)]
fn get_process_name(pid: u32) -> Option<String> {
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        );
        let _ = windows::Win32::Foundation::CloseHandle(handle);

        if result.is_err() || len == 0 {
            return None;
        }
        let full_path = String::from_utf16_lossy(&buf[..len as usize]);
        // 只保留文件名部分（如 "Code.exe"）
        let name = full_path
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or(&full_path)
            .to_string();
        Some(name)
    }
}

/// 读取窗口标题。用 SendMessageTimeoutW 而非 GetWindowTextW，
/// 避免目标窗口无响应时 WM_GETTEXT 永久阻塞本线程。
#[cfg(windows)]
fn get_window_title(hwnd: windows::Win32::Foundation::HWND) -> String {
    use windows::Win32::Foundation::WPARAM;
    use windows::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, SMTO_ABORTIFHUNG, WM_GETTEXT, WM_GETTEXTLENGTH,
    };

    const MAX_TITLE_LEN: usize = 512;

    unsafe {
        let mut len_result: usize = 0;
        let len = SendMessageTimeoutW(
            hwnd,
            WM_GETTEXTLENGTH,
            WPARAM(0),
            windows::Win32::Foundation::LPARAM(0),
            SMTO_ABORTIFHUNG,
            200,
            Some(&mut len_result),
        );
        if len.0 == 0 && len_result == 0 {
            return String::new();
        }

        let cap = (len_result + 1).min(MAX_TITLE_LEN);
        let mut buf = vec![0u16; cap];
        let mut copied: usize = 0;
        SendMessageTimeoutW(
            hwnd,
            WM_GETTEXT,
            WPARAM(cap),
            windows::Win32::Foundation::LPARAM(buf.as_mut_ptr() as isize),
            SMTO_ABORTIFHUNG,
            200,
            Some(&mut copied),
        );

        let text_len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..text_len])
    }
}

/// 用户空闲秒数（距离上次键鼠输入）
#[cfg(windows)]
fn get_idle_secs() -> u32 {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    unsafe {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut info).as_bool() {
            let tick = GetTickCount();
            // dwTime/tick 都是 u32，可能环绕，用 wrapping_sub 安全
            tick.wrapping_sub(info.dwTime) / 1000
        } else {
            0
        }
    }
}
