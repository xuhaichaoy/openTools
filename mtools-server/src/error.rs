use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Error)]
pub enum Error {
    #[error("Internal Server Error")]
    Internal(anyhow::Error),

    #[error("Database Error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("Unauthorized: {0}")]
    Unauthorized(String),

    #[error("Bad Request: {0}")]
    BadRequest(String),

    #[error("Not Found: {0}")]
    NotFound(String),

    #[error("{code}: {message}")]
    Api {
        status: StatusCode,
        code: String,
        message: String,
        details: Option<serde_json::Value>,
    },
}

impl From<anyhow::Error> for Error {
    fn from(e: anyhow::Error) -> Self {
        Error::Internal(e)
    }
}

impl From<String> for Error {
    fn from(s: String) -> Self {
        Error::Internal(anyhow::anyhow!(s))
    }
}

impl Error {
    pub fn api(
        status: StatusCode,
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<serde_json::Value>,
    ) -> Self {
        Self::Api {
            status,
            code: code.into(),
            message: message.into(),
            details,
        }
    }

    pub fn bad_request_code(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<serde_json::Value>,
    ) -> Self {
        Self::api(StatusCode::BAD_REQUEST, code, message, details)
    }

    pub fn unauthorized_code(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<serde_json::Value>,
    ) -> Self {
        Self::api(StatusCode::UNAUTHORIZED, code, message, details)
    }

    pub fn not_found_code(
        code: impl Into<String>,
        message: impl Into<String>,
        details: Option<serde_json::Value>,
    ) -> Self {
        Self::api(StatusCode::NOT_FOUND, code, message, details)
    }
}

impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let (status, code, message, details) = match &self {
            Self::Internal(e) => {
                tracing::error!("Internal error: {:?}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "INTERNAL_SERVER_ERROR".to_string(),
                    "Internal server error".to_string(),
                    None,
                )
            }
            Self::Database(e) => {
                tracing::error!("Database error: {:?}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "INTERNAL_SERVER_ERROR".to_string(),
                    "Internal server error".to_string(),
                    None,
                )
            }
            Self::Unauthorized(msg) => (
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED".to_string(),
                msg.clone(),
                None,
            ),
            Self::BadRequest(msg) => (
                StatusCode::BAD_REQUEST,
                "BAD_REQUEST".to_string(),
                msg.clone(),
                None,
            ),
            Self::NotFound(msg) => (
                StatusCode::NOT_FOUND,
                "NOT_FOUND".to_string(),
                msg.clone(),
                None,
            ),
            Self::Api {
                status,
                code,
                message,
                details,
            } => (*status, code.clone(), message.clone(), details.clone()),
        };

        let body = Json(json!({
            "code": code,
            "message": message,
            "error": message,
            "details": details,
        }));

        (status, body).into_response()
    }
}
