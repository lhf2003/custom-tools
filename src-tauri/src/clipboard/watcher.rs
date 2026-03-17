use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc::Sender;

use windows::Win32::Foundation::{HGLOBAL, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::DataExchange::{
    AddClipboardFormatListener, CloseClipboard, GetClipboardData, OpenClipboard,
    RemoveClipboardFormatListener,
};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
    PostQuitMessage, RegisterClassW, TranslateMessage, CS_HREDRAW, CS_VREDRAW,
    MSG, WM_CLIPBOARDUPDATE, WM_CREATE, WM_DESTROY, WNDCLASSW, WS_OVERLAPPEDWINDOW,
};

use super::{ClipboardContent, ClipboardEvent};

thread_local! {
    static CLIPBOARD_SENDER: RefCell<Option<Sender<ClipboardEvent>>> = RefCell::new(None);
}

/// Windows clipboard watcher using WM_CLIPBOARDUPDATE
pub struct ClipboardWatcher {
    sender: Sender<ClipboardEvent>,
    running: Arc<AtomicBool>,
    hwnd: Option<HWND>,
}

impl ClipboardWatcher {
    pub fn new(sender: Sender<ClipboardEvent>) -> anyhow::Result<Self> {
        Ok(Self {
            sender,
            running: Arc::new(AtomicBool::new(true)),
            hwnd: None,
        })
    }

    pub fn run(&mut self) -> anyhow::Result<()> {
        // Store sender in thread-local storage for window proc access
        CLIPBOARD_SENDER.with(|s| {
            *s.borrow_mut() = Some(self.sender.clone());
        });

        // Create a message-only window for clipboard notifications
        let hwnd = self.create_message_window()?;
        self.hwnd = Some(hwnd);

        // Register as clipboard format listener
        unsafe {
            AddClipboardFormatListener(hwnd)?;
        }

        log::info!("Clipboard watcher started");

        // Message loop
        let mut msg: MSG = unsafe { std::mem::zeroed() };

        loop {
            let result = unsafe { GetMessageW(&mut msg, None, 0, 0) };

            // 0 = WM_QUIT received, -1 = error
            if result.0 <= 0 {
                break;
            }

            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }

        // Cleanup
        unsafe {
            let _ = RemoveClipboardFormatListener(hwnd);
            let _ = DestroyWindow(hwnd);
        }

        // Clear thread-local sender
        CLIPBOARD_SENDER.with(|s| {
            s.borrow_mut().take();
        });

        log::info!("Clipboard watcher stopped");
        Ok(())
    }

    pub fn stop(&mut self) -> anyhow::Result<()> {
        self.running.store(false, Ordering::Relaxed);

        if let Some(_hwnd) = self.hwnd {
            unsafe {
                PostQuitMessage(0);
            }
        }

        Ok(())
    }

    fn create_message_window(&self) -> anyhow::Result<HWND> {
        let class_name = windows::core::w!("CustomToolsClipboardWindow");

        unsafe {
            let hinstance = GetModuleHandleW(None)?;

            let wndclass = WNDCLASSW {
                lpfnWndProc: Some(Self::window_proc),
                hInstance: hinstance.into(),
                lpszClassName: class_name,
                style: CS_HREDRAW | CS_VREDRAW,
                ..std::mem::zeroed()
            };

            RegisterClassW(&wndclass);

            let hwnd = CreateWindowExW(
                windows::Win32::UI::WindowsAndMessaging::WINDOW_EX_STYLE(0),
                class_name,
                windows::core::w!("ClipboardListener"),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                0,
                0,
                None,
                None,
                hinstance,
                None,
            );

            if hwnd.0 == 0 {
                return Err(anyhow::anyhow!("Failed to create window"));
            }

            Ok(hwnd)
        }
    }

    extern "system" fn window_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_CLIPBOARDUPDATE => {
                if let Err(e) = Self::handle_clipboard_update() {
                    log::error!("Failed to handle clipboard update: {}", e);
                }
                LRESULT(0)
            }
            WM_CREATE => LRESULT(0),
            WM_DESTROY => {
                unsafe { PostQuitMessage(0) };
                LRESULT(0)
            }
            _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
        }
    }

    fn handle_clipboard_update() -> anyhow::Result<()> {
        unsafe {
            log::info!("Clipboard update detected");

            // Open clipboard
            if let Err(e) = OpenClipboard(None) {
                log::error!("Failed to open clipboard: {:?}", e);
                return Err(e.into());
            }

            // Get clipboard data
            let result = Self::read_clipboard_content();

            // Always close clipboard
            let _ = CloseClipboard();

            match result {
                Ok(content) => {
                    log::info!("Clipboard content read successfully");
                    CLIPBOARD_SENDER.with(|sender| {
                        if let Some(sender) = sender.borrow().as_ref() {
                            let event = ClipboardEvent {
                                content,
                                source_app: None,
                            };
                            if let Err(e) = sender.try_send(event) {
                                log::error!("Failed to send clipboard event: {}", e);
                            } else {
                                log::info!("Clipboard event sent successfully");
                            }
                        } else {
                            log::error!("No clipboard sender available");
                        }
                    });
                }
                Err(e) => {
                    log::warn!("Failed to read clipboard content: {}", e);
                }
            }

            Ok(())
        }
    }

    /// Read DIB (Device Independent Bitmap) data from clipboard and convert to PNG
    unsafe fn read_dib_data(ptr: *mut std::ffi::c_void) -> anyhow::Result<Vec<u8>> {
        use std::slice;

        // BITMAPINFOHEADER structure
        #[repr(C)]
        struct BITMAPINFOHEADER {
            biSize: u32,
            biWidth: i32,
            biHeight: i32,
            biPlanes: u16,
            biBitCount: u16,
            biCompression: u32,
            biSizeImage: u32,
            biXPelsPerMeter: i32,
            biYPelsPerMeter: i32,
            biClrUsed: u32,
            biClrImportant: u32,
        }

        let header = &*(ptr as *const BITMAPINFOHEADER);

        let width = header.biWidth as u32;
        let height = header.biHeight.abs() as u32;
        let bit_count = header.biBitCount as u32;
        let row_size = ((width * bit_count + 31) / 32) * 4; // DWORD aligned

        log::debug!("DIB: {}x{} @ {} bits per pixel", width, height, bit_count);

        // Calculate offset to pixel data (after header and color table)
        let header_size = header.biSize as usize;
        let color_table_size = if header.biClrUsed > 0 {
            header.biClrUsed as usize * 4
        } else if bit_count <= 8 {
            (1usize << bit_count) * 4
        } else {
            0
        };

        let pixel_data_offset = header_size + color_table_size;
        let pixel_data_ptr = (ptr as *const u8).add(pixel_data_offset);
        let image_size = (row_size * height) as usize;
        let pixel_data = slice::from_raw_parts(pixel_data_ptr, image_size);

        // Convert to RGBA
        let mut rgba_data = Vec::with_capacity((width * height * 4) as usize);

        // DIB is bottom-up by default (negative height means top-down)
        let is_top_down = header.biHeight < 0;

        for y in 0..height {
            let src_y = if is_top_down { y } else { height - 1 - y };
            let row_start = (src_y * row_size as u32) as usize;

            for x in 0..width {
                let pixel_offset = row_start + (x * (bit_count / 8)) as usize;

                if bit_count == 24 || bit_count == 32 {
                    let b = pixel_data[pixel_offset];
                    let g = pixel_data[pixel_offset + 1];
                    let r = pixel_data[pixel_offset + 2];
                    let a = if bit_count == 32 {
                        pixel_data[pixel_offset + 3]
                    } else {
                        255
                    };

                    rgba_data.push(r);
                    rgba_data.push(g);
                    rgba_data.push(b);
                    rgba_data.push(a);
                } else if bit_count == 16 {
                    // 16-bit RGB (5-6-5)
                    let pixel = pixel_data[pixel_offset] as u16
                        | ((pixel_data[pixel_offset + 1] as u16) << 8);
                    let r = ((pixel >> 11) & 0x1F) as u8 * 8;
                    let g = ((pixel >> 5) & 0x3F) as u8 * 4;
                    let b = (pixel & 0x1F) as u8 * 8;
                    rgba_data.push(r);
                    rgba_data.push(g);
                    rgba_data.push(b);
                    rgba_data.push(255);
                }
            }
        }

        // Encode as PNG using image crate
        let image = image::RgbaImage::from_raw(width, height, rgba_data)
            .ok_or_else(|| anyhow::anyhow!("Failed to create image from raw data"))?;

        let mut png_data = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut png_data);
            image::DynamicImage::ImageRgba8(image)
                .write_to(&mut std::io::BufWriter::new(cursor), image::ImageFormat::Png)?;
        }

        log::info!("Image converted to PNG: {} bytes", png_data.len());
        Ok(png_data)
    }

    unsafe fn read_clipboard_content() -> anyhow::Result<ClipboardContent> {
        use windows::Win32::Foundation::HANDLE;

        log::info!("Reading clipboard content, checking available formats...");

        // CF_UNICODETEXT = 13
        const CF_UNICODETEXT: u32 = 13;

        // Try text content first (most common)
        let text_handle: Result<HANDLE, _> = GetClipboardData(CF_UNICODETEXT);
        let has_text = text_handle.as_ref().map(|h| !h.is_invalid()).unwrap_or(false);
        log::info!("CF_UNICODETEXT (13): available={}", has_text);

        if let Ok(handle) = text_handle {
            if !handle.is_invalid() {
                let hglobal = HGLOBAL(handle.0 as *mut std::ffi::c_void);
                let ptr = GlobalLock(hglobal);
                if !ptr.is_null() {
                    let size = GlobalSize(hglobal);
                    log::debug!("Text data size: {} bytes", size);
                    let wide_slice = std::slice::from_raw_parts(ptr as *const u16, size / 2);
                    let len = wide_slice
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(wide_slice.len());
                    let text = String::from_utf16_lossy(&wide_slice[..len]);
                    let _ = GlobalUnlock(hglobal);

                    if !text.trim().is_empty() {
                        log::info!("Text content read: {} chars", text.len());
                        return Ok(ClipboardContent::Text(text));
                    }
                }
            }
        }

        log::info!("No text found, checking for image formats...");

        // Check for files (CF_HDROP)
        const CF_HDROP: u32 = 15;
        let hdrop_handle: Result<HANDLE, _> = GetClipboardData(CF_HDROP);
        log::info!("CF_HDROP (15): available={}", hdrop_handle.as_ref().map(|h| !h.is_invalid()).unwrap_or(false));

        if let Ok(handle) = hdrop_handle {
            if !handle.is_invalid() {
                log::info!("File list in clipboard detected (not yet implemented)");
            }
        }

        // Check for bitmap/image (CF_DIB - Device Independent Bitmap is preferred over CF_BITMAP)
        const CF_DIB: u32 = 8;
        let dib_handle: Result<HANDLE, _> = GetClipboardData(CF_DIB);
        let has_dib = dib_handle.as_ref().map(|h| !h.is_invalid()).unwrap_or(false);
        log::info!("CF_DIB (8): available={}", has_dib);

        if let Ok(handle) = dib_handle {
            if !handle.is_invalid() {
                log::info!("CF_DIB handle acquired, attempting to read...");
                let hglobal = HGLOBAL(handle.0 as *mut std::ffi::c_void);
                let ptr = GlobalLock(hglobal);
                if !ptr.is_null() {
                    log::info!("DIB data locked, processing...");
                    let result = Self::read_dib_data(ptr);
                    let _ = GlobalUnlock(hglobal);
                    match result {
                        Ok(image_data) => {
                            log::info!("DIB data converted successfully: {} bytes", image_data.len());
                            return Ok(ClipboardContent::Image(image_data));
                        }
                        Err(e) => {
                            log::error!("Failed to convert DIB data: {}", e);
                        }
                    }
                } else {
                    log::error!("GlobalLock returned null for DIB data");
                }
            } else {
                log::info!("CF_DIB handle is invalid");
            }
        }

        // Fallback to CF_BITMAP if CF_DIB is not available
        const CF_BITMAP: u32 = 2;
        let bitmap_handle: Result<HANDLE, _> = GetClipboardData(CF_BITMAP);
        let has_bitmap = bitmap_handle.as_ref().map(|h| !h.is_invalid()).unwrap_or(false);
        log::info!("CF_BITMAP (2): available={}", has_bitmap);

        if let Ok(handle) = bitmap_handle {
            if !handle.is_invalid() {
                log::info!("CF_BITMAP detected but not implemented");
            }
        }

        // Try CF_DIBV5 (V5 bitmap format used by some apps)
        const CF_DIBV5: u32 = 17;
        let dibv5_handle: Result<HANDLE, _> = GetClipboardData(CF_DIBV5);
        let has_dibv5 = dibv5_handle.as_ref().map(|h| !h.is_invalid()).unwrap_or(false);
        log::info!("CF_DIBV5 (17): available={}", has_dibv5);

        if let Ok(handle) = dibv5_handle {
            if !handle.is_invalid() {
                log::info!("CF_DIBV5 handle acquired (not yet implemented)");
            }
        }

        Err(anyhow::anyhow!("No supported content in clipboard"))
    }
}
