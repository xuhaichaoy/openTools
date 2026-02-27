use image::RgbImage;
use ndarray::Array4;
use ort::{
    inputs,
    session::{builder::GraphOptimizationLevel, Session},
};
use serde::{Deserialize, Serialize};
use std::any::Any;
use std::cmp::Ordering;
use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::Instant;

const OCR_PADDING: u32 = 50;
const OCR_MAX_SIDE_LEN: u32 = 1024;
const OCR_BOX_SCORE_THRESH: f32 = 0.5;
const OCR_BOX_THRESH: f32 = 0.3;
const OCR_MIN_BOX_EDGE: f32 = 3.0;
const OCR_BOX_NMS_IOU_THRESH: f32 = 0.35;
const OCR_BOX_NMS_CONTAIN_THRESH: f32 = 0.85;
const OCR_THREADS: usize = 2;
const OCR_REC_HEIGHT: u32 = 48;
const OCR_REC_SLIDING_TRIGGER_RATIO: f32 = 1.3;
const OCR_REC_SLIDING_STRIDE_RATIO: f32 = 0.72;
const OCR_REC_SLIDING_MAX_WINDOWS: u32 = 20;
const OCR_REC_SLIDING_MIN_SEGMENT_SCORE: f32 = 0.32;
const OCR_REC_SLIDING_ACCEPT_SCORE: f32 = 0.6;
const OCR_REC_DYNAMIC_STEP_STRIDE: u32 = 8;
const OCR_REC_DYNAMIC_MIN_WINDOW_WIDTH: u32 = 320;
const OCR_REC_DYNAMIC_MAX_WIDTH: u32 = 960;
const OCR_REC_MERGE_MAX_OVERLAP_CHARS: usize = 24;
const OCR_REC_ALT_RETRY_CONFIDENCE: f32 = 0.62;
const OCR_REC_ALT_DARK_RETRY_CONFIDENCE: f32 = 0.78;
const OCR_REC_ALT_SWITCH_MARGIN: f32 = 0.05;
const OCR_REC_BINARY_RETRY_CONFIDENCE: f32 = 0.72;
const OCR_REC_ALT_RETRY_CONFIDENCE_LARGE_DICT: f32 = 0.28;
const OCR_REC_ALT_DARK_RETRY_CONFIDENCE_LARGE_DICT: f32 = 0.40;
const OCR_REC_BINARY_RETRY_CONFIDENCE_LARGE_DICT: f32 = 0.38;
const OCR_REC_RETRY_MAX_TEXT_LEN: usize = 12;
const OCR_REC_RETRY_MAX_TEXT_LEN_LARGE_DICT: usize = 6;
const OCR_REC_MAX_ATTEMPTS_LARGE_DICT: u32 = 3;
const OCR_REC_MAX_ATTEMPTS_DEFAULT: u32 = 6;
const OCR_MULTILINE_VERTICAL_RATIO: f32 = 2.4;
const OCR_MULTILINE_FALLBACK_MAX_LINES: u32 = 10;
const OCR_DETECT_POLARITY_RETRY_MIN_SCORE: f32 = 0.95;
const OCR_DETECT_POLARITY_RETRY_MIN_BLOCKS: usize = 5;
const OCR_DETECT_POLARITY_RETRY_MIN_TEXT_CHARS: usize = 80;
const OCR_DETECT_POLARITY_RETRY_MIN_SCORE_LARGE_DICT: f32 = 0.78;
const OCR_DETECT_POLARITY_RETRY_MIN_BLOCKS_LARGE_DICT: usize = 3;
const OCR_DETECT_POLARITY_RETRY_MIN_TEXT_CHARS_LARGE_DICT: usize = 24;
const OCR_DET_MEAN: [f32; 3] = [
    0.485_f32 * 255_f32,
    0.456_f32 * 255_f32,
    0.406_f32 * 255_f32,
];
const OCR_DET_NORM: [f32; 3] = [
    1.0_f32 / 0.229_f32 / 255.0_f32,
    1.0_f32 / 0.224_f32 / 255.0_f32,
    1.0_f32 / 0.225_f32 / 255.0_f32,
];
const OCR_REC_MEAN: [f32; 3] = [127.5, 127.5, 127.5];
const OCR_REC_NORM: [f32; 3] = [1.0 / 127.5, 1.0 / 127.5, 1.0 / 127.5];
const OCR_KEYS_FILE_CANDIDATES: &[&str] = &[
    "ppocr_keys_v5.txt",
    "ppocr_keys_v4.txt",
    "ppocr_keys_v1.txt",
    "ppocr_keys.txt",
];
const OCR_REC_MODEL_CANDIDATES: &[&str] = &[
    "ppocr_rec_server_v5.onnx",
    "ppocr_rec_server_v4.onnx",
    "ch_PP-OCRv5_rec_server_infer.onnx",
    "ch_PP-OCRv4_rec_server_infer.onnx",
    "ppocr_rec_v5.onnx",
    "ppocr_rec_v4.onnx",
    "ch_PP-OCRv5_rec_infer.onnx",
    "ch_PP-OCRv4_rec_infer.onnx",
    "ppocr_rec_dynamic.onnx",
    "ppocr_rec.onnx",
];

/// OCR 识别结果中的文字块
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrBlock {
    /// 识别出的文字
    pub text: String,
    /// 置信度 0-1
    pub confidence: f32,
    /// 边界框 [x, y, width, height]
    pub bbox: [f32; 4],
}

/// OCR 完整识别结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrResult {
    /// 合并后的全文
    pub full_text: String,
    /// 各文字块
    pub blocks: Vec<OcrBlock>,
    /// 识别语言
    pub language: String,
    /// 是否检测到旋转
    pub rotation_detected: bool,
    /// 旋转角度（度）
    pub rotation_angle: f32,
}

#[derive(Debug, Clone)]
struct ScaleParam {
    src_width: u32,
    src_height: u32,
    dst_width: u32,
    dst_height: u32,
    scale_width: f32,
    scale_height: f32,
}

impl ScaleParam {
    fn from_image(img: &RgbImage, max_side_len: u32) -> Self {
        let src_width = img.width();
        let src_height = img.height();
        let mut ratio = 1.0_f32;
        let max_side = src_width.max(src_height) as f32;
        if max_side > max_side_len as f32 {
            ratio = max_side_len as f32 / max_side;
        }

        let mut dst_width = (src_width as f32 * ratio).round() as u32;
        let mut dst_height = (src_height as f32 * ratio).round() as u32;
        dst_width = (dst_width / 32).max(1) * 32;
        dst_height = (dst_height / 32).max(1) * 32;

        let scale_width = dst_width as f32 / src_width as f32;
        let scale_height = dst_height as f32 / src_height as f32;

        Self {
            src_width,
            src_height,
            dst_width,
            dst_height,
            scale_width,
            scale_height,
        }
    }
}

#[derive(Debug, Clone)]
struct TextBox {
    points: Vec<(f32, f32)>,
    score: f32,
}

fn dedup_dirs(dirs: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for dir in dirs {
        let key = dir.to_string_lossy().to_string();
        if seen.insert(key) {
            result.push(dir);
        }
    }
    result
}

fn runtime_library_file_names() -> Vec<&'static str> {
    #[cfg(target_os = "windows")]
    {
        vec!["onnxruntime.dll"]
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        vec!["libonnxruntime.so"]
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        vec!["libonnxruntime.dylib"]
    }
}

fn append_env_library_dirs(dirs: &mut Vec<PathBuf>, key: &str) {
    if let Ok(value) = std::env::var(key) {
        for path in std::env::split_paths(OsStr::new(&value)) {
            if !path.as_os_str().is_empty() {
                dirs.push(path);
            }
        }
    }
}

fn runtime_search_dirs(model_dir: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    dirs.push(model_dir.to_path_buf());
    dirs.push(model_dir.join("lib"));

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            dirs.push(exe_dir.to_path_buf());
            dirs.push(exe_dir.join("lib"));
        }
    }

    if let Ok(path) = std::env::var("ORT_DYLIB_PATH") {
        if !path.trim().is_empty() {
            let p = PathBuf::from(path.trim());
            if p.is_dir() {
                dirs.push(p);
            } else if let Some(parent) = p.parent() {
                dirs.push(parent.to_path_buf());
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/opt/homebrew/lib"));
        dirs.push(PathBuf::from("/opt/homebrew/opt/onnxruntime/lib"));
        dirs.push(PathBuf::from("/usr/local/lib"));
        dirs.push(PathBuf::from("/usr/local/opt/onnxruntime/lib"));
        append_env_library_dirs(&mut dirs, "DYLD_LIBRARY_PATH");
        append_env_library_dirs(&mut dirs, "DYLD_FALLBACK_LIBRARY_PATH");
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        append_env_library_dirs(&mut dirs, "LD_LIBRARY_PATH");
    }

    dedup_dirs(dirs)
}

fn is_runtime_library_name(file_name: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        file_name.eq_ignore_ascii_case("onnxruntime.dll")
    }
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        file_name.starts_with("libonnxruntime") && file_name.ends_with(".so")
    }
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        file_name.starts_with("libonnxruntime") && file_name.ends_with(".dylib")
    }
}

fn runtime_library_candidates(model_dir: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let file_names = runtime_library_file_names();

    if let Ok(path) = std::env::var("ORT_DYLIB_PATH") {
        if !path.trim().is_empty() {
            let p = PathBuf::from(path);
            if p.is_file() {
                candidates.push(p);
            } else if p.is_dir() {
                for file_name in &file_names {
                    let candidate = p.join(file_name);
                    if candidate.exists() {
                        candidates.push(candidate);
                    }
                }
            }
        }
    }

    for dir in runtime_search_dirs(model_dir) {
        for file_name in &file_names {
            let path = dir.join(file_name);
            if path.exists() {
                candidates.push(path);
            }
        }

        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                if is_runtime_library_name(file_name) {
                    candidates.push(path);
                }
            }
        }
    }

    dedup_dirs(candidates)
}

fn runtime_missing_hint() -> String {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        return "建议先执行: brew install onnxruntime；若仍缺失，请将 libonnxruntime.dylib 复制到应用模型目录。".to_string();
    }

    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        return "请安装系统 onnxruntime 动态库，或将 libonnxruntime.so 放到应用模型目录。"
            .to_string();
    }

    #[cfg(target_os = "windows")]
    {
        return "请安装 onnxruntime，或将 onnxruntime.dll 放到应用模型目录。".to_string();
    }

    #[allow(unreachable_code)]
    "请安装 onnxruntime 动态库，或将运行时库放到应用模型目录。".to_string()
}

fn ensure_ort_runtime(model_dir: &Path) -> Result<Option<String>, String> {
    let candidates = runtime_library_candidates(model_dir);
    if candidates.is_empty() {
        let expected = runtime_library_file_names().join(", ");
        let searched = runtime_search_dirs(model_dir)
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join(" | ");
        return Err(format!(
            "ONNX Runtime 动态库缺失。需要文件: {}。{} 搜索目录: {}",
            expected,
            runtime_missing_hint(),
            searched
        ));
    }

    let mut errors = Vec::new();
    for candidate in candidates {
        match ort::init_from(candidate.to_string_lossy().to_string()) {
            Ok(builder) => {
                builder.commit();
                return Ok(Some(candidate.to_string_lossy().to_string()));
            }
            Err(e) => {
                errors.push(format!("{} ({})", candidate.to_string_lossy(), e));
            }
        }
    }

    Err(format!(
        "ONNX Runtime 动态库加载失败: {}",
        errors.join(" | ")
    ))
}

#[allow(dead_code)]
fn panic_message(payload: Box<dyn Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        return (*s).to_string();
    }
    if let Some(s) = payload.downcast_ref::<String>() {
        return s.clone();
    }
    "unknown panic".to_string()
}

fn model_dirs(model_dir: &Path) -> Vec<PathBuf> {
    dedup_dirs(vec![model_dir.to_path_buf()])
}

fn find_model_path(model_dir: &Path, file_name: &str) -> Option<PathBuf> {
    model_dirs(model_dir)
        .into_iter()
        .map(|dir| dir.join(file_name))
        .find(|path| path.exists())
}

fn list_onnx_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return files;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_onnx = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("onnx"))
            .unwrap_or(false);
        if is_onnx {
            files.push(path);
        }
    }
    files.sort_by_key(|path| path.to_string_lossy().to_string());
    files
}

fn list_txt_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return files;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_txt = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case("txt"))
            .unwrap_or(false);
        if is_txt {
            files.push(path);
        }
    }
    files.sort_by_key(|path| path.to_string_lossy().to_string());
    files
}

fn collect_rec_model_candidates(model_dir: &Path) -> Vec<PathBuf> {
    let dirs = model_dirs(model_dir);
    let mut paths = Vec::new();

    for file_name in OCR_REC_MODEL_CANDIDATES {
        for dir in &dirs {
            let candidate = dir.join(file_name);
            if candidate.exists() {
                paths.push(candidate);
            }
        }
    }

    for dir in &dirs {
        for path in list_onnx_files(dir) {
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if file_name.contains("rec") {
                paths.push(path);
            }
        }
    }

    dedup_dirs(paths)
}

#[allow(dead_code)]
fn find_any_rec_model_path(model_dir: &Path) -> Option<PathBuf> {
    collect_rec_model_candidates(model_dir).into_iter().next()
}

fn collect_ocr_keys_candidates(model_dir: &Path) -> Vec<PathBuf> {
    let dirs = model_dirs(model_dir);
    let mut paths = Vec::new();
    for file_name in OCR_KEYS_FILE_CANDIDATES {
        for dir in &dirs {
            let candidate = dir.join(file_name);
            if candidate.exists() {
                paths.push(candidate);
            }
        }
    }
    for dir in &dirs {
        paths.extend(list_txt_files(dir));
    }
    dedup_dirs(paths)
}

fn count_ocr_keys(path: &PathBuf) -> Result<usize, String> {
    let file = File::open(path).map_err(|e| format!("读取字符字典失败: {}", e))?;
    let reader = BufReader::new(file);
    let mut count = 0usize;
    for line in reader.lines() {
        line.map_err(|e| format!("读取字符字典失败: {}", e))?;
        count += 1;
    }
    Ok(count)
}

fn find_ocr_keys_path(model_dir: &Path, expected_class_count: Option<usize>) -> Option<PathBuf> {
    let candidates = collect_ocr_keys_candidates(model_dir);
    if candidates.is_empty() {
        return None;
    }

    if let Some(classes) = expected_class_count {
        for path in &candidates {
            let Ok(dict_chars) = count_ocr_keys(path) else {
                continue;
            };
            if dict_chars + 2 == classes {
                return Some(path.clone());
            }
        }
        tracing::error!(
            "未找到与识别模型输出类别数({})匹配的字典，不再回退到不匹配字典",
            classes
        );
        return None;
    }

    candidates.into_iter().next()
}

fn subtract_mean_normalize(
    img_src: &RgbImage,
    mean_vals: &[f32; 3],
    norm_vals: &[f32; 3],
) -> Array4<f32> {
    let cols = img_src.width() as usize;
    let rows = img_src.height() as usize;
    let mut input_tensor = Array4::<f32>::zeros((1, 3, rows, cols));

    for (x, y, pixel) in img_src.enumerate_pixels() {
        for ch in 0..3 {
            let value = pixel[ch] as f32 * norm_vals[ch] - mean_vals[ch] * norm_vals[ch];
            input_tensor[[0, ch, y as usize, x as usize]] = value;
        }
    }
    input_tensor
}

fn pixel_luma(pixel: &image::Rgb<u8>) -> u8 {
    ((pixel[0] as u32 * 299 + pixel[1] as u32 * 587 + pixel[2] as u32 * 114 + 500) / 1000) as u8
}

fn is_dark_background_line(img_src: &RgbImage) -> bool {
    let total = (img_src.width() as usize).saturating_mul(img_src.height() as usize);
    if total == 0 {
        return false;
    }

    let mut dark = 0usize;
    let mut bright = 0usize;
    let mut sum = 0u64;
    for pixel in img_src.pixels() {
        let luma = pixel_luma(pixel);
        sum += luma as u64;
        if luma < 90 {
            dark += 1;
        }
        if luma > 170 {
            bright += 1;
        }
    }

    let mean = sum as f32 / total as f32;
    let dark_ratio = dark as f32 / total as f32;
    let bright_ratio = bright as f32 / total as f32;

    mean < 130.0 && dark_ratio > 0.45 && bright_ratio > 0.03
}

fn is_dark_background_image(img_src: &RgbImage) -> bool {
    let total = (img_src.width() as usize).saturating_mul(img_src.height() as usize);
    if total == 0 {
        return false;
    }

    let mut dark = 0usize;
    let mut bright = 0usize;
    let mut sum = 0u64;
    for pixel in img_src.pixels() {
        let luma = pixel_luma(pixel);
        sum += luma as u64;
        if luma < 90 {
            dark += 1;
        }
        if luma > 170 {
            bright += 1;
        }
    }

    let mean = sum as f32 / total as f32;
    let dark_ratio = dark as f32 / total as f32;
    let bright_ratio = bright as f32 / total as f32;

    mean < 140.0 && dark_ratio > 0.4 && bright_ratio > 0.02
}

fn invert_rgb_image(img_src: &RgbImage) -> RgbImage {
    let mut result = RgbImage::new(img_src.width(), img_src.height());
    for (x, y, pixel) in img_src.enumerate_pixels() {
        result.put_pixel(
            x,
            y,
            image::Rgb([
                255u8.saturating_sub(pixel[0]),
                255u8.saturating_sub(pixel[1]),
                255u8.saturating_sub(pixel[2]),
            ]),
        );
    }
    result
}

fn grayscale_contrast_image(img_src: &RgbImage) -> RgbImage {
    if img_src.width() == 0 || img_src.height() == 0 {
        return img_src.clone();
    }

    let mut min_luma = u8::MAX;
    let mut max_luma = u8::MIN;
    for pixel in img_src.pixels() {
        let luma = pixel_luma(pixel);
        min_luma = min_luma.min(luma);
        max_luma = max_luma.max(luma);
    }

    if max_luma <= min_luma.saturating_add(8) {
        return img_src.clone();
    }

    let min_f = min_luma as f32;
    let scale = 255.0 / (max_luma as f32 - min_f);
    let mut result = RgbImage::new(img_src.width(), img_src.height());
    for (x, y, pixel) in img_src.enumerate_pixels() {
        let luma = pixel_luma(pixel) as f32;
        let value = ((luma - min_f) * scale).clamp(0.0, 255.0) as u8;
        result.put_pixel(x, y, image::Rgb([value, value, value]));
    }
    result
}

fn otsu_threshold_from_luma_hist(hist: &[u32; 256], total: u32) -> u8 {
    if total == 0 {
        return 127;
    }

    let mut sum_all = 0.0_f64;
    for (i, &count) in hist.iter().enumerate() {
        sum_all += (i as f64) * (count as f64);
    }

    let mut sum_bg = 0.0_f64;
    let mut weight_bg = 0.0_f64;
    let mut best_var = -1.0_f64;
    let mut best_threshold = 127u8;

    for (t, &count) in hist.iter().enumerate() {
        weight_bg += count as f64;
        if weight_bg <= 0.0 {
            continue;
        }
        let weight_fg = (total as f64) - weight_bg;
        if weight_fg <= 0.0 {
            break;
        }

        sum_bg += (t as f64) * (count as f64);
        let mean_bg = sum_bg / weight_bg;
        let mean_fg = (sum_all - sum_bg) / weight_fg;
        let diff = mean_bg - mean_fg;
        let between_var = weight_bg * weight_fg * diff * diff;
        if between_var > best_var {
            best_var = between_var;
            best_threshold = t as u8;
        }
    }

    best_threshold
}

fn otsu_binary_image(img_src: &RgbImage) -> RgbImage {
    let mut hist = [0u32; 256];
    let mut total = 0u32;
    let mut sum = 0u64;
    for pixel in img_src.pixels() {
        let luma = pixel_luma(pixel);
        hist[luma as usize] += 1;
        total += 1;
        sum += luma as u64;
    }
    if total == 0 {
        return img_src.clone();
    }

    let threshold = otsu_threshold_from_luma_hist(&hist, total);
    let mean = (sum as f32) / (total as f32);

    let mut binary = RgbImage::new(img_src.width(), img_src.height());
    for (x, y, pixel) in img_src.enumerate_pixels() {
        let luma = pixel_luma(pixel);
        let value = if luma > threshold { 255 } else { 0 };
        binary.put_pixel(x, y, image::Rgb([value, value, value]));
    }

    if mean < 128.0 {
        invert_rgb_image(&binary)
    } else {
        binary
    }
}

fn make_padding(img_src: &RgbImage, padding: u32) -> RgbImage {
    if padding == 0 {
        return img_src.clone();
    }

    let width = img_src.width();
    let height = img_src.height();
    let mut padded = RgbImage::new(width + 2 * padding, height + 2 * padding);
    imageproc::drawing::draw_filled_rect_mut(
        &mut padded,
        imageproc::rect::Rect::at(0, 0).of_size(width + 2 * padding, height + 2 * padding),
        image::Rgb([255, 255, 255]),
    );
    image::imageops::replace(&mut padded, img_src, padding as i64, padding as i64);
    padded
}

fn prepare_fixed_det_input(
    img_src: &RgbImage,
    target_h: u32,
    target_w: u32,
) -> (RgbImage, ScaleParam) {
    let src_width = img_src.width().max(1);
    let src_height = img_src.height().max(1);
    let ratio = ((target_w as f32) / (src_width as f32))
        .min((target_h as f32) / (src_height as f32))
        .max(1.0 / src_width.max(src_height) as f32);

    let resized_w = ((src_width as f32 * ratio).round() as u32).clamp(1, target_w.max(1));
    let resized_h = ((src_height as f32 * ratio).round() as u32).clamp(1, target_h.max(1));
    let resized = image::imageops::resize(
        img_src,
        resized_w,
        resized_h,
        image::imageops::FilterType::CatmullRom,
    );
    tracing::info!(
        "OCR det letterbox: src={}x{}, resized={}x{}, input={}x{}",
        img_src.width(),
        img_src.height(),
        resized_w,
        resized_h,
        target_w,
        target_h
    );

    let mut canvas = RgbImage::from_pixel(target_w, target_h, image::Rgb([255, 255, 255]));
    image::imageops::replace(&mut canvas, &resized, 0, 0);

    (
        canvas,
        ScaleParam {
            src_width: img_src.width(),
            src_height: img_src.height(),
            dst_width: target_w,
            dst_height: target_h,
            scale_width: ratio,
            scale_height: ratio,
        },
    )
}

fn read_ocr_keys(path: &PathBuf) -> Result<Vec<String>, String> {
    let file = File::open(path).map_err(|e| format!("读取字符字典失败: {}", e))?;
    let reader = BufReader::new(file);

    let mut keys = Vec::new();
    keys.push("#".to_string());
    for line in reader.lines() {
        let line = line.map_err(|e| format!("读取字符字典失败: {}", e))?;
        keys.push(line);
    }
    keys.push(" ".to_string());
    Ok(keys)
}

fn order_quad_points(points: &[(f32, f32); 4]) -> [(f32, f32); 4] {
    let mut tl = points[0];
    let mut tr = points[0];
    let mut br = points[0];
    let mut bl = points[0];

    let mut min_sum = f32::MAX;
    let mut max_sum = f32::MIN;
    let mut min_diff = f32::MAX;
    let mut max_diff = f32::MIN;

    for &(x, y) in points {
        let sum = x + y;
        let diff = y - x;
        if sum < min_sum {
            min_sum = sum;
            tl = (x, y);
        }
        if sum > max_sum {
            max_sum = sum;
            br = (x, y);
        }
        if diff < min_diff {
            min_diff = diff;
            tr = (x, y);
        }
        if diff > max_diff {
            max_diff = diff;
            bl = (x, y);
        }
    }

    [tl, tr, br, bl]
}

fn contour_min_box(
    contour_points: &[imageproc::point::Point<i32>],
) -> Option<(Vec<imageproc::point::Point<f32>>, f32)> {
    let rect = imageproc::geometry::min_area_rect(contour_points);
    if rect.len() != 4 {
        return None;
    }

    let raw_points = [
        (rect[0].x as f32, rect[0].y as f32),
        (rect[1].x as f32, rect[1].y as f32),
        (rect[2].x as f32, rect[2].y as f32),
        (rect[3].x as f32, rect[3].y as f32),
    ];
    let ordered = order_quad_points(&raw_points);

    let width_top =
        ((ordered[0].0 - ordered[1].0).powi(2) + (ordered[0].1 - ordered[1].1).powi(2)).sqrt();
    let width_bottom =
        ((ordered[2].0 - ordered[3].0).powi(2) + (ordered[2].1 - ordered[3].1).powi(2)).sqrt();
    let height_left =
        ((ordered[0].0 - ordered[3].0).powi(2) + (ordered[0].1 - ordered[3].1).powi(2)).sqrt();
    let height_right =
        ((ordered[1].0 - ordered[2].0).powi(2) + (ordered[1].1 - ordered[2].1).powi(2)).sqrt();
    let min_edge_size = width_top
        .min(width_bottom)
        .min(height_left)
        .min(height_right);

    let box_points = ordered
        .into_iter()
        .map(|(x, y)| imageproc::point::Point::new(x, y))
        .collect::<Vec<_>>();
    Some((box_points, min_edge_size))
}

fn contour_score(
    contour: &imageproc::contours::Contour<i32>,
    pred_img: &image::ImageBuffer<image::Luma<f32>, Vec<f32>>,
) -> f32 {
    let mut xmin = i32::MAX;
    let mut xmax = i32::MIN;
    let mut ymin = i32::MAX;
    let mut ymax = i32::MIN;

    for point in &contour.points {
        xmin = xmin.min(point.x);
        xmax = xmax.max(point.x);
        ymin = ymin.min(point.y);
        ymax = ymax.max(point.y);
    }

    let width = pred_img.width() as i32;
    let height = pred_img.height() as i32;
    xmin = xmin.max(0).min(width - 1);
    xmax = xmax.max(0).min(width - 1);
    ymin = ymin.max(0).min(height - 1);
    ymax = ymax.max(0).min(height - 1);
    let roi_width = xmax - xmin + 1;
    let roi_height = ymax - ymin + 1;
    if roi_width <= 0 || roi_height <= 0 {
        return 0.0;
    }

    let mut mask = image::GrayImage::new(roi_width as u32, roi_height as u32);
    let pts = contour
        .points
        .iter()
        .map(|point| imageproc::point::Point::new(point.x - xmin, point.y - ymin))
        .collect::<Vec<_>>();
    imageproc::drawing::draw_polygon_mut(&mut mask, &pts, image::Luma([255]));

    let cropped = image::imageops::crop_imm(
        pred_img,
        xmin as u32,
        ymin as u32,
        roi_width as u32,
        roi_height as u32,
    )
    .to_image();

    let mut sum = 0.0_f32;
    let mut count = 0_u32;
    for y in 0..cropped.height() {
        for x in 0..cropped.width() {
            if mask.get_pixel(x, y)[0] > 0 {
                sum += cropped.get_pixel(x, y)[0];
                count += 1;
            }
        }
    }

    if count == 0 {
        0.0
    } else {
        sum / count as f32
    }
}

fn points_to_axis_bbox(points: &[(f32, f32)]) -> Option<[f32; 4]> {
    if points.is_empty() {
        return None;
    }
    let mut min_x = f32::MAX;
    let mut min_y = f32::MAX;
    let mut max_x = f32::MIN;
    let mut max_y = f32::MIN;
    for &(x, y) in points {
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
    }
    if !min_x.is_finite()
        || !min_y.is_finite()
        || !max_x.is_finite()
        || !max_y.is_finite()
        || max_x <= min_x
        || max_y <= min_y
    {
        return None;
    }
    Some([min_x, min_y, max_x, max_y])
}

fn bbox_intersection_area(a: [f32; 4], b: [f32; 4]) -> f32 {
    let left = a[0].max(b[0]);
    let top = a[1].max(b[1]);
    let right = a[2].min(b[2]);
    let bottom = a[3].min(b[3]);
    let w = (right - left).max(0.0);
    let h = (bottom - top).max(0.0);
    w * h
}

fn suppress_text_boxes(mut boxes: Vec<TextBox>) -> Vec<TextBox> {
    if boxes.len() <= 1 {
        return boxes;
    }

    boxes.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));

    let mut kept: Vec<TextBox> = Vec::new();
    let mut kept_bboxes: Vec<[f32; 4]> = Vec::new();

    for candidate in boxes {
        let Some(cand_bbox) = points_to_axis_bbox(&candidate.points) else {
            continue;
        };
        let cand_area = (cand_bbox[2] - cand_bbox[0]) * (cand_bbox[3] - cand_bbox[1]);
        if cand_area <= 1.0 {
            continue;
        }

        let mut overlapped = false;
        for kept_bbox in &kept_bboxes {
            let inter = bbox_intersection_area(cand_bbox, *kept_bbox);
            if inter <= 0.0 {
                continue;
            }
            let kept_area = (kept_bbox[2] - kept_bbox[0]) * (kept_bbox[3] - kept_bbox[1]);
            if kept_area <= 1.0 {
                continue;
            }
            let union = cand_area + kept_area - inter;
            let iou = if union > 0.0 { inter / union } else { 0.0 };
            let contain_ratio = (inter / cand_area).max(inter / kept_area);
            if iou >= OCR_BOX_NMS_IOU_THRESH || contain_ratio >= OCR_BOX_NMS_CONTAIN_THRESH {
                overlapped = true;
                break;
            }
        }

        if !overlapped {
            kept_bboxes.push(cand_bbox);
            kept.push(candidate);
        }
    }

    kept
}

fn get_rotate_crop_image(img_src: &RgbImage, points: &[(f32, f32)]) -> Option<RgbImage> {
    if points.len() != 4 {
        return None;
    }
    let ordered = order_quad_points(&[points[0], points[1], points[2], points[3]]);
    let points = ordered.as_slice();

    let min_x = points
        .iter()
        .map(|(x, _)| *x)
        .fold(f32::MAX, f32::min)
        .floor()
        .max(0.0) as u32;
    let min_y = points
        .iter()
        .map(|(_, y)| *y)
        .fold(f32::MAX, f32::min)
        .floor()
        .max(0.0) as u32;
    let max_x = points
        .iter()
        .map(|(x, _)| *x)
        .fold(0.0_f32, f32::max)
        .ceil()
        .min(img_src.width().saturating_sub(1) as f32) as u32;
    let max_y = points
        .iter()
        .map(|(_, y)| *y)
        .fold(0.0_f32, f32::max)
        .ceil()
        .min(img_src.height().saturating_sub(1) as f32) as u32;

    if max_x <= min_x || max_y <= min_y {
        return None;
    }

    let crop_w = max_x - min_x + 1;
    let crop_h = max_y - min_y + 1;
    let crop = image::imageops::crop_imm(img_src, min_x, min_y, crop_w, crop_h).to_image();

    let local_points = points
        .iter()
        .map(|(x, y)| (*x - min_x as f32, *y - min_y as f32))
        .collect::<Vec<_>>();

    let width_top = ((local_points[0].0 - local_points[1].0).powi(2)
        + (local_points[0].1 - local_points[1].1).powi(2))
    .sqrt();
    let width_bottom = ((local_points[2].0 - local_points[3].0).powi(2)
        + (local_points[2].1 - local_points[3].1).powi(2))
    .sqrt();
    let height_left = ((local_points[0].0 - local_points[3].0).powi(2)
        + (local_points[0].1 - local_points[3].1).powi(2))
    .sqrt();
    let height_right = ((local_points[1].0 - local_points[2].0).powi(2)
        + (local_points[1].1 - local_points[2].1).powi(2))
    .sqrt();
    let crop_width = width_top.max(width_bottom).max(1.0) as u32;
    let crop_height = height_left.max(height_right).max(1.0) as u32;

    let src_points = [
        (local_points[0].0, local_points[0].1),
        (local_points[1].0, local_points[1].1),
        (local_points[2].0, local_points[2].1),
        (local_points[3].0, local_points[3].1),
    ];
    let dst_points = [
        (0.0, 0.0),
        (crop_width as f32, 0.0),
        (crop_width as f32, crop_height as f32),
        (0.0, crop_height as f32),
    ];

    let projection = imageproc::geometric_transformations::Projection::from_control_points(
        src_points, dst_points,
    )?;
    let mut part_img = RgbImage::new(crop_width, crop_height);
    imageproc::geometric_transformations::warp_into(
        &crop,
        &projection,
        imageproc::geometric_transformations::Interpolation::Bilinear,
        image::Rgb([255, 255, 255]),
        &mut part_img,
    );

    if part_img.height() >= part_img.width() * 3 / 2 {
        Some(image::imageops::rotate90(&part_img))
    } else {
        Some(part_img)
    }
}

fn split_multiline_crop(img_src: &RgbImage) -> Vec<RgbImage> {
    let width = img_src.width();
    let height = img_src.height();
    if width == 0 || height == 0 {
        return vec![img_src.clone()];
    }
    if height <= OCR_REC_HEIGHT * 3 / 2 {
        return vec![img_src.clone()];
    }
    let vertical_ratio = height as f32 / width.max(1) as f32;
    if vertical_ratio >= OCR_MULTILINE_VERTICAL_RATIO && width <= OCR_REC_HEIGHT * 2 {
        return vec![img_src.clone()];
    }

    let normalized = otsu_binary_image(img_src);
    let mut row_dark_counts = vec![0u32; height as usize];
    let mut row_sum = 0u64;
    let mut row_max = 0u32;
    for (y, count_ref) in row_dark_counts.iter_mut().enumerate() {
        let mut count = 0u32;
        for x in 0..width {
            let pixel = normalized.get_pixel(x, y as u32);
            if pixel_luma(pixel) < 120 {
                count += 1;
            }
        }
        *count_ref = count;
        row_sum += count as u64;
        row_max = row_max.max(count);
    }

    let row_avg = row_sum as f32 / height.max(1) as f32;
    let row_active_threshold = ((width as f32) * 0.008)
        .max(row_avg * 0.55)
        .max(row_max as f32 * 0.1)
        .min((row_max as f32 * 0.85).max(2.0))
        .max(2.0) as u32;
    let mut active = row_dark_counts
        .iter()
        .map(|&count| count >= row_active_threshold)
        .collect::<Vec<_>>();

    if active.len() >= 3 {
        for i in 1..active.len() - 1 {
            if !active[i] && active[i - 1] && active[i + 1] {
                active[i] = true;
            }
        }
    }

    let min_seg_h = (height / 30).max(6);
    let mut segments: Vec<(u32, u32)> = Vec::new();
    let mut start: Option<u32> = None;
    for (i, &flag) in active.iter().enumerate() {
        let y = i as u32;
        if flag {
            if start.is_none() {
                start = Some(y);
            }
        } else if let Some(s) = start.take() {
            let e = y.saturating_sub(1);
            if e >= s && e - s + 1 >= min_seg_h {
                segments.push((s, e));
            }
        }
    }
    if let Some(s) = start {
        let e = height.saturating_sub(1);
        if e >= s && e - s + 1 >= min_seg_h {
            segments.push((s, e));
        }
    }

    let mut merged: Vec<(u32, u32)> = Vec::new();
    for (s, e) in segments {
        if let Some((_, last_e)) = merged.last_mut() {
            if s <= last_e.saturating_add(3) {
                *last_e = (*last_e).max(e);
                continue;
            }
        }
        merged.push((s, e));
    }

    if merged.len() <= 1 {
        if height >= OCR_REC_HEIGHT * 5 / 2 && width <= height * 5 {
            let estimated_lines = ((height as f32) / (OCR_REC_HEIGHT as f32 * 1.1))
                .round()
                .clamp(2.0, OCR_MULTILINE_FALLBACK_MAX_LINES as f32)
                as u32;
            let mut lines = Vec::new();
            let step = (height as f32 / estimated_lines as f32).max(1.0);
            for i in 0..estimated_lines {
                let start = (i as f32 * step).floor() as u32;
                let end = (((i + 1) as f32 * step).ceil() as u32)
                    .saturating_sub(1)
                    .min(height.saturating_sub(1));
                if end <= start {
                    continue;
                }
                let top = start.saturating_sub(1);
                let bottom = (end + 1).min(height.saturating_sub(1));
                if bottom <= top {
                    continue;
                }
                let h = bottom - top + 1;
                let line = image::imageops::crop_imm(img_src, 0, top, width, h).to_image();
                if line.height() >= 6 {
                    lines.push(line);
                }
            }
            if lines.len() > 1 {
                tracing::info!(
                    "OCR fallback split multiline into {} lines (w={}, h={})",
                    lines.len(),
                    width,
                    height
                );
                return lines;
            }
        }
        return vec![img_src.clone()];
    }

    let mut lines = Vec::new();
    for (s, e) in merged {
        let top = s.saturating_sub(2);
        let bottom = (e + 2).min(height.saturating_sub(1));
        if bottom <= top {
            continue;
        }
        let h = bottom - top + 1;
        let line = image::imageops::crop_imm(img_src, 0, top, width, h).to_image();
        if line.height() >= 6 {
            lines.push(line);
        }
    }

    if lines.is_empty() {
        vec![img_src.clone()]
    } else {
        lines
    }
}

fn extract_fixed_input_size(input: &ort::value::Outlet) -> Option<(u32, u32)> {
    if let ort::value::ValueType::Tensor { shape, .. } = input.dtype() {
        let dims = shape.as_ref();
        if dims.len() >= 4 {
            let h = dims[2];
            let w = dims[3];
            if h > 0 && w > 0 {
                return Some((h as u32, w as u32));
            }
        }
    }
    None
}

fn extract_rec_class_count(output: &ort::value::Outlet) -> Option<usize> {
    if let ort::value::ValueType::Tensor { shape, .. } = output.dtype() {
        let dims = shape.as_ref();
        let mut tail_dims = dims
            .iter()
            .rev()
            .filter_map(|dim| (*dim > 1).then_some(*dim as usize))
            .take(2)
            .collect::<Vec<_>>();
        if tail_dims.is_empty() {
            return None;
        }
        tail_dims.sort_unstable();
        return tail_dims.pop();
    }
    None
}

fn extract_rec_step_count(
    output: &ort::value::Outlet,
    class_count: Option<usize>,
) -> Option<u32> {
    if let ort::value::ValueType::Tensor { shape, .. } = output.dtype() {
        let dimensions = shape.as_ref();
        if dimensions.len() < 2 {
            return None;
        }
        let d1 = dimensions[dimensions.len() - 2];
        let d2 = dimensions[dimensions.len() - 1];
        if d1 <= 1 || d2 <= 1 {
            return None;
        }

        let steps = if let Some(classes) = class_count {
            if (d2 as usize).abs_diff(classes) <= (d1 as usize).abs_diff(classes) {
                d1 as u32
            } else {
                d2 as u32
            }
        } else {
            (d1.min(d2)) as u32
        };

        if (2..=4096).contains(&steps) {
            return Some(steps);
        }
    }
    None
}

pub struct OcrEngine {
    det_session: Session,
    det_input_name: String,
    det_fixed_size: Option<(u32, u32)>,
    rec_session: Session,
    rec_input_name: String,
    rec_fixed_width: Option<u32>,
    rec_step_count: Option<u32>,
    rec_keys: Vec<String>,
}

impl OcrEngine {
    pub fn new(model_dir: &Path) -> Result<Self, String> {
        let init_started = Instant::now();
        let runtime_started = Instant::now();
        let runtime_path = ensure_ort_runtime(model_dir)?;
        let runtime_ms = runtime_started.elapsed().as_millis();
        if let Some(path) = runtime_path {
            tracing::info!("OCR runtime loaded from {:?}", path);
        }

        let det_model_path = find_model_path(model_dir, "ppocr_det.onnx")
            .ok_or_else(|| "缺少模型文件: ppocr_det.onnx".to_string())?;
        let rec_model_candidates = collect_rec_model_candidates(model_dir);
        if rec_model_candidates.is_empty() {
            return Err(format!(
                "缺少识别模型文件: {}",
                OCR_REC_MODEL_CANDIDATES.join(" / ")
            ));
        }

        let det_load_started = Instant::now();
        let det_session = Session::builder()
            .map_err(|e| format!("创建检测会话失败: {}", e))?
            .with_optimization_level(GraphOptimizationLevel::Level2)
            .map_err(|e| format!("配置检测会话失败: {}", e))?
            .with_intra_threads(OCR_THREADS)
            .map_err(|e| format!("配置检测线程失败: {}", e))?
            .with_inter_threads(OCR_THREADS)
            .map_err(|e| format!("配置检测线程失败: {}", e))?
            .commit_from_file(&det_model_path)
            .map_err(|e| format!("加载检测模型失败: {}", e))?;
        let det_load_ms = det_load_started.elapsed().as_millis();

        let det_input = det_session
            .inputs()
            .first()
            .ok_or_else(|| "检测模型缺少输入节点".to_string())?;
        let det_input_name = det_input.name().to_string();

        let det_fixed_size = extract_fixed_input_size(det_input);
        if let Some((h, w)) = det_fixed_size {
            tracing::info!("OCR 检测模型使用固定输入尺寸: {}x{}", w, h);
        } else {
            tracing::info!("OCR 检测模型使用动态输入尺寸");
        }

        let mut selected_dynamic = None;
        let mut selected_fixed = None;
        let mut rec_model_errors = Vec::new();
        let mut rec_candidates_tried = 0usize;

        for rec_model_path in rec_model_candidates {
            rec_candidates_tried += 1;
            let rec_candidate_started = Instant::now();
            let rec_session = match Session::builder()
                .map_err(|e| format!("创建识别会话失败: {}", e))
                .and_then(|builder| {
                    builder
                        .with_optimization_level(GraphOptimizationLevel::Level2)
                        .map_err(|e| format!("配置识别会话失败: {}", e))
                })
                .and_then(|builder| {
                    builder
                        .with_intra_threads(OCR_THREADS)
                        .map_err(|e| format!("配置识别线程失败: {}", e))
                })
                .and_then(|builder| {
                    builder
                        .with_inter_threads(OCR_THREADS)
                        .map_err(|e| format!("配置识别线程失败: {}", e))
                })
                .and_then(|builder| {
                    builder
                        .commit_from_file(&rec_model_path)
                        .map_err(|e| format!("加载识别模型失败: {}", e))
                }) {
                Ok(session) => session,
                Err(err) => {
                    rec_model_errors.push(format!(
                        "{} ({})",
                        rec_model_path.to_string_lossy(),
                        err
                    ));
                    continue;
                }
            };

            let Some(rec_input) = rec_session.inputs().first() else {
                rec_model_errors.push(format!(
                    "{} (识别模型缺少输入节点)",
                    rec_model_path.to_string_lossy()
                ));
                continue;
            };
            let rec_input_name = rec_input.name().to_string();
            let rec_fixed_width = extract_fixed_input_size(rec_input).map(|(_h, w)| w);

            let Some(rec_output) = rec_session.outputs().first() else {
                rec_model_errors.push(format!(
                    "{} (识别模型缺少输出节点)",
                    rec_model_path.to_string_lossy()
                ));
                continue;
            };
            let rec_class_count = extract_rec_class_count(rec_output);
            let rec_step_count = extract_rec_step_count(rec_output, rec_class_count);

            let Some(keys_path) = find_ocr_keys_path(model_dir, rec_class_count) else {
                rec_model_errors.push(format!(
                    "{} (找不到匹配字典 classes={:?})",
                    rec_model_path.to_string_lossy(),
                    rec_class_count
                ));
                continue;
            };
            let rec_keys = match read_ocr_keys(&keys_path) {
                Ok(keys) => keys,
                Err(err) => {
                    rec_model_errors.push(format!(
                        "{} (读取字典失败: {})",
                        rec_model_path.to_string_lossy(),
                        err
                    ));
                    continue;
                }
            };

            let candidate = (
                rec_session,
                rec_input_name,
                rec_fixed_width,
                rec_step_count,
                rec_keys,
                rec_model_path,
                rec_class_count,
                keys_path,
                rec_candidate_started.elapsed().as_millis(),
            );
            if candidate.2.is_none() {
                selected_dynamic = Some(candidate);
                break;
            }
            if selected_fixed.is_none() {
                selected_fixed = Some(candidate);
            }
        }

        let (
            rec_session,
            rec_input_name,
            rec_fixed_width,
            rec_step_count,
            rec_keys,
            rec_model_path,
            rec_class_count,
            keys_path,
            rec_select_ms,
        ) = if let Some(candidate) = selected_dynamic {
            candidate
        } else if let Some(candidate) = selected_fixed {
            candidate
        } else {
            return Err(format!(
                "加载识别模型失败。候选: {}。错误: {}",
                OCR_REC_MODEL_CANDIDATES.join(" / "),
                if rec_model_errors.is_empty() {
                    "(无详细错误)".to_string()
                } else {
                    rec_model_errors.join(" | ")
                }
            ));
        };

        tracing::info!("OCR 识别模型路径: {:?}", rec_model_path);
        if let Some(w) = rec_fixed_width {
            tracing::info!("OCR 识别模型使用固定输入宽度: {}", w);
            tracing::warn!("OCR 当前未加载到动态宽度识别模型，将使用固定宽度路径");
        } else {
            tracing::info!("OCR 识别模型使用动态输入宽度");
        }
        if let Some(classes) = rec_class_count {
            tracing::info!("OCR 识别模型输出类别数: {}", classes);
        } else {
            tracing::info!("OCR 识别模型输出类别数: 动态/未知");
        }
        if let Some(steps) = rec_step_count {
            tracing::info!("OCR 识别模型输出序列步长: {}", steps);
        }
        tracing::info!("OCR 使用字符字典: {:?}", keys_path);
        if let Some(classes) = rec_class_count {
            if rec_keys.len() != classes {
                tracing::warn!(
                    "OCR 字典长度({})与识别模型输出类别数({})不一致，可能影响识别准确率",
                    rec_keys.len(),
                    classes
                );
            }
        }
        tracing::info!(
            "OCR init timing: runtime={}ms, det_load={}ms, rec_select={}ms, rec_candidates_tried={}, total={}ms",
            runtime_ms,
            det_load_ms,
            rec_select_ms,
            rec_candidates_tried,
            init_started.elapsed().as_millis()
        );

        Ok(Self {
            det_session,
            det_input_name,
            det_fixed_size,
            rec_session,
            rec_input_name,
            rec_fixed_width,
            rec_step_count,
            rec_keys,
        })
    }

    pub fn is_available(&self) -> bool {
        true
    }

    fn reading_order_cmp(a: &OcrBlock, b: &OcrBlock) -> Ordering {
        let ay = a.bbox[1];
        let by = b.bbox[1];
        if (ay - by).abs() <= 12.0 {
            return a.bbox[0].partial_cmp(&b.bbox[0]).unwrap_or(Ordering::Equal);
        }
        ay.partial_cmp(&by).unwrap_or(Ordering::Equal)
    }

    fn blocks_quality_score(blocks: &[OcrBlock]) -> f32 {
        if blocks.is_empty() {
            return 0.0;
        }
        let confidence_sum = blocks
            .iter()
            .map(|block| block.confidence.max(0.0))
            .sum::<f32>();
        let text_len = blocks
            .iter()
            .map(|block| block.text.chars().count())
            .sum::<usize>();
        confidence_sum / blocks.len() as f32 + (text_len as f32 / 120.0).min(1.0)
    }

    fn remap_bbox_from_180(blocks: &mut [OcrBlock], width: u32, height: u32) {
        let width_f = width as f32;
        let height_f = height as f32;
        for block in blocks {
            let x = block.bbox[0];
            let y = block.bbox[1];
            let w = block.bbox[2];
            let h = block.bbox[3];
            block.bbox[0] = (width_f - (x + w)).max(0.0);
            block.bbox[1] = (height_f - (y + h)).max(0.0);
        }
    }

    fn bbox_from_points(points: &[(f32, f32)], padding: u32, width: u32, height: u32) -> [f32; 4] {
        if points.is_empty() || width == 0 || height == 0 {
            return [0.0, 0.0, 0.0, 0.0];
        }

        let mut min_x = f32::MAX;
        let mut min_y = f32::MAX;
        let mut max_x = 0.0_f32;
        let mut max_y = 0.0_f32;
        for (x, y) in points {
            min_x = min_x.min(*x - padding as f32);
            min_y = min_y.min(*y - padding as f32);
            max_x = max_x.max(*x - padding as f32);
            max_y = max_y.max(*y - padding as f32);
        }

        let max_bound_x = width.saturating_sub(1) as f32;
        let max_bound_y = height.saturating_sub(1) as f32;
        let x = min_x.clamp(0.0, max_bound_x);
        let y = min_y.clamp(0.0, max_bound_y);
        let right = max_x.clamp(0.0, max_bound_x);
        let bottom = max_y.clamp(0.0, max_bound_y);
        [x, y, (right - x).max(1.0), (bottom - y).max(1.0)]
    }

    fn compose_full_text(blocks: &[OcrBlock], merge_paragraph: bool) -> String {
        if !merge_paragraph {
            return blocks
                .iter()
                .map(|block| block.text.trim())
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
        }

        let mut merged = String::new();
        let mut prev_bottom: Option<f32> = None;
        for block in blocks {
            let text = block.text.trim();
            if text.is_empty() {
                continue;
            }
            if let Some(bottom) = prev_bottom {
                let gap = block.bbox[1] - bottom;
                if gap > block.bbox[3] * 0.8 {
                    merged.push('\n');
                }
                merged.push('\n');
            }
            merged.push_str(text);
            prev_bottom = Some(block.bbox[1] + block.bbox[3]);
        }
        merged
    }

    fn decode_rec_output(&self, data: &[f32], shape: &[usize]) -> Result<(String, f32), String> {
        if shape.len() < 2 {
            return Err(format!("识别输出维度异常: {:?}", shape));
        }

        let (steps, classes, transposed) = if shape.len() == 3 {
            let d1 = shape[1];
            let d2 = shape[2];
            if d2.abs_diff(self.rec_keys.len()) <= d1.abs_diff(self.rec_keys.len()) {
                (d1, d2, false)
            } else {
                (d2, d1, true)
            }
        } else {
            let d1 = shape[shape.len() - 2];
            let d2 = shape[shape.len() - 1];
            if d2.abs_diff(self.rec_keys.len()) <= d1.abs_diff(self.rec_keys.len()) {
                (d1, d2, false)
            } else {
                (d2, d1, true)
            }
        };

        let mut text = String::new();
        let mut score_sum = 0.0_f32;
        let mut score_count = 0_u32;
        let mut last_index = usize::MAX;

        for step in 0..steps {
            let mut max_idx = 0_usize;
            let mut max_logit = f32::NEG_INFINITY;
            for class_idx in 0..classes {
                let value = if transposed {
                    data[class_idx * steps + step]
                } else {
                    data[step * classes + class_idx]
                };
                if value > max_logit {
                    max_logit = value;
                    max_idx = class_idx;
                }
            }

            let mut exp_sum = 0.0_f32;
            if max_logit.is_finite() {
                for class_idx in 0..classes {
                    let value = if transposed {
                        data[class_idx * steps + step]
                    } else {
                        data[step * classes + class_idx]
                    };
                    exp_sum += (value - max_logit).exp();
                }
            }
            let max_prob = if exp_sum.is_finite() && exp_sum > 0.0 {
                (1.0 / exp_sum).clamp(0.0, 1.0)
            } else {
                0.0
            };

            if max_idx > 0 && max_idx < self.rec_keys.len() && max_idx != last_index {
                text.push_str(&self.rec_keys[max_idx]);
                score_sum += max_prob;
                score_count += 1;
            }
            last_index = max_idx;
        }

        let confidence = if score_count > 0 {
            (score_sum / score_count as f32).clamp(0.0, 1.0)
        } else {
            0.0
        };

        Ok((text, confidence))
    }

    fn text_quality_score(text: &str) -> f32 {
        let mut total = 0usize;
        let mut valid = 0usize;
        let mut repeat_penalty = 0usize;
        let mut last_char: Option<char> = None;
        let mut repeat_run = 0usize;

        for ch in text.chars() {
            if ch.is_control() {
                continue;
            }
            total += 1;

            let is_common_cjk = ('\u{4E00}'..='\u{9FFF}').contains(&ch);
            let is_common_jp = ('\u{3040}'..='\u{30FF}').contains(&ch);
            let is_common_ko = ('\u{AC00}'..='\u{D7AF}').contains(&ch);
            if ch.is_ascii_alphanumeric()
                || ch.is_ascii_punctuation()
                || ch.is_whitespace()
                || is_common_cjk
                || is_common_jp
                || is_common_ko
            {
                valid += 1;
            }

            if let Some(prev) = last_char {
                if prev == ch {
                    repeat_run += 1;
                    if repeat_run >= 3 {
                        repeat_penalty += 1;
                    }
                } else {
                    repeat_run = 0;
                }
            }
            last_char = Some(ch);
        }

        if total == 0 {
            return -1.0;
        }

        let valid_ratio = valid as f32 / total as f32;
        let repeat_ratio = repeat_penalty as f32 / total as f32;
        valid_ratio - repeat_ratio * 0.5
    }

    fn rec_candidate_score(text: &str, confidence: f32) -> f32 {
        let text_len_bonus = (text.chars().count().min(40) as f32) / 400.0;
        let quality_bonus = Self::text_quality_score(text) * 0.08;
        confidence + text_len_bonus + quality_bonus
    }

    fn is_large_dict_model(&self) -> bool {
        self.rec_keys.len() >= 12000
    }

    fn rec_dynamic_window_width(&self) -> u32 {
        self.rec_step_count
            .map(|steps| steps.saturating_mul(OCR_REC_DYNAMIC_STEP_STRIDE))
            .unwrap_or(OCR_REC_DYNAMIC_MAX_WIDTH)
            .clamp(OCR_REC_DYNAMIC_MIN_WINDOW_WIDTH, OCR_REC_DYNAMIC_MAX_WIDTH)
    }

    fn rec_retry_thresholds(&self) -> (f32, f32, f32) {
        if self.is_large_dict_model() {
            (
                OCR_REC_ALT_RETRY_CONFIDENCE_LARGE_DICT,
                OCR_REC_ALT_DARK_RETRY_CONFIDENCE_LARGE_DICT,
                OCR_REC_BINARY_RETRY_CONFIDENCE_LARGE_DICT,
            )
        } else {
            (
                OCR_REC_ALT_RETRY_CONFIDENCE,
                OCR_REC_ALT_DARK_RETRY_CONFIDENCE,
                OCR_REC_BINARY_RETRY_CONFIDENCE,
            )
        }
    }

    fn run_rec_on_prepared(&mut self, prepared: &RgbImage) -> Result<(String, f32), String> {
        let input_tensor = subtract_mean_normalize(prepared, &OCR_REC_MEAN, &OCR_REC_NORM);
        let input_value = ort::value::Tensor::from_array(input_tensor)
            .map_err(|e| format!("创建识别输入张量失败: {}", e))?;
        let (data, shape) = {
            let outputs = self
                .rec_session
                .run(inputs![self.rec_input_name.clone() => input_value])
                .map_err(|e| format!("识别推理失败: {}", e))?;
            let (_, output) = outputs
                .iter()
                .next()
                .ok_or_else(|| "识别模型无输出".to_string())?;
            let (shape_ref, data_ref) = output
                .try_extract_tensor::<f32>()
                .map_err(|e| format!("识别输出解析失败: {}", e))?;
            let shape: Vec<usize> = shape_ref.iter().map(|&x| x as usize).collect();
            let data = data_ref.to_vec();
            (data, shape)
        };
        self.decode_rec_output(&data, &shape)
    }

    fn overlap_suffix_prefix_chars(left: &str, right: &str) -> usize {
        let left_chars = left.chars().collect::<Vec<_>>();
        let right_chars = right.chars().collect::<Vec<_>>();
        let max_overlap = left_chars
            .len()
            .min(right_chars.len())
            .min(OCR_REC_MERGE_MAX_OVERLAP_CHARS);
        for overlap in (1..=max_overlap).rev() {
            if left_chars[left_chars.len() - overlap..] == right_chars[..overlap] {
                return overlap;
            }
        }

        for overlap in (2..=max_overlap).rev() {
            let mut matched = 0usize;
            for i in 0..overlap {
                if left_chars[left_chars.len() - overlap + i] == right_chars[i] {
                    matched += 1;
                }
            }
            let ratio = matched as f32 / overlap as f32;
            let required = if overlap >= 12 {
                0.55
            } else if overlap >= 8 {
                0.6
            } else if overlap >= 5 {
                0.7
            } else {
                0.85
            };
            if ratio >= required {
                return overlap;
            }
        }
        0
    }

    fn merge_rec_segments(merged: &mut String, segment: &str) {
        let segment = segment.trim();
        if segment.is_empty() {
            return;
        }
        if merged.is_empty() {
            merged.push_str(segment);
            return;
        }

        let overlap = Self::overlap_suffix_prefix_chars(merged, segment);
        if overlap == 0 {
            merged.push_str(segment);
            return;
        }
        if overlap >= 8 {
            tracing::info!("OCR merge overlap chars: {}", overlap);
        } else {
            tracing::debug!("OCR merge overlap chars: {}", overlap);
        }
        for ch in segment.chars().skip(overlap) {
            merged.push(ch);
        }
    }

    fn recognize_text_line_sliding(
        &mut self,
        scaled_line: &RgbImage,
        fixed_w: u32,
    ) -> Result<(String, f32), String> {
        let sliding_started = Instant::now();
        let src_w = scaled_line.width();
        if src_w == 0 || fixed_w == 0 {
            return Ok((String::new(), 0.0));
        }

        let mut stride = ((fixed_w as f32) * OCR_REC_SLIDING_STRIDE_RATIO)
            .round()
            .max(1.0)
            .min(fixed_w as f32) as u32;
        if src_w > fixed_w && OCR_REC_SLIDING_MAX_WINDOWS > 1 {
            let span = src_w - fixed_w;
            let estimated_windows = ((span as f32) / stride as f32).ceil() as u32 + 1;
            if estimated_windows > OCR_REC_SLIDING_MAX_WINDOWS {
                stride = ((span as f32) / (OCR_REC_SLIDING_MAX_WINDOWS - 1) as f32)
                    .ceil()
                    .max(1.0)
                    .min(fixed_w as f32) as u32;
            }
        }

        let mut offset = 0u32;
        let mut merged_text = String::new();
        let mut conf_sum = 0.0_f32;
        let mut conf_count = 0u32;
        let mut window_count = 0u32;

        loop {
            window_count += 1;
            let window_w = (src_w - offset).min(fixed_w);
            let crop = image::imageops::crop_imm(scaled_line, offset, 0, window_w, OCR_REC_HEIGHT)
                .to_image();
            let prepared = if window_w == fixed_w {
                crop
            } else {
                let mut canvas =
                    RgbImage::from_pixel(fixed_w, OCR_REC_HEIGHT, image::Rgb([255, 255, 255]));
                image::imageops::replace(&mut canvas, &crop, 0, 0);
                canvas
            };

            let (text, confidence) = self.run_rec_on_prepared(&prepared)?;
            let segment_score = Self::rec_candidate_score(&text, confidence);
            let keep_segment = !text.trim().is_empty()
                && (segment_score >= OCR_REC_SLIDING_MIN_SEGMENT_SCORE || merged_text.is_empty());
            if keep_segment {
                Self::merge_rec_segments(&mut merged_text, &text);
                conf_sum += confidence.max(0.0);
                conf_count += 1;
            }

            if offset + fixed_w >= src_w {
                break;
            }
            let next = offset.saturating_add(stride);
            if next <= offset {
                break;
            }
            offset = next.min(src_w.saturating_sub(1));
        }
        if window_count >= 8 {
            tracing::debug!(
                "OCR sliding windows: src_w={}, fixed_w={}, stride={}, windows={}, elapsed={}ms",
                src_w,
                fixed_w,
                stride,
                window_count,
                sliding_started.elapsed().as_millis()
            );
        }

        let confidence = if conf_count > 0 {
            (conf_sum / conf_count as f32).clamp(0.0, 1.0)
        } else {
            0.0
        };
        Ok((merged_text, confidence))
    }

    fn recognize_text_line_once(&mut self, img_src: &RgbImage) -> Result<(String, f32), String> {
        let scale = OCR_REC_HEIGHT as f32 / img_src.height().max(1) as f32;
        let dst_width = ((img_src.width() as f32 * scale).round() as u32).max(1);

        if let Some(fixed_w) = self.rec_fixed_width {
            let scaled = image::imageops::resize(
                img_src,
                dst_width,
                OCR_REC_HEIGHT,
                image::imageops::FilterType::CatmullRom,
            );
            if dst_width > fixed_w {
                let sliding_trigger =
                    ((fixed_w as f32) * OCR_REC_SLIDING_TRIGGER_RATIO).ceil() as u32;
                if dst_width >= sliding_trigger {
                    let (sliding_text, sliding_confidence) =
                        self.recognize_text_line_sliding(&scaled, fixed_w)?;
                    let sliding_score =
                        Self::rec_candidate_score(&sliding_text, sliding_confidence);
                    if !sliding_text.trim().is_empty()
                        && sliding_score >= OCR_REC_SLIDING_ACCEPT_SCORE
                    {
                        return Ok((sliding_text, sliding_confidence));
                    }

                    let squeezed = image::imageops::resize(
                        &scaled,
                        fixed_w,
                        OCR_REC_HEIGHT,
                        image::imageops::FilterType::CatmullRom,
                    );
                    let (squeezed_text, squeezed_confidence) =
                        self.run_rec_on_prepared(&squeezed)?;
                    if sliding_text.trim().is_empty() {
                        return Ok((squeezed_text, squeezed_confidence));
                    }
                    let squeezed_score =
                        Self::rec_candidate_score(&squeezed_text, squeezed_confidence);
                    if squeezed_score > sliding_score + 0.03 {
                        return Ok((squeezed_text, squeezed_confidence));
                    }
                    return Ok((sliding_text, sliding_confidence));
                }
                let squeezed = image::imageops::resize(
                    &scaled,
                    fixed_w,
                    OCR_REC_HEIGHT,
                    image::imageops::FilterType::CatmullRom,
                );
                return self.run_rec_on_prepared(&squeezed);
            }

            let mut canvas =
                RgbImage::from_pixel(fixed_w, OCR_REC_HEIGHT, image::Rgb([255, 255, 255]));
            image::imageops::replace(&mut canvas, &scaled, 0, 0);
            return self.run_rec_on_prepared(&canvas);
        }

        let resized = image::imageops::resize(
            img_src,
            dst_width,
            OCR_REC_HEIGHT,
            image::imageops::FilterType::CatmullRom,
        );
        if self.is_large_dict_model() {
            let dynamic_window_w = self.rec_dynamic_window_width();
            if dst_width > dynamic_window_w {
                tracing::debug!(
                    "OCR dynamic rec use sliding: line_w={}, window_w={}, step_hint={:?}",
                    dst_width,
                    dynamic_window_w,
                    self.rec_step_count
                );
                let (sliding_text, sliding_confidence) =
                    self.recognize_text_line_sliding(&resized, dynamic_window_w)?;
                let sliding_score = Self::rec_candidate_score(&sliding_text, sliding_confidence);
                if !sliding_text.trim().is_empty()
                    && sliding_score >= OCR_REC_SLIDING_MIN_SEGMENT_SCORE
                {
                    return Ok((sliding_text, sliding_confidence));
                }
            }
        }
        self.run_rec_on_prepared(&resized)
    }

    fn recognize_text_line(&mut self, img_src: &RgbImage) -> Result<(String, f32), String> {
        let line_started = Instant::now();
        let large_dict = self.is_large_dict_model();
        let dark_background = is_dark_background_line(img_src);
        let (retry_conf, dark_retry_conf, binary_retry_conf) = self.rec_retry_thresholds();
        let max_attempts = if large_dict {
            OCR_REC_MAX_ATTEMPTS_LARGE_DICT
        } else {
            OCR_REC_MAX_ATTEMPTS_DEFAULT
        };
        let retry_max_text_len = if large_dict {
            OCR_REC_RETRY_MAX_TEXT_LEN_LARGE_DICT
        } else {
            OCR_REC_RETRY_MAX_TEXT_LEN
        };
        let mut attempts = 1u32;

        let (mut best_text, mut best_confidence) = self.recognize_text_line_once(img_src)?;
        let mut best_source = "original";
        let mut best_score = Self::rec_candidate_score(&best_text, best_confidence);
        let mut quality = Self::text_quality_score(&best_text);
        let text_len = best_text.chars().count();

        let should_retry = text_len <= 2
            || quality < 0.2
            || (best_confidence < retry_conf && text_len <= retry_max_text_len)
            || (dark_background
                && best_confidence < dark_retry_conf
                && quality < if large_dict { 0.35 } else { 0.45 });
        if should_retry {
            let inverted = invert_rgb_image(img_src);
            if attempts < max_attempts {
                attempts += 1;
                if let Ok((text, confidence)) = self.recognize_text_line_once(&inverted) {
                    let score = Self::rec_candidate_score(&text, confidence);
                    if score > best_score + OCR_REC_ALT_SWITCH_MARGIN {
                        best_text = text;
                        best_confidence = confidence;
                        best_score = score;
                        best_source = "inverted";
                        quality = Self::text_quality_score(&best_text);
                    }
                }
            }

            if attempts < max_attempts
                && (best_confidence < retry_conf || best_text.chars().count() <= 2 || quality < 0.2)
            {
                let contrasted = grayscale_contrast_image(img_src);
                attempts += 1;
                if let Ok((text, confidence)) = self.recognize_text_line_once(&contrasted) {
                    let score = Self::rec_candidate_score(&text, confidence);
                    if score > best_score + OCR_REC_ALT_SWITCH_MARGIN {
                        best_text = text;
                        best_confidence = confidence;
                        best_score = score;
                        best_source = "grayscale_contrast";
                        quality = Self::text_quality_score(&best_text);
                    }
                }

                if attempts < max_attempts
                    && dark_background
                    && (best_confidence < dark_retry_conf || quality < 0.25)
                {
                    let inverted_contrasted = grayscale_contrast_image(&inverted);
                    attempts += 1;
                    if let Ok((text, confidence)) =
                        self.recognize_text_line_once(&inverted_contrasted)
                    {
                        let score = Self::rec_candidate_score(&text, confidence);
                        if score > best_score + OCR_REC_ALT_SWITCH_MARGIN {
                            best_text = text;
                            best_confidence = confidence;
                            best_score = score;
                            best_source = "inverted_grayscale_contrast";
                            quality = Self::text_quality_score(&best_text);
                        }
                    }
                }
            }

            let allow_binary_retry =
                !large_dict || best_text.chars().count() <= 2 || quality < 0.05;
            if attempts < max_attempts
                && allow_binary_retry
                && (best_confidence < binary_retry_conf
                    || best_text.chars().count() <= 2
                    || quality < 0.1)
            {
                let binary = otsu_binary_image(img_src);
                attempts += 1;
                if let Ok((text, confidence)) = self.recognize_text_line_once(&binary) {
                    let score = Self::rec_candidate_score(&text, confidence);
                    if score > best_score + OCR_REC_ALT_SWITCH_MARGIN {
                        best_text = text;
                        best_confidence = confidence;
                        best_score = score;
                        best_source = "otsu_binary";
                        quality = Self::text_quality_score(&best_text);
                    }
                }

                if attempts < max_attempts {
                    let inverted_binary = invert_rgb_image(&binary);
                    attempts += 1;
                    if let Ok((text, confidence)) = self.recognize_text_line_once(&inverted_binary)
                    {
                        let score = Self::rec_candidate_score(&text, confidence);
                        if score > best_score + OCR_REC_ALT_SWITCH_MARGIN {
                            best_text = text;
                            best_confidence = confidence;
                            best_score = score;
                            best_source = "inverted_otsu_binary";
                            quality = Self::text_quality_score(&best_text);
                        }
                    }
                }
            }
        }

        if attempts > 1 {
            tracing::info!(
                "OCR line retry summary: attempts={}, source={}, score={:.3}, conf={:.3}, quality={:.3}, elapsed={}ms",
                attempts,
                best_source,
                best_score,
                best_confidence,
                quality,
                line_started.elapsed().as_millis()
            );
        }

        Ok((best_text, best_confidence))
    }

    fn detect_boxes(&mut self, img_src: &RgbImage) -> Result<Vec<TextBox>, String> {
        let detect_boxes_started = Instant::now();
        let prep_started = Instant::now();
        let (resized, scale) = if let Some((fixed_h, fixed_w)) = self.det_fixed_size {
            prepare_fixed_det_input(img_src, fixed_h, fixed_w)
        } else {
            let scale = ScaleParam::from_image(img_src, OCR_MAX_SIDE_LEN + OCR_PADDING * 2);
            let resized = image::imageops::resize(
                img_src,
                scale.dst_width,
                scale.dst_height,
                image::imageops::FilterType::CatmullRom,
            );
            (resized, scale)
        };
        let input_tensor = subtract_mean_normalize(&resized, &OCR_DET_MEAN, &OCR_DET_NORM);
        let prep_ms = prep_started.elapsed().as_millis();

        let infer_started = Instant::now();
        let input_value = ort::value::Tensor::from_array(input_tensor)
            .map_err(|e| format!("创建检测输入张量失败: {}", e))?;
        let outputs = self
            .det_session
            .run(inputs![self.det_input_name.clone() => input_value])
            .map_err(|e| format!("检测推理失败: {}", e))?;
        let (_, output) = outputs
            .iter()
            .next()
            .ok_or_else(|| "检测模型无输出".to_string())?;
        let (shape_ref, data_ref) = output
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("检测输出解析失败: {}", e))?;
        let infer_ms = infer_started.elapsed().as_millis();

        let post_started = Instant::now();
        let shape: Vec<usize> = shape_ref.iter().map(|&x| x as usize).collect();
        let (rows, cols) = match shape.as_slice() {
            [_, _, h, w] => (*h as u32, *w as u32),
            [_, h, w] => (*h as u32, *w as u32),
            [h, w] => (*h as u32, *w as u32),
            _ => return Err(format!("检测输出维度异常: {:?}", shape)),
        };
        let pred_data = data_ref.to_vec();
        let pred_img = image::ImageBuffer::<image::Luma<f32>, Vec<f32>>::from_vec(
            cols,
            rows,
            pred_data.clone(),
        )
        .ok_or_else(|| "检测输出尺寸不匹配".to_string())?;
        let cbuf_data = pred_data
            .iter()
            .map(|pixel| (pixel * 255.0).clamp(0.0, 255.0) as u8)
            .collect::<Vec<_>>();
        let cbuf_img = image::GrayImage::from_vec(cols, rows, cbuf_data)
            .ok_or_else(|| "检测输出灰度图构建失败".to_string())?;

        let threshold_img = imageproc::contrast::threshold(
            &cbuf_img,
            (OCR_BOX_THRESH * 255.0) as u8,
            imageproc::contrast::ThresholdType::Binary,
        );
        let dilate_img = imageproc::morphology::dilate(
            &threshold_img,
            imageproc::distance_transform::Norm::LInf,
            1,
        );
        let contours = imageproc::contours::find_contours::<i32>(&dilate_img);

        let mut boxes = Vec::new();
        for contour in contours {
            if contour.points.len() <= 2 {
                continue;
            }
            let Some((mini_box, min_edge)) = contour_min_box(&contour.points) else {
                continue;
            };
            if min_edge < OCR_MIN_BOX_EDGE {
                continue;
            }

            let score = contour_score(&contour, &pred_img);
            if score < OCR_BOX_SCORE_THRESH {
                continue;
            }

            let mapped_points = mini_box
                .iter()
                .map(|point| {
                    let x = (point.x / scale.scale_width)
                        .clamp(0.0, scale.src_width.saturating_sub(1) as f32);
                    let y = (point.y / scale.scale_height)
                        .clamp(0.0, scale.src_height.saturating_sub(1) as f32);
                    (x, y)
                })
                .collect::<Vec<_>>();
            boxes.push(TextBox {
                points: mapped_points,
                score,
            });
        }
        let raw_box_count = boxes.len();
        let before = raw_box_count;
        let boxes = suppress_text_boxes(boxes);
        let after = boxes.len();
        if after < before {
            tracing::info!("OCR text box NMS reduced {} -> {}", before, after);
        }
        let post_ms = post_started.elapsed().as_millis();
        let total_ms = detect_boxes_started.elapsed().as_millis();
        tracing::info!(
            "OCR detect_boxes timing: prep={}ms, infer={}ms, post={}ms, raw_boxes={}, final_boxes={}, total={}ms",
            prep_ms,
            infer_ms,
            post_ms,
            raw_box_count,
            after,
            total_ms
        );
        Ok(boxes)
    }

    fn detect_once(&mut self, img_src: &RgbImage) -> Result<Vec<OcrBlock>, String> {
        let detect_once_started = Instant::now();
        let padded = make_padding(img_src, OCR_PADDING);
        let det_started = Instant::now();
        let text_boxes = self.detect_boxes(&padded)?;
        let det_ms = det_started.elapsed().as_millis();
        if text_boxes.is_empty() {
            tracing::info!(
                "OCR detect_once timing: det={}ms, boxes=0, lines=0, rec_calls=0, rec=0ms, blocks=0, total={}ms",
                det_ms,
                detect_once_started.elapsed().as_millis()
            );
            return Ok(Vec::new());
        }

        let text_box_count = text_boxes.len();
        let mut split_line_count = 0usize;
        let mut rec_calls = 0usize;
        let mut rec_ms_sum = 0u128;
        let mut blocks = Vec::new();
        for text_box in text_boxes {
            let Some(part_image) = get_rotate_crop_image(&padded, &text_box.points) else {
                continue;
            };
            let split_lines = split_multiline_crop(&part_image);
            split_line_count += split_lines.len();
            if split_lines.len() > 1 {
                tracing::info!(
                    "OCR split multiline crop into {} lines (w={}, h={})",
                    split_lines.len(),
                    part_image.width(),
                    part_image.height()
                );
            }

            let mut line_texts = Vec::new();
            let mut line_conf_sum = 0.0_f32;
            let mut line_conf_count = 0_u32;
            for line_img in &split_lines {
                let rec_started = Instant::now();
                let (text, confidence) = match self.recognize_text_line(line_img) {
                    Ok(result) => result,
                    Err(err) => {
                        tracing::warn!("OCR line recognition failed: {}", err);
                        continue;
                    }
                };
                rec_ms_sum += rec_started.elapsed().as_millis();
                rec_calls += 1;
                let text = text.trim().to_string();
                if text.is_empty() {
                    continue;
                }
                line_texts.push(text);
                line_conf_sum += confidence.max(0.0);
                line_conf_count += 1;
            }

            if line_texts.is_empty() {
                continue;
            }
            let text = line_texts.join("\n");
            let confidence = if line_conf_count > 0 {
                (line_conf_sum / line_conf_count as f32).clamp(0.0, 1.0)
            } else {
                0.0
            };

            if text.is_empty() {
                continue;
            }
            let combined_confidence =
                ((confidence.max(0.0) + text_box.score.max(0.0)) / 2.0).clamp(0.0, 1.0);
            blocks.push(OcrBlock {
                text,
                confidence: combined_confidence,
                bbox: Self::bbox_from_points(
                    &text_box.points,
                    OCR_PADDING,
                    img_src.width(),
                    img_src.height(),
                ),
            });
        }
        tracing::info!(
            "OCR detect_once timing: det={}ms, boxes={}, lines={}, rec_calls={}, rec={}ms, blocks={}, total={}ms",
            det_ms,
            text_box_count,
            split_line_count,
            rec_calls,
            rec_ms_sum,
            blocks.len(),
            detect_once_started.elapsed().as_millis()
        );
        Ok(blocks)
    }

    fn detect_once_with_polarity_retry(
        &mut self,
        img_src: &RgbImage,
        try_inverted: bool,
    ) -> Result<Vec<OcrBlock>, String> {
        let origin_blocks = self.detect_once(img_src)?;
        if !try_inverted {
            return Ok(origin_blocks);
        }

        let origin_score = Self::blocks_quality_score(&origin_blocks);
        let origin_text_len = origin_blocks
            .iter()
            .map(|block| block.text.chars().count())
            .sum::<usize>();
        let (min_score, min_blocks, min_text_chars) = if self.is_large_dict_model() {
            (
                OCR_DETECT_POLARITY_RETRY_MIN_SCORE_LARGE_DICT,
                OCR_DETECT_POLARITY_RETRY_MIN_BLOCKS_LARGE_DICT,
                OCR_DETECT_POLARITY_RETRY_MIN_TEXT_CHARS_LARGE_DICT,
            )
        } else {
            (
                OCR_DETECT_POLARITY_RETRY_MIN_SCORE,
                OCR_DETECT_POLARITY_RETRY_MIN_BLOCKS,
                OCR_DETECT_POLARITY_RETRY_MIN_TEXT_CHARS,
            )
        };
        if origin_score >= min_score
            && origin_blocks.len() >= min_blocks
            && origin_text_len >= min_text_chars
        {
            tracing::info!(
                "OCR skip inverted detect retry: score={:.3}, blocks={}, text_len={}, gate=({:.2},{},{})",
                origin_score,
                origin_blocks.len(),
                origin_text_len,
                min_score,
                min_blocks,
                min_text_chars
            );
            return Ok(origin_blocks);
        }
        let inverted_img = invert_rgb_image(img_src);
        let inverted_blocks = self.detect_once(&inverted_img)?;
        let inverted_score = Self::blocks_quality_score(&inverted_blocks);

        if inverted_score > origin_score + 0.05 {
            tracing::info!(
                "OCR detect used inverted image variant (score {:.3} -> {:.3})",
                origin_score,
                inverted_score
            );
            Ok(inverted_blocks)
        } else {
            Ok(origin_blocks)
        }
    }

    pub fn detect_text(
        &mut self,
        image_data: &[u8],
        lang: &str,
        detect_rotation: bool,
        merge_paragraph: bool,
    ) -> Result<OcrResult, String> {
        let detect_text_started = Instant::now();
        let decode_started = Instant::now();
        let img = image::load_from_memory(image_data)
            .map_err(|e| format!("解码图片失败: {}", e))?
            .to_rgb8();
        let decode_ms = decode_started.elapsed().as_millis();

        let prefer_inverted_detect = is_dark_background_image(&img);
        let primary_started = Instant::now();
        let mut best_blocks = self.detect_once_with_polarity_retry(&img, prefer_inverted_detect)?;
        let primary_ms = primary_started.elapsed().as_millis();
        let mut rotation_detected = false;
        let mut rotation_angle = 0.0;
        let mut rotation_ms = 0u128;

        if detect_rotation {
            let rotation_started = Instant::now();
            let rotated = image::imageops::rotate180(&img);
            let mut rotated_blocks =
                self.detect_once_with_polarity_retry(&rotated, prefer_inverted_detect)?;
            Self::remap_bbox_from_180(&mut rotated_blocks, img.width(), img.height());
            if Self::blocks_quality_score(&rotated_blocks)
                > Self::blocks_quality_score(&best_blocks)
            {
                best_blocks = rotated_blocks;
                rotation_detected = true;
                rotation_angle = 180.0;
            }
            rotation_ms = rotation_started.elapsed().as_millis();
        }

        let post_started = Instant::now();
        best_blocks.sort_by(Self::reading_order_cmp);
        let full_text = Self::compose_full_text(&best_blocks, merge_paragraph);
        let post_ms = post_started.elapsed().as_millis();
        let total_ms = detect_text_started.elapsed().as_millis();
        tracing::info!(
            "OCR detect_text timing: decode={}ms, primary={}ms, rotation={}ms, post={}ms, blocks={}, total={}ms",
            decode_ms,
            primary_ms,
            rotation_ms,
            post_ms,
            best_blocks.len(),
            total_ms
        );

        Ok(OcrResult {
            full_text,
            blocks: best_blocks,
            language: lang.to_string(),
            rotation_detected,
            rotation_angle,
        })
    }
}
