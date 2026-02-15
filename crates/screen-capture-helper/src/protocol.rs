use serde::{Deserialize, Serialize};
use serde_json::Value;

/// JSON-RPC 请求
#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// JSON-RPC 响应
#[derive(Debug, Serialize)]
pub struct Response {
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 推送事件 (id 为 null)，用于 JSON-RPC 事件推送
#[allow(dead_code)]
#[derive(Debug, Serialize)]
pub struct Event {
    pub id: Option<()>, // 始终序列化为 null
    pub event: String,
    pub data: Value,
}

impl Response {
    pub fn ok(id: u64, result: Value) -> Self {
        Self { id, result: Some(result), error: None }
    }
    pub fn err(id: u64, error: String) -> Self {
        Self { id, result: None, error: Some(error) }
    }
}

#[allow(dead_code)]
impl Event {
    pub fn new(event: &str, data: Value) -> Self {
        Self {
            id: None,
            event: event.to_string(),
            data,
        }
    }
}

// ===== 业务参数类型 =====

#[derive(Debug, Deserialize)]
pub struct CaptureFullscreenParams {
    pub monitor_id: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct CropRegionParams {
    pub image_path: String,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// 按屏幕/图像坐标截取显示器上的某一区域（先截全屏再裁剪，得到的是实时区域内容）
#[derive(Debug, Deserialize)]
pub struct CaptureScreenRegionParams {
    pub monitor_id: Option<u32>,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Deserialize)]
pub struct ScrollCaptureParams {
    pub window_id: Option<u64>,
    pub window_title: Option<String>,
    pub max_scrolls: Option<u32>,
    pub scroll_delay_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct SaveParams {
    pub source_path: String,
    pub target_path: String,
    pub format: String, // "png", "jpeg", "pdf"
    pub quality: Option<u8>, // JPEG quality 1-100
    pub pdf_mode: Option<String>, // "single_page" | "a4_paged"
}

#[derive(Debug, Deserialize)]
pub struct RecorderStartParams {
    pub target: RecordTarget,
    pub fps: Option<u32>,
    pub format: String, // "mp4" | "gif"
    pub output_path: Option<String>,
    pub max_width: Option<u32>, // GIF 最大宽度
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
#[allow(dead_code)] // Window/Region 变体字段待录屏实现时使用
pub enum RecordTarget {
    #[serde(rename = "fullscreen")]
    FullScreen { monitor_id: Option<u32> },
    #[serde(rename = "window")]
    Window { window_id: u64 },
    #[serde(rename = "region")]
    Region { x: i32, y: i32, width: u32, height: u32, monitor_id: Option<u32> },
}

// ===== 返回类型 =====

#[derive(Debug, Serialize)]
pub struct MonitorInfo {
    pub id: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub scale_factor: f32,
    pub is_primary: bool,
}

#[derive(Debug, Serialize)]
pub struct WindowInfo {
    pub id: u64,
    pub title: String,
    pub app_name: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub thumbnail: Option<String>, // base64 PNG
}
