use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;
use uuid::Uuid;

const CLAWHUB_SITE_ENV: &str = "CLAWHUB_SITE";
const CLAWHUB_REGISTRY_ENV: &str = "CLAWHUB_REGISTRY";
const CLAWHUB_CONFIG_PATH_ENV: &str = "CLAWHUB_CONFIG_PATH";
const CLAWHUB_WORKDIR_ENV: &str = "CLAWHUB_WORKDIR";
const CLAWHUB_DISABLE_TELEMETRY_ENV: &str = "CLAWHUB_DISABLE_TELEMETRY";

#[derive(Debug, Clone, Serialize)]
pub struct ClawHubCliStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub binary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClawHubVerifyResult {
    pub ok: bool,
    pub stdout: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClawHubInstallResult {
    pub skill_md: String,
    pub stdout: String,
    pub installed_spec: String,
    pub detected_skill_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ClawHubInstallRequest {
    pub slug: String,
    pub version: Option<String>,
    pub token: Option<String>,
    pub site_url: Option<String>,
    pub registry_url: Option<String>,
}

#[derive(Debug, Clone)]
struct ClawHubCommandContext {
    config_path: PathBuf,
    workdir: PathBuf,
    site_url: Option<String>,
    registry_url: Option<String>,
}

#[derive(Debug)]
struct CommandRunResult {
    stdout: String,
    stderr: String,
}

#[tauri::command]
pub async fn skill_marketplace_clawhub_status() -> Result<ClawHubCliStatus, String> {
    tokio::task::spawn_blocking(detect_clawhub_status)
        .await
        .map_err(|e| format!("检测 clawhub CLI 失败: {e}"))?
}

#[tauri::command]
pub async fn skill_marketplace_clawhub_verify(
    app: tauri::AppHandle,
    token: Option<String>,
    site_url: Option<String>,
    registry_url: Option<String>,
) -> Result<ClawHubVerifyResult, String> {
    tokio::task::spawn_blocking(move || {
        let trimmed_token = token.unwrap_or_default().trim().to_string();
        if trimmed_token.is_empty() {
            return Err("请先填写 ClawHub token".to_string());
        }

        let (binary, _) = find_clawhub_binary()
            .ok_or_else(|| "未检测到 clawhub CLI，请先在系统安装后再使用".to_string())?;
        let context =
            prepare_command_context(&app, site_url.as_deref(), registry_url.as_deref(), "verify")?;

        run_clawhub_login(&binary, &context, &trimmed_token)?;
        let whoami = run_clawhub_command(&binary, &["whoami"], &context)?;

        Ok(ClawHubVerifyResult {
            ok: true,
            stdout: collect_command_logs(&[whoami]),
        })
    })
    .await
    .map_err(|e| format!("验证 ClawHub token 失败: {e}"))?
}

#[tauri::command]
pub async fn skill_marketplace_clawhub_install(
    app: tauri::AppHandle,
    request: ClawHubInstallRequest,
) -> Result<ClawHubInstallResult, String> {
    tokio::task::spawn_blocking(move || {
        let slug = request.slug.trim().to_string();
        if slug.is_empty() {
            return Err("Skill slug 不能为空".to_string());
        }

        let (binary, _) = find_clawhub_binary()
            .ok_or_else(|| "未检测到 clawhub CLI，请先在系统安装后再使用".to_string())?;
        let context = prepare_command_context(
            &app,
            request.site_url.as_deref(),
            request.registry_url.as_deref(),
            "install",
        )?;

        let mut logs = Vec::new();
        let trimmed_token = request.token.unwrap_or_default().trim().to_string();
        if !trimmed_token.is_empty() {
            logs.push(run_clawhub_login(&binary, &context, &trimmed_token)?);
        }

        let installed_spec = match request.version.as_deref().map(str::trim) {
            Some(version) if !version.is_empty() => format!("{slug}@{version}"),
            _ => slug.clone(),
        };

        let mut args = vec![
            "install".to_string(),
            slug.clone(),
            "--workdir".to_string(),
            context.workdir.to_string_lossy().to_string(),
            "--dir".to_string(),
            "skills".to_string(),
        ];
        if let Some(version) = request.version.as_deref().map(str::trim) {
            if !version.is_empty() {
                args.push("--version".to_string());
                args.push(version.to_string());
            }
        }

        logs.push(run_clawhub_command(
            &binary,
            &args.iter().map(String::as_str).collect::<Vec<_>>(),
            &context,
        )?);

        let skills_root = context.workdir.join("skills");
        let skill_md_path = find_first_skill_md(&skills_root).ok_or_else(|| {
            format!(
                "已完成安装，但未在 {} 中找到 SKILL.md",
                skills_root.display()
            )
        })?;
        let skill_md = fs::read_to_string(&skill_md_path)
            .map_err(|e| format!("读取 SKILL.md 失败 ({}): {e}", skill_md_path.display()))?;

        Ok(ClawHubInstallResult {
            skill_md,
            stdout: collect_command_logs(&logs),
            installed_spec,
            detected_skill_path: skill_md_path
                .parent()
                .map(|path| path.display().to_string()),
        })
    })
    .await
    .map_err(|e| format!("安装 ClawHub skill 失败: {e}"))?
}

fn detect_clawhub_status() -> Result<ClawHubCliStatus, String> {
    if let Some((binary, version)) = find_clawhub_binary() {
        return Ok(ClawHubCliStatus {
            installed: true,
            version: Some(version),
            binary: Some(binary),
        });
    }

    Ok(ClawHubCliStatus {
        installed: false,
        version: None,
        binary: None,
    })
}

fn find_clawhub_binary() -> Option<(String, String)> {
    for candidate in ["clawhub", "clawhub.cmd", "clawhub.exe"] {
        let Ok(output) = Command::new(candidate).arg("--version").output() else {
            continue;
        };
        if !output.status.success() {
            continue;
        }

        let version = normalized_output_text(&output.stdout, &output.stderr);
        return Some((candidate.to_string(), version));
    }
    None
}

fn prepare_command_context(
    app: &tauri::AppHandle,
    site_url: Option<&str>,
    registry_url: Option<&str>,
    purpose: &str,
) -> Result<ClawHubCommandContext, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {e}"))?;
    let session_dir = app_data_dir
        .join("skill-marketplace")
        .join("clawhub")
        .join(format!("{purpose}-{}", Uuid::new_v4()));
    let workdir = session_dir.join("workspace");
    fs::create_dir_all(workdir.join("skills"))
        .map_err(|e| format!("创建 ClawHub 工作目录失败: {e}"))?;

    Ok(ClawHubCommandContext {
        config_path: session_dir.join("config.json"),
        workdir,
        site_url: normalize_optional_value(site_url),
        registry_url: normalize_optional_value(registry_url),
    })
}

fn run_clawhub_login(
    binary: &str,
    context: &ClawHubCommandContext,
    token: &str,
) -> Result<CommandRunResult, String> {
    run_clawhub_command(binary, &["login", "--token", token], context)
}

fn run_clawhub_command(
    binary: &str,
    args: &[&str],
    context: &ClawHubCommandContext,
) -> Result<CommandRunResult, String> {
    let mut command = Command::new(binary);
    command.args(args);
    command.current_dir(&context.workdir);
    command.env(CLAWHUB_CONFIG_PATH_ENV, &context.config_path);
    command.env(CLAWHUB_WORKDIR_ENV, &context.workdir);
    command.env(CLAWHUB_DISABLE_TELEMETRY_ENV, "1");
    if let Some(site_url) = &context.site_url {
        command.env(CLAWHUB_SITE_ENV, site_url);
    }
    if let Some(registry_url) = &context.registry_url {
        command.env(CLAWHUB_REGISTRY_ENV, registry_url);
    }

    let output = command
        .output()
        .map_err(|e| format!("执行 clawhub 命令失败 ({}): {e}", args.join(" ")))?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !output.status.success() {
        let message = if stderr.is_empty() {
            stdout.clone()
        } else if stdout.is_empty() {
            stderr.clone()
        } else {
            format!("{stdout}\n{stderr}")
        };
        return Err(format!(
            "clawhub {} 执行失败{}",
            args.join(" "),
            if message.is_empty() {
                String::new()
            } else {
                format!(": {message}")
            }
        ));
    }

    Ok(CommandRunResult { stdout, stderr })
}

fn normalized_output_text(stdout: &[u8], stderr: &[u8]) -> String {
    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    if !stdout.is_empty() {
        return stdout;
    }
    String::from_utf8_lossy(stderr).trim().to_string()
}

fn collect_command_logs(results: &[CommandRunResult]) -> String {
    results
        .iter()
        .flat_map(|item| {
            [item.stdout.trim(), item.stderr.trim()]
                .into_iter()
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn normalize_optional_value(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
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
