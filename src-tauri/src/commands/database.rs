use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Manager, State};

// ── Types ──

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DatabaseConfig {
    pub id: String,
    pub name: String,
    pub db_type: String, // "sqlite" | "postgres" | "mysql" | "mongodb"
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
    pub file_path: Option<String>,
    pub connection_string: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub affected: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    pub schema: Option<String>,
    pub table_type: Option<String>,
    pub row_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    pub default_value: Option<String>,
}

// ── State ──

enum DbConnection {
    Sqlite(rusqlite::Connection),
    // Postgres/MySQL/MongoDB will use async connections via sqlx/mongodb
    // For now, we support SQLite natively and other types via connection strings
    ConnectionString { db_type: String, #[allow(dead_code)] conn_str: String },
}

pub struct DatabaseManager {
    connections: Mutex<HashMap<String, DbConnection>>,
}

impl DatabaseManager {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
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
    std::fs::create_dir_all(&db_dir).map_err(|e| format!("Create dir failed: {}", e))?;
    Ok(db_dir.join("database_connections.json"))
}

#[tauri::command]
pub async fn db_save_connections(
    connections: Vec<DatabaseConfig>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let path = config_path(&app)?;
    let json =
        serde_json::to_string_pretty(&connections).map_err(|e| format!("Serialize error: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("Write error: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn db_load_connections(app: tauri::AppHandle) -> Result<Vec<DatabaseConfig>, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let json = std::fs::read_to_string(&path).map_err(|e| format!("Read error: {}", e))?;
    serde_json::from_str(&json).map_err(|e| format!("Parse error: {}", e))
}

// ── Connection ──

#[tauri::command]
pub async fn db_connect(
    config: DatabaseConfig,
    manager: State<'_, DatabaseManager>,
) -> Result<String, String> {
    let conn_id = config.id.clone();

    let connection = match config.db_type.as_str() {
        "sqlite" => {
            let path = config
                .file_path
                .as_ref()
                .or(config.database.as_ref())
                .ok_or("SQLite requires a file path")?;
            let conn = rusqlite::Connection::open(path)
                .map_err(|e| format!("SQLite open failed: {}", e))?;
            DbConnection::Sqlite(conn)
        }
        "postgres" | "mysql" | "mongodb" => {
            let conn_str = if let Some(cs) = &config.connection_string {
                cs.clone()
            } else {
                let host = config.host.as_deref().unwrap_or("localhost");
                let port = config.port.unwrap_or(match config.db_type.as_str() {
                    "postgres" => 5432,
                    "mysql" => 3306,
                    "mongodb" => 27017,
                    _ => 5432,
                });
                let user = config.username.as_deref().unwrap_or("root");
                let pass = config.password.as_deref().unwrap_or("");
                let db = config.database.as_deref().unwrap_or("default");

                match config.db_type.as_str() {
                    "postgres" => format!("postgres://{}:{}@{}:{}/{}", user, pass, host, port, db),
                    "mysql" => format!("mysql://{}:{}@{}:{}/{}", user, pass, host, port, db),
                    "mongodb" => format!("mongodb://{}:{}@{}:{}/{}", user, pass, host, port, db),
                    _ => return Err(format!("Unknown db type: {}", config.db_type)),
                }
            };
            DbConnection::ConnectionString {
                db_type: config.db_type.clone(),
                conn_str,
            }
        }
        _ => return Err(format!("Unsupported database type: {}", config.db_type)),
    };

    let mut connections = manager
        .connections
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    connections.insert(conn_id.clone(), connection);

    Ok(conn_id)
}

#[tauri::command]
pub async fn db_disconnect(
    conn_id: String,
    manager: State<'_, DatabaseManager>,
) -> Result<(), String> {
    let mut connections = manager
        .connections
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    connections.remove(&conn_id);
    Ok(())
}

#[tauri::command]
pub async fn db_test_connection(config: DatabaseConfig) -> Result<bool, String> {
    match config.db_type.as_str() {
        "sqlite" => {
            let path = config
                .file_path
                .as_ref()
                .or(config.database.as_ref())
                .ok_or("SQLite requires a file path")?;
            rusqlite::Connection::open(path)
                .map_err(|e| format!("SQLite test failed: {}", e))?;
            Ok(true)
        }
        "postgres" | "mysql" | "mongodb" => {
            // Basic connectivity test via TCP
            let host = config.host.as_deref().unwrap_or("localhost");
            let port = config.port.unwrap_or(5432);
            match std::net::TcpStream::connect_timeout(
                &format!("{}:{}", host, port)
                    .parse()
                    .map_err(|e| format!("Invalid address: {}", e))?,
                std::time::Duration::from_secs(5),
            ) {
                Ok(_) => Ok(true),
                Err(e) => Err(format!("Connection test failed: {}", e)),
            }
        }
        _ => Err(format!("Unsupported: {}", config.db_type)),
    }
}

// ── Query Execution ──

#[tauri::command]
pub async fn db_execute_query(
    conn_id: String,
    query: String,
    manager: State<'_, DatabaseManager>,
) -> Result<QueryResult, String> {
    let start = std::time::Instant::now();

    let connections = manager
        .connections
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    let conn = connections
        .get(&conn_id)
        .ok_or(format!("Connection {} not found", conn_id))?;

    match conn {
        DbConnection::Sqlite(sqlite_conn) => {
            let trimmed = query.trim().to_uppercase();
            let is_select = trimmed.starts_with("SELECT")
                || trimmed.starts_with("PRAGMA")
                || trimmed.starts_with("EXPLAIN");

            if is_select {
                let mut stmt = sqlite_conn
                    .prepare(&query)
                    .map_err(|e| format!("Prepare error: {}", e))?;
                let column_count = stmt.column_count();
                let columns: Vec<String> = (0..column_count)
                    .map(|i| stmt.column_name(i).unwrap_or("?").to_string())
                    .collect();

                let rows_result: Result<Vec<Vec<serde_json::Value>>, _> = stmt
                    .query_map([], |row| {
                        let mut values = Vec::new();
                        for i in 0..column_count {
                            let val: rusqlite::Result<rusqlite::types::Value> = row.get(i);
                            let json_val = match val {
                                Ok(rusqlite::types::Value::Null) => serde_json::Value::Null,
                                Ok(rusqlite::types::Value::Integer(n)) => serde_json::json!(n),
                                Ok(rusqlite::types::Value::Real(f)) => serde_json::json!(f),
                                Ok(rusqlite::types::Value::Text(s)) => serde_json::json!(s),
                                Ok(rusqlite::types::Value::Blob(b)) => {
                                    serde_json::json!(format!("[blob: {} bytes]", b.len()))
                                }
                                Err(_) => serde_json::Value::Null,
                            };
                            values.push(json_val);
                        }
                        Ok(values)
                    })
                    .map_err(|e| format!("Query error: {}", e))?
                    .collect();

                let rows = rows_result.map_err(|e| format!("Row error: {}", e))?;
                let elapsed = start.elapsed().as_millis() as u64;

                Ok(QueryResult {
                    columns,
                    rows,
                    affected: 0,
                    elapsed_ms: elapsed,
                })
            } else {
                let affected = sqlite_conn
                    .execute(&query, [])
                    .map_err(|e| format!("Execute error: {}", e))?;
                let elapsed = start.elapsed().as_millis() as u64;

                Ok(QueryResult {
                    columns: vec![],
                    rows: vec![],
                    affected: affected as u64,
                    elapsed_ms: elapsed,
                })
            }
        }
        DbConnection::ConnectionString { db_type, .. } => {
            Err(format!(
                "{} queries require async connection pool (coming soon). Use SQLite for now.",
                db_type
            ))
        }
    }
}

// ── Schema ──

#[tauri::command]
pub async fn db_list_schemas(
    conn_id: String,
    manager: State<'_, DatabaseManager>,
) -> Result<Vec<String>, String> {
    let connections = manager
        .connections
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    let conn = connections
        .get(&conn_id)
        .ok_or(format!("Connection {} not found", conn_id))?;

    match conn {
        DbConnection::Sqlite(_) => Ok(vec!["main".to_string()]),
        _ => Ok(vec!["public".to_string()]),
    }
}

#[tauri::command]
pub async fn db_list_tables(
    conn_id: String,
    _schema: Option<String>,
    manager: State<'_, DatabaseManager>,
) -> Result<Vec<TableInfo>, String> {
    let connections = manager
        .connections
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    let conn = connections
        .get(&conn_id)
        .ok_or(format!("Connection {} not found", conn_id))?;

    match conn {
        DbConnection::Sqlite(sqlite_conn) => {
            let mut stmt = sqlite_conn
                .prepare(
                    "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
                )
                .map_err(|e| format!("Query error: {}", e))?;

            let tables: Vec<TableInfo> = stmt
                .query_map([], |row| {
                    Ok(TableInfo {
                        name: row.get(0)?,
                        schema: Some("main".to_string()),
                        table_type: row.get(1)?,
                        row_count: None,
                    })
                })
                .map_err(|e| format!("Query error: {}", e))?
                .filter_map(|r| r.ok())
                .collect();

            Ok(tables)
        }
        _ => Err("Schema browsing for this db type coming soon".to_string()),
    }
}

#[tauri::command]
pub async fn db_describe_table(
    conn_id: String,
    table: String,
    manager: State<'_, DatabaseManager>,
) -> Result<Vec<ColumnInfo>, String> {
    let connections = manager
        .connections
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?;
    let conn = connections
        .get(&conn_id)
        .ok_or(format!("Connection {} not found", conn_id))?;

    match conn {
        DbConnection::Sqlite(sqlite_conn) => {
            let mut stmt = sqlite_conn
                .prepare(&format!("PRAGMA table_info('{}')", table))
                .map_err(|e| format!("Pragma error: {}", e))?;

            let columns: Vec<ColumnInfo> = stmt
                .query_map([], |row| {
                    Ok(ColumnInfo {
                        name: row.get(1)?,
                        data_type: row.get::<_, String>(2).unwrap_or_default(),
                        nullable: row.get::<_, i32>(3).unwrap_or(1) == 0,
                        primary_key: row.get::<_, i32>(5).unwrap_or(0) == 1,
                        default_value: row.get(4).ok(),
                    })
                })
                .map_err(|e| format!("Query error: {}", e))?
                .filter_map(|r| r.ok())
                .collect();

            Ok(columns)
        }
        _ => Err("Describe table for this db type coming soon".to_string()),
    }
}
