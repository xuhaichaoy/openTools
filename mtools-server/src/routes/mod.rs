pub mod ai;
pub mod app_update;
pub mod auth;
pub mod kb;
pub mod ocr;
pub mod plugins;
pub mod stubs;
pub mod sync;
pub mod team_data_export;
pub mod team_entitlements;
pub mod team_quota_common;
pub mod team_quota_routes;
pub mod team_workflow_templates;
pub mod teams;
pub mod users;

use crate::config::DeployMode;
use crate::middleware::auth_middleware;
pub use auth::AppState;
use axum::{extract::State, middleware, routing::get, Json, Router};
use http::{HeaderValue, Method};
use std::sync::Arc;
use tower_governor::{governor::GovernorConfigBuilder, GovernorLayer};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};
use tower_http::services::ServeDir;

pub fn create_router(state: Arc<AppState>) -> Router {
    let allowed_origins = std::env::var("ALLOWED_ORIGINS").unwrap_or_default();
    let origin_layer = if allowed_origins.is_empty() || allowed_origins == "*" {
        CorsLayer::new().allow_origin(Any)
    } else {
        let origins: Vec<HeaderValue> = allowed_origins
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        CorsLayer::new().allow_origin(AllowOrigin::list(origins))
    };

    let cors = origin_layer
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers(Any)
        .max_age(std::time::Duration::from_secs(3600));

    let governor_conf = GovernorConfigBuilder::default()
        .per_second(1)
        .burst_size(300)
        .finish()
        .expect("valid governor config");
    let rate_limit = GovernorLayer::new(governor_conf);

    let auth_routes = Router::new()
        .nest("/users", users::routes_no_layer())
        .nest("/sync", sync::routes_no_layer())
        .nest("/ai", ai::routes_no_layer())
        .nest("/plugins", plugins::private_routes_no_layer())
        .nest(
            "/teams",
            teams::routes_no_layer()
                .merge(team_data_export::routes_no_layer())
                .merge(team_entitlements::routes_no_layer())
                .merge(team_workflow_templates::routes_no_layer())
                .merge(kb::team_kb_routes()),
        )
        .nest("/kb/personal", kb::personal_routes())
        .merge(stubs::routes_no_layer())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ));

    // v1 路由（新客户端使用）
    let v1_auth_routes = Router::new()
        .nest("/users", users::routes_no_layer())
        .nest("/sync", sync::routes_no_layer())
        .nest("/ai", ai::routes_no_layer())
        .nest("/plugins", plugins::private_routes_no_layer())
        .nest(
            "/teams",
            teams::routes_no_layer()
                .merge(team_data_export::routes_no_layer())
                .merge(team_entitlements::routes_no_layer())
                .merge(team_workflow_templates::routes_no_layer())
                .merge(kb::team_kb_routes()),
        )
        .nest("/kb/personal", kb::personal_routes())
        .merge(stubs::routes_no_layer())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ));

    let upload_dir = state.config.upload_dir.clone();

    Router::new()
        .route("/health", get(health_check))
        .route("/deploy-info", get(deploy_info))
        .route("/v1/app/update", get(app_update::check_update))
        .nest_service("/uploads", ServeDir::new(&upload_dir))
        .nest("/v1/plugins", plugins::public_routes_no_layer())
        .nest("/plugins", plugins::public_routes_no_layer())
        .nest("/v1/ocr", ocr::routes_no_layer())
        // v1 路由
        .nest("/v1/auth", auth::routes())
        .nest("/v1", v1_auth_routes)
        // 旧路由（向后兼容，后续版本移除）
        .nest("/auth", auth::routes())
        .merge(auth_routes)
        .layer(rate_limit)
        .layer(cors)
        .with_state(state)
}

async fn health_check() -> &'static str {
    "OK"
}

async fn deploy_info(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let mode = match state.config.deploy_mode {
        DeployMode::Public => "public",
        DeployMode::Private => "private",
    };
    let energy_enabled = state.config.deploy_mode == DeployMode::Public;
    Json(serde_json::json!({
        "deploy_mode": mode,
        "energy_billing_enabled": energy_enabled,
        "sms_login_enabled": state.config.deploy_mode == DeployMode::Public,
        "oauth_enabled": state.config.deploy_mode == DeployMode::Public,
        "version": env!("CARGO_PKG_VERSION"),
    }))
}
