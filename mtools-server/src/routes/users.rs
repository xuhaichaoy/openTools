use crate::{
    models::user::User,
    routes::AppState,
    services::{auth::Claims, entitlement},
    Error, Result,
};
use axum::{
    extract::{Extension, Multipart, State},
    routing::{get, post},
    Json, Router,
};
use std::sync::Arc;
use uuid::Uuid;

const MAX_AVATAR_SIZE: usize = 2 * 1024 * 1024; // 2 MB
const ALLOWED_TYPES: &[&str] = &["image/png", "image/jpeg", "image/webp", "image/gif"];

pub fn routes_no_layer() -> Router<Arc<AppState>> {
    Router::new()
        .route("/entitlements", get(get_my_entitlements))
        .route("/me", get(get_me).patch(update_me).delete(delete_me))
        .route("/me/avatar", post(upload_avatar))
}

async fn get_my_entitlements(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<serde_json::Value>> {
    let user_id =
        Uuid::parse_str(&claims.sub).map_err(|_| Error::BadRequest("Invalid user ID".into()))?;

    let personal = entitlement::resolve_personal_entitlement(&state.db, user_id).await?;

    Ok(Json(serde_json::json!({
        "personal_plan": personal.personal_plan,
        "personal_plan_expires_at": personal.personal_plan_expires_at,
        "can_personal_sync": personal.can_personal_sync,
        "can_personal_server_storage": personal.can_personal_sync,
        "personal_sync_status": personal.personal_sync_status,
        "days_to_expire": personal.days_to_expire,
        "personal_sync_stop_at": personal.personal_sync_stop_at,
    })))
}

async fn get_me(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<User>> {
    let user_id =
        Uuid::parse_str(&claims.sub).map_err(|_| Error::BadRequest("Invalid user ID".into()))?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| Error::NotFound("User not found".into()))?;

    Ok(Json(user))
}

async fn update_me(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<UpdateUserRequest>,
) -> Result<Json<User>> {
    let user_id =
        Uuid::parse_str(&claims.sub).map_err(|_| Error::BadRequest("Invalid user ID".into()))?;

    let user = sqlx::query_as::<_, User>(
        "UPDATE users SET
            username = COALESCE($1, username),
            avatar_url = COALESCE($2, avatar_url),
            updated_at = NOW()
         WHERE id = $3
         RETURNING *",
    )
    .bind(&payload.username)
    .bind(&payload.avatar_url)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(user))
}

async fn upload_avatar(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>> {
    let user_id =
        Uuid::parse_str(&claims.sub).map_err(|_| Error::BadRequest("Invalid user ID".into()))?;

    let field = multipart
        .next_field()
        .await
        .map_err(|_| Error::BadRequest("Invalid multipart data".into()))?
        .ok_or_else(|| Error::BadRequest("No file uploaded".into()))?;

    let content_type = field
        .content_type()
        .unwrap_or("application/octet-stream")
        .to_string();
    if !ALLOWED_TYPES.contains(&content_type.as_str()) {
        return Err(Error::BadRequest(format!(
            "Unsupported file type: {content_type}. Allowed: png, jpeg, webp, gif"
        )));
    }

    let ext = match content_type.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "bin",
    };

    let data = field
        .bytes()
        .await
        .map_err(|_| Error::BadRequest("Failed to read file data".into()))?;
    if data.len() > MAX_AVATAR_SIZE {
        return Err(Error::BadRequest("File too large (max 2MB)".into()));
    }

    let avatar_dir = std::path::Path::new(&state.config.upload_dir).join("avatars");
    tokio::fs::create_dir_all(&avatar_dir)
        .await
        .map_err(|e| Error::from(format!("Failed to create upload directory: {e}")))?;

    let filename = format!("{}.{}", user_id, ext);
    let filepath = avatar_dir.join(&filename);
    tokio::fs::write(&filepath, &data)
        .await
        .map_err(|e| Error::from(format!("Failed to write file: {e}")))?;

    let avatar_url = format!("/uploads/avatars/{}", filename);

    let _user = sqlx::query_as::<_, User>(
        "UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
    )
    .bind(&avatar_url)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(serde_json::json!({ "avatar_url": avatar_url })))
}

async fn delete_me(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<serde_json::Value>> {
    let user_id =
        Uuid::parse_str(&claims.sub).map_err(|_| Error::BadRequest("Invalid user ID".into()))?;

    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(&state.db)
        .await?;

    Ok(Json(serde_json::json!({ "message": "Account deleted" })))
}

#[derive(serde::Deserialize)]
struct UpdateUserRequest {
    username: Option<String>,
    avatar_url: Option<String>,
}
