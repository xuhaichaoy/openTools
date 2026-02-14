use image::GenericImageView;
use printpdf::*;
use std::fs::File;
use std::io::BufWriter;

/// 保存图片为指定格式
pub fn save_image(
    source_path: &str,
    target_path: &str,
    format: &str,
    quality: Option<u8>,
    pdf_mode: Option<&str>,
) -> Result<(), String> {
    match format {
        "png" => save_as_png(source_path, target_path),
        "jpeg" | "jpg" => save_as_jpeg(source_path, target_path, quality.unwrap_or(90)),
        "pdf" => save_as_pdf(source_path, target_path, pdf_mode.unwrap_or("single_page")),
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
    let img = image::open(source).map_err(|e| format!("打开图片失败: {e}"))?;
    let rgb = img.to_rgb8();
    let file = File::create(target).map_err(|e| format!("创建文件失败: {e}"))?;
    let mut buf = BufWriter::new(file);
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
    image::ImageEncoder::write_image(
        encoder,
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    ).map_err(|e| format!("JPEG 编码失败: {e}"))?;
    Ok(())
}

fn save_as_pdf(source: &str, target: &str, mode: &str) -> Result<(), String> {
    let img = image::open(source).map_err(|e| format!("打开图片失败: {e}"))?;
    let rgb = img.to_rgb8();
    let (img_w, img_h) = (rgb.width(), rgb.height());

    match mode {
        "single_page" => save_pdf_single_page(&rgb, img_w, img_h, target),
        "a4_paged" => save_pdf_a4_paged(&rgb, img_w, img_h, target),
        _ => Err(format!("不支持的 PDF 模式: {}", mode)),
    }
}

/// 单页模式: 整张图放在一个页面中
fn save_pdf_single_page(
    rgb: &image::RgbImage,
    img_w: u32,
    img_h: u32,
    target: &str,
) -> Result<(), String> {
    // 页面宽度固定 210mm (A4 宽度), 高度按比例
    let page_width_mm = 210.0;
    let scale = page_width_mm / img_w as f32;
    let page_height_mm = img_h as f32 * scale;

    let page_w = Mm(page_width_mm as f64);
    let page_h = Mm(page_height_mm as f64);

    let (doc, page1, layer1) = PdfDocument::new("Screenshot", page_w, page_h, "Layer 1");
    let current_layer = doc.get_page(page1).get_layer(layer1);

    // 将 RGB 数据编码为 JPEG 用于嵌入 PDF (比原始 RGB 小很多)
    let jpeg_data = encode_jpeg(rgb, 90)?;

    let image = Image::from(ImageXObject {
        width: Px(img_w as usize),
        height: Px(img_h as usize),
        color_space: ColorSpace::Rgb,
        bits_per_component: ColorBits::Bit8,
        interpolate: true,
        image_data: jpeg_data,
        image_filter: Some(ImageFilter::DCT),
        clipping_bbox: None,
        smask: None,
    });

    let transform = ImageTransform {
        translate_x: Some(Mm(0.0)),
        translate_y: Some(Mm(0.0)),
        scale_x: Some(page_width_mm as f64),
        scale_y: Some(page_height_mm as f64),
        ..Default::default()
    };

    image.add_to_layer(current_layer, transform);

    doc.save(&mut BufWriter::new(
        File::create(target).map_err(|e| format!("创建 PDF 失败: {e}"))?
    )).map_err(|e| format!("保存 PDF 失败: {e}"))?;

    Ok(())
}

/// A4 分页模式: 按 A4 尺寸自动分页
fn save_pdf_a4_paged(
    rgb: &image::RgbImage,
    img_w: u32,
    img_h: u32,
    target: &str,
) -> Result<(), String> {
    let a4_w_mm = 210.0_f64;
    let a4_h_mm = 297.0_f64;

    // 计算缩放: 图片宽度缩放到 A4 宽度
    let scale = a4_w_mm / img_w as f64;
    let scaled_h = img_h as f64 * scale;

    // 需要多少页
    let page_count = (scaled_h / a4_h_mm).ceil() as u32;

    // 每页对应原图的高度 (像素)
    let pixels_per_page = (a4_h_mm / scale) as u32;

    let (doc, _, _) = PdfDocument::new("Screenshot", Mm(a4_w_mm), Mm(a4_h_mm), "Layer 1");

    for page_idx in 0..page_count {
        let y_start = page_idx * pixels_per_page;
        let y_end = ((page_idx + 1) * pixels_per_page).min(img_h);
        let chunk_h = y_end - y_start;

        if chunk_h == 0 {
            break;
        }

        // 裁剪出当前页的图片区域
        let chunk = image::imageops::crop_imm(rgb, 0, y_start, img_w, chunk_h).to_image();
        let jpeg_data = encode_jpeg_rgb(&chunk, 90)?;

        let (page, layer) = if page_idx == 0 {
            let pages = doc.get_pages();
            let first_page = *pages.keys().next().unwrap();
            let layer = doc.get_page(first_page).get_layer(
                doc.get_page(first_page).get_layer_ids()[0]
            );
            (first_page, layer)
        } else {
            let (page, layer) = doc.add_page(Mm(a4_w_mm), Mm(a4_h_mm), "Layer 1");
            (page, doc.get_page(page).get_layer(layer))
        };

        let chunk_h_mm = chunk_h as f64 * scale;

        let image = Image::from(ImageXObject {
            width: Px(img_w as usize),
            height: Px(chunk_h as usize),
            color_space: ColorSpace::Rgb,
            bits_per_component: ColorBits::Bit8,
            interpolate: true,
            image_data: jpeg_data,
            image_filter: Some(ImageFilter::DCT),
            clipping_bbox: None,
            smask: None,
        });

        // PDF 坐标系: 原点在左下角，图片从页面顶部开始
        let translate_y = a4_h_mm - chunk_h_mm;

        let transform = ImageTransform {
            translate_x: Some(Mm(0.0)),
            translate_y: Some(Mm(translate_y)),
            scale_x: Some(a4_w_mm),
            scale_y: Some(chunk_h_mm),
            ..Default::default()
        };

        image.add_to_layer(layer, transform);
    }

    doc.save(&mut BufWriter::new(
        File::create(target).map_err(|e| format!("创建 PDF 失败: {e}"))?
    )).map_err(|e| format!("保存 PDF 失败: {e}"))?;

    Ok(())
}

/// 将 RGB 图像编码为 JPEG 字节
fn encode_jpeg(rgb: &image::RgbImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
    image::ImageEncoder::write_image(
        encoder,
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    ).map_err(|e| format!("JPEG 编码失败: {e}"))?;
    Ok(buf)
}

fn encode_jpeg_rgb(rgb: &image::RgbImage, quality: u8) -> Result<Vec<u8>, String> {
    encode_jpeg(rgb, quality)
}
