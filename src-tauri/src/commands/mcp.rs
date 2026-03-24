use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, State};

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
    pub processes: Mutex<HashMap<String, ManagedMcpProcess>>,
}

impl McpServerManager {
    pub fn new() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
        }
    }
}

pub struct ManagedMcpProcess {
    pub child: Child,
    pub stdin: ChildStdin,
    pub stdout: BufReader<ChildStdout>,
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
    let json =
        serde_json::to_string_pretty(&configs).map_err(|e| format!("Serialize error: {}", e))?;
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
        let separator = if cfg!(target_os = "windows") {
            ';'
        } else {
            ':'
        };

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

fn build_mcp_stdio_frame(message: &str) -> String {
    format!(
        "Content-Length: {}\r\n\r\n{}",
        message.as_bytes().len(),
        message
    )
}

fn read_mcp_message_from_reader<R: BufRead + Read>(stdout: &mut R) -> Result<String, String> {
    let mut content_length: Option<usize> = None;
    let mut saw_header = false;
    let mut noise_lines: Vec<String> = Vec::new();

    loop {
        let mut line = String::new();
        let bytes_read = stdout
            .read_line(&mut line)
            .map_err(|e| format!("Failed to read MCP header: {}", e))?;

        if bytes_read == 0 {
            if let Some(raw_json) = noise_lines
                .iter()
                .rev()
                .map(|line| line.trim())
                .find(|line| line.starts_with('{') || line.starts_with('['))
            {
                return Ok(raw_json.to_string());
            }
            return Ok(String::new());
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            if saw_header {
                break;
            }
            continue;
        }

        if !saw_header && (trimmed.starts_with('{') || trimmed.starts_with('[')) {
            return Ok(trimmed.to_string());
        }

        if let Some(value) = trimmed
            .strip_prefix("Content-Length:")
            .or_else(|| trimmed.strip_prefix("content-length:"))
        {
            let parsed = value
                .trim()
                .parse::<usize>()
                .map_err(|e| format!("Invalid MCP Content-Length: {}", e))?;
            content_length = Some(parsed);
            saw_header = true;
            continue;
        }

        if saw_header {
            continue;
        }

        noise_lines.push(trimmed.to_string());
    }

    let length = content_length.ok_or("Missing MCP Content-Length header")?;
    let mut body = vec![0u8; length];
    stdout
        .read_exact(&mut body)
        .map_err(|e| format!("Failed to read MCP body: {}", e))?;
    String::from_utf8(body).map_err(|e| format!("Invalid UTF-8 in MCP response: {}", e))
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
        if let Some(mut old_process) = processes.remove(&server_id) {
            let _ = old_process.child.kill();
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

    let mut child = child;
    let stdin = child.stdin.take().ok_or("Failed to capture stdin")?;
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    if let Some(stderr) = child.stderr.take() {
        let server_id_for_log = server_id.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            loop {
                let mut line = String::new();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        let trimmed = line.trim();
                        if !trimmed.is_empty() {
                            eprintln!("[mcp:{}] {}", server_id_for_log, trimmed);
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }

    {
        let mut processes = manager
            .processes
            .lock()
            .map_err(|e| format!("Lock poisoned: {}", e))?;
        processes.insert(
            server_id.clone(),
            ManagedMcpProcess {
                child,
                stdin,
                stdout: BufReader::new(stdout),
            },
        );
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

    if let Some(mut process) = processes.remove(&server_id) {
        process
            .child
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

    if let Some(process) = processes.get_mut(&server_id) {
        write!(process.stdin, "{}", build_mcp_stdio_frame(&message))
            .map_err(|e| format!("Failed to write to stdin: {}", e))?;
        process
            .stdin
            .flush()
            .map_err(|e| format!("Failed to flush stdin: {}", e))?;
        read_mcp_message_from_reader(&mut process.stdout)
    } else {
        Err(format!("Server {} not found", server_id))
    }
}

#[tauri::command]
pub async fn send_mcp_notification(
    server_id: String,
    message: String,
    manager: State<'_, McpServerManager>,
) -> Result<(), String> {
    let mut processes = manager
        .processes
        .lock()
        .map_err(|e| format!("Lock poisoned: {}", e))?;

    if let Some(process) = processes.get_mut(&server_id) {
        write!(process.stdin, "{}", build_mcp_stdio_frame(&message))
            .map_err(|e| format!("Failed to write notification to stdin: {}", e))?;
        process
            .stdin
            .flush()
            .map_err(|e| format!("Failed to flush notification stdin: {}", e))?;
        Ok(())
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

#[cfg(test)]
mod tests {
    use super::{build_mcp_stdio_frame, read_mcp_message_from_reader};
    use std::io::Cursor;

    #[test]
    fn builds_standard_mcp_stdio_frame() {
        let frame = build_mcp_stdio_frame("{\"jsonrpc\":\"2.0\"}");
        assert!(frame.starts_with("Content-Length: 17\r\n\r\n"));
        assert!(frame.ends_with("{\"jsonrpc\":\"2.0\"}"));
    }

    #[test]
    fn reads_content_length_framed_message() {
        let payload = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}";
        let raw = format!("Content-Length: {}\r\n\r\n{}", payload.len(), payload);
        let mut reader = Cursor::new(raw.into_bytes());
        let parsed = read_mcp_message_from_reader(&mut reader).unwrap();
        assert_eq!(parsed, payload);
    }

    #[test]
    fn reads_legacy_raw_json_line() {
        let payload = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n";
        let mut reader = Cursor::new(payload.as_bytes());
        let parsed = read_mcp_message_from_reader(&mut reader).unwrap();
        assert_eq!(parsed, payload.trim());
    }
}
