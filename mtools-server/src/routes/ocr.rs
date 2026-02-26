use crate::error::{Error, Result};
use crate::routes::AppState;
use axum::{extract::State, routing::post, Json, Router};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::services::ocr::{OcrBlock, OcrEngine, OcrResult};

#[derive(Debug, Deserialize)]
pub struct OcrRequest {
    /// Base64 编码的图片
    pub image_base64: String,
    /// 识别语言，默认 "ch"
    pub lang: Option<String>,
    /// 是否检测旋转，默认 false
    pub detect_rotation: Option<bool>,
    /// 是否合并段落，默认 true
    pub merge_paragraph: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct OcrResponse {
    pub full_text: String,
    pub blocks: Vec<OcrBlock>,
    pub language: String,
    pub rotation_detected: bool,
    pub rotation_angle: f32,
}

impl From<OcrResult> for OcrResponse {
    fn from(r: OcrResult) -> Self {
        Self {
            full_text: r.full_text,
            blocks: r.blocks,
            language: r.language,
            rotation_detected: r.rotation_detected,
            rotation_angle: r.rotation_angle,
        }
    }
}

pub fn routes_no_layer() -> Router<Arc<AppState>> {
    Router::new().route("/detect", post(ocr_detect))
}

async fn ocr_detect(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<OcrRequest>,
) -> Result<Json<OcrResponse>> {
    let image_data = BASE64
        .decode(&payload.image_base64)
        .map_err(|e| Error::BadRequest(format!("Invalid base64 image: {e}")))?;

    let lang = payload.lang.unwrap_or_else(|| "ch".to_string());
    let detect_rotation = payload.detect_rotation.unwrap_or(false);
    let merge_paragraph = payload.merge_paragraph.unwrap_or(true);

    let model_dir = std::path::PathBuf::from(&state.config.ocr_model_dir);

    let result = tokio::task::spawn_blocking(move || {
        let mut engine = OcrEngine::new(&model_dir)
            .map_err(|e| Error::Internal(anyhow::anyhow!("OCR engine init failed: {e}")))?;
        let result = engine
            .detect_text(&image_data, &lang, detect_rotation, merge_paragraph)
            .map_err(|e| Error::Internal(anyhow::anyhow!("OCR detection failed: {e}")))?;
        Ok::<OcrResult, Error>(result)
    })
    .await
    .map_err(|e| Error::Internal(anyhow::anyhow!("OCR task panicked: {e}")))?;

    Ok(Json(result?.into()))
}
