use std::fs::File;
use std::io::BufWriter;

/// 保存图片为指定格式
pub fn save_image(
    source_path: &str,
    target_path: &str,
    format: &str,
    quality: Option<u8>,
    _pdf_mode: Option<&str>,
) -> Result<(), String> {
    match format {
        "png" => save_as_png(source_path, target_path),
        "jpeg" | "jpg" => save_as_jpeg(source_path, target_path, quality.unwrap_or(90)),
        "pdf" => save_as_pdf(source_path, target_path),
        _ => Err(format!("不支持的格式: {}", format)),
    }
}

fn save_as_png(source: &str, target: &str) -> Result<(), String> {
    if source == target {
        return Ok(());
    }
    std::fs::copy(source, target).map_err(|e| format!("复制文件失败: {e}"))?;
    Ok(())
}

fn save_as_jpeg(source: &str, target: &str, quality: u8) -> Result<(), String> {
    let img = ::image::open(source).map_err(|e| format!("打开图片失败: {e}"))?;
    let rgb = img.to_rgb8();
    let file = File::create(target).map_err(|e| format!("创建文件失败: {e}"))?;
    let mut buf = BufWriter::new(file);
    let encoder = ::image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
    ::image::ImageEncoder::write_image(
        encoder,
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        ::image::ExtendedColorType::Rgb8,
    )
    .map_err(|e| format!("JPEG 编码失败: {e}"))?;
    Ok(())
}

fn save_as_pdf(_source: &str, _target: &str) -> Result<(), String> {
    Err("PDF 导出暂未实现，请使用 PNG 或 JPEG 格式".to_string())
}
