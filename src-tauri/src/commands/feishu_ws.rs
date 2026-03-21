use base64::{engine::general_purpose, Engine as _};
use futures_util::{SinkExt, StreamExt};
use lark_websocket_protobuf::pbbp2::{Frame, Header};
use prost::Message as ProstMessage;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State as TauriState};
use tokio::sync::oneshot;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};

const FEISHU_BASE_URL: &str = "https://open.feishu.cn";
const LARK_BASE_URL: &str = "https://open.larksuite.com";
const FEISHU_WS_ENDPOINT_PATH: &str = "/callback/ws/endpoint";
const INITIAL_CONNECT_TIMEOUT_SECS: u64 = 20;
const HEARTBEAT_TIMEOUT_SECS: u64 = 120;
const RECONNECT_DELAY_SECS: u64 = 3;
const SPLIT_PAYLOAD_TTL_SECS: u64 = 30;
const DEFAULT_PING_INTERVAL_SECS: u64 = 30;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuWsStatus {
    pub channel_id: String,
    pub state: String,
    pub last_error: Option<String>,
}

struct FeishuWsRuntime {
    token: u64,
    state: String,
    last_error: Option<String>,
    stop_tx: Option<oneshot::Sender<()>>,
}

impl FeishuWsRuntime {
    fn new_pending(token: u64, stop_tx: oneshot::Sender<()>) -> Self {
        Self {
            token,
            state: "starting".to_string(),
            last_error: None,
            stop_tx: Some(stop_tx),
        }
    }
}

#[derive(Clone)]
pub struct FeishuWsManager {
    inner: Arc<Mutex<HashMap<String, FeishuWsRuntime>>>,
    next_token: Arc<AtomicU64>,
}

impl FeishuWsManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            next_token: Arc::new(AtomicU64::new(1)),
        }
    }

    pub fn get_status(&self, channel_id: &str) -> Result<Option<FeishuWsStatus>, String> {
        let guard = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(guard
            .get(channel_id)
            .map(|runtime| snapshot_status(channel_id, runtime)))
    }

    pub async fn start_channel(
        &self,
        app: AppHandle,
        channel_id: String,
        app_id: String,
        app_secret: String,
        base_url: Option<String>,
    ) -> Result<FeishuWsStatus, String> {
        self.stop_channel(&channel_id).await?;

        let normalized_base_url = normalize_base_url(base_url.as_deref());
        request_feishu_ws_endpoint(&normalized_base_url, &app_id, &app_secret).await?;

        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();
        let token = self.next_token.fetch_add(1, Ordering::SeqCst);

        {
            let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
            guard.insert(
                channel_id.clone(),
                FeishuWsRuntime::new_pending(token, stop_tx),
            );
        }

        let state = self.inner.clone();
        let task_channel_id = channel_id.clone();
        tauri::async_runtime::spawn(async move {
            run_feishu_ws_loop(
                app,
                state,
                task_channel_id,
                token,
                app_id,
                app_secret,
                normalized_base_url,
                stop_rx,
                ready_tx,
            )
            .await;
        });

        match tokio::time::timeout(Duration::from_secs(INITIAL_CONNECT_TIMEOUT_SECS), ready_rx)
            .await
        {
            Ok(Ok(Ok(()))) => self
                .get_status(&channel_id)?
                .ok_or_else(|| "飞书长连接状态丢失".to_string()),
            Ok(Ok(Err(err))) => {
                let _ = self.stop_channel(&channel_id).await;
                Err(err)
            }
            Ok(Err(_)) => {
                let _ = self.stop_channel(&channel_id).await;
                Err("飞书长连接初始化被中断".to_string())
            }
            Err(_) => {
                let _ = self.stop_channel(&channel_id).await;
                Err("飞书长连接初始化超时".to_string())
            }
        }
    }

    pub async fn stop_channel(&self, channel_id: &str) -> Result<(), String> {
        let stop_tx = {
            let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
            guard
                .remove(channel_id)
                .and_then(|mut runtime| runtime.stop_tx.take())
        };

        if let Some(tx) = stop_tx {
            let _ = tx.send(());
        }

        Ok(())
    }
}

#[derive(Debug, Deserialize)]
struct FeishuWsEndpointResponse {
    code: i32,
    msg: String,
    data: Option<FeishuWsEndpointData>,
}

#[derive(Debug, Deserialize)]
struct FeishuWsEndpointData {
    #[serde(rename = "URL")]
    url: Option<String>,
    #[serde(rename = "ClientConfig")]
    client_config: Option<FeishuWsClientConfig>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "PascalCase")]
struct FeishuWsClientConfig {
    reconnect_count: i32,
    reconnect_interval: i32,
    reconnect_nonce: i32,
    ping_interval: i32,
}

#[derive(Debug)]
struct PendingPayload {
    parts: Vec<Option<Vec<u8>>>,
    created_at: Instant,
}

#[derive(Debug, Serialize)]
struct FeishuWsAckPayload {
    code: u16,
    headers: HashMap<String, String>,
    data: Vec<u8>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuTenantAccessTokenResult {
    pub tenant_access_token: String,
    pub expire: u64,
}

#[derive(Debug, Deserialize)]
struct FeishuTenantAccessTokenResponse {
    code: i32,
    msg: String,
    tenant_access_token: Option<String>,
    expire: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct FeishuSendMessageResponse {
    code: i32,
    msg: String,
}

#[derive(Debug, Deserialize)]
struct FeishuReactionResponse {
    code: i32,
    msg: String,
    data: Option<FeishuReactionResponseData>,
}

#[derive(Debug, Deserialize)]
struct FeishuReactionResponseData {
    reaction_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FeishuUploadImageResponse {
    code: i32,
    msg: String,
    data: Option<FeishuUploadImageData>,
}

#[derive(Debug, Deserialize)]
struct FeishuUploadImageData {
    #[serde(rename = "image_key")]
    image_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FeishuUploadFileResponse {
    code: i32,
    msg: String,
    data: Option<FeishuUploadFileData>,
}

#[derive(Debug, Deserialize)]
struct FeishuUploadFileData {
    #[serde(rename = "file_key")]
    file_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuTypingReactionResult {
    pub reaction_id: String,
}

#[tauri::command]
pub async fn start_feishu_ws_channel(
    app: AppHandle,
    manager: TauriState<'_, FeishuWsManager>,
    channel_id: String,
    app_id: String,
    app_secret: String,
    base_url: Option<String>,
) -> Result<FeishuWsStatus, String> {
    manager
        .inner()
        .clone()
        .start_channel(app, channel_id, app_id, app_secret, base_url)
        .await
}

#[tauri::command]
pub async fn stop_feishu_ws_channel(
    manager: TauriState<'_, FeishuWsManager>,
    channel_id: String,
) -> Result<(), String> {
    manager.inner().clone().stop_channel(&channel_id).await
}

#[tauri::command]
pub async fn get_feishu_ws_channel_status(
    manager: TauriState<'_, FeishuWsManager>,
    channel_id: String,
) -> Result<Option<FeishuWsStatus>, String> {
    manager.get_status(&channel_id)
}

#[tauri::command]
pub async fn feishu_refresh_tenant_access_token(
    app_id: String,
    app_secret: String,
    base_url: Option<String>,
) -> Result<FeishuTenantAccessTokenResult, String> {
    let normalized_base_url = normalize_base_url(base_url.as_deref());
    request_feishu_tenant_access_token(&normalized_base_url, &app_id, &app_secret).await
}

#[tauri::command]
pub async fn feishu_send_app_message(
    app_id: String,
    app_secret: String,
    base_url: Option<String>,
    receive_id: String,
    msg_type: String,
    content: String,
    reply_to_message_id: Option<String>,
) -> Result<(), String> {
    let normalized_base_url = normalize_base_url(base_url.as_deref());
    let token =
        request_feishu_tenant_access_token(&normalized_base_url, &app_id, &app_secret).await?;

    let client = reqwest::Client::new();
    let response = if let Some(reply_to_message_id) = reply_to_message_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        client
            .post(format!(
                "{}/open-apis/im/v1/messages/{}/reply",
                normalized_base_url.trim_end_matches('/'),
                reply_to_message_id
            ))
            .bearer_auth(&token.tenant_access_token)
            .json(&json!({
                "msg_type": msg_type,
                "content": content,
            }))
            .send()
            .await
            .map_err(|e| format!("飞书回复消息失败: {}", e))?
    } else {
        client
            .post(format!(
                "{}/open-apis/im/v1/messages?receive_id_type=chat_id",
                normalized_base_url.trim_end_matches('/')
            ))
            .bearer_auth(&token.tenant_access_token)
            .json(&json!({
                "receive_id": receive_id,
                "msg_type": msg_type,
                "content": content,
            }))
            .send()
            .await
            .map_err(|e| format!("飞书发送消息失败: {}", e))?
    };

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("飞书发送消息失败: HTTP {} {}", status, body));
    }

    let payload = response
        .json::<FeishuSendMessageResponse>()
        .await
        .map_err(|e| format!("飞书发送消息响应解析失败: {}", e))?;

    if payload.code != 0 {
        return Err(format!(
            "飞书发送消息失败: {} ({})",
            payload.msg, payload.code
        ));
    }

    Ok(())
}

#[tauri::command]
pub async fn feishu_add_typing_reaction(
    app_id: String,
    app_secret: String,
    base_url: Option<String>,
    message_id: String,
) -> Result<FeishuTypingReactionResult, String> {
    let normalized_base_url = normalize_base_url(base_url.as_deref());
    let token =
        request_feishu_tenant_access_token(&normalized_base_url, &app_id, &app_secret).await?;
    let client = reqwest::Client::new();
    let response = client
        .post(format!(
            "{}/open-apis/im/v1/messages/{}/reactions",
            normalized_base_url.trim_end_matches('/'),
            message_id
        ))
        .bearer_auth(&token.tenant_access_token)
        .json(&json!({
            "reaction_type": {
                "emoji_type": "Typing",
            },
        }))
        .send()
        .await
        .map_err(|e| format!("飞书输入提示创建失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("飞书输入提示创建失败: HTTP {} {}", status, body));
    }

    let payload = response
        .json::<FeishuReactionResponse>()
        .await
        .map_err(|e| format!("飞书输入提示响应解析失败: {}", e))?;

    if payload.code != 0 {
        return Err(format!(
            "飞书输入提示创建失败: {} ({})",
            payload.msg, payload.code
        ));
    }

    let reaction_id = payload
        .data
        .and_then(|data| data.reaction_id)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "飞书输入提示创建失败: 未返回 reaction_id".to_string())?;

    Ok(FeishuTypingReactionResult { reaction_id })
}

#[tauri::command]
pub async fn feishu_remove_typing_reaction(
    app_id: String,
    app_secret: String,
    base_url: Option<String>,
    message_id: String,
    reaction_id: String,
) -> Result<(), String> {
    let normalized_base_url = normalize_base_url(base_url.as_deref());
    let token =
        request_feishu_tenant_access_token(&normalized_base_url, &app_id, &app_secret).await?;
    let client = reqwest::Client::new();
    let response = client
        .delete(format!(
            "{}/open-apis/im/v1/messages/{}/reactions/{}",
            normalized_base_url.trim_end_matches('/'),
            message_id,
            reaction_id
        ))
        .bearer_auth(&token.tenant_access_token)
        .send()
        .await
        .map_err(|e| format!("飞书输入提示移除失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("飞书输入提示移除失败: HTTP {} {}", status, body));
    }

    let payload = response
        .json::<FeishuSendMessageResponse>()
        .await
        .map_err(|e| format!("飞书输入提示移除响应解析失败: {}", e))?;

    if payload.code != 0 {
        return Err(format!(
            "飞书输入提示移除失败: {} ({})",
            payload.msg, payload.code
        ));
    }

    Ok(())
}

#[tauri::command]
pub async fn feishu_upload_image(
    app_id: String,
    app_secret: String,
    base_url: Option<String>,
    file_path: String,
) -> Result<String, String> {
    let normalized_base_url = normalize_base_url(base_url.as_deref());
    let token =
        request_feishu_tenant_access_token(&normalized_base_url, &app_id, &app_secret).await?;

    let file_content = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("读取本地文件失败: {}", e))?;

    let form = reqwest::multipart::Form::new()
        .text("image_type", "message")
        .part(
            "image",
            reqwest::multipart::Part::bytes(file_content).file_name("image.png"),
        );

    let client = reqwest::Client::new();
    let response = client
        .post(format!(
            "{}/open-apis/im/v1/images",
            normalized_base_url.trim_end_matches('/')
        ))
        .bearer_auth(&token.tenant_access_token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("飞书图片上传失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("飞书图片上传失败: HTTP {} {}", status, body));
    }

    let payload = response
        .json::<FeishuUploadImageResponse>()
        .await
        .map_err(|e| format!("飞书图片上传响应解析失败: {}", e))?;

    if payload.code != 0 {
        return Err(format!(
            "飞书图片上传失败: {} ({})",
            payload.msg, payload.code
        ));
    }

    let image_key = payload
        .data
        .and_then(|d| d.image_key)
        .ok_or_else(|| "飞书图片上传响应缺少 image_key".to_string())?;

    Ok(image_key)
}

#[tauri::command]
pub async fn feishu_get_image_as_base64(
    app_id: String,
    app_secret: String,
    base_url: Option<String>,
    image_key: String,
) -> Result<String, String> {
    let normalized_base_url = normalize_base_url(base_url.as_deref());
    let token =
        request_feishu_tenant_access_token(&normalized_base_url, &app_id, &app_secret).await?;

    log::info!("[Feishu] Fetching image content for key: {}", image_key);

    let url = format!(
        "{}/open-apis/im/v1/images/{}",
        normalized_base_url, image_key
    );
    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .header(
            "Authorization",
            format!("Bearer {}", token.tenant_access_token),
        )
        .send()
        .await
        .map_err(|e| format!("获取飞书图片失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();
        return Err(format!("获取飞书图片失败: HTTP {} {}", status, body_text));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取图片数据失败: {}", e))?;

    let b64 = general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:image/png;base64,{}", b64))
}

#[tauri::command]
pub async fn feishu_upload_file(
    app_id: String,
    app_secret: String,
    base_url: Option<String>,
    file_type: String, // pdf, doc, xls, ppt, stream
    file_path: String,
) -> Result<String, String> {
    let normalized_base_url = normalize_base_url(base_url.as_deref());
    let token =
        request_feishu_tenant_access_token(&normalized_base_url, &app_id, &app_secret).await?;

    let file_content = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("读取本地文件失败: {}", e))?;

    let file_name = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();

    let form = reqwest::multipart::Form::new()
        .text("file_type", file_type)
        .text("file_name", file_name.clone())
        .part(
            "file",
            reqwest::multipart::Part::bytes(file_content).file_name(file_name),
        );

    let client = reqwest::Client::new();
    let response = client
        .post(format!(
            "{}/open-apis/im/v1/files",
            normalized_base_url.trim_end_matches('/')
        ))
        .bearer_auth(&token.tenant_access_token)
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("飞书文件上传失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("飞书文件上传失败: HTTP {} {}", status, body));
    }

    let payload = response
        .json::<FeishuUploadFileResponse>()
        .await
        .map_err(|e| format!("飞书文件上传响应解析失败: {}", e))?;

    if payload.code != 0 {
        return Err(format!(
            "飞书文件上传失败: {} ({})",
            payload.msg, payload.code
        ));
    }

    let file_key = payload
        .data
        .and_then(|d| d.file_key)
        .ok_or_else(|| "飞书文件上传响应缺少 file_key".to_string())?;

    Ok(file_key)
}

#[tauri::command]
pub async fn feishu_send_webhook_message(webhook_url: String, body: Value) -> Result<(), String> {
    let client = reqwest::Client::new();
    let response = client
        .post(webhook_url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("飞书 Webhook 发送失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("飞书 Webhook 发送失败: HTTP {} {}", status, body));
    }

    let payload = response
        .json::<Value>()
        .await
        .map_err(|e| format!("飞书 Webhook 响应解析失败: {}", e))?;

    let code = payload
        .get("code")
        .and_then(Value::as_i64)
        .or_else(|| payload.get("StatusCode").and_then(Value::as_i64))
        .unwrap_or(0);

    if code != 0 {
        let msg = payload
            .get("msg")
            .and_then(Value::as_str)
            .or_else(|| payload.get("StatusMessage").and_then(Value::as_str))
            .unwrap_or("unknown error");
        return Err(format!("飞书 Webhook 发送失败: {} ({})", msg, code));
    }

    Ok(())
}

async fn run_feishu_ws_loop(
    app: AppHandle,
    state: Arc<Mutex<HashMap<String, FeishuWsRuntime>>>,
    channel_id: String,
    token: u64,
    app_id: String,
    app_secret: String,
    base_url: String,
    mut stop_rx: oneshot::Receiver<()>,
    ready_tx: oneshot::Sender<Result<(), String>>,
) {
    let mut ready_tx = Some(ready_tx);
    let mut is_first_attempt = true;

    loop {
        if should_stop(&state, &channel_id, token) {
            return;
        }

        update_runtime_state(
            &state,
            &channel_id,
            token,
            if is_first_attempt {
                "starting"
            } else {
                "reconnecting"
            },
            None,
        );

        let endpoint = match request_feishu_ws_endpoint(&base_url, &app_id, &app_secret).await {
            Ok(endpoint) => endpoint,
            Err(err) => {
                update_runtime_state(&state, &channel_id, token, "error", Some(err.clone()));
                if let Some(tx) = ready_tx.take() {
                    let _ = tx.send(Err(err));
                    return;
                }
                if wait_or_stop(&mut stop_rx, Duration::from_secs(RECONNECT_DELAY_SECS)).await {
                    let _ = remove_runtime(&state, &channel_id, token);
                    return;
                }
                is_first_attempt = false;
                continue;
            }
        };

        let ws_url = endpoint
            .url
            .as_deref()
            .ok_or_else(|| "飞书长连接端点缺少 URL".to_string());
        let ws_url = match ws_url {
            Ok(url) if !url.trim().is_empty() => url.to_string(),
            _ => {
                let err = "飞书长连接端点缺少可用的 WebSocket URL".to_string();
                update_runtime_state(&state, &channel_id, token, "error", Some(err.clone()));
                if let Some(tx) = ready_tx.take() {
                    let _ = tx.send(Err(err));
                    return;
                }
                if wait_or_stop(&mut stop_rx, Duration::from_secs(RECONNECT_DELAY_SECS)).await {
                    let _ = remove_runtime(&state, &channel_id, token);
                    return;
                }
                is_first_attempt = false;
                continue;
            }
        };

        let service_id = match extract_service_id(&ws_url) {
            Ok(service_id) => service_id,
            Err(err) => {
                update_runtime_state(&state, &channel_id, token, "error", Some(err.clone()));
                if let Some(tx) = ready_tx.take() {
                    let _ = tx.send(Err(err));
                    return;
                }
                if wait_or_stop(&mut stop_rx, Duration::from_secs(RECONNECT_DELAY_SECS)).await {
                    let _ = remove_runtime(&state, &channel_id, token);
                    return;
                }
                is_first_attempt = false;
                continue;
            }
        };

        let ws_result = connect_async(ws_url.as_str()).await;
        let (mut ws_stream, _) = match ws_result {
            Ok(ok) => ok,
            Err(err) => {
                let err_msg = format!("飞书 WebSocket 连接失败: {}", err);
                update_runtime_state(&state, &channel_id, token, "error", Some(err_msg.clone()));
                if let Some(tx) = ready_tx.take() {
                    let _ = tx.send(Err(err_msg));
                    return;
                }
                if wait_or_stop(&mut stop_rx, Duration::from_secs(RECONNECT_DELAY_SECS)).await {
                    let _ = remove_runtime(&state, &channel_id, token);
                    return;
                }
                is_first_attempt = false;
                continue;
            }
        };

        let initial_ping_interval = endpoint
            .client_config
            .as_ref()
            .map(|config| normalize_ping_interval(config.ping_interval))
            .unwrap_or(DEFAULT_PING_INTERVAL_SECS);
        let mut ping_interval_secs = initial_ping_interval;
        let mut ping_timer = tokio::time::interval(Duration::from_secs(ping_interval_secs));
        let mut heartbeat_timer = tokio::time::interval(Duration::from_secs(1));
        let mut last_pong_at = Instant::now();
        let mut split_payloads = HashMap::<String, PendingPayload>::new();

        update_runtime_state(&state, &channel_id, token, "connected", None);
        if let Some(tx) = ready_tx.take() {
            let _ = tx.send(Ok(()));
        }

        loop {
            tokio::select! {
                _ = &mut stop_rx => {
                    let _ = ws_stream.close(None).await;
                    let _ = remove_runtime(&state, &channel_id, token);
                    return;
                }
                _ = ping_timer.tick() => {
                    let frame = build_ping_frame(service_id);
                    if let Err(err) = ws_stream.send(Message::Binary(frame.encode_to_vec())).await {
                        update_runtime_state(
                            &state,
                            &channel_id,
                            token,
                            "error",
                            Some(format!("飞书 ping 发送失败: {}", err)),
                        );
                        break;
                    }
                }
                _ = heartbeat_timer.tick() => {
                    cleanup_expired_payloads(&mut split_payloads);
                    if last_pong_at.elapsed() > Duration::from_secs(HEARTBEAT_TIMEOUT_SECS) {
                        update_runtime_state(
                            &state,
                            &channel_id,
                            token,
                            "reconnecting",
                            Some("飞书长连接心跳超时，准备重连".to_string()),
                        );
                        break;
                    }
                }
                next = ws_stream.next() => {
                    match next {
                        Some(Ok(Message::Binary(data))) => {
                            match process_ws_binary_message(
                                &app,
                                &channel_id,
                                data.as_ref(),
                                service_id,
                                &mut split_payloads,
                            ) {
                                Ok(FrameProcessResult::Ack(frame)) => {
                                    if let Err(err) = ws_stream.send(Message::Binary(frame.encode_to_vec())).await {
                                        update_runtime_state(
                                            &state,
                                            &channel_id,
                                            token,
                                            "error",
                                            Some(format!("飞书 ACK 发送失败: {}", err)),
                                        );
                                        break;
                                    }
                                }
                                Ok(FrameProcessResult::UpdatePingInterval(next_interval)) => {
                                    last_pong_at = Instant::now();
                                    if next_interval != ping_interval_secs {
                                        ping_interval_secs = next_interval;
                                        ping_timer = tokio::time::interval(Duration::from_secs(ping_interval_secs));
                                    }
                                }
                                Ok(FrameProcessResult::Noop) => {}
                                Err(err) => {
                                    update_runtime_state(&state, &channel_id, token, "error", Some(err));
                                    break;
                                }
                            }
                        }
                        Some(Ok(Message::Ping(payload))) => {
                            if let Err(err) = ws_stream.send(Message::Pong(payload)).await {
                                update_runtime_state(
                                    &state,
                                    &channel_id,
                                    token,
                                    "error",
                                    Some(format!("飞书 WebSocket pong 发送失败: {}", err)),
                                );
                                break;
                            }
                        }
                        Some(Ok(Message::Pong(_))) => {
                            last_pong_at = Instant::now();
                        }
                        Some(Ok(Message::Close(_))) => {
                            update_runtime_state(
                                &state,
                                &channel_id,
                                token,
                                "reconnecting",
                                Some("飞书 WebSocket 连接已关闭，准备重连".to_string()),
                            );
                            break;
                        }
                        Some(Ok(_)) => {}
                        Some(Err(err)) => {
                            update_runtime_state(
                                &state,
                                &channel_id,
                                token,
                                "error",
                                Some(format!("飞书 WebSocket 读取失败: {}", err)),
                            );
                            break;
                        }
                        None => {
                            update_runtime_state(
                                &state,
                                &channel_id,
                                token,
                                "reconnecting",
                                Some("飞书 WebSocket 连接已断开，准备重连".to_string()),
                            );
                            break;
                        }
                    }
                }
            }
        }

        if wait_or_stop(&mut stop_rx, Duration::from_secs(RECONNECT_DELAY_SECS)).await {
            let _ = remove_runtime(&state, &channel_id, token);
            return;
        }
        is_first_attempt = false;
    }
}

async fn request_feishu_ws_endpoint(
    base_url: &str,
    app_id: &str,
    app_secret: &str,
) -> Result<FeishuWsEndpointData, String> {
    let client = reqwest::Client::new();
    let response = client
        .post(format!(
            "{}/{}",
            base_url.trim_end_matches('/'),
            FEISHU_WS_ENDPOINT_PATH.trim_start_matches('/')
        ))
        .json(&json!({
            "AppID": app_id,
            "AppSecret": app_secret,
        }))
        .send()
        .await
        .map_err(|e| format!("飞书长连接端点请求失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("飞书长连接端点请求失败: HTTP {} {}", status, body));
    }

    let payload = response
        .json::<FeishuWsEndpointResponse>()
        .await
        .map_err(|e| format!("飞书长连接端点响应解析失败: {}", e))?;

    if payload.code != 0 {
        return Err(format!(
            "飞书长连接端点校验失败: {} ({})",
            payload.msg, payload.code
        ));
    }

    let data = payload
        .data
        .ok_or_else(|| "飞书长连接端点缺少 data 字段".to_string())?;
    if data.url.as_ref().is_none_or(|url| url.trim().is_empty()) {
        return Err("飞书长连接端点校验失败: 未返回可用的 WebSocket URL".to_string());
    }

    Ok(data)
}

async fn request_feishu_tenant_access_token(
    base_url: &str,
    app_id: &str,
    app_secret: &str,
) -> Result<FeishuTenantAccessTokenResult, String> {
    let client = reqwest::Client::new();
    let response = client
        .post(format!(
            "{}/open-apis/auth/v3/tenant_access_token/internal",
            base_url.trim_end_matches('/')
        ))
        .json(&json!({
            "app_id": app_id,
            "app_secret": app_secret,
        }))
        .send()
        .await
        .map_err(|e| format!("飞书 tenant_access_token 请求失败: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "飞书 tenant_access_token 请求失败: HTTP {} {}",
            status, body
        ));
    }

    let payload = response
        .json::<FeishuTenantAccessTokenResponse>()
        .await
        .map_err(|e| format!("飞书 tenant_access_token 响应解析失败: {}", e))?;

    if payload.code != 0 {
        return Err(format!(
            "飞书 tenant_access_token 获取失败: {} ({})",
            payload.msg, payload.code
        ));
    }

    let tenant_access_token = payload
        .tenant_access_token
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| "飞书 tenant_access_token 响应缺少 token".to_string())?;
    let expire = payload.expire.unwrap_or(0);
    if expire == 0 {
        return Err("飞书 tenant_access_token 响应缺少有效过期时间".to_string());
    }

    Ok(FeishuTenantAccessTokenResult {
        tenant_access_token,
        expire,
    })
}

fn process_ws_binary_message(
    app: &AppHandle,
    channel_id: &str,
    bytes: &[u8],
    service_id: i32,
    split_payloads: &mut HashMap<String, PendingPayload>,
) -> Result<FrameProcessResult, String> {
    let frame = Frame::decode(bytes).map_err(|e| format!("飞书消息解码失败: {}", e))?;
    let frame = match combine_frame_payload(frame, split_payloads) {
        Ok(Some(frame)) => frame,
        Ok(None) => return Ok(FrameProcessResult::Noop),
        Err(err) => return Err(err),
    };

    match frame.method {
        0 => handle_control_frame(frame),
        1 => handle_data_frame(app, channel_id, frame, service_id),
        method => Err(format!("飞书消息包含未知的 frame method: {}", method)),
    }
}

fn handle_control_frame(frame: Frame) -> Result<FrameProcessResult, String> {
    let frame_type = header_value(&frame.headers, "type").unwrap_or_default();
    if frame_type != "pong" {
        return Ok(FrameProcessResult::Noop);
    }

    let next_interval = frame
        .payload
        .as_deref()
        .and_then(|payload| serde_json::from_slice::<FeishuWsClientConfig>(payload).ok())
        .map(|config| normalize_ping_interval(config.ping_interval))
        .unwrap_or(DEFAULT_PING_INTERVAL_SECS);

    Ok(FrameProcessResult::UpdatePingInterval(next_interval))
}

fn handle_data_frame(
    app: &AppHandle,
    channel_id: &str,
    mut frame: Frame,
    service_id: i32,
) -> Result<FrameProcessResult, String> {
    let frame_type = header_value(&frame.headers, "type").unwrap_or_default();
    if frame_type != "event" {
        return Ok(FrameProcessResult::Noop);
    }

    let payload = frame
        .payload
        .take()
        .ok_or_else(|| "飞书事件帧缺少 payload".to_string())?;
    let started_at = Instant::now();
    let raw_event = serde_json::from_slice::<Value>(&payload)
        .map_err(|e| format!("飞书事件 payload 解析失败: {}", e))?;

    let event_type = raw_event
        .get("header")
        .and_then(|header| header.get("event_type"))
        .and_then(Value::as_str)
        .unwrap_or_default();

    let response = if event_type == "im.message.receive_v1" {
        app.emit(
            "im-channel-callback",
            json!({
                "channelId": channel_id,
                "payload": raw_event,
            }),
        )
        .map_err(|e| format!("飞书事件转发失败: {}", e))?;

        build_ack_payload(200, started_at.elapsed().as_millis())
    } else {
        build_ack_payload(200, started_at.elapsed().as_millis())
    };

    let ack_frame = build_response_frame(
        service_id,
        &frame.headers,
        serde_json::to_vec(&response).map_err(|e| format!("飞书 ACK 序列化失败: {}", e))?,
    );

    Ok(FrameProcessResult::Ack(ack_frame))
}

fn combine_frame_payload(
    mut frame: Frame,
    split_payloads: &mut HashMap<String, PendingPayload>,
) -> Result<Option<Frame>, String> {
    cleanup_expired_payloads(split_payloads);

    let sum = header_value(&frame.headers, "sum")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(1);
    let seq = header_value(&frame.headers, "seq")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let message_id = header_value(&frame.headers, "message_id").unwrap_or_default();

    let payload = frame
        .payload
        .take()
        .ok_or_else(|| "飞书消息缺少 payload".to_string())?;

    if sum <= 1 {
        frame.payload = Some(payload);
        return Ok(Some(frame));
    }

    let entry = split_payloads
        .entry(message_id.clone())
        .or_insert_with(|| PendingPayload {
            parts: vec![None; sum],
            created_at: Instant::now(),
        });

    if entry.parts.len() != sum {
        entry.parts = vec![None; sum];
        entry.created_at = Instant::now();
    }

    if seq >= sum {
        return Err(format!("飞书分片序号越界: seq={} sum={}", seq, sum));
    }

    entry.parts[seq] = Some(payload);
    if entry.parts.iter().any(|part| part.is_none()) {
        return Ok(None);
    }

    let mut combined = Vec::new();
    for part in entry.parts.iter().flatten() {
        combined.extend_from_slice(part);
    }
    split_payloads.remove(&message_id);

    frame.payload = Some(combined);
    Ok(Some(frame))
}

fn cleanup_expired_payloads(split_payloads: &mut HashMap<String, PendingPayload>) {
    let ttl = Duration::from_secs(SPLIT_PAYLOAD_TTL_SECS);
    split_payloads.retain(|_, payload| payload.created_at.elapsed() < ttl);
}

fn build_ping_frame(service_id: i32) -> Frame {
    Frame {
        seq_id: 0,
        log_id: 0,
        service: service_id,
        method: 0,
        headers: vec![Header {
            key: "type".to_string(),
            value: "ping".to_string(),
        }],
        payload_encoding: None,
        payload_type: None,
        payload: None,
        log_id_new: None,
    }
}

fn build_response_frame(service_id: i32, request_headers: &[Header], payload: Vec<u8>) -> Frame {
    let mut headers = request_headers.to_vec();
    headers.retain(|header| header.key != "biz_rt");

    Frame {
        seq_id: 0,
        log_id: 0,
        service: service_id,
        method: 1,
        headers,
        payload_encoding: None,
        payload_type: None,
        payload: Some(payload),
        log_id_new: None,
    }
}

fn build_ack_payload(code: u16, elapsed_ms: u128) -> FeishuWsAckPayload {
    let mut headers = HashMap::new();
    headers.insert("biz_rt".to_string(), elapsed_ms.to_string());
    FeishuWsAckPayload {
        code,
        headers,
        data: Vec::new(),
    }
}

fn header_value(headers: &[Header], key: &str) -> Option<String> {
    headers
        .iter()
        .find(|header| header.key == key)
        .map(|header| header.value.clone())
}

fn extract_service_id(ws_url: &str) -> Result<i32, String> {
    let parsed =
        url::Url::parse(ws_url).map_err(|e| format!("飞书 WebSocket URL 解析失败: {}", e))?;
    parsed
        .query_pairs()
        .find_map(|(key, value)| {
            if key == "service_id" {
                value.parse::<i32>().ok()
            } else {
                None
            }
        })
        .ok_or_else(|| "飞书 WebSocket URL 缺少 service_id".to_string())
}

fn normalize_ping_interval(value: i32) -> u64 {
    if value <= 0 {
        DEFAULT_PING_INTERVAL_SECS
    } else {
        value as u64
    }
}

fn normalize_base_url(base_url: Option<&str>) -> String {
    let trimmed = base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(FEISHU_BASE_URL);

    if trimmed.contains("larksuite") {
        LARK_BASE_URL.to_string()
    } else {
        FEISHU_BASE_URL.to_string()
    }
}

fn update_runtime_state(
    state: &Arc<Mutex<HashMap<String, FeishuWsRuntime>>>,
    channel_id: &str,
    token: u64,
    new_state: &str,
    last_error: Option<String>,
) {
    if let Ok(mut guard) = state.lock() {
        if let Some(runtime) = guard.get_mut(channel_id) {
            if runtime.token != token {
                return;
            }
            runtime.state = new_state.to_string();
            runtime.last_error = last_error;
        }
    }
}

fn should_stop(
    state: &Arc<Mutex<HashMap<String, FeishuWsRuntime>>>,
    channel_id: &str,
    token: u64,
) -> bool {
    match state.lock() {
        Ok(guard) => !matches!(guard.get(channel_id), Some(runtime) if runtime.token == token),
        Err(_) => true,
    }
}

fn remove_runtime(
    state: &Arc<Mutex<HashMap<String, FeishuWsRuntime>>>,
    channel_id: &str,
    token: u64,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| e.to_string())?;
    let should_remove = guard
        .get(channel_id)
        .map(|runtime| runtime.token == token)
        .unwrap_or(false);
    if should_remove {
        guard.remove(channel_id);
    }
    Ok(())
}

async fn wait_or_stop(stop_rx: &mut oneshot::Receiver<()>, duration: Duration) -> bool {
    tokio::select! {
        _ = stop_rx => true,
        _ = tokio::time::sleep(duration) => false,
    }
}

fn snapshot_status(channel_id: &str, runtime: &FeishuWsRuntime) -> FeishuWsStatus {
    FeishuWsStatus {
        channel_id: channel_id.to_string(),
        state: runtime.state.clone(),
        last_error: runtime.last_error.clone(),
    }
}

enum FrameProcessResult {
    Ack(Frame),
    UpdatePingInterval(u64),
    Noop,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_lark_base_url() {
        assert_eq!(
            normalize_base_url(Some("https://open.larksuite.com")),
            LARK_BASE_URL
        );
    }

    #[test]
    fn defaults_to_feishu_base_url() {
        assert_eq!(normalize_base_url(None), FEISHU_BASE_URL);
    }

    #[test]
    fn extracts_service_id_from_ws_url() {
        let service_id = extract_service_id("wss://example.com/ws?service_id=42&foo=bar")
            .expect("service_id should be parsed");
        assert_eq!(service_id, 42);
    }

    #[test]
    fn builds_ack_payload_with_biz_rt() {
        let payload = build_ack_payload(200, 15);
        assert_eq!(payload.code, 200);
        assert_eq!(payload.headers.get("biz_rt"), Some(&"15".to_string()));
    }
}
