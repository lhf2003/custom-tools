//! 全局语音输入:快捷键唤醒 → 顶部浮窗录音 → Moss 转写 → 三操作卡片。
//! 窗口范式同划词翻译浮窗:预创建隐藏 + 前端渲染回执再 show(透明窗严禁先 show 后
//! emit——事件即发即丢,透明窗滞留吞点击)。状态机在前端(idle/recording/transcribing/
//! result),Rust 只管窗口显隐、定位、尺寸与跨窗口中转。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

/// 浮窗 label(与 capabilities/voice-toast.json 一致)
const WINDOW_LABEL: &str = "voice-toast";
/// 录音条尺寸(图1/2 横条,逻辑像素)
const BAR_WIDTH: f64 = 248.0;
const BAR_HEIGHT: f64 = 44.0;
/// 完成卡片尺寸(图3 宽卡,逻辑像素;高度含底部快捷键提示条)
const CARD_WIDTH: f64 = 540.0;
const CARD_HEIGHT: f64 = 190.0;
/// 距显示器顶部的间距(逻辑像素)
const TOP_MARGIN: f64 = 80.0;

/// 页面就绪 + 待处理 toggle:预创建窗口的页面异步加载,首次快捷键可能早于
/// listen 就位——emit 丢了用 pending 兜底,页面挂载补拉。
#[derive(Default)]
pub struct VoiceToastState {
    page_ready: AtomicBool,
    pending_toggle: Mutex<bool>,
}

/// 预创建浮窗(lib.rs setup 调用);失败仅告警,快捷键触发时查无窗口自然空转。
/// 不设初始尺寸(与 companion/translate 浮窗完全同构):默认尺寸创建,
/// 就绪回执里 set_size(Physical) 到目标尺寸再 show——小尺寸创建 + transparent
/// 在 Windows 透明合成路径上与两浮窗存在差异,不做首个异类。
pub fn preload_window(app: &tauri::App) {
    let result = tauri::WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        tauri::WebviewUrl::App("/voice-toast.html".into()),
    )
    .title("语音输入")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .focused(false)
    .resizable(false)
    .visible(false)
    .build();

    if let Err(e) = result {
        log::warn!("Failed to pre-create voice toast window: {}", e);
    }
}

/// 定尺寸 + 顶部中央定位(鼠标所在显示器;companion 浮窗同套物理坐标算法)
fn place_window(window: &tauri::WebviewWindow, width: f64, height: f64) {
    let Some(monitor) = crate::get_monitor_at_cursor(window.app_handle()) else {
        return;
    };
    let scale = monitor.scale_factor();
    let pos = monitor.position();
    let size = monitor.size();
    let win_w = (width * scale) as i32;
    let win_h = (height * scale) as i32;
    let x = pos.x + (size.width as i32 - win_w) / 2;
    let y = pos.y + (TOP_MARGIN * scale) as i32;
    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
        width: win_w as u32,
        height: win_h as u32,
    }));
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x, y }));
}

/// 快捷键动作入口(voice_input):toggle 语义——开始/结束由前端按当前状态裁决。
pub fn toggle(app_handle: &AppHandle) {
    let Some(window) = app_handle.get_webview_window(WINDOW_LABEL) else {
        log::warn!("voice-toast 窗口不存在");
        return;
    };
    let page_ready = app_handle
        .try_state::<VoiceToastState>()
        .map(|s| s.page_ready.load(Ordering::SeqCst))
        .unwrap_or(false);
    if page_ready {
        let _ = window.emit("voice:toggle", ());
    } else {
        // 页面未就绪:emit 必丢,落 pending 等页面挂载补拉
        if let Some(state) = app_handle.try_state::<VoiceToastState>() {
            if let Ok(mut p) = state.pending_toggle.lock() {
                *p = true;
            }
        }
    }
}

/// 页面挂载补拉:pending toggle 存在则取走并返回 true(前端据此直接开始录音)
#[tauri::command]
pub fn voice_take_pending_toggle(state: tauri::State<'_, VoiceToastState>) -> bool {
    state.page_ready.store(true, Ordering::SeqCst);
    state
        .pending_toggle
        .lock()
        .map(|mut p| std::mem::take(&mut *p))
        .unwrap_or(false)
}

/// 录音条渲染回执(双 rAF 后):定尺寸 + 定位 + show + 抢焦点(Esc 取消依赖键盘焦点;
/// 被 Windows 焦点锁拦截则退化为点击浮窗后可键盘,同 companion 浮窗)。
#[tauri::command]
pub fn voice_bar_ready(app_handle: AppHandle) {
    if let Some(window) = app_handle.get_webview_window(WINDOW_LABEL) {
        place_window(&window, BAR_WIDTH, BAR_HEIGHT);
        if window.show().is_ok() {
            let _ = window.set_focus();
        }
    }
}

/// 形态切换:bar / card 两档尺寸,重定位保持顶部中央
#[tauri::command]
pub fn voice_set_phase(app_handle: AppHandle, phase: String) {
    let Some(window) = app_handle.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let (w, h) = if phase == "card" {
        (CARD_WIDTH, CARD_HEIGHT)
    } else {
        (BAR_WIDTH, BAR_HEIGHT)
    };
    place_window(&window, w, h);
}

/// 「发送给 AI 聊天」跨窗口中转:toast webview 与主窗 zustand 不共享,
/// 经 Rust 显示主窗并广播,主窗监听后填入并直接发送(语音场景零键盘)。
#[tauri::command]
pub fn voice_send_to_chat(app_handle: AppHandle, text: String) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("文本为空".to_string());
    }
    if let Some(window) = app_handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    crate::emit_window_shown(&app_handle);
    app_handle
        .emit("voice:chat_send", text)
        .map_err(|e| e.to_string())
}
