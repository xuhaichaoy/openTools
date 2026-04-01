use crate::{
    routes::AppState,
    services::{auth::Claims, entitlement},
    Error, Result,
};
use axum::{
    extract::{Extension, Path, Query, State},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::{Duration, Instant},
};
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
    pub subscription_plan: String,
    pub subscription_started_at: chrono::DateTime<chrono::Utc>,
    pub subscription_expires_at: Option<chrono::DateTime<chrono::Utc>>,
    pub subscription_updated_at: chrono::DateTime<chrono::Utc>,
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
        .route(
            "/{id}/skill-marketplace-config",
            get(get_skill_marketplace_config).put(set_skill_marketplace_config),
        )
        .route(
            "/{id}/skill-marketplace-status",
            get(get_skill_marketplace_status),
        )
        .route(
            "/{id}/skill-marketplace-config/verify",
            post(verify_skill_marketplace_config),
        )
        .route(
            "/{id}/skill-marketplace-install",
            post(install_skill_marketplace_skill),
        )
        .route(
            "/{id}/skill-marketplace-search",
            post(search_skill_marketplace_skills),
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
        return Err(Error::api(
            http::StatusCode::FORBIDDEN,
            "TEAM_ACCESS_DENIED",
            "Not a team member",
            Some(serde_json::json!({ "team_id": team_id })),
        ));
    }
    Ok(())
}

async fn get_team_member_role(
    db: &sqlx::PgPool,
    team_id: Uuid,
    user_id: Uuid,
) -> Result<Option<String>> {
    sqlx::query_scalar("SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2")
        .bind(team_id)
        .bind(user_id)
        .fetch_optional(db)
        .await
        .map_err(Into::into)
}

async fn check_admin(db: &sqlx::PgPool, team_id: Uuid, user_id: Uuid) -> Result<()> {
    let role = get_team_member_role(db, team_id, user_id).await?;

    match role.as_deref() {
        Some("owner") | Some("admin") => Ok(()),
        Some(_) => Err(Error::api(
            http::StatusCode::FORBIDDEN,
            "TEAM_ADMIN_REQUIRED",
            "Admin permission required",
            Some(serde_json::json!({ "team_id": team_id })),
        )),
        None => Err(Error::api(
            http::StatusCode::FORBIDDEN,
            "TEAM_ACCESS_DENIED",
            "Not a team member",
            Some(serde_json::json!({ "team_id": team_id })),
        )),
    }
}

async fn check_membership_active(db: &sqlx::PgPool, team_id: Uuid, user_id: Uuid) -> Result<()> {
    check_membership(db, team_id, user_id).await?;
    entitlement::require_team_active(db, team_id, user_id).await?;
    Ok(())
}

async fn check_admin_active(db: &sqlx::PgPool, team_id: Uuid, user_id: Uuid) -> Result<()> {
    check_admin(db, team_id, user_id).await?;
    entitlement::require_team_active(db, team_id, user_id).await?;
    Ok(())
}

fn parse_user_id(claims: &Claims) -> Result<Uuid> {
    Uuid::parse_str(&claims.sub).map_err(|_| Error::BadRequest("Invalid user ID".into()))
}

async fn record_team_skill_audit_log(
    db: &sqlx::PgPool,
    team_id: Uuid,
    user_id: Uuid,
    event_type: &str,
    provider: Option<&str>,
    skill_slug: Option<&str>,
    skill_version: Option<&str>,
    published_skill_id: Option<Uuid>,
    detail_json: serde_json::Value,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO team_skill_audit_logs (
            team_id, user_id, event_type, provider, skill_slug, skill_version, published_skill_id, detail_json
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(team_id)
    .bind(user_id)
    .bind(event_type)
    .bind(provider)
    .bind(skill_slug)
    .bind(skill_version)
    .bind(published_skill_id)
    .bind(sqlx::types::Json(detail_json))
    .execute(db)
    .await?;
    Ok(())
}

async fn record_team_skill_audit_log_best_effort(
    db: &sqlx::PgPool,
    team_id: Uuid,
    user_id: Uuid,
    event_type: &str,
    provider: Option<&str>,
    skill_slug: Option<&str>,
    skill_version: Option<&str>,
    published_skill_id: Option<Uuid>,
    detail_json: serde_json::Value,
) {
    if let Err(error) = record_team_skill_audit_log(
        db,
        team_id,
        user_id,
        event_type,
        provider,
        skill_slug,
        skill_version,
        published_skill_id,
        detail_json,
    )
    .await
    {
        tracing::warn!("team skill audit log failed: {error}");
    }
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
        "INSERT INTO teams (
            name, owner_id, subscription_plan, subscription_started_at, subscription_expires_at, subscription_updated_at
         ) VALUES ($1, $2, 'trial', NOW(), NOW() + INTERVAL '3 days', NOW())
         RETURNING
            id, name, owner_id, avatar_url, created_at,
            subscription_plan, subscription_started_at, subscription_expires_at, subscription_updated_at",
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
        "SELECT
            t.id, t.name, t.owner_id, t.avatar_url, t.created_at,
            t.subscription_plan, t.subscription_started_at, t.subscription_expires_at, t.subscription_updated_at
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
        "SELECT
            id, name, owner_id, avatar_url, created_at,
            subscription_plan, subscription_started_at, subscription_expires_at, subscription_updated_at
         FROM teams
         WHERE id = $1",
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
    check_admin_active(&state.db, team_id, user_id).await?;

    let team = sqlx::query_as::<_, Team>(
        "UPDATE teams SET
            name = COALESCE($1, name),
            avatar_url = COALESCE($2, avatar_url),
            updated_at = NOW()
         WHERE id = $3
         RETURNING
            id, name, owner_id, avatar_url, created_at,
            subscription_plan, subscription_started_at, subscription_expires_at, subscription_updated_at",
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
    entitlement::require_team_active(&state.db, team_id, user_id).await?;

    // 只有 owner 可以解散
    let owner_id: Uuid = sqlx::query_scalar("SELECT owner_id FROM teams WHERE id = $1")
        .bind(team_id)
        .fetch_one(&state.db)
        .await?;

    if owner_id != user_id {
        return Err(Error::api(
            http::StatusCode::FORBIDDEN,
            "TEAM_OWNER_REQUIRED",
            "Only owner can delete team",
            Some(serde_json::json!({ "team_id": team_id })),
        ));
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
    check_admin_active(&state.db, team_id, user_id).await?;

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
    check_admin_active(&state.db, team_id, user_id).await?;

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
    check_admin_active(&state.db, team_id, user_id).await?;

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
    check_membership_active(&state.db, team_id, user_id).await?;

    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| Error::Internal(e.into()))?;

    let mut resource_id = payload.resource_id.clone();
    let mut resource_name = payload.resource_name.clone();

    if payload.resource_type == "workflow" {
        let legacy_name = resource_name
            .clone()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| format!("工作流模板({})", payload.resource_id));

        let workflow_json = serde_json::json!({
            "legacy": true,
            "source_resource_id": payload.resource_id,
            "note": "legacy shared workflow without body, please re-share from latest client",
        });

        let created_template_id: Uuid = sqlx::query_scalar(
            "INSERT INTO team_workflow_templates (
                team_id, name, description, icon, category, workflow_json, version,
                created_by, updated_by, created_at, updated_at
             ) VALUES (
                $1, $2, $3, '📋', 'legacy', $4, 1,
                $5, $5, NOW(), NOW()
             )
             RETURNING id",
        )
        .bind(team_id)
        .bind(&legacy_name)
        .bind(Some("历史兼容分享记录（无正文），请重新分享后导入"))
        .bind(&workflow_json)
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;

        resource_id = created_template_id.to_string();
        resource_name = Some(legacy_name);
    }

    sqlx::query(
        "INSERT INTO team_shared_resources (team_id, user_id, resource_type, resource_id, resource_name)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (team_id, resource_type, resource_id) DO NOTHING",
    )
    .bind(team_id)
    .bind(user_id)
    .bind(&payload.resource_type)
    .bind(&resource_id)
    .bind(&resource_name)
    .execute(&mut *tx)
    .await?;

    tx.commit().await.map_err(|e| Error::Internal(e.into()))?;

    Ok(Json(serde_json::json!({
        "message": "Resource shared",
        "resource_type": payload.resource_type,
        "resource_id": resource_id
    })))
}

async fn list_shared_resources(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_membership_active(&state.db, team_id, user_id).await?;

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
    check_membership_active(&state.db, team_id, user_id).await?;

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
    check_admin_active(&state.db, team_id, user_id).await?;

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
    check_admin_active(&state.db, team_id, user_id).await?;

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
    check_membership_active(&state.db, team_id, user_id).await?;

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
    check_admin_active(&state.db, team_id, user_id).await?;

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
    check_admin_active(&state.db, team_id, user_id).await?;

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
    check_admin_active(&state.db, team_id, user_id).await?;

    sqlx::query("DELETE FROM team_ai_configs WHERE id = $1 AND team_id = $2")
        .bind(config_id)
        .bind(team_id)
        .execute(&state.db)
        .await?;

    Ok(Json(serde_json::json!({ "message": "AI config deleted" })))
}

// ── 团队 Skill Marketplace 配置 ──

async fn get_skill_marketplace_config(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Query(query): Query<GetTeamSkillMarketplaceConfigQuery>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    if query.resolve.unwrap_or(false) {
        check_admin_active(&state.db, team_id, user_id).await?;
    } else {
        check_membership_active(&state.db, team_id, user_id).await?;
    }

    let provider = normalize_skill_marketplace_provider(query.provider.as_deref())?;
    let row = sqlx::query_as::<_, TeamSkillMarketplaceConfigRow>(
        "SELECT
            id, team_id, provider, site_url, registry_url, api_token, is_active, updated_at
         FROM team_skill_marketplace_configs
         WHERE team_id = $1 AND provider = $2
         LIMIT 1",
    )
    .bind(team_id)
    .bind(provider)
    .fetch_optional(&state.db)
    .await?;

    let config = row.map(|record| {
        let decrypted = crate::crypto::maybe_decrypt(&record.api_token);
        let masked = crate::crypto::mask_key(&decrypted);
        let context = resolve_server_http_context(&record.site_url, &record.registry_url);
        serde_json::json!({
            "id": record.id,
            "team_id": record.team_id,
            "provider": record.provider,
            "site_url": context.site_url,
            "registry_url": context.registry_url,
            "is_active": record.is_active,
            "masked_token": masked,
            "updated_at": record.updated_at,
            "token": if query.resolve.unwrap_or(false) { serde_json::Value::String(decrypted) } else { serde_json::Value::Null },
        })
    });

    Ok(Json(serde_json::json!({ "config": config })))
}

async fn get_skill_marketplace_status(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Query(query): Query<GetTeamSkillMarketplaceStatusQuery>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_membership_active(&state.db, team_id, user_id).await?;

    let provider = normalize_skill_marketplace_provider(query.provider.as_deref())?;
    let config = sqlx::query_as::<_, TeamSkillMarketplaceConfigRow>(
        "SELECT
            id, team_id, provider, site_url, registry_url, api_token, is_active, updated_at
         FROM team_skill_marketplace_configs
         WHERE team_id = $1 AND provider = $2
         LIMIT 1",
    )
    .bind(team_id)
    .bind(provider)
    .fetch_optional(&state.db)
    .await?;

    let resolved_context = config
        .as_ref()
        .map(|item| resolve_server_http_context(&item.site_url, &item.registry_url));
    let token_available = config
        .as_ref()
        .map(|item| {
            !crate::crypto::maybe_decrypt(&item.api_token)
                .trim()
                .is_empty()
        })
        .unwrap_or(false);
    let service_ready =
        config.as_ref().map(|item| item.is_active).unwrap_or(false) && token_available;
    Ok(Json(serde_json::json!({
        "provider": provider,
        "configured": config.is_some(),
        "active": config.as_ref().map(|item| item.is_active).unwrap_or(false),
        "site_url": resolved_context.as_ref().map(|item| item.site_url.clone()),
        "registry_url": resolved_context.as_ref().map(|item| item.registry_url.clone()),
        "updated_at": config.as_ref().map(|item| item.updated_at),
        "service_ready": service_ready,
        "can_search": service_ready,
        "can_install": service_ready,
    })))
}

async fn set_skill_marketplace_config(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Json(payload): Json<SetTeamSkillMarketplaceConfigRequest>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_admin_active(&state.db, team_id, user_id).await?;

    let provider = normalize_skill_marketplace_provider(payload.provider.as_deref())?;
    let context = resolve_server_http_context("", "");
    let site_url = context.site_url;
    let registry_url = context.registry_url;

    let encrypted_token = if payload.api_token.trim().is_empty() {
        String::new()
    } else {
        crate::crypto::encrypt(payload.api_token.trim()).map_err(Error::Internal)?
    };
    let is_active = payload.is_active.unwrap_or(true);

    if let Some(config_id) = payload.id {
        sqlx::query(
            "UPDATE team_skill_marketplace_configs SET
                provider = $1,
                site_url = $2,
                registry_url = $3,
                api_token = CASE WHEN $4 = '' THEN api_token ELSE $4 END,
                is_active = $5,
                updated_by = $6,
                updated_at = NOW()
             WHERE id = $7 AND team_id = $8",
        )
        .bind(provider)
        .bind(site_url.as_str())
        .bind(registry_url.as_str())
        .bind(&encrypted_token)
        .bind(is_active)
        .bind(user_id)
        .bind(config_id)
        .bind(team_id)
        .execute(&state.db)
        .await?;
    } else {
        sqlx::query(
            "INSERT INTO team_skill_marketplace_configs (
                team_id, provider, site_url, registry_url, api_token, is_active, created_by, updated_by
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
             ON CONFLICT (team_id, provider) DO UPDATE SET
                site_url = EXCLUDED.site_url,
                registry_url = EXCLUDED.registry_url,
                api_token = CASE
                    WHEN EXCLUDED.api_token = '' THEN team_skill_marketplace_configs.api_token
                    ELSE EXCLUDED.api_token
                END,
                is_active = EXCLUDED.is_active,
                updated_by = EXCLUDED.updated_by,
                updated_at = NOW()",
        )
        .bind(team_id)
        .bind(provider)
        .bind(site_url.as_str())
        .bind(registry_url.as_str())
        .bind(&encrypted_token)
        .bind(is_active)
        .bind(user_id)
        .execute(&state.db)
        .await?;
    }

    clear_skill_marketplace_search_cache_for_team(team_id);

    record_team_skill_audit_log_best_effort(
        &state.db,
        team_id,
        user_id,
        "skill_marketplace_config_saved",
        Some(provider),
        None,
        None,
        None,
        serde_json::json!({
            "site_url": site_url,
            "registry_url": registry_url,
            "is_active": is_active,
            "config_id": payload.id,
        }),
    )
    .await;

    Ok(Json(
        serde_json::json!({ "message": "Skill marketplace config updated" }),
    ))
}

async fn verify_skill_marketplace_config(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Json(payload): Json<VerifyTeamSkillMarketplaceConfigRequest>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_admin_active(&state.db, team_id, user_id).await?;

    let provider = normalize_skill_marketplace_provider(payload.provider.as_deref())?;
    let config = get_active_skill_marketplace_config(&state.db, team_id, provider).await?;
    let token = crate::crypto::maybe_decrypt(&config.api_token);
    if token.trim().is_empty() {
        return Err(Error::bad_request_code(
            "SKILL_MARKETPLACE_TOKEN_MISSING",
            "当前团队尚未配置可用的 ClawHub Token",
            None,
        ));
    }

    let result = run_server_clawhub_verify_http(
        config.site_url.as_str(),
        config.registry_url.as_str(),
        token.trim(),
    )
    .await?;

    record_team_skill_audit_log_best_effort(
        &state.db,
        team_id,
        user_id,
        "skill_marketplace_config_verified",
        Some(provider),
        None,
        None,
        None,
        serde_json::json!({
            "stdout": result.stdout,
        }),
    )
    .await;

    Ok(Json(serde_json::json!({
        "ok": true,
        "stdout": result.stdout,
    })))
}

async fn install_skill_marketplace_skill(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Json(payload): Json<InstallTeamSkillMarketplaceRequest>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_membership_active(&state.db, team_id, user_id).await?;

    let provider = normalize_skill_marketplace_provider(payload.provider.as_deref())?;
    let slug = payload.slug.trim();
    if slug.is_empty() {
        return Err(Error::bad_request_code(
            "INVALID_SKILL_SLUG",
            "Skill slug 不能为空",
            None,
        ));
    }

    let config = get_active_skill_marketplace_config(&state.db, team_id, provider).await?;
    let token = crate::crypto::maybe_decrypt(&config.api_token);
    if token.trim().is_empty() {
        return Err(Error::bad_request_code(
            "SKILL_MARKETPLACE_TOKEN_MISSING",
            "当前团队尚未配置可用的 ClawHub Token",
            None,
        ));
    }

    let slug = slug.to_string();
    let version = payload.version;
    let audit_slug = slug.clone();
    let audit_version = version.clone();
    let result = run_server_clawhub_install_http(
        config.site_url.as_str(),
        config.registry_url.as_str(),
        token.trim(),
        slug.as_str(),
        version.as_deref(),
    )
    .await?;

    record_team_skill_audit_log_best_effort(
        &state.db,
        team_id,
        user_id,
        "skill_marketplace_proxy_installed",
        Some(provider),
        Some(&audit_slug),
        audit_version.as_deref(),
        None,
        serde_json::json!({
            "installed_spec": result.installed_spec,
            "detected_skill_path": result.detected_skill_path,
            "installed_version": result.installed_version,
            "origin_url": result.origin_url,
        }),
    )
    .await;

    Ok(Json(serde_json::json!({
        "skill_md": result.skill_md,
        "stdout": result.stdout,
        "installed_spec": result.installed_spec,
        "detected_skill_path": result.detected_skill_path,
        "bundle_base64": result.bundle_base64,
        "installed_version": result.installed_version,
        "origin_url": result.origin_url,
        "site_url": result.site_url,
        "registry_url": result.registry_url,
    })))
}

async fn search_skill_marketplace_skills(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Json(payload): Json<SearchTeamSkillMarketplaceRequest>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_membership_active(&state.db, team_id, user_id).await?;

    let provider = normalize_skill_marketplace_provider(payload.provider.as_deref())?;
    let query = payload.query.trim();
    if query.is_empty() {
        return Err(Error::bad_request_code(
            "INVALID_SKILL_SEARCH_QUERY",
            "搜索关键词不能为空",
            None,
        ));
    }

    let config = get_active_skill_marketplace_config(&state.db, team_id, provider).await?;
    let token = crate::crypto::maybe_decrypt(&config.api_token);
    if token.trim().is_empty() {
        return Err(Error::bad_request_code(
            "SKILL_MARKETPLACE_TOKEN_MISSING",
            "当前团队尚未配置可用的 ClawHub Token",
            None,
        ));
    }
    let query = query.to_string();
    let limit = payload.limit.unwrap_or(20).clamp(1, 50);
    let cache_key = TeamSkillMarketplaceSearchCacheKey {
        team_id,
        provider: provider.to_string(),
        query: query.to_ascii_lowercase(),
        limit,
    };

    if let Some(cached) = get_cached_skill_marketplace_search(&cache_key) {
        return Ok(Json(serde_json::json!({
            "entries": cached.entries,
            "raw_output": cached.raw_output,
            "cached": true,
        })));
    }

    let result = run_server_clawhub_search_http(
        config.site_url.as_str(),
        config.registry_url.as_str(),
        token.trim(),
        query.as_str(),
        limit as usize,
    )
    .await?;

    cache_skill_marketplace_search(
        cache_key,
        CachedTeamSkillMarketplaceSearch {
            entries: result.entries.clone(),
            raw_output: result.raw_output.clone(),
            expires_at: Instant::now() + TEAM_SKILL_MARKETPLACE_SEARCH_CACHE_TTL,
        },
    );

    Ok(Json(serde_json::json!({
        "entries": result.entries,
        "raw_output": result.raw_output,
        "cached": false,
    })))
}

async fn get_active_skill_marketplace_config(
    db: &sqlx::PgPool,
    team_id: Uuid,
    provider: &str,
) -> Result<TeamSkillMarketplaceConfigRow> {
    sqlx::query_as::<_, TeamSkillMarketplaceConfigRow>(
        "SELECT
            id, team_id, provider, site_url, registry_url, api_token, is_active, updated_at
         FROM team_skill_marketplace_configs
         WHERE team_id = $1 AND provider = $2 AND is_active = true
         LIMIT 1",
    )
    .bind(team_id)
    .bind(provider)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| {
        Error::not_found_code(
            "SKILL_MARKETPLACE_CONFIG_NOT_FOUND",
            "当前团队尚未启用 ClawHub 技能中心配置",
            Some(serde_json::json!({ "team_id": team_id, "provider": provider })),
        )
    })
}

fn normalize_skill_marketplace_provider(provider: Option<&str>) -> Result<&'static str> {
    match provider
        .unwrap_or("clawhub")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "" | "clawhub" => Ok("clawhub"),
        other => Err(Error::bad_request_code(
            "UNSUPPORTED_SKILL_MARKETPLACE_PROVIDER",
            format!("Unsupported skill marketplace provider: {other}"),
            None,
        )),
    }
}

const TEAM_SKILL_MARKETPLACE_SEARCH_CACHE_TTL: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Eq, PartialEq, Hash)]
struct TeamSkillMarketplaceSearchCacheKey {
    team_id: Uuid,
    provider: String,
    query: String,
    limit: u32,
}

#[derive(Debug, Clone)]
struct CachedTeamSkillMarketplaceSearch {
    entries: Vec<ServerClawHubSearchEntry>,
    raw_output: String,
    expires_at: Instant,
}

static TEAM_SKILL_MARKETPLACE_SEARCH_CACHE: once_cell::sync::Lazy<
    Mutex<HashMap<TeamSkillMarketplaceSearchCacheKey, CachedTeamSkillMarketplaceSearch>>,
> = once_cell::sync::Lazy::new(|| Mutex::new(HashMap::new()));

fn get_cached_skill_marketplace_search(
    key: &TeamSkillMarketplaceSearchCacheKey,
) -> Option<CachedTeamSkillMarketplaceSearch> {
    let mut cache = TEAM_SKILL_MARKETPLACE_SEARCH_CACHE.lock().ok()?;
    let now = Instant::now();
    cache.retain(|_, entry| entry.expires_at > now);
    cache.get(key).cloned()
}

fn cache_skill_marketplace_search(
    key: TeamSkillMarketplaceSearchCacheKey,
    value: CachedTeamSkillMarketplaceSearch,
) {
    if let Ok(mut cache) = TEAM_SKILL_MARKETPLACE_SEARCH_CACHE.lock() {
        let now = Instant::now();
        cache.retain(|_, entry| entry.expires_at > now);
        cache.insert(key, value);
    }
}

fn clear_skill_marketplace_search_cache_for_team(team_id: Uuid) {
    if let Ok(mut cache) = TEAM_SKILL_MARKETPLACE_SEARCH_CACHE.lock() {
        cache.retain(|key, _| key.team_id != team_id);
    }
}

struct ServerCommandRunResult {
    stdout: String,
}

struct ServerClawHubInstallResult {
    skill_md: String,
    stdout: String,
    installed_spec: String,
    detected_skill_path: Option<String>,
    bundle_base64: Option<String>,
    installed_version: Option<String>,
    origin_url: Option<String>,
    site_url: Option<String>,
    registry_url: Option<String>,
}

struct ServerClawHubSearchResult {
    entries: Vec<ServerClawHubSearchEntry>,
    raw_output: String,
}

#[derive(Debug, Clone, Serialize)]
struct ServerClawHubSearchEntry {
    slug: String,
    title: Option<String>,
    description: Option<String>,
    version: Option<String>,
    origin_url: Option<String>,
    site_url: Option<String>,
    registry_url: Option<String>,
    source_kind: Option<String>,
}

#[derive(Debug, Clone)]
struct ServerHttpClawHubContext {
    site_url: String,
    registry_url: String,
}

#[derive(Debug)]
struct ServerHttpClawHubBundle {
    bytes: Vec<u8>,
    version: Option<String>,
    origin_url: Option<String>,
}

fn resolve_server_http_context(site_url: &str, registry_url: &str) -> ServerHttpClawHubContext {
    ServerHttpClawHubContext {
        site_url: normalize_marketplace_url(site_url, "https://clawhub.ai"),
        registry_url: normalize_marketplace_url(registry_url, "https://clawhub.ai"),
    }
}

fn normalize_marketplace_url(value: &str, default_url: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case(default_url) {
        default_url.to_string()
    } else {
        default_url.to_string()
    }
}

fn build_server_clawhub_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| Error::Internal(error.into()))
}

fn server_apply_auth(
    request: reqwest::RequestBuilder,
    token: Option<&str>,
) -> reqwest::RequestBuilder {
    let request = request
        .header(
            ACCEPT,
            "application/json, application/zip, application/octet-stream;q=0.9, */*;q=0.8",
        )
        .header(USER_AGENT, "mtools-server/ClawHubProxy");
    match token {
        Some(token) if !token.trim().is_empty() => {
            request.header(AUTHORIZATION, format!("Bearer {}", token.trim()))
        }
        _ => request,
    }
}

fn server_json_string(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Some(Value::Number(number)) => Some(number.to_string()),
        Some(Value::Bool(flag)) => Some(flag.to_string()),
        _ => None,
    }
}

fn server_looks_like_skill_slug(value: &str) -> bool {
    let trimmed = value.trim().trim_matches('/');
    let Some((owner, skill)) = trimmed.split_once('/') else {
        return false;
    };
    !owner.is_empty()
        && !skill.is_empty()
        && owner
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        && skill
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
}

fn resolve_marketplace_relative_url(base: &str, value: &str) -> Option<String> {
    if value.starts_with("http://") || value.starts_with("https://") {
        return Some(value.to_string());
    }
    let base = Url::parse(base).ok()?;
    base.join(value).ok().map(|url| url.to_string())
}

fn server_extract_url_from_json(value: &Value, keys: &[&str], bases: &[&str]) -> Option<String> {
    match value {
        Value::Object(map) => {
            for key in keys {
                if let Some(candidate) = server_json_string(map.get(*key)) {
                    for base in bases {
                        if let Some(url) =
                            resolve_marketplace_relative_url(base, candidate.as_str())
                        {
                            return Some(url);
                        }
                    }
                }
            }
            for child in map.values() {
                if let Some(url) = server_extract_url_from_json(child, keys, bases) {
                    return Some(url);
                }
            }
            None
        }
        Value::Array(items) => items
            .iter()
            .find_map(|item| server_extract_url_from_json(item, keys, bases)),
        _ => None,
    }
}

fn server_extract_string_from_json(value: &Value, keys: &[&str]) -> Option<String> {
    match value {
        Value::Object(map) => {
            for key in keys {
                if let Some(candidate) = server_json_string(map.get(*key)) {
                    return Some(candidate);
                }
            }
            for child in map.values() {
                if let Some(text) = server_extract_string_from_json(child, keys) {
                    return Some(text);
                }
            }
            None
        }
        Value::Array(items) => items
            .iter()
            .find_map(|item| server_extract_string_from_json(item, keys)),
        _ => None,
    }
}

fn server_extract_version_from_json(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => server_json_string(map.get("version"))
            .or_else(|| server_json_string(map.get("latest_version")))
            .or_else(|| server_json_string(map.get("installed_version")))
            .or_else(|| map.values().find_map(server_extract_version_from_json)),
        Value::Array(items) => items.iter().find_map(server_extract_version_from_json),
        _ => None,
    }
}

fn server_parse_http_search_entries(
    value: &Value,
    limit: usize,
    site_url: &str,
    registry_url: &str,
    source_kind: Option<&str>,
) -> Vec<ServerClawHubSearchEntry> {
    fn visit(
        value: &Value,
        entries: &mut Vec<ServerClawHubSearchEntry>,
        seen: &mut HashSet<String>,
        limit: usize,
        site_url: &str,
        registry_url: &str,
        source_kind: Option<&str>,
    ) {
        if entries.len() >= limit {
            return;
        }
        match value {
            Value::Object(map) => {
                let slug = server_json_string(map.get("slug"))
                    .or_else(|| server_json_string(map.get("skill_slug")))
                    .or_else(|| server_json_string(map.get("id")))
                    .filter(|candidate| server_looks_like_skill_slug(candidate));

                if let Some(slug) = slug {
                    if seen.insert(slug.clone()) {
                        entries.push(ServerClawHubSearchEntry {
                            slug,
                            title: server_json_string(map.get("title"))
                                .or_else(|| server_json_string(map.get("name")))
                                .or_else(|| server_json_string(map.get("display_name"))),
                            description: server_json_string(map.get("description"))
                                .or_else(|| server_json_string(map.get("summary"))),
                            version: server_json_string(map.get("version"))
                                .or_else(|| server_json_string(map.get("latest_version"))),
                            origin_url: server_extract_url_from_json(
                                value,
                                &["origin_url", "originUrl", "url", "site_url", "siteUrl"],
                                &[site_url, registry_url],
                            ),
                            site_url: Some(site_url.to_string()),
                            registry_url: Some(registry_url.to_string()),
                            source_kind: source_kind.map(str::to_string),
                        });
                    }
                }
                for child in map.values() {
                    visit(
                        child,
                        entries,
                        seen,
                        limit,
                        site_url,
                        registry_url,
                        source_kind,
                    );
                }
            }
            Value::Array(items) => {
                for child in items {
                    visit(
                        child,
                        entries,
                        seen,
                        limit,
                        site_url,
                        registry_url,
                        source_kind,
                    );
                }
            }
            _ => {}
        }
    }

    let mut entries = Vec::new();
    let mut seen = HashSet::new();
    visit(
        value,
        &mut entries,
        &mut seen,
        limit,
        site_url,
        registry_url,
        source_kind,
    );
    entries
}

async fn server_fetch_json(
    client: &reqwest::Client,
    url: Url,
    token: Option<&str>,
) -> Result<Value> {
    let response = server_apply_auth(client.get(url.clone()), token)
        .send()
        .await
        .map_err(|error| Error::Internal(error.into()))?;
    if !response.status().is_success() {
        return Err(Error::bad_request_code(
            "CLAWHUB_HTTP_REQUEST_FAILED",
            format!("ClawHub 接口返回 {} ({url})", response.status()),
            None,
        ));
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| Error::Internal(error.into()))
}

async fn run_server_clawhub_verify_http(
    site_url: &str,
    registry_url: &str,
    token: &str,
) -> Result<ServerCommandRunResult> {
    let context = resolve_server_http_context(site_url, registry_url);
    let client = build_server_clawhub_client()?;
    let candidates = [
        format!("{}/api/v1/auth/whoami", context.registry_url),
        format!("{}/api/v1/auth/whoami", context.site_url),
        format!("{}/api/v1/me", context.registry_url),
        format!("{}/api/v1/profile", context.site_url),
    ];
    let mut last_error = None;
    for url in candidates {
        let response = server_apply_auth(client.get(&url), Some(token))
            .send()
            .await
            .map_err(|error| Error::Internal(error.into()))?;
        if !response.status().is_success() {
            last_error = Some(format!(
                "ClawHub 验证接口返回 {} ({url})",
                response.status()
            ));
            continue;
        }
        let body = response
            .text()
            .await
            .map_err(|error| Error::Internal(error.into()))?;
        return Ok(ServerCommandRunResult {
            stdout: if body.trim().is_empty() {
                "ClawHub token 验证成功".to_string()
            } else {
                body
            },
        });
    }
    Err(Error::bad_request_code(
        "CLAWHUB_HTTP_VERIFY_FAILED",
        last_error.unwrap_or_else(|| "ClawHub token 验证失败".to_string()),
        None,
    ))
}

async fn run_server_clawhub_search_http(
    site_url: &str,
    registry_url: &str,
    token: &str,
    query: &str,
    limit: usize,
) -> Result<ServerClawHubSearchResult> {
    let context = resolve_server_http_context(site_url, registry_url);
    let client = build_server_clawhub_client()?;
    let mut candidates = Vec::new();
    let mut search_url = Url::parse(&format!("{}/api/v1/search", context.registry_url))
        .map_err(|error| Error::Internal(error.into()))?;
    search_url
        .query_pairs_mut()
        .append_pair("q", query)
        .append_pair("limit", &limit.to_string());
    candidates.push(search_url);

    let mut search_url_alt = Url::parse(&format!("{}/api/v1/search", context.registry_url))
        .map_err(|error| Error::Internal(error.into()))?;
    search_url_alt
        .query_pairs_mut()
        .append_pair("query", query)
        .append_pair("limit", &limit.to_string());
    candidates.push(search_url_alt);

    let mut site_search_url = Url::parse(&format!("{}/api/v1/search", context.site_url))
        .map_err(|error| Error::Internal(error.into()))?;
    site_search_url
        .query_pairs_mut()
        .append_pair("q", query)
        .append_pair("limit", &limit.to_string());
    candidates.push(site_search_url);

    let mut last_error = None;
    for url in candidates {
        match server_fetch_json(&client, url.clone(), Some(token)).await {
            Ok(payload) => {
                let entries = server_parse_http_search_entries(
                    &payload,
                    limit,
                    context.site_url.as_str(),
                    context.registry_url.as_str(),
                    Some("team_proxy"),
                );
                if !entries.is_empty() {
                    return Ok(ServerClawHubSearchResult {
                        entries,
                        raw_output: serde_json::to_string(&payload).unwrap_or_default(),
                    });
                }
                last_error = Some(format!("ClawHub 搜索返回成功但未解析到 skill ({url})"));
            }
            Err(error) => last_error = Some(error.to_string()),
        }
    }

    Err(Error::bad_request_code(
        "CLAWHUB_HTTP_SEARCH_FAILED",
        last_error.unwrap_or_else(|| "ClawHub 搜索失败".to_string()),
        None,
    ))
}

async fn run_server_clawhub_install_http(
    site_url: &str,
    registry_url: &str,
    token: &str,
    slug: &str,
    version: Option<&str>,
) -> Result<ServerClawHubInstallResult> {
    let context = resolve_server_http_context(site_url, registry_url);
    let bundle = resolve_server_bundle_http(&context, slug, version, token).await?;
    let skill_md = String::from_utf8(bundle.bytes.clone())
        .ok()
        .filter(|text| text.trim_start().starts_with("---"))
        .unwrap_or_default();
    Ok(ServerClawHubInstallResult {
        skill_md,
        stdout: "已通过服务端 HTTP 代理获取 ClawHub bundle".to_string(),
        installed_spec: match version {
            Some(version) => format!("{slug}@{version}"),
            None => slug.to_string(),
        },
        detected_skill_path: None,
        bundle_base64: Some(STANDARD.encode(&bundle.bytes)),
        installed_version: bundle.version.or_else(|| version.map(str::to_string)),
        origin_url: bundle.origin_url,
        site_url: Some(context.site_url),
        registry_url: Some(context.registry_url),
    })
}

async fn resolve_server_bundle_http(
    context: &ServerHttpClawHubContext,
    slug: &str,
    version: Option<&str>,
    token: &str,
) -> Result<ServerHttpClawHubBundle> {
    let client = build_server_clawhub_client()?;
    let mut candidates = Vec::new();

    let mut skill_url = Url::parse(&format!("{}/api/v1/skills/{}", context.registry_url, slug))
        .map_err(|error| Error::Internal(error.into()))?;
    if let Some(version) = version {
        skill_url.query_pairs_mut().append_pair("version", version);
    }
    candidates.push(skill_url);

    let mut download_url = Url::parse(&format!("{}/api/v1/download", context.registry_url))
        .map_err(|error| Error::Internal(error.into()))?;
    download_url.query_pairs_mut().append_pair("slug", slug);
    if let Some(version) = version {
        download_url
            .query_pairs_mut()
            .append_pair("version", version);
    }
    candidates.push(download_url);

    let mut download_slug_url = Url::parse(&format!(
        "{}/api/v1/download/{}",
        context.registry_url, slug
    ))
    .map_err(|error| Error::Internal(error.into()))?;
    if let Some(version) = version {
        download_slug_url
            .query_pairs_mut()
            .append_pair("version", version);
    }
    candidates.push(download_slug_url);

    let mut download_skill_url = Url::parse(&format!(
        "{}/api/v1/skills/{}/download",
        context.registry_url, slug
    ))
    .map_err(|error| Error::Internal(error.into()))?;
    if let Some(version) = version {
        download_skill_url
            .query_pairs_mut()
            .append_pair("version", version);
    }
    candidates.push(download_skill_url);

    let mut last_error = None;
    for url in candidates {
        let response = server_apply_auth(client.get(url.clone()), Some(token))
            .send()
            .await
            .map_err(|error| Error::Internal(error.into()))?;
        if !response.status().is_success() {
            last_error = Some(format!(
                "ClawHub 下载接口返回 {} ({url})",
                response.status()
            ));
            continue;
        }
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let body = response
            .bytes()
            .await
            .map_err(|error| Error::Internal(error.into()))?
            .to_vec();

        if content_type.contains("application/json")
            || body.first() == Some(&b'{')
            || body.first() == Some(&b'[')
        {
            let payload = serde_json::from_slice::<Value>(&body)
                .map_err(|error| Error::Internal(error.into()))?;
            if let Some(download_url) = server_extract_url_from_json(
                &payload,
                &[
                    "download_url",
                    "downloadUrl",
                    "bundle_url",
                    "bundleUrl",
                    "archive_url",
                    "archiveUrl",
                    "url",
                ],
                &[context.registry_url.as_str(), context.site_url.as_str()],
            ) {
                let followup_response = server_apply_auth(client.get(&download_url), Some(token))
                    .send()
                    .await
                    .map_err(|error| Error::Internal(error.into()))?;
                if !followup_response.status().is_success() {
                    last_error = Some(format!(
                        "ClawHub bundle 下载返回 {} ({download_url})",
                        followup_response.status()
                    ));
                    continue;
                }
                let bytes = followup_response
                    .bytes()
                    .await
                    .map_err(|error| Error::Internal(error.into()))?
                    .to_vec();
                return Ok(ServerHttpClawHubBundle {
                    bytes,
                    version: server_extract_version_from_json(&payload)
                        .or_else(|| version.map(str::to_string)),
                    origin_url: server_extract_url_from_json(
                        &payload,
                        &["origin_url", "originUrl", "url", "site_url", "siteUrl"],
                        &[context.site_url.as_str(), context.registry_url.as_str()],
                    )
                    .or(Some(download_url)),
                });
            }
            if let Some(skill_md) =
                server_extract_string_from_json(&payload, &["skill_md", "skillMd"])
            {
                return Ok(ServerHttpClawHubBundle {
                    bytes: skill_md.into_bytes(),
                    version: server_extract_version_from_json(&payload)
                        .or_else(|| version.map(str::to_string)),
                    origin_url: server_extract_url_from_json(
                        &payload,
                        &["origin_url", "originUrl", "url", "site_url", "siteUrl"],
                        &[context.site_url.as_str(), context.registry_url.as_str()],
                    )
                    .or(Some(url.to_string())),
                });
            }
            last_error = Some(format!(
                "ClawHub 下载接口返回 JSON，但未找到 bundle URL ({url})"
            ));
            continue;
        }

        return Ok(ServerHttpClawHubBundle {
            bytes: body,
            version: version.map(str::to_string),
            origin_url: Some(url.to_string()),
        });
    }

    Err(Error::bad_request_code(
        "CLAWHUB_HTTP_INSTALL_FAILED",
        last_error.unwrap_or_else(|| "ClawHub bundle 下载失败".to_string()),
        None,
    ))
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

#[derive(Debug, Deserialize, Default)]
struct GetTeamSkillMarketplaceConfigQuery {
    provider: Option<String>,
    resolve: Option<bool>,
}

#[derive(Debug, Deserialize, Default)]
struct GetTeamSkillMarketplaceStatusQuery {
    provider: Option<String>,
}

#[derive(Debug, sqlx::FromRow)]
struct TeamSkillMarketplaceConfigRow {
    id: Uuid,
    team_id: Uuid,
    provider: String,
    site_url: String,
    registry_url: String,
    api_token: String,
    is_active: bool,
    updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize)]
struct SetTeamSkillMarketplaceConfigRequest {
    id: Option<Uuid>,
    provider: Option<String>,
    api_token: String,
    is_active: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct VerifyTeamSkillMarketplaceConfigRequest {
    provider: Option<String>,
}

#[derive(Debug, Deserialize)]
struct InstallTeamSkillMarketplaceRequest {
    provider: Option<String>,
    slug: String,
    version: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SearchTeamSkillMarketplaceRequest {
    provider: Option<String>,
    query: String,
    limit: Option<u32>,
}
