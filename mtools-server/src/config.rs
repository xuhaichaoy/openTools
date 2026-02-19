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
    pub port: u16,
    pub deploy_mode: DeployMode,
    pub upload_dir: String,
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
            port: std::env::var("PORT")
                .unwrap_or_else(|_| "3000".to_string())
                .parse()?,
            deploy_mode,
            upload_dir: std::env::var("UPLOAD_DIR").unwrap_or_else(|_| "./uploads".to_string()),
        })
    }
}
