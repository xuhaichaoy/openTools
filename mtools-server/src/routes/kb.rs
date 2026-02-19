use axum::{
    body::Body,
    extract::{Extension, Multipart, Path, State},
    routing::{get, post},
    Json, Router,
};
use crate::{
    routes::AppState,
    services::auth::Claims,
    Error, Result,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

const MAX_DOC_SIZE: usize = 10 * 1024 * 1024; // 10 MB
const ALLOWED_FORMATS: &[&str] = &["txt", "md", "json", "csv", "html", "markdown", "htm"];

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct KbDocument {
    pub id: Uuid,
    pub owner_type: String,
    pub owner_id: Uuid,
    pub uploader_id: Uuid,
    pub name: String,
    pub format: String,
    pub size: i64,
    pub file_path: String,
    pub content: Option<String>,
    pub tags: Vec<String>,
    pub description: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize)]
pub struct KbDocumentInfo {
    pub id: Uuid,
    pub owner_type: String,
    pub owner_id: Uuid,
    pub uploader_id: Uuid,
    pub name: String,
    pub format: String,
    pub size: i64,
    pub tags: Vec<String>,
    pub description: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
    pub uploader_name: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateDocRequest {
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateDocRequest {
    pub name: Option<String>,
    pub content: Option<String>,
    pub tags: Option<Vec<String>>,
    pub description: Option<String>,
}

pub fn personal_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/", get(list_personal_docs).post(create_personal_doc))
        .route("/upload", post(upload_personal_doc))
        .route("/{doc_id}", get(get_personal_doc).patch(update_personal_doc).delete(delete_personal_doc))
        .route("/{doc_id}/download", get(download_doc))
}

pub fn team_kb_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/{team_id}/kb", get(list_team_docs).post(create_team_doc))
        .route("/{team_id}/kb/upload", post(upload_team_doc))
        .route("/{team_id}/kb/{doc_id}", get(get_team_doc).patch(update_team_doc).delete(delete_team_doc))
        .route("/{team_id}/kb/{doc_id}/download", get(download_team_doc))
}

// ── 辅助函数 ──

fn detect_format(filename: &str) -> String {
    let ext = std::path::Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("txt")
        .to_lowercase();
    match ext.as_str() {
        "md" | "markdown" => "md".to_string(),
        "json" => "json".to_string(),
        "csv" => "csv".to_string(),
        "html" | "htm" => "html".to_string(),
        _ => "txt".to_string(),
    }
}

fn validate_format(format: &str) -> Result<()> {
    if !ALLOWED_FORMATS.contains(&format) {
        return Err(Error::BadRequest(format!(
            "Unsupported format: {}. Allowed: {}",
            format,
            ALLOWED_FORMATS.join(", ")
        )));
    }
    Ok(())
}

async fn check_team_membership(db: &sqlx::PgPool, team_id: Uuid, user_id: Uuid) -> Result<()> {
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

async fn check_team_admin_or_uploader(
    db: &sqlx::PgPool,
    team_id: Uuid,
    user_id: Uuid,
    uploader_id: Uuid,
) -> Result<()> {
    if user_id == uploader_id {
        return Ok(());
    }
    let role: Option<String> = sqlx::query_scalar(
        "SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2",
    )
    .bind(team_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;

    match role.as_deref() {
        Some("owner") | Some("admin") => Ok(()),
        Some(_) => Err(Error::Unauthorized("Admin or uploader permission required".into())),
        None => Err(Error::Unauthorized("Not a team member".into())),
    }
}

async fn save_doc_file(
    upload_dir: &str,
    sub_path: &str,
    filename: &str,
    data: &[u8],
) -> Result<String> {
    let dir = std::path::Path::new(upload_dir).join("kb").join(sub_path);
    tokio::fs::create_dir_all(&dir).await
        .map_err(|e| Error::from(format!("Failed to create directory: {e}")))?;
    let file_path = dir.join(filename);
    tokio::fs::write(&file_path, data).await
        .map_err(|e| Error::from(format!("Failed to write file: {e}")))?;
    Ok(format!("kb/{}/{}", sub_path, filename))
}

// ── 个人知识库 ──

async fn list_personal_docs(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
) -> Result<Json<Vec<KbDocumentInfo>>> {
    let user_id = Uuid::parse_str(&claims.sub)
        .map_err(|_| Error::BadRequest("Invalid user ID".into()))?;

    let rows = sqlx::query_as::<_, KbDocument>(
        "SELECT * FROM kb_documents WHERE owner_type = 'personal' AND owner_id = $1 ORDER BY updated_at DESC",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    let docs: Vec<KbDocumentInfo> = rows.into_iter().map(|d| KbDocumentInfo {
        id: d.id,
        owner_type: d.owner_type,
        owner_id: d.owner_id,
        uploader_id: d.uploader_id,
        name: d.name,
        format: d.format,
        size: d.size,
        tags: d.tags,
        description: d.description,
        created_at: d.created_at,
        updated_at: d.updated_at,
        uploader_name: None,
    }).collect();

    Ok(Json(docs))
}

async fn create_personal_doc(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Json(payload): Json<CreateDocRequest>,
) -> Result<Json<KbDocumentInfo>> {
    let user_id = Uuid::parse_str(&claims.sub)
        .map_err(|_| Error::BadRequest("Invalid user ID".into()))?;

    let format = payload.format.as_deref().unwrap_or("md").to_string();
    validate_format(&format)?;

    let content_bytes = payload.content.as_bytes();
    if content_bytes.len() > MAX_DOC_SIZE {
        return Err(Error::BadRequest("Document too large (max 10MB)".into()));
    }

    let doc_id = Uuid::new_v4();
    let filename = format!("{}_{}.{}", doc_id, sanitize_filename(&payload.name), format);
    let rel_path = save_doc_file(
        &state.config.upload_dir,
        &format!("personal/{}", user_id),
        &filename,
        content_bytes,
    ).await?;

    let doc = sqlx::query_as::<_, KbDocument>(
        "INSERT INTO kb_documents (id, owner_type, owner_id, uploader_id, name, format, size, file_path, content, tags, description)
         VALUES ($1, 'personal', $2, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *",
    )
    .bind(doc_id)
    .bind(user_id)
    .bind(&payload.name)
    .bind(&format)
    .bind(content_bytes.len() as i64)
    .bind(&rel_path)
    .bind(&payload.content)
    .bind(&payload.tags)
    .bind(&payload.description)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(doc_to_info(doc, None)))
}

async fn upload_personal_doc(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    mut multipart: Multipart,
) -> Result<Json<KbDocumentInfo>> {
    let user_id = Uuid::parse_str(&claims.sub)
        .map_err(|_| Error::BadRequest("Invalid user ID".into()))?;

    let field = multipart.next_field().await
        .map_err(|_| Error::BadRequest("Invalid multipart data".into()))?
        .ok_or_else(|| Error::BadRequest("No file uploaded".into()))?;

    let original_name = field.file_name()
        .unwrap_or("untitled.txt")
        .to_string();
    let format = detect_format(&original_name);
    validate_format(&format)?;

    let data = field.bytes().await
        .map_err(|_| Error::BadRequest("Failed to read file data".into()))?;
    if data.len() > MAX_DOC_SIZE {
        return Err(Error::BadRequest("File too large (max 10MB)".into()));
    }

    let content = String::from_utf8_lossy(&data).to_string();
    let doc_id = Uuid::new_v4();
    let filename = format!("{}_{}", doc_id, sanitize_filename(&original_name));
    let rel_path = save_doc_file(
        &state.config.upload_dir,
        &format!("personal/{}", user_id),
        &filename,
        &data,
    ).await?;

    let doc = sqlx::query_as::<_, KbDocument>(
        "INSERT INTO kb_documents (id, owner_type, owner_id, uploader_id, name, format, size, file_path, content)
         VALUES ($1, 'personal', $2, $2, $3, $4, $5, $6, $7)
         RETURNING *",
    )
    .bind(doc_id)
    .bind(user_id)
    .bind(&original_name)
    .bind(&format)
    .bind(data.len() as i64)
    .bind(&rel_path)
    .bind(&content)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(doc_to_info(doc, None)))
}

async fn get_personal_doc(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(doc_id): Path<Uuid>,
) -> Result<Json<KbDocument>> {
    let user_id = Uuid::parse_str(&claims.sub)
        .map_err(|_| Error::BadRequest("Invalid user ID".into()))?;

    let doc = sqlx::query_as::<_, KbDocument>(
        "SELECT * FROM kb_documents WHERE id = $1 AND owner_type = 'personal' AND owner_id = $2",
    )
    .bind(doc_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| Error::NotFound("Document not found".into()))?;

    Ok(Json(doc))
}

async fn update_personal_doc(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(doc_id): Path<Uuid>,
    Json(payload): Json<UpdateDocRequest>,
) -> Result<Json<KbDocument>> {
    let user_id = Uuid::parse_str(&claims.sub)
        .map_err(|_| Error::BadRequest("Invalid user ID".into()))?;

    let existing = sqlx::query_as::<_, KbDocument>(
        "SELECT * FROM kb_documents WHERE id = $1 AND owner_type = 'personal' AND owner_id = $2",
    )
    .bind(doc_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| Error::NotFound("Document not found".into()))?;

    let existing_content = existing.content.unwrap_or_default();
    let new_content = payload.content.as_ref().unwrap_or(&existing_content);
    let new_size = new_content.len() as i64;

    if let Some(ref content) = payload.content {
        let full_path = std::path::Path::new(&state.config.upload_dir).join(&existing.file_path);
        tokio::fs::write(&full_path, content.as_bytes()).await.ok();
    }

    let doc = sqlx::query_as::<_, KbDocument>(
        "UPDATE kb_documents SET
            name = COALESCE($1, name),
            content = COALESCE($2, content),
            tags = COALESCE($3, tags),
            description = COALESCE($4, description),
            size = $5,
            updated_at = NOW()
         WHERE id = $6 AND owner_type = 'personal' AND owner_id = $7
         RETURNING *",
    )
    .bind(&payload.name)
    .bind(&payload.content)
    .bind(&payload.tags)
    .bind(&payload.description)
    .bind(new_size)
    .bind(doc_id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(doc))
}

async fn delete_personal_doc(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(doc_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>> {
    let user_id = Uuid::parse_str(&claims.sub)
        .map_err(|_| Error::BadRequest("Invalid user ID".into()))?;

    let doc = sqlx::query_as::<_, KbDocument>(
        "DELETE FROM kb_documents WHERE id = $1 AND owner_type = 'personal' AND owner_id = $2 RETURNING *",
    )
    .bind(doc_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| Error::NotFound("Document not found".into()))?;

    let full_path = std::path::Path::new(&state.config.upload_dir).join(&doc.file_path);
    tokio::fs::remove_file(&full_path).await.ok();

    Ok(Json(serde_json::json!({ "message": "Document deleted" })))
}

async fn download_doc(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(doc_id): Path<Uuid>,
) -> Result<axum::response::Response> {
    let user_id = Uuid::parse_str(&claims.sub)
        .map_err(|_| Error::BadRequest("Invalid user ID".into()))?;

    let doc = sqlx::query_as::<_, KbDocument>(
        "SELECT * FROM kb_documents WHERE id = $1 AND owner_type = 'personal' AND owner_id = $2",
    )
    .bind(doc_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| Error::NotFound("Document not found".into()))?;

    serve_doc_file(&state.config.upload_dir, &doc).await
}

// ── 团队知识库 ──

async fn list_team_docs(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
) -> Result<Json<Vec<KbDocumentInfo>>> {
    let user_id = Uuid::parse_str(&claims.sub)
        .map_err(|_| Error::BadRequest("Invalid user ID".into()))?;
    check_team_membership(&state.db, team_id, user_id).await?;

    #[derive(sqlx::FromRow)]
    #[allow(dead_code)]
    struct DocWithUploader {
        id: Uuid,
        owner_type: String,
        owner_id: Uuid,
        uploader_id: Uuid,
        name: String,
        format: String,
        size: i64,
        file_path: String,
        content: Option<String>,
        tags: Vec<String>,
        description: Option<String>,
        created_at: chrono::DateTime<chrono::Utc>,
        updated_at: chrono::DateTime<chrono::Utc>,
        uploader_name: Option<String>,
    }

    let rows = sqlx::query_as::<_, DocWithUploader>(
        "SELECT d.*, u.username as uploader_name
         FROM kb_documents d
         JOIN users u ON d.uploader_id = u.id
         WHERE d.owner_type = 'team' AND d.owner_id = $1
         ORDER BY d.updated_at DESC",
    )
    .bind(team_id)
    .fetch_all(&state.db)
    .await?;

    let docs: Vec<KbDocumentInfo> = rows.into_iter().map(|d| KbDocumentInfo {
        id: d.id,
        owner_type: d.owner_type,
        owner_id: d.owner_id,
        uploader_id: d.uploader_id,
        name: d.name,
        format: d.format,
        size: d.size,
        tags: d.tags,
        description: d.description,
        created_at: d.created_at,
        updated_at: d.updated_at,
        uploader_name: d.uploader_name,
    }).collect();

    Ok(Json(docs))
}

async fn create_team_doc(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    Json(payload): Json<CreateDocRequest>,
) -> Result<Json<KbDocumentInfo>> {
    let user_id = Uuid::parse_str(&claims.sub)
        .map_err(|_| Error::BadRequest("Invalid user ID".into()))?;
    check_team_membership(&state.db, team_id, user_id).await?;

    let format = payload.format.as_deref().unwrap_or("md").to_string();
    validate_format(&format)?;

    let content_bytes = payload.content.as_bytes();
    if content_bytes.len() > MAX_DOC_SIZE {
        return Err(Error::BadRequest("Document too large (max 10MB)".into()));
    }

    let doc_id = Uuid::new_v4();
    let filename = format!("{}_{}.{}", doc_id, sanitize_filename(&payload.name), format);
    let rel_path = save_doc_file(
        &state.config.upload_dir,
        &format!("teams/{}", team_id),
        &filename,
        content_bytes,
    ).await?;

    let doc = sqlx::query_as::<_, KbDocument>(
        "INSERT INTO kb_documents (id, owner_type, owner_id, uploader_id, name, format, size, file_path, content, tags, description)
         VALUES ($1, 'team', $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *",
    )
    .bind(doc_id)
    .bind(team_id)
    .bind(user_id)
    .bind(&payload.name)
    .bind(&format)
    .bind(content_bytes.len() as i64)
    .bind(&rel_path)
    .bind(&payload.content)
    .bind(&payload.tags)
    .bind(&payload.description)
    .fetch_one(&state.db)
    .await?;

    let uploader_name = get_username(&state.db, user_id).await;
    Ok(Json(doc_to_info(doc, uploader_name)))
}

async fn upload_team_doc(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path(team_id): Path<Uuid>,
    mut multipart: Multipart,
) -> Result<Json<KbDocumentInfo>> {
    let user_id = Uuid::parse_str(&claims.sub)
        .map_err(|_| Error::BadRequest("Invalid user ID".into()))?;
    check_team_membership(&state.db, team_id, user_id).await?;

    let field = multipart.next_field().await
        .map_err(|_| Error::BadRequest("Invalid multipart data".into()))?
        .ok_or_else(|| Error::BadRequest("No file uploaded".into()))?;

    let original_name = field.file_name()
        .unwrap_or("untitled.txt")
        .to_string();
    let format = detect_format(&original_name);
    validate_format(&format)?;

    let data = field.bytes().await
        .map_err(|_| Error::BadRequest("Failed to read file data".into()))?;
    if data.len() > MAX_DOC_SIZE {
        return Err(Error::BadRequest("File too large (max 10MB)".into()));
    }

    let content = String::from_utf8_lossy(&data).to_string();
    let doc_id = Uuid::new_v4();
    let filename = format!("{}_{}", doc_id, sanitize_filename(&original_name));
    let rel_path = save_doc_file(
        &state.config.upload_dir,
        &format!("teams/{}", team_id),
        &filename,
        &data,
    ).await?;

    let doc = sqlx::query_as::<_, KbDocument>(
        "INSERT INTO kb_documents (id, owner_type, owner_id, uploader_id, name, format, size, file_path, content)
         VALUES ($1, 'team', $2, $3, $4, $5, $6, $7, $8)
         RETURNING *",
    )
    .bind(doc_id)
    .bind(team_id)
    .bind(user_id)
    .bind(&original_name)
    .bind(&format)
    .bind(data.len() as i64)
    .bind(&rel_path)
    .bind(&content)
    .fetch_one(&state.db)
    .await?;

    let uploader_name = get_username(&state.db, user_id).await;
    Ok(Json(doc_to_info(doc, uploader_name)))
}

async fn get_team_doc(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((team_id, doc_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<KbDocument>> {
    let user_id = Uuid::parse_str(&claims.sub)
        .map_err(|_| Error::BadRequest("Invalid user ID".into()))?;
    check_team_membership(&state.db, team_id, user_id).await?;

    let doc = sqlx::query_as::<_, KbDocument>(
        "SELECT * FROM kb_documents WHERE id = $1 AND owner_type = 'team' AND owner_id = $2",
    )
    .bind(doc_id)
    .bind(team_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| Error::NotFound("Document not found".into()))?;

    Ok(Json(doc))
}

async fn update_team_doc(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((team_id, doc_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<UpdateDocRequest>,
) -> Result<Json<KbDocument>> {
    let user_id = Uuid::parse_str(&claims.sub)
        .map_err(|_| Error::BadRequest("Invalid user ID".into()))?;
    check_team_membership(&state.db, team_id, user_id).await?;

    let existing = sqlx::query_as::<_, KbDocument>(
        "SELECT * FROM kb_documents WHERE id = $1 AND owner_type = 'team' AND owner_id = $2",
    )
    .bind(doc_id)
    .bind(team_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| Error::NotFound("Document not found".into()))?;

    check_team_admin_or_uploader(&state.db, team_id, user_id, existing.uploader_id).await?;

    let existing_content = existing.content.unwrap_or_default();
    let new_content = payload.content.as_ref().unwrap_or(&existing_content);
    let new_size = new_content.len() as i64;

    if let Some(ref content) = payload.content {
        let full_path = std::path::Path::new(&state.config.upload_dir).join(&existing.file_path);
        tokio::fs::write(&full_path, content.as_bytes()).await.ok();
    }

    let doc = sqlx::query_as::<_, KbDocument>(
        "UPDATE kb_documents SET
            name = COALESCE($1, name),
            content = COALESCE($2, content),
            tags = COALESCE($3, tags),
            description = COALESCE($4, description),
            size = $5,
            updated_at = NOW()
         WHERE id = $6 AND owner_type = 'team' AND owner_id = $7
         RETURNING *",
    )
    .bind(&payload.name)
    .bind(&payload.content)
    .bind(&payload.tags)
    .bind(&payload.description)
    .bind(new_size)
    .bind(doc_id)
    .bind(team_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(doc))
}

async fn delete_team_doc(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((team_id, doc_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>> {
    let user_id = Uuid::parse_str(&claims.sub)
        .map_err(|_| Error::BadRequest("Invalid user ID".into()))?;
    check_team_membership(&state.db, team_id, user_id).await?;

    let doc = sqlx::query_as::<_, KbDocument>(
        "SELECT * FROM kb_documents WHERE id = $1 AND owner_type = 'team' AND owner_id = $2",
    )
    .bind(doc_id)
    .bind(team_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| Error::NotFound("Document not found".into()))?;

    check_team_admin_or_uploader(&state.db, team_id, user_id, doc.uploader_id).await?;

    sqlx::query("DELETE FROM kb_documents WHERE id = $1")
        .bind(doc_id)
        .execute(&state.db)
        .await?;

    let full_path = std::path::Path::new(&state.config.upload_dir).join(&doc.file_path);
    tokio::fs::remove_file(&full_path).await.ok();

    Ok(Json(serde_json::json!({ "message": "Document deleted" })))
}

async fn download_team_doc(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    Path((team_id, doc_id)): Path<(Uuid, Uuid)>,
) -> Result<axum::response::Response> {
    let user_id = Uuid::parse_str(&claims.sub)
        .map_err(|_| Error::BadRequest("Invalid user ID".into()))?;
    check_team_membership(&state.db, team_id, user_id).await?;

    let doc = sqlx::query_as::<_, KbDocument>(
        "SELECT * FROM kb_documents WHERE id = $1 AND owner_type = 'team' AND owner_id = $2",
    )
    .bind(doc_id)
    .bind(team_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| Error::NotFound("Document not found".into()))?;

    serve_doc_file(&state.config.upload_dir, &doc).await
}

// ── 通用工具 ──

async fn serve_doc_file(upload_dir: &str, doc: &KbDocument) -> Result<axum::response::Response> {
    let full_path = std::path::Path::new(upload_dir).join(&doc.file_path);
    let data = tokio::fs::read(&full_path).await
        .map_err(|_| Error::NotFound("File not found on disk".into()))?;

    let content_type = match doc.format.as_str() {
        "md" | "markdown" => "text/markdown; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        _ => "text/plain; charset=utf-8",
    };

    Ok(axum::response::Response::builder()
        .header("Content-Type", content_type)
        .header(
            "Content-Disposition",
            format!("attachment; filename=\"{}\"", doc.name),
        )
        .body(Body::from(data))
        .unwrap())
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .take(64)
        .collect()
}

fn doc_to_info(doc: KbDocument, uploader_name: Option<String>) -> KbDocumentInfo {
    KbDocumentInfo {
        id: doc.id,
        owner_type: doc.owner_type,
        owner_id: doc.owner_id,
        uploader_id: doc.uploader_id,
        name: doc.name,
        format: doc.format,
        size: doc.size,
        tags: doc.tags,
        description: doc.description,
        created_at: doc.created_at,
        updated_at: doc.updated_at,
        uploader_name,
    }
}

async fn get_username(db: &sqlx::PgPool, user_id: Uuid) -> Option<String> {
    sqlx::query_scalar::<_, String>("SELECT username FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
}
