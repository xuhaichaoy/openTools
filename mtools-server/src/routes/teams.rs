use axum::{
    extract::{State, Extension, Path, Query},
    routing::{get, post, put, patch},
    Json,
    Router,
};
use crate::{
    routes::AppState,
    services::auth::Claims,
    Result,
    Error,
};
use std::sync::Arc;
use uuid::Uuid;
use serde::{Deserialize, Serialize};
use chrono::Datelike;

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
        .route("/{id}", get(get_team_details).patch(update_team).delete(delete_team))
        .route("/{id}/members", get(list_team_members).post(invite_member))
        .route("/{id}/members/{uid}", axum::routing::patch(update_member_role).delete(remove_member))
        .route("/{id}/share", post(share_resource))
        .route("/{id}/resources", get(list_shared_resources))
        .route("/{id}/resources/{rid}", axum::routing::delete(unshare_resource))
        .route("/{id}/ai-config", get(get_ai_config).put(set_ai_config))
        .route("/{id}/ai-config/{cid}", axum::routing::patch(patch_ai_config).delete(delete_ai_config))
        .route("/{id}/ai-models", get(get_team_ai_models))
        .route("/{id}/ai-usage", get(get_team_ai_usage))
        .route("/{id}/ai-quota", get(get_team_ai_quota))
        .route("/{id}/ai-quota/policy", put(set_team_ai_quota_policy))
        .route("/{id}/ai-quota/member/{uid}", patch(patch_team_member_ai_quota))
        .route("/{id}/ai-quota/members", get(get_team_ai_quota_members))
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
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2",
    )
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

async fn ensure_team_quota_tables(db: &sqlx::PgPool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS team_ai_quota_policy (
            team_id UUID PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
            monthly_limit_tokens BIGINT NOT NULL DEFAULT 0,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )",
    )
    .execute(db)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS team_ai_member_quota_adjustments (
            team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            month_key CHAR(7) NOT NULL,
            extra_tokens BIGINT NOT NULL DEFAULT 0,
            updated_by UUID NOT NULL REFERENCES users(id),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (team_id, user_id, month_key)
        )",
    )
    .execute(db)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_team_ai_usage_month_user
         ON team_ai_usage_logs(team_id, user_id, created_at DESC)",
    )
    .execute(db)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_team_quota_adjustments_lookup
         ON team_ai_member_quota_adjustments(team_id, month_key, user_id)",
    )
    .execute(db)
    .await?;

    Ok(())
}

fn current_month_key() -> String {
    let now = chrono::Local::now();
    format!("{:04}-{:02}", now.year(), now.month())
}

fn normalize_month_key(month: Option<&str>) -> Result<String> {
    let value = month
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(current_month_key);

    if value.len() != 7 || !value.is_ascii() || &value[4..5] != "-" {
        return Err(Error::BadRequest("Invalid month format, expected YYYY-MM".into()));
    }

    let year: i32 = value[0..4]
        .parse()
        .map_err(|_| Error::BadRequest("Invalid month format, expected YYYY-MM".into()))?;
    let month_num: u32 = value[5..7]
        .parse()
        .map_err(|_| Error::BadRequest("Invalid month format, expected YYYY-MM".into()))?;

    if year < 1970 || !(1..=12).contains(&month_num) {
        return Err(Error::BadRequest("Invalid month format, expected YYYY-MM".into()));
    }

    Ok(format!("{:04}-{:02}", year, month_num))
}

// ── 团队 CRUD ──

async fn create_team(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<CreateTeamRequest>,
) -> Result<Json<Team>> {
    let user_id = parse_user_id(&claims)?;
    let mut tx = state.db.begin().await.map_err(|e| Error::Internal(e.into()))?;

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
        "SELECT id, team_id, config_name, protocol, base_url, api_key, model_name, member_token_limit, priority, is_active, created_at
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
                "member_token_limit": r.member_token_limit,
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
    let member_token_limit = payload.member_token_limit.unwrap_or(0);
    let priority = payload.priority;
    if let Some(value) = priority {
        if value < 0 {
            return Err(Error::BadRequest("priority must be >= 0".into()));
        }
    }

    let encrypted_key = if payload.api_key.is_empty() {
        String::new()
    } else {
        crate::crypto::encrypt(&payload.api_key)
            .map_err(|e| Error::Internal(e))?
    };

    if let Some(config_id) = payload.id {
        sqlx::query(
            "UPDATE team_ai_configs SET
                config_name = $1,
                protocol = $2,
                base_url = $3,
                api_key = CASE WHEN $4 = '' THEN api_key ELSE $4 END,
                model_name = $5,
                member_token_limit = $6,
                priority = COALESCE($7, priority),
                updated_at = NOW()
             WHERE id = $8 AND team_id = $9",
        )
        .bind(config_name)
        .bind(protocol)
        .bind(&payload.base_url)
        .bind(&encrypted_key)
        .bind(&payload.model_name)
        .bind(member_token_limit)
        .bind(priority)
        .bind(config_id)
        .bind(team_id)
        .execute(&state.db)
        .await?;
    } else {
        let insert_priority = priority.unwrap_or(1000);
        sqlx::query(
            "INSERT INTO team_ai_configs (
                team_id, config_name, protocol, base_url, api_key, model_name, member_token_limit, priority, is_active
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)",
        )
        .bind(team_id)
        .bind(config_name)
        .bind(protocol)
        .bind(&payload.base_url)
        .bind(&encrypted_key)
        .bind(&payload.model_name)
        .bind(member_token_limit)
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

async fn get_team_ai_quota(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Query(query): Query<MonthQuery>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_admin(&state.db, team_id, user_id).await?;
    ensure_team_quota_tables(&state.db).await?;

    let month_key = normalize_month_key(query.month.as_deref())?;

    let monthly_limit_tokens: i64 = sqlx::query_scalar(
        "SELECT monthly_limit_tokens FROM team_ai_quota_policy WHERE team_id = $1",
    )
    .bind(team_id)
    .fetch_optional(&state.db)
    .await?
    .unwrap_or(0);

    let adjusted_members: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT FROM team_ai_member_quota_adjustments WHERE team_id = $1 AND month_key = $2",
    )
    .bind(team_id)
    .bind(&month_key)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "team_id": team_id,
        "month": month_key,
        "monthly_limit_tokens": monthly_limit_tokens,
        "adjusted_members": adjusted_members,
    })))
}

async fn set_team_ai_quota_policy(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Json(payload): Json<SetTeamAiQuotaPolicyRequest>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_admin(&state.db, team_id, user_id).await?;
    ensure_team_quota_tables(&state.db).await?;

    if payload.monthly_limit_tokens < 0 {
        return Err(Error::BadRequest("monthly_limit_tokens must be >= 0".into()));
    }

    let monthly_limit_tokens: i64 = sqlx::query_scalar(
        "INSERT INTO team_ai_quota_policy (team_id, monthly_limit_tokens, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (team_id) DO UPDATE
         SET monthly_limit_tokens = EXCLUDED.monthly_limit_tokens, updated_at = NOW()
         RETURNING monthly_limit_tokens",
    )
    .bind(team_id)
    .bind(payload.monthly_limit_tokens)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(serde_json::json!({
        "message": "Team AI quota policy updated",
        "team_id": team_id,
        "monthly_limit_tokens": monthly_limit_tokens,
    })))
}

async fn patch_team_member_ai_quota(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((team_id, target_user_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<PatchTeamMemberQuotaRequest>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_admin(&state.db, team_id, user_id).await?;
    ensure_team_quota_tables(&state.db).await?;

    let is_member: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2)",
    )
    .bind(team_id)
    .bind(target_user_id)
    .fetch_one(&state.db)
    .await?;
    if !is_member {
        return Err(Error::NotFound("Target user is not a team member".into()));
    }

    let month_key = normalize_month_key(payload.month.as_deref())?;

    let extra_tokens: i64 = sqlx::query_scalar(
        "INSERT INTO team_ai_member_quota_adjustments (
            team_id, user_id, month_key, extra_tokens, updated_by, updated_at
         ) VALUES ($1, $2, $3, GREATEST($4, 0), $5, NOW())
         ON CONFLICT (team_id, user_id, month_key) DO UPDATE
         SET
            extra_tokens = GREATEST(
                team_ai_member_quota_adjustments.extra_tokens + EXCLUDED.extra_tokens,
                0
            ),
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
         RETURNING extra_tokens",
    )
    .bind(team_id)
    .bind(target_user_id)
    .bind(&month_key)
    .bind(payload.extra_delta_tokens)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    let base_tokens: i64 = sqlx::query_scalar(
        "SELECT monthly_limit_tokens FROM team_ai_quota_policy WHERE team_id = $1",
    )
    .bind(team_id)
    .fetch_optional(&state.db)
    .await?
    .unwrap_or(0);

    let used_tokens: i64 = sqlx::query_scalar(
        "SELECT COALESCE(
            SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)),
            0
        )::BIGINT
         FROM team_ai_usage_logs
         WHERE team_id = $1
           AND user_id = $2
           AND created_at >= TO_DATE($3 || '-01', 'YYYY-MM-DD')
           AND created_at < (TO_DATE($3 || '-01', 'YYYY-MM-DD') + INTERVAL '1 month')",
    )
    .bind(team_id)
    .bind(target_user_id)
    .bind(&month_key)
    .fetch_one(&state.db)
    .await?;

    let effective_limit_tokens = base_tokens.saturating_add(extra_tokens);
    let remaining_tokens = if effective_limit_tokens <= 0 {
        None
    } else {
        Some((effective_limit_tokens - used_tokens).max(0))
    };

    Ok(Json(serde_json::json!({
        "message": "Team member AI quota updated",
        "team_id": team_id,
        "user_id": target_user_id,
        "month": month_key,
        "base_tokens": base_tokens,
        "extra_tokens": extra_tokens,
        "used_tokens": used_tokens,
        "effective_limit_tokens": effective_limit_tokens,
        "remaining_tokens": remaining_tokens,
    })))
}

async fn get_team_ai_quota_members(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Query(query): Query<MonthQuery>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_admin(&state.db, team_id, user_id).await?;
    ensure_team_quota_tables(&state.db).await?;

    let month_key = normalize_month_key(query.month.as_deref())?;
    let monthly_limit_tokens: i64 = sqlx::query_scalar(
        "SELECT monthly_limit_tokens FROM team_ai_quota_policy WHERE team_id = $1",
    )
    .bind(team_id)
    .fetch_optional(&state.db)
    .await?
    .unwrap_or(0);

    let rows = sqlx::query_as::<_, TeamQuotaMemberRow>(
        "SELECT
            tm.user_id,
            u.username,
            tm.role,
            COALESCE(usage.used_tokens, 0)::BIGINT AS used_tokens,
            COALESCE(adj.extra_tokens, 0) AS extra_tokens
         FROM team_members tm
         JOIN users u ON u.id = tm.user_id
         LEFT JOIN (
            SELECT
                user_id,
                COALESCE(
                    SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)),
                    0
                )::BIGINT AS used_tokens
            FROM team_ai_usage_logs
            WHERE team_id = $1
              AND created_at >= TO_DATE($2 || '-01', 'YYYY-MM-DD')
              AND created_at < (TO_DATE($2 || '-01', 'YYYY-MM-DD') + INTERVAL '1 month')
            GROUP BY user_id
         ) usage ON usage.user_id = tm.user_id
         LEFT JOIN team_ai_member_quota_adjustments adj
            ON adj.team_id = $1
           AND adj.user_id = tm.user_id
           AND adj.month_key = $2
         WHERE tm.team_id = $1
         ORDER BY COALESCE(usage.used_tokens, 0) DESC, u.username ASC",
    )
    .bind(team_id)
    .bind(&month_key)
    .fetch_all(&state.db)
    .await?;

    let members: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|row| {
            let effective_limit_tokens = monthly_limit_tokens.saturating_add(row.extra_tokens);
            let remaining_tokens = if effective_limit_tokens <= 0 {
                None
            } else {
                Some((effective_limit_tokens - row.used_tokens).max(0))
            };
            serde_json::json!({
                "user_id": row.user_id,
                "username": row.username,
                "role": row.role,
                "used_tokens": row.used_tokens,
                "base_tokens": monthly_limit_tokens,
                "extra_tokens": row.extra_tokens,
                "effective_limit_tokens": effective_limit_tokens,
                "remaining_tokens": remaining_tokens,
            })
        })
        .collect();

    Ok(Json(serde_json::json!({
        "team_id": team_id,
        "month": month_key,
        "monthly_limit_tokens": monthly_limit_tokens,
        "members": members,
    })))
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
    member_token_limit: i64,
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

#[derive(Debug, Deserialize)]
struct MonthQuery {
    month: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SetTeamAiQuotaPolicyRequest {
    monthly_limit_tokens: i64,
}

#[derive(Debug, Deserialize)]
struct PatchTeamMemberQuotaRequest {
    month: Option<String>,
    extra_delta_tokens: i64,
}

#[derive(Debug, sqlx::FromRow)]
struct TeamQuotaMemberRow {
    user_id: Uuid,
    username: String,
    role: String,
    used_tokens: i64,
    extra_tokens: i64,
}
