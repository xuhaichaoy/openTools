use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct TranslateResult {
    pub text: String,
    pub translated: String,
    pub from_lang: String,
    pub to_lang: String,
    pub engine: String,
}

/// 翻译文本（调用外部 API）
#[tauri::command]
pub async fn translate_text(
    text: String,
    from_lang: String,
    to_lang: String,
    engine: Option<String>,
) -> Result<TranslateResult, String> {
    let engine_id = engine.unwrap_or_else(|| "google".to_string());

    match engine_id.as_str() {
        "google" => google_translate(&text, &from_lang, &to_lang).await,
        _ => Err(format!("Unsupported engine: {}", engine_id)),
    }
}

async fn google_translate(text: &str, from: &str, to: &str) -> Result<TranslateResult, String> {
    let url = format!(
        "https://translate.googleapis.com/translate_a/single?client=gtx&sl={}&tl={}&dt=t&q={}",
        from,
        to,
        urlencoding_encode(text)
    );

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0")
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Parse response failed: {}", e))?;

    // Google 翻译返回格式: [[["translated text","source text",null,null,10]],null,"en"]
    let translated = body
        .get(0)
        .and_then(|arr| arr.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.get(0).and_then(|v| v.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();

    Ok(TranslateResult {
        text: text.to_string(),
        translated,
        from_lang: from.to_string(),
        to_lang: to.to_string(),
        engine: "google".to_string(),
    })
}

fn urlencoding_encode(s: &str) -> String {
    percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
}
