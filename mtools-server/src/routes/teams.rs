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
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::{
    collections::HashMap,
    fs,
    path::{Path as FsPath, PathBuf},
    process::Command,
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
        .route(
            "/{id}/skill-marketplace-sync",
            post(sync_skill_marketplace_cache),
        )
        .route(
            "/{id}/skill-marketplace-cache",
            get(list_skill_marketplace_cache),
        )
        .route(
            "/{id}/published-skills",
            get(list_team_published_skills).post(publish_team_skill),
        )
        .route(
            "/{id}/published-skills/{sid}",
            axum::routing::patch(patch_team_published_skill),
        )
        .route(
            "/{id}/published-skills/{sid}/install-logs",
            get(list_team_published_skill_install_logs),
        )
        .route(
            "/{id}/published-skills/{sid}/install",
            post(install_team_published_skill),
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

fn team_skill_marketplace_cache_to_json(row: TeamSkillMarketplaceCacheRow) -> serde_json::Value {
    serde_json::json!({
        "id": row.id,
        "team_id": row.team_id,
        "provider": row.provider,
        "slug": row.slug,
        "name": row.name,
        "description": row.description,
        "latest_version": row.latest_version,
        "versions": row.versions_json.0,
        "author": row.author,
        "tags": row.tags_json.0,
        "icon_url": row.icon_url,
        "raw_metadata": row.raw_metadata_json.0,
        "last_synced_at": row.last_synced_at,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    })
}

async fn record_team_skill_install_log(
    db: &sqlx::PgPool,
    team_id: Uuid,
    user_id: Uuid,
    published_skill_id: Uuid,
    action: &str,
    status: &str,
    error_message: Option<&str>,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO team_skill_install_logs (
            team_id, user_id, published_skill_id, action, status, error_message
         ) VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(team_id)
    .bind(user_id)
    .bind(published_skill_id)
    .bind(action)
    .bind(status)
    .bind(error_message)
    .execute(db)
    .await?;
    Ok(())
}

async fn record_team_skill_install_log_best_effort(
    db: &sqlx::PgPool,
    team_id: Uuid,
    user_id: Uuid,
    published_skill_id: Uuid,
    action: &str,
    status: &str,
    error_message: Option<&str>,
) {
    if let Err(error) = record_team_skill_install_log(
        db,
        team_id,
        user_id,
        published_skill_id,
        action,
        status,
        error_message,
    )
    .await
    {
        tracing::warn!("team skill install log failed: {error}");
    }
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
    check_membership_active(&state.db, team_id, user_id).await?;

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
        serde_json::json!({
            "id": record.id,
            "team_id": record.team_id,
            "provider": record.provider,
            "site_url": record.site_url,
            "registry_url": record.registry_url,
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

    let (cli_installed, cli_version) = match find_clawhub_binary() {
        Some((_, version)) => (true, Some(version)),
        None => (false, None),
    };
    let cache_stats = sqlx::query_as::<_, TeamSkillMarketplaceCacheStats>(
        "SELECT
            COUNT(*)::bigint AS cached_count,
            MAX(last_synced_at) AS last_synced_at
         FROM team_skill_marketplace_cache
         WHERE team_id = $1 AND provider = $2",
    )
    .bind(team_id)
    .bind(provider)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "provider": provider,
        "configured": config.is_some(),
        "active": config.as_ref().map(|item| item.is_active).unwrap_or(false),
        "site_url": config.as_ref().map(|item| item.site_url.clone()),
        "registry_url": config.as_ref().map(|item| item.registry_url.clone()),
        "updated_at": config.as_ref().map(|item| item.updated_at),
        "cli_installed": cli_installed,
        "cli_version": cli_version,
        "can_search": cli_installed && config.as_ref().map(|item| item.is_active).unwrap_or(false),
        "can_install": cli_installed && config.as_ref().map(|item| item.is_active).unwrap_or(false),
        "can_sync": cli_installed && config.as_ref().map(|item| item.is_active).unwrap_or(false),
        "cached_count": cache_stats.cached_count,
        "last_synced_at": cache_stats.last_synced_at,
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
    let site_url = payload.site_url.trim();
    let registry_url = payload.registry_url.trim();
    if site_url.is_empty() || registry_url.is_empty() {
        return Err(Error::bad_request_code(
            "INVALID_SKILL_MARKETPLACE_CONFIG",
            "site_url and registry_url are required",
            None,
        ));
    }

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
        .bind(site_url)
        .bind(registry_url)
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
        .bind(site_url)
        .bind(registry_url)
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

    let site_url = config.site_url;
    let registry_url = config.registry_url;
    let token = token.trim().to_string();
    let result = tokio::task::spawn_blocking(move || {
        run_server_clawhub_verify(site_url.as_str(), registry_url.as_str(), token.as_str())
    })
    .await
    .map_err(|error| {
        Error::Internal(anyhow::anyhow!("验证团队 ClawHub 配置任务失败: {error}"))
    })??;

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

    let site_url = config.site_url;
    let registry_url = config.registry_url;
    let token = token.trim().to_string();
    let slug = slug.to_string();
    let version = payload.version;
    let audit_slug = slug.clone();
    let audit_version = version.clone();
    let result = tokio::task::spawn_blocking(move || {
        run_server_clawhub_install(
            site_url.as_str(),
            registry_url.as_str(),
            token.as_str(),
            slug.as_str(),
            version.as_deref(),
        )
    })
    .await
    .map_err(|error| {
        Error::Internal(anyhow::anyhow!("安装团队 ClawHub skill 任务失败: {error}"))
    })??;

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
        }),
    )
    .await;

    Ok(Json(serde_json::json!({
        "skill_md": result.skill_md,
        "stdout": result.stdout,
        "installed_spec": result.installed_spec,
        "detected_skill_path": result.detected_skill_path,
    })))
}

async fn sync_skill_marketplace_cache(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Json(payload): Json<SyncTeamSkillMarketplaceRequest>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_admin_active(&state.db, team_id, user_id).await?;

    let provider = normalize_skill_marketplace_provider(payload.provider.as_deref())?;
    let query = payload.query.trim();
    if query.is_empty() {
        return Err(Error::bad_request_code(
            "INVALID_SKILL_SYNC_QUERY",
            "同步关键词不能为空",
            None,
        ));
    }

    let config = get_active_skill_marketplace_config(&state.db, team_id, provider).await?;
    let token = crate::crypto::maybe_decrypt(&config.api_token);
    let site_url = config.site_url;
    let registry_url = config.registry_url;
    let query_string = query.to_string();
    let token = token.trim().to_string();
    let limit = payload.limit.unwrap_or(50).clamp(1, 100);

    let result = tokio::task::spawn_blocking(move || {
        run_server_clawhub_search(
            site_url.as_str(),
            registry_url.as_str(),
            token.as_str(),
            query_string.as_str(),
            limit as usize,
        )
    })
    .await
    .map_err(|error| Error::Internal(anyhow::anyhow!("同步团队技能市场缓存任务失败: {error}")))??;

    let synced_at = chrono::Utc::now();
    let mut tx = state
        .db
        .begin()
        .await
        .map_err(|e| Error::Internal(e.into()))?;
    let mut items = Vec::new();
    for entry in result.entries {
        let title = entry.title.clone().unwrap_or_else(|| entry.slug.clone());
        let row: TeamSkillMarketplaceCacheRow = sqlx::query_as(
            "INSERT INTO team_skill_marketplace_cache (
                team_id, provider, slug, name, description, latest_version, versions_json,
                author, tags_json, icon_url, raw_metadata_json, last_synced_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (team_id, provider, slug) DO UPDATE SET
                name = EXCLUDED.name,
                description = EXCLUDED.description,
                latest_version = EXCLUDED.latest_version,
                versions_json = EXCLUDED.versions_json,
                author = EXCLUDED.author,
                tags_json = EXCLUDED.tags_json,
                icon_url = EXCLUDED.icon_url,
                raw_metadata_json = EXCLUDED.raw_metadata_json,
                last_synced_at = EXCLUDED.last_synced_at,
                updated_at = NOW()
             RETURNING
                id, team_id, provider, slug, name, description, latest_version, versions_json,
                author, tags_json, icon_url, raw_metadata_json, last_synced_at, created_at, updated_at",
        )
        .bind(team_id)
        .bind(provider)
        .bind(&entry.slug)
        .bind(&title)
        .bind(&entry.description)
        .bind(Option::<String>::None)
        .bind(sqlx::types::Json(serde_json::Value::Array(vec![])))
        .bind(Option::<String>::None)
        .bind(sqlx::types::Json(serde_json::Value::Array(vec![])))
        .bind(Option::<String>::None)
        .bind(sqlx::types::Json(serde_json::json!({
            "title": entry.title,
            "description": entry.description,
            "query": query,
            "source": "clawhub_search_sync",
        })))
        .bind(synced_at)
        .fetch_one(&mut *tx)
        .await?;
        items.push(team_skill_marketplace_cache_to_json(row));
    }
    tx.commit().await.map_err(|e| Error::Internal(e.into()))?;
    let item_count = items.len();

    record_team_skill_audit_log_best_effort(
        &state.db,
        team_id,
        user_id,
        "skill_marketplace_cache_synced",
        Some(provider),
        None,
        None,
        None,
        serde_json::json!({
            "query": query,
            "limit": limit,
            "count": item_count,
        }),
    )
    .await;

    Ok(Json(serde_json::json!({
        "items": items,
        "count": item_count,
        "query": query,
        "synced_at": synced_at,
        "raw_output": result.raw_output,
    })))
}

async fn list_skill_marketplace_cache(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Query(query): Query<GetTeamSkillMarketplaceCacheQuery>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_admin_active(&state.db, team_id, user_id).await?;

    let provider = normalize_skill_marketplace_provider(query.provider.as_deref())?;
    let search_text = query.query.unwrap_or_default().trim().to_string();
    let limit = query.limit.unwrap_or(100).clamp(1, 200) as i64;
    let rows = if search_text.is_empty() {
        sqlx::query_as::<_, TeamSkillMarketplaceCacheRow>(
            "SELECT
                id, team_id, provider, slug, name, description, latest_version, versions_json,
                author, tags_json, icon_url, raw_metadata_json, last_synced_at, created_at, updated_at
             FROM team_skill_marketplace_cache
             WHERE team_id = $1 AND provider = $2
             ORDER BY last_synced_at DESC, updated_at DESC
             LIMIT $3",
        )
        .bind(team_id)
        .bind(provider)
        .bind(limit)
        .fetch_all(&state.db)
        .await?
    } else {
        let like = format!("%{search_text}%");
        sqlx::query_as::<_, TeamSkillMarketplaceCacheRow>(
            "SELECT
                id, team_id, provider, slug, name, description, latest_version, versions_json,
                author, tags_json, icon_url, raw_metadata_json, last_synced_at, created_at, updated_at
             FROM team_skill_marketplace_cache
             WHERE team_id = $1
               AND provider = $2
               AND (slug ILIKE $3 OR name ILIKE $3 OR COALESCE(description, '') ILIKE $3)
             ORDER BY last_synced_at DESC, updated_at DESC
             LIMIT $4",
        )
        .bind(team_id)
        .bind(provider)
        .bind(like)
        .bind(limit)
        .fetch_all(&state.db)
        .await?
    };

    let count = rows.len();
    let items = rows
        .into_iter()
        .map(team_skill_marketplace_cache_to_json)
        .collect::<Vec<_>>();

    Ok(Json(serde_json::json!({
        "items": items,
        "count": count,
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
    let site_url = config.site_url;
    let registry_url = config.registry_url;
    let query = query.to_string();
    let token = token.trim().to_string();
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

    let result = tokio::task::spawn_blocking(move || {
        run_server_clawhub_search(
            site_url.as_str(),
            registry_url.as_str(),
            token.as_str(),
            query.as_str(),
            limit as usize,
        )
    })
    .await
    .map_err(|error| {
        Error::Internal(anyhow::anyhow!("搜索团队 ClawHub skill 任务失败: {error}"))
    })??;

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

async fn list_team_published_skills(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_membership_active(&state.db, team_id, user_id).await?;
    let role = get_team_member_role(&state.db, team_id, user_id).await?;
    let include_inactive = matches!(role.as_deref(), Some("owner") | Some("admin"));

    let rows = if include_inactive {
        sqlx::query_as::<_, TeamPublishedSkillRow>(
            "SELECT
                id, team_id, provider, slug, version, display_name, description,
                skill_md, is_active, published_by, updated_by, created_at, updated_at
             FROM team_published_skills
             WHERE team_id = $1
             ORDER BY is_active DESC, updated_at DESC, created_at DESC",
        )
        .bind(team_id)
        .fetch_all(&state.db)
        .await?
    } else {
        sqlx::query_as::<_, TeamPublishedSkillRow>(
            "SELECT
                id, team_id, provider, slug, version, display_name, description,
                skill_md, is_active, published_by, updated_by, created_at, updated_at
             FROM team_published_skills
             WHERE team_id = $1 AND is_active = true
             ORDER BY updated_at DESC, created_at DESC",
        )
        .bind(team_id)
        .fetch_all(&state.db)
        .await?
    };

    let skills = rows
        .into_iter()
        .map(|row| {
            serde_json::json!({
                "id": row.id,
                "team_id": row.team_id,
                "provider": row.provider,
                "slug": row.slug,
                "version": row.version,
                "display_name": row.display_name,
                "description": row.description,
                "is_active": row.is_active,
                "published_by": row.published_by,
                "updated_by": row.updated_by,
                "created_at": row.created_at,
                "updated_at": row.updated_at,
            })
        })
        .collect::<Vec<_>>();

    Ok(Json(serde_json::json!({ "skills": skills })))
}

async fn publish_team_skill(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Json(payload): Json<PublishTeamSkillRequest>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_admin_active(&state.db, team_id, user_id).await?;

    let provider = normalize_skill_marketplace_provider(payload.provider.as_deref())?;
    let slug = payload.slug.trim();
    if slug.is_empty() {
        return Err(Error::bad_request_code(
            "INVALID_PUBLISHED_SKILL_SLUG",
            "发布到团队的 skill slug 不能为空",
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

    let site_url = config.site_url;
    let registry_url = config.registry_url;
    let token = token.trim().to_string();
    let slug_string = slug.to_string();
    let version = payload.version.clone();
    let install_result = tokio::task::spawn_blocking(move || {
        run_server_clawhub_install(
            site_url.as_str(),
            registry_url.as_str(),
            token.as_str(),
            slug_string.as_str(),
            version.as_deref(),
        )
    })
    .await
    .map_err(|error| Error::Internal(anyhow::anyhow!("发布团队 skill 任务失败: {error}")))??;

    let metadata = extract_skill_md_metadata(&install_result.skill_md, slug);
    let requested_version = payload
        .version
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let detected_version = metadata
        .version
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let (Some(requested), Some(detected)) =
        (requested_version.as_deref(), detected_version.as_deref())
    {
        if requested != detected {
            return Err(Error::bad_request_code(
                "TEAM_PUBLISHED_SKILL_VERSION_MISMATCH",
                format!("安装得到的 skill 版本为 {detected}，与请求版本 {requested} 不一致"),
                Some(serde_json::json!({
                    "team_id": team_id,
                    "slug": slug,
                    "requested_version": requested,
                    "detected_version": detected,
                })),
            ));
        }
    }
    let version_value = requested_version.or(detected_version).ok_or_else(|| {
        Error::bad_request_code(
            "TEAM_PUBLISHED_SKILL_VERSION_UNRESOLVED",
            "无法解析 skill 实际版本，请在发布时明确填写版本，或确保 SKILL.md 中包含 version 字段",
            Some(serde_json::json!({
                "team_id": team_id,
                "slug": slug,
            })),
        )
    })?;
    let row: TeamPublishedSkillRow = sqlx::query_as(
        "INSERT INTO team_published_skills (
            team_id, provider, slug, version, display_name, description, skill_md, is_active, published_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $8)
         ON CONFLICT (team_id, provider, slug, version) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            description = EXCLUDED.description,
            skill_md = EXCLUDED.skill_md,
            is_active = true,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
         RETURNING
            id, team_id, provider, slug, version, display_name, description,
            skill_md, is_active, published_by, updated_by, created_at, updated_at",
    )
    .bind(team_id)
    .bind(provider)
    .bind(slug)
    .bind(&version_value)
    .bind(&metadata.display_name)
    .bind(&metadata.description)
    .bind(&install_result.skill_md)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    record_team_skill_audit_log_best_effort(
        &state.db,
        team_id,
        user_id,
        "team_skill_published",
        Some(provider),
        Some(slug),
        Some(&version_value),
        Some(row.id),
        serde_json::json!({
            "display_name": row.display_name.clone(),
            "description": row.description.clone(),
        }),
    )
    .await;

    Ok(Json(serde_json::json!({
        "skill": {
            "id": row.id,
            "team_id": row.team_id,
            "provider": row.provider,
            "slug": row.slug,
            "version": row.version,
            "display_name": row.display_name,
            "description": row.description,
            "is_active": row.is_active,
            "published_by": row.published_by,
            "updated_by": row.updated_by,
            "created_at": row.created_at,
            "updated_at": row.updated_at,
        },
        "stdout": install_result.stdout,
    })))
}

async fn patch_team_published_skill(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((team_id, skill_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<PatchTeamPublishedSkillRequest>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_admin_active(&state.db, team_id, user_id).await?;
    let existing = sqlx::query_scalar::<_, Option<bool>>(
        "SELECT is_active FROM team_published_skills WHERE id = $1 AND team_id = $2",
    )
    .bind(skill_id)
    .bind(team_id)
    .fetch_optional(&state.db)
    .await?
    .flatten();

    let result = sqlx::query(
        "UPDATE team_published_skills
         SET
            is_active = COALESCE($1, is_active),
            updated_by = $2,
            updated_at = NOW()
         WHERE id = $3 AND team_id = $4",
    )
    .bind(payload.is_active)
    .bind(user_id)
    .bind(skill_id)
    .bind(team_id)
    .execute(&state.db)
    .await?;
    if result.rows_affected() == 0 {
        return Err(Error::not_found_code(
            "TEAM_PUBLISHED_SKILL_NOT_FOUND",
            "团队技能不存在",
            Some(serde_json::json!({ "team_id": team_id, "skill_id": skill_id })),
        ));
    }

    record_team_skill_audit_log_best_effort(
        &state.db,
        team_id,
        user_id,
        "team_skill_updated",
        Some("clawhub"),
        None,
        None,
        Some(skill_id),
        serde_json::json!({
            "previous_is_active": existing,
            "next_is_active": payload.is_active,
        }),
    )
    .await;

    Ok(Json(
        serde_json::json!({ "message": "Team published skill updated" }),
    ))
}

async fn install_team_published_skill(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((team_id, skill_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_membership_active(&state.db, team_id, user_id).await?;

    let row = sqlx::query_as::<_, TeamPublishedSkillRow>(
        "SELECT
            id, team_id, provider, slug, version, display_name, description,
            skill_md, is_active, published_by, updated_by, created_at, updated_at
         FROM team_published_skills
         WHERE id = $1 AND team_id = $2 AND is_active = true
         LIMIT 1",
    )
    .bind(skill_id)
    .bind(team_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        Error::not_found_code(
            "TEAM_PUBLISHED_SKILL_NOT_FOUND",
            "团队技能不存在或未启用",
            Some(serde_json::json!({ "team_id": team_id, "skill_id": skill_id })),
        )
    })?;

    record_team_skill_install_log_best_effort(
        &state.db, team_id, user_id, row.id, "install", "success", None,
    )
    .await;
    record_team_skill_audit_log_best_effort(
        &state.db,
        team_id,
        user_id,
        "team_skill_installed",
        Some(&row.provider),
        Some(&row.slug),
        Some(&row.version),
        Some(row.id),
        serde_json::json!({
            "display_name": row.display_name.clone(),
        }),
    )
    .await;

    Ok(Json(serde_json::json!({
        "skill_md": row.skill_md,
        "stdout": format!("已从团队技能库安装：{}", row.display_name),
        "installed_spec": if row.version.trim().is_empty() {
            row.slug.clone()
        } else {
            format!("{}@{}", row.slug, row.version)
        },
        "display_name": row.display_name,
        "slug": row.slug,
        "version": row.version,
    })))
}

async fn list_team_published_skill_install_logs(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((team_id, skill_id)): Path<(Uuid, Uuid)>,
    Query(query): Query<GetTeamPublishedSkillInstallLogsQuery>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_admin_active(&state.db, team_id, user_id).await?;

    let limit = query.limit.unwrap_or(50).clamp(1, 200) as i64;
    let rows = sqlx::query_as::<_, TeamSkillInstallLogRow>(
        "SELECT
            logs.id, logs.team_id, logs.user_id, logs.published_skill_id, logs.action,
            logs.status, logs.error_message, logs.created_at, users.username
         FROM team_skill_install_logs logs
         LEFT JOIN users ON users.id = logs.user_id
         WHERE logs.team_id = $1 AND logs.published_skill_id = $2
         ORDER BY logs.created_at DESC
         LIMIT $3",
    )
    .bind(team_id)
    .bind(skill_id)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "logs": rows.into_iter().map(|row| {
            serde_json::json!({
                "id": row.id,
                "team_id": row.team_id,
                "user_id": row.user_id,
                "published_skill_id": row.published_skill_id,
                "action": row.action,
                "status": row.status,
                "error_message": row.error_message,
                "created_at": row.created_at,
                "username": row.username,
            })
        }).collect::<Vec<_>>(),
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

const CLAWHUB_SITE_ENV: &str = "CLAWHUB_SITE";
const CLAWHUB_REGISTRY_ENV: &str = "CLAWHUB_REGISTRY";
const CLAWHUB_CONFIG_PATH_ENV: &str = "CLAWHUB_CONFIG_PATH";
const CLAWHUB_WORKDIR_ENV: &str = "CLAWHUB_WORKDIR";
const CLAWHUB_DISABLE_TELEMETRY_ENV: &str = "CLAWHUB_DISABLE_TELEMETRY";

struct ServerClawHubContext {
    root: PathBuf,
    config_path: PathBuf,
    workdir: PathBuf,
    site_url: String,
    registry_url: String,
}

impl Drop for ServerClawHubContext {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct ServerCommandRunResult {
    stdout: String,
    stderr: String,
}

struct ServerClawHubInstallResult {
    skill_md: String,
    stdout: String,
    installed_spec: String,
    detected_skill_path: Option<String>,
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
}

fn run_server_clawhub_verify(
    site_url: &str,
    registry_url: &str,
    token: &str,
) -> Result<ServerCommandRunResult> {
    let (binary, _) = find_clawhub_binary().ok_or_else(|| {
        Error::bad_request_code(
            "CLAWHUB_CLI_NOT_AVAILABLE",
            "服务端未安装 clawhub CLI，无法验证团队配置",
            None,
        )
    })?;
    let context = prepare_server_clawhub_context(site_url, registry_url, "verify")?;
    run_clawhub_login(&binary, &context, token)?;
    run_clawhub_command(&binary, &["whoami"], &context)
}

fn run_server_clawhub_install(
    site_url: &str,
    registry_url: &str,
    token: &str,
    slug: &str,
    version: Option<&str>,
) -> Result<ServerClawHubInstallResult> {
    let (binary, _) = find_clawhub_binary().ok_or_else(|| {
        Error::bad_request_code(
            "CLAWHUB_CLI_NOT_AVAILABLE",
            "服务端未安装 clawhub CLI，无法执行团队技能安装",
            None,
        )
    })?;
    let context = prepare_server_clawhub_context(site_url, registry_url, "install")?;
    let mut logs = Vec::new();
    logs.push(run_clawhub_login(&binary, &context, token)?);

    let installed_spec = match version.map(str::trim).filter(|value| !value.is_empty()) {
        Some(version) => format!("{slug}@{version}"),
        None => slug.to_string(),
    };

    let mut args = vec![
        "install".to_string(),
        slug.to_string(),
        "--workdir".to_string(),
        context.workdir.to_string_lossy().to_string(),
        "--dir".to_string(),
        "skills".to_string(),
    ];
    if let Some(version) = version.map(str::trim).filter(|value| !value.is_empty()) {
        args.push("--version".to_string());
        args.push(version.to_string());
    }

    let string_args = args.iter().map(String::as_str).collect::<Vec<_>>();
    logs.push(run_clawhub_command(&binary, &string_args, &context)?);

    let skills_root = context.workdir.join("skills");
    let skill_md_path = find_installed_skill_md(&skills_root, slug).ok_or_else(|| {
        Error::bad_request_code(
            "CLAWHUB_SKILL_MD_NOT_FOUND",
            format!(
                "服务端已完成安装，但未在 {} 中找到 SKILL.md",
                skills_root.display()
            ),
            None,
        )
    })?;

    let skill_md = fs::read_to_string(&skill_md_path).map_err(|error| {
        Error::bad_request_code(
            "CLAWHUB_SKILL_MD_READ_FAILED",
            format!(
                "读取服务端 SKILL.md 失败 ({}): {error}",
                skill_md_path.display()
            ),
            None,
        )
    })?;

    Ok(ServerClawHubInstallResult {
        skill_md,
        stdout: collect_command_logs(&logs),
        installed_spec,
        detected_skill_path: skill_md_path
            .parent()
            .map(|path| path.display().to_string()),
    })
}

fn run_server_clawhub_search(
    site_url: &str,
    registry_url: &str,
    token: &str,
    query: &str,
    limit: usize,
) -> Result<ServerClawHubSearchResult> {
    let (binary, _) = find_clawhub_binary().ok_or_else(|| {
        Error::bad_request_code(
            "CLAWHUB_CLI_NOT_AVAILABLE",
            "服务端未安装 clawhub CLI，无法搜索团队技能",
            None,
        )
    })?;
    let context = prepare_server_clawhub_context(site_url, registry_url, "search")?;
    if !token.trim().is_empty() {
        let _ = run_clawhub_login(&binary, &context, token)?;
    }
    let result = run_clawhub_command(&binary, &["search", query], &context)?;
    let raw_output = collect_command_logs(&[result]);
    let entries = parse_clawhub_search_output(&raw_output, limit);
    Ok(ServerClawHubSearchResult {
        entries,
        raw_output,
    })
}

fn find_clawhub_binary() -> Option<(String, String)> {
    for candidate in ["clawhub", "clawhub.cmd", "clawhub.exe"] {
        let Ok(output) = Command::new(candidate).arg("--version").output() else {
            continue;
        };
        if !output.status.success() {
            continue;
        }

        return Some((
            candidate.to_string(),
            normalized_output_text(&output.stdout, &output.stderr),
        ));
    }
    None
}

fn prepare_server_clawhub_context(
    site_url: &str,
    registry_url: &str,
    purpose: &str,
) -> Result<ServerClawHubContext> {
    let root = std::env::temp_dir()
        .join("mtools-server-skill-marketplace")
        .join("clawhub")
        .join(format!("{purpose}-{}", Uuid::new_v4()));
    let workdir = root.join("workspace");
    fs::create_dir_all(workdir.join("skills")).map_err(|error| {
        Error::bad_request_code(
            "CLAWHUB_WORKDIR_CREATE_FAILED",
            format!("创建服务端 ClawHub 工作目录失败: {error}"),
            None,
        )
    })?;

    Ok(ServerClawHubContext {
        root: root.clone(),
        config_path: root.join("config.json"),
        workdir,
        site_url: site_url.trim().to_string(),
        registry_url: registry_url.trim().to_string(),
    })
}

fn run_clawhub_login(
    binary: &str,
    context: &ServerClawHubContext,
    token: &str,
) -> Result<ServerCommandRunResult> {
    run_clawhub_command(binary, &["login", "--token", token], context)
}

fn run_clawhub_command(
    binary: &str,
    args: &[&str],
    context: &ServerClawHubContext,
) -> Result<ServerCommandRunResult> {
    let mut command = Command::new(binary);
    command.args(args);
    command.current_dir(&context.workdir);
    command.env(CLAWHUB_CONFIG_PATH_ENV, &context.config_path);
    command.env(CLAWHUB_WORKDIR_ENV, &context.workdir);
    command.env(CLAWHUB_DISABLE_TELEMETRY_ENV, "1");
    command.env(CLAWHUB_SITE_ENV, &context.site_url);
    command.env(CLAWHUB_REGISTRY_ENV, &context.registry_url);

    let output = command.output().map_err(|error| {
        Error::bad_request_code(
            "CLAWHUB_COMMAND_EXEC_FAILED",
            format!("执行 clawhub {} 失败: {error}", args.join(" ")),
            None,
        )
    })?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if !output.status.success() {
        let message = if stderr.is_empty() {
            stdout.clone()
        } else if stdout.is_empty() {
            stderr.clone()
        } else {
            format!("{stdout}\n{stderr}")
        };
        return Err(Error::bad_request_code(
            "CLAWHUB_COMMAND_FAILED",
            format!(
                "clawhub {} 执行失败{}",
                args.join(" "),
                if message.is_empty() {
                    String::new()
                } else {
                    format!(": {message}")
                }
            ),
            None,
        ));
    }

    Ok(ServerCommandRunResult { stdout, stderr })
}

fn normalized_output_text(stdout: &[u8], stderr: &[u8]) -> String {
    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    if !stdout.is_empty() {
        return stdout;
    }
    String::from_utf8_lossy(stderr).trim().to_string()
}

fn collect_command_logs(results: &[ServerCommandRunResult]) -> String {
    results
        .iter()
        .flat_map(|item| {
            [item.stdout.trim(), item.stderr.trim()]
                .into_iter()
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn parse_clawhub_search_output(output: &str, limit: usize) -> Vec<ServerClawHubSearchEntry> {
    let cleaned = strip_ansi_codes(output);
    let mut entries = Vec::new();

    for line in cleaned.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        if let Some(entry) = parse_clawhub_search_line(line) {
            if entries
                .iter()
                .any(|existing: &ServerClawHubSearchEntry| existing.slug == entry.slug)
            {
                continue;
            }
            entries.push(entry);
            if entries.len() >= limit {
                break;
            }
        }
    }

    entries
}

fn parse_clawhub_search_line(line: &str) -> Option<ServerClawHubSearchEntry> {
    let slug = extract_slug_candidate(line)?;
    let title = line
        .split_whitespace()
        .take_while(|part| !part.contains('/'))
        .collect::<Vec<_>>()
        .join(" ");
    let description = line
        .split_once(&slug)
        .map(|(_, rest)| rest.trim().trim_matches('-').trim().to_string())
        .filter(|text| !text.is_empty());

    Some(ServerClawHubSearchEntry {
        slug,
        title: if title.is_empty() { None } else { Some(title) },
        description,
    })
}

fn extract_slug_candidate(line: &str) -> Option<String> {
    line.split_whitespace()
        .map(|token| token.trim_matches(|ch: char| ",;|[]()".contains(ch)))
        .find(|token| {
            let Some((owner, skill)) = token.split_once('/') else {
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
        })
        .map(str::to_string)
}

fn strip_ansi_codes(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            while let Some(next) = chars.next() {
                if matches!(next, 'A'..='Z' | 'a'..='z') {
                    break;
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

struct SkillMdMetadata {
    display_name: String,
    description: Option<String>,
    version: Option<String>,
}

fn extract_skill_md_metadata(content: &str, fallback_slug: &str) -> SkillMdMetadata {
    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut version: Option<String> = None;

    let mut lines = content.lines();
    if matches!(lines.next().map(str::trim), Some("---")) {
        for line in lines {
            let trimmed = line.trim();
            if trimmed == "---" {
                break;
            }
            if let Some(value) = trimmed.strip_prefix("name:") {
                let next = value.trim().trim_matches('"').trim_matches('\'');
                if !next.is_empty() {
                    name = Some(next.to_string());
                }
            } else if let Some(value) = trimmed.strip_prefix("description:") {
                let next = value.trim().trim_matches('"').trim_matches('\'');
                if !next.is_empty() {
                    description = Some(next.to_string());
                }
            } else if let Some(value) = trimmed.strip_prefix("version:") {
                let next = value.trim().trim_matches('"').trim_matches('\'');
                if !next.is_empty() {
                    version = Some(next.to_string());
                }
            }
        }
    }

    SkillMdMetadata {
        display_name: name.unwrap_or_else(|| fallback_slug.to_string()),
        description,
        version,
    }
}

fn find_installed_skill_md(root: &FsPath, slug: &str) -> Option<PathBuf> {
    if !root.exists() {
        return None;
    }
    let mut candidates = Vec::new();
    collect_skill_md_files(root, &mut candidates);
    if candidates.is_empty() {
        return None;
    }

    let slug_parts = slug
        .split('/')
        .map(|part| part.trim().to_ascii_lowercase())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        let left_score = skill_md_candidate_score(left, &slug_parts);
        let right_score = skill_md_candidate_score(right, &slug_parts);
        left_score
            .cmp(&right_score)
            .then_with(|| left.to_string_lossy().cmp(&right.to_string_lossy()))
    });
    candidates.into_iter().next()
}

fn skill_md_candidate_score(path: &FsPath, slug_parts: &[String]) -> (u8, usize) {
    let components = path
        .components()
        .map(|component| component.as_os_str().to_string_lossy().to_ascii_lowercase())
        .collect::<Vec<_>>();
    let depth = components.len();
    if slug_parts.len() >= 2 {
        let owner = &slug_parts[0];
        let skill = &slug_parts[1];
        if depth >= 3 && components[depth - 2] == *skill && components[depth - 3] == *owner {
            return (0, depth);
        }
        if depth >= 4 && components[depth - 3] == *skill && components[depth - 4] == *owner {
            return (1, depth);
        }
    }
    if !slug_parts.is_empty()
        && components
            .windows(slug_parts.len())
            .any(|window| window == slug_parts)
    {
        return (2, depth);
    }
    if slug_parts
        .iter()
        .all(|part| components.iter().any(|component| component == part))
    {
        return (3, depth);
    }
    (4, depth)
}

fn collect_skill_md_files(dir: &FsPath, results: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut sorted_entries = entries
        .flatten()
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    sorted_entries.sort_by(|left, right| {
        let left = left.to_string_lossy();
        let right = right.to_string_lossy();
        left.cmp(&right)
    });
    for path in sorted_entries {
        if path.is_file() {
            if path
                .file_name()
                .map(|name| name.to_string_lossy() == "SKILL.md")
                == Some(true)
            {
                results.push(path);
            }
            continue;
        }

        if path.is_dir() {
            collect_skill_md_files(&path, results);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_skill_md_metadata_reads_version_field() {
        let metadata = extract_skill_md_metadata(
            r#"---
name: SQL Export
description: Export data
version: 2.3.4
---
# Body
"#,
            "team/sql-export",
        );

        assert_eq!(metadata.display_name, "SQL Export");
        assert_eq!(metadata.description.as_deref(), Some("Export data"));
        assert_eq!(metadata.version.as_deref(), Some("2.3.4"));
    }

    #[test]
    fn find_installed_skill_md_prefers_slug_matched_path() {
        let root = std::env::temp_dir()
            .join("mtools-server-skill-marketplace-tests")
            .join(Uuid::new_v4().to_string());
        let expected = root
            .join("team")
            .join("sql-export")
            .join("2.3.4")
            .join("SKILL.md");
        let distractor = root.join("other").join("misc").join("SKILL.md");

        fs::create_dir_all(expected.parent().expect("expected parent")).expect("create expected");
        fs::create_dir_all(distractor.parent().expect("distractor parent"))
            .expect("create distractor");
        fs::write(&expected, "---\nname: expected\n---").expect("write expected");
        fs::write(&distractor, "---\nname: distractor\n---").expect("write distractor");

        let selected = find_installed_skill_md(&root, "team/sql-export").expect("select skill");
        assert_eq!(selected, expected);

        let _ = fs::remove_dir_all(root);
    }
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

#[derive(Debug, Deserialize, Default)]
struct GetTeamSkillMarketplaceCacheQuery {
    provider: Option<String>,
    query: Option<String>,
    limit: Option<u32>,
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
    site_url: String,
    registry_url: String,
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

#[derive(Debug, Deserialize)]
struct SyncTeamSkillMarketplaceRequest {
    provider: Option<String>,
    query: String,
    limit: Option<u32>,
}

#[derive(Debug, sqlx::FromRow)]
struct TeamPublishedSkillRow {
    id: Uuid,
    team_id: Uuid,
    provider: String,
    slug: String,
    version: String,
    display_name: String,
    description: Option<String>,
    skill_md: String,
    is_active: bool,
    published_by: Uuid,
    updated_by: Uuid,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, sqlx::FromRow)]
struct TeamSkillMarketplaceCacheRow {
    id: Uuid,
    team_id: Uuid,
    provider: String,
    slug: String,
    name: String,
    description: Option<String>,
    latest_version: Option<String>,
    versions_json: sqlx::types::Json<serde_json::Value>,
    author: Option<String>,
    tags_json: sqlx::types::Json<serde_json::Value>,
    icon_url: Option<String>,
    raw_metadata_json: sqlx::types::Json<serde_json::Value>,
    last_synced_at: chrono::DateTime<chrono::Utc>,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, sqlx::FromRow)]
struct TeamSkillMarketplaceCacheStats {
    cached_count: i64,
    last_synced_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, sqlx::FromRow)]
struct TeamSkillInstallLogRow {
    id: Uuid,
    team_id: Uuid,
    user_id: Uuid,
    published_skill_id: Uuid,
    action: String,
    status: String,
    error_message: Option<String>,
    created_at: chrono::DateTime<chrono::Utc>,
    username: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PublishTeamSkillRequest {
    provider: Option<String>,
    slug: String,
    version: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PatchTeamPublishedSkillRequest {
    is_active: Option<bool>,
}

#[derive(Debug, Deserialize, Default)]
struct GetTeamPublishedSkillInstallLogsQuery {
    limit: Option<u32>,
}
