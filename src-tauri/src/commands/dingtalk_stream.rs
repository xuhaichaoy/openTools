use futures_util::{SinkExt, StreamExt};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::error::Error as StdError;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State as TauriState};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::oneshot;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message, MaybeTlsStream};

const DINGTALK_STREAM_OPEN_URL: &str = "https://api.dingtalk.com/v1.0/gateway/connections/open";
const DINGTALK_BOT_MESSAGE_TOPIC: &str = "/v1.0/im/bot/messages/get";
const DINGTALK_STREAM_UA: &str = "HiClow-dingtalk-stream/1.0.0";
const INITIAL_CONNECT_TIMEOUT_SECS: u64 = 20;
const RECONNECT_DELAY_SECS: u64 = 3;
const DINGTALK_HTTP_CONNECT_TIMEOUT_SECS: u64 = 15;
const DINGTALK_HTTP_REQUEST_TIMEOUT_SECS: u64 = 30;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DingTalkStreamStatus {
    pub channel_id: String,
    pub state: String,
    pub last_error: Option<String>,
}

struct DingTalkStreamRuntime {
    token: u64,
    state: String,
    last_error: Option<String>,
    stop_tx: Option<oneshot::Sender<()>>,
}

struct DingTalkHttpClientContext {
    client: reqwest::Client,
    network_mode: String,
}

impl DingTalkStreamRuntime {
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
pub struct DingTalkStreamManager {
    inner: Arc<Mutex<HashMap<String, DingTalkStreamRuntime>>>,
    next_token: Arc<AtomicU64>,
}

impl DingTalkStreamManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(HashMap::new())),
            next_token: Arc::new(AtomicU64::new(1)),
        }
    }

    pub fn get_status(&self, channel_id: &str) -> Result<Option<DingTalkStreamStatus>, String> {
        let guard = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(guard
            .get(channel_id)
            .map(|runtime| snapshot_status(channel_id, runtime)))
    }

    pub async fn start_channel(
        &self,
        app: AppHandle,
        channel_id: String,
        client_id: String,
        client_secret: String,
    ) -> Result<DingTalkStreamStatus, String> {
        self.stop_channel(&channel_id).await?;

        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let (ready_tx, ready_rx) = oneshot::channel::<Result<(), String>>();
        let token = self.next_token.fetch_add(1, Ordering::SeqCst);

        {
            let mut guard = self.inner.lock().map_err(|e| e.to_string())?;
            guard.insert(
                channel_id.clone(),
                DingTalkStreamRuntime::new_pending(token, stop_tx),
            );
        }

        let state = self.inner.clone();
        let task_channel_id = channel_id.clone();
        tauri::async_runtime::spawn(async move {
            run_stream_loop(
                app,
                state,
                task_channel_id,
                token,
                client_id,
                client_secret,
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
                .ok_or_else(|| "钉钉 Stream 状态丢失".to_string()),
            Ok(Ok(Err(err))) => {
                let _ = self.stop_channel(&channel_id).await;
                Err(err)
            }
            Ok(Err(_)) => {
                let _ = self.stop_channel(&channel_id).await;
                Err("钉钉 Stream 初始化被中断".to_string())
            }
            Err(_) => {
                let _ = self.stop_channel(&channel_id).await;
                Err("钉钉 Stream 初始化超时".to_string())
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamOpenRequest {
    client_id: String,
    client_secret: String,
    subscriptions: Vec<StreamSubscription>,
    ua: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamSubscription {
    topic: String,
    #[serde(rename = "type")]
    subscription_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamOpenResponse {
    endpoint: String,
    ticket: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamEnvelope {
    #[allow(dead_code)]
    spec_version: Option<String>,
    #[serde(rename = "type")]
    envelope_type: String,
    headers: HashMap<String, Value>,
    data: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamAckEnvelope {
    code: u16,
    headers: StreamAckHeaders,
    message: String,
    data: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamAckHeaders {
    content_type: String,
    message_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DingTalkAccessTokenResponse {
    #[serde(alias = "access_token")]
    access_token: Option<String>,
    #[serde(alias = "expires_in")]
    _expires_in: Option<u64>,
    errcode: Option<i64>,
    errmsg: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DingTalkDownloadedFile {
    pub download_code: String,
    pub path: String,
    pub file_name: String,
    pub content_type: Option<String>,
}

#[tauri::command]
pub async fn start_dingtalk_stream_channel(
    app: AppHandle,
    manager: TauriState<'_, DingTalkStreamManager>,
    channel_id: String,
    client_id: String,
    client_secret: String,
) -> Result<DingTalkStreamStatus, String> {
    manager
        .inner()
        .clone()
        .start_channel(app, channel_id, client_id, client_secret)
        .await
}

#[tauri::command]
pub async fn stop_dingtalk_stream_channel(
    manager: TauriState<'_, DingTalkStreamManager>,
    channel_id: String,
) -> Result<(), String> {
    manager.inner().clone().stop_channel(&channel_id).await
}

#[tauri::command]
pub async fn get_dingtalk_stream_channel_status(
    manager: TauriState<'_, DingTalkStreamManager>,
    channel_id: String,
) -> Result<Option<DingTalkStreamStatus>, String> {
    manager.get_status(&channel_id)
}

#[tauri::command]
pub async fn dingtalk_send_app_single_message(
    client_id: String,
    client_secret: String,
    robot_code: String,
    user_id: String,
    msg_key: String,
    msg_param: String,
) -> Result<(), String> {
    let access_token = request_dingtalk_access_token(&client_id, &client_secret).await?;
    let client_ctx = build_dingtalk_http_client()?;
    let response = client_ctx
        .client
        .post("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend")
        .header("x-acs-dingtalk-access-token", access_token)
        .json(&json!({
            "robotCode": robot_code,
            "userIds": [user_id],
            "msgKey": msg_key,
            "msgParam": msg_param,
        }))
        .send()
        .await
        .map_err(|e| {
            format_reqwest_transport_error("钉钉 API 发送失败 (单聊)", &e, &client_ctx.network_mode)
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "钉钉 API 发送失败 (单聊): HTTP {} {}",
            status, body
        ));
    }

    let payload = response
        .json::<Value>()
        .await
        .map_err(|e| format!("钉钉 API 响应解析失败: {}", e))?;

    let code = payload
        .get("errcode")
        .and_then(Value::as_i64)
        .or_else(|| payload.get("code").and_then(Value::as_i64))
        .unwrap_or(0);

    if code != 0 {
        let msg = payload
            .get("errmsg")
            .and_then(Value::as_str)
            .or_else(|| payload.get("message").and_then(Value::as_str))
            .unwrap_or("Unknown Error");
        return Err(format!(
            "钉钉 API 发送失败 (单聊) 业务错误: Code {}, {}",
            code, msg
        ));
    }

    Ok(())
}

#[tauri::command]
pub async fn dingtalk_send_app_message(
    client_id: String,
    client_secret: String,
    robot_code: String,
    open_conversation_id: String,
    msg_key: String,
    msg_param: String,
) -> Result<(), String> {
    let access_token = request_dingtalk_access_token(&client_id, &client_secret).await?;
    let client_ctx = build_dingtalk_http_client()?;
    let response = client_ctx
        .client
        .post("https://api.dingtalk.com/v1.0/robot/groupMessages/send")
        .header("x-acs-dingtalk-access-token", access_token)
        .json(&json!({
            "openConversationId": open_conversation_id,
            "robotCode": robot_code,
            "msgKey": msg_key,
            "msgParam": msg_param,
        }))
        .send()
        .await
        .map_err(|e| {
            format_reqwest_transport_error("钉钉 API 发送失败", &e, &client_ctx.network_mode)
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("钉钉 API 发送失败: HTTP {} {}", status, body));
    }

    let payload = response
        .json::<Value>()
        .await
        .map_err(|e| format!("钉钉 API 响应解析失败: {}", e))?;

    let code = payload
        .get("errcode")
        .and_then(Value::as_i64)
        .or_else(|| payload.get("code").and_then(Value::as_i64))
        .unwrap_or(0);

    if code != 0 {
        let msg = payload
            .get("errmsg")
            .and_then(Value::as_str)
            .or_else(|| payload.get("message").and_then(Value::as_str))
            .unwrap_or("unknown error");
        return Err(format!("钉钉 API 发送失败: {} ({})", msg, code));
    }

    Ok(())
}

#[tauri::command]
pub async fn dingtalk_upload_media(
    client_id: String,
    client_secret: String,
    media_type: String, // "image", "file", "voice", "video"
    file_path: String,
) -> Result<String, String> {
    let access_token = request_dingtalk_access_token(&client_id, &client_secret).await?;
    let client_ctx = build_dingtalk_http_client()?;

    let file_content = tokio::fs::read(&file_path)
        .await
        .map_err(|e| format!("读取本地文件失败: {}", e))?;

    let file_name = std::path::Path::new(&file_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file")
        .to_string();

    let form = reqwest::multipart::Form::new().part(
        "media",
        reqwest::multipart::Part::bytes(file_content).file_name(file_name),
    );

    log::info!(
        "[DingTalk] Uploading media: path={}, type={}",
        file_path,
        media_type
    );
    let response = client_ctx
        .client
        .post("https://oapi.dingtalk.com/media/upload")
        .query(&[("access_token", access_token), ("type", media_type)])
        .multipart(form)
        .send()
        .await
        .map_err(|e| {
            let err =
                format_reqwest_transport_error("钉钉媒体上传失败", &e, &client_ctx.network_mode);
            log::error!("[DingTalk] Media upload transport error: {}", err);
            err
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("钉钉媒体上传失败: HTTP {} {}", status, body));
    }

    let payload = response
        .json::<Value>()
        .await
        .map_err(|e| format!("钉钉媒体上传响应解析失败: {}", e))?;

    let errcode = payload.get("errcode").and_then(Value::as_i64).unwrap_or(0);
    if errcode != 0 {
        let errmsg = payload
            .get("errmsg")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(format!("钉钉媒体上传失败: {} ({})", errmsg, errcode));
    }

    let media_id = payload
        .get("media_id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            log::error!(
                "[DingTalk] Media upload response missing media_id: {:?}",
                payload
            );
            "钉钉上传响应缺少 media_id".to_string()
        })?
        .to_string();

    log::info!("[DingTalk] Media upload success: media_id={}", media_id);
    Ok(media_id)
}

#[tauri::command]
pub async fn dingtalk_get_download_urls(
    client_id: String,
    client_secret: String,
    robot_code: String,
    download_codes: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    if download_codes.is_empty() {
        return Ok(HashMap::new());
    }

    let access_token = request_dingtalk_access_token(&client_id, &client_secret).await?;
    let client_ctx = build_dingtalk_http_client()?;
    query_dingtalk_download_urls(&client_ctx, &access_token, &robot_code, &download_codes).await
}

#[tauri::command]
pub async fn dingtalk_download_files(
    client_id: String,
    client_secret: String,
    robot_code: String,
    download_codes: Vec<String>,
) -> Result<Vec<DingTalkDownloadedFile>, String> {
    if download_codes.is_empty() {
        return Ok(Vec::new());
    }

    let access_token = request_dingtalk_access_token(&client_id, &client_secret).await?;
    let client_ctx = build_dingtalk_http_client()?;
    let url_map =
        query_dingtalk_download_urls(&client_ctx, &access_token, &robot_code, &download_codes)
            .await?;

    let media_dir = std::env::temp_dir().join("HiClow-dingtalk-media");
    tokio::fs::create_dir_all(&media_dir)
        .await
        .map_err(|e| format!("创建钉钉媒体缓存目录失败: {}", e))?;

    let mut downloaded = Vec::new();
    let mut errors = Vec::new();

    for download_code in download_codes {
        let Some(download_url) = url_map.get(&download_code).cloned() else {
            errors.push(format!("downloadCode={} 未返回下载地址", download_code));
            continue;
        };

        match download_dingtalk_file(&client_ctx, &media_dir, &download_code, &download_url).await {
            Ok(file) => downloaded.push(file),
            Err(error) => errors.push(error),
        }
    }

    if downloaded.is_empty() && !errors.is_empty() {
        return Err(errors.join("; "));
    }

    if !errors.is_empty() {
        log::warn!(
            "[DingTalk] some files failed to download: {}",
            errors.join(" | ")
        );
    }

    Ok(downloaded)
}

#[tauri::command]
pub async fn dingtalk_send_webhook_message(url: String, body: Value) -> Result<(), String> {
    let client_ctx = build_dingtalk_http_client()?;
    let response = client_ctx
        .client
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            format_reqwest_transport_error("钉钉 Webhook 发送失败", &e, &client_ctx.network_mode)
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("钉钉 Webhook 发送失败: HTTP {} {}", status, body));
    }

    let payload = response
        .json::<Value>()
        .await
        .map_err(|e| format!("钉钉 Webhook 响应解析失败: {}", e))?;

    let code = payload
        .get("errcode")
        .and_then(Value::as_i64)
        .or_else(|| payload.get("code").and_then(Value::as_i64))
        .unwrap_or(0);

    if code != 0 {
        let msg = payload
            .get("errmsg")
            .and_then(Value::as_str)
            .or_else(|| payload.get("msg").and_then(Value::as_str))
            .unwrap_or("unknown error");
        return Err(format!("钉钉 Webhook 发送失败: {} ({})", msg, code));
    }

    Ok(())
}

async fn run_stream_loop(
    app: AppHandle,
    state: Arc<Mutex<HashMap<String, DingTalkStreamRuntime>>>,
    channel_id: String,
    token: u64,
    client_id: String,
    client_secret: String,
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

        let open_result = open_stream_connection(&client_id, &client_secret).await;
        let open = match open_result {
            Ok(open) => open,
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

        let ws_url = build_ws_url(&open.endpoint, &open.ticket);
        log::info!("[DingTalk] Connecting to Stream WebSocket: {}", ws_url);

        let ws_result = connect_async_robust(&ws_url).await;
        let (mut ws_stream, _) = match ws_result {
            Ok(ok) => ok,
            Err(err) => {
                let err_msg = format!("钉钉 Stream WebSocket 连接失败: {}", err);
                log::error!("[DingTalk] {}", err_msg);
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
                next = ws_stream.next() => {
                    match next {
                        Some(Ok(Message::Text(text))) => {
                            if let Err(err) = process_stream_message(&app, &channel_id, &mut ws_stream, &text).await {
                                update_runtime_state(&state, &channel_id, token, "error", Some(err));
                                break;
                            }
                        }
                        Some(Ok(Message::Ping(payload))) => {
                            if ws_stream.send(Message::Pong(payload)).await.is_err() {
                                update_runtime_state(&state, &channel_id, token, "error", Some("钉钉 Stream pong 发送失败".to_string()));
                                break;
                            }
                        }
                        Some(Ok(Message::Close(_))) => {
                            update_runtime_state(&state, &channel_id, token, "reconnecting", Some("钉钉 Stream 连接已关闭，准备重连".to_string()));
                            break;
                        }
                        Some(Ok(_)) => {}
                        Some(Err(err)) => {
                            update_runtime_state(&state, &channel_id, token, "error", Some(format!("钉钉 Stream 读取失败: {}", err)));
                            break;
                        }
                        None => {
                            update_runtime_state(&state, &channel_id, token, "reconnecting", Some("钉钉 Stream 连接已断开，准备重连".to_string()));
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

async fn open_stream_connection(
    client_id: &str,
    client_secret: &str,
) -> Result<StreamOpenResponse, String> {
    let client_ctx = build_dingtalk_http_client()?;
    let request = StreamOpenRequest {
        client_id: client_id.to_string(),
        client_secret: client_secret.to_string(),
        subscriptions: vec![StreamSubscription {
            topic: DINGTALK_BOT_MESSAGE_TOPIC.to_string(),
            subscription_type: "CALLBACK".to_string(),
        }],
        ua: DINGTALK_STREAM_UA.to_string(),
    };

    log::info!(
        "[DingTalk] opening stream registration with network={}",
        client_ctx.network_mode
    );

    let response = client_ctx
        .client
        .post(DINGTALK_STREAM_OPEN_URL)
        .json(&request)
        .send()
        .await
        .map_err(|e| {
            format_reqwest_transport_error("钉钉 Stream 凭证注册失败", &e, &client_ctx.network_mode)
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "钉钉 Stream 凭证注册失败: HTTP {} {}",
            status, body
        ));
    }

    response
        .json::<StreamOpenResponse>()
        .await
        .map_err(|e| format!("钉钉 Stream 凭证解析失败: {}", e))
}

async fn request_dingtalk_access_token(
    client_id: &str,
    client_secret: &str,
) -> Result<String, String> {
    match request_dingtalk_access_token_v1(client_id, client_secret).await {
        Ok(token) => return Ok(token),
        Err(error) => {
            log::warn!(
                "[DingTalk] v1 oauth2 access token request failed, falling back to legacy endpoint: {}",
                error
            );
        }
    }

    request_dingtalk_access_token_legacy(client_id, client_secret).await
}

async fn request_dingtalk_access_token_v1(
    client_id: &str,
    client_secret: &str,
) -> Result<String, String> {
    let client_ctx = build_dingtalk_http_client()?;
    let response = client_ctx
        .client
        .post("https://api.dingtalk.com/v1.0/oauth2/accessToken")
        .json(&json!({
            "appKey": client_id,
            "appSecret": client_secret,
        }))
        .send()
        .await
        .map_err(|e| {
            format_reqwest_transport_error(
                "钉钉 v1 access token 请求失败",
                &e,
                &client_ctx.network_mode,
            )
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "钉钉 v1 access token 请求失败: HTTP {} {}",
            status, body
        ));
    }

    let payload = response
        .json::<DingTalkAccessTokenResponse>()
        .await
        .map_err(|e| format!("钉钉 v1 access token 响应解析失败: {}", e))?;

    extract_dingtalk_access_token(payload, "钉钉 v1 access token")
}

async fn request_dingtalk_access_token_legacy(
    client_id: &str,
    client_secret: &str,
) -> Result<String, String> {
    let params = [("appkey", client_id), ("appsecret", client_secret)];
    let client_ctx = build_dingtalk_http_client()?;
    let response = client_ctx
        .client
        .get("https://oapi.dingtalk.com/gettoken")
        .query(&params)
        .send()
        .await
        .map_err(|e| {
            format_reqwest_transport_error(
                "钉钉 access_token 请求失败",
                &e,
                &client_ctx.network_mode,
            )
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "钉钉 access_token 请求失败: HTTP {} {}",
            status, body
        ));
    }

    let payload = response
        .json::<DingTalkAccessTokenResponse>()
        .await
        .map_err(|e| format!("钉钉 access_token 响应解析失败: {}", e))?;

    extract_dingtalk_access_token(payload, "钉钉 access_token")
}

fn extract_dingtalk_access_token(
    payload: DingTalkAccessTokenResponse,
    label: &str,
) -> Result<String, String> {
    let errcode = payload.errcode.unwrap_or(0);
    if errcode != 0 {
        return Err(format!(
            "{} 获取失败: {} ({})",
            label,
            payload.errmsg.as_deref().unwrap_or("unknown error"),
            errcode
        ));
    }

    payload
        .access_token
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| format!("{} 响应缺少 token", label))
}

async fn query_dingtalk_download_urls(
    client_ctx: &DingTalkHttpClientContext,
    access_token: &str,
    robot_code: &str,
    download_codes: &[String],
) -> Result<HashMap<String, String>, String> {
    let mut result = HashMap::new();
    let mut errors = Vec::new();

    for download_code in download_codes {
        match query_single_dingtalk_download_url(
            client_ctx,
            access_token,
            robot_code,
            download_code,
        )
        .await
        {
            Ok(download_url) => {
                result.insert(download_code.clone(), download_url);
            }
            Err(error) => {
                errors.push(format!("downloadCode={}: {}", download_code, error));
            }
        }
    }

    if result.is_empty() && !errors.is_empty() {
        return Err(errors.join("; "));
    }

    if !errors.is_empty() {
        log::warn!(
            "[DingTalk] partial download URL lookup failure: {}",
            errors.join(" | ")
        );
    }

    log::info!("[DingTalk] Resolved {} download URLs", result.len());
    Ok(result)
}

async fn query_single_dingtalk_download_url(
    client_ctx: &DingTalkHttpClientContext,
    access_token: &str,
    robot_code: &str,
    download_code: &str,
) -> Result<String, String> {
    let body = json!({
        "downloadCode": download_code,
        "robotCode": robot_code,
    });

    let response = client_ctx
        .client
        .post("https://api.dingtalk.com/v1.0/robot/messageFiles/download")
        .header("x-acs-dingtalk-access-token", access_token)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            format_reqwest_transport_error("查询钉钉下载地址失败", &e, &client_ctx.network_mode)
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();
        return Err(format!("HTTP {} {}", status, body_text));
    }

    let payload = response
        .json::<Value>()
        .await
        .map_err(|e| format!("解析钉钉下载地址响应失败: {}", e))?;

    extract_dingtalk_download_url(&payload)
        .ok_or_else(|| format!("响应中未找到 downloadUrl: {}", payload))
}

fn extract_dingtalk_download_url(value: &Value) -> Option<String> {
    match value {
        Value::Array(items) => items.iter().find_map(extract_dingtalk_download_url),
        Value::Object(map) => {
            if let Some(download_url) = map
                .get("downloadUrl")
                .or_else(|| map.get("url"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return Some(download_url.to_string());
            }

            for nested in map.values() {
                if let Some(found) = extract_dingtalk_download_url(nested) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

async fn download_dingtalk_file(
    client_ctx: &DingTalkHttpClientContext,
    media_dir: &Path,
    download_code: &str,
    download_url: &str,
) -> Result<DingTalkDownloadedFile, String> {
    let response = client_ctx
        .client
        .get(download_url)
        .send()
        .await
        .map_err(|e| {
            format_reqwest_transport_error("下载钉钉媒体失败", &e, &client_ctx.network_mode)
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "下载钉钉媒体失败(downloadCode={}): HTTP {} {}",
            download_code, status, body
        ));
    }

    let headers = response.headers().clone();
    let content_type = headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or(value).trim().to_string())
        .filter(|value| !value.is_empty());
    let content_disposition = headers
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let bytes = response.bytes().await.map_err(|e| {
        format!(
            "读取钉钉媒体响应体失败(downloadCode={}): {}",
            download_code, e
        )
    })?;

    let file_name = infer_dingtalk_download_file_name(
        download_code,
        download_url,
        content_type.as_deref(),
        content_disposition.as_deref(),
    );
    let target_path = media_dir.join(format!(
        "{}-{}",
        uuid::Uuid::new_v4(),
        sanitize_dingtalk_file_name(&file_name)
    ));

    tokio::fs::write(&target_path, &bytes).await.map_err(|e| {
        format!(
            "写入钉钉媒体文件失败(downloadCode={}): {}",
            download_code, e
        )
    })?;

    Ok(DingTalkDownloadedFile {
        download_code: download_code.to_string(),
        path: target_path.to_string_lossy().into_owned(),
        file_name,
        content_type,
    })
}

fn infer_dingtalk_download_file_name(
    download_code: &str,
    download_url: &str,
    content_type: Option<&str>,
    content_disposition: Option<&str>,
) -> String {
    if let Some(file_name) = content_disposition
        .and_then(parse_content_disposition_file_name)
        .filter(|value| !value.trim().is_empty())
    {
        return file_name;
    }

    if let Ok(url) = url::Url::parse(download_url) {
        if let Some(segment) = url
            .path_segments()
            .and_then(|segments| segments.last())
            .filter(|segment| segment.contains('.'))
        {
            return segment.to_string();
        }
    }

    let ext = match content_type.unwrap_or("").to_ascii_lowercase().as_str() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "application/pdf" => "pdf",
        "text/plain" => "txt",
        "application/zip" => "zip",
        _ => "bin",
    };

    format!(
        "dingtalk-{}.{}",
        sanitize_dingtalk_file_name(download_code),
        ext
    )
}

fn parse_content_disposition_file_name(value: &str) -> Option<String> {
    value
        .split(';')
        .map(str::trim)
        .find_map(|segment| {
            segment
                .strip_prefix("filename=")
                .or_else(|| segment.strip_prefix("filename*="))
                .map(|raw| raw.trim_matches('"').trim().to_string())
        })
        .filter(|value| !value.is_empty())
}

fn sanitize_dingtalk_file_name(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>();

    let trimmed = sanitized.trim_matches('.').trim();
    if trimmed.is_empty() {
        "file.bin".to_string()
    } else {
        trimmed.to_string()
    }
}

async fn process_stream_message(
    app: &AppHandle,
    channel_id: &str,
    ws_stream: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    text: &str,
) -> Result<(), String> {
    let envelope: StreamEnvelope =
        serde_json::from_str(text).map_err(|e| format!("钉钉 Stream 消息解析失败: {}", e))?;

    let topic = envelope
        .headers
        .get("topic")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let message_id = envelope
        .headers
        .get("messageId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    match envelope.envelope_type.as_str() {
        "SYSTEM" if topic == "ping" => {
            let opaque = parse_json_string(&envelope.data)
                .and_then(|v| v.get("opaque").cloned())
                .unwrap_or(Value::Null);
            let ack = build_ack_message(&message_id, json!({ "opaque": opaque }));
            ws_stream
                .send(Message::Text(ack.into()))
                .await
                .map_err(|e| format!("钉钉 Stream ping ACK 发送失败: {}", e))?;
        }
        "SYSTEM" if topic == "disconnect" => {
            // 钉钉服务端会在约 10 秒后主动断开，此处不做 ACK，交给上层重连。
        }
        "CALLBACK" if topic == DINGTALK_BOT_MESSAGE_TOPIC => {
            let payload = parse_json_string(&envelope.data)
                .ok_or_else(|| "钉钉机器人消息 data 不是合法 JSON".to_string())?;
            app.emit(
                "im-channel-callback",
                json!({
                    "channelId": channel_id,
                    "payload": payload,
                }),
            )
            .map_err(|e| format!("钉钉 Stream 事件转发失败: {}", e))?;

            let ack = build_ack_message(&message_id, json!({ "response": Value::Null }));
            ws_stream
                .send(Message::Text(ack.into()))
                .await
                .map_err(|e| format!("钉钉 Stream callback ACK 发送失败: {}", e))?;
        }
        "EVENT" => {
            let ack = build_ack_message(
                &message_id,
                json!({ "status": "SUCCESS", "message": "success" }),
            );
            ws_stream
                .send(Message::Text(ack.into()))
                .await
                .map_err(|e| format!("钉钉 Stream event ACK 发送失败: {}", e))?;
        }
        _ => {}
    }

    Ok(())
}

async fn connect_async_robust(
    url_str: &str,
) -> Result<
    (
        tokio_tungstenite::WebSocketStream<MaybeTlsStream<TcpStream>>,
        tokio_tungstenite::tungstenite::handshake::client::Response,
    ),
    String,
> {
    let url = url::Url::parse(url_str).map_err(|e| format!("URL 解析失败: {}", e))?;
    let host = url.host_str().ok_or("URL 缺少 host")?;
    let port = url.port_or_known_default().ok_or("URL 端口未知")?;

    log::info!("[DingTalk] Resolving host: {} (port={})", host, port);
    let mut connect_errs = Vec::new();

    // 1. 尝试环境变量中的 HTTP 代理
    if let Some(proxy_url) =
        read_proxy_env(&["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"])
    {
        let proxy_label = redact_proxy_url(&proxy_url);
        log::info!(
            "[DingTalk] Attempting connection via proxy: {}",
            proxy_label
        );

        match connect_via_http_proxy(&proxy_url, host, port).await {
            Ok(tcp_stream) => {
                let request = match tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(url_str) {
                    Ok(req) => req,
                    Err(e) => return Err(format!("构建请求失败: {}", e)),
                };
                match tokio_tungstenite::client_async_tls(request, tcp_stream).await {
                    Ok(ok) => {
                        log::info!(
                            "[DingTalk] Connection established via proxy: {}",
                            proxy_label
                        );
                        return Ok(ok);
                    }
                    Err(err) => {
                        let msg = format!("代理握手失败({}): {}", proxy_label, err);
                        log::warn!("[DingTalk] {}", msg);
                        connect_errs.push(msg);
                    }
                }
            }
            Err(err) => {
                let msg = format!("代理连接失败({}): {}", proxy_label, err);
                log::warn!("[DingTalk] {}", msg);
                connect_errs.push(msg);
            }
        }
    }

    // 2. 优先尝试直接连接 (connect_async)
    // 如果失败且是 Network is down (os error 50)，则尝试 IPv4 强制连接
    match connect_async(url_str).await {
        Ok(ok) => return Ok(ok),
        Err(err) => {
            let err_str = err.to_string();
            if !err_str.contains("os error 50") && !err_str.contains("Network is down") {
                return Err(err_str);
            }
            log::warn!(
                "[DingTalk] Direct connection failed with {}, attempting IPv4 fallback",
                err_str
            );
        }
    }

    // IPv4 强制解析逻辑
    let addrs = tokio::net::lookup_host(format!("{}:{}", host, port))
        .await
        .map_err(|e| format!("DNS 解析失败: {}", e))?;

    let mut ipv4_addrs = Vec::new();
    for addr in addrs {
        if addr.is_ipv4() {
            ipv4_addrs.push(addr);
        }
    }

    if ipv4_addrs.is_empty() {
        return Err("未找到 IPv4 地址，无法进行 fallback 连接".to_string());
    }

    log::info!(
        "[DingTalk] Found IPv4 addresses: {:?}, trying to connect...",
        ipv4_addrs
    );

    let mut connect_err = String::new();
    for addr in ipv4_addrs {
        log::info!(
            "[DingTalk] Trying to connect to {} via IP-based TCP stream",
            addr
        );

        let tcp_stream = match tokio::net::TcpStream::connect(addr).await {
            Ok(s) => s,
            Err(e) => {
                connect_err = format!("TCP 连接失败: {}", e);
                log::warn!("[DingTalk] IPv4 fallback TCP failed for {}: {}", addr, e);
                continue;
            }
        };

        let request =
            match tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
                url_str,
            ) {
                Ok(req) => req,
                Err(e) => {
                    connect_err = format!("构建请求失败: {}", e);
                    continue;
                }
            };

        match tokio_tungstenite::client_async_tls(request, tcp_stream).await {
            Ok(ok) => {
                log::info!("[DingTalk] Robust connection established via {}", addr);
                return Ok(ok);
            }
            Err(e) => {
                connect_err = format!("TLS/WS Handshake Failed: {}", e);
                log::warn!("[DingTalk] IPv4 fallback failed for {}: {}", addr, e);
                continue;
            }
        }
    }

    if !connect_errs.is_empty() {
        return Err(format!(
            "所有尝试均失败。记录的错误: {}",
            connect_errs.join(" | ")
        ));
    }
    Err(format!("所有尝试均失败。最后错误: {}", connect_err))
}

async fn connect_via_http_proxy(
    proxy_url: &str,
    target_host: &str,
    target_port: u16,
) -> Result<TcpStream, String> {
    let url = url::Url::parse(proxy_url).map_err(|e| format!("代理 URL 无效: {}", e))?;
    let proxy_host = url.host_str().ok_or("代理 URL 缺少 host")?;
    let proxy_port = url.port_or_known_default().ok_or("代理 URL 缺少端口")?;

    match url.scheme() {
        "http" | "https" => {}
        _ => return Err(format!("不支持的代理协议: {}", url.scheme())),
    }

    let mut stream = TcpStream::connect(format!("{}:{}", proxy_host, proxy_port))
        .await
        .map_err(|e| format!("连接代理服务器失败({}:{}): {}", proxy_host, proxy_port, e))?;

    let connect_req = format!(
        "CONNECT {0}:{1} HTTP/1.1\r\nHost: {0}:{1}\r\nProxy-Connection: Keep-Alive\r\nUser-Agent: {2}\r\n\r\n",
        target_host, target_port, DINGTALK_STREAM_UA
    );

    stream
        .write_all(connect_req.as_bytes())
        .await
        .map_err(|e| format!("发送 CONNECT 请求失败: {}", e))?;

    let mut response = [0u8; 1024];
    let n = stream
        .read(&mut response)
        .await
        .map_err(|e| format!("读取代理响应失败: {}", e))?;
    let response_text = String::from_utf8_lossy(&response[..n]);

    if !response_text.contains("HTTP/1.1 200") && !response_text.contains("HTTP/1.0 200") {
        return Err(format!(
            "代理隧道建立失败: {}",
            response_text.lines().next().unwrap_or("Unknown Error")
        ));
    }

    Ok(stream)
}

fn build_ws_url(endpoint: &str, ticket: &str) -> String {
    match url::Url::parse(endpoint) {
        Ok(mut url) => {
            url.query_pairs_mut().append_pair("ticket", ticket);
            url.to_string()
        }
        Err(_) => format!(
            "{}?ticket={}",
            endpoint,
            utf8_percent_encode(ticket, NON_ALPHANUMERIC)
        ),
    }
}

fn parse_json_string(text: &str) -> Option<Value> {
    serde_json::from_str::<Value>(text).ok()
}

fn build_ack_message(message_id: &str, data: Value) -> String {
    let ack = StreamAckEnvelope {
        code: 200,
        headers: StreamAckHeaders {
            content_type: "application/json".to_string(),
            message_id: message_id.to_string(),
        },
        message: "OK".to_string(),
        data: data.to_string(),
    };
    serde_json::to_string(&ack).unwrap_or_else(|_| {
        "{\"code\":200,\"message\":\"OK\",\"headers\":{\"contentType\":\"application/json\",\"messageId\":\"\"},\"data\":\"{}\"}".to_string()
    })
}

fn build_dingtalk_http_client() -> Result<DingTalkHttpClientContext, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(DINGTALK_HTTP_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(DINGTALK_HTTP_REQUEST_TIMEOUT_SECS))
        .no_gzip()
        .no_brotli()
        .no_deflate();

    let mut proxy_notes = Vec::new();

    if let Some(proxy_url) =
        read_proxy_env(&["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"])
    {
        let proxy_label = redact_proxy_url(&proxy_url);
        let proxy = reqwest::Proxy::https(&proxy_url)
            .map_err(|e| format!("钉钉 HTTPS 代理配置无效({proxy_label}): {e}"))?;
        builder = builder.proxy(proxy);
        proxy_notes.push(format!("https={proxy_label}"));
    }

    if let Some(proxy_url) = read_proxy_env(&["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"])
    {
        let proxy_label = redact_proxy_url(&proxy_url);
        let proxy = reqwest::Proxy::http(&proxy_url)
            .map_err(|e| format!("钉钉 HTTP 代理配置无效({proxy_label}): {e}"))?;
        builder = builder.proxy(proxy);
        proxy_notes.push(format!("http={proxy_label}"));
    }

    let network_mode = if proxy_notes.is_empty() {
        "system-proxy-or-direct".to_string()
    } else {
        format!("env+system-proxy [{}]", proxy_notes.join(", "))
    };

    let client = builder
        .build()
        .map_err(|e| format!("钉钉 HTTP 客户端初始化失败: {}", e))?;

    Ok(DingTalkHttpClientContext {
        client,
        network_mode,
    })
}

fn read_proxy_env(keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        env::var(key)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn redact_proxy_url(proxy_url: &str) -> String {
    match url::Url::parse(proxy_url) {
        Ok(mut url) => {
            if !url.username().is_empty() {
                let _ = url.set_username("****");
            }
            if url.password().is_some() {
                let _ = url.set_password(Some("****"));
            }
            url.to_string()
        }
        Err(_) => "<invalid-proxy-url>".to_string(),
    }
}

fn format_reqwest_transport_error(label: &str, err: &reqwest::Error, network_mode: &str) -> String {
    let mut details = vec![format!("{label}: {err}")];

    if let Some(url) = err.url() {
        details.push(format!("url={url}"));
    }
    if err.is_timeout() {
        details.push("kind=timeout".to_string());
    }
    if err.is_connect() {
        details.push("kind=connect".to_string());
    }

    let mut source_chain = Vec::new();
    let mut source = err.source();
    while let Some(current) = source {
        source_chain.push(current.to_string());
        if source_chain.len() >= 6 {
            break;
        }
        source = current.source();
    }
    if !source_chain.is_empty() {
        details.push(format!("source={}", source_chain.join(" <- ")));
    }

    details.push(format!("network={network_mode}"));
    details.join(" | ")
}

fn update_runtime_state(
    state: &Arc<Mutex<HashMap<String, DingTalkStreamRuntime>>>,
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
    state: &Arc<Mutex<HashMap<String, DingTalkStreamRuntime>>>,
    channel_id: &str,
    token: u64,
) -> bool {
    match state.lock() {
        Ok(guard) => !matches!(guard.get(channel_id), Some(runtime) if runtime.token == token),
        Err(_) => true,
    }
}

fn remove_runtime(
    state: &Arc<Mutex<HashMap<String, DingTalkStreamRuntime>>>,
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

fn snapshot_status(channel_id: &str, runtime: &DingTalkStreamRuntime) -> DingTalkStreamStatus {
    DingTalkStreamStatus {
        channel_id: channel_id.to_string(),
        state: runtime.state.clone(),
        last_error: runtime.last_error.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_ticket_to_ws_url() {
        let url = build_ws_url("wss://wss-open-connection.dingtalk.com/connect", "abc");
        assert!(url.contains("ticket=abc"));
    }

    #[test]
    fn callback_ack_contains_null_response() {
        let ack = build_ack_message("mid", json!({ "response": Value::Null }));
        assert!(ack.contains("\"messageId\":\"mid\""));
        assert!(ack.contains("\\\"response\\\":null"));
    }
}
