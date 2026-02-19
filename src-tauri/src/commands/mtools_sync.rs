use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct SyncItem {
    pub data_id: String,
    pub content: serde_json::Value,
    pub version: i32,
    pub deleted: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SyncPushRequest {
    pub data_type: String,
    pub items: Vec<SyncItem>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SyncRow {
    pub id: String,
    pub user_id: String,
    pub data_type: String,
    pub data_id: String,
    pub content: serde_json::Value,
    pub version: i32,
    pub deleted: bool,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SyncPullResponse {
    pub items: Vec<SyncRow>,
    pub latest_version: i32,
}

/// 测试 mTools 服务器连接
#[tauri::command]
pub async fn mtools_sync_test(token: String, base_url: String) -> Result<bool, String> {
    let client = reqwest::Client::new();
    let response = client
        .get(format!("{}/health", base_url))
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("连接失败: {}", e))?;

    Ok(response.status().is_success())
}

/// 推送变更到 mTools 服务器
#[tauri::command]
pub async fn mtools_sync_push(
    token: String,
    base_url: String,
    request: SyncPushRequest,
) -> Result<bool, String> {
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{}/sync/push", base_url))
        .header("Authorization", format!("Bearer {}", token))
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("推送失败: {}", e))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("推送失败: {}", body));
    }

    Ok(true)
}

/// 从 mTools 服务器拉取变更
#[tauri::command]
pub async fn mtools_sync_pull(
    token: String,
    base_url: String,
    data_type: String,
    after_version: Option<i32>,
) -> Result<SyncPullResponse, String> {
    let client = reqwest::Client::new();
    let mut url = format!("{}/sync/pull?data_type={}", base_url, data_type);
    if let Some(version) = after_version {
        url.push_str(&format!("&after_version={}", version));
    }

    let response = client
        .get(url)
        .header("Authorization", format!("Bearer {}", token))
        .send()
        .await
        .map_err(|e| format!("拉取失败: {}", e))?;

    if !response.status().is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!("拉取失败: {}", body));
    }

    let result: SyncPullResponse = response
        .json()
        .await
        .map_err(|e| format!("解析失败: {}", e))?;
    Ok(result)
}
