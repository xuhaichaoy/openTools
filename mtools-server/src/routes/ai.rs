use crate::{
    routes::{team_quota_common, AppState},
    services::{auth::Claims, entitlement},
    Error, Result,
};
use axum::{
    body::Body,
    extract::{Extension, State},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use futures_util::StreamExt;
use http::StatusCode;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub struct EnergyResponse {
    pub balance: i64,
}

#[derive(Debug, Deserialize)]
pub struct DeductRequest {
    pub amount: i64,
    pub reason: String,
}

pub fn routes_no_layer() -> Router<Arc<AppState>> {
    Router::new()
        .route("/energy", get(get_energy))
        .route("/energy/deduct", post(deduct_energy))
        .route("/energy/logs", get(get_energy_logs))
        .route("/models", get(get_models))
        .route("/chat/completions", post(ai_proxy_chat))
        .route("/team/chat/completions", post(ai_team_proxy_chat))
        .route("/team/v1/messages", post(ai_team_proxy_chat))
}

async fn get_energy(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<EnergyResponse>> {
    let user_id =
        Uuid::parse_str(&claims.sub).map_err(|_| Error::BadRequest("Invalid user ID".into()))?;

    let balance: i64 = sqlx::query_scalar(
        "INSERT INTO ai_energy (user_id, balance) VALUES ($1, 1000)
         ON CONFLICT (user_id) DO UPDATE SET balance = ai_energy.balance
         RETURNING balance",
    )
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(EnergyResponse { balance }))
}

async fn deduct_energy(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<DeductRequest>,
) -> Result<Json<EnergyResponse>> {
    let user_id =
        Uuid::parse_str(&claims.sub).map_err(|_| Error::BadRequest("Invalid user ID".into()))?;

    let balance: i64 = sqlx::query_scalar(
        "UPDATE ai_energy SET balance = balance - $1, updated_at = NOW()
         WHERE user_id = $2 AND balance >= $1
         RETURNING balance",
    )
    .bind(payload.amount)
    .bind(user_id)
    .fetch_one(&state.db)
    .await
    .map_err(|_| Error::BadRequest("Insufficient energy or user not found".into()))?;

    tracing::info!(
        "User {} deducted {} energy for: {}",
        user_id,
        payload.amount,
        payload.reason
    );

    Ok(Json(EnergyResponse { balance }))
}

async fn get_energy_logs(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    axum::extract::Query(params): axum::extract::Query<PaginationQuery>,
) -> Result<Json<serde_json::Value>> {
    let user_id =
        Uuid::parse_str(&claims.sub).map_err(|_| Error::BadRequest("Invalid user ID".into()))?;
    let limit = params.limit.unwrap_or(20).min(100);
    let offset = params.offset.unwrap_or(0);

    let logs = sqlx::query_as::<_, EnergyLog>(
        "SELECT * FROM ai_energy_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
    )
    .bind(user_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    Ok(Json(
        serde_json::json!({ "logs": logs, "limit": limit, "offset": offset }),
    ))
}

async fn get_models(State(state): State<Arc<AppState>>) -> Result<Json<serde_json::Value>> {
    let rows = sqlx::query_as::<_, ModelPricing>(
        "SELECT model_id, display_name, input_price_per_1k, output_price_per_1k, is_active
         FROM ai_model_pricing WHERE is_active = true ORDER BY display_name ASC",
    )
    .fetch_all(&state.db)
    .await?;

    if rows.is_empty() {
        return Ok(Json(serde_json::json!({
            "models": [
                { "id": "deepseek-chat", "name": "DeepSeek Chat", "input_price_per_1k": 1, "output_price_per_1k": 2 },
                { "id": "deepseek-reasoner", "name": "DeepSeek Reasoner", "input_price_per_1k": 4, "output_price_per_1k": 16 },
            ]
        })));
    }

    let models: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|r| {
            serde_json::json!({
                "id": r.model_id,
                "name": r.display_name,
                "input_price_per_1k": r.input_price_per_1k,
                "output_price_per_1k": r.output_price_per_1k,
            })
        })
        .collect();

    Ok(Json(serde_json::json!({ "models": models })))
}

/// 平台 AI 代理：使用平台 API Key 转发，按实际 token 计费
async fn ai_proxy_chat(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<serde_json::Value>,
) -> Result<Response> {
    let platform_ai_enabled = std::env::var("ENABLE_PLATFORM_AI")
        .unwrap_or_default()
        .trim()
        .eq("1");
    if !platform_ai_enabled {
        return Err(Error::api(
            StatusCode::FORBIDDEN,
            "PLATFORM_AI_NOT_AVAILABLE",
            "平台 AI 暂未开放",
            None,
        ));
    }

    let user_id =
        Uuid::parse_str(&claims.sub).map_err(|_| Error::BadRequest("Invalid user ID".into()))?;

    // 公共部署模式下检查余额是否足够；私有部署跳过能量检查
    let energy_enabled = state.config.deploy_mode == crate::config::DeployMode::Public;
    if energy_enabled {
        let current_balance: i64 =
            sqlx::query_scalar("SELECT balance FROM ai_energy WHERE user_id = $1")
                .bind(user_id)
                .fetch_optional(&state.db)
                .await?
                .unwrap_or(0);

        if current_balance <= 0 {
            return Err(Error::BadRequest("Insufficient energy".into()));
        }
    }

    let api_key = std::env::var("PLATFORM_AI_API_KEY")
        .unwrap_or_else(|_| std::env::var("OPENAI_API_KEY").unwrap_or_default());
    let api_base =
        std::env::var("PLATFORM_AI_BASE_URL").unwrap_or_else(|_| "https://api.deepseek.com".into());

    let is_stream = payload
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let res = state
        .http_client
        .post(format!("{}/chat/completions", api_base))
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&payload)
        .send()
        .await
        .map_err(|e| Error::Internal(anyhow::anyhow!("Proxy error: {}", e)))?;

    let status = res.status();

    if !is_stream {
        // 非流式：读完整响应，计算 token 并扣费
        let body_bytes = res
            .bytes()
            .await
            .map_err(|e| Error::Internal(anyhow::anyhow!("Read error: {}", e)))?;
        let body_json: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap_or_default();

        // 从 usage 字段提取 token 数
        if let Some(usage) = body_json.get("usage") {
            let total_tokens = usage
                .get("total_tokens")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let model = payload
                .get("model")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let energy_cost = calculate_energy_cost(total_tokens, model);

            if energy_cost > 0 {
                let _ = deduct_and_log_energy(
                    &state.db,
                    user_id,
                    energy_cost,
                    model,
                    usage
                        .get("prompt_tokens")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    usage
                        .get("completion_tokens")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                )
                .await;
            }
        }

        Ok(Response::builder()
            .status(status)
            .header("Content-Type", "application/json")
            .body(Body::from(body_bytes))
            .unwrap())
    } else {
        // 流式：转发 SSE 流，公共模式下在流结束时从最后一个 chunk 的 usage 扣费
        let db = state.db.clone();
        let model = payload
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let upstream = res.bytes_stream();
        let deducted = Arc::new(AtomicBool::new(false));
        let mapped = upstream.map(move |chunk_result| match chunk_result {
            Ok(bytes) => {
                if energy_enabled {
                    let text = String::from_utf8_lossy(&bytes);
                    for line in text.lines() {
                        if let Some(data) = line.strip_prefix("data: ") {
                            if data == "[DONE]" {
                                continue;
                            }
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                                if let Some(usage) = json.get("usage") {
                                    if !deducted.swap(true, Ordering::SeqCst) {
                                        let total_tokens = usage
                                            .get("total_tokens")
                                            .and_then(|v| v.as_i64())
                                            .unwrap_or(0);
                                        let energy_cost =
                                            calculate_energy_cost(total_tokens, &model);
                                        if energy_cost > 0 {
                                            let db = db.clone();
                                            let model = model.clone();
                                            let prompt = usage
                                                .get("prompt_tokens")
                                                .and_then(|v| v.as_i64())
                                                .unwrap_or(0);
                                            let completion = usage
                                                .get("completion_tokens")
                                                .and_then(|v| v.as_i64())
                                                .unwrap_or(0);
                                            tokio::spawn(async move {
                                                let _ = deduct_and_log_energy(
                                                    &db,
                                                    user_id,
                                                    energy_cost,
                                                    &model,
                                                    prompt,
                                                    completion,
                                                )
                                                .await;
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(bytes)
            }
            Err(e) => Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                e.to_string(),
            )),
        });

        let body = Body::from_stream(mapped);
        Ok(Response::builder()
            .status(status)
            .header("Content-Type", "text/event-stream")
            .header("Cache-Control", "no-cache")
            .header("Connection", "keep-alive")
            .body(body)
            .unwrap())
    }
}

/// 团队 AI 代理：使用团队配置的 Key 转发，记录用量到团队日志
async fn ai_team_proxy_chat(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<serde_json::Value>,
) -> Result<Response> {
    let user_id =
        Uuid::parse_str(&claims.sub).map_err(|_| Error::BadRequest("Invalid user ID".into()))?;

    let team_id_str = payload
        .get("team_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            Error::bad_request_code(
                "TEAM_ID_REQUIRED",
                "team_id is required when source=team",
                None,
            )
        })?;

    let team_id = Uuid::parse_str(team_id_str)
        .map_err(|_| Error::bad_request_code("TEAM_ID_REQUIRED", "Invalid team_id", None))?;

    entitlement::require_team_active(&state.db, team_id, user_id).await?;

    let requested_model = payload
        .get("model")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
        .map(|v| v.trim().to_string());

    let requested_team_config_id = payload
        .get("team_config_id")
        .and_then(|v| v.as_str())
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .map(|raw| {
            Uuid::parse_str(&raw).map_err(|_| {
                Error::bad_request_code(
                    "TEAM_MODEL_UNAVAILABLE",
                    "Invalid team_config_id",
                    Some(serde_json::json!({ "team_config_id": raw })),
                )
            })
        })
        .transpose()?;

    // 解析最终团队配置：team_config_id > model_name > 默认优先级
    let team_config = if let Some(config_id) = requested_team_config_id {
        sqlx::query_as::<_, TeamAiConfig>(
            "SELECT id, team_id, base_url, api_key, model_name, is_active, protocol, priority, created_at
             FROM team_ai_configs
             WHERE team_id = $1 AND id = $2 AND is_active = true
             LIMIT 1",
        )
        .bind(team_id)
        .bind(config_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| {
            Error::bad_request_code(
                "TEAM_MODEL_UNAVAILABLE",
                "Requested team model is unavailable",
                Some(serde_json::json!({
                    "team_id": team_id,
                    "team_config_id": config_id,
                })),
            )
        })?
    } else if let Some(model_name) = requested_model.as_deref() {
        sqlx::query_as::<_, TeamAiConfig>(
            "SELECT id, team_id, base_url, api_key, model_name, is_active, protocol, priority, created_at
             FROM team_ai_configs
             WHERE team_id = $1 AND is_active = true AND model_name = $2
             ORDER BY priority ASC, created_at ASC
             LIMIT 1",
        )
        .bind(team_id)
        .bind(model_name)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| {
            Error::bad_request_code(
                "TEAM_MODEL_UNAVAILABLE",
                "Requested model is unavailable in team",
                Some(serde_json::json!({
                    "team_id": team_id,
                    "model": model_name,
                })),
            )
        })?
    } else {
        sqlx::query_as::<_, TeamAiConfig>(
            "SELECT id, team_id, base_url, api_key, model_name, is_active, protocol, priority, created_at
             FROM team_ai_configs
             WHERE team_id = $1 AND is_active = true
             ORDER BY priority ASC, created_at ASC
             LIMIT 1",
        )
        .bind(team_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| {
            Error::bad_request_code(
                "NO_ACTIVE_TEAM_MODEL",
                "No active team AI config",
                Some(serde_json::json!({ "team_id": team_id })),
            )
        })?
    };

    // 团队月额度校验（0 表示不限额）
    enforce_team_monthly_quota(&state.db, team_id, user_id, &team_config.model_name).await?;

    // 构建转发 payload：移除 team_id（上游 API 不认识），替换 model 为实际配置的 model
    let mut forward_payload = payload.clone();
    if let Some(obj) = forward_payload.as_object_mut() {
        obj.remove("team_id");
        obj.remove("team_config_id");
        obj.insert(
            "model".to_string(),
            serde_json::json!(team_config.model_name),
        );
    }

    let decrypted_key = crate::crypto::maybe_decrypt(&team_config.api_key);

    let is_anthropic = team_config.protocol == "anthropic";
    let forward_url = if is_anthropic {
        format!("{}/v1/messages", team_config.base_url)
    } else {
        format!("{}/chat/completions", team_config.base_url)
    };
    let is_stream = payload
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    tracing::info!(
        "[team_proxy] forwarding to {} | protocol={} model={} config_id={}",
        forward_url,
        team_config.protocol,
        team_config.model_name,
        team_config.id
    );

    let mut req = state.http_client.post(&forward_url);
    if is_anthropic {
        req = req
            .header("x-api-key", &decrypted_key)
            .header("anthropic-version", "2023-06-01");
    } else {
        req = req.header("Authorization", format!("Bearer {}", decrypted_key));
    }
    let res = req
        .header("Content-Type", "application/json")
        .json(&forward_payload)
        .send()
        .await
        .map_err(|e| Error::Internal(anyhow::anyhow!("Team proxy error: {}", e)))?;

    let status = res.status();

    if !is_stream {
        let body_bytes = res
            .bytes()
            .await
            .map_err(|e| Error::Internal(anyhow::anyhow!("Read error: {}", e)))?;
        let body_json: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap_or_default();

        if let Some(usage) = body_json.get("usage") {
            let (prompt_tokens, completion_tokens) = extract_usage_tokens(usage);
            if prompt_tokens > 0 || completion_tokens > 0 {
                let _ = insert_team_usage_log(
                    &state.db,
                    team_id,
                    user_id,
                    team_config.id,
                    &team_config.model_name,
                    prompt_tokens,
                    completion_tokens,
                )
                .await;
            }
        }

        return Ok(Response::builder()
            .status(status)
            .header("Content-Type", "application/json")
            .body(Body::from(body_bytes))
            .unwrap());
    }

    let stream = res.bytes_stream();
    let db = state.db.clone();
    let model = team_config.model_name.clone();
    let config_id = team_config.id;
    let logged = Arc::new(AtomicBool::new(false));
    let mapped = stream.map(move |chunk| match chunk {
        Ok(bytes) => {
            let text = String::from_utf8_lossy(&bytes);
            for line in text.lines() {
                if let Some(data) = line.strip_prefix("data: ") {
                    if data == "[DONE]" {
                        continue;
                    }
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                        if let Some(usage) = json.get("usage") {
                            if !logged.swap(true, Ordering::SeqCst) {
                                let (prompt_tokens, completion_tokens) =
                                    extract_usage_tokens(usage);
                                if prompt_tokens > 0 || completion_tokens > 0 {
                                    let db = db.clone();
                                    let model = model.clone();
                                    tokio::spawn(async move {
                                        let _ = insert_team_usage_log(
                                            &db,
                                            team_id,
                                            user_id,
                                            config_id,
                                            &model,
                                            prompt_tokens,
                                            completion_tokens,
                                        )
                                        .await;
                                    });
                                }
                            }
                        }
                    }
                }
            }
            Ok(bytes)
        }
        Err(e) => Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        )),
    });

    let body = Body::from_stream(mapped);
    Ok(Response::builder()
        .status(status)
        .header("Content-Type", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .header("Connection", "keep-alive")
        .body(body)
        .unwrap())
}

// ── 辅助函数 ──

async fn enforce_team_monthly_quota(
    db: &sqlx::PgPool,
    team_id: Uuid,
    user_id: Uuid,
    model: &str,
) -> Result<()> {
    let month_key = team_quota_common::resolve_month_key(db, None).await?;
    let (month_start, month_end) = team_quota_common::month_range_utc(&month_key)?;

    let base_tokens: i64 = sqlx::query_scalar(
        "SELECT COALESCE(monthly_limit_tokens::BIGINT, 0)::BIGINT
         FROM team_ai_quota_policy
         WHERE team_id = $1",
    )
    .bind(team_id)
    .fetch_optional(db)
    .await?
    .unwrap_or(0);

    let extra_tokens: i64 = sqlx::query_scalar(
        "SELECT COALESCE(extra_tokens::BIGINT, 0)::BIGINT
         FROM team_ai_member_quota_adjustments
         WHERE team_id = $1 AND user_id = $2 AND month_key = $3",
    )
    .bind(team_id)
    .bind(user_id)
    .bind(&month_key)
    .fetch_optional(db)
    .await?
    .unwrap_or(0);

    let effective_tokens = base_tokens.saturating_add(extra_tokens);
    if effective_tokens <= 0 {
        return Ok(());
    }

    let used_tokens: i64 = sqlx::query_scalar(
        "SELECT COALESCE(
            SUM(COALESCE(prompt_tokens, 0)::BIGINT + COALESCE(completion_tokens, 0)::BIGINT),
            0
        )::BIGINT
         FROM team_ai_usage_logs
         WHERE team_id = $1
           AND user_id = $2
           AND created_at >= $3
           AND created_at < $4",
    )
    .bind(team_id)
    .bind(user_id)
    .bind(month_start)
    .bind(month_end)
    .fetch_one(db)
    .await?;

    if used_tokens >= effective_tokens {
        return Err(Error::bad_request_code(
            "TEAM_QUOTA_EXCEEDED",
            "Team monthly quota exceeded",
            Some(serde_json::json!({
                "team_id": team_id,
                "user_id": user_id,
                "month": month_key,
                "used_tokens": used_tokens,
                "effective_tokens": effective_tokens,
                "model": model,
            })),
        ));
    }

    Ok(())
}

fn extract_usage_tokens(usage: &serde_json::Value) -> (i64, i64) {
    let prompt_tokens = usage
        .get("prompt_tokens")
        .and_then(|v| v.as_i64())
        .or_else(|| usage.get("input_tokens").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    let completion_tokens = usage
        .get("completion_tokens")
        .and_then(|v| v.as_i64())
        .or_else(|| usage.get("output_tokens").and_then(|v| v.as_i64()))
        .unwrap_or(0);
    (prompt_tokens, completion_tokens)
}

async fn insert_team_usage_log(
    db: &sqlx::PgPool,
    team_id: Uuid,
    user_id: Uuid,
    config_id: Uuid,
    model: &str,
    prompt_tokens: i64,
    completion_tokens: i64,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO team_ai_usage_logs (
            team_id, user_id, config_id, model, prompt_tokens, completion_tokens, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, NOW())",
    )
    .bind(team_id)
    .bind(user_id)
    .bind(config_id)
    .bind(model)
    .bind(prompt_tokens)
    .bind(completion_tokens)
    .execute(db)
    .await?;
    Ok(())
}

fn calculate_energy_cost(total_tokens: i64, _model: &str) -> i64 {
    // Fallback: 1 energy per 1000 tokens
    // Dynamic pricing is applied at the DB query level when the feature is fully integrated
    (total_tokens + 999) / 1000
}

async fn deduct_and_log_energy(
    db: &sqlx::PgPool,
    user_id: Uuid,
    amount: i64,
    model: &str,
    prompt_tokens: i64,
    completion_tokens: i64,
) -> anyhow::Result<()> {
    let mut tx = db.begin().await?;

    sqlx::query(
        "UPDATE ai_energy SET balance = balance - $1, updated_at = NOW()
         WHERE user_id = $2 AND balance >= $1",
    )
    .bind(amount)
    .bind(user_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO ai_energy_logs (user_id, amount, balance_after, model, prompt_tokens, completion_tokens, source)
         VALUES ($1, $2, (SELECT balance FROM ai_energy WHERE user_id = $1), $3, $4, $5, 'platform')",
    )
    .bind(user_id)
    .bind(-amount)
    .bind(model)
    .bind(prompt_tokens)
    .bind(completion_tokens)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

// ── 类型 ──

#[derive(Debug, Deserialize)]
struct PaginationQuery {
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct EnergyLog {
    id: Uuid,
    user_id: Uuid,
    amount: i64,
    balance_after: i64,
    model: Option<String>,
    prompt_tokens: Option<i64>,
    completion_tokens: Option<i64>,
    source: String,
    created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, sqlx::FromRow)]
struct ModelPricing {
    model_id: String,
    display_name: String,
    input_price_per_1k: i64,
    output_price_per_1k: i64,
    #[allow(dead_code)]
    is_active: bool,
}

#[derive(Debug, sqlx::FromRow)]
struct TeamAiConfig {
    id: Uuid,
    #[allow(dead_code)]
    team_id: Uuid,
    base_url: String,
    api_key: String,
    model_name: String,
    #[allow(dead_code)]
    is_active: bool,
    protocol: String,
    #[allow(dead_code)]
    priority: i32,
    #[allow(dead_code)]
    created_at: chrono::DateTime<chrono::Utc>,
}
