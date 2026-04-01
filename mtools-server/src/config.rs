use serde::Deserialize;

#[derive(Debug, Deserialize, Clone, PartialEq)]
pub enum DeployMode {
    Public,
    Private,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Config {
    pub database_url: String,
    pub redis_url: String,
    pub jwt_secret: String,
    pub jwt_access_token_ttl_secs: u64,
    pub jwt_refresh_token_ttl_secs: u64,
    pub jwt_leeway_secs: u64,
    pub port: u16,
    pub deploy_mode: DeployMode,
    pub upload_dir: String,
    pub upstream_connect_timeout_secs: u64,
    pub upstream_request_timeout_secs: u64,
    /// OCR 模型目录，默认 ./ocr-models
    pub ocr_model_dir: String,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        dotenvy::dotenv().ok();

        let deploy_mode = match std::env::var("DEPLOY_MODE")
            .unwrap_or_else(|_| "private".to_string())
            .to_lowercase()
            .as_str()
        {
            "public" => DeployMode::Public,
            _ => DeployMode::Private,
        };

        Ok(Config {
            database_url: std::env::var("DATABASE_URL")?,
            redis_url: std::env::var("REDIS_URL")?,
            jwt_secret: std::env::var("JWT_SECRET")?,
            jwt_access_token_ttl_secs: parse_env_u64("JWT_ACCESS_TOKEN_TTL_SECS", 3600)?.max(60),
            jwt_refresh_token_ttl_secs: parse_env_u64(
                "JWT_REFRESH_TOKEN_TTL_SECS",
                30 * 24 * 60 * 60,
            )?
            .max(300),
            jwt_leeway_secs: parse_env_u64("JWT_LEEWAY_SECS", 30)?,
            port: std::env::var("PORT")
                .unwrap_or_else(|_| "3000".to_string())
                .parse()?,
            deploy_mode,
            upload_dir: std::env::var("UPLOAD_DIR").unwrap_or_else(|_| "./uploads".to_string()),
            upstream_connect_timeout_secs: parse_env_u64("UPSTREAM_CONNECT_TIMEOUT_SECS", 10)?
                .max(1),
            upstream_request_timeout_secs: parse_env_u64("UPSTREAM_REQUEST_TIMEOUT_SECS", 180)?
                .max(5),
            ocr_model_dir: std::env::var("OCR_MODEL_DIR")
                .unwrap_or_else(|_| "./ocr-models".to_string()),
        })
    }
}

fn parse_env_u64(key: &str, default: u64) -> anyhow::Result<u64> {
    match std::env::var(key) {
        Ok(value) => Ok(value.trim().parse()?),
        Err(_) => Ok(default),
    }
}
