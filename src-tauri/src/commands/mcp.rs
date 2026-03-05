use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, State};
use serde::{Deserialize, Serialize};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

// ── Types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub transport: String, // "stdio" | "sse"
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub url: Option<String>,
    pub env: Option<HashMap<String, String>>,
    pub headers: Option<HashMap<String, String>>,
    pub enabled: bool,
    #[serde(default)]
    pub auto_start: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct McpToolDef {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct McpResourceDef {
    pub uri: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct McpPromptDef {
    pub name: String,
    pub description: Option<String>,
    pub arguments: Option<Vec<serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerStatus {
    pub id: String,
    pub name: String,
    pub transport: String,
    pub enabled: bool,
    pub running: bool,
}

// ── State Manager ──

pub struct McpServerManager {
    pub processes: Mutex<HashMap<String, Child>>,
}

impl McpServerManager {
    pub fn new() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
        }
    }
}

// ── Config Persistence ──

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let db_dir = app_data.join("mtools-db");
    std::fs::create_dir_all(&db_dir).map_err(|e| format!("Failed to create db dir: {}", e))?;
    Ok(db_dir.join("mcp_servers.json"))
}

#[tauri::command]
pub async fn mcp_save_config(
    configs: Vec<McpServerConfig>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let path = config_path(&app)?;
    let json = serde_json::to_string_pretty(&configs)
        .map_err(|e| format!("Serialize error: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("Write error: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn mcp_load_config(app: tauri::AppHandle) -> Result<Vec<McpServerConfig>, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let json = std::fs::read_to_string(&path).map_err(|e| format!("Read error: {}", e))?;
    let configs: Vec<McpServerConfig> =
        serde_json::from_str(&json).map_err(|e| format!("Parse error: {}", e))?;
    Ok(configs)
}

// ── Server Status ──

#[tauri::command]
pub async fn mcp_list_servers(
    app: tauri::AppHandle,
    manager: State<'_, McpServerManager>,
) -> Result<Vec<McpServerStatus>, String> {
    let configs = mcp_load_config(app).await.unwrap_or_default();
    let processes = manager
        .processes
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?;

    Ok(configs
        .into_iter()
        .map(|c| McpServerStatus {
            running: processes.contains_key(&c.id),
            id: c.id,
            name: c.name,
            transport: c.transport,
            enabled: c.enabled,
        })
        .collect())
}

#[tauri::command]
pub async fn mcp_get_server_status(
    server_id: String,
    manager: State<'_, McpServerManager>,
) -> Result<bool, String> {
    let processes = manager
        .processes
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?;
    Ok(processes.contains_key(&server_id))
}

// ── npx path resolution ──

fn find_npx_path() -> Option<String> {
    let common_paths = vec![
        format!(
            "{}/.volta/bin/npx",
            std::env::var("HOME").unwrap_or_default()
        ),
        "/usr/local/bin/npx".to_string(),
        "/opt/homebrew/bin/npx".to_string(),
        format!(
            "{}/.nvm/versions/node/*/bin/npx",
            std::env::var("HOME").unwrap_or_default()
        ),
        format!(
            "{}/.local/bin/npx",
            std::env::var("HOME").unwrap_or_default()
        ),
        format!("{}/bin/npx", std::env::var("HOME").unwrap_or_default()),
        format!(
            "{}\\AppData\\Local\\Volta\\bin\\npx.cmd",
            std::env::var("USERPROFILE").unwrap_or_default()
        ),
        "C:\\Program Files\\nodejs\\npx.cmd".to_string(),
        format!(
            "{}\\AppData\\Roaming\\npm\\npx.cmd",
            std::env::var("USERPROFILE").unwrap_or_default()
        ),
    ];

    if let Ok(path_var) = std::env::var("PATH") {
        let separator = if cfg!(target_os = "windows") { ';' } else { ':' };

        if cfg!(target_os = "windows") {
            for path in path_var.split(separator) {
                let npx_cmd = PathBuf::from(path).join("npx.cmd");
                if npx_cmd.exists() {
                    return Some(npx_cmd.to_string_lossy().to_string());
                }
            }
            for path in path_var.split(separator) {
                let npx_path = PathBuf::from(path).join("npx");
                if npx_path.exists() {
                    return Some(npx_path.to_string_lossy().to_string());
                }
            }
        } else {
            for path in path_var.split(separator) {
                let npx_path = PathBuf::from(path).join("npx");
                if npx_path.exists() {
                    return Some(npx_path.to_string_lossy().to_string());
                }
            }
        }
    }

    for path in &common_paths {
        if path.contains('*') {
            if let Some(parent) = path.rsplit_once('/').map(|(p, _)| p) {
                if let Ok(entries) = std::fs::read_dir(parent.replace("/*", "")) {
                    for entry in entries.flatten() {
                        let npx_path = entry.path().join("bin/npx");
                        if npx_path.exists() {
                            return Some(npx_path.to_string_lossy().to_string());
                        }
                    }
                }
            }
        } else {
            let npx_path = PathBuf::from(&path);
            if npx_path.exists() {
                return Some(path.clone());
            }
        }
    }
    None
}

// ── Stdio Transport ──

#[tauri::command]
pub async fn start_mcp_stdio_server(
    server_id: String,
    command: String,
    args: Vec<String>,
    env: HashMap<String, String>,
    manager: State<'_, McpServerManager>,
) -> Result<String, String> {
    println!(
        "Starting MCP stdio server: {} with command: {}",
        server_id, command
    );

    {
        let mut processes = manager
            .processes
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        if let Some(mut old_child) = processes.remove(&server_id) {
            let _ = old_child.kill();
            println!("Stopped existing MCP server: {}", server_id);
        }
    }

    let mut cmd = if command == "npx" || command.ends_with("/npx") || command.ends_with("\\npx") {
        let npx_path = find_npx_path();
        if let Some(npx) = npx_path {
            println!("Using npx at: {}", npx);
            #[cfg(target_os = "windows")]
            {
                if npx.ends_with(".cmd") || npx.ends_with(".bat") {
                    let mut cmd = Command::new("cmd");
                    cmd.args(&["/C", &npx]);
                    cmd.args(&args);
                    cmd
                } else {
                    let mut cmd = Command::new(&npx);
                    cmd.args(&args);
                    cmd
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let mut cmd = Command::new(&npx);
                cmd.args(&args);
                cmd
            }
        } else {
            let full_command = if args.is_empty() {
                command.clone()
            } else {
                format!("{} {}", command, args.join(" "))
            };
            #[cfg(target_os = "windows")]
            {
                let mut cmd = Command::new("cmd");
                cmd.args(&["/C", &full_command]);
                cmd
            }
            #[cfg(not(target_os = "windows"))]
            {
                let mut cmd = Command::new("sh");
                cmd.args(&["-c", &full_command]);
                cmd
            }
        }
    } else {
        let mut cmd = Command::new(&command);
        cmd.args(&args);
        cmd
    };

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    for (key, value) in env {
        cmd.env(key, value);
    }

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::System::Threading::CREATE_NO_WINDOW;
        cmd.creation_flags(CREATE_NO_WINDOW.0);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn process: {}", e))?;

    {
        let mut processes = manager
            .processes
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        processes.insert(server_id.clone(), child);
    }

    Ok(format!("Server {} started", server_id))
}

// ── Stop ──

#[tauri::command]
pub async fn stop_mcp_server(
    server_id: String,
    manager: State<'_, McpServerManager>,
) -> Result<(), String> {
    let mut processes = manager
        .processes
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?;

    if let Some(mut child) = processes.remove(&server_id) {
        child
            .kill()
            .map_err(|e| format!("Failed to kill process: {}", e))?;
        Ok(())
    } else {
        Err(format!("Server {} not found", server_id))
    }
}

// ── JSON-RPC Message ──

#[tauri::command]
pub async fn send_mcp_message(
    server_id: String,
    message: String,
    manager: State<'_, McpServerManager>,
) -> Result<String, String> {
    let mut processes = manager
        .processes
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?;

    if let Some(child) = processes.get_mut(&server_id) {
        let stdin = child.stdin.as_mut().ok_or("Failed to get stdin")?;
        let stdout = child.stdout.as_mut().ok_or("Failed to get stdout")?;

        writeln!(stdin, "{}", message).map_err(|e| format!("Failed to write to stdin: {}", e))?;
        stdin
            .flush()
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;

        let mut reader = BufReader::new(stdout);
        let mut lines = Vec::new();

        loop {
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .map_err(|e| format!("Failed to read from stdout: {}", e))?;

            let trimmed = line.trim();
            if trimmed.is_empty() {
                break;
            }
            if lines.is_empty() && trimmed.starts_with('{') {
                return Ok(trimmed.to_string());
            }
            lines.push(line);
        }

        for line in &lines {
            let trimmed = line.trim();
            if trimmed.starts_with("data: ") {
                let json_data = trimmed.strip_prefix("data: ").unwrap_or("");
                return Ok(json_data.to_string());
            }
        }

        Ok(lines.join("\n").trim().to_string())
    } else {
        Err(format!("Server {} not found", server_id))
    }
}

// ── SSE Transport ──

#[tauri::command]
pub async fn mcp_send_sse_message(
    url: String,
    message: String,
    headers: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let mut req = client.post(&url).header("Content-Type", "application/json");
    if let Some(h) = headers {
        for (k, v) in h {
            req = req.header(&k, &v);
        }
    }
    let resp = req
        .body(message)
        .send()
        .await
        .map_err(|e| format!("SSE request failed: {}", e))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read SSE response: {}", e))?;

    if !status.is_success() {
        return Err(format!("SSE server returned {}: {}", status, body));
    }

    Ok(body)
}
