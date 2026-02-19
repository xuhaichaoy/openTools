use axum::{
    extract::{Extension, Path, Query, State},
    routing::{get, patch, put},
    Json, Router,
};
use serde::Deserialize;
use std::sync::Arc;
use uuid::Uuid;

use crate::{
    routes::{team_quota_common, AppState},
    services::{auth::Claims, entitlement},
    Error, Result,
};

pub fn quota_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/{id}/ai-quota", get(get_team_ai_quota))
        .route("/{id}/ai-quota/policy", put(set_team_ai_quota_policy))
        .route(
            "/{id}/ai-quota/member/{uid}",
            patch(patch_team_member_ai_quota),
        )
        .route("/{id}/ai-quota/members", get(get_team_ai_quota_members))
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

fn parse_user_id(claims: &Claims) -> Result<Uuid> {
    Uuid::parse_str(&claims.sub).map_err(|_| Error::BadRequest("Invalid user ID".into()))
}

async fn check_admin(db: &sqlx::PgPool, team_id: Uuid, user_id: Uuid) -> Result<()> {
    entitlement::require_team_active(db, team_id, user_id).await?;

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

async fn get_team_ai_quota(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Query(query): Query<MonthQuery>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    check_admin(&state.db, team_id, user_id).await?;

    let month_key = team_quota_common::resolve_month_key(&state.db, query.month.as_deref()).await?;

    let monthly_limit_tokens: i64 = sqlx::query_scalar(
        "SELECT COALESCE(monthly_limit_tokens::BIGINT, 0)::BIGINT
         FROM team_ai_quota_policy
         WHERE team_id = $1",
    )
    .bind(team_id)
    .fetch_optional(&state.db)
    .await?
    .unwrap_or(0);

    let adjusted_members: i64 = sqlx::query_scalar(
        "SELECT COUNT(*)::BIGINT
         FROM team_ai_member_quota_adjustments
         WHERE team_id = $1 AND month_key = $2",
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

    if payload.monthly_limit_tokens < 0 {
        return Err(Error::BadRequest(
            "monthly_limit_tokens must be >= 0".into(),
        ));
    }

    let monthly_limit_tokens: i64 = sqlx::query_scalar(
        "INSERT INTO team_ai_quota_policy (team_id, monthly_limit_tokens, updated_at)
         VALUES ($1, $2::BIGINT, NOW())
         ON CONFLICT (team_id) DO UPDATE
         SET monthly_limit_tokens = EXCLUDED.monthly_limit_tokens, updated_at = NOW()
         RETURNING monthly_limit_tokens::BIGINT",
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

    let month_key =
        team_quota_common::resolve_month_key(&state.db, payload.month.as_deref()).await?;
    let (month_start, month_end) = team_quota_common::month_range_utc(&month_key)?;

    let extra_tokens: i64 = sqlx::query_scalar(
        "INSERT INTO team_ai_member_quota_adjustments (
            team_id, user_id, month_key, extra_tokens, updated_by, updated_at
         ) VALUES ($1, $2, $3, GREATEST($4::BIGINT, 0), $5, NOW())
         ON CONFLICT (team_id, user_id, month_key) DO UPDATE
         SET
            extra_tokens = GREATEST(
                team_ai_member_quota_adjustments.extra_tokens::BIGINT + EXCLUDED.extra_tokens::BIGINT,
                0
            ),
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
         RETURNING extra_tokens::BIGINT",
    )
    .bind(team_id)
    .bind(target_user_id)
    .bind(&month_key)
    .bind(payload.extra_delta_tokens)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    let base_tokens: i64 = sqlx::query_scalar(
        "SELECT COALESCE(monthly_limit_tokens::BIGINT, 0)::BIGINT
         FROM team_ai_quota_policy
         WHERE team_id = $1",
    )
    .bind(team_id)
    .fetch_optional(&state.db)
    .await?
    .unwrap_or(0);

    let used_tokens: i64 = sqlx::query_scalar(
        "SELECT COALESCE(
            SUM(COALESCE(prompt_tokens, 0)::BIGINT + COALESCE(completion_tokens, 0)::BIGINT),
            0
        )::BIGINT
         FROM team_ai_usage_logs
         WHERE team_id = $1
           AND user_id = $2
           AND created_at >= $3
           AND created_at < $4",
    )
    .bind(team_id)
    .bind(target_user_id)
    .bind(month_start)
    .bind(month_end)
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

    let month_key = team_quota_common::resolve_month_key(&state.db, query.month.as_deref()).await?;
    let (month_start, month_end) = team_quota_common::month_range_utc(&month_key)?;

    let monthly_limit_tokens: i64 = sqlx::query_scalar(
        "SELECT COALESCE(monthly_limit_tokens::BIGINT, 0)::BIGINT
         FROM team_ai_quota_policy
         WHERE team_id = $1",
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
            COALESCE(adj.extra_tokens::BIGINT, 0)::BIGINT AS extra_tokens
         FROM team_members tm
         JOIN users u ON u.id = tm.user_id
         LEFT JOIN (
            SELECT
                user_id,
                COALESCE(
                    SUM(COALESCE(prompt_tokens, 0)::BIGINT + COALESCE(completion_tokens, 0)::BIGINT),
                    0
                )::BIGINT AS used_tokens
            FROM team_ai_usage_logs
            WHERE team_id = $1
              AND created_at >= $2
              AND created_at < $3
            GROUP BY user_id
         ) usage ON usage.user_id = tm.user_id
         LEFT JOIN team_ai_member_quota_adjustments adj
            ON adj.team_id = $1
           AND adj.user_id = tm.user_id
           AND adj.month_key = $4
         WHERE tm.team_id = $1
         ORDER BY COALESCE(usage.used_tokens, 0) DESC, u.username ASC",
    )
    .bind(team_id)
    .bind(month_start)
    .bind(month_end)
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
