use mtools_server::{config::Config, routes::create_router};
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::net::SocketAddr;
use std::time::Duration;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 初始化日志
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "mtools_server=debug,tower_http=debug".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    // 加载配置
    let config = Config::from_env()?;

    // 初始化数据库连接
    let pool = PgPoolOptions::new()
        .max_connections(20)
        .min_connections(3)
        .acquire_timeout(Duration::from_secs(10))
        .connect(&config.database_url)
        .await?;
    tracing::info!("Connected to database");

    // 运行数据库迁移
    sqlx::migrate!("./migrations").run(&pool).await?;
    tracing::info!("Database migrations applied");

    // 初始化 Redis 连接
    let redis_client = redis::Client::open(config.redis_url.as_str())?;
    // 验证连接
    let mut conn = redis_client.get_multiplexed_async_connection().await?;
    redis::cmd("PING").query_async::<String>(&mut conn).await?;
    tracing::info!("Connected to Redis");

    // 初始化服务
    let auth_service = mtools_server::services::AuthService::new(
        config.jwt_secret.clone(),
        redis_client.clone(),
        config.jwt_access_token_ttl_secs,
        config.jwt_refresh_token_ttl_secs,
        config.jwt_leeway_secs,
    );

    // 创建上传目录
    let avatar_dir = std::path::Path::new(&config.upload_dir).join("avatars");
    tokio::fs::create_dir_all(&avatar_dir).await?;
    tracing::info!("Upload directory ready: {}", config.upload_dir);

    // 存量敏感字段加密迁移
    migrate_plaintext_keys(&pool).await;
    migrate_plaintext_skill_marketplace_tokens(&pool).await;

    // 创建应用状态
    let http_client = reqwest::Client::builder()
        .pool_max_idle_per_host(50)
        .connect_timeout(Duration::from_secs(config.upstream_connect_timeout_secs))
        .build()
        .expect("Failed to build HTTP client");

    let state = std::sync::Arc::new(mtools_server::routes::AppState {
        db: pool,
        redis: redis_client,
        auth: auth_service,
        config: config.clone(),
        http_client,
    });

    // 创建应用路由
    let app = create_router(state);

    // 绑定端口并启动
    let addr = SocketAddr::from(([0, 0, 0, 0], config.port));
    tracing::info!("Listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}

/// Encrypt any plaintext API keys in team_ai_configs that lack the `enc:` prefix.
async fn migrate_plaintext_keys(pool: &PgPool) {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: uuid::Uuid,
        api_key: String,
    }

    let rows: Vec<Row> = match sqlx::query_as::<_, Row>(
        "SELECT id, api_key FROM team_ai_configs WHERE api_key != '' AND api_key NOT LIKE 'enc:%'",
    )
    .fetch_all(pool)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("Migration query failed: {e}");
            return;
        }
    };

    if rows.is_empty() {
        return;
    }

    tracing::info!("Encrypting {} plaintext API key(s)…", rows.len());
    for row in rows {
        match mtools_server::crypto::encrypt(&row.api_key) {
            Ok(encrypted) => {
                let _ = sqlx::query("UPDATE team_ai_configs SET api_key = $1 WHERE id = $2")
                    .bind(&encrypted)
                    .bind(row.id)
                    .execute(pool)
                    .await;
            }
            Err(e) => {
                tracing::warn!("Failed to encrypt key for config {}: {e}", row.id);
            }
        }
    }
    tracing::info!("API key encryption migration complete");
}

/// Encrypt any plaintext marketplace tokens that lack the `enc:` prefix.
async fn migrate_plaintext_skill_marketplace_tokens(pool: &PgPool) {
    #[derive(sqlx::FromRow)]
    struct Row {
        id: uuid::Uuid,
        api_token: String,
    }

    let rows: Vec<Row> = match sqlx::query_as::<_, Row>(
        "SELECT id, api_token
         FROM team_skill_marketplace_configs
         WHERE api_token != '' AND api_token NOT LIKE 'enc:%'",
    )
    .fetch_all(pool)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("Marketplace token migration query failed: {e}");
            return;
        }
    };

    if rows.is_empty() {
        return;
    }

    tracing::info!("Encrypting {} plaintext marketplace token(s)…", rows.len());
    for row in rows {
        match mtools_server::crypto::encrypt(&row.api_token) {
            Ok(encrypted) => {
                let _ = sqlx::query(
                    "UPDATE team_skill_marketplace_configs SET api_token = $1 WHERE id = $2",
                )
                .bind(&encrypted)
                .bind(row.id)
                .execute(pool)
                .await;
            }
            Err(e) => {
                tracing::warn!(
                    "Failed to encrypt marketplace token for config {}: {e}",
                    row.id
                );
            }
        }
    }
    tracing::info!("Marketplace token encryption migration complete");
}
