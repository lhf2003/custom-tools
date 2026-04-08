use serde::{Deserialize, Serialize};

/// 截图模式
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ScreenshotMode {
    FullScreen,
    Window,
    Region,
}

impl std::fmt::Display for ScreenshotMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ScreenshotMode::FullScreen => write!(f, "full"),
            ScreenshotMode::Window => write!(f, "window"),
            ScreenshotMode::Region => write!(f, "region"),
        }
    }
}

/// 截图结果（简化版，不包含数据库ID）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotResult {
    pub filename: String,
    pub filepath: String,
    pub mode: ScreenshotMode,
    pub width: u32,
    pub height: u32,
}

/// 窗口信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub id: u64,
    pub title: String,
    pub app_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>, // base64 缩略图
}

/// 绘制元素类型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DrawElement {
    Rect {
        id: String,
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        color: String,
        stroke_width: f32,
    },
    Arrow {
        id: String,
        x1: f32,
        y1: f32,
        x2: f32,
        y2: f32,
        color: String,
        stroke_width: f32,
    },
    Line {
        id: String,
        x1: f32,
        y1: f32,
        x2: f32,
        y2: f32,
        color: String,
        stroke_width: f32,
    },
    Text {
        id: String,
        x: f32,
        y: f32,
        text: String,
        color: String,
        font_size: f32,
    },
    Mosaic {
        id: String,
        x: f32,
        y: f32,
        width: f32,
        height: f32,
        block_size: u32,
    },
    Spotlight {
        id: String,
        x: f32,
        y: f32,
        radius: f32,
    },
}

/// 矩形区域
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// OCR 请求参数
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrRequest {
    pub screenshot_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// OCR 响应结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrResult {
    pub text: String,
    pub model: String,
    pub processed_at: String,
}

/// 窗口边界信息（用于截图遮罩窗口检测）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub id: u64,              // 窗口 ID
    pub title: String,        // 窗口标题
    pub app_name: String,     // 应用名称
    pub x: i32,               // 左上角 X
    pub y: i32,               // 左上角 Y
    pub width: u32,           // 宽度
    pub height: u32,          // 高度
    pub is_minimized: bool,   // 是否最小化
}

/// 选区来源
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SelectionSource {
    Window {
        window_id: u64,
        title: String,
    },
    Region,
}

/// 选区信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub source: SelectionSource,
}
