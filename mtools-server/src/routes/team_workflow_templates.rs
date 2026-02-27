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
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Arc;
use uuid::Uuid;

pub fn routes_no_layer() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/{id}/workflow-templates",
            get(list_templates).post(create_template),
        )
        .route(
            "/{id}/workflow-templates/{template_id}",
            get(get_template)
                .patch(update_template)
                .delete(delete_template),
        )
}

#[derive(Debug, Deserialize)]
struct CreateTemplateRequest {
    name: String,
    description: Option<String>,
    icon: Option<String>,
    category: Option<String>,
    workflow_json: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct UpdateTemplateRequest {
    name: Option<String>,
    description: Option<String>,
    icon: Option<String>,
    category: Option<String>,
    workflow_json: Option<serde_json::Value>,
}

#[derive(Debug, sqlx::FromRow)]
struct TemplateRow {
    id: Uuid,
    team_id: Uuid,
    name: String,
    description: Option<String>,
    icon: Option<String>,
    category: Option<String>,
    workflow_json: serde_json::Value,
    version: i64,
    created_by: Uuid,
    updated_by: Uuid,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize)]
struct TemplateSummary {
    id: String,
    team_id: Uuid,
    name: String,
    description: Option<String>,
    icon: Option<String>,
    category: Option<String>,
    version: i64,
    created_by: Uuid,
    updated_by: Uuid,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
    is_legacy: bool,
    legacy_resource_id: Option<String>,
    created_by_username: Option<String>,
}

#[derive(Debug, Serialize)]
struct TemplateDetail {
    id: Uuid,
    team_id: Uuid,
    name: String,
    description: Option<String>,
    icon: Option<String>,
    category: Option<String>,
    workflow_json: serde_json::Value,
    version: i64,
    created_by: Uuid,
    updated_by: Uuid,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
    is_legacy: bool,
}

#[derive(Debug, sqlx::FromRow)]
struct LegacyResourceRow {
    id: Uuid,
    resource_id: String,
    resource_name: Option<String>,
    user_id: Uuid,
    username: String,
    shared_at: chrono::DateTime<chrono::Utc>,
}

fn parse_user_id(claims: &Claims) -> Result<Uuid> {
    Uuid::parse_str(&claims.sub).map_err(|_| Error::BadRequest("Invalid user ID".into()))
}

fn row_is_legacy(row: &TemplateRow) -> bool {
    row.workflow_json
        .get("legacy")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

async fn ensure_template_editor(
    db: &sqlx::PgPool,
    team_id: Uuid,
    user_id: Uuid,
    template_creator_id: Uuid,
) -> Result<()> {
    if template_creator_id == user_id {
        return Ok(());
    }

    let role: Option<String> =
        sqlx::query_scalar("SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2")
            .bind(team_id)
            .bind(user_id)
            .fetch_optional(db)
            .await?;

    match role.as_deref() {
        Some("owner") | Some("admin") => Ok(()),
        Some(_) => Err(Error::api(
            http::StatusCode::FORBIDDEN,
            "TEAM_ADMIN_REQUIRED",
            "Admin or creator permission required",
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

async fn list_templates(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    entitlement::require_team_active(&state.db, team_id, user_id).await?;

    let rows = sqlx::query_as::<_, TemplateRow>(
        "SELECT
            id, team_id, name, description, icon, category, workflow_json, version,
            created_by, updated_by, created_at, updated_at
         FROM team_workflow_templates
         WHERE team_id = $1
         ORDER BY updated_at DESC",
    )
    .bind(team_id)
    .fetch_all(&state.db)
    .await?;

    let mut known_template_ids: HashSet<String> = HashSet::with_capacity(rows.len());
    let mut templates: Vec<TemplateSummary> = rows
        .iter()
        .map(|row| {
            known_template_ids.insert(row.id.to_string());
            TemplateSummary {
                id: row.id.to_string(),
                team_id: row.team_id,
                name: row.name.clone(),
                description: row.description.clone(),
                icon: row.icon.clone(),
                category: row.category.clone(),
                version: row.version,
                created_by: row.created_by,
                updated_by: row.updated_by,
                created_at: row.created_at,
                updated_at: row.updated_at,
                is_legacy: row_is_legacy(row),
                legacy_resource_id: row
                    .workflow_json
                    .get("source_resource_id")
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string()),
                created_by_username: None,
            }
        })
        .collect();

    let legacy_rows = sqlx::query_as::<_, LegacyResourceRow>(
        "SELECT
            sr.id, sr.resource_id, sr.resource_name, sr.user_id, u.username, sr.shared_at
         FROM team_shared_resources sr
         JOIN users u ON u.id = sr.user_id
         WHERE sr.team_id = $1
           AND sr.resource_type = 'workflow'
         ORDER BY sr.shared_at DESC",
    )
    .bind(team_id)
    .fetch_all(&state.db)
    .await?;

    for legacy in legacy_rows {
        if known_template_ids.contains(&legacy.resource_id) {
            continue;
        }

        templates.push(TemplateSummary {
            id: format!("legacy-{}", legacy.id),
            team_id,
            name: legacy
                .resource_name
                .unwrap_or_else(|| "团队模板（legacy）".to_string()),
            description: Some("历史分享记录，缺少可导入正文，请重新分享".to_string()),
            icon: Some("📋".to_string()),
            category: Some("legacy".to_string()),
            version: 0,
            created_by: legacy.user_id,
            updated_by: legacy.user_id,
            created_at: legacy.shared_at,
            updated_at: legacy.shared_at,
            is_legacy: true,
            legacy_resource_id: Some(legacy.resource_id),
            created_by_username: Some(legacy.username),
        });
    }

    Ok(Json(serde_json::json!({ "templates": templates })))
}

async fn create_template(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Json(payload): Json<CreateTemplateRequest>,
) -> Result<Json<TemplateDetail>> {
    let user_id = parse_user_id(&claims)?;
    entitlement::require_team_active(&state.db, team_id, user_id).await?;

    if payload.name.trim().is_empty() {
        return Err(Error::BadRequest("name is required".into()));
    }

    let row = sqlx::query_as::<_, TemplateRow>(
        "INSERT INTO team_workflow_templates (
            team_id, name, description, icon, category, workflow_json, version,
            created_by, updated_by, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $7, NOW(), NOW())
         RETURNING
            id, team_id, name, description, icon, category, workflow_json, version,
            created_by, updated_by, created_at, updated_at",
    )
    .bind(team_id)
    .bind(payload.name.trim())
    .bind(payload.description.as_deref())
    .bind(payload.icon.as_deref())
    .bind(payload.category.as_deref())
    .bind(&payload.workflow_json)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;
    let is_legacy = row_is_legacy(&row);

    let _ = sqlx::query(
        "INSERT INTO team_shared_resources (team_id, user_id, resource_type, resource_id, resource_name)
         VALUES ($1, $2, 'workflow', $3, $4)
         ON CONFLICT (team_id, resource_type, resource_id) DO NOTHING",
    )
    .bind(team_id)
    .bind(user_id)
    .bind(row.id.to_string())
    .bind(&row.name)
    .execute(&state.db)
    .await;

    Ok(Json(TemplateDetail {
        id: row.id,
        team_id: row.team_id,
        name: row.name,
        description: row.description,
        icon: row.icon,
        category: row.category,
        workflow_json: row.workflow_json,
        version: row.version,
        created_by: row.created_by,
        updated_by: row.updated_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        is_legacy,
    }))
}

async fn get_template(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((team_id, template_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<TemplateDetail>> {
    let user_id = parse_user_id(&claims)?;
    entitlement::require_team_active(&state.db, team_id, user_id).await?;

    let row = sqlx::query_as::<_, TemplateRow>(
        "SELECT
            id, team_id, name, description, icon, category, workflow_json, version,
            created_by, updated_by, created_at, updated_at
         FROM team_workflow_templates
         WHERE id = $1 AND team_id = $2",
    )
    .bind(template_id)
    .bind(team_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        Error::not_found_code(
            "TEAM_WORKFLOW_TEMPLATE_NOT_FOUND",
            "Team workflow template not found",
            Some(serde_json::json!({ "team_id": team_id, "template_id": template_id })),
        )
    })?;
    let is_legacy = row_is_legacy(&row);

    Ok(Json(TemplateDetail {
        id: row.id,
        team_id: row.team_id,
        name: row.name,
        description: row.description,
        icon: row.icon,
        category: row.category,
        workflow_json: row.workflow_json,
        version: row.version,
        created_by: row.created_by,
        updated_by: row.updated_by,
        created_at: row.created_at,
        updated_at: row.updated_at,
        is_legacy,
    }))
}

async fn update_template(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((team_id, template_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<UpdateTemplateRequest>,
) -> Result<Json<TemplateDetail>> {
    let user_id = parse_user_id(&claims)?;
    entitlement::require_team_active(&state.db, team_id, user_id).await?;

    let existing = sqlx::query_as::<_, TemplateRow>(
        "SELECT
            id, team_id, name, description, icon, category, workflow_json, version,
            created_by, updated_by, created_at, updated_at
         FROM team_workflow_templates
         WHERE id = $1 AND team_id = $2",
    )
    .bind(template_id)
    .bind(team_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        Error::not_found_code(
            "TEAM_WORKFLOW_TEMPLATE_NOT_FOUND",
            "Team workflow template not found",
            Some(serde_json::json!({ "team_id": team_id, "template_id": template_id })),
        )
    })?;

    ensure_template_editor(&state.db, team_id, user_id, existing.created_by).await?;

    let next_name = payload
        .name
        .as_ref()
        .map(|v| v.trim().to_string())
        .unwrap_or_else(|| existing.name.clone());
    if next_name.is_empty() {
        return Err(Error::BadRequest("name is required".into()));
    }

    let updated = sqlx::query_as::<_, TemplateRow>(
        "UPDATE team_workflow_templates
         SET
            name = $1,
            description = COALESCE($2, description),
            icon = COALESCE($3, icon),
            category = COALESCE($4, category),
            workflow_json = COALESCE($5, workflow_json),
            version = version + 1,
            updated_by = $6,
            updated_at = NOW()
         WHERE id = $7 AND team_id = $8
         RETURNING
            id, team_id, name, description, icon, category, workflow_json, version,
            created_by, updated_by, created_at, updated_at",
    )
    .bind(next_name)
    .bind(payload.description.as_deref())
    .bind(payload.icon.as_deref())
    .bind(payload.category.as_deref())
    .bind(payload.workflow_json.as_ref())
    .bind(user_id)
    .bind(template_id)
    .bind(team_id)
    .fetch_one(&state.db)
    .await?;
    let is_legacy = row_is_legacy(&updated);

    let _ = sqlx::query(
        "UPDATE team_shared_resources
         SET resource_name = $1
         WHERE team_id = $2 AND resource_type = 'workflow' AND resource_id = $3",
    )
    .bind(&updated.name)
    .bind(team_id)
    .bind(template_id.to_string())
    .execute(&state.db)
    .await;

    Ok(Json(TemplateDetail {
        id: updated.id,
        team_id: updated.team_id,
        name: updated.name,
        description: updated.description,
        icon: updated.icon,
        category: updated.category,
        workflow_json: updated.workflow_json,
        version: updated.version,
        created_by: updated.created_by,
        updated_by: updated.updated_by,
        created_at: updated.created_at,
        updated_at: updated.updated_at,
        is_legacy,
    }))
}

async fn delete_template(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((team_id, template_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    entitlement::require_team_active(&state.db, team_id, user_id).await?;

    let existing = sqlx::query_as::<_, TemplateRow>(
        "SELECT
            id, team_id, name, description, icon, category, workflow_json, version,
            created_by, updated_by, created_at, updated_at
         FROM team_workflow_templates
         WHERE id = $1 AND team_id = $2",
    )
    .bind(template_id)
    .bind(team_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        Error::not_found_code(
            "TEAM_WORKFLOW_TEMPLATE_NOT_FOUND",
            "Team workflow template not found",
            Some(serde_json::json!({ "team_id": team_id, "template_id": template_id })),
        )
    })?;

    ensure_template_editor(&state.db, team_id, user_id, existing.created_by).await?;

    sqlx::query("DELETE FROM team_workflow_templates WHERE id = $1 AND team_id = $2")
        .bind(template_id)
        .bind(team_id)
        .execute(&state.db)
        .await?;

    let _ = sqlx::query(
        "DELETE FROM team_shared_resources
         WHERE team_id = $1 AND resource_type = 'workflow' AND resource_id = $2",
    )
    .bind(team_id)
    .bind(template_id.to_string())
    .execute(&state.db)
    .await;

    Ok(Json(serde_json::json!({ "message": "Template deleted" })))
}
