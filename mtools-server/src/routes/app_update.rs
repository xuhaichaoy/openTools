use axum::{extract::Query, http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 客户端查询参数（Tauri Updater 自动附加）
#[derive(Debug, Deserialize)]
pub struct UpdateQuery {
    /// 当前客户端版本，例如 "0.1.0"
    pub current_version: Option<String>,
    /// 目标平台，例如 "darwin-aarch64"、"windows-x86_64"
    pub target: Option<String>,
}

/// 单个平台的更新包信息
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlatformUpdate {
    /// minisign 签名字符串（base64 编码，来自构建产物 .sig 文件）
    pub signature: String,
    /// 安装包下载地址（.dmg.tar.gz / .nsis.zip）
    pub url: String,
}

/// Tauri v2 Updater 标准更新清单格式
#[derive(Debug, Serialize)]
pub struct UpdateManifest {
    /// 最新版本号，例如 "0.2.0"
    pub version: String,
    /// 发布日期（RFC 3339 格式）
    pub pub_date: String,
    /// 更新说明（支持 Markdown）
    pub notes: String,
    /// 各平台的下载信息
    pub platforms: HashMap<String, PlatformUpdate>,
}

/// 服务端维护的最新版本信息
/// 生产环境中可改为从数据库或环境变量中读取
fn get_latest_release() -> Option<UpdateManifest> {
    // 从环境变量读取最新版本配置
    let version = std::env::var("APP_LATEST_VERSION").ok()?;
    let notes = std::env::var("APP_RELEASE_NOTES")
        .unwrap_or_else(|_| "修复若干问题并提升稳定性".to_string());
    let pub_date =
        std::env::var("APP_RELEASE_DATE").unwrap_or_else(|_| chrono::Utc::now().to_rfc3339());
    let base_url = std::env::var("APP_RELEASE_BASE_URL").ok()?;

    let mut platforms = HashMap::new();

    // macOS Apple Silicon (M 系列)
    if let (Ok(sig), Ok(_)) = (
        std::env::var("APP_SIG_DARWIN_AARCH64"),
        std::env::var("APP_RELEASE_BASE_URL"),
    ) {
        platforms.insert(
            "darwin-aarch64".to_string(),
            PlatformUpdate {
                signature: sig,
                url: format!("{}/HiClow_{}_aarch64.dmg.tar.gz", base_url, version),
            },
        );
    }

    // macOS Intel
    if let Ok(sig) = std::env::var("APP_SIG_DARWIN_X86_64") {
        platforms.insert(
            "darwin-x86_64".to_string(),
            PlatformUpdate {
                signature: sig,
                url: format!("{}/HiClow_{}_x64.dmg.tar.gz", base_url, version),
            },
        );
    }

    // Windows x64
    if let Ok(sig) = std::env::var("APP_SIG_WINDOWS_X86_64") {
        platforms.insert(
            "windows-x86_64".to_string(),
            PlatformUpdate {
                signature: sig,
                url: format!("{}/HiClow_{}_x64-setup.nsis.zip", base_url, version),
            },
        );
    }

    // Linux x64
    if let Ok(sig) = std::env::var("APP_SIG_LINUX_X86_64") {
        platforms.insert(
            "linux-x86_64".to_string(),
            PlatformUpdate {
                signature: sig,
                url: format!("{}/HiClow_{}_amd64.AppImage.tar.gz", base_url, version),
            },
        );
    }

    if platforms.is_empty() {
        return None;
    }

    Some(UpdateManifest {
        version,
        pub_date,
        notes,
        platforms,
    })
}

/// 比较版本号大小，若 latest > current 返回 true
fn is_newer(current: &str, latest: &str) -> bool {
    let parse = |v: &str| -> (u64, u64, u64) {
        let parts: Vec<&str> = v.trim_start_matches('v').split('.').collect();
        let major = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
        let minor = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        let patch = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
        (major, minor, patch)
    };
    parse(latest) > parse(current)
}

/// GET /v1/app/update
///
/// 检查应用更新。Tauri Updater 会自动附加查询参数：
/// - `current_version`: 当前安装版本
/// - `target`: 目标平台标识（如 darwin-aarch64）
///
/// 返回：
/// - `200 OK` + UpdateManifest JSON：有新版本可用
/// - `204 No Content`：已是最新版本
/// - `204 No Content`：服务端未配置更新信息
pub async fn check_update(Query(params): Query<UpdateQuery>) -> impl IntoResponse {
    let Some(manifest) = get_latest_release() else {
        // 未配置发布信息，客户端静默忽略
        return StatusCode::NO_CONTENT.into_response();
    };

    let current = params.current_version.as_deref().unwrap_or("0.0.0");

    if !is_newer(current, &manifest.version) {
        // 已是最新版本
        return StatusCode::NO_CONTENT.into_response();
    }

    // 若客户端指定了平台，过滤只返回对应平台信息
    // Tauri Updater 实际上会自动匹配，这里保留完整 platforms 即可
    Json(manifest).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_newer() {
        assert!(is_newer("0.1.0", "0.2.0"));
        assert!(is_newer("0.1.0", "1.0.0"));
        assert!(!is_newer("0.2.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(is_newer("0.1.0", "v0.2.0"));
    }
}
