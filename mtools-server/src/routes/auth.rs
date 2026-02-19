use crate::{
    config::Config,
    models::user::{AuthResponse, EmailLoginRequest, SmsLoginRequest, User},
    services::AuthService,
    Error, Result,
};
use axum::{extract::State, routing::post, Json, Router};
use sqlx::PgPool;
use std::sync::Arc;

pub struct AppState {
    pub db: PgPool,
    pub redis: redis::Client,
    pub auth: AuthService,
    pub config: Config,
    pub http_client: reqwest::Client,
}

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/sms/send", post(send_sms))
        .route("/sms/verify", post(verify_sms))
        .route("/email/register", post(email_register))
        .route("/email/login", post(email_login))
        .route("/refresh", post(refresh_token))
        .route("/logout", post(logout))
}

async fn send_sms(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>> {
    let phone = payload["phone"]
        .as_str()
        .ok_or_else(|| Error::BadRequest("Phone missing".into()))?;
    state.auth.send_sms_code(phone).await?;
    Ok(Json(serde_json::json!({ "message": "Code sent" })))
}

async fn verify_sms(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<SmsLoginRequest>,
) -> Result<Json<AuthResponse>> {
    let verified = state
        .auth
        .verify_sms_code(&payload.phone, &payload.code)
        .await?;
    if !verified {
        return Err(Error::Unauthorized("Invalid code".into()));
    }

    let user = find_or_create_user_by_phone(&state.db, &payload.phone).await?;
    let tokens = state.auth.generate_token_pair(&user.id.to_string())?;

    Ok(Json(AuthResponse {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        user,
    }))
}

async fn email_register(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<EmailRegisterRequest>,
) -> Result<Json<AuthResponse>> {
    // 检查邮箱是否已存在
    let existing = sqlx::query_as::<_, User>("SELECT * FROM users WHERE email = $1")
        .bind(&payload.email)
        .fetch_optional(&state.db)
        .await?;

    if existing.is_some() {
        return Err(Error::BadRequest("Email already registered".into()));
    }

    let password_hash = hash_password(&payload.password)?;
    let username = payload.username.unwrap_or_else(|| {
        payload
            .email
            .split('@')
            .next()
            .unwrap_or("user")
            .to_string()
    });

    let user = sqlx::query_as::<_, User>(
        "INSERT INTO users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING *",
    )
    .bind(&payload.email)
    .bind(&username)
    .bind(&password_hash)
    .fetch_one(&state.db)
    .await?;

    let tokens = state.auth.generate_token_pair(&user.id.to_string())?;

    Ok(Json(AuthResponse {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        user,
    }))
}

async fn email_login(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<EmailLoginRequest>,
) -> Result<Json<AuthResponse>> {
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE email = $1")
        .bind(&payload.email)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| Error::Unauthorized("User not found".into()))?;

    let password_hash = user
        .password_hash
        .as_ref()
        .ok_or_else(|| Error::Unauthorized("No password set".into()))?;

    verify_password(&payload.password, password_hash)?;

    let tokens = state.auth.generate_token_pair(&user.id.to_string())?;

    Ok(Json(AuthResponse {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        user,
    }))
}

async fn refresh_token(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<RefreshRequest>,
) -> Result<Json<AuthResponse>> {
    let tokens = state.auth.refresh_tokens(&payload.refresh_token)?;
    let claims = state.auth.validate_token(&tokens.access_token)?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(
            uuid::Uuid::parse_str(&claims.sub)
                .map_err(|_| Error::Unauthorized("Invalid token".into()))?,
        )
        .fetch_one(&state.db)
        .await?;

    Ok(Json(AuthResponse {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        user,
    }))
}

async fn logout() -> Result<Json<serde_json::Value>> {
    // 无状态 JWT，客户端清除即可
    // 后续可加 token 黑名单
    Ok(Json(serde_json::json!({ "message": "Logged out" })))
}

// ── 辅助函数 ──

async fn find_or_create_user_by_phone(db: &PgPool, phone: &str) -> Result<User> {
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE phone = $1")
        .bind(phone)
        .fetch_optional(db)
        .await?;

    match user {
        Some(u) => Ok(u),
        None => {
            let suffix = if phone.len() >= 4 {
                &phone[phone.len() - 4..]
            } else {
                phone
            };
            sqlx::query_as::<_, User>(
                "INSERT INTO users (phone, username) VALUES ($1, $2) RETURNING *",
            )
            .bind(phone)
            .bind(format!("用户_{}", suffix))
            .fetch_one(db)
            .await
            .map_err(Into::into)
        }
    }
}

fn hash_password(password: &str) -> Result<String> {
    use argon2::{
        password_hash::{rand_core::OsRng, PasswordHasher, SaltString},
        Argon2,
    };
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    argon2
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| Error::Internal(anyhow::anyhow!("Hash error: {}", e)))
}

fn verify_password(password: &str, hash: &str) -> Result<()> {
    use argon2::{
        password_hash::{PasswordHash, PasswordVerifier},
        Argon2,
    };
    let parsed = PasswordHash::new(hash)
        .map_err(|e| Error::Internal(anyhow::anyhow!("Hash parse error: {}", e)))?;
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .map_err(|_| Error::Unauthorized("Invalid password".into()))
}

// ── 请求类型 ──

#[derive(serde::Deserialize)]
struct EmailRegisterRequest {
    email: String,
    password: String,
    username: Option<String>,
}

#[derive(serde::Deserialize)]
struct RefreshRequest {
    refresh_token: String,
}
