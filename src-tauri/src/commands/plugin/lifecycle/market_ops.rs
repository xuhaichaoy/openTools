use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Cursor;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use zip::ZipArchive;

use super::{
    get_cached_plugins, get_official_plugins_dir, invalidate_plugin_runtime,
    is_developer_mode_enabled, persist_plugin_settings, refresh_plugin_cache,
};
use crate::commands::plugin::types::{PluginCache, PluginInfo};

const MAX_PLUGIN_PACKAGE_BYTES: u64 = 50 * 1024 * 1024;

fn resolve_local_official_plugin_source(app: &AppHandle, slug: &str) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("official-plugins").join(slug));
        candidates.push(resource_dir.join("plugins").join("official").join(slug));
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("official-plugins").join(slug));
        candidates.push(cwd.join("src-tauri").join("official-plugins").join(slug));
        candidates.push(cwd.join("plugins").join("official").join(slug));
    }

    candidates
        .into_iter()
        .find(|path| path.is_dir() && contains_manifest(path))
}

fn ensure_safe_relative_path(path: &Path) -> bool {
    path.components()
        .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

fn contains_manifest(path: &Path) -> bool {
    path.join("plugin.json").exists() || path.join("package.json").exists()
}

fn resolve_extracted_plugin_root(staging_dir: &Path) -> Result<PathBuf, String> {
    if contains_manifest(staging_dir) {
        return Ok(staging_dir.to_path_buf());
    }

    let mut candidates = Vec::new();
    let entries = std::fs::read_dir(staging_dir).map_err(|e| format!("读取解压目录失败: {}", e))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && contains_manifest(&path) {
            candidates.push(path);
        }
    }

    if candidates.len() == 1 {
        return Ok(candidates.remove(0));
    }

    Err("插件包缺少 plugin.json/package.json，或包含多个候选根目录".to_string())
}

fn extract_zip_safely(zip_bytes: &[u8], target_dir: &Path) -> Result<(), String> {
    let reader = Cursor::new(zip_bytes);
    let mut archive = ZipArchive::new(reader).map_err(|e| format!("无法打开 zip: {}", e))?;

    let mut total_uncompressed: u64 = 0;
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|e| format!("读取 zip 条目失败: {}", e))?;
        let enclosed = file
            .enclosed_name()
            .map(PathBuf::from)
            .ok_or_else(|| "插件包包含非法路径（路径穿越）".to_string())?;
        if !ensure_safe_relative_path(&enclosed) {
            return Err("插件包包含非法路径（路径穿越）".to_string());
        }

        total_uncompressed = total_uncompressed.saturating_add(file.size());
        if total_uncompressed > 200 * 1024 * 1024 {
            return Err("插件包解压后体积超过安全限制（200MB）".to_string());
        }

        let out_path = target_dir.join(&enclosed);
        if file.name().ends_with('/') {
            std::fs::create_dir_all(&out_path).map_err(|e| format!("创建目录失败: {}", e))?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {}", e))?;
        }
        let mut out_file = File::create(&out_path).map_err(|e| format!("写入文件失败: {}", e))?;
        std::io::copy(&mut file, &mut out_file).map_err(|e| format!("解压文件失败: {}", e))?;
    }

    Ok(())
}

fn remove_path_if_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    if path.is_dir() {
        std::fs::remove_dir_all(path).map_err(|e| format!("删除目录失败: {}", e))
    } else {
        std::fs::remove_file(path).map_err(|e| format!("删除文件失败: {}", e))
    }
}

fn path_within(path: &Path, root: &Path) -> bool {
    let normalized_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let normalized_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    normalized_path.starts_with(normalized_root)
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    if !source.exists() || !source.is_dir() {
        return Err(format!(
            "复制目录失败：源目录不存在或不是目录 ({})",
            source.display()
        ));
    }

    std::fs::create_dir_all(target).map_err(|e| format!("创建目录失败: {}", e))?;

    let entries = std::fs::read_dir(source).map_err(|e| format!("读取目录失败: {}", e))?;
    for entry in entries.flatten() {
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| format!("读取文件类型失败: {}", e))?;

        if file_type.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else if file_type.is_file() {
            if let Some(parent) = target_path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
            }
            std::fs::copy(&source_path, &target_path).map_err(|e| {
                format!(
                    "复制文件失败: {} -> {} ({})",
                    source_path.display(),
                    target_path.display(),
                    e
                )
            })?;
        }
    }

    Ok(())
}

async fn download_plugin_package(
    download_url: &str,
    expected_size: u64,
) -> Result<Vec<u8>, String> {
    use futures_util::StreamExt;

    let client = reqwest::Client::new();
    let response = client
        .get(download_url)
        .send()
        .await
        .map_err(|e| format!("下载插件包失败: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "下载插件包失败: HTTP {}",
            response.status().as_u16()
        ));
    }

    let mut bytes: Vec<u8> = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取下载数据失败: {}", e))?;
        bytes.extend_from_slice(&chunk);
        if bytes.len() as u64 > MAX_PLUGIN_PACKAGE_BYTES {
            return Err(format!("插件包超过 50MB 限制（{} bytes）", bytes.len()));
        }
    }

    if expected_size > 0 && bytes.len() as u64 != expected_size {
        return Err(format!(
            "插件包大小不匹配: expected={}, actual={}",
            expected_size,
            bytes.len()
        ));
    }

    Ok(bytes)
}

fn verify_package_sha256(bytes: &[u8], expected_sha256: &str) -> Result<(), String> {
    let expected = expected_sha256.trim().to_lowercase();
    if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("无效的 SHA256 校验值".to_string());
    }

    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let actual = format!("{:x}", hasher.finalize());
    if actual != expected {
        return Err(format!(
            "PLUGIN_PACKAGE_INTEGRITY_FAILED: sha256 mismatch, expected={}, actual={}",
            expected, actual
        ));
    }
    Ok(())
}

pub(super) async fn plugin_market_install(
    app: AppHandle,
    slug: String,
    version: String,
    download_url: String,
    sha256: String,
    size_bytes: u64,
) -> Result<Vec<PluginInfo>, String> {
    let _ = get_cached_plugins(&app);

    let slug = slug.trim().to_lowercase();
    if slug.is_empty() {
        return Err("插件 slug 不能为空".to_string());
    }
    if !slug
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("插件 slug 含非法字符".to_string());
    }
    if version.trim().is_empty() {
        return Err("插件 version 不能为空".to_string());
    }
    if !download_url.starts_with("http://") && !download_url.starts_with("https://") {
        return Err("PLUGIN_INSTALL_NOT_SUPPORTED: 仅支持 http/https 下载链接".to_string());
    }
    if size_bytes > MAX_PLUGIN_PACKAGE_BYTES {
        return Err(format!(
            "插件包声明大小超过 50MB 限制（{} bytes）",
            size_bytes
        ));
    }

    let package_bytes = download_plugin_package(&download_url, size_bytes).await?;
    verify_package_sha256(&package_bytes, &sha256)?;

    let official_root = get_official_plugins_dir(&app);
    std::fs::create_dir_all(&official_root).map_err(|e| format!("创建官方插件目录失败: {}", e))?;

    let staging_parent = official_root.join(".staging");
    std::fs::create_dir_all(&staging_parent).map_err(|e| format!("创建临时目录失败: {}", e))?;
    let staging_dir = staging_parent.join(format!("{}-{}", slug, uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&staging_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;

    let install_dir = official_root.join(&slug);
    let backup_dir = official_root.join(format!(".backup-{}-{}", slug, uuid::Uuid::new_v4()));

    let install_result = (|| -> Result<(), String> {
        extract_zip_safely(&package_bytes, &staging_dir)?;
        let extracted_root = resolve_extracted_plugin_root(&staging_dir)?;

        if install_dir.exists() {
            std::fs::rename(&install_dir, &backup_dir)
                .map_err(|e| format!("备份旧版本失败: {}", e))?;
        }

        if let Err(e) = std::fs::rename(&extracted_root, &install_dir) {
            if backup_dir.exists() {
                let _ = std::fs::rename(&backup_dir, &install_dir);
            }
            return Err(format!("安装插件失败（原子替换失败）: {}", e));
        }

        if backup_dir.exists() {
            let _ = std::fs::remove_dir_all(&backup_dir);
        }
        let _ = std::fs::remove_dir_all(&staging_dir);
        Ok(())
    })();

    if install_result.is_err() {
        let _ = std::fs::remove_dir_all(&staging_dir);
    }
    install_result?;

    {
        let cache = app.state::<Mutex<PluginCache>>();
        let mut cache = cache.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        cache.disabled_ids.remove(&slug);
        persist_plugin_settings(&app, &cache);
    }
    invalidate_plugin_runtime(&app);

    Ok(refresh_plugin_cache(&app))
}

pub(super) async fn plugin_market_install_official_local(
    app: AppHandle,
    slug: String,
) -> Result<Vec<PluginInfo>, String> {
    let _ = get_cached_plugins(&app);

    if !is_developer_mode_enabled(&app) {
        return Err("PLUGIN_INSTALL_NOT_SUPPORTED: 本地官方包安装仅在开发者模式下可用".to_string());
    }

    let slug = slug.trim().to_lowercase();
    if slug.is_empty() {
        return Err("插件 slug 不能为空".to_string());
    }
    if !slug
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err("插件 slug 含非法字符".to_string());
    }

    let source_dir = resolve_local_official_plugin_source(&app, &slug).ok_or_else(|| {
        format!(
            "官方插件 {} 本地包不存在，请先发布到插件市场或检查 official-plugins 目录",
            slug
        )
    })?;

    let official_root = get_official_plugins_dir(&app);
    std::fs::create_dir_all(&official_root).map_err(|e| format!("创建官方插件目录失败: {}", e))?;

    let staging_parent = official_root.join(".staging");
    std::fs::create_dir_all(&staging_parent).map_err(|e| format!("创建临时目录失败: {}", e))?;
    let staging_dir = staging_parent.join(format!("{}-{}", slug, uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&staging_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;
    let staged_plugin_dir = staging_dir.join(&slug);

    let install_dir = official_root.join(&slug);
    let backup_dir = official_root.join(format!(".backup-{}-{}", slug, uuid::Uuid::new_v4()));

    let install_result = (|| -> Result<(), String> {
        copy_dir_recursive(&source_dir, &staged_plugin_dir)?;
        if !contains_manifest(&staged_plugin_dir) {
            return Err("官方插件目录缺少 plugin.json/package.json".to_string());
        }

        if install_dir.exists() {
            std::fs::rename(&install_dir, &backup_dir)
                .map_err(|e| format!("备份旧版本失败: {}", e))?;
        }

        if let Err(e) = std::fs::rename(&staged_plugin_dir, &install_dir) {
            if backup_dir.exists() {
                let _ = std::fs::rename(&backup_dir, &install_dir);
            }
            return Err(format!("安装官方本地插件失败（原子替换失败）: {}", e));
        }

        if backup_dir.exists() {
            let _ = std::fs::remove_dir_all(&backup_dir);
        }
        let _ = std::fs::remove_dir_all(&staging_dir);
        Ok(())
    })();

    if install_result.is_err() {
        let _ = std::fs::remove_dir_all(&staging_dir);
    }
    install_result?;

    {
        let cache = app.state::<Mutex<PluginCache>>();
        let mut cache = cache.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        cache.disabled_ids.remove(&slug);
        persist_plugin_settings(&app, &cache);
    }
    invalidate_plugin_runtime(&app);

    Ok(refresh_plugin_cache(&app))
}

pub(super) async fn plugin_market_uninstall(
    app: AppHandle,
    plugin_id: String,
) -> Result<Vec<PluginInfo>, String> {
    let plugins = get_cached_plugins(&app);
    let plugin = plugins
        .iter()
        .find(|p| p.id == plugin_id)
        .ok_or_else(|| format!("插件不存在: {}", plugin_id))?;

    if plugin.is_builtin {
        return Err("内置插件不支持卸载".to_string());
    }

    let plugin_dir = PathBuf::from(&plugin.dir_path);
    let official_root = get_official_plugins_dir(&app);
    if !path_within(&plugin_dir, &official_root) {
        return Err("仅支持卸载通过插件市场安装到官方目录的插件".to_string());
    }

    remove_path_if_exists(&plugin_dir)?;

    {
        let cache = app.state::<Mutex<PluginCache>>();
        let mut cache = cache.lock().map_err(|e| format!("Lock poisoned: {}", e))?;
        cache.disabled_ids.remove(&plugin_id);
        persist_plugin_settings(&app, &cache);
    }
    invalidate_plugin_runtime(&app);

    Ok(refresh_plugin_cache(&app))
}

pub(super) async fn plugin_market_clear_data(
    app: AppHandle,
    data_profile: String,
) -> Result<(), String> {
    let profile = data_profile.trim().to_lowercase();
    if profile.is_empty() || profile == "none" {
        return Ok(());
    }

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 AppData 目录失败: {}", e))?;
    let db_dir = app_data_dir.join("mtools-db");

    match profile.as_str() {
        "snippets" => {
            remove_path_if_exists(&db_dir.join("snippets.json"))?;
        }
        "bookmarks" => {
            remove_path_if_exists(&db_dir.join("bookmarks.json"))?;
        }
        "note_hub" | "note-hub" => {
            remove_path_if_exists(&db_dir.join("marks.json"))?;
            remove_path_if_exists(&db_dir.join("tags.json"))?;
            remove_path_if_exists(&app_data_dir.join("notes"))?;
        }
        _ => {
            return Err(format!("未知 data_profile: {}", profile));
        }
    }
    Ok(())
}
