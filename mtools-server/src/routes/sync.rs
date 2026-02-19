use crate::{
    models::sync::{SyncPullResponse, SyncPushRequest, SyncRow},
    routes::AppState,
    services::{auth::Claims, entitlement},
    Error, Result,
};
use axum::{
    extract::{Extension, Query, State},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct PullQuery {
    pub data_type: String,
    pub after_version: Option<i32>,
}

pub fn routes_no_layer() -> Router<Arc<AppState>> {
    Router::new()
        .route("/pull", get(pull_data))
        .route("/push", post(push_data))
        .route("/status", get(sync_status))
}

fn parse_user_id(claims: &Claims) -> Result<Uuid> {
    Uuid::parse_str(&claims.sub).map_err(|_| Error::BadRequest("Invalid user ID".into()))
}

async fn pull_data(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Query(query): Query<PullQuery>,
) -> Result<Json<SyncPullResponse>> {
    let user_id = parse_user_id(&claims)?;
    entitlement::require_personal_sync(&state.db, user_id).await?;

    let items = sqlx::query_as::<_, SyncRow>(
        "SELECT * FROM sync_data WHERE user_id = $1 AND data_type = $2 AND version > $3 ORDER BY version ASC",
    )
    .bind(user_id)
    .bind(&query.data_type)
    .bind(query.after_version.unwrap_or(0))
    .fetch_all(&state.db)
    .await?;

    let latest_version = items
        .last()
        .map(|i| i.version)
        .unwrap_or(query.after_version.unwrap_or(0));

    Ok(Json(SyncPullResponse {
        items,
        latest_version,
    }))
}

/// 返回用户各数据类型的最新版本号
async fn sync_status(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    entitlement::require_personal_sync(&state.db, user_id).await?;

    let rows = sqlx::query_as::<_, (String, Option<i32>)>(
        "SELECT data_type, MAX(version) as max_version FROM sync_data WHERE user_id = $1 GROUP BY data_type",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    let mut versions = serde_json::Map::new();
    for (data_type, max_ver) in rows {
        versions.insert(data_type, serde_json::json!(max_ver.unwrap_or(0)));
    }

    Ok(Json(serde_json::json!({ "versions": versions })))
}

async fn push_data(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<SyncPushRequest>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    entitlement::require_personal_sync(&state.db, user_id).await?;

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| Error::Internal(e.into()))?;

    let mut upserted = 0i32;
    let mut skipped = 0i32;

    for item in &payload.items {
        let result = sqlx::query(
            "INSERT INTO sync_data (user_id, data_type, data_id, content, version, deleted, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (user_id, data_type, data_id)
             DO UPDATE SET
               content = EXCLUDED.content,
               version = EXCLUDED.version,
               deleted = EXCLUDED.deleted,
               updated_at = NOW()
             WHERE sync_data.version < EXCLUDED.version",
        )
        .bind(user_id)
        .bind(&payload.data_type)
        .bind(&item.data_id)
        .bind(&item.content)
        .bind(item.version)
        .bind(item.deleted)
        .execute(&mut *tx)
        .await
        .map_err(|e| Error::Internal(e.into()))?;

        if result.rows_affected() > 0 {
            upserted += 1;
        } else {
            skipped += 1;
        }
    }

    tx.commit().await.map_err(|e| Error::Internal(e.into()))?;

    Ok(Json(serde_json::json!({
        "success": true,
        "upserted": upserted,
        "skipped": skipped,
    })))
}
