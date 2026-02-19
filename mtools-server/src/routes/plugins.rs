use crate::{routes::AppState, services::auth::Claims, Error, Result};
use axum::{
    extract::{Extension, Multipart, Path as AxumPath, Query, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

const MAX_PLUGIN_ZIP_BYTES: usize = 50 * 1024 * 1024;

pub fn public_routes_no_layer() -> Router<Arc<AppState>> {
    Router::new()
        .route("/market/apps", get(list_market_apps))
        .route("/compat-matrix", get(get_compat_matrix))
        .route("/market/apps/{slug}/package", get(get_market_package))
        .route(
            "/market/apps/{slug}/install-report",
            post(report_market_install),
        )
}

pub fn private_routes_no_layer() -> Router<Arc<AppState>> {
    Router::new()
        .route("/submissions", post(create_submission))
        .route("/submissions/preflight", post(plugin_submission_preflight))
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CompatMatrixItem {
    capability: String,
    status: String,
    notes: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompatMatrixResponse {
    matrix: Vec<CompatMatrixItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreflightReport {
    ok: bool,
    file_size_bytes: usize,
    manifest: Option<ManifestSummary>,
    compatibility: Vec<CompatMatrixItem>,
    risks: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SubmissionResponse {
    submission_id: Uuid,
    status: String,
    message: String,
    uploaded_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct MarketAppItem {
    id: Uuid,
    slug: String,
    name: String,
    description: String,
    tag: String,
    version: String,
    installs: i64,
    is_official: bool,
    current_version: Option<String>,
    package_size_bytes: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarketPackageResponse {
    slug: String,
    version: String,
    package_sha256: String,
    package_size_bytes: i64,
    download_url: String,
    is_official: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarketAppsResponse {
    items: Vec<MarketAppItem>,
    total: i64,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct InstallReportResponse {
    slug: String,
    installs: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ManifestSummary {
    plugin_name: String,
    version: String,
    features_count: usize,
    permissions: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedManifest {
    #[serde(default, alias = "name")]
    plugin_name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    features: Vec<serde_json::Value>,
    #[serde(default)]
    mtools: Option<ManifestMtools>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestMtools {
    #[serde(default)]
    permissions: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct MarketAppsQuery {
    q: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct MarketPackageQuery {
    version: Option<String>,
}

fn build_compat_matrix() -> Vec<CompatMatrixItem> {
    vec![
        CompatMatrixItem {
            capability: "lifecycle.onPluginEnter/onPluginOut".to_string(),
            status: "supported".to_string(),
            notes: None,
        },
        CompatMatrixItem {
            capability: "ui.setSubInput".to_string(),
            status: "supported".to_string(),
            notes: None,
        },
        CompatMatrixItem {
            capability: "storage.dbStorage".to_string(),
            status: "supported".to_string(),
            notes: None,
        },
        CompatMatrixItem {
            capability: "shell.openExternal/openPath".to_string(),
            status: "supported".to_string(),
            notes: Some("需声明 shell 权限".to_string()),
        },
        CompatMatrixItem {
            capability: "screenCapture API".to_string(),
            status: "partial".to_string(),
            notes: Some("按宿主平台能力提供".to_string()),
        },
        CompatMatrixItem {
            capability: "platform payment APIs".to_string(),
            status: "not_supported".to_string(),
            notes: Some("一期未开放".to_string()),
        },
    ]
}

fn parse_user_id(claims: &Claims) -> Result<Uuid> {
    Uuid::parse_str(&claims.sub).map_err(|_| Error::BadRequest("Invalid user ID".into()))
}

async fn get_compat_matrix() -> Json<CompatMatrixResponse> {
    Json(CompatMatrixResponse {
        matrix: build_compat_matrix(),
    })
}

async fn list_market_apps(
    State(state): State<Arc<AppState>>,
    Query(query): Query<MarketAppsQuery>,
) -> Result<Json<MarketAppsResponse>> {
    let limit = query.limit.unwrap_or(20).clamp(1, 100);
    let offset = query.offset.unwrap_or(0).max(0);
    let keyword = query
        .q
        .as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let total: i64 = sqlx::query_scalar(
        r#"
        SELECT COUNT(*)
        FROM plugin_market_apps
        WHERE status = 'published'
          AND ($1::TEXT IS NULL
               OR name ILIKE '%' || $1 || '%'
               OR description ILIKE '%' || $1 || '%'
               OR tag ILIKE '%' || $1 || '%')
        "#,
    )
    .bind(keyword.as_deref())
    .fetch_one(&state.db)
    .await?;

    let items: Vec<MarketAppItem> = sqlx::query_as(
        r#"
        SELECT
            a.id,
            a.slug,
            a.name,
            a.description,
            a.tag,
            COALESCE(r.version, a.version) AS version,
            a.installs::BIGINT AS installs,
            a.is_official,
            r.version AS current_version,
            r.package_size_bytes::BIGINT AS package_size_bytes
        FROM plugin_market_apps a
        LEFT JOIN plugin_market_releases r
          ON r.id = a.current_release_id
         AND r.status = 'published'
        WHERE a.status = 'published'
          AND ($1::TEXT IS NULL
               OR a.name ILIKE '%' || $1 || '%'
               OR a.description ILIKE '%' || $1 || '%'
               OR a.tag ILIKE '%' || $1 || '%')
        ORDER BY a.installs DESC, a.created_at DESC
        LIMIT $2 OFFSET $3
        "#,
    )
    .bind(keyword.as_deref())
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(MarketAppsResponse { items, total }))
}

#[derive(Debug, sqlx::FromRow)]
struct MarketPackageRow {
    slug: String,
    is_official: bool,
    version: String,
    package_sha256: String,
    package_size_bytes: i64,
    package_file_path: String,
}

fn to_download_url(package_file_path: &str) -> String {
    let normalized = package_file_path
        .trim()
        .trim_start_matches('/')
        .replace('\\', "/");
    if normalized.starts_with("uploads/") {
        format!("/{}", normalized)
    } else {
        format!("/uploads/{}", normalized)
    }
}

async fn get_market_package(
    State(state): State<Arc<AppState>>,
    AxumPath(slug): AxumPath<String>,
    Query(query): Query<MarketPackageQuery>,
) -> Result<Json<MarketPackageResponse>> {
    let requested_version = query
        .version
        .as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    let app_exists: Option<(Uuid, bool)> = sqlx::query_as(
        r#"
        SELECT id, is_official
        FROM plugin_market_apps
        WHERE slug = $1
          AND status = 'published'
        "#,
    )
    .bind(&slug)
    .fetch_optional(&state.db)
    .await?;

    let (app_id, app_is_official) = app_exists.ok_or_else(|| {
        Error::not_found_code(
            "PLUGIN_PACKAGE_NOT_FOUND",
            "插件不存在或未发布",
            Some(serde_json::json!({ "slug": slug })),
        )
    })?;

    let selected_release: Option<MarketPackageRow> =
        if let Some(version) = requested_version.as_deref() {
            sqlx::query_as(
                r#"
            SELECT
                a.slug,
                a.is_official,
                r.version,
                r.package_sha256,
                r.package_size_bytes::BIGINT AS package_size_bytes,
                r.package_file_path
            FROM plugin_market_apps a
            JOIN plugin_market_releases r ON r.app_id = a.id
            WHERE a.id = $1
              AND r.status = 'published'
              AND r.version = $2
            ORDER BY r.created_at DESC
            LIMIT 1
            "#,
            )
            .bind(app_id)
            .bind(version)
            .fetch_optional(&state.db)
            .await?
        } else {
            let current: Option<MarketPackageRow> = sqlx::query_as(
                r#"
            SELECT
                a.slug,
                a.is_official,
                r.version,
                r.package_sha256,
                r.package_size_bytes::BIGINT AS package_size_bytes,
                r.package_file_path
            FROM plugin_market_apps a
            JOIN plugin_market_releases r ON r.id = a.current_release_id
            WHERE a.id = $1
              AND r.status = 'published'
            LIMIT 1
            "#,
            )
            .bind(app_id)
            .fetch_optional(&state.db)
            .await?;

            if current.is_some() {
                current
            } else {
                sqlx::query_as(
                    r#"
                SELECT
                    a.slug,
                    a.is_official,
                    r.version,
                    r.package_sha256,
                    r.package_size_bytes::BIGINT AS package_size_bytes,
                    r.package_file_path
                FROM plugin_market_apps a
                JOIN plugin_market_releases r ON r.app_id = a.id
                WHERE a.id = $1
                  AND r.status = 'published'
                ORDER BY r.created_at DESC
                LIMIT 1
                "#,
                )
                .bind(app_id)
                .fetch_optional(&state.db)
                .await?
            }
        };

    let release = selected_release.ok_or_else(|| {
        Error::api(
            StatusCode::NOT_FOUND,
            "PLUGIN_PACKAGE_NOT_FOUND",
            "插件包不存在或未发布",
            Some(serde_json::json!({
                "slug": slug,
                "requested_version": requested_version,
                "is_official": app_is_official,
            })),
        )
    })?;

    Ok(Json(MarketPackageResponse {
        slug: release.slug,
        version: release.version,
        package_sha256: release.package_sha256,
        package_size_bytes: release.package_size_bytes,
        download_url: to_download_url(&release.package_file_path),
        is_official: release.is_official,
    }))
}

async fn report_market_install(
    State(state): State<Arc<AppState>>,
    AxumPath(slug): AxumPath<String>,
) -> Result<Json<InstallReportResponse>> {
    let updated: Option<InstallReportResponse> = sqlx::query_as(
        r#"
        UPDATE plugin_market_apps
        SET installs = COALESCE(installs, 0) + 1,
            updated_at = NOW()
        WHERE slug = $1
          AND status = 'published'
        RETURNING slug, installs::BIGINT AS installs
        "#,
    )
    .bind(&slug)
    .fetch_optional(&state.db)
    .await?;

    let row = updated.ok_or_else(|| {
        Error::not_found_code(
            "PLUGIN_PACKAGE_NOT_FOUND",
            "插件不存在或未发布",
            Some(serde_json::json!({ "slug": slug })),
        )
    })?;

    Ok(Json(row))
}

fn extract_manifest_from_zip(
    bytes: &[u8],
) -> Result<(
    Option<serde_json::Value>,
    Option<ManifestSummary>,
    Vec<String>,
)> {
    let mut risks = Vec::new();
    let tmp_path = std::env::temp_dir().join(format!("plugin-preflight-{}.zip", Uuid::new_v4()));
    std::fs::write(&tmp_path, bytes).map_err(|e| {
        Error::bad_request_code("INVALID_UPLOAD", format!("写入临时文件失败: {}", e), None)
    })?;

    let list_output = std::process::Command::new("unzip")
        .args(["-Z", "-1", &tmp_path.to_string_lossy()])
        .output();

    let (manifest_content, manifest_entry_name) = match list_output {
        Ok(output) if output.status.success() => {
            let entries_raw = String::from_utf8_lossy(&output.stdout);
            let entries: Vec<String> = entries_raw
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();

            for entry in &entries {
                if entry.contains("..") || entry.starts_with('/') || entry.starts_with('\\') {
                    let _ = std::fs::remove_file(&tmp_path);
                    return Err(Error::bad_request_code(
                        "ZIP_PATH_TRAVERSAL",
                        "zip 内包含非法路径",
                        Some(serde_json::json!({ "entry": entry })),
                    ));
                }
            }

            let manifest_entry = entries.iter().find(|name| {
                let lowered = name.to_lowercase();
                lowered.ends_with("/plugin.json")
                    || lowered.ends_with("/package.json")
                    || lowered == "plugin.json"
                    || lowered == "package.json"
            });

            if let Some(entry) = manifest_entry {
                let content_output = std::process::Command::new("unzip")
                    .args(["-p", &tmp_path.to_string_lossy(), entry])
                    .output();
                match content_output {
                    Ok(data) if data.status.success() => {
                        let text = String::from_utf8_lossy(&data.stdout).to_string();
                        (Some(text), Some(entry.clone()))
                    }
                    _ => {
                        risks.push("无法读取清单内容（unzip -p 失败）".to_string());
                        (None, Some(entry.clone()))
                    }
                }
            } else {
                (None, None)
            }
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let _ = std::fs::remove_file(&tmp_path);
            return Err(Error::bad_request_code(
                "INVALID_ZIP",
                format!("无法解析 zip: {}", stderr.trim()),
                None,
            ));
        }
        Err(_) => {
            risks.push("服务器未安装 unzip，跳过 zip 深度解析".to_string());
            (None, None)
        }
    };
    let _ = std::fs::remove_file(&tmp_path);

    if let Some(content) = manifest_content {
        match serde_json::from_str::<ParsedManifest>(&content) {
            Ok(manifest) => {
                let manifest_json = serde_json::to_value(&manifest).ok();
                let permissions = manifest.mtools.map(|m| m.permissions).unwrap_or_default();
                let plugin_name = if manifest.plugin_name.trim().is_empty() {
                    "未命名插件".to_string()
                } else {
                    manifest.plugin_name
                };
                let version = if manifest.version.trim().is_empty() {
                    "0.0.0".to_string()
                } else {
                    manifest.version
                };
                let summary = ManifestSummary {
                    plugin_name,
                    version,
                    features_count: manifest.features.len(),
                    permissions,
                };
                Ok((manifest_json, Some(summary), risks))
            }
            Err(e) => {
                risks.push(format!("manifest JSON 解析失败: {}", e));
                Ok((None, None, risks))
            }
        }
    } else {
        let target = manifest_entry_name.unwrap_or_else(|| "plugin.json/package.json".to_string());
        risks.push(format!("未找到可解析清单文件: {}", target));
        Ok((None, None, risks))
    }
}

async fn plugin_submission_preflight(
    State(_state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    mut multipart: Multipart,
) -> Result<Json<PreflightReport>> {
    let _user_id = parse_user_id(&claims)?;

    let mut zip_bytes: Option<Vec<u8>> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| Error::bad_request_code("INVALID_MULTIPART", e.to_string(), None))?
    {
        if field.name() == Some("file") {
            let data = field
                .bytes()
                .await
                .map_err(|e| Error::bad_request_code("INVALID_UPLOAD", e.to_string(), None))?;
            if data.len() > MAX_PLUGIN_ZIP_BYTES {
                return Err(Error::bad_request_code(
                    "PLUGIN_PACKAGE_TOO_LARGE",
                    "插件包大小超过 50MB 限制",
                    Some(serde_json::json!({
                        "max_bytes": MAX_PLUGIN_ZIP_BYTES,
                        "actual_bytes": data.len(),
                    })),
                ));
            }
            zip_bytes = Some(data.to_vec());
            break;
        }
    }

    let bytes = zip_bytes.ok_or_else(|| {
        Error::bad_request_code(
            "PLUGIN_PACKAGE_REQUIRED",
            "请上传 file 字段（zip 包）",
            None,
        )
    })?;

    let compatibility = build_compat_matrix();
    let (_manifest_json, manifest_summary, mut risks) = extract_manifest_from_zip(&bytes)?;
    let mut ok = manifest_summary.is_some();
    if let Some(summary) = &manifest_summary {
        if summary.features_count == 0 {
            ok = false;
            risks.push("features 为空，插件无法在市场中正常展示".to_string());
        }
        if summary.permissions.iter().any(|p| p == "shell") {
            risks.push("声明了 shell 权限，审核将提高安全等级".to_string());
        }
        if summary.permissions.iter().any(|p| p == "filesystem") {
            risks.push("声明了 filesystem 权限，请确认最小权限原则".to_string());
        }
        if summary.permissions.iter().any(|p| p == "system") {
            risks.push("声明了 system 权限，需补充使用场景说明".to_string());
        }
    }

    Ok(Json(PreflightReport {
        ok,
        file_size_bytes: bytes.len(),
        manifest: manifest_summary,
        compatibility,
        risks,
    }))
}

async fn create_submission(
    State(state): State<Arc<AppState>>,
    Extension(claims): Extension<Claims>,
    mut multipart: Multipart,
) -> Result<Json<SubmissionResponse>> {
    let user_id = parse_user_id(&claims)?;

    let mut zip_size: Option<usize> = None;
    let mut file_name = "plugin.zip".to_string();
    let mut zip_bytes: Option<Vec<u8>> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| Error::bad_request_code("INVALID_MULTIPART", e.to_string(), None))?
    {
        if field.name() == Some("file") {
            if let Some(name) = field.file_name() {
                file_name = name.to_string();
            }
            let data = field
                .bytes()
                .await
                .map_err(|e| Error::bad_request_code("INVALID_UPLOAD", e.to_string(), None))?;
            if data.len() > MAX_PLUGIN_ZIP_BYTES {
                return Err(Error::bad_request_code(
                    "PLUGIN_PACKAGE_TOO_LARGE",
                    "插件包大小超过 50MB 限制",
                    Some(serde_json::json!({
                        "max_bytes": MAX_PLUGIN_ZIP_BYTES,
                        "actual_bytes": data.len(),
                    })),
                ));
            }
            zip_size = Some(data.len());
            zip_bytes = Some(data.to_vec());
            break;
        }
    }

    if zip_size.is_none() {
        return Err(Error::bad_request_code(
            "PLUGIN_PACKAGE_REQUIRED",
            "请上传 file 字段（zip 包）",
            None,
        ));
    }

    let submission_id = Uuid::new_v4();
    let bytes = zip_bytes.unwrap_or_default();
    let (manifest_json, _summary, _risks) = extract_manifest_from_zip(&bytes)?;
    sqlx::query(
        r#"
        INSERT INTO plugin_submissions (
            id, user_id, file_name, package_size_bytes, manifest_json, status, created_at, updated_at
        ) VALUES (
            $1, $2, $3, $4, $5, 'pending_review', NOW(), NOW()
        )
        "#,
    )
    .bind(submission_id)
    .bind(user_id)
    .bind(&file_name)
    .bind(zip_size.unwrap_or(0) as i64)
    .bind(manifest_json)
    .execute(&state.db)
    .await?;

    tracing::info!(
        "Plugin submission stored: submission_id={}, user_id={}, size_bytes={}",
        submission_id,
        user_id,
        zip_size.unwrap_or(0)
    );

    Ok(Json(SubmissionResponse {
        submission_id,
        status: "pending_review".to_string(),
        message: "提交成功，已进入人工审核队列".to_string(),
        uploaded_at: chrono::Utc::now(),
    }))
}
