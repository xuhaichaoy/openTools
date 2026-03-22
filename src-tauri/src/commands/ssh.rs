use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};

const SSH_KEEPALIVE_INTERVAL_SECS: u32 = 3;
const TRANSPORT_READ_ERROR_RETRY_LIMIT: u32 = 400;
const SSH_EVENT_WAIT_MS: u64 = 100;

fn is_transient_io_error(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::Interrupted
    )
}

fn is_transport_read_error(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::Other
        && err
            .to_string()
            .to_ascii_lowercase()
            .contains("transport read")
}

fn is_transient_channel_write_error(err: &std::io::Error) -> bool {
    if is_transient_io_error(err) || is_transport_read_error(err) {
        return true;
    }
    let msg = err.to_string().to_ascii_lowercase();
    msg.contains("draining incoming flow")
        || msg.contains("would block")
        || msg.contains("wouldblock")
}

fn log_ssh_info(session_id: &str, message: &str) {
    log::info!("[ssh:{}] {}", session_id, message);
}

fn log_ssh_warn(session_id: &str, message: &str) {
    log::warn!("[ssh:{}] {}", session_id, message);
}

fn append_recent_output(recent: &mut String, chunk: &str, max_len: usize) {
    recent.push_str(chunk);
    if recent.len() > max_len {
        let drain_len = recent.len() - max_len;
        recent.drain(..drain_len);
    }
}

fn handle_shell_msg(
    msg: ShellMsg,
    pending_write: &mut Vec<u8>,
    channel: &mut ssh2::Channel,
    session_id_for_log: &str,
) -> Result<(), String> {
    match msg {
        ShellMsg::Data(data) => {
            if !data.is_empty() {
                pending_write.extend_from_slice(&data);
            }
            Ok(())
        }
        ShellMsg::Resize(cols, rows) => {
            if let Err(e) = channel.request_pty_size(cols, rows, None, None) {
                log_ssh_warn(
                    session_id_for_log,
                    &format!(
                        "request_pty_size failed cols={} rows={} err={}",
                        cols, rows, e
                    ),
                );
            }
            Ok(())
        }
        ShellMsg::Close => Err("received close signal".to_string()),
    }
}

// ── Types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConnectionConfig {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String, // "password" | "key" | "agent"
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<i64>,
    pub permissions: Option<String>,
}

// ── Shell message sent from write/resize commands to the reader thread ──

enum ShellMsg {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

// ── State Manager ──

pub struct SshManager {
    configs: Mutex<HashMap<String, SshConnectionConfig>>,
    connected: Mutex<HashMap<String, bool>>,
    shell_writers: Mutex<HashMap<String, std::sync::mpsc::Sender<ShellMsg>>>,
    sftp_sessions: Mutex<HashMap<String, ssh2::Session>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            configs: Mutex::new(HashMap::new()),
            connected: Mutex::new(HashMap::new()),
            shell_writers: Mutex::new(HashMap::new()),
            sftp_sessions: Mutex::new(HashMap::new()),
        }
    }
}

fn create_session(config: &SshConnectionConfig) -> Result<ssh2::Session, String> {
    log_ssh_info(
        &config.id,
        &format!(
            "create_session start host={} port={} user={} auth={}",
            config.host, config.port, config.username, config.auth_type
        ),
    );

    let tcp = std::net::TcpStream::connect(format!("{}:{}", config.host, config.port))
        .map_err(|e| format!("TCP connection failed: {}", e))?;

    let mut session =
        ssh2::Session::new().map_err(|e| format!("Session creation failed: {}", e))?;
    session.set_tcp_stream(tcp);
    session
        .handshake()
        .map_err(|e| format!("SSH handshake failed: {}", e))?;
    log_ssh_info(&config.id, "handshake ok");

    match config.auth_type.as_str() {
        "password" => {
            let password = config.password.as_deref().unwrap_or("");
            session
                .userauth_password(&config.username, password)
                .map_err(|e| format!("Password auth failed: {}", e))?;
        }
        "key" => {
            let key_path = config
                .private_key_path
                .as_ref()
                .ok_or("Private key path required")?;
            let passphrase = config.passphrase.as_deref();
            session
                .userauth_pubkey_file(
                    &config.username,
                    None,
                    std::path::Path::new(key_path),
                    passphrase,
                )
                .map_err(|e| format!("Key auth failed: {}", e))?;
        }
        "agent" => {
            let mut agent = session
                .agent()
                .map_err(|e| format!("SSH agent init failed: {}", e))?;
            agent
                .connect()
                .map_err(|e| format!("SSH agent connect failed: {}", e))?;
            agent
                .list_identities()
                .map_err(|e| format!("SSH agent list identities failed: {}", e))?;
            let identities = agent
                .identities()
                .map_err(|e| format!("SSH agent identities failed: {}", e))?;
            let mut authed = false;
            for identity in identities {
                if agent.userauth(&config.username, &identity).is_ok() {
                    authed = true;
                    break;
                }
            }
            if !authed {
                return Err("SSH agent authentication failed: no matching identity".to_string());
            }
        }
        _ => return Err(format!("Unknown auth type: {}", config.auth_type)),
    }

    if !session.authenticated() {
        log_ssh_warn(&config.id, "authentication check failed");
        return Err("Authentication failed".to_string());
    }
    log_ssh_info(&config.id, "authenticated");

    // Keep idle connections alive through NAT / LB / firewall.
    session.set_keepalive(true, SSH_KEEPALIVE_INTERVAL_SECS);
    log_ssh_info(
        &config.id,
        &format!(
            "keepalive enabled interval={}s",
            SSH_KEEPALIVE_INTERVAL_SECS
        ),
    );

    Ok(session)
}

// ── Config Persistence ──

fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let db_dir = app_data.join("mtools-db");
    std::fs::create_dir_all(&db_dir).map_err(|e| format!("Failed to create dir: {}", e))?;
    Ok(db_dir.join("ssh_connections.json"))
}

#[tauri::command]
pub async fn ssh_save_connections(
    connections: Vec<SshConnectionConfig>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let path = config_path(&app)?;
    let json = serde_json::to_string_pretty(&connections)
        .map_err(|e| format!("Serialize error: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("Write error: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_load_connections(
    app: tauri::AppHandle,
) -> Result<Vec<SshConnectionConfig>, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let json = std::fs::read_to_string(&path).map_err(|e| format!("Read error: {}", e))?;
    serde_json::from_str(&json).map_err(|e| format!("Parse error: {}", e))
}

// ── Connection Management ──

#[tauri::command]
pub async fn ssh_connect(
    config: SshConnectionConfig,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    log_ssh_info(&config.id, "ssh_connect called");

    // Validate credentials by creating a test session
    let session = create_session(&config).map_err(|e| {
        log_ssh_warn(&config.id, &format!("ssh_connect validation failed: {}", e));
        e
    })?;
    let _ = session.disconnect(None, "test ok", None);

    let session_id = config.id.clone();
    {
        let mut configs = manager.configs.lock().map_err(|e| format!("Lock: {}", e))?;
        configs.insert(session_id.clone(), config);
    }
    {
        let mut connected = manager
            .connected
            .lock()
            .map_err(|e| format!("Lock: {}", e))?;
        connected.insert(session_id.clone(), true);
    }
    log_ssh_info(&session_id, "ssh_connect success");
    Ok(session_id)
}

#[tauri::command]
pub async fn ssh_disconnect(
    session_id: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    log_ssh_info(&session_id, "ssh_disconnect called");

    // Signal shell thread to close
    {
        let mut writers = manager
            .shell_writers
            .lock()
            .map_err(|e| format!("Lock: {}", e))?;
        if let Some(tx) = writers.remove(&session_id) {
            let _ = tx.send(ShellMsg::Close);
            log_ssh_info(&session_id, "shell close signal sent");
        } else {
            log_ssh_warn(&session_id, "shell writer not found during disconnect");
        }
    }
    {
        let mut connected = manager
            .connected
            .lock()
            .map_err(|e| format!("Lock: {}", e))?;
        connected.remove(&session_id);
    }
    {
        let mut sftp_sessions = manager
            .sftp_sessions
            .lock()
            .map_err(|e| format!("Lock: {}", e))?;
        if let Some(session) = sftp_sessions.remove(&session_id) {
            let _ = session.disconnect(None, "bye", None);
            log_ssh_info(&session_id, "sftp session removed");
        }
    }
    log_ssh_info(&session_id, "ssh_disconnect completed");
    Ok(())
}

// ── Shell / Terminal ──

#[tauri::command]
pub async fn ssh_shell_open(
    session_id: String,
    cols: u32,
    rows: u32,
    manager: State<'_, SshManager>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    log_ssh_info(
        &session_id,
        &format!("ssh_shell_open called cols={} rows={}", cols, rows),
    );

    // Get config and create a dedicated session for the shell
    let config = {
        let configs = manager.configs.lock().map_err(|e| format!("Lock: {}", e))?;
        configs
            .get(&session_id)
            .cloned()
            .ok_or(format!("Config {} not found", session_id))?
    };

    let session = create_session(&config).map_err(|e| {
        log_ssh_warn(
            &session_id,
            &format!("create session for shell failed: {}", e),
        );
        e
    })?;
    let mut channel = session.channel_session().map_err(|e| {
        let msg = format!("Channel open failed: {}", e);
        log_ssh_warn(&session_id, &msg);
        msg
    })?;
    channel
        .request_pty("xterm-256color", None, Some((cols, rows, 0, 0)))
        .map_err(|e| {
            let msg = format!("PTY request failed: {}", e);
            log_ssh_warn(&session_id, &msg);
            msg
        })?;
    channel.shell().map_err(|e| {
        let msg = format!("Shell request failed: {}", e);
        log_ssh_warn(&session_id, &msg);
        msg
    })?;
    log_ssh_info(&session_id, "shell channel opened");

    // Non-blocking mode avoids transport read timeout edge-cases in blocking mode.
    // We poll reads/writes in a loop with a short idle sleep.
    session.set_blocking(false);

    let (tx, rx) = std::sync::mpsc::channel::<ShellMsg>();
    {
        let mut writers = manager
            .shell_writers
            .lock()
            .map_err(|e| format!("Lock: {}", e))?;
        if let Some(old_tx) = writers.insert(session_id.clone(), tx) {
            let _ = old_tx.send(ShellMsg::Close);
            log_ssh_warn(
                &session_id,
                "existing shell writer replaced; sent close to previous shell",
            );
        }
    }
    log_ssh_info(&session_id, "shell writer registered");

    let event_out = format!("ssh-output-{}", session_id);
    let event_closed = format!("ssh-closed-{}", session_id);
    let session_id_for_log = session_id.clone();

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut last_keepalive = Instant::now();
        let mut keepalive_success_count: u64 = 0;
        let mut transport_read_error_count: u32 = 0;
        let mut write_drain_error_count: u32 = 0;
        let mut pending_write: Vec<u8> = Vec::new();
        let mut recent_output = String::new();
        log_ssh_info(&session_id_for_log, "shell thread started");
        let close_reason = 'shell_loop: loop {
            if last_keepalive.elapsed() >= Duration::from_secs(SSH_KEEPALIVE_INTERVAL_SECS as u64) {
                // Keepalive failures can be transient on unstable networks.
                // Do not force-close the shell here; real disconnects are still
                // detected by read/write/eof.
                match session.keepalive_send() {
                    Ok(next_hint) => {
                        keepalive_success_count += 1;
                        if keepalive_success_count % 20 == 0 {
                            log_ssh_info(
                                &session_id_for_log,
                                &format!(
                                    "keepalive ok count={} next_hint={}s",
                                    keepalive_success_count, next_hint
                                ),
                            );
                        }
                    }
                    Err(e) => {
                        log_ssh_warn(
                            &session_id_for_log,
                            &format!("keepalive_send failed (transient tolerated): {}", e),
                        );
                    }
                }
                last_keepalive = Instant::now();
            }

            if pending_write.is_empty() {
                match rx.recv_timeout(Duration::from_millis(SSH_EVENT_WAIT_MS)) {
                    Ok(msg) => {
                        if let Err(reason) = handle_shell_msg(
                            msg,
                            &mut pending_write,
                            &mut channel,
                            &session_id_for_log,
                        ) {
                            break 'shell_loop reason;
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        break 'shell_loop "shell command channel disconnected".to_string();
                    }
                }
            }

            while let Ok(msg) = rx.try_recv() {
                if let Err(reason) = handle_shell_msg(
                    msg,
                    &mut pending_write,
                    &mut channel,
                    &session_id_for_log,
                ) {
                    break 'shell_loop reason;
                }
            }

            // 1.5) Flush queued stdin data with non-blocking partial writes.
            if !pending_write.is_empty() {
                match channel.write(&pending_write) {
                    Ok(0) => {
                        write_drain_error_count += 1;
                        if write_drain_error_count == 1 || write_drain_error_count % 20 == 0 {
                            log_ssh_warn(
                                &session_id_for_log,
                                &format!(
                                    "channel.write returned 0 count={}",
                                    write_drain_error_count
                                ),
                            );
                        }
                    }
                    Ok(n) => {
                        pending_write.drain(..n);
                        write_drain_error_count = 0;
                    }
                    Err(ref e) if is_transient_channel_write_error(e) => {
                        write_drain_error_count += 1;
                        if write_drain_error_count == 1 || write_drain_error_count % 20 == 0 {
                            log_ssh_warn(
                                &session_id_for_log,
                                &format!(
                                    "channel.write transient/drain error count={} pending_bytes={} err={}",
                                    write_drain_error_count,
                                    pending_write.len(),
                                    e
                                ),
                            );
                        }
                    }
                    Err(e) => {
                        break 'shell_loop format!("channel.write fatal error: {}", e);
                    }
                }
            }

            // 2) Read stdout (non-blocking)
            match channel.read(&mut buf) {
                Ok(0) => break 'shell_loop "stdout read returned 0 (remote closed)".to_string(),
                Ok(n) => {
                    transport_read_error_count = 0;
                    write_drain_error_count = 0;
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    append_recent_output(&mut recent_output, &data, 1024);
                    let _ = app.emit(&event_out, data);
                    // More data might be available, skip to next iteration immediately
                    continue;
                }
                Err(ref e)
                    if e.kind() == std::io::ErrorKind::WouldBlock
                        || e.kind() == std::io::ErrorKind::TimedOut =>
                {
                    transport_read_error_count = 0;
                    // Timeout — no data available, loop back to check writes
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => {
                    transport_read_error_count = 0;
                    // Interrupted by signal — retry loop.
                }
                Err(ref e) if is_transport_read_error(e) => {
                    transport_read_error_count += 1;
                    if transport_read_error_count == 1 || transport_read_error_count % 20 == 0 {
                        log_ssh_warn(
                            &session_id_for_log,
                            &format!(
                                "stdout transport read error count={} kind={:?} raw_os_error={:?} msg={}",
                                transport_read_error_count,
                                e.kind(),
                                e.raw_os_error(),
                                e
                            ),
                        );
                    }
                    if transport_read_error_count >= TRANSPORT_READ_ERROR_RETRY_LIMIT {
                        break 'shell_loop format!(
                            "stdout transport read exceeded retry limit={} kind={:?} raw_os_error={:?}",
                            TRANSPORT_READ_ERROR_RETRY_LIMIT,
                            e.kind(),
                            e.raw_os_error()
                        );
                    }
                    std::thread::sleep(Duration::from_millis(20));
                    continue;
                }
                Err(e) => {
                    break 'shell_loop format!(
                        "stdout read fatal error: {} kind={:?} raw_os_error={:?}",
                        e,
                        e.kind(),
                        e.raw_os_error()
                    )
                }
            }

            // 3) Read stderr (same timeout applies)
            match channel.stderr().read(&mut buf) {
                Ok(n) if n > 0 => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    append_recent_output(&mut recent_output, &data, 1024);
                    let _ = app.emit(&event_out, data);
                    transport_read_error_count = 0;
                    write_drain_error_count = 0;
                }
                _ => {}
            }

            if channel.eof() {
                break 'shell_loop "channel eof".to_string();
            }
        };

        log_ssh_warn(
            &session_id_for_log,
            &format!("shell loop exiting: {}", close_reason),
        );
        if close_reason == "received close signal" {
            log_ssh_info(&session_id_for_log, "shell thread closed by signal");
        }
        if !recent_output.is_empty() {
            let recent = recent_output.replace('\r', "\\r").replace('\n', "\\n");
            log_ssh_info(
                &session_id_for_log,
                &format!("recent terminal output tail: {}", recent),
            );
        } else {
            log_ssh_info(&session_id_for_log, "recent terminal output tail: <empty>");
        }
        session.set_timeout(0);
        let _ = channel.close();
        let _ = session.disconnect(None, "bye", None);
        let _ = app.emit(&event_closed, ());
        log_ssh_info(&session_id_for_log, "shell thread emitted closed event");
    });

    log_ssh_info(&session_id, "ssh_shell_open success");
    Ok(())
}

#[tauri::command]
pub async fn ssh_shell_write(
    session_id: String,
    data: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let writers = manager
        .shell_writers
        .lock()
        .map_err(|e| format!("Lock: {}", e))?;
    let tx = writers.get(&session_id).ok_or_else(|| {
        let msg = format!("No shell for session {}", session_id);
        log_ssh_warn(&session_id, &msg);
        msg
    })?;
    tx.send(ShellMsg::Data(data.into_bytes())).map_err(|e| {
        let msg = format!("Send error: {}", e);
        log_ssh_warn(&session_id, &msg);
        msg
    })?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_shell_resize(
    session_id: String,
    cols: u32,
    rows: u32,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    let writers = manager
        .shell_writers
        .lock()
        .map_err(|e| format!("Lock: {}", e))?;
    let tx = writers.get(&session_id).ok_or_else(|| {
        let msg = format!("No shell for session {}", session_id);
        log_ssh_warn(&session_id, &msg);
        msg
    })?;
    tx.send(ShellMsg::Resize(cols, rows)).map_err(|e| {
        let msg = format!("Send error: {}", e);
        log_ssh_warn(&session_id, &msg);
        msg
    })?;
    Ok(())
}

// ── SFTP (reuses one SSH session per connection id) ──

fn get_sftp_config(
    manager: &State<'_, SshManager>,
    session_id: &str,
) -> Result<SshConnectionConfig, String> {
    let configs = manager.configs.lock().map_err(|e| format!("Lock: {}", e))?;
    configs
        .get(session_id)
        .cloned()
        .ok_or(format!("Config {} not found", session_id))
}

fn ensure_sftp_session(manager: &State<'_, SshManager>, session_id: &str) -> Result<(), String> {
    {
        let sessions = manager
            .sftp_sessions
            .lock()
            .map_err(|e| format!("Lock: {}", e))?;
        if sessions.contains_key(session_id) {
            return Ok(());
        }
    }

    let config = get_sftp_config(manager, session_id)?;
    let session = create_session(&config)?;
    let mut sessions = manager
        .sftp_sessions
        .lock()
        .map_err(|e| format!("Lock: {}", e))?;
    sessions.insert(session_id.to_string(), session);
    log_ssh_info(session_id, "sftp session created");
    Ok(())
}

fn with_sftp_session<T, F>(
    manager: &State<'_, SshManager>,
    session_id: &str,
    op_name: &str,
    mut op: F,
) -> Result<T, String>
where
    F: FnMut(&ssh2::Sftp) -> Result<T, String>,
{
    let mut last_err = "unknown sftp error".to_string();

    for attempt in 1..=2 {
        ensure_sftp_session(manager, session_id)?;
        let result = {
            let sessions = manager
                .sftp_sessions
                .lock()
                .map_err(|e| format!("Lock: {}", e))?;
            let session = sessions
                .get(session_id)
                .ok_or(format!("No SFTP session for {}", session_id))?;
            let sftp = session
                .sftp()
                .map_err(|e| format!("SFTP init failed: {}", e))?;
            op(&sftp)
        };

        match result {
            Ok(v) => return Ok(v),
            Err(e) => {
                last_err = e;
                let mut sessions = manager
                    .sftp_sessions
                    .lock()
                    .map_err(|le| format!("Lock: {}", le))?;
                sessions.remove(session_id);
                log_ssh_warn(
                    session_id,
                    &format!(
                        "{} failed on attempt {} (session reset): {}",
                        op_name, attempt, last_err
                    ),
                );
            }
        }
    }

    Err(last_err)
}

#[tauri::command]
pub async fn ssh_sftp_list(
    session_id: String,
    path: String,
    manager: State<'_, SshManager>,
) -> Result<Vec<SftpEntry>, String> {
    with_sftp_session(&manager, &session_id, "sftp_list", |sftp| {
        let dir = sftp
            .readdir(std::path::Path::new(&path))
            .map_err(|e| format!("SFTP readdir failed: {}", e))?;

        Ok(dir
            .into_iter()
            .map(|(path_buf, stat)| {
                let name = path_buf
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                let full_path = path_buf.to_string_lossy().to_string();
                SftpEntry {
                    name,
                    path: full_path,
                    is_dir: stat.is_dir(),
                    size: stat.size.unwrap_or(0),
                    modified: stat.mtime.map(|t| t as i64),
                    permissions: stat.perm.map(|p| format!("{:o}", p)),
                }
            })
            .collect())
    })
}

#[tauri::command]
pub async fn ssh_sftp_read(
    session_id: String,
    path: String,
    manager: State<'_, SshManager>,
) -> Result<String, String> {
    with_sftp_session(&manager, &session_id, "sftp_read", |sftp| {
        let mut file = sftp
            .open(std::path::Path::new(&path))
            .map_err(|e| format!("SFTP open failed: {}", e))?;

        let mut content = String::new();
        file.read_to_string(&mut content)
            .map_err(|e| format!("SFTP read failed: {}", e))?;

        Ok(content)
    })
}

#[tauri::command]
pub async fn ssh_sftp_write(
    session_id: String,
    path: String,
    content: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    with_sftp_session(&manager, &session_id, "sftp_write", |sftp| {
        let mut file = sftp
            .create(std::path::Path::new(&path))
            .map_err(|e| format!("SFTP create failed: {}", e))?;

        file.write_all(content.as_bytes())
            .map_err(|e| format!("SFTP write failed: {}", e))?;

        Ok(())
    })
}

#[tauri::command]
pub async fn ssh_sftp_mkdir(
    session_id: String,
    path: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    with_sftp_session(&manager, &session_id, "sftp_mkdir", |sftp| {
        sftp.mkdir(std::path::Path::new(&path), 0o755)
            .map_err(|e| format!("SFTP mkdir failed: {}", e))?;
        Ok(())
    })
}

#[tauri::command]
pub async fn ssh_sftp_remove(
    session_id: String,
    path: String,
    is_dir: bool,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    with_sftp_session(&manager, &session_id, "sftp_remove", |sftp| {
        if is_dir {
            sftp.rmdir(std::path::Path::new(&path))
                .map_err(|e| format!("SFTP rmdir failed: {}", e))?;
        } else {
            sftp.unlink(std::path::Path::new(&path))
                .map_err(|e| format!("SFTP unlink failed: {}", e))?;
        }
        Ok(())
    })
}

#[tauri::command]
pub async fn ssh_sftp_rename(
    session_id: String,
    old_path: String,
    new_path: String,
    manager: State<'_, SshManager>,
) -> Result<(), String> {
    with_sftp_session(&manager, &session_id, "sftp_rename", |sftp| {
        sftp.rename(
            std::path::Path::new(&old_path),
            std::path::Path::new(&new_path),
            None,
        )
        .map_err(|e| format!("SFTP rename failed: {}", e))?;
        Ok(())
    })
}
