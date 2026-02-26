use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OcrBlock {
    pub text: String,
    pub confidence: f32,
    pub bbox: [f32; 4],
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OcrResult {
    pub full_text: String,
    pub blocks: Vec<OcrBlock>,
    pub language: String,
    pub rotation_detected: bool,
    pub rotation_angle: f32,
}

#[derive(Debug, Serialize)]
struct OcrRequest {
    image_base64: String,
    lang: Option<String>,
    detect_rotation: Option<bool>,
    merge_paragraph: Option<bool>,
}

/// 高级 OCR 识别（通过服务端 API）
#[tauri::command]
pub async fn ocr_detect_advanced(
    image_base64: String,
    lang: Option<String>,
    detect_rotation: Option<bool>,
    merge_paragraph: Option<bool>,
    base_url: String,
    token: Option<String>,
) -> Result<OcrResult, String> {
    let url = format!("{}/v1/ocr/detect", base_url.trim_end_matches('/'));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))?;

    let mut req = client.post(&url).json(&OcrRequest {
        image_base64,
        lang,
        detect_rotation,
        merge_paragraph,
    });

    if let Some(t) = token {
        if !t.is_empty() {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("OCR 请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("OCR 服务返回错误 {status}: {body}"));
    }

    resp.json::<OcrResult>()
        .await
        .map_err(|e| format!("解析 OCR 结果失败: {e}"))
}

/// 基础 OCR 检测（兼容旧接口）
#[tauri::command]
pub async fn ocr_detect(_image_path: String) -> Result<String, String> {
    Ok("OCR Engine ready (server mode)".to_string())
}

/// 获取 OCR 运行时信息（服务端模式下始终返回 ready）
#[tauri::command]
pub async fn ocr_get_runtime_info() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "install_dir": "",
        "search_dirs": [],
        "required_files": [],
        "missing_required_files": [],
        "runtime_library_loaded": true,
        "runtime_library_path": null,
        "runtime_library_error": null,
        "runtime_search_dirs": [],
        "ready": true
    }))
}

/// 打开模型目录（服务端模式下无需本地模型）
#[tauri::command]
pub async fn ocr_open_model_dir() -> Result<String, String> {
    Ok("服务端 OCR 模式，无需本地模型".to_string())
}

/// 列出模型（服务端模式下返回空列表）
#[tauri::command]
pub async fn ocr_list_models() -> Result<Vec<serde_json::Value>, String> {
    Ok(vec![])
}
