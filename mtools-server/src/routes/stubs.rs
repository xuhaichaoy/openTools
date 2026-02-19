use crate::routes::AppState;
use axum::{routing::get, Json, Router};
use std::sync::Arc;

pub fn routes_no_layer() -> Router<Arc<AppState>> {
    Router::new()
        .route("/plans", get(get_plans))
        .route("/orders", get(get_orders).post(create_order))
        .route("/subscriptions/current", get(get_subscription))
        .route("/vouchers", get(get_vouchers))
        .route("/vouchers/redeem", axum::routing::post(redeem_voucher))
}

async fn get_plans() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "plans": [
            { "id": "free", "name": "免费版", "price": 0, "features": ["本地使用", "自有 API Key"] },
            { "id": "pro", "name": "专业版", "price": 9900, "features": ["云同步", "平台 AI 服务", "优先支持"], "coming_soon": true },
            { "id": "team", "name": "团队版", "price": 19900, "features": ["团队协作", "共享知识库", "团队 AI Key"], "coming_soon": true },
        ]
    }))
}

async fn get_orders() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "orders": [], "message": "Coming soon" }))
}

async fn create_order() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "error": "Payment not yet available", "coming_soon": true }))
}

async fn get_subscription() -> Json<serde_json::Value> {
    Json(
        serde_json::json!({ "plan": "free", "status": "active", "message": "Subscription management coming soon" }),
    )
}

async fn get_vouchers() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "vouchers": [], "message": "Coming soon" }))
}

async fn redeem_voucher() -> Json<serde_json::Value> {
    Json(
        serde_json::json!({ "error": "Voucher redemption not yet available", "coming_soon": true }),
    )
}
