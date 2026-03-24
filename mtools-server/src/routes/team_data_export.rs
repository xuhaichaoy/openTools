use crate::{
    crypto,
    routes::AppState,
    services::{auth::Claims, entitlement},
    Error, Result,
};
use axum::{
    extract::{Extension, Path, State},
    routing::{get, post},
    Json, Router,
};
use http::StatusCode;
use mongodb::{
    bson::{doc, Bson, Document},
    options::ClientOptions,
    Client as MongoClient,
};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use sqlx::{
    mysql::{MySqlPool, MySqlPoolOptions, MySqlRow},
    postgres::{PgPool, PgPoolOptions, PgRow},
    Column, Executor, Row, TypeInfo, ValueRef,
};
use std::{
    collections::{BTreeSet, HashMap},
    fs::File,
    io::{BufWriter, Write},
    path::{Path as FsPath, PathBuf},
    sync::Arc,
};
use uuid::Uuid;

const DEFAULT_PREVIEW_LIMIT: u64 = 50;
const DEFAULT_EXPORT_LIMIT: u64 = 10_000;
const PREVIEW_TTL_MINUTES: i64 = 30;
const EXTERNAL_DB_MAX_CONNECTIONS: u32 = 3;

pub fn routes_no_layer() -> Router<Arc<AppState>> {
    Router::new()
        .route(
            "/{id}/data-sources",
            get(list_team_data_sources).put(save_team_data_source),
        )
        .route(
            "/{id}/data-sources/{source_id}",
            axum::routing::patch(patch_team_data_source).delete(delete_team_data_source),
        )
        .route(
            "/{id}/export-datasets",
            get(list_team_export_datasets).put(save_team_export_dataset),
        )
        .route(
            "/{id}/export-datasets/{dataset_id}",
            axum::routing::patch(patch_team_export_dataset).delete(delete_team_export_dataset),
        )
        .route("/{id}/data-export/preview", post(preview_team_data_export))
        .route("/{id}/data-export/confirm", post(confirm_team_data_export))
}

#[allow(dead_code)]
#[derive(Debug, Clone, sqlx::FromRow)]
struct TeamDataSourceRow {
    id: Uuid,
    team_id: Uuid,
    name: String,
    db_type: String,
    host: Option<String>,
    port: Option<i32>,
    database_name: Option<String>,
    username_encrypted: Option<String>,
    password_encrypted: Option<String>,
    connection_string_encrypted: Option<String>,
    export_alias: Option<String>,
    export_default_schema: Option<String>,
    max_export_rows: i64,
    enabled: bool,
    created_by: Uuid,
    updated_by: Uuid,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize)]
struct TeamDataSourceSummary {
    id: Uuid,
    name: String,
    db_type: String,
    host: Option<String>,
    port: Option<i32>,
    database: Option<String>,
    export_alias: Option<String>,
    export_default_schema: Option<String>,
    max_export_rows: Option<i64>,
    enabled: bool,
    has_password: bool,
    masked_username: Option<String>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Deserialize)]
struct TeamDataSourceUpsertRequest {
    id: Option<Uuid>,
    name: String,
    db_type: String,
    host: Option<String>,
    port: Option<i32>,
    database: Option<String>,
    username: Option<String>,
    password: Option<String>,
    connection_string: Option<String>,
    export_alias: Option<String>,
    export_default_schema: Option<String>,
    max_export_rows: Option<i64>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct TeamDataSourcePatchRequest {
    name: Option<String>,
    db_type: Option<String>,
    host: Option<String>,
    port: Option<i32>,
    database: Option<String>,
    username: Option<String>,
    password: Option<String>,
    connection_string: Option<String>,
    export_alias: Option<String>,
    export_default_schema: Option<String>,
    max_export_rows: Option<i64>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportDatasetFieldDefinition {
    name: String,
    label: String,
    data_type: Option<String>,
    nullable: Option<bool>,
    primary_key: Option<bool>,
    aliases: Option<Vec<String>>,
    #[serde(default = "default_enabled")]
    enabled: bool,
}

#[allow(dead_code)]
#[derive(Debug, Clone, sqlx::FromRow)]
struct TeamExportDatasetRow {
    id: Uuid,
    team_id: Uuid,
    source_id: Uuid,
    display_name: String,
    description: Option<String>,
    entity_name: String,
    entity_type: String,
    schema_name: Option<String>,
    time_field: Option<String>,
    default_fields_json: serde_json::Value,
    fields_json: serde_json::Value,
    enabled: bool,
    created_by: Uuid,
    updated_by: Uuid,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Serialize)]
struct TeamExportDatasetSummary {
    id: Uuid,
    display_name: String,
    description: Option<String>,
    source_id: Uuid,
    entity_name: String,
    entity_type: String,
    schema: Option<String>,
    time_field: Option<String>,
    default_fields: Vec<String>,
    fields: Vec<ExportDatasetFieldDefinition>,
    enabled: bool,
    updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Deserialize)]
struct TeamExportDatasetUpsertRequest {
    id: Option<Uuid>,
    display_name: String,
    description: Option<String>,
    source_id: Uuid,
    entity_name: String,
    entity_type: String,
    schema: Option<String>,
    time_field: Option<String>,
    default_fields: Option<Vec<String>>,
    fields: Option<Vec<ExportDatasetFieldDefinition>>,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
struct TeamExportDatasetPatchRequest {
    display_name: Option<String>,
    description: Option<String>,
    source_id: Option<Uuid>,
    entity_name: Option<String>,
    entity_type: Option<String>,
    schema: Option<String>,
    time_field: Option<String>,
    default_fields: Option<Vec<String>>,
    fields: Option<Vec<ExportDatasetFieldDefinition>>,
    enabled: Option<bool>,
}

#[allow(dead_code)]
#[derive(Debug, Clone, sqlx::FromRow)]
struct TeamDataExportPreviewRow {
    preview_token: String,
    team_id: Uuid,
    user_id: Uuid,
    source_id: Uuid,
    dataset_id: Uuid,
    intent_json: serde_json::Value,
    source_kind: String,
    canonical_query: String,
    created_at: chrono::DateTime<chrono::Utc>,
    expires_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreviewTeamDataExportRequest {
    intent: StructuredExportIntent,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfirmTeamDataExportRequest {
    preview_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StructuredExportIntent {
    source_id: String,
    source_scope: Option<String>,
    team_id: Option<String>,
    dataset_id: Option<String>,
    entity_name: String,
    entity_type: Option<String>,
    schema: Option<String>,
    fields: Option<Vec<String>>,
    filters: Option<Vec<ExportFilter>>,
    sort: Option<Vec<ExportSort>>,
    limit: Option<u64>,
    output_format: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportFilter {
    field: String,
    op: String,
    value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportSort {
    field: String,
    direction: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedTeamExportIntent {
    source_id: Uuid,
    dataset_id: Uuid,
    entity_name: String,
    entity_type: String,
    schema: Option<String>,
    fields: Option<Vec<String>>,
    filters: Vec<ExportFilter>,
    sort: Vec<ExportSort>,
    limit: u64,
    output_format: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportPreviewResponse {
    preview_token: String,
    source_kind: String,
    canonical_query: String,
    columns: Vec<String>,
    rows: Vec<HashMap<String, serde_json::Value>>,
    preview_row_count: usize,
    estimated_total: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TeamExportExecutionResult {
    preview_token: String,
    row_count: usize,
    columns: Vec<String>,
    download_url: String,
    file_name: String,
}

#[derive(Debug, Clone)]
struct TeamDataSourceDraft {
    id: Uuid,
    name: String,
    db_type: String,
    host: Option<String>,
    port: Option<i32>,
    database: Option<String>,
    username: Option<String>,
    password: Option<String>,
    connection_string: Option<String>,
    export_alias: Option<String>,
    export_default_schema: Option<String>,
    max_export_rows: i64,
    enabled: bool,
}

#[derive(Debug, Clone)]
struct TeamExportDatasetDraft {
    id: Uuid,
    display_name: String,
    description: Option<String>,
    source_id: Uuid,
    entity_name: String,
    entity_type: String,
    schema: Option<String>,
    time_field: Option<String>,
    default_fields: Vec<String>,
    fields: Vec<ExportDatasetFieldDefinition>,
    enabled: bool,
}

#[derive(Debug, Clone)]
enum ExternalDbConnection {
    Postgres(PgPool),
    MySql(MySqlPool),
    Mongo(MongoConnection),
}

#[derive(Debug, Clone)]
struct MongoConnection {
    client: MongoClient,
    database_name: String,
}

async fn list_team_data_sources(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
) -> Result<Json<Vec<TeamDataSourceSummary>>> {
    let user_id = parse_user_id(&claims)?;
    entitlement::require_team_active(&state.db, team_id, user_id).await?;

    let rows = sqlx::query_as::<_, TeamDataSourceRow>(
        "SELECT
            id, team_id, name, db_type, host, port, database_name,
            username_encrypted, password_encrypted, connection_string_encrypted,
            export_alias, export_default_schema, max_export_rows, enabled,
            created_by, updated_by, created_at, updated_at
         FROM team_data_sources
         WHERE team_id = $1
         ORDER BY updated_at DESC",
    )
    .bind(team_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(
        rows.into_iter().map(to_team_data_source_summary).collect(),
    ))
}

async fn save_team_data_source(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Json(payload): Json<TeamDataSourceUpsertRequest>,
) -> Result<Json<TeamDataSourceSummary>> {
    let user_id = parse_user_id(&claims)?;
    ensure_team_admin_active(&state.db, team_id, user_id).await?;

    let existing = match payload.id {
        Some(source_id) => fetch_team_data_source(&state.db, team_id, source_id).await?,
        None => None,
    };

    let mut draft = existing
        .as_ref()
        .map(source_row_to_draft)
        .unwrap_or_else(|| TeamDataSourceDraft {
            id: payload.id.unwrap_or_else(Uuid::new_v4),
            name: String::new(),
            db_type: String::new(),
            host: None,
            port: None,
            database: None,
            username: None,
            password: None,
            connection_string: None,
            export_alias: None,
            export_default_schema: None,
            max_export_rows: DEFAULT_EXPORT_LIMIT as i64,
            enabled: true,
        });

    draft.name = payload.name;
    draft.db_type = payload.db_type;
    apply_optional_text(&mut draft.host, payload.host);
    if let Some(port) = payload.port {
        draft.port = Some(port);
    }
    apply_optional_text(&mut draft.database, payload.database);
    apply_optional_text(&mut draft.username, payload.username);
    apply_optional_text(&mut draft.password, payload.password);
    apply_optional_text(&mut draft.connection_string, payload.connection_string);
    apply_optional_text(&mut draft.export_alias, payload.export_alias);
    apply_optional_text(
        &mut draft.export_default_schema,
        payload.export_default_schema,
    );
    if let Some(max_export_rows) = payload.max_export_rows {
        draft.max_export_rows = max_export_rows;
    }
    if let Some(enabled) = payload.enabled {
        draft.enabled = enabled;
    }

    normalize_team_data_source_draft(&mut draft)?;

    if draft.enabled
        && existing
            .as_ref()
            .map_or(true, |row| source_connection_changed(row, &draft))
    {
        test_team_data_source_connection(&draft).await?;
    }

    let row = upsert_team_data_source_row(&state.db, team_id, user_id, existing, draft).await?;
    Ok(Json(to_team_data_source_summary(row)))
}

async fn patch_team_data_source(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((team_id, source_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<TeamDataSourcePatchRequest>,
) -> Result<Json<TeamDataSourceSummary>> {
    let user_id = parse_user_id(&claims)?;
    ensure_team_admin_active(&state.db, team_id, user_id).await?;

    let existing = fetch_team_data_source(&state.db, team_id, source_id)
        .await?
        .ok_or_else(|| {
            Error::not_found_code(
                "TEAM_DATA_SOURCE_NOT_FOUND",
                "Team data source not found",
                Some(serde_json::json!({ "team_id": team_id, "source_id": source_id })),
            )
        })?;

    let mut draft = source_row_to_draft(&existing);
    if let Some(name) = payload.name {
        draft.name = name;
    }
    if let Some(db_type) = payload.db_type {
        draft.db_type = db_type;
    }
    apply_optional_text(&mut draft.host, payload.host);
    if let Some(port) = payload.port {
        draft.port = Some(port);
    }
    apply_optional_text(&mut draft.database, payload.database);
    apply_optional_text(&mut draft.username, payload.username);
    apply_optional_text(&mut draft.password, payload.password);
    apply_optional_text(&mut draft.connection_string, payload.connection_string);
    apply_optional_text(&mut draft.export_alias, payload.export_alias);
    apply_optional_text(
        &mut draft.export_default_schema,
        payload.export_default_schema,
    );
    if let Some(max_export_rows) = payload.max_export_rows {
        draft.max_export_rows = max_export_rows;
    }
    if let Some(enabled) = payload.enabled {
        draft.enabled = enabled;
    }

    normalize_team_data_source_draft(&mut draft)?;

    if draft.enabled && source_connection_changed(&existing, &draft) {
        test_team_data_source_connection(&draft).await?;
    }

    let row =
        upsert_team_data_source_row(&state.db, team_id, user_id, Some(existing), draft).await?;
    Ok(Json(to_team_data_source_summary(row)))
}

async fn delete_team_data_source(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((team_id, source_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    ensure_team_admin_active(&state.db, team_id, user_id).await?;

    let deleted = sqlx::query("DELETE FROM team_data_sources WHERE team_id = $1 AND id = $2")
        .bind(team_id)
        .bind(source_id)
        .execute(&state.db)
        .await?;

    if deleted.rows_affected() == 0 {
        return Err(Error::not_found_code(
            "TEAM_DATA_SOURCE_NOT_FOUND",
            "Team data source not found",
            Some(serde_json::json!({ "team_id": team_id, "source_id": source_id })),
        ));
    }

    Ok(Json(
        serde_json::json!({ "message": "Team data source deleted" }),
    ))
}

async fn list_team_export_datasets(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
) -> Result<Json<Vec<TeamExportDatasetSummary>>> {
    let user_id = parse_user_id(&claims)?;
    entitlement::require_team_active(&state.db, team_id, user_id).await?;

    let rows = sqlx::query_as::<_, TeamExportDatasetRow>(
        "SELECT
            id, team_id, source_id, display_name, description, entity_name, entity_type,
            schema_name, time_field, default_fields_json, fields_json, enabled,
            created_by, updated_by, created_at, updated_at
         FROM team_export_datasets
         WHERE team_id = $1
         ORDER BY updated_at DESC",
    )
    .bind(team_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(
        rows.into_iter()
            .map(to_team_export_dataset_summary)
            .collect(),
    ))
}

async fn save_team_export_dataset(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Json(payload): Json<TeamExportDatasetUpsertRequest>,
) -> Result<Json<TeamExportDatasetSummary>> {
    let user_id = parse_user_id(&claims)?;
    ensure_team_admin_active(&state.db, team_id, user_id).await?;

    let existing = match payload.id {
        Some(dataset_id) => fetch_team_export_dataset(&state.db, team_id, dataset_id).await?,
        None => None,
    };

    let mut draft = existing
        .as_ref()
        .map(dataset_row_to_draft)
        .unwrap_or_else(|| TeamExportDatasetDraft {
            id: payload.id.unwrap_or_else(Uuid::new_v4),
            display_name: String::new(),
            description: None,
            source_id: payload.source_id,
            entity_name: String::new(),
            entity_type: String::new(),
            schema: None,
            time_field: None,
            default_fields: Vec::new(),
            fields: Vec::new(),
            enabled: true,
        });

    draft.display_name = payload.display_name;
    draft.description = clean_optional_text(payload.description);
    draft.source_id = payload.source_id;
    draft.entity_name = payload.entity_name;
    draft.entity_type = payload.entity_type;
    draft.schema = clean_optional_text(payload.schema);
    draft.time_field = clean_optional_text(payload.time_field);
    if let Some(default_fields) = payload.default_fields {
        draft.default_fields = default_fields;
    }
    if let Some(fields) = payload.fields {
        draft.fields = fields;
    }
    if let Some(enabled) = payload.enabled {
        draft.enabled = enabled;
    }

    let source = fetch_team_data_source_required(&state.db, team_id, draft.source_id).await?;
    normalize_team_export_dataset_draft(&mut draft, &source)?;

    let row = upsert_team_export_dataset_row(&state.db, team_id, user_id, existing, draft).await?;
    Ok(Json(to_team_export_dataset_summary(row)))
}

async fn patch_team_export_dataset(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((team_id, dataset_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<TeamExportDatasetPatchRequest>,
) -> Result<Json<TeamExportDatasetSummary>> {
    let user_id = parse_user_id(&claims)?;
    ensure_team_admin_active(&state.db, team_id, user_id).await?;

    let existing = fetch_team_export_dataset(&state.db, team_id, dataset_id)
        .await?
        .ok_or_else(|| {
            Error::not_found_code(
                "TEAM_EXPORT_DATASET_NOT_FOUND",
                "Team export dataset not found",
                Some(serde_json::json!({ "team_id": team_id, "dataset_id": dataset_id })),
            )
        })?;

    let mut draft = dataset_row_to_draft(&existing);
    if let Some(display_name) = payload.display_name {
        draft.display_name = display_name;
    }
    if payload.description.is_some() {
        draft.description = clean_optional_text(payload.description);
    }
    if let Some(source_id) = payload.source_id {
        draft.source_id = source_id;
    }
    if let Some(entity_name) = payload.entity_name {
        draft.entity_name = entity_name;
    }
    if let Some(entity_type) = payload.entity_type {
        draft.entity_type = entity_type;
    }
    if payload.schema.is_some() {
        draft.schema = clean_optional_text(payload.schema);
    }
    if payload.time_field.is_some() {
        draft.time_field = clean_optional_text(payload.time_field);
    }
    if let Some(default_fields) = payload.default_fields {
        draft.default_fields = default_fields;
    }
    if let Some(fields) = payload.fields {
        draft.fields = fields;
    }
    if let Some(enabled) = payload.enabled {
        draft.enabled = enabled;
    }

    let source = fetch_team_data_source_required(&state.db, team_id, draft.source_id).await?;
    normalize_team_export_dataset_draft(&mut draft, &source)?;

    let row =
        upsert_team_export_dataset_row(&state.db, team_id, user_id, Some(existing), draft).await?;
    Ok(Json(to_team_export_dataset_summary(row)))
}

async fn delete_team_export_dataset(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((team_id, dataset_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>> {
    let user_id = parse_user_id(&claims)?;
    ensure_team_admin_active(&state.db, team_id, user_id).await?;

    let deleted = sqlx::query("DELETE FROM team_export_datasets WHERE team_id = $1 AND id = $2")
        .bind(team_id)
        .bind(dataset_id)
        .execute(&state.db)
        .await?;

    if deleted.rows_affected() == 0 {
        return Err(Error::not_found_code(
            "TEAM_EXPORT_DATASET_NOT_FOUND",
            "Team export dataset not found",
            Some(serde_json::json!({ "team_id": team_id, "dataset_id": dataset_id })),
        ));
    }

    Ok(Json(
        serde_json::json!({ "message": "Team export dataset deleted" }),
    ))
}

async fn preview_team_data_export(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Json(payload): Json<PreviewTeamDataExportRequest>,
) -> Result<Json<ExportPreviewResponse>> {
    let user_id = parse_user_id(&claims)?;
    entitlement::require_team_active(&state.db, team_id, user_id).await?;
    cleanup_expired_previews(&state.db).await?;

    let (source, dataset, resolved_intent) =
        resolve_team_export_request(&state.db, team_id, payload.intent).await?;
    if !source.enabled {
        return Err(Error::bad_request_code(
            "TEAM_DATA_SOURCE_DISABLED",
            "The selected team data source is disabled",
            Some(serde_json::json!({ "team_id": team_id, "source_id": source.id })),
        ));
    }
    if !dataset.enabled {
        return Err(Error::bad_request_code(
            "TEAM_EXPORT_DATASET_DISABLED",
            "The selected team export dataset is disabled",
            Some(serde_json::json!({ "team_id": team_id, "dataset_id": dataset.id })),
        ));
    }

    let (source_kind, canonical_query, columns, rows) =
        execute_resolved_export(&source, &resolved_intent, true).await?;
    let preview_token = Uuid::new_v4().to_string();
    let expires_at = chrono::Utc::now() + chrono::Duration::minutes(PREVIEW_TTL_MINUTES);

    sqlx::query(
        "INSERT INTO team_data_export_previews (
            preview_token, team_id, user_id, source_id, dataset_id,
            intent_json, source_kind, canonical_query, created_at, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)",
    )
    .bind(&preview_token)
    .bind(team_id)
    .bind(user_id)
    .bind(source.id)
    .bind(dataset.id)
    .bind(serde_json::to_value(&resolved_intent).map_err(|error| Error::Internal(error.into()))?)
    .bind(&source_kind)
    .bind(&canonical_query)
    .bind(expires_at)
    .execute(&state.db)
    .await?;

    Ok(Json(ExportPreviewResponse {
        preview_token,
        source_kind,
        canonical_query,
        columns: columns.clone(),
        rows: build_row_maps(&columns, &rows),
        preview_row_count: rows.len(),
        estimated_total: Some(rows.len() as u64),
    }))
}

async fn confirm_team_data_export(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Json(payload): Json<ConfirmTeamDataExportRequest>,
) -> Result<Json<TeamExportExecutionResult>> {
    let user_id = parse_user_id(&claims)?;
    entitlement::require_team_active(&state.db, team_id, user_id).await?;
    cleanup_expired_previews(&state.db).await?;

    let preview = sqlx::query_as::<_, TeamDataExportPreviewRow>(
        "SELECT
            preview_token, team_id, user_id, source_id, dataset_id,
            intent_json, source_kind, canonical_query, created_at, expires_at
         FROM team_data_export_previews
         WHERE preview_token = $1
           AND team_id = $2
           AND user_id = $3
           AND expires_at > NOW()",
    )
    .bind(payload.preview_token.trim())
    .bind(team_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        Error::not_found_code(
            "TEAM_EXPORT_PREVIEW_NOT_FOUND",
            "Team export preview not found or expired",
            Some(serde_json::json!({ "team_id": team_id })),
        )
    })?;

    let source = fetch_team_data_source_required(&state.db, team_id, preview.source_id).await?;
    let dataset =
        fetch_team_export_dataset_required(&state.db, team_id, preview.dataset_id).await?;
    if !source.enabled {
        return Err(Error::bad_request_code(
            "TEAM_DATA_SOURCE_DISABLED",
            "The selected team data source is disabled",
            Some(serde_json::json!({ "team_id": team_id, "source_id": source.id })),
        ));
    }
    if !dataset.enabled {
        return Err(Error::bad_request_code(
            "TEAM_EXPORT_DATASET_DISABLED",
            "The selected team export dataset is disabled",
            Some(serde_json::json!({ "team_id": team_id, "dataset_id": dataset.id })),
        ));
    }

    let resolved_intent: ResolvedTeamExportIntent =
        serde_json::from_value(preview.intent_json.clone()).map_err(|error| {
            Error::Internal(anyhow::anyhow!(
                "Failed to deserialize stored team export preview: {}",
                error
            ))
        })?;

    let (_, _, columns, rows) = execute_resolved_export(&source, &resolved_intent, false).await?;
    let file_name = build_team_export_file_name(&dataset, &preview.preview_token);
    let relative_path = format!("team-exports/{}/{}", team_id, file_name);
    let absolute_path = FsPath::new(&state.config.upload_dir)
        .join("team-exports")
        .join(team_id.to_string())
        .join(&file_name);
    let parent = absolute_path.parent().ok_or_else(|| {
        Error::Internal(anyhow::anyhow!(
            "Failed to resolve export parent directory: {}",
            absolute_path.display()
        ))
    })?;
    tokio::fs::create_dir_all(parent)
        .await
        .map_err(|error| Error::Internal(anyhow::anyhow!("Create upload dir failed: {}", error)))?;

    let write_path = absolute_path.clone();
    let write_columns = columns.clone();
    let write_rows = rows.clone();
    tokio::task::spawn_blocking(move || write_csv_file(&write_path, &write_columns, &write_rows))
        .await
        .map_err(|error| {
            Error::Internal(anyhow::anyhow!("Write export file join failed: {}", error))
        })?
        .map_err(|error| Error::Internal(anyhow::anyhow!(error)))?;

    sqlx::query("DELETE FROM team_data_export_previews WHERE preview_token = $1")
        .bind(&preview.preview_token)
        .execute(&state.db)
        .await?;

    Ok(Json(TeamExportExecutionResult {
        preview_token: preview.preview_token,
        row_count: rows.len(),
        columns,
        download_url: format!("/uploads/{}", relative_path),
        file_name,
    }))
}

fn default_enabled() -> bool {
    true
}

fn parse_user_id(claims: &Claims) -> Result<Uuid> {
    Uuid::parse_str(&claims.sub).map_err(|_| Error::BadRequest("Invalid user ID".into()))
}

async fn ensure_team_admin_active(db: &sqlx::PgPool, team_id: Uuid, user_id: Uuid) -> Result<()> {
    let entitlement = entitlement::require_team_active(db, team_id, user_id).await?;
    match entitlement.role.as_deref() {
        Some("owner") | Some("admin") => Ok(()),
        Some(_) => Err(Error::api(
            StatusCode::FORBIDDEN,
            "TEAM_ADMIN_REQUIRED",
            "Admin permission required",
            Some(serde_json::json!({ "team_id": team_id })),
        )),
        None => Err(Error::api(
            StatusCode::FORBIDDEN,
            "TEAM_ACCESS_DENIED",
            "Not a team member",
            Some(serde_json::json!({ "team_id": team_id })),
        )),
    }
}

fn clean_optional_text(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn apply_optional_text(target: &mut Option<String>, incoming: Option<String>) {
    if incoming.is_some() {
        *target = clean_optional_text(incoming);
    }
}

fn normalize_team_db_type(value: &str) -> Result<String> {
    let normalized = value.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "postgres" | "mysql" | "mongodb" => Ok(normalized),
        "sqlite" => Err(Error::bad_request_code(
            "TEAM_DATA_SOURCE_UNSUPPORTED",
            "Team export service does not support sqlite",
            None,
        )),
        _ => Err(Error::bad_request_code(
            "TEAM_DATA_SOURCE_UNSUPPORTED",
            format!("Unsupported team data source type: {}", value.trim()),
            None,
        )),
    }
}

fn default_port_for_db_type(db_type: &str) -> i32 {
    match db_type {
        "postgres" => 5432,
        "mysql" => 3306,
        "mongodb" => 27017,
        _ => 0,
    }
}

fn normalize_team_data_source_draft(draft: &mut TeamDataSourceDraft) -> Result<()> {
    draft.name = draft.name.trim().to_string();
    if draft.name.is_empty() {
        return Err(Error::BadRequest("name is required".into()));
    }

    draft.db_type = normalize_team_db_type(&draft.db_type)?;
    draft.host = draft
        .host
        .take()
        .and_then(|value| clean_optional_text(Some(value)));
    draft.database = draft
        .database
        .take()
        .and_then(|value| clean_optional_text(Some(value)));
    draft.username = draft
        .username
        .take()
        .and_then(|value| clean_optional_text(Some(value)));
    draft.password = draft
        .password
        .take()
        .and_then(|value| clean_optional_text(Some(value)));
    draft.connection_string = draft
        .connection_string
        .take()
        .and_then(|value| clean_optional_text(Some(value)));
    draft.export_alias = draft
        .export_alias
        .take()
        .and_then(|value| clean_optional_text(Some(value)));
    draft.export_default_schema = draft
        .export_default_schema
        .take()
        .and_then(|value| clean_optional_text(Some(value)));
    draft.port = Some(
        draft
            .port
            .filter(|value| *value > 0)
            .unwrap_or_else(|| default_port_for_db_type(&draft.db_type)),
    );
    draft.max_export_rows = draft
        .max_export_rows
        .max(1)
        .min((DEFAULT_EXPORT_LIMIT * 100) as i64);

    if draft.connection_string.is_none() && (draft.host.is_none() || draft.database.is_none()) {
        return Err(Error::bad_request_code(
            "TEAM_DATA_SOURCE_INVALID",
            "host and database are required when connection_string is not provided",
            None,
        ));
    }

    Ok(())
}

fn source_row_to_draft(row: &TeamDataSourceRow) -> TeamDataSourceDraft {
    TeamDataSourceDraft {
        id: row.id,
        name: row.name.clone(),
        db_type: row.db_type.clone(),
        host: row.host.clone(),
        port: row.port,
        database: row.database_name.clone(),
        username: decrypt_optional(&row.username_encrypted),
        password: decrypt_optional(&row.password_encrypted),
        connection_string: decrypt_optional(&row.connection_string_encrypted),
        export_alias: row.export_alias.clone(),
        export_default_schema: row.export_default_schema.clone(),
        max_export_rows: row.max_export_rows,
        enabled: row.enabled,
    }
}

fn source_connection_changed(existing: &TeamDataSourceRow, draft: &TeamDataSourceDraft) -> bool {
    existing.db_type != draft.db_type
        || existing.host != draft.host
        || existing.port != draft.port
        || existing.database_name != draft.database
        || decrypt_optional(&existing.username_encrypted) != draft.username
        || decrypt_optional(&existing.password_encrypted) != draft.password
        || decrypt_optional(&existing.connection_string_encrypted) != draft.connection_string
}

fn decrypt_optional(value: &Option<String>) -> Option<String> {
    value
        .as_ref()
        .map(|raw| crypto::maybe_decrypt(raw))
        .and_then(|raw| clean_optional_text(Some(raw)))
}

fn encrypt_optional(value: &Option<String>) -> Result<Option<String>> {
    match value {
        Some(raw) if !raw.trim().is_empty() => crypto::encrypt(raw)
            .map(Some)
            .map_err(|error| Error::Internal(anyhow::anyhow!("Encrypt secret failed: {}", error))),
        _ => Ok(None),
    }
}

async fn test_team_data_source_connection(draft: &TeamDataSourceDraft) -> Result<()> {
    let connection_string = build_connection_string(
        &draft.db_type,
        draft.host.as_deref(),
        draft.port,
        draft.database.as_deref(),
        draft.username.as_deref(),
        draft.password.as_deref(),
        draft.connection_string.as_deref(),
    )?;

    match draft.db_type.as_str() {
        "postgres" => {
            let pool = PgPoolOptions::new()
                .max_connections(1)
                .connect(&connection_string)
                .await
                .map_err(|error| {
                    Error::bad_request_code(
                        "TEAM_DATA_SOURCE_CONNECT_FAILED",
                        format!("PostgreSQL connect failed: {}", error),
                        None,
                    )
                })?;
            sqlx::query("SELECT 1")
                .execute(&pool)
                .await
                .map_err(|error| {
                    Error::bad_request_code(
                        "TEAM_DATA_SOURCE_CONNECT_FAILED",
                        format!("PostgreSQL ping failed: {}", error),
                        None,
                    )
                })?;
            pool.close().await;
        }
        "mysql" => {
            let pool = MySqlPoolOptions::new()
                .max_connections(1)
                .connect(&connection_string)
                .await
                .map_err(|error| {
                    Error::bad_request_code(
                        "TEAM_DATA_SOURCE_CONNECT_FAILED",
                        format!("MySQL connect failed: {}", error),
                        None,
                    )
                })?;
            sqlx::query("SELECT 1")
                .execute(&pool)
                .await
                .map_err(|error| {
                    Error::bad_request_code(
                        "TEAM_DATA_SOURCE_CONNECT_FAILED",
                        format!("MySQL ping failed: {}", error),
                        None,
                    )
                })?;
            pool.close().await;
        }
        "mongodb" => {
            let options = ClientOptions::parse(&connection_string)
                .await
                .map_err(|error| {
                    Error::bad_request_code(
                        "TEAM_DATA_SOURCE_CONNECT_FAILED",
                        format!("MongoDB options parse failed: {}", error),
                        None,
                    )
                })?;
            let database_name = draft
                .database
                .clone()
                .or_else(|| options.default_database.clone())
                .unwrap_or_else(|| "test".to_string());
            let client = MongoClient::with_options(options).map_err(|error| {
                Error::bad_request_code(
                    "TEAM_DATA_SOURCE_CONNECT_FAILED",
                    format!("MongoDB client build failed: {}", error),
                    None,
                )
            })?;
            client
                .database(&database_name)
                .run_command(doc! { "ping": 1 })
                .await
                .map_err(|error| {
                    Error::bad_request_code(
                        "TEAM_DATA_SOURCE_CONNECT_FAILED",
                        format!("MongoDB ping failed: {}", error),
                        None,
                    )
                })?;
        }
        other => {
            return Err(Error::bad_request_code(
                "TEAM_DATA_SOURCE_UNSUPPORTED",
                format!("Unsupported team data source type: {}", other),
                None,
            ))
        }
    }

    Ok(())
}

async fn upsert_team_data_source_row(
    db: &sqlx::PgPool,
    team_id: Uuid,
    user_id: Uuid,
    existing: Option<TeamDataSourceRow>,
    draft: TeamDataSourceDraft,
) -> Result<TeamDataSourceRow> {
    let username_encrypted = encrypt_optional(&draft.username)?;
    let password_encrypted = encrypt_optional(&draft.password)?;
    let connection_string_encrypted = encrypt_optional(&draft.connection_string)?;

    if existing.is_some() {
        sqlx::query_as::<_, TeamDataSourceRow>(
            "UPDATE team_data_sources
             SET
                name = $1,
                db_type = $2,
                host = $3,
                port = $4,
                database_name = $5,
                username_encrypted = $6,
                password_encrypted = $7,
                connection_string_encrypted = $8,
                export_alias = $9,
                export_default_schema = $10,
                max_export_rows = $11,
                enabled = $12,
                updated_by = $13,
                updated_at = NOW()
             WHERE team_id = $14 AND id = $15
             RETURNING
                id, team_id, name, db_type, host, port, database_name,
                username_encrypted, password_encrypted, connection_string_encrypted,
                export_alias, export_default_schema, max_export_rows, enabled,
                created_by, updated_by, created_at, updated_at",
        )
        .bind(&draft.name)
        .bind(&draft.db_type)
        .bind(draft.host.as_deref())
        .bind(draft.port)
        .bind(draft.database.as_deref())
        .bind(username_encrypted)
        .bind(password_encrypted)
        .bind(connection_string_encrypted)
        .bind(draft.export_alias.as_deref())
        .bind(draft.export_default_schema.as_deref())
        .bind(draft.max_export_rows)
        .bind(draft.enabled)
        .bind(user_id)
        .bind(team_id)
        .bind(draft.id)
        .fetch_one(db)
        .await
        .map_err(Into::into)
    } else {
        sqlx::query_as::<_, TeamDataSourceRow>(
            "INSERT INTO team_data_sources (
                id, team_id, name, db_type, host, port, database_name,
                username_encrypted, password_encrypted, connection_string_encrypted,
                export_alias, export_default_schema, max_export_rows, enabled,
                created_by, updated_by, created_at, updated_at
             ) VALUES (
                $1, $2, $3, $4, $5, $6, $7,
                $8, $9, $10,
                $11, $12, $13, $14,
                $15, $15, NOW(), NOW()
             )
             RETURNING
                id, team_id, name, db_type, host, port, database_name,
                username_encrypted, password_encrypted, connection_string_encrypted,
                export_alias, export_default_schema, max_export_rows, enabled,
                created_by, updated_by, created_at, updated_at",
        )
        .bind(draft.id)
        .bind(team_id)
        .bind(&draft.name)
        .bind(&draft.db_type)
        .bind(draft.host.as_deref())
        .bind(draft.port)
        .bind(draft.database.as_deref())
        .bind(username_encrypted)
        .bind(password_encrypted)
        .bind(connection_string_encrypted)
        .bind(draft.export_alias.as_deref())
        .bind(draft.export_default_schema.as_deref())
        .bind(draft.max_export_rows)
        .bind(draft.enabled)
        .bind(user_id)
        .fetch_one(db)
        .await
        .map_err(Into::into)
    }
}

fn mask_username(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= 2 {
        return "*".repeat(chars.len());
    }
    let first = chars.first().copied().unwrap_or('*');
    let last = chars.last().copied().unwrap_or('*');
    format!("{}***{}", first, last)
}

fn to_team_data_source_summary(row: TeamDataSourceRow) -> TeamDataSourceSummary {
    let username = decrypt_optional(&row.username_encrypted);
    let password = decrypt_optional(&row.password_encrypted);
    TeamDataSourceSummary {
        id: row.id,
        name: row.name,
        db_type: row.db_type,
        host: row.host,
        port: row.port,
        database: row.database_name,
        export_alias: row.export_alias,
        export_default_schema: row.export_default_schema,
        max_export_rows: Some(row.max_export_rows.max(1)),
        enabled: row.enabled,
        has_password: password.is_some(),
        masked_username: username
            .as_deref()
            .map(mask_username)
            .filter(|value| !value.is_empty()),
        updated_at: row.updated_at,
    }
}

async fn fetch_team_data_source(
    db: &sqlx::PgPool,
    team_id: Uuid,
    source_id: Uuid,
) -> Result<Option<TeamDataSourceRow>> {
    sqlx::query_as::<_, TeamDataSourceRow>(
        "SELECT
            id, team_id, name, db_type, host, port, database_name,
            username_encrypted, password_encrypted, connection_string_encrypted,
            export_alias, export_default_schema, max_export_rows, enabled,
            created_by, updated_by, created_at, updated_at
         FROM team_data_sources
         WHERE team_id = $1 AND id = $2",
    )
    .bind(team_id)
    .bind(source_id)
    .fetch_optional(db)
    .await
    .map_err(Into::into)
}

async fn fetch_team_data_source_required(
    db: &sqlx::PgPool,
    team_id: Uuid,
    source_id: Uuid,
) -> Result<TeamDataSourceRow> {
    fetch_team_data_source(db, team_id, source_id)
        .await?
        .ok_or_else(|| {
            Error::not_found_code(
                "TEAM_DATA_SOURCE_NOT_FOUND",
                "Team data source not found",
                Some(serde_json::json!({ "team_id": team_id, "source_id": source_id })),
            )
        })
}

fn normalize_string_list(values: Vec<String>) -> Vec<String> {
    let mut items = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        let key = trimmed.to_ascii_lowercase();
        if seen.insert(key) {
            items.push(trimmed.to_string());
        }
    }
    items
}

fn normalize_dataset_fields(
    fields: Vec<ExportDatasetFieldDefinition>,
) -> Vec<ExportDatasetFieldDefinition> {
    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for mut field in fields {
        let name = field.name.trim();
        if name.is_empty() {
            continue;
        }
        let key = name.to_ascii_lowercase();
        if !seen.insert(key) {
            continue;
        }

        field.name = name.to_string();
        field.label = if field.label.trim().is_empty() {
            field.name.clone()
        } else {
            field.label.trim().to_string()
        };
        field.data_type = clean_optional_text(field.data_type);
        field.aliases = field
            .aliases
            .take()
            .map(normalize_string_list)
            .filter(|items| !items.is_empty());
        result.push(field);
    }

    result
}

fn parse_string_array(value: &serde_json::Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(ToString::to_string))
                .collect::<Vec<_>>()
        })
        .map(normalize_string_list)
        .unwrap_or_default()
}

fn parse_dataset_fields_json(value: &serde_json::Value) -> Vec<ExportDatasetFieldDefinition> {
    serde_json::from_value::<Vec<ExportDatasetFieldDefinition>>(value.clone()).unwrap_or_default()
}

fn dataset_row_to_draft(row: &TeamExportDatasetRow) -> TeamExportDatasetDraft {
    TeamExportDatasetDraft {
        id: row.id,
        display_name: row.display_name.clone(),
        description: row.description.clone(),
        source_id: row.source_id,
        entity_name: row.entity_name.clone(),
        entity_type: row.entity_type.clone(),
        schema: row.schema_name.clone(),
        time_field: row.time_field.clone(),
        default_fields: parse_string_array(&row.default_fields_json),
        fields: parse_dataset_fields_json(&row.fields_json),
        enabled: row.enabled,
    }
}

fn normalize_team_export_dataset_draft(
    draft: &mut TeamExportDatasetDraft,
    source: &TeamDataSourceRow,
) -> Result<()> {
    draft.display_name = draft.display_name.trim().to_string();
    draft.entity_name = draft.entity_name.trim().to_string();
    draft.entity_type = draft.entity_type.trim().to_ascii_lowercase();
    draft.description = draft
        .description
        .take()
        .and_then(|value| clean_optional_text(Some(value)));
    draft.schema = draft
        .schema
        .take()
        .and_then(|value| clean_optional_text(Some(value)));
    draft.time_field = draft
        .time_field
        .take()
        .and_then(|value| clean_optional_text(Some(value)));
    draft.default_fields = normalize_string_list(std::mem::take(&mut draft.default_fields));
    draft.fields = normalize_dataset_fields(std::mem::take(&mut draft.fields));

    if draft.display_name.is_empty() {
        return Err(Error::BadRequest("display_name is required".into()));
    }
    if draft.entity_name.is_empty() {
        return Err(Error::BadRequest("entity_name is required".into()));
    }

    match source.db_type.as_str() {
        "mongodb" => {
            if draft.entity_type != "collection" {
                return Err(Error::bad_request_code(
                    "TEAM_EXPORT_DATASET_INVALID",
                    "MongoDB team export datasets must use entity_type=collection",
                    None,
                ));
            }
        }
        _ => {
            if draft.entity_type != "table" && draft.entity_type != "view" {
                return Err(Error::bad_request_code(
                    "TEAM_EXPORT_DATASET_INVALID",
                    "SQL team export datasets must use entity_type=table or view",
                    None,
                ));
            }
        }
    }

    if !draft.fields.is_empty() {
        let enabled_names = build_field_alias_lookup(&draft.fields);
        draft.default_fields = draft
            .default_fields
            .iter()
            .filter_map(|item| resolve_field_name(&enabled_names, item, false))
            .collect();
    }

    Ok(())
}

async fn upsert_team_export_dataset_row(
    db: &sqlx::PgPool,
    team_id: Uuid,
    user_id: Uuid,
    existing: Option<TeamExportDatasetRow>,
    draft: TeamExportDatasetDraft,
) -> Result<TeamExportDatasetRow> {
    let default_fields_json = serde_json::to_value(&draft.default_fields)
        .map_err(|error| Error::Internal(error.into()))?;
    let fields_json =
        serde_json::to_value(&draft.fields).map_err(|error| Error::Internal(error.into()))?;

    if existing.is_some() {
        sqlx::query_as::<_, TeamExportDatasetRow>(
            "UPDATE team_export_datasets
             SET
                source_id = $1,
                display_name = $2,
                description = $3,
                entity_name = $4,
                entity_type = $5,
                schema_name = $6,
                time_field = $7,
                default_fields_json = $8,
                fields_json = $9,
                enabled = $10,
                updated_by = $11,
                updated_at = NOW()
             WHERE team_id = $12 AND id = $13
             RETURNING
                id, team_id, source_id, display_name, description, entity_name, entity_type,
                schema_name, time_field, default_fields_json, fields_json, enabled,
                created_by, updated_by, created_at, updated_at",
        )
        .bind(draft.source_id)
        .bind(&draft.display_name)
        .bind(draft.description.as_deref())
        .bind(&draft.entity_name)
        .bind(&draft.entity_type)
        .bind(draft.schema.as_deref())
        .bind(draft.time_field.as_deref())
        .bind(default_fields_json)
        .bind(fields_json)
        .bind(draft.enabled)
        .bind(user_id)
        .bind(team_id)
        .bind(draft.id)
        .fetch_one(db)
        .await
        .map_err(Into::into)
    } else {
        sqlx::query_as::<_, TeamExportDatasetRow>(
            "INSERT INTO team_export_datasets (
                id, team_id, source_id, display_name, description,
                entity_name, entity_type, schema_name, time_field,
                default_fields_json, fields_json, enabled,
                created_by, updated_by, created_at, updated_at
             ) VALUES (
                $1, $2, $3, $4, $5,
                $6, $7, $8, $9,
                $10, $11, $12,
                $13, $13, NOW(), NOW()
             )
             RETURNING
                id, team_id, source_id, display_name, description, entity_name, entity_type,
                schema_name, time_field, default_fields_json, fields_json, enabled,
                created_by, updated_by, created_at, updated_at",
        )
        .bind(draft.id)
        .bind(team_id)
        .bind(draft.source_id)
        .bind(&draft.display_name)
        .bind(draft.description.as_deref())
        .bind(&draft.entity_name)
        .bind(&draft.entity_type)
        .bind(draft.schema.as_deref())
        .bind(draft.time_field.as_deref())
        .bind(default_fields_json)
        .bind(fields_json)
        .bind(draft.enabled)
        .bind(user_id)
        .fetch_one(db)
        .await
        .map_err(Into::into)
    }
}

fn to_team_export_dataset_summary(row: TeamExportDatasetRow) -> TeamExportDatasetSummary {
    TeamExportDatasetSummary {
        id: row.id,
        display_name: row.display_name,
        description: row.description,
        source_id: row.source_id,
        entity_name: row.entity_name,
        entity_type: row.entity_type,
        schema: row.schema_name,
        time_field: row.time_field,
        default_fields: parse_string_array(&row.default_fields_json),
        fields: parse_dataset_fields_json(&row.fields_json),
        enabled: row.enabled,
        updated_at: row.updated_at,
    }
}

async fn fetch_team_export_dataset(
    db: &sqlx::PgPool,
    team_id: Uuid,
    dataset_id: Uuid,
) -> Result<Option<TeamExportDatasetRow>> {
    sqlx::query_as::<_, TeamExportDatasetRow>(
        "SELECT
            id, team_id, source_id, display_name, description, entity_name, entity_type,
            schema_name, time_field, default_fields_json, fields_json, enabled,
            created_by, updated_by, created_at, updated_at
         FROM team_export_datasets
         WHERE team_id = $1 AND id = $2",
    )
    .bind(team_id)
    .bind(dataset_id)
    .fetch_optional(db)
    .await
    .map_err(Into::into)
}

async fn fetch_team_export_dataset_required(
    db: &sqlx::PgPool,
    team_id: Uuid,
    dataset_id: Uuid,
) -> Result<TeamExportDatasetRow> {
    fetch_team_export_dataset(db, team_id, dataset_id)
        .await?
        .ok_or_else(|| {
            Error::not_found_code(
                "TEAM_EXPORT_DATASET_NOT_FOUND",
                "Team export dataset not found",
                Some(serde_json::json!({ "team_id": team_id, "dataset_id": dataset_id })),
            )
        })
}

async fn cleanup_expired_previews(db: &sqlx::PgPool) -> Result<()> {
    sqlx::query("DELETE FROM team_data_export_previews WHERE expires_at <= NOW()")
        .execute(db)
        .await?;
    Ok(())
}

fn parse_runtime_source_id(team_id: Uuid, value: &str) -> Result<Option<Uuid>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if let Ok(source_id) = Uuid::parse_str(trimmed) {
        return Ok(Some(source_id));
    }

    let prefix = format!("team:{}:source:", team_id);
    if let Some(raw_id) = trimmed.strip_prefix(&prefix) {
        return Uuid::parse_str(raw_id).map(Some).map_err(|_| {
            Error::bad_request_code(
                "TEAM_DATA_SOURCE_INVALID",
                "Invalid team runtime source id",
                Some(serde_json::json!({ "team_id": team_id, "source_id": trimmed })),
            )
        });
    }

    Err(Error::bad_request_code(
        "TEAM_DATA_SOURCE_INVALID",
        "Invalid team source id",
        Some(serde_json::json!({ "team_id": team_id, "source_id": trimmed })),
    ))
}

fn parse_runtime_dataset_id(team_id: Uuid, value: &str) -> Result<Option<Uuid>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if let Ok(dataset_id) = Uuid::parse_str(trimmed) {
        return Ok(Some(dataset_id));
    }

    let prefix = format!("team:{}:dataset:", team_id);
    if let Some(raw_id) = trimmed.strip_prefix(&prefix) {
        return Uuid::parse_str(raw_id).map(Some).map_err(|_| {
            Error::bad_request_code(
                "TEAM_EXPORT_DATASET_INVALID",
                "Invalid team runtime dataset id",
                Some(serde_json::json!({ "team_id": team_id, "dataset_id": trimmed })),
            )
        });
    }

    Err(Error::bad_request_code(
        "TEAM_EXPORT_DATASET_INVALID",
        "Invalid team dataset id",
        Some(serde_json::json!({ "team_id": team_id, "dataset_id": trimmed })),
    ))
}

async fn resolve_team_export_request(
    db: &sqlx::PgPool,
    team_id: Uuid,
    intent: StructuredExportIntent,
) -> Result<(
    TeamDataSourceRow,
    TeamExportDatasetRow,
    ResolvedTeamExportIntent,
)> {
    if let Some(scope) = intent.source_scope.as_deref() {
        if scope != "team" {
            return Err(Error::bad_request_code(
                "TEAM_EXPORT_SCOPE_INVALID",
                "Team export service only accepts sourceScope=team",
                Some(serde_json::json!({ "sourceScope": scope })),
            ));
        }
    }

    if let Some(raw_team_id) = intent.team_id.as_deref() {
        let parsed = Uuid::parse_str(raw_team_id).map_err(|_| {
            Error::bad_request_code(
                "TEAM_EXPORT_SCOPE_INVALID",
                "Invalid teamId in export intent",
                Some(serde_json::json!({ "teamId": raw_team_id })),
            )
        })?;
        if parsed != team_id {
            return Err(Error::bad_request_code(
                "TEAM_EXPORT_SCOPE_INVALID",
                "The export intent teamId does not match the active team",
                Some(serde_json::json!({ "teamId": raw_team_id, "activeTeamId": team_id })),
            ));
        }
    }

    if let Some(output_format) = intent.output_format.as_deref() {
        if !output_format.trim().eq_ignore_ascii_case("csv") {
            return Err(Error::bad_request_code(
                "TEAM_EXPORT_FORMAT_UNSUPPORTED",
                "Only CSV export is supported",
                Some(serde_json::json!({ "outputFormat": output_format })),
            ));
        }
    }

    let requested_source_id = parse_runtime_source_id(team_id, &intent.source_id)?;
    let requested_dataset_id =
        parse_runtime_dataset_id(team_id, intent.dataset_id.as_deref().unwrap_or_default())?;

    let dataset = if let Some(dataset_id) = requested_dataset_id {
        fetch_team_export_dataset_required(db, team_id, dataset_id).await?
    } else {
        resolve_dataset_from_intent(db, team_id, requested_source_id, &intent).await?
    };

    if !dataset.enabled {
        return Err(Error::bad_request_code(
            "TEAM_EXPORT_DATASET_DISABLED",
            "The selected team export dataset is disabled",
            Some(serde_json::json!({ "team_id": team_id, "dataset_id": dataset.id })),
        ));
    }

    if let Some(source_id) = requested_source_id {
        if source_id != dataset.source_id {
            return Err(Error::bad_request_code(
                "TEAM_EXPORT_SOURCE_MISMATCH",
                "The selected dataset does not belong to the provided team data source",
                Some(serde_json::json!({
                    "team_id": team_id,
                    "dataset_id": dataset.id,
                    "source_id": source_id,
                    "dataset_source_id": dataset.source_id,
                })),
            ));
        }
    }

    let source = fetch_team_data_source_required(db, team_id, dataset.source_id).await?;
    let resolved = resolve_structured_export_intent(&source, &dataset, intent)?;
    Ok((source, dataset, resolved))
}

async fn resolve_dataset_from_intent(
    db: &sqlx::PgPool,
    team_id: Uuid,
    requested_source_id: Option<Uuid>,
    intent: &StructuredExportIntent,
) -> Result<TeamExportDatasetRow> {
    let rows = sqlx::query_as::<_, TeamExportDatasetRow>(
        "SELECT
            id, team_id, source_id, display_name, description, entity_name, entity_type,
            schema_name, time_field, default_fields_json, fields_json, enabled,
            created_by, updated_by, created_at, updated_at
         FROM team_export_datasets
         WHERE team_id = $1 AND enabled = TRUE
         ORDER BY updated_at DESC",
    )
    .bind(team_id)
    .fetch_all(db)
    .await?;

    let target = intent.entity_name.trim();
    let mut matches = rows
        .into_iter()
        .filter(|row| {
            requested_source_id.map_or(true, |source_id| row.source_id == source_id)
                && (row.display_name.trim().eq_ignore_ascii_case(target)
                    || row.entity_name.trim().eq_ignore_ascii_case(target))
        })
        .collect::<Vec<_>>();

    if matches.len() == 1 {
        return Ok(matches.remove(0));
    }

    if matches.is_empty() {
        return Err(Error::bad_request_code(
            "TEAM_EXPORT_DATASET_REQUIRED",
            "The request must resolve to a published team dataset",
            Some(serde_json::json!({
                "team_id": team_id,
                "entityName": intent.entity_name,
            })),
        ));
    }

    Err(Error::bad_request_code(
        "TEAM_EXPORT_DATASET_AMBIGUOUS",
        "Multiple published team datasets match this request; please be more specific",
        Some(serde_json::json!({
            "team_id": team_id,
            "entityName": intent.entity_name,
        })),
    ))
}

fn build_field_alias_lookup(fields: &[ExportDatasetFieldDefinition]) -> HashMap<String, String> {
    let mut lookup = HashMap::new();
    for field in fields.iter().filter(|field| field.enabled) {
        lookup
            .entry(field.name.trim().to_ascii_lowercase())
            .or_insert_with(|| field.name.clone());
        if !field.label.trim().is_empty() {
            lookup
                .entry(field.label.trim().to_ascii_lowercase())
                .or_insert_with(|| field.name.clone());
        }
        for alias in field.aliases.as_deref().unwrap_or(&[]) {
            let trimmed = alias.trim();
            if trimmed.is_empty() {
                continue;
            }
            lookup
                .entry(trimmed.to_ascii_lowercase())
                .or_insert_with(|| field.name.clone());
        }
    }
    lookup
}

fn resolve_field_name(
    lookup: &HashMap<String, String>,
    value: &str,
    allow_raw_when_unconfigured: bool,
) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if lookup.is_empty() {
        return allow_raw_when_unconfigured.then(|| trimmed.to_string());
    }
    lookup.get(&trimmed.to_ascii_lowercase()).cloned()
}

fn resolve_structured_export_intent(
    source: &TeamDataSourceRow,
    dataset: &TeamExportDatasetRow,
    intent: StructuredExportIntent,
) -> Result<ResolvedTeamExportIntent> {
    let dataset_fields = parse_dataset_fields_json(&dataset.fields_json);
    let field_lookup = build_field_alias_lookup(&dataset_fields);
    let allow_raw_fields = dataset_fields.is_empty();
    let default_fields = parse_string_array(&dataset.default_fields_json);
    let allowed_fields = if field_lookup.is_empty() {
        None
    } else {
        Some(
            dataset_fields
                .iter()
                .filter(|field| field.enabled)
                .map(|field| field.name.clone())
                .collect::<Vec<_>>(),
        )
    };

    let requested_fields = match intent.fields {
        Some(fields) => {
            let mut resolved = Vec::new();
            for field in fields {
                let canonical = resolve_field_name(&field_lookup, &field, allow_raw_fields)
                    .ok_or_else(|| {
                        Error::bad_request_code(
                            "TEAM_EXPORT_FIELD_UNAVAILABLE",
                            format!(
                                "Field is not published in this team dataset: {}",
                                field.trim()
                            ),
                            Some(serde_json::json!({ "dataset_id": dataset.id })),
                        )
                    })?;
                resolved.push(canonical);
            }
            Some(normalize_string_list(resolved))
        }
        None => {
            let defaults = default_fields
                .iter()
                .filter_map(|field| resolve_field_name(&field_lookup, field, allow_raw_fields))
                .collect::<Vec<_>>();
            if !defaults.is_empty() {
                Some(normalize_string_list(defaults))
            } else {
                allowed_fields.clone().filter(|items| !items.is_empty())
            }
        }
    };

    let mut resolved_filters = Vec::new();
    for filter in intent.filters.unwrap_or_default() {
        let canonical = resolve_field_name(&field_lookup, &filter.field, allow_raw_fields)
            .ok_or_else(|| {
                Error::bad_request_code(
                    "TEAM_EXPORT_FIELD_UNAVAILABLE",
                    format!(
                        "Filter field is not published in this team dataset: {}",
                        filter.field.trim()
                    ),
                    Some(serde_json::json!({ "dataset_id": dataset.id })),
                )
            })?;
        resolved_filters.push(ExportFilter {
            field: canonical,
            op: filter.op,
            value: filter.value,
        });
    }

    let mut resolved_sort = Vec::new();
    for sort in intent.sort.unwrap_or_default() {
        let canonical = resolve_field_name(&field_lookup, &sort.field, allow_raw_fields)
            .ok_or_else(|| {
                Error::bad_request_code(
                    "TEAM_EXPORT_FIELD_UNAVAILABLE",
                    format!(
                        "Sort field is not published in this team dataset: {}",
                        sort.field.trim()
                    ),
                    Some(serde_json::json!({ "dataset_id": dataset.id })),
                )
            })?;
        resolved_sort.push(ExportSort {
            field: canonical,
            direction: sort.direction,
        });
    }

    let limit_cap = source.max_export_rows.max(1) as u64;
    let limit = intent.limit.unwrap_or(limit_cap).clamp(1, limit_cap);

    Ok(ResolvedTeamExportIntent {
        source_id: source.id,
        dataset_id: dataset.id,
        entity_name: dataset.entity_name.clone(),
        entity_type: dataset.entity_type.clone(),
        schema: dataset
            .schema_name
            .clone()
            .or_else(|| source.export_default_schema.clone()),
        fields: requested_fields.filter(|items| !items.is_empty()),
        filters: resolved_filters,
        sort: resolved_sort,
        limit,
        output_format: "csv".to_string(),
    })
}

fn escape_connection_part(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

fn build_connection_string(
    db_type: &str,
    host: Option<&str>,
    port: Option<i32>,
    database: Option<&str>,
    username: Option<&str>,
    password: Option<&str>,
    connection_string: Option<&str>,
) -> Result<String> {
    if let Some(raw) = connection_string {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }

    let host = host
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Error::BadRequest("host is required".into()))?;
    let database = database
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Error::BadRequest("database is required".into()))?;
    let auth = match (
        username.map(str::trim).filter(|value| !value.is_empty()),
        password.map(str::trim).filter(|value| !value.is_empty()),
    ) {
        (Some(user), Some(pass)) => format!(
            "{}:{}@",
            escape_connection_part(user),
            escape_connection_part(pass)
        ),
        (Some(user), None) => format!("{}@", escape_connection_part(user)),
        _ => String::new(),
    };

    match db_type {
        "postgres" => Ok(format!(
            "postgres://{}{}:{}/{}",
            auth,
            host,
            port.unwrap_or(5432),
            escape_connection_part(database)
        )),
        "mysql" => Ok(format!(
            "mysql://{}{}:{}/{}",
            auth,
            host,
            port.unwrap_or(3306),
            escape_connection_part(database)
        )),
        "mongodb" => Ok(format!(
            "mongodb://{}{}:{}/{}",
            auth,
            host,
            port.unwrap_or(27017),
            escape_connection_part(database)
        )),
        other => Err(Error::bad_request_code(
            "TEAM_DATA_SOURCE_UNSUPPORTED",
            format!("Unsupported team data source type: {}", other),
            None,
        )),
    }
}

async fn connect_external_source(source: &TeamDataSourceRow) -> Result<ExternalDbConnection> {
    let username = decrypt_optional(&source.username_encrypted);
    let password = decrypt_optional(&source.password_encrypted);
    let inline_connection_string = decrypt_optional(&source.connection_string_encrypted);
    let connection_string = build_connection_string(
        &source.db_type,
        source.host.as_deref(),
        source.port,
        source.database_name.as_deref(),
        username.as_deref(),
        password.as_deref(),
        inline_connection_string.as_deref(),
    )?;

    match source.db_type.as_str() {
        "postgres" => {
            let pool = PgPoolOptions::new()
                .max_connections(EXTERNAL_DB_MAX_CONNECTIONS)
                .connect(&connection_string)
                .await
                .map_err(|error| {
                    Error::bad_request_code(
                        "TEAM_DATA_SOURCE_CONNECT_FAILED",
                        format!("PostgreSQL connect failed: {}", error),
                        None,
                    )
                })?;
            Ok(ExternalDbConnection::Postgres(pool))
        }
        "mysql" => {
            let pool = MySqlPoolOptions::new()
                .max_connections(EXTERNAL_DB_MAX_CONNECTIONS)
                .connect(&connection_string)
                .await
                .map_err(|error| {
                    Error::bad_request_code(
                        "TEAM_DATA_SOURCE_CONNECT_FAILED",
                        format!("MySQL connect failed: {}", error),
                        None,
                    )
                })?;
            Ok(ExternalDbConnection::MySql(pool))
        }
        "mongodb" => {
            let options = ClientOptions::parse(&connection_string)
                .await
                .map_err(|error| {
                    Error::bad_request_code(
                        "TEAM_DATA_SOURCE_CONNECT_FAILED",
                        format!("MongoDB options parse failed: {}", error),
                        None,
                    )
                })?;
            let database_name = source
                .database_name
                .clone()
                .or_else(|| options.default_database.clone())
                .unwrap_or_else(|| "test".to_string());
            let client = MongoClient::with_options(options).map_err(|error| {
                Error::bad_request_code(
                    "TEAM_DATA_SOURCE_CONNECT_FAILED",
                    format!("MongoDB client build failed: {}", error),
                    None,
                )
            })?;
            Ok(ExternalDbConnection::Mongo(MongoConnection {
                client,
                database_name,
            }))
        }
        other => Err(Error::bad_request_code(
            "TEAM_DATA_SOURCE_UNSUPPORTED",
            format!("Unsupported team data source type: {}", other),
            None,
        )),
    }
}

fn normalize_identifier(value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(Error::BadRequest("Identifier cannot be empty".into()));
    }
    let valid = trimmed.chars().enumerate().all(|(index, ch)| {
        (ch == '_' || ch.is_ascii_alphabetic() || (index > 0 && ch.is_ascii_digit()))
            || (index > 0 && ch == '$')
    });
    if !valid {
        return Err(Error::BadRequest(format!(
            "Unsupported identifier: {}",
            trimmed
        )));
    }
    Ok(trimmed.to_string())
}

fn normalize_field_path(value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(Error::BadRequest("Field path cannot be empty".into()));
    }
    let parts = trimmed
        .split('.')
        .map(normalize_identifier)
        .collect::<Result<Vec<_>>>()?;
    Ok(parts.join("."))
}

fn quote_sql_identifier(dialect: &str, identifier: &str) -> Result<String> {
    let normalized = normalize_identifier(identifier)?;
    Ok(match dialect {
        "mysql" => format!("`{}`", normalized),
        _ => format!("\"{}\"", normalized),
    })
}

fn json_literal_to_sql(value: &serde_json::Value) -> Result<String> {
    match value {
        serde_json::Value::Null => Ok("NULL".to_string()),
        serde_json::Value::Bool(v) => Ok(if *v {
            "TRUE".to_string()
        } else {
            "FALSE".to_string()
        }),
        serde_json::Value::Number(v) => Ok(v.to_string()),
        serde_json::Value::String(v) => Ok(format!("'{}'", v.replace('\'', "''"))),
        serde_json::Value::Array(values) => Ok(format!(
            "({})",
            values
                .iter()
                .map(json_literal_to_sql)
                .collect::<Result<Vec<_>>>()?
                .join(", ")
        )),
        serde_json::Value::Object(_) => Err(Error::BadRequest(
            "Object literal is not supported in SQL filters".into(),
        )),
    }
}

fn escape_regex_literal(value: &str) -> String {
    value
        .chars()
        .flat_map(|ch| match ch {
            '.' | '*' | '+' | '?' | '^' | '$' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '\\' => {
                ['\\', ch].into_iter().collect::<Vec<_>>()
            }
            _ => vec![ch],
        })
        .collect()
}

fn compile_sql_filter(dialect: &str, filter: &ExportFilter) -> Result<String> {
    let field = quote_sql_identifier(dialect, &filter.field)?;
    let op = filter.op.trim().to_ascii_lowercase();
    match op.as_str() {
        "eq" | "=" => {
            if filter.value.is_null() {
                Ok(format!("{} IS NULL", field))
            } else {
                Ok(format!(
                    "{} = {}",
                    field,
                    json_literal_to_sql(&filter.value)?
                ))
            }
        }
        "neq" | "!=" | "<>" => {
            if filter.value.is_null() {
                Ok(format!("{} IS NOT NULL", field))
            } else {
                Ok(format!(
                    "{} <> {}",
                    field,
                    json_literal_to_sql(&filter.value)?
                ))
            }
        }
        "gt" => Ok(format!(
            "{} > {}",
            field,
            json_literal_to_sql(&filter.value)?
        )),
        "gte" => Ok(format!(
            "{} >= {}",
            field,
            json_literal_to_sql(&filter.value)?
        )),
        "lt" => Ok(format!(
            "{} < {}",
            field,
            json_literal_to_sql(&filter.value)?
        )),
        "lte" => Ok(format!(
            "{} <= {}",
            field,
            json_literal_to_sql(&filter.value)?
        )),
        "like" => {
            let value = filter
                .value
                .as_str()
                .ok_or_else(|| Error::BadRequest("LIKE filter requires string value".into()))?;
            let pattern = json_literal_to_sql(&serde_json::json!(value))?;
            if dialect == "postgres" {
                Ok(format!("{} ILIKE {}", field, pattern))
            } else {
                Ok(format!("{} LIKE {}", field, pattern))
            }
        }
        "contains" => {
            let value = filter
                .value
                .as_str()
                .ok_or_else(|| Error::BadRequest("CONTAINS filter requires string value".into()))?;
            let pattern = json_literal_to_sql(&serde_json::json!(format!("%{}%", value)))?;
            if dialect == "postgres" {
                Ok(format!("{} ILIKE {}", field, pattern))
            } else {
                Ok(format!("{} LIKE {}", field, pattern))
            }
        }
        "in" => {
            let values = filter
                .value
                .as_array()
                .ok_or_else(|| Error::BadRequest("IN filter requires array value".into()))?;
            if values.is_empty() {
                return Err(Error::BadRequest("IN filter cannot be empty".into()));
            }
            Ok(format!(
                "{} IN {}",
                field,
                json_literal_to_sql(&filter.value)?
            ))
        }
        other => Err(Error::BadRequest(format!(
            "Unsupported SQL filter op: {}",
            other
        ))),
    }
}

fn compile_sql_query(
    dialect: &str,
    intent: &ResolvedTeamExportIntent,
    preview_mode: bool,
) -> Result<String> {
    let entity_name = quote_sql_identifier(dialect, &intent.entity_name)?;
    let schema = intent
        .schema
        .as_deref()
        .map(normalize_identifier)
        .transpose()?;
    let table_ref = match schema.as_deref() {
        Some(schema_name) => format!(
            "{}.{}",
            quote_sql_identifier(dialect, schema_name)?,
            entity_name
        ),
        None => entity_name,
    };

    let select_clause = if let Some(fields) = &intent.fields {
        if fields.is_empty() {
            "*".to_string()
        } else {
            fields
                .iter()
                .map(|field| quote_sql_identifier(dialect, field))
                .collect::<Result<Vec<_>>>()?
                .join(", ")
        }
    } else {
        "*".to_string()
    };

    let mut query = format!("SELECT {} FROM {}", select_clause, table_ref);
    if !intent.filters.is_empty() {
        let clauses = intent
            .filters
            .iter()
            .map(|filter| compile_sql_filter(dialect, filter))
            .collect::<Result<Vec<_>>>()?;
        query.push_str(&format!(" WHERE {}", clauses.join(" AND ")));
    }

    if !intent.sort.is_empty() {
        let order_by = intent
            .sort
            .iter()
            .map(|item| {
                let direction = item.direction.trim().to_ascii_uppercase();
                let normalized_direction = if direction == "DESC" { "DESC" } else { "ASC" };
                Ok(format!(
                    "{} {}",
                    quote_sql_identifier(dialect, &item.field)?,
                    normalized_direction
                ))
            })
            .collect::<Result<Vec<_>>>()?;
        query.push_str(&format!(" ORDER BY {}", order_by.join(", ")));
    }

    let limit = if preview_mode {
        intent.limit.min(DEFAULT_PREVIEW_LIMIT).max(1)
    } else {
        intent.limit.max(1)
    };
    query.push_str(&format!(" LIMIT {}", limit));
    Ok(query)
}

fn json_to_bson(value: &serde_json::Value) -> Result<Bson> {
    mongodb::bson::to_bson(value)
        .map_err(|error| Error::Internal(anyhow::anyhow!("Convert json to bson failed: {}", error)))
}

fn compile_mongo_filter(filter: &ExportFilter) -> Result<Document> {
    let field = normalize_field_path(&filter.field)?;
    let op = filter.op.trim().to_ascii_lowercase();
    let bson_value = json_to_bson(&filter.value)?;
    let mut result = Document::new();

    match op.as_str() {
        "eq" | "=" => {
            result.insert(field, bson_value);
        }
        "gt" => {
            result.insert(field, doc! { "$gt": bson_value });
        }
        "gte" => {
            result.insert(field, doc! { "$gte": bson_value });
        }
        "lt" => {
            result.insert(field, doc! { "$lt": bson_value });
        }
        "lte" => {
            result.insert(field, doc! { "$lte": bson_value });
        }
        "in" => {
            let values = filter
                .value
                .as_array()
                .ok_or_else(|| Error::BadRequest("Mongo IN filter requires array value".into()))?;
            result.insert(
                field,
                doc! {
                    "$in": values
                        .iter()
                        .map(json_to_bson)
                        .collect::<Result<Vec<_>>>()?
                },
            );
        }
        "like" | "contains" => {
            let raw = filter.value.as_str().ok_or_else(|| {
                Error::BadRequest("Mongo text filter requires string value".into())
            })?;
            let pattern = escape_regex_literal(raw);
            result.insert(field, doc! { "$regex": pattern, "$options": "i" });
        }
        other => {
            return Err(Error::BadRequest(format!(
                "Unsupported Mongo filter op: {}",
                other
            )))
        }
    }

    Ok(result)
}

fn merge_mongo_filter_documents(filters: &[ExportFilter]) -> Result<Document> {
    let mut clauses = Vec::new();
    for filter in filters {
        clauses.push(Bson::Document(compile_mongo_filter(filter)?));
    }
    if clauses.is_empty() {
        Ok(doc! {})
    } else if clauses.len() == 1 {
        match clauses.into_iter().next() {
            Some(Bson::Document(document)) => Ok(document),
            _ => Ok(doc! {}),
        }
    } else {
        Ok(doc! { "$and": clauses })
    }
}

fn extract_document_path(document: &Document, path: &str) -> Option<Bson> {
    let mut current = Bson::Document(document.clone());
    for part in path.split('.') {
        current = match current {
            Bson::Document(doc) => doc.get(part).cloned()?,
            _ => return None,
        };
    }
    Some(current)
}

fn mongo_bson_to_json(value: &Bson) -> serde_json::Value {
    match value {
        Bson::Double(v) => serde_json::json!(v),
        Bson::String(v) => serde_json::json!(v),
        Bson::Array(items) => {
            serde_json::Value::Array(items.iter().map(mongo_bson_to_json).collect())
        }
        Bson::Document(doc) => {
            let mut map = serde_json::Map::new();
            for (key, value) in doc {
                map.insert(key.to_string(), mongo_bson_to_json(value));
            }
            serde_json::Value::Object(map)
        }
        Bson::Boolean(v) => serde_json::json!(v),
        Bson::Null => serde_json::Value::Null,
        Bson::Int32(v) => serde_json::json!(v),
        Bson::Int64(v) => serde_json::json!(v),
        Bson::Decimal128(v) => serde_json::json!(v.to_string()),
        Bson::DateTime(v) => serde_json::json!(v.try_to_rfc3339_string().unwrap_or_default()),
        Bson::ObjectId(v) => serde_json::json!(v.to_hex()),
        Bson::Binary(v) => serde_json::json!(format!("[blob: {} bytes]", v.bytes.len())),
        other => serde_json::json!(other.to_string()),
    }
}

fn pg_value_to_json(row: &PgRow, index: usize) -> Result<serde_json::Value> {
    let raw = row
        .try_get_raw(index)
        .map_err(|error| Error::Internal(anyhow::anyhow!("Read column error: {}", error)))?;
    if raw.is_null() {
        return Ok(serde_json::Value::Null);
    }

    let type_name = row.columns()[index].type_info().name().to_ascii_lowercase();
    if type_name.contains("bool") {
        if let Ok(value) = row.try_get::<bool, _>(index) {
            return Ok(serde_json::json!(value));
        }
    }
    if ["int2", "int4", "int8", "serial", "bigserial"].contains(&type_name.as_str()) {
        if let Ok(value) = row.try_get::<i64, _>(index) {
            return Ok(serde_json::json!(value));
        }
        if let Ok(value) = row.try_get::<i32, _>(index) {
            return Ok(serde_json::json!(value));
        }
    }
    if ["float4", "float8", "numeric", "decimal"].contains(&type_name.as_str()) {
        if let Ok(value) = row.try_get::<f64, _>(index) {
            return Ok(serde_json::json!(value));
        }
    }
    if type_name.contains("json") {
        if let Ok(value) = row.try_get::<serde_json::Value, _>(index) {
            return Ok(value);
        }
    }
    if type_name == "uuid" {
        if let Ok(value) = row.try_get::<uuid::Uuid, _>(index) {
            return Ok(serde_json::json!(value.to_string()));
        }
    }
    if type_name == "date" {
        if let Ok(value) = row.try_get::<chrono::NaiveDate, _>(index) {
            return Ok(serde_json::json!(value.to_string()));
        }
    }
    if type_name.contains("timestamp") {
        if let Ok(value) = row.try_get::<chrono::NaiveDateTime, _>(index) {
            return Ok(serde_json::json!(value.to_string()));
        }
        if let Ok(value) = row.try_get::<chrono::DateTime<chrono::Utc>, _>(index) {
            return Ok(serde_json::json!(value.to_rfc3339()));
        }
    }
    if type_name == "time" || type_name == "timetz" {
        if let Ok(value) = row.try_get::<chrono::NaiveTime, _>(index) {
            return Ok(serde_json::json!(value.to_string()));
        }
    }
    if type_name == "bytea" {
        if let Ok(value) = row.try_get::<Vec<u8>, _>(index) {
            return Ok(serde_json::json!(format!("[blob: {} bytes]", value.len())));
        }
    }
    if let Ok(value) = row.try_get::<String, _>(index) {
        return Ok(serde_json::json!(value));
    }
    if let Ok(value) = row.try_get::<Vec<u8>, _>(index) {
        if let Ok(text) = String::from_utf8(value.clone()) {
            return Ok(serde_json::json!(text));
        }
        return Ok(serde_json::json!(format!("[blob: {} bytes]", value.len())));
    }

    Ok(serde_json::json!(format!("[unsupported:{}]", type_name)))
}

fn mysql_value_to_json(row: &MySqlRow, index: usize) -> Result<serde_json::Value> {
    let raw = row
        .try_get_raw(index)
        .map_err(|error| Error::Internal(anyhow::anyhow!("Read column error: {}", error)))?;
    if raw.is_null() {
        return Ok(serde_json::Value::Null);
    }

    let type_name = row.columns()[index].type_info().name().to_ascii_lowercase();
    if type_name.contains("bool") {
        if let Ok(value) = row.try_get::<bool, _>(index) {
            return Ok(serde_json::json!(value));
        }
    }
    if type_name.contains("int") {
        if let Ok(value) = row.try_get::<i64, _>(index) {
            return Ok(serde_json::json!(value));
        }
    }
    if type_name.contains("double")
        || type_name.contains("float")
        || type_name.contains("decimal")
        || type_name.contains("numeric")
    {
        if let Ok(value) = row.try_get::<f64, _>(index) {
            return Ok(serde_json::json!(value));
        }
    }
    if type_name.contains("json") {
        if let Ok(value) = row.try_get::<serde_json::Value, _>(index) {
            return Ok(value);
        }
    }
    if type_name.contains("date")
        && !type_name.contains("datetime")
        && !type_name.contains("timestamp")
    {
        if let Ok(value) = row.try_get::<chrono::NaiveDate, _>(index) {
            return Ok(serde_json::json!(value.to_string()));
        }
    }
    if type_name.contains("timestamp") || type_name.contains("datetime") {
        if let Ok(value) = row.try_get::<chrono::NaiveDateTime, _>(index) {
            return Ok(serde_json::json!(value.to_string()));
        }
    }
    if type_name == "time" {
        if let Ok(value) = row.try_get::<chrono::NaiveTime, _>(index) {
            return Ok(serde_json::json!(value.to_string()));
        }
    }
    if type_name.contains("blob") || type_name.contains("binary") {
        if let Ok(value) = row.try_get::<Vec<u8>, _>(index) {
            return Ok(serde_json::json!(format!("[blob: {} bytes]", value.len())));
        }
    }
    if let Ok(value) = row.try_get::<String, _>(index) {
        return Ok(serde_json::json!(value));
    }
    if let Ok(value) = row.try_get::<Vec<u8>, _>(index) {
        if let Ok(text) = String::from_utf8(value.clone()) {
            return Ok(serde_json::json!(text));
        }
        return Ok(serde_json::json!(format!("[blob: {} bytes]", value.len())));
    }

    Ok(serde_json::json!(format!("[unsupported:{}]", type_name)))
}

async fn execute_sql_query(
    conn: &ExternalDbConnection,
    query: &str,
) -> Result<(Vec<String>, Vec<Vec<serde_json::Value>>)> {
    match conn {
        ExternalDbConnection::Postgres(pool) => {
            let description = pool.describe(query).await.map_err(|error| {
                Error::Internal(anyhow::anyhow!("Describe query failed: {}", error))
            })?;
            let columns = description
                .columns()
                .iter()
                .map(|column| column.name().to_string())
                .collect::<Vec<_>>();
            let rows = sqlx::query(query)
                .fetch_all(pool)
                .await
                .map_err(|error| Error::Internal(anyhow::anyhow!("Run query failed: {}", error)))?;
            let mut values = Vec::with_capacity(rows.len());
            for row in &rows {
                let mut row_values = Vec::with_capacity(columns.len());
                for index in 0..columns.len() {
                    row_values.push(pg_value_to_json(row, index)?);
                }
                values.push(row_values);
            }
            Ok((columns, values))
        }
        ExternalDbConnection::MySql(pool) => {
            let description = pool.describe(query).await.map_err(|error| {
                Error::Internal(anyhow::anyhow!("Describe query failed: {}", error))
            })?;
            let columns = description
                .columns()
                .iter()
                .map(|column| column.name().to_string())
                .collect::<Vec<_>>();
            let rows = sqlx::query(query)
                .fetch_all(pool)
                .await
                .map_err(|error| Error::Internal(anyhow::anyhow!("Run query failed: {}", error)))?;
            let mut values = Vec::with_capacity(rows.len());
            for row in &rows {
                let mut row_values = Vec::with_capacity(columns.len());
                for index in 0..columns.len() {
                    row_values.push(mysql_value_to_json(row, index)?);
                }
                values.push(row_values);
            }
            Ok((columns, values))
        }
        ExternalDbConnection::Mongo(_) => Err(Error::BadRequest(
            "SQL execution requested for a MongoDB data source".into(),
        )),
    }
}

async fn execute_mongo_plan(
    conn: &MongoConnection,
    collection_name: &str,
    filter: Document,
    projection: Option<Document>,
    sort: Option<Document>,
    limit: i64,
    fixed_columns: Option<&[String]>,
) -> Result<(Vec<String>, Vec<Vec<serde_json::Value>>)> {
    let collection = conn
        .client
        .database(&conn.database_name)
        .collection::<Document>(collection_name);
    let mut action = collection.find(filter);
    if let Some(projection_doc) = projection {
        action = action.projection(projection_doc);
    }
    if let Some(sort_doc) = sort {
        action = action.sort(sort_doc);
    }
    action = action.limit(limit);
    let mut cursor = action.await.map_err(|error| {
        Error::Internal(anyhow::anyhow!(
            "MongoDB execute export plan failed: {}",
            error
        ))
    })?;

    let mut documents = Vec::new();
    while cursor.advance().await.map_err(|error| {
        Error::Internal(anyhow::anyhow!("MongoDB cursor advance failed: {}", error))
    })? {
        let current = cursor.deserialize_current().map_err(|error| {
            Error::Internal(anyhow::anyhow!("MongoDB row decode failed: {}", error))
        })?;
        documents.push(current);
    }

    let columns = if let Some(columns) = fixed_columns {
        columns.to_vec()
    } else {
        let mut set = BTreeSet::new();
        for document in &documents {
            for key in document.keys() {
                set.insert(key.to_string());
            }
        }
        set.into_iter().collect::<Vec<_>>()
    };

    let rows = documents
        .iter()
        .map(|document| {
            columns
                .iter()
                .map(|column| {
                    extract_document_path(document, column)
                        .map(|value| mongo_bson_to_json(&value))
                        .unwrap_or(serde_json::Value::Null)
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    Ok((columns, rows))
}

async fn execute_resolved_export(
    source: &TeamDataSourceRow,
    intent: &ResolvedTeamExportIntent,
    preview_mode: bool,
) -> Result<(String, String, Vec<String>, Vec<Vec<serde_json::Value>>)> {
    let conn = connect_external_source(source).await?;

    match &conn {
        ExternalDbConnection::Mongo(mongo_conn) => {
            let projection_columns = intent.fields.clone();
            let projection = projection_columns.as_ref().map(|fields| {
                let mut projection_doc = Document::new();
                for field in fields {
                    projection_doc.insert(field, 1);
                }
                projection_doc
            });
            let filter = merge_mongo_filter_documents(&intent.filters)?;
            let sort = if intent.sort.is_empty() {
                None
            } else {
                let mut sort_doc = Document::new();
                for item in &intent.sort {
                    sort_doc.insert(
                        normalize_field_path(&item.field)?,
                        if item.direction.trim().eq_ignore_ascii_case("desc") {
                            -1
                        } else {
                            1
                        },
                    );
                }
                Some(sort_doc)
            };
            let limit = if preview_mode {
                intent.limit.min(DEFAULT_PREVIEW_LIMIT).max(1)
            } else {
                intent.limit.max(1)
            } as i64;
            let (columns, rows) = execute_mongo_plan(
                mongo_conn,
                &intent.entity_name,
                filter.clone(),
                projection.clone(),
                sort.clone(),
                limit,
                projection_columns.as_deref(),
            )
            .await?;
            let canonical_query = serde_json::to_string_pretty(&serde_json::json!({
                "collection": intent.entity_name,
                "filter": filter,
                "projection": projection,
                "sort": sort,
                "limit": limit,
            }))
            .map_err(|error| {
                Error::Internal(anyhow::anyhow!("Serialize mongo query failed: {}", error))
            })?;
            Ok(("mongodb".to_string(), canonical_query, columns, rows))
        }
        ExternalDbConnection::Postgres(_) => {
            let query = compile_sql_query("postgres", intent, preview_mode)?;
            let (columns, rows) = execute_sql_query(&conn, &query).await?;
            Ok(("postgres".to_string(), query, columns, rows))
        }
        ExternalDbConnection::MySql(_) => {
            let query = compile_sql_query("mysql", intent, preview_mode)?;
            let (columns, rows) = execute_sql_query(&conn, &query).await?;
            Ok(("mysql".to_string(), query, columns, rows))
        }
    }
}

fn build_row_maps(
    columns: &[String],
    rows: &[Vec<serde_json::Value>],
) -> Vec<HashMap<String, serde_json::Value>> {
    rows.iter()
        .map(|row| {
            columns
                .iter()
                .enumerate()
                .map(|(index, key)| {
                    (
                        key.clone(),
                        row.get(index).cloned().unwrap_or(serde_json::Value::Null),
                    )
                })
                .collect()
        })
        .collect()
}

fn sanitize_file_stem(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let compact = sanitized.trim_matches('_');
    if compact.is_empty() {
        "team-export".to_string()
    } else {
        compact.to_string()
    }
}

fn build_team_export_file_name(dataset: &TeamExportDatasetRow, preview_token: &str) -> String {
    let stem = sanitize_file_stem(&dataset.display_name);
    let suffix = preview_token.chars().take(8).collect::<String>();
    format!(
        "{}-{}-{}.csv",
        stem,
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        suffix
    )
}

fn write_csv_value(
    writer: &mut BufWriter<File>,
    value: &serde_json::Value,
) -> std::result::Result<(), String> {
    let raw = match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::Bool(v) => v.to_string(),
        serde_json::Value::Number(v) => v.to_string(),
        serde_json::Value::String(v) => v.clone(),
        other => serde_json::to_string(other)
            .map_err(|error| format!("Serialize CSV cell failed: {}", error))?,
    };
    let escaped = raw.replace('"', "\"\"");
    write!(writer, "\"{}\"", escaped).map_err(|error| format!("Write CSV cell failed: {}", error))
}

fn write_csv_file(
    file_path: &PathBuf,
    columns: &[String],
    rows: &[Vec<serde_json::Value>],
) -> std::result::Result<(), String> {
    let file =
        File::create(file_path).map_err(|error| format!("Create export file failed: {}", error))?;
    let mut writer = BufWriter::new(file);

    for (index, column) in columns.iter().enumerate() {
        if index > 0 {
            write!(writer, ",")
                .map_err(|error| format!("Write CSV separator failed: {}", error))?;
        }
        write_csv_value(&mut writer, &serde_json::json!(column))?;
    }
    writeln!(writer).map_err(|error| format!("Write CSV header failed: {}", error))?;

    for row in rows {
        for (index, value) in row.iter().enumerate() {
            if index > 0 {
                write!(writer, ",")
                    .map_err(|error| format!("Write CSV separator failed: {}", error))?;
            }
            write_csv_value(&mut writer, value)?;
        }
        writeln!(writer).map_err(|error| format!("Write CSV row failed: {}", error))?;
    }

    writer
        .flush()
        .map_err(|error| format!("Flush CSV file failed: {}", error))
}
