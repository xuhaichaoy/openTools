use reqwest_dav::{Auth, Client, ClientBuilder, Depth};

use std::net::SocketAddr;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::Ordering;
use tokio::net::lookup_host;
use tokio::net::TcpStream;
use tokio::time::{timeout, Duration};
use url::Url;

//全局变量
static WEBDAV_DEPTH_STRATEGY: AtomicU32 = AtomicU32::new(1);

//超时控制
async fn test_depth_with_timeout(
    client: &Client,
    path: &str,
    depth: Depth,
    timeout_secs: u64,
) -> bool {
    timeout(Duration::from_secs(timeout_secs), client.list(path, depth))
        .await
        .map(|result| result.is_ok())
        .unwrap_or(false)
}

// WebDAV客户端创建：建立连接并验证服务器可达性
pub async fn create_client(url: &str, username: &str, password: &str) -> Result<Client, String> {
    // 超时时间
    const CONNECT_TIMEOUT: Duration = Duration::from_secs(6);

    // URL解析
    let parsed_url = Url::parse(url).map_err(|e| format!("URL 解析失败: {}", e))?;

    // 核心逻辑：根据 Scheme 决定连接策略
    if parsed_url.scheme() == "https" {
        // 1. 创建带超时的 reqwest 客户端
        let http_client = reqwest_dav::re_exports::reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(Duration::from_secs(30)) // 为整个请求设置一个更长的超时
            .build()
            .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

        // 2. 将原始 URL 和配置好的客户端传递给 ClientBuilder
        ClientBuilder::new()
            .set_host(url.to_string()) // 直接使用原始 URL
            .set_auth(Auth::Basic(username.to_owned(), password.to_owned()))
            .set_agent(http_client) // 使用 set_agent 注入配置
            .build()
            .map_err(|e| format!("创建 WebDAV 客户端失败: {}", e))
    } else {
        // --- HTTP 策略继续使用 IP 直连可以避免一些 DNS 问题

        let host = parsed_url
            .host_str()
            .ok_or_else(|| "URL 中未找到主机名".to_string())?;
        let port = parsed_url
            .port_or_known_default()
            .ok_or_else(|| "URL 中缺少有效的端口".to_string())?;

        // DNS解析获取IP地址
        let dns_lookup_future = lookup_host(format!("{}:{}", host, port));
        let addrs: Vec<SocketAddr> = match timeout(CONNECT_TIMEOUT, dns_lookup_future).await {
            Ok(Ok(addrs)) => addrs.collect(),
            Ok(Err(e)) => return Err(format!("DNS 解析失败: {}", e)),
            Err(_) => return Err(format!("DNS 解析超时 ({} 秒)", CONNECT_TIMEOUT.as_secs())),
        };

        if addrs.is_empty() {
            return Err(format!("DNS 解析未返回任何 IP 地址 for {}", host));
        }
        let final_ip_addr = addrs
            .iter()
            .find(|addr| addr.is_ipv6())
            .unwrap_or(&addrs[0]);

        // TCP连接测试
        let preflight_future = TcpStream::connect(final_ip_addr);
        match timeout(CONNECT_TIMEOUT, preflight_future).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(format!("服务器连接被拒绝: {}", e)),
            Err(_) => return Err(format!("服务器连接超时 ({} 秒)", CONNECT_TIMEOUT.as_secs())),
        }

        // WebDAV客户端构建
        let host_url = format!("{}://{}/", parsed_url.scheme(), final_ip_addr);
        ClientBuilder::new()
            .set_host(host_url)
            .set_auth(Auth::Basic(username.to_owned(), password.to_owned()))
            .build()
            .map_err(|e| format!("创建 WebDAV 客户端失败: {}", e))
    }
}

// WebDAV连接测试：验证连接并检测服务器深度支持
#[tauri::command]
pub async fn webdav_test(
    url: String,
    username: String,
    password: String,
    path: String,
) -> Result<bool, String> {
    let client = create_client(&url, &username, &password).await?;
    let test_path = normalize_path(&path, true);

    // 优先尝试 Depth::Infinity
    if test_depth_with_timeout(&client, &test_path, Depth::Infinity, 2).await {
        WEBDAV_DEPTH_STRATEGY.store(0, Ordering::SeqCst);
        return Ok(true);
    }

    // 降级尝试 Depth::Number(1)
    if test_depth_with_timeout(&client, &test_path, Depth::Number(1), 2).await {
        WEBDAV_DEPTH_STRATEGY.store(1, Ordering::SeqCst);
        return Ok(true);
    }

    // 深度检测失败返回连接错误
    Err(format!(
        "[ERR_PATH_NOT_FOUND] Path may not exist or credentials are wrong"
    ))
}

// WebDAV 创建目录
#[tauri::command]
pub async fn webdav_create_dir(
    url: String,
    username: String,
    password: String,
    path: String,
) -> Result<(), String> {
    let client = create_client(&url, &username, &password).await?;
    let parts: Vec<&str> = path.trim().split('/').filter(|s| !s.is_empty()).collect();
    if parts.is_empty() {
        return Ok(());
    }
    let mut current_path = String::new();

    //逐个创建路径中的目录
    for part in parts {
        current_path.push_str(part);
        let path_for_request = format!("{}/", current_path);

        match client.list(&path_for_request, Depth::Number(0)).await {
            Ok(_) => {
                // 目录已存在，在 current_path 后加上斜杠，为下一轮循环做准备
                current_path.push('/');
                continue;
            }
            Err(_) => {
                // 目录不存在尝试创建
                if let Err(e) = client.mkcol(&path_for_request).await {
                    return Err(format!("创建目录 '{}' 失败: {}", path_for_request, e));
                }
                current_path.push('/');
            }
        }
    }

    Ok(())
}

// 辅助函数：规范化文件路径
fn normalize_path(path: &str, remove_leading_slash: bool) -> String {
    if path.trim().is_empty() {
        return String::new();
    }

    let mut normalized = path.trim().replace('\\', "/");
    if remove_leading_slash {
        normalized = normalized.trim_start_matches('/').to_string();
    }
    normalized
}
