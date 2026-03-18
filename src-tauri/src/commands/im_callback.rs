use axum::{
    body::Bytes,
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State as TauriState};

const IM_CALLBACK_HOST: &str = "127.0.0.1";
const IM_CALLBACK_PORT: u16 = 21947;
const IM_CALLBACK_BASE_PATH: &str = "/callbacks/im";

#[derive(Debug)]
struct ImCallbackServerRuntime {
    running: bool,
    starting: bool,
    host: String,
    port: u16,
    last_error: Option<String>,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Default for ImCallbackServerRuntime {
    fn default() -> Self {
        Self {
            running: false,
            starting: false,
            host: IM_CALLBACK_HOST.to_string(),
            port: IM_CALLBACK_PORT,
            last_error: None,
            shutdown_tx: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImCallbackServerStatus {
    pub running: bool,
    pub starting: bool,
    pub host: String,
    pub port: u16,
    pub base_url: String,
    pub callback_base_url: String,
    pub last_error: Option<String>,
}

#[derive(Clone)]
pub struct ImCallbackServerManager {
    inner: Arc<Mutex<ImCallbackServerRuntime>>,
}

impl ImCallbackServerManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(ImCallbackServerRuntime::default())),
        }
    }

    pub fn status(&self) -> Result<ImCallbackServerStatus, String> {
        let runtime = self.inner.lock().map_err(|e| e.to_string())?;
        Ok(snapshot_status(&runtime))
    }

    pub async fn start(&self, app: AppHandle) -> Result<ImCallbackServerStatus, String> {
        {
            let mut runtime = self.inner.lock().map_err(|e| e.to_string())?;
            if runtime.running || runtime.starting {
                return Ok(snapshot_status(&runtime));
            }
            runtime.starting = true;
            runtime.last_error = None;
        }

        let addr = {
            let runtime = self.inner.lock().map_err(|e| e.to_string())?;
            format!("{}:{}", runtime.host, runtime.port)
        };

        let listener = match tokio::net::TcpListener::bind(&addr).await {
            Ok(listener) => listener,
            Err(err) => {
                let err_msg = format!("IM 回调服务启动失败（{}）: {}", addr, err);
                let mut runtime = self.inner.lock().map_err(|e| e.to_string())?;
                runtime.running = false;
                runtime.starting = false;
                runtime.last_error = Some(err_msg.clone());
                return Err(err_msg);
            }
        };

        let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        let route_state = CallbackRouteState { app: app.clone() };
        let router = Router::new()
            .route(
                &format!("{}/:platform/:channel_id", IM_CALLBACK_BASE_PATH),
                post(handle_im_callback).get(handle_im_callback_probe),
            )
            .route(
                &format!("{}/health", IM_CALLBACK_BASE_PATH),
                get(handle_healthcheck),
            )
            .with_state(route_state);

        {
            let mut runtime = self.inner.lock().map_err(|e| e.to_string())?;
            runtime.running = true;
            runtime.starting = false;
            runtime.last_error = None;
            runtime.shutdown_tx = Some(shutdown_tx);
        }

        let state = self.inner.clone();
        tauri::async_runtime::spawn(async move {
            let serve_result = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await;

            match state.lock() {
                Ok(mut runtime) => {
                    runtime.running = false;
                    runtime.starting = false;
                    runtime.shutdown_tx = None;
                    if let Err(err) = serve_result {
                        runtime.last_error = Some(format!("IM 回调服务运行异常: {}", err));
                        log::warn!("IM callback server stopped unexpectedly: {}", err);
                    }
                }
                Err(err) => {
                    log::warn!("IM callback server state lock poisoned: {}", err);
                }
            }
        });

        self.status()
    }

    pub async fn stop(&self) -> Result<ImCallbackServerStatus, String> {
        let shutdown_tx = {
            let mut runtime = self.inner.lock().map_err(|e| e.to_string())?;
            runtime.starting = false;
            runtime.shutdown_tx.take()
        };

        if let Some(tx) = shutdown_tx {
            let _ = tx.send(());
        }

        self.status()
    }
}

#[derive(Clone)]
struct CallbackRouteState {
    app: AppHandle,
}

#[tauri::command]
pub async fn start_im_callback_server(
    app: AppHandle,
    manager: TauriState<'_, ImCallbackServerManager>,
) -> Result<ImCallbackServerStatus, String> {
    manager.inner().clone().start(app).await
}

#[tauri::command]
pub async fn stop_im_callback_server(
    manager: TauriState<'_, ImCallbackServerManager>,
) -> Result<ImCallbackServerStatus, String> {
    manager.inner().clone().stop().await
}

#[tauri::command]
pub async fn get_im_callback_server_status(
    manager: TauriState<'_, ImCallbackServerManager>,
) -> Result<ImCallbackServerStatus, String> {
    manager.status()
}

async fn handle_healthcheck() -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "service": "im-callback-server",
    }))
}

async fn handle_im_callback_probe(
    Path((platform, channel_id)): Path<(String, String)>,
) -> impl IntoResponse {
    Json(json!({
        "ok": true,
        "platform": platform,
        "channelId": channel_id,
        "message": "IM callback server is ready",
    }))
}

async fn handle_im_callback(
    State(state): State<CallbackRouteState>,
    Path((platform, channel_id)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    let platform = platform.trim().to_ascii_lowercase();
    if platform != "feishu" && platform != "dingtalk" {
        return (
            StatusCode::NOT_FOUND,
            format!("Unsupported IM platform: {}", platform),
        )
            .into_response();
    }

    let payload = parse_callback_payload(&body);
    let emit_payload = json!({
        "channelId": channel_id,
        "payload": payload.clone(),
    });

    if let Err(err) = state.app.emit("im-channel-callback", emit_payload) {
        log::warn!("Failed to emit im-channel-callback: {}", err);
    }

    build_callback_response(&platform, &payload)
}

fn parse_callback_payload(body: &[u8]) -> Value {
    if body.is_empty() {
        return json!({});
    }

    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(map)) => Value::Object(map),
        Ok(value) => json!({ "value": value }),
        Err(_) => json!({
            "rawBody": String::from_utf8_lossy(body).to_string(),
        }),
    }
}

fn build_callback_response(platform: &str, payload: &Value) -> Response {
    match platform {
        "feishu" => {
            if let Some(challenge) = payload.get("challenge") {
                Json(json!({ "challenge": challenge })).into_response()
            } else {
                Json(json!({ "code": 0 })).into_response()
            }
        }
        "dingtalk" => (StatusCode::OK, "success").into_response(),
        _ => (
            StatusCode::NOT_FOUND,
            format!("Unsupported IM platform: {}", platform),
        )
            .into_response(),
    }
}

fn snapshot_status(runtime: &ImCallbackServerRuntime) -> ImCallbackServerStatus {
    let base_url = format!("http://{}:{}", runtime.host, runtime.port);
    ImCallbackServerStatus {
        running: runtime.running,
        starting: runtime.starting,
        host: runtime.host.clone(),
        port: runtime.port,
        base_url: base_url.clone(),
        callback_base_url: format!("{}{}", base_url, IM_CALLBACK_BASE_PATH),
        last_error: runtime.last_error.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_feishu_challenge_response() {
        let response = build_callback_response("feishu", &json!({ "challenge": "abc123" }));
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn parses_non_object_payload_into_wrapped_value() {
        let payload = parse_callback_payload(br#"["hello"]"#);
        assert_eq!(payload.get("value"), Some(&json!(["hello"])));
    }
}
