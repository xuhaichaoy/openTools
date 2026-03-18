use futures_util::{SinkExt, StreamExt};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State as TauriState};
use tokio::sync::oneshot;
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};

const DINGTALK_STREAM_OPEN_URL: &str = "https://api.dingtalk.com/v1.0/gateway/connections/open";
const DINGTALK_BOT_MESSAGE_TOPIC: &str = "/v1.0/im/bot/messages/get";
const DINGTALK_STREAM_UA: &str = "51toolbox-dingtalk-stream/1.0.0";
const INITIAL_CONNECT_TIMEOUT_SECS: u64 = 20;
const RECONNECT_DELAY_SECS: u64 = 3;

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
    access_token: Option<String>,
    expires_in: Option<u64>,
    errcode: Option<i64>,
    errmsg: Option<String>,
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
pub async fn dingtalk_send_app_message(
    client_id: String,
    client_secret: String,
    robot_code: String,
    open_conversation_id: String,
    msg_key: String,
    msg_param: String,
) -> Result<(), String> {
    let access_token = request_dingtalk_access_token(&client_id, &client_secret).await?;
    let client = reqwest::Client::new();
    let response = client
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
        .map_err(|e| format!("钉钉 API 发送失败: {}", e))?;

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
pub async fn dingtalk_send_webhook_message(url: String, body: Value) -> Result<(), String> {
    let client = reqwest::Client::new();
    let response = client
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("钉钉 Webhook 发送失败: {}", e))?;

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
        let ws_result = connect_async(ws_url.as_str()).await;
        let (mut ws_stream, _) = match ws_result {
            Ok(ok) => ok,
            Err(err) => {
                let err_msg = format!("钉钉 Stream WebSocket 连接失败: {}", err);
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
    let client = reqwest::Client::new();
    let request = StreamOpenRequest {
        client_id: client_id.to_string(),
        client_secret: client_secret.to_string(),
        subscriptions: vec![StreamSubscription {
            topic: DINGTALK_BOT_MESSAGE_TOPIC.to_string(),
            subscription_type: "CALLBACK".to_string(),
        }],
        ua: DINGTALK_STREAM_UA.to_string(),
    };

    let response = client
        .post(DINGTALK_STREAM_OPEN_URL)
        .json(&request)
        .send()
        .await
        .map_err(|e| format!("钉钉 Stream 凭证注册失败: {}", e))?;

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
    let params = [("appkey", client_id), ("appsecret", client_secret)];
    let client = reqwest::Client::new();
    let response = client
        .get("https://oapi.dingtalk.com/gettoken")
        .query(&params)
        .send()
        .await
        .map_err(|e| format!("钉钉 access_token 请求失败: {}", e))?;

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

    let errcode = payload.errcode.unwrap_or(0);
    if errcode != 0 {
        return Err(format!(
            "钉钉 access_token 获取失败: {} ({})",
            payload.errmsg.as_deref().unwrap_or("unknown error"),
            errcode
        ));
    }

    let _expires_in = payload.expires_in.unwrap_or(0);

    payload
        .access_token
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| "钉钉 access_token 响应缺少 token".to_string())
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
