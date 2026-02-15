use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use ort::session::Session;
use serde::{Deserialize, Serialize};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;

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

/// OCR 模型信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrModelInfo {
    pub language: String,
    pub display_name: String,
    pub file_name: String,
    pub installed: bool,
    pub file_size_mb: f64,
}

pub struct OcrEngine {
    det_model: Option<Session>,
    rec_model: Option<Session>,
    #[allow(dead_code)]
    cls_model: Option<Session>,
}

impl OcrEngine {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let resource_path = app
            .path()
            .resource_dir()
            .map_err(|e| format!("Get resource dir failed: {}", e))?
            .join("models")
            .join("ppocr");

        let det_model_path = resource_path.join("ppocr_det.onnx");
        let rec_model_path = resource_path.join("ppocr_rec.onnx");
        let cls_model_path = resource_path.join("ppocr_cls.onnx");

        let det_model = Self::load_model(&det_model_path, "detection");
        let rec_model = Self::load_model(&rec_model_path, "recognition");
        let cls_model = Self::load_model(&cls_model_path, "classification");

        Ok(Self {
            det_model,
            rec_model,
            cls_model,
        })
    }

    fn load_model(path: &PathBuf, name: &str) -> Option<Session> {
        if !path.exists() {
            log::info!("OCR {} model not found at {:?}, skipping.", name, path);
            return None;
        }
        match Session::builder()
            .and_then(|b| b.commit_from_file(path))
        {
            Ok(session) => {
                log::info!("OCR {} model loaded successfully.", name);
                Some(session)
            }
            Err(e) => {
                log::warn!("Failed to load OCR {} model: {}", name, e);
                None
            }
        }
    }

    pub fn is_available(&self) -> bool {
        self.det_model.is_some() && self.rec_model.is_some()
    }

    /// 执行 OCR 检测 (简化版 — 返回占位结果，具体推理逻辑需 ONNX 模型)
    pub fn detect_text(
        &self,
        image_data: &[u8],
        _lang: &str,
        _detect_rotation: bool,
        _merge_paragraph: bool,
    ) -> Result<OcrResult, String> {
        if !self.is_available() {
            return Err("OCR models not loaded. Please install OCR models first.".to_string());
        }

        // 解码图片验证格式
        let img = image::load_from_memory(image_data)
            .map_err(|e| format!("Failed to decode image: {}", e))?;
        let (width, height) = (img.width(), img.height());

        // TODO: 完整的推理流程:
        // 1. 预处理: 缩放到模型输入尺寸、归一化
        // 2. 检测模型推理: 获取文字区域
        // 3. 方向分类(可选): 判断文字方向
        // 4. 区域裁剪 + 识别模型推理: 对每个区域识别文字
        // 5. 后处理: 合并段落、排序

        // 暂时返回模型状态信息
        Ok(OcrResult {
            full_text: format!(
                "OCR Engine ready (image: {}x{}). Models loaded, inference pending full pipeline implementation.",
                width, height
            ),
            blocks: vec![],
            language: _lang.to_string(),
            rotation_detected: false,
            rotation_angle: 0.0,
        })
    }
}

/// 高级 OCR 识别
#[tauri::command]
pub async fn ocr_detect_advanced(
    image_base64: String,
    lang: Option<String>,
    detect_rotation: Option<bool>,
    merge_paragraph: Option<bool>,
    app: AppHandle,
) -> Result<OcrResult, String> {
    let lang = lang.unwrap_or_else(|| "ch".to_string());
    let detect_rotation = detect_rotation.unwrap_or(false);
    let merge_paragraph = merge_paragraph.unwrap_or(true);

    // 解码 base64 图片
    let image_data = BASE64
        .decode(&image_base64)
        .map_err(|e| format!("Invalid base64 image: {}", e))?;

    let engine = OcrEngine::new(&app)?;
    engine.detect_text(&image_data, &lang, detect_rotation, merge_paragraph)
}

/// 基础 OCR 检测（兼容旧接口）
#[tauri::command]
pub async fn ocr_detect(_image_path: String, app: AppHandle) -> Result<String, String> {
    match OcrEngine::new(&app) {
        Ok(engine) => {
            if engine.is_available() {
                Ok("OCR Engine ready (models loaded)".to_string())
            } else {
                Ok("OCR Engine initialized but models not found. Please install OCR models.".to_string())
            }
        }
        Err(e) => Err(format!("OCR Engine init failed: {}", e)),
    }
}

/// 列出可用的 OCR 模型
#[tauri::command]
pub async fn ocr_list_models(app: AppHandle) -> Result<Vec<OcrModelInfo>, String> {
    let resource_path = app
        .path()
        .resource_dir()
        .map_err(|e| format!("Get resource dir failed: {}", e))?
        .join("models")
        .join("ppocr");

    let models = vec![
        OcrModelInfo {
            language: "ch".to_string(),
            display_name: "中文".to_string(),
            file_name: "ppocr_rec.onnx".to_string(),
            installed: resource_path.join("ppocr_rec.onnx").exists(),
            file_size_mb: 12.0,
        },
        OcrModelInfo {
            language: "en".to_string(),
            display_name: "English".to_string(),
            file_name: "ppocr_rec_en.onnx".to_string(),
            installed: resource_path.join("ppocr_rec_en.onnx").exists(),
            file_size_mb: 8.0,
        },
        OcrModelInfo {
            language: "ja".to_string(),
            display_name: "日本語".to_string(),
            file_name: "ppocr_rec_ja.onnx".to_string(),
            installed: resource_path.join("ppocr_rec_ja.onnx").exists(),
            file_size_mb: 10.0,
        },
        OcrModelInfo {
            language: "ko".to_string(),
            display_name: "한국어".to_string(),
            file_name: "ppocr_rec_ko.onnx".to_string(),
            installed: resource_path.join("ppocr_rec_ko.onnx").exists(),
            file_size_mb: 10.0,
        },
    ];

    // 检测模型和方向分类模型（通用）
    let det_installed = resource_path.join("ppocr_det.onnx").exists();
    let cls_installed = resource_path.join("ppocr_cls.onnx").exists();

    let mut result = vec![
        OcrModelInfo {
            language: "det".to_string(),
            display_name: "文字检测模型 (通用)".to_string(),
            file_name: "ppocr_det.onnx".to_string(),
            installed: det_installed,
            file_size_mb: 4.0,
        },
        OcrModelInfo {
            language: "cls".to_string(),
            display_name: "方向分类模型 (通用)".to_string(),
            file_name: "ppocr_cls.onnx".to_string(),
            installed: cls_installed,
            file_size_mb: 2.0,
        },
    ];
    result.extend(models);
    Ok(result)
}
