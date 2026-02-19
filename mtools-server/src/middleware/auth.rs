use crate::error::{Error, Result};
use crate::routes::AppState;
use axum::{
    extract::{Request, State},
    middleware::Next,
    response::Response,
};
use std::sync::Arc;

pub async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    mut req: Request,
    next: Next,
) -> Result<Response> {
    let auth_header = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .ok_or_else(|| Error::Unauthorized("Missing Authorization header".into()))?;

    if !auth_header.starts_with("Bearer ") {
        return Err(Error::Unauthorized(
            "Invalid Authorization header format".into(),
        ));
    }

    let token = &auth_header[7..];

    // We would normally get the secret from config, but for simplicity we'll use a hack or pass it via State
    // Here we use state.auth which has the secret (if we expose it) or a dedicated method

    // For now, let's assume we implement a `validate_token` in AuthService
    let claims = state.auth.validate_token(token)?;

    // 只接受 access token（不接受 refresh token 用于 API 调用）
    if claims.token_type != "access" {
        return Err(Error::Unauthorized("Invalid token type".into()));
    }

    req.extensions_mut().insert(claims);

    Ok(next.run(req).await)
}
