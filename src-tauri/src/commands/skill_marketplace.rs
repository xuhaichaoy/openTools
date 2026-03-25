use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use tauri::Manager;
use url::Url;
use zip::ZipArchive;

const DEFAULT_CLAWHUB_SITE_URL: &str = "https://clawhub.ai";
const DEFAULT_CLAWHUB_REGISTRY_URL: &str = "https://clawhub.ai";
const CLAWHUB_USER_AGENT: &str = "51ToolBox/ClawHubRuntime";

#[derive(Debug, Clone, Serialize)]
pub struct ClawHubCliStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub binary: Option<String>,
    pub mode: Option<String>,
    pub site_url: Option<String>,
    pub registry_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClawHubVerifyResult {
    pub ok: bool,
    pub stdout: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClawHubSearchResult {
    pub entries: Vec<ClawHubSearchEntry>,
    pub raw_output: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClawHubSearchEntry {
    pub slug: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub version: Option<String>,
    pub origin_url: Option<String>,
    pub site_url: Option<String>,
    pub registry_url: Option<String>,
    pub source_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClawHubInstallResult {
    pub skill_md: String,
    pub stdout: String,
    pub installed_spec: String,
    pub detected_skill_path: Option<String>,
    pub bundle_root_path: Option<String>,
    pub bundle_hash: Option<String>,
    pub installed_version: Option<String>,
    pub origin_url: Option<String>,
    pub site_url: Option<String>,
    pub registry_url: Option<String>,
    pub legacy_fallback: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ClawHubSearchRequest {
    pub query: String,
    pub limit: Option<u32>,
    pub token: Option<String>,
    pub site_url: Option<String>,
    pub registry_url: Option<String>,
    pub source_kind: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ClawHubInstallRequest {
    pub slug: String,
    pub version: Option<String>,
    pub token: Option<String>,
    pub site_url: Option<String>,
    pub registry_url: Option<String>,
    pub source_kind: Option<String>,
    pub bundle_base64: Option<String>,
}

#[derive(Debug, Clone)]
struct HttpClawHubContext {
    site_url: String,
    registry_url: String,
}

#[derive(Debug)]
struct HttpClawHubBundle {
    bytes: Vec<u8>,
    version: Option<String>,
    origin_url: Option<String>,
}

#[derive(Debug)]
struct InstalledBundle {
    skill_md: String,
    skill_md_parent: Option<String>,
    bundle_root_path: String,
    bundle_hash: String,
    legacy_fallback: bool,
}

#[tauri::command]
pub async fn skill_marketplace_clawhub_status() -> Result<ClawHubCliStatus, String> {
    Ok(ClawHubCliStatus {
        installed: true,
        version: Some("http-runtime".to_string()),
        binary: Some("embedded-http".to_string()),
        mode: Some("http".to_string()),
        site_url: Some(DEFAULT_CLAWHUB_SITE_URL.to_string()),
        registry_url: Some(DEFAULT_CLAWHUB_REGISTRY_URL.to_string()),
    })
}

#[tauri::command]
pub async fn skill_marketplace_clawhub_verify(
    _app: tauri::AppHandle,
    token: Option<String>,
    _site_url: Option<String>,
    _registry_url: Option<String>,
) -> Result<ClawHubVerifyResult, String> {
    let trimmed_token = token.unwrap_or_default().trim().to_string();
    if trimmed_token.is_empty() {
        return Err("请先填写 ClawHub token".to_string());
    }

    let http_context = resolve_http_context();
    let stdout = verify_with_http(&http_context, trimmed_token.as_str()).await?;
    Ok(ClawHubVerifyResult { ok: true, stdout })
}

#[tauri::command]
pub async fn skill_marketplace_clawhub_search(
    request: ClawHubSearchRequest,
) -> Result<ClawHubSearchResult, String> {
    let query = request.query.trim().to_string();
    if query.is_empty() {
        return Err("搜索关键词不能为空".to_string());
    }
    let http_context = resolve_http_context();
    let limit = request.limit.unwrap_or(8).clamp(1, 20) as usize;
    let token = request
        .token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let source_kind = request
        .source_kind
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    search_with_http(
        &http_context,
        query.as_str(),
        limit,
        token.as_deref(),
        source_kind.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn skill_marketplace_clawhub_install(
    app: tauri::AppHandle,
    request: ClawHubInstallRequest,
) -> Result<ClawHubInstallResult, String> {
    let slug = request.slug.trim().to_string();
    if slug.is_empty() {
        return Err("Skill slug 不能为空".to_string());
    }
    let http_context = resolve_http_context();
    let token = request
        .token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let version = request
        .version
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let _source_kind = request.source_kind.as_deref();
    let bundle_base64 = request
        .bundle_base64
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    if let Some(bundle_base64) = bundle_base64 {
        let version_tag = version.clone().unwrap_or_else(|| "latest".to_string());
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("获取应用数据目录失败: {error}"))?;
        let slug_for_path = slug.replace('/', "__");
        let bytes = STANDARD
            .decode(bundle_base64.as_bytes())
            .map_err(|error| format!("解析团队代理返回的 bundle_base64 失败: {error}"))?;
        let installed = tokio::task::spawn_blocking(move || {
            install_bundle_to_root(
                app_data_dir
                    .join("skill-bundles")
                    .join("clawhub")
                    .join(slug_for_path)
                    .join(version_tag),
                bytes,
            )
        })
        .await
        .map_err(|error| format!("安装团队代理 bundle 任务失败: {error}"))??;

        return Ok(ClawHubInstallResult {
            skill_md: installed.skill_md,
            stdout: "已通过团队代理下载 bundle，并在本地完成安装".to_string(),
            installed_spec: match version.as_deref() {
                Some(version) => format!("{slug}@{version}"),
                None => slug.clone(),
            },
            detected_skill_path: installed.skill_md_parent,
            bundle_root_path: Some(installed.bundle_root_path),
            bundle_hash: Some(installed.bundle_hash),
            installed_version: version,
            origin_url: None,
            site_url: Some(http_context.site_url),
            registry_url: Some(http_context.registry_url),
            legacy_fallback: installed.legacy_fallback,
        });
    }

    install_with_http(
        &app,
        &http_context,
        slug.as_str(),
        version.as_deref(),
        token.as_deref(),
    )
    .await
}

fn resolve_http_context() -> HttpClawHubContext {
    HttpClawHubContext {
        site_url: DEFAULT_CLAWHUB_SITE_URL.to_string(),
        registry_url: DEFAULT_CLAWHUB_REGISTRY_URL.to_string(),
    }
}

fn build_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| format!("创建 ClawHub HTTP 客户端失败: {error}"))
}

fn apply_auth(request: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
    let request = request
        .header(ACCEPT, "application/json, application/zip, application/octet-stream;q=0.9, */*;q=0.8")
        .header(USER_AGENT, CLAWHUB_USER_AGENT);
    match token {
        Some(token) if !token.trim().is_empty() => {
            request.header(AUTHORIZATION, format!("Bearer {}", token.trim()))
        }
        _ => request,
    }
}

fn looks_like_skill_slug(value: &str) -> bool {
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

fn json_string(value: Option<&Value>) -> Option<String> {
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

fn is_http_url(value: &str) -> bool {
    value.starts_with("http://") || value.starts_with("https://")
}

fn resolve_relative_url(base: &str, value: &str) -> Option<String> {
    if is_http_url(value) {
        return Some(value.to_string());
    }
    let url = Url::parse(base).ok()?;
    let joined = url.join(value).ok()?;
    Some(joined.to_string())
}

fn extract_url_from_json(value: &Value, keys: &[&str], bases: &[&str]) -> Option<String> {
    match value {
        Value::Object(map) => {
            for key in keys {
                if let Some(candidate) = json_string(map.get(*key)) {
                    for base in bases {
                        if let Some(url) = resolve_relative_url(base, candidate.as_str()) {
                            return Some(url);
                        }
                    }
                }
            }
            for child in map.values() {
                if let Some(url) = extract_url_from_json(child, keys, bases) {
                    return Some(url);
                }
            }
            None
        }
        Value::Array(items) => items
            .iter()
            .find_map(|item| extract_url_from_json(item, keys, bases)),
        _ => None,
    }
}

fn extract_string_from_json(value: &Value, keys: &[&str]) -> Option<String> {
    match value {
        Value::Object(map) => {
            for key in keys {
                if let Some(candidate) = json_string(map.get(*key)) {
                    return Some(candidate);
                }
            }
            for child in map.values() {
                if let Some(text) = extract_string_from_json(child, keys) {
                    return Some(text);
                }
            }
            None
        }
        Value::Array(items) => items
            .iter()
            .find_map(|item| extract_string_from_json(item, keys)),
        _ => None,
    }
}

fn extract_version_from_json(value: &Value) -> Option<String> {
    match value {
        Value::Object(map) => {
            json_string(map.get("version"))
                .or_else(|| json_string(map.get("latest_version")))
                .or_else(|| json_string(map.get("installed_version")))
                .or_else(|| map.values().find_map(extract_version_from_json))
        }
        Value::Array(items) => items.iter().find_map(extract_version_from_json),
        _ => None,
    }
}

fn extract_origin_url_from_json(value: &Value, site_url: &str, registry_url: &str) -> Option<String> {
    extract_url_from_json(
        value,
        &["origin_url", "originUrl", "url", "site_url", "siteUrl"],
        &[site_url, registry_url],
    )
}

fn parse_http_search_entries(
    value: &Value,
    limit: usize,
    site_url: &str,
    registry_url: &str,
    source_kind: Option<&str>,
) -> Vec<ClawHubSearchEntry> {
    fn visit(
        value: &Value,
        entries: &mut Vec<ClawHubSearchEntry>,
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
                let slug = json_string(map.get("slug"))
                    .or_else(|| json_string(map.get("skill_slug")))
                    .or_else(|| json_string(map.get("id")))
                    .filter(|candidate| looks_like_skill_slug(candidate));

                if let Some(slug) = slug {
                    if seen.insert(slug.clone()) {
                        entries.push(ClawHubSearchEntry {
                            slug,
                            title: json_string(map.get("title"))
                                .or_else(|| json_string(map.get("name")))
                                .or_else(|| json_string(map.get("display_name"))),
                            description: json_string(map.get("description"))
                                .or_else(|| json_string(map.get("summary"))),
                            version: json_string(map.get("version"))
                                .or_else(|| json_string(map.get("latest_version"))),
                            origin_url: extract_origin_url_from_json(value, site_url, registry_url),
                            site_url: Some(site_url.to_string()),
                            registry_url: Some(registry_url.to_string()),
                            source_kind: source_kind.map(str::to_string),
                        });
                    }
                }

                for child in map.values() {
                    visit(child, entries, seen, limit, site_url, registry_url, source_kind);
                }
            }
            Value::Array(items) => {
                for item in items {
                    visit(item, entries, seen, limit, site_url, registry_url, source_kind);
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

async fn verify_with_http(context: &HttpClawHubContext, token: &str) -> Result<String, String> {
    let client = build_http_client()?;
    let candidates = [
        format!("{}/api/v1/auth/whoami", context.registry_url),
        format!("{}/api/v1/auth/whoami", context.site_url),
        format!("{}/api/v1/me", context.registry_url),
        format!("{}/api/v1/profile", context.site_url),
    ];
    let mut last_error = None;
    for url in candidates {
        let response = apply_auth(client.get(&url), Some(token))
            .send()
            .await
            .map_err(|error| format!("请求 ClawHub 验证接口失败 ({url}): {error}"))?;
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
            .map_err(|error| format!("读取 ClawHub 验证响应失败: {error}"))?;
        let trimmed = body.trim();
        if trimmed.is_empty() {
            return Ok("ClawHub token 验证成功".to_string());
        }
        return Ok(trimmed.to_string());
    }
    Err(last_error.unwrap_or_else(|| "ClawHub token 验证失败".to_string()))
}

async fn fetch_json_endpoint(
    client: &reqwest::Client,
    url: &str,
    token: Option<&str>,
) -> Result<Value, String> {
    let response = apply_auth(client.get(url), token)
        .send()
        .await
        .map_err(|error| format!("请求 ClawHub 接口失败 ({url}): {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "ClawHub 接口返回 {} ({url})",
            response.status()
        ));
    }
    response
        .json::<Value>()
        .await
        .map_err(|error| format!("解析 ClawHub JSON 响应失败 ({url}): {error}"))
}

async fn search_with_http(
    context: &HttpClawHubContext,
    query: &str,
    limit: usize,
    token: Option<&str>,
    source_kind: Option<&str>,
) -> Result<ClawHubSearchResult, String> {
    let client = build_http_client()?;
    let candidates = [
        format!(
            "{}/api/v1/search?q={}&limit={}",
            context.registry_url,
            encode_query_value(query),
            limit
        ),
        format!(
            "{}/api/v1/search?query={}&limit={}",
            context.registry_url,
            encode_query_value(query),
            limit
        ),
        format!(
            "{}/api/v1/search?q={}&limit={}",
            context.site_url,
            encode_query_value(query),
            limit
        ),
    ];
    let mut last_error = None;
    for url in candidates {
        match fetch_json_endpoint(&client, &url, token).await {
            Ok(payload) => {
                let entries = parse_http_search_entries(
                    &payload,
                    limit,
                    context.site_url.as_str(),
                    context.registry_url.as_str(),
                    source_kind,
                );
                if !entries.is_empty() {
                    return Ok(ClawHubSearchResult {
                        raw_output: serde_json::to_string(&payload).unwrap_or_default(),
                        entries,
                    });
                }
                last_error = Some(format!("ClawHub 搜索接口返回成功，但未解析到 skill ({url})"));
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| "ClawHub 搜索失败".to_string()))
}

async fn resolve_bundle_from_http(
    context: &HttpClawHubContext,
    slug: &str,
    version: Option<&str>,
    token: Option<&str>,
) -> Result<HttpClawHubBundle, String> {
    let client = build_http_client()?;
    let mut candidate_urls = Vec::new();
    candidate_urls.push(format!(
        "{}/api/v1/skills/{}{}",
        context.registry_url,
        slug,
        version
            .map(|value| format!("?version={}", encode_query_value(value)))
            .unwrap_or_default()
    ));
    candidate_urls.push(format!(
        "{}/api/v1/download?slug={}{}",
        context.registry_url,
        encode_query_value(slug),
        version
            .map(|value| format!("&version={}", encode_query_value(value)))
            .unwrap_or_default()
    ));
    candidate_urls.push(format!(
        "{}/api/v1/download/{}{}",
        context.registry_url,
        slug,
        version
            .map(|value| format!("?version={}", encode_query_value(value)))
            .unwrap_or_default()
    ));
    candidate_urls.push(format!(
        "{}/api/v1/skills/{}/download{}",
        context.registry_url,
        slug,
        version
            .map(|value| format!("?version={}", encode_query_value(value)))
            .unwrap_or_default()
    ));

    let mut last_error = None;
    for url in candidate_urls {
        let response = apply_auth(client.get(&url), token)
            .send()
            .await
            .map_err(|error| format!("请求 ClawHub 下载接口失败 ({url}): {error}"))?;
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
            .map_err(|error| format!("读取 ClawHub 下载响应失败 ({url}): {error}"))?
            .to_vec();

        if content_type.contains("application/json")
            || body.first() == Some(&b'{')
            || body.first() == Some(&b'[')
        {
            let payload = serde_json::from_slice::<Value>(&body)
                .map_err(|error| format!("解析 ClawHub 下载 JSON 失败 ({url}): {error}"))?;
            if let Some(download_url) = extract_url_from_json(
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
                let followup_response = apply_auth(client.get(&download_url), token)
                    .send()
                    .await
                    .map_err(|error| format!("下载 ClawHub bundle 失败 ({download_url}): {error}"))?;
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
                    .map_err(|error| format!("读取 ClawHub bundle 失败 ({download_url}): {error}"))?
                    .to_vec();
                return Ok(HttpClawHubBundle {
                    bytes,
                    version: extract_version_from_json(&payload)
                        .or_else(|| version.map(str::to_string)),
                    origin_url: extract_origin_url_from_json(
                        &payload,
                        context.site_url.as_str(),
                        context.registry_url.as_str(),
                    )
                    .or(Some(download_url)),
                });
            }

            if let Some(raw_skill_md) = extract_string_from_json(&payload, &["skill_md", "skillMd"]) {
                return Ok(HttpClawHubBundle {
                    bytes: raw_skill_md.into_bytes(),
                    version: extract_version_from_json(&payload)
                        .or_else(|| version.map(str::to_string)),
                    origin_url: extract_origin_url_from_json(
                        &payload,
                        context.site_url.as_str(),
                        context.registry_url.as_str(),
                    ),
                });
            }

            last_error = Some(format!("ClawHub 下载接口返回 JSON，但未发现 bundle URL ({url})"));
            continue;
        }

        return Ok(HttpClawHubBundle {
            bytes: body,
            version: version.map(str::to_string),
            origin_url: Some(url),
        });
    }
    Err(last_error.unwrap_or_else(|| "ClawHub bundle 下载失败".to_string()))
}

async fn install_with_http(
    app: &tauri::AppHandle,
    context: &HttpClawHubContext,
    slug: &str,
    version: Option<&str>,
    token: Option<&str>,
) -> Result<ClawHubInstallResult, String> {
    let bundle = resolve_bundle_from_http(context, slug, version, token).await?;
    let version_tag = bundle
        .version
        .clone()
        .or_else(|| version.map(str::to_string))
        .unwrap_or_else(|| "latest".to_string());
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("获取应用数据目录失败: {error}"))?;
    let slug_for_path = slug.replace('/', "__");
    let bytes_for_install = bundle.bytes.clone();
    let installed = tokio::task::spawn_blocking(move || {
        install_bundle_to_root(
            app_data_dir
                .join("skill-bundles")
                .join("clawhub")
                .join(slug_for_path)
                .join(version_tag),
            bytes_for_install,
        )
    })
    .await
    .map_err(|error| format!("安装 ClawHub bundle 任务失败: {error}"))??;

    Ok(ClawHubInstallResult {
        skill_md: installed.skill_md,
        stdout: "已通过 ClawHub HTTP registry 下载并安装完整 bundle".to_string(),
        installed_spec: match version {
            Some(version) => format!("{slug}@{version}"),
            None => slug.to_string(),
        },
        detected_skill_path: installed.skill_md_parent,
        bundle_root_path: Some(installed.bundle_root_path),
        bundle_hash: Some(installed.bundle_hash),
        installed_version: bundle.version.or_else(|| version.map(str::to_string)),
        origin_url: bundle.origin_url,
        site_url: Some(context.site_url.clone()),
        registry_url: Some(context.registry_url.clone()),
        legacy_fallback: installed.legacy_fallback,
    })
}

fn install_bundle_to_root(root: PathBuf, bytes: Vec<u8>) -> Result<InstalledBundle, String> {
    if root.exists() {
        fs::remove_dir_all(&root)
            .map_err(|error| format!("清理旧 ClawHub bundle 目录失败 ({}): {error}", root.display()))?;
    }
    fs::create_dir_all(&root)
        .map_err(|error| format!("创建 ClawHub bundle 目录失败 ({}): {error}", root.display()))?;

    let bundle_hash = format!("{:x}", Sha256::digest(&bytes));
    let legacy_fallback = match extract_zip_bundle(root.as_path(), bytes.as_slice()) {
        Ok(()) => false,
        Err(zip_error) => {
            let text = String::from_utf8(bytes.clone())
                .map_err(|_| format!("解析 ClawHub bundle 失败: {zip_error}"))?;
            if !text.trim_start().starts_with("---") {
                return Err(format!("解析 ClawHub bundle 失败: {zip_error}"));
            }
            let mut file = fs::File::create(root.join("SKILL.md"))
                .map_err(|error| format!("写入 fallback SKILL.md 失败: {error}"))?;
            file.write_all(text.as_bytes())
                .map_err(|error| format!("写入 fallback SKILL.md 内容失败: {error}"))?;
            true
        }
    };

    let skill_md_path = find_first_skill_md(&root)
        .ok_or_else(|| format!("安装完成，但未在 {} 中找到 SKILL.md", root.display()))?;
    let skill_md = fs::read_to_string(&skill_md_path)
        .map_err(|error| format!("读取安装后的 SKILL.md 失败 ({}): {error}", skill_md_path.display()))?;

    Ok(InstalledBundle {
        skill_md,
        skill_md_parent: skill_md_path
            .parent()
            .map(|path| path.display().to_string()),
        bundle_root_path: root.display().to_string(),
        bundle_hash,
        legacy_fallback,
    })
}

fn extract_zip_bundle(root: &Path, bytes: &[u8]) -> Result<(), String> {
    let cursor = Cursor::new(bytes.to_vec());
    let mut archive = ZipArchive::new(cursor)
        .map_err(|error| format!("打开 ClawHub zip bundle 失败: {error}"))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("读取 ClawHub zip entry 失败: {error}"))?;
        let Some(relative_path) = entry.enclosed_name().map(|path| path.to_path_buf()) else {
            continue;
        };
        let target_path = root.join(relative_path);
        if entry.name().ends_with('/') {
            fs::create_dir_all(&target_path)
                .map_err(|error| format!("创建目录失败 ({}): {error}", target_path.display()))?;
            continue;
        }
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建文件父目录失败 ({}): {error}", parent.display()))?;
        }
        let mut file = fs::File::create(&target_path)
            .map_err(|error| format!("创建 bundle 文件失败 ({}): {error}", target_path.display()))?;
        std::io::copy(&mut entry, &mut file)
            .map_err(|error| format!("写入 bundle 文件失败 ({}): {error}", target_path.display()))?;
    }
    Ok(())
}

fn find_first_skill_md(root: &Path) -> Option<PathBuf> {
    if !root.exists() {
        return None;
    }

    walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .find(|entry| {
            entry.file_type().is_file() && entry.file_name().to_string_lossy() == "SKILL.md"
        })
        .map(|entry| entry.path().to_path_buf())
}

fn encode_query_value(input: &str) -> String {
    url::form_urlencoded::byte_serialize(input.as_bytes()).collect::<String>()
}
