use crate::protocol::*;
use base64::Engine;
use image::RgbaImage;
use xcap::{Monitor, Window};

/// 枚举所有显示器
pub fn list_monitors() -> Result<Vec<MonitorInfo>, String> {
    let monitors = Monitor::all().map_err(|e| format!("枚举显示器失败: {e}"))?;
    let mut result = Vec::new();
    for (i, m) in monitors.iter().enumerate() {
        result.push(MonitorInfo {
            id: i as u32,
            name: m.name().unwrap_or_else(|_| format!("Display {}", i + 1)),
            width: m.width().unwrap_or(0),
            height: m.height().unwrap_or(0),
            x: m.x().unwrap_or(0),
            y: m.y().unwrap_or(0),
            scale_factor: m.scale_factor().unwrap_or(1.0),
            is_primary: m.is_primary().unwrap_or(false),
        });
    }
    Ok(result)
}

/// 截取全屏 (指定显示器或主显示器)
pub fn capture_fullscreen(monitor_id: Option<u32>) -> Result<String, String> {
    let monitors = Monitor::all().map_err(|e| format!("枚举显示器失败: {e}"))?;

    let monitor = if let Some(id) = monitor_id {
        monitors.get(id as usize)
            .ok_or_else(|| format!("显示器 {} 不存在", id))?
    } else {
        // 默认取主显示器
        monitors.iter().find(|m| m.is_primary().unwrap_or(false))
            .or_else(|| monitors.first())
            .ok_or_else(|| "没有找到显示器".to_string())?
    };

    let img = monitor.capture_image().map_err(|e| format!("截屏失败: {e}"))?;

    // 存到临时文件
    let tmp = tempfile::Builder::new()
        .prefix("mtools-screenshot-")
        .suffix(".png")
        .tempfile()
        .map_err(|e| format!("创建临时文件失败: {e}"))?;
    let path = tmp.path().to_string_lossy().to_string();
    // 保持临时文件不被删除
    tmp.keep().map_err(|e| format!("保持临时文件失败: {e}"))?;

    img.save(&path).map_err(|e| format!("保存截图失败: {e}"))?;
    Ok(path)
}

/// 直接截取显示器上指定区域（先截全屏再裁剪，得到该区域的实时画面）
pub fn capture_screen_region(params: crate::protocol::CaptureScreenRegionParams) -> Result<String, String> {
    let img = capture_fullscreen(params.monitor_id)?;
    let img = ::image::open(&img).map_err(|e| format!("打开截图失败: {e}"))?;
    let cropped = img.crop_imm(params.x, params.y, params.width, params.height);
    let tmp = tempfile::Builder::new()
        .prefix("mtools-region-")
        .suffix(".png")
        .tempfile()
        .map_err(|e| format!("创建临时文件失败: {e}"))?;
    let path = tmp.path().to_string_lossy().to_string();
    tmp.keep().map_err(|e| format!("保持临时文件失败: {e}"))?;
    cropped.save(&path).map_err(|e| format!("保存区域截图失败: {e}"))?;
    Ok(path)
}

/// 枚举所有窗口
pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    let windows = Window::all().map_err(|e| format!("枚举窗口失败: {e}"))?;
    let mut result = Vec::new();

    for w in windows {
        let title = w.title().unwrap_or_default();
        let app_name = w.app_name().unwrap_or_default();

        // 跳过无标题和特殊窗口
        if title.is_empty() && app_name.is_empty() {
            continue;
        }

        // 跳过自身
        if app_name == "51ToolBox" || app_name == "mTools" || app_name == "screen-capture-helper" {
            continue;
        }

        let width = w.width().unwrap_or(0);
        let height = w.height().unwrap_or(0);
        // 跳过太小的窗口
        if width < 100 || height < 100 {
            continue;
        }

        // 生成缩略图 (max 200px 宽)
        let thumbnail = match w.capture_image() {
            Ok(img) => {
                let thumb = create_thumbnail(&img, 200);
                let mut buf = Vec::new();
                let encoder = ::image::codecs::png::PngEncoder::new(&mut buf);
                if ::image::ImageEncoder::write_image(
                    encoder,
                    thumb.as_raw(),
                    thumb.width(),
                    thumb.height(),
                    ::image::ExtendedColorType::Rgba8,
                ).is_ok() {
                    Some(base64::engine::general_purpose::STANDARD.encode(&buf))
                } else {
                    None
                }
            }
            Err(_) => None,
        };

        result.push(WindowInfo {
            id: w.id().unwrap_or(0) as u64,
            title,
            app_name,
            x: w.x().unwrap_or(0),
            y: w.y().unwrap_or(0),
            width,
            height,
            thumbnail,
        });
    }
    Ok(result)
}

/// 裁剪区域
pub fn crop_region(params: CropRegionParams) -> Result<String, String> {
    let img = ::image::open(&params.image_path)
        .map_err(|e| format!("打开图片失败: {e}"))?;
    let cropped = img.crop_imm(params.x, params.y, params.width, params.height);

    let out_path = format!(
        "{}-cropped.png",
        params.image_path.trim_end_matches(".png")
    );
    cropped.save(&out_path).map_err(|e| format!("保存裁剪图失败: {e}"))?;
    Ok(out_path)
}

/// 截取指定窗口
pub fn capture_window(window_id: u64) -> Result<String, String> {
    let windows = Window::all().map_err(|e| format!("枚举窗口失败: {e}"))?;
    let window = windows.into_iter()
        .find(|w| w.id().ok().map(|id| id as u64) == Some(window_id))
        .ok_or_else(|| format!("窗口 {} 不存在", window_id))?;

    let img = window.capture_image().map_err(|e| format!("截取窗口失败: {e}"))?;

    let tmp = tempfile::Builder::new()
        .prefix("mtools-window-")
        .suffix(".png")
        .tempfile()
        .map_err(|e| format!("创建临时文件失败: {e}"))?;
    let path = tmp.path().to_string_lossy().to_string();
    tmp.keep().map_err(|e| format!("保持临时文件失败: {e}"))?;

    img.save(&path).map_err(|e| format!("保存截图失败: {e}"))?;
    Ok(path)
}

/// 生成缩略图
fn create_thumbnail(img: &RgbaImage, max_width: u32) -> RgbaImage {
    let (w, h) = (img.width(), img.height());
    if w <= max_width {
        return img.clone();
    }
    let scale = max_width as f32 / w as f32;
    let new_w = max_width;
    let new_h = (h as f32 * scale) as u32;
    ::image::imageops::resize(img, new_w, new_h, ::image::imageops::FilterType::Triangle)
}
