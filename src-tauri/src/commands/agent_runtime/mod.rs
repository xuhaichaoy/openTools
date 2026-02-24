use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;

const DOCKER_BIN: &str = "docker";
const DEFAULT_DOCKER_IMAGE: &str = "alpine:3.20";
const DEFAULT_TIMEOUT_SECS: u64 = 120;

#[derive(Debug, Clone, Serialize)]
pub struct AgentContainerAvailability {
    pub available: bool,
    pub runtime: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentContainerShellResult {
    pub runtime: &'static str,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentContainerWriteResult {
    pub runtime: &'static str,
    pub path: String,
    pub bytes: usize,
    pub message: String,
}

fn docker_image() -> String {
    std::env::var("MTOOLS_AGENT_DOCKER_IMAGE").unwrap_or_else(|_| DEFAULT_DOCKER_IMAGE.to_string())
}

fn normalize_allowed_roots(allowed_roots: Vec<String>) -> Vec<PathBuf> {
    allowed_roots
        .into_iter()
        .filter_map(|raw| {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            let path = PathBuf::from(trimmed);
            if path.exists() {
                path.canonicalize().ok()
            } else if path.is_absolute() {
                Some(path)
            } else {
                None
            }
        })
        .collect()
}

fn has_parent_component(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::ParentDir))
}

fn resolve_target_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if has_parent_component(&p) {
        return Err("路径包含不允许的上级目录跳转(..)".to_string());
    }
    if p.is_absolute() {
        return Ok(p);
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(p))
        .map_err(|e| format!("解析路径失败: {}", e))
}

fn path_in_root(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
}

fn path_to_unix_slashes(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn docker_mount_source(path: &Path) -> Result<String, String> {
    let mut normalized = path_to_unix_slashes(path);
    let lowered = normalized.to_lowercase();

    // Windows 扩展前缀示例：\\?\C:\foo -> //?/C:/foo；\\?\UNC\server\share -> //?/UNC/server/share
    if lowered.starts_with("//?/unc/") {
        normalized = format!("//{}", &normalized[8..]);
    } else if normalized.starts_with("//?/") {
        normalized = normalized[4..].to_string();
    }

    if normalized.contains('\n') || normalized.contains('\r') {
        return Err("挂载路径包含非法换行字符".to_string());
    }

    // Docker --mount 以逗号分隔键值，source 中的逗号需要转义
    Ok(normalized.replace(',', "\\,"))
}

async fn run_docker(mut args: Vec<String>) -> Result<std::process::Output, String> {
    let mut cmd = Command::new(DOCKER_BIN);
    cmd.args(args.drain(..));
    tokio::time::timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS), cmd.output())
        .await
        .map_err(|_| "容器执行超时".to_string())?
        .map_err(|e| format!("调用 docker 失败: {}", e))
}

#[tauri::command]
pub async fn agent_container_available() -> Result<AgentContainerAvailability, String> {
    let output = Command::new(DOCKER_BIN)
        .args(["info", "--format", "{{.ServerVersion}}"])
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() => {
            let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
            Ok(AgentContainerAvailability {
                available: true,
                runtime: "docker",
                message: if version.is_empty() {
                    "Docker 可用".to_string()
                } else {
                    format!("Docker 可用（Server {}）", version)
                },
            })
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Ok(AgentContainerAvailability {
                available: false,
                runtime: "docker",
                message: if stderr.is_empty() {
                    "Docker 不可用".to_string()
                } else {
                    format!("Docker 不可用：{}", stderr)
                },
            })
        }
        Err(e) => Ok(AgentContainerAvailability {
            available: false,
            runtime: "docker",
            message: format!("Docker 不可用：{}", e),
        }),
    }
}

#[tauri::command]
pub async fn agent_container_run_shell(
    command: String,
    allowed_roots: Vec<String>,
) -> Result<AgentContainerShellResult, String> {
    let roots = normalize_allowed_roots(allowed_roots);
    if roots.is_empty() {
        return Err("容器执行缺少 allowed_roots，拒绝运行".to_string());
    }

    let mut args = vec![
        "run".to_string(),
        "--rm".to_string(),
        "--network".to_string(),
        "none".to_string(),
        "--workdir".to_string(),
        "/workspace/root0".to_string(),
    ];

    for (idx, root) in roots.iter().enumerate() {
        let mount_source = docker_mount_source(root)?;
        args.push("--mount".to_string());
        args.push(format!(
            "type=bind,source={},target=/workspace/root{}",
            mount_source, idx
        ));
    }

    args.push(docker_image());
    args.push("sh".to_string());
    args.push("-lc".to_string());
    args.push(command);

    let output = run_docker(args).await?;
    let code = output.status.code().unwrap_or(-1);
    Ok(AgentContainerShellResult {
        runtime: "container",
        exit_code: code,
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
    })
}

#[tauri::command]
pub async fn agent_container_write_file(
    path: String,
    content: String,
    allowed_roots: Vec<String>,
) -> Result<AgentContainerWriteResult, String> {
    let roots = normalize_allowed_roots(allowed_roots);
    if roots.is_empty() {
        return Err("容器写文件缺少 allowed_roots，拒绝执行".to_string());
    }

    let resolved = resolve_target_path(&path)?;
    let Some((root_idx, root_path)) = roots
        .iter()
        .enumerate()
        .find(|(_, root)| path_in_root(&resolved, root))
    else {
        return Err("目标路径不在 allowed_roots 内".to_string());
    };

    let rel = resolved
        .strip_prefix(root_path)
        .map_err(|_| "计算容器目标路径失败".to_string())?;
    let rel_unix = path_to_unix_slashes(rel);
    let target_in_container = if rel_unix.is_empty() {
        format!("/workspace/root{}", root_idx)
    } else {
        format!("/workspace/root{}/{}", root_idx, rel_unix)
    };

    let payload_dir = std::env::temp_dir().join(format!("mtools-agent-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&payload_dir).map_err(|e| format!("创建临时目录失败: {}", e))?;
    let payload_file = payload_dir.join("content.txt");
    std::fs::write(&payload_file, content.as_bytes())
        .map_err(|e| format!("写入临时内容失败: {}", e))?;

    let args = vec![
        "run".to_string(),
        "--rm".to_string(),
        "--network".to_string(),
        "none".to_string(),
        "--workdir".to_string(),
        "/workspace".to_string(),
        "-e".to_string(),
        format!("TARGET_PATH={}", target_in_container),
        "--mount".to_string(),
        format!(
            "type=bind,source={},target=/workspace/root{}",
            docker_mount_source(root_path)?,
            root_idx
        ),
        "--mount".to_string(),
        format!(
            "type=bind,source={},target=/workspace/_payload,readonly",
            docker_mount_source(&payload_dir)?
        ),
        docker_image(),
        "sh".to_string(),
        "-lc".to_string(),
        "mkdir -p \"$(dirname \\\"$TARGET_PATH\\\")\" && cat /workspace/_payload/content.txt > \"$TARGET_PATH\"".to_string(),
    ];

    let output = run_docker(args).await;
    let _ = std::fs::remove_dir_all(&payload_dir);
    let output = output?;

    if !output.status.success() {
        return Err(format!(
            "容器写文件失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    Ok(AgentContainerWriteResult {
        runtime: "container",
        path: path.clone(),
        bytes: content.len(),
        message: format!("容器写入成功: {} ({} 字节)", path, content.len()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docker_mount_source_strips_windows_verbatim_prefix() {
        let p = PathBuf::from(r"\\?\C:\Users\alice\project");
        let normalized = docker_mount_source(&p).expect("normalize should pass");
        assert_eq!(normalized, "C:/Users/alice/project");
    }

    #[test]
    fn docker_mount_source_normalizes_unc_and_escapes_commas() {
        let p = PathBuf::from(r"\\?\UNC\server\share\my,dir");
        let normalized = docker_mount_source(&p).expect("normalize should pass");
        assert_eq!(normalized, "//server/share/my\\,dir");
    }
}
