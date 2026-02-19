use crate::{routes::AppState, services::auth::Claims, Error, Result};
use axum::{
    extract::{Extension, Path, State},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Debug, Deserialize)]
pub struct CreateTeamRequest {
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTeamRequest {
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct InviteMemberRequest {
    pub email: Option<String>,
    pub phone: Option<String>,
    pub role: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateMemberRoleRequest {
    pub role: String,
}

#[derive(Debug, Deserialize)]
pub struct ShareResourceRequest {
    pub resource_type: String,
    pub resource_id: String,
    pub resource_name: Option<String>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct Team {
    pub id: Uuid,
    pub name: String,
    pub owner_id: Uuid,
    pub avatar_url: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TeamMember {
    pub team_id: Uuid,
    pub user_id: Uuid,
    pub role: String,
    pub joined_at: chrono::DateTime<chrono::Utc>,
    pub username: String,
}

pub fn routes_no_layer() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", post(create_team).get(list_my_teams))
        .route(
            "/{id}",
            get(get_team_details).patch(update_team).delete(delete_team),
        )
        .route("/{id}/members", get(list_team_members).post(invite_member))
        .route(
            "/{id}/members/{uid}",
            axum::routing::patch(update_member_role).delete(remove_member),
        )
        .route("/{id}/share", post(share_resource))
        .route("/{id}/resources", get(list_shared_resources))
        .route(
            "/{id}/resources/{rid}",
            axum::routing::delete(unshare_resource),
        )
        .route("/{id}/ai-config", get(get_ai_config).put(set_ai_config))
        .route(
            "/{id}/ai-config/{cid}",
            axum::routing::patch(patch_ai_config).delete(delete_ai_config),
        )
        .route("/{id}/ai-models", get(get_team_ai_models))
        .route("/{id}/ai-usage", get(get_team_ai_usage))
        .merge(crate::routes::team_quota_routes::quota_routes())
}

// ── 辅助函数 ──

async fn check_membership(db: &sqlx::PgPool, team_id: Uuid, user_id: Uuid) -> Result<()> {
    let is_member: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2)",
    )
    .bind(team_id)
    .bind(user_id)
    .fetch_one(db)
    .await?;

    if !is_member {
        return Err(Error::Unauthorized("Not a team member".into()));
    }
    Ok(())
}

async fn check_admin(db: &sqlx::PgPool, team_id: Uuid, user_id: Uuid) -> Result<()> {
    let role: Option<String> =
        sqlx::query_scalar("SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2")
            .bind(team_id)
            .bind(user_id)
            .fetch_optional(db)
            .await?;

    match role.as_deref() {
        Some("owner") | Some("admin") => Ok(()),
        Some(_) => Err(Error::Unauthorized("Admin permission required".into())),
        None => Err(Error::Unauthorized("Not a team member".into())),
    }
}

fn parse_user_id(claims: &Claims) -> Result<Uuid> {
    Uuid::parse_str(&claims.sub).map_err(|_| Error::BadRequest("Invalid user ID".into()))
}

// ── 团队 CRUD ──

async fn create_team(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<CreateTeamRequest>,
) -> Result<Json<Team>> {
    let user_id = parse_user_id(&claims)?;
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| Error::Internal(e.into()))?;

    let team: Team = sqlx::query_as(
        "INSERT INTO teams (name, owner_id) VALUES ($1, $2) RETURNING id, name, owner_id, avatar_url, created_at",
    )
    .bind(&payload.name)
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query("INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'owner')")
        .bind(team.id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await.map_err(|e| Error::Internal(e.into()))?;
    Ok(Json(team))
}

async fn list_my_teams(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<Team>>> {
    let user_id = parse_user_id(&claims)?;
    let teams = sqlx::query_as::<_, Team>(
        "SELECT t.id, t.name, t.owner_id, t.avatar_url, t.created_at
         FROM teams t JOIN team_members tm ON t.id = tm.team_id
         WHERE tm.user_id = $1",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(teams))
}

async fn get_team_details(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
) -> Result<Json<Team>> {
    let user_id = parse_user_id(&claims)?;
    check_membership(&state.db, team_id, user_id).await?;

    let team = sqlx::query_as::<_, Team>(
        "SELECT id, name, owner_id, avatar_url, created_at FROM teams WHERE id = $1",
    )
    .bind(team_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(team))
}

async fn update_team(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Json(payload): Json<UpdateTeamRequest>,
) -> Result<Json<Team>> {
    let user_id = parse_user_id(&claims)?;
    check_admin(&state.db, team_id, user_id).await?;

    let team = sqlx::query_as::<_, Team>(
        "UPDATE teams SET
            name = COALESCE($1, name),
            avatar_url = COALESCE($2, avatar_url),
            updated_at = NOW()
         WHERE id = $3
         RETURNING id, name, owner_id, avatar_url, created_at",
    )
    .bind(&payload.name)
    .bind(&payload.avatar_url)
    .bind(team_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(team))
}

async fn delete_team(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;

    // 只有 owner 可以解散
    let owner_id: Uuid = sqlx::query_scalar("SELECT owner_id FROM teams WHERE id = $1")
        .bind(team_id)
        .fetch_one(&state.db)
        .await?;

    if owner_id != user_id {
        return Err(Error::Unauthorized("Only owner can delete team".into()));
    }

    sqlx::query("DELETE FROM teams WHERE id = $1")
        .bind(team_id)
        .execute(&state.db)
        .await?;

    Ok(Json(serde_json::json!({ "message": "Team deleted" })))
}

// ── 成员管理 ──

async fn list_team_members(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
) -> Result<Json<Vec<TeamMember>>> {
    let user_id = parse_user_id(&claims)?;
    check_membership(&state.db, team_id, user_id).await?;

    let members = sqlx::query_as::<_, TeamMember>(
        "SELECT tm.team_id, tm.user_id, tm.role, tm.joined_at, u.username
         FROM team_members tm JOIN users u ON tm.user_id = u.id
         WHERE tm.team_id = $1",
    )
    .bind(team_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(members))
}

async fn invite_member(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Json(payload): Json<InviteMemberRequest>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_admin(&state.db, team_id, user_id).await?;

    let target_user = if let Some(ref email) = payload.email {
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE email = $1")
            .bind(email)
            .fetch_optional(&state.db)
            .await?
    } else if let Some(ref phone) = payload.phone {
        sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE phone = $1")
            .bind(phone)
            .fetch_optional(&state.db)
            .await?
    } else {
        return Err(Error::BadRequest("email or phone required".into()));
    };

    let target_uid = target_user.ok_or_else(|| Error::NotFound("User not found".into()))?;
    let role = payload.role.as_deref().unwrap_or("member");

    sqlx::query(
        "INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (team_id, user_id) DO NOTHING",
    )
    .bind(team_id)
    .bind(target_uid)
    .bind(role)
    .execute(&state.db)
    .await?;

    Ok(Json(serde_json::json!({ "message": "Member invited" })))
}

async fn update_member_role(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((team_id, target_uid)): Path<(Uuid, Uuid)>,
    Json(payload): Json<UpdateMemberRoleRequest>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_admin(&state.db, team_id, user_id).await?;

    sqlx::query("UPDATE team_members SET role = $1 WHERE team_id = $2 AND user_id = $3")
        .bind(&payload.role)
        .bind(team_id)
        .bind(target_uid)
        .execute(&state.db)
        .await?;

    Ok(Json(serde_json::json!({ "message": "Role updated" })))
}

async fn remove_member(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((team_id, target_uid)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_admin(&state.db, team_id, user_id).await?;

    if target_uid == user_id {
        return Err(Error::BadRequest("Cannot remove yourself".into()));
    }

    sqlx::query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2")
        .bind(team_id)
        .bind(target_uid)
        .execute(&state.db)
        .await?;

    Ok(Json(serde_json::json!({ "message": "Member removed" })))
}

// ── 资源共享 ──

async fn share_resource(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Json(payload): Json<ShareResourceRequest>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_membership(&state.db, team_id, user_id).await?;

    sqlx::query(
        "INSERT INTO team_shared_resources (team_id, user_id, resource_type, resource_id, resource_name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (team_id, resource_type, resource_id) DO NOTHING",
    )
    .bind(team_id)
    .bind(user_id)
    .bind(&payload.resource_type)
    .bind(&payload.resource_id)
    .bind(&payload.resource_name)
    .execute(&state.db)
    .await?;

    Ok(Json(serde_json::json!({ "message": "Resource shared" })))
}

async fn list_shared_resources(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_membership(&state.db, team_id, user_id).await?;

    let resources = sqlx::query_as::<_, SharedResource>(
        "SELECT sr.id, sr.team_id, sr.user_id, sr.resource_type, sr.resource_id, sr.resource_name, sr.shared_at, u.username
         FROM team_shared_resources sr JOIN users u ON sr.user_id = u.id
         WHERE sr.team_id = $1
         ORDER BY sr.shared_at DESC",
    )
    .bind(team_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(serde_json::json!({ "resources": resources })))
}

async fn unshare_resource(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((team_id, resource_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_membership(&state.db, team_id, user_id).await?;

    sqlx::query("DELETE FROM team_shared_resources WHERE id = $1 AND team_id = $2")
        .bind(resource_id)
        .bind(team_id)
        .execute(&state.db)
        .await?;

    Ok(Json(serde_json::json!({ "message": "Resource unshared" })))
}

// ── 团队 AI 配置 ──

async fn get_ai_config(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_admin(&state.db, team_id, user_id).await?;

    let rows = sqlx::query_as::<_, TeamAiConfigRowWithKey>(
        "SELECT id, team_id, config_name, protocol, base_url, api_key, model_name, priority, is_active, created_at
         FROM team_ai_configs
         WHERE team_id = $1
         ORDER BY priority ASC, created_at ASC",
    )
    .bind(team_id)
    .fetch_all(&state.db)
    .await?;

    let configs: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|r| {
            let decrypted = crate::crypto::maybe_decrypt(&r.api_key);
            let masked = crate::crypto::mask_key(&decrypted);
            serde_json::json!({
                "id": r.id,
                "team_id": r.team_id,
                "config_name": r.config_name,
                "protocol": r.protocol,
                "base_url": r.base_url,
                "model_name": r.model_name,
                "priority": r.priority,
                "is_active": r.is_active,
                "created_at": r.created_at,
                "masked_key": masked,
            })
        })
        .collect();

    Ok(Json(serde_json::json!({ "configs": configs })))
}

async fn set_ai_config(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Json(payload): Json<SetAiConfigRequest>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_admin(&state.db, team_id, user_id).await?;

    let config_name = payload.config_name.as_deref().unwrap_or("default");
    let protocol = payload.protocol.as_deref().unwrap_or("openai");
    let _legacy_member_token_limit = payload.member_token_limit;
    let priority = payload.priority;
    if let Some(value) = priority {
        if value < 0 {
            return Err(Error::BadRequest("priority must be >= 0".into()));
        }
    }

    let encrypted_key = if payload.api_key.is_empty() {
        String::new()
    } else {
        crate::crypto::encrypt(&payload.api_key).map_err(|e| Error::Internal(e))?
    };

    if let Some(config_id) = payload.id {
        sqlx::query(
            "UPDATE team_ai_configs SET
                config_name = $1,
                protocol = $2,
                base_url = $3,
                api_key = CASE WHEN $4 = '' THEN api_key ELSE $4 END,
                model_name = $5,
                priority = COALESCE($6, priority),
                updated_at = NOW()
             WHERE id = $7 AND team_id = $8",
        )
        .bind(config_name)
        .bind(protocol)
        .bind(&payload.base_url)
        .bind(&encrypted_key)
        .bind(&payload.model_name)
        .bind(priority)
        .bind(config_id)
        .bind(team_id)
        .execute(&state.db)
        .await?;
    } else {
        let insert_priority = priority.unwrap_or(1000);
        sqlx::query(
            "INSERT INTO team_ai_configs (
                team_id, config_name, protocol, base_url, api_key, model_name, priority, is_active
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, true)",
        )
        .bind(team_id)
        .bind(config_name)
        .bind(protocol)
        .bind(&payload.base_url)
        .bind(&encrypted_key)
        .bind(&payload.model_name)
        .bind(insert_priority)
        .execute(&state.db)
        .await?;
    }

    Ok(Json(serde_json::json!({ "message": "AI config updated" })))
}

async fn get_team_ai_models(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_membership(&state.db, team_id, user_id).await?;

    let models = sqlx::query_as::<_, TeamAiModelInfo>(
        "SELECT
            id AS config_id,
            CASE
                WHEN config_name IS NULL OR config_name = '' THEN model_name
                WHEN model_name IS NULL OR model_name = '' THEN config_name
                ELSE config_name || ' / ' || model_name
            END AS display_name,
            model_name,
            protocol,
            priority
         FROM team_ai_configs
         WHERE team_id = $1 AND is_active = true
         ORDER BY priority ASC, created_at ASC",
    )
    .bind(team_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(serde_json::json!({ "models": models })))
}

async fn get_team_ai_usage(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_admin(&state.db, team_id, user_id).await?;

    let usage = sqlx::query_as::<_, TeamUsageRow>(
        "SELECT
            u.username,
            SUM(l.prompt_tokens)::BIGINT as prompt_tokens,
            SUM(l.completion_tokens)::BIGINT as completion_tokens,
            COUNT(*) as request_count
         FROM team_ai_usage_logs l JOIN users u ON l.user_id = u.id
         WHERE l.team_id = $1
         GROUP BY u.username
         ORDER BY request_count DESC",
    )
    .bind(team_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    Ok(Json(serde_json::json!({ "usage": usage })))
}

// ── 单条 AI 配置操作 ──

async fn patch_ai_config(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((team_id, config_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<PatchAiConfigRequest>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_admin(&state.db, team_id, user_id).await?;

    if let Some(priority) = payload.priority {
        if priority < 0 {
            return Err(Error::BadRequest("priority must be >= 0".into()));
        }
    }

    sqlx::query(
        "UPDATE team_ai_configs
         SET
            is_active = COALESCE($1, is_active),
            priority = COALESCE($2, priority),
            updated_at = NOW()
         WHERE id = $3 AND team_id = $4",
    )
    .bind(payload.is_active)
    .bind(payload.priority)
    .bind(config_id)
    .bind(team_id)
    .execute(&state.db)
    .await?;

    Ok(Json(serde_json::json!({ "message": "AI config updated" })))
}

async fn delete_ai_config(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((team_id, config_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_admin(&state.db, team_id, user_id).await?;

    sqlx::query("DELETE FROM team_ai_configs WHERE id = $1 AND team_id = $2")
        .bind(config_id)
        .bind(team_id)
        .execute(&state.db)
        .await?;

    Ok(Json(serde_json::json!({ "message": "AI config deleted" })))
}

// ── 类型 ──

#[derive(Debug, Serialize, sqlx::FromRow)]
struct SharedResource {
    id: Uuid,
    team_id: Uuid,
    user_id: Uuid,
    resource_type: String,
    resource_id: String,
    resource_name: Option<String>,
    shared_at: chrono::DateTime<chrono::Utc>,
    username: String,
}

#[derive(Debug, sqlx::FromRow)]
struct TeamAiConfigRowWithKey {
    id: Uuid,
    team_id: Uuid,
    config_name: String,
    protocol: String,
    base_url: String,
    api_key: String,
    model_name: String,
    priority: i32,
    is_active: bool,
    created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize)]
struct SetAiConfigRequest {
    id: Option<Uuid>,
    config_name: Option<String>,
    protocol: Option<String>,
    base_url: String,
    api_key: String,
    model_name: String,
    // Deprecated and ignored. Kept for backward compatibility with old clients.
    member_token_limit: Option<i64>,
    priority: Option<i32>,
}

#[derive(Debug, Deserialize)]
struct PatchAiConfigRequest {
    is_active: Option<bool>,
    priority: Option<i32>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct TeamAiModelInfo {
    config_id: Uuid,
    display_name: String,
    model_name: String,
    protocol: String,
    priority: i32,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
struct TeamUsageRow {
    username: String,
    prompt_tokens: Option<i64>,
    completion_tokens: Option<i64>,
    request_count: Option<i64>,
}
