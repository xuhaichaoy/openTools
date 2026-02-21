use crate::{
    routes::AppState,
    services::{auth::Claims, entitlement},
    Error, Result,
};
use axum::{
    extract::{Extension, Path, State},
    routing::get,
    Json, Router,
};
use std::sync::Arc;
use uuid::Uuid;

pub fn routes_no_layer() -> Router<Arc<AppState>> {
    Router::new().route("/{id}/entitlements", get(get_team_entitlements))
}

fn parse_user_id(claims: &Claims) -> Result<Uuid> {
    Uuid::parse_str(&claims.sub).map_err(|_| Error::BadRequest("Invalid user ID".into()))
}

async fn get_team_entitlements(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    let team_entitlement =
        entitlement::resolve_team_entitlement(&state.db, team_id, user_id).await?;
    if !team_entitlement.is_member {
        return Err(Error::unauthorized_code(
            "TEAM_ACCESS_DENIED",
            "Not a team member",
            Some(serde_json::json!({ "team_id": team_id })),
        ));
    }

    Ok(Json(serde_json::json!({
        "team_plan": team_entitlement.team_plan,
        "is_team_active": team_entitlement.is_team_active,
        "expires_at": team_entitlement.expires_at,
        "status": team_entitlement.status,
        "is_member": team_entitlement.is_member,
        "role": team_entitlement.role,
        "can_team_server_storage": team_entitlement.can_team_sync,
        "team_sync_status": team_entitlement.team_sync_status,
        "days_to_expire": team_entitlement.days_to_expire,
        "team_sync_stop_at": team_entitlement.team_sync_stop_at,
        "can_team_sync": team_entitlement.can_team_sync,
    })))
}
