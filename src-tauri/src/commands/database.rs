use mongodb::{
    bson::{doc, Bson, Document},
    options::ClientOptions,
    Client as MongoClient,
};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use sqlx::{
    mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow, MySqlSslMode},
    postgres::{PgPool, PgPoolOptions, PgRow},
    Column, Executor, Row, TypeInfo, ValueRef,
};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, Mutex};
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
    pub export_enabled: Option<bool>,
    pub export_alias: Option<String>,
    pub export_default_schema: Option<String>,
    pub max_export_rows: Option<u64>,
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
pub struct TableSearchResult {
    pub name: String,
    pub schema: Option<String>,
    pub table_type: Option<String>,
    pub matched_columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    pub default_value: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MongoConnection {
    pub client: MongoClient,
    pub database_name: String,
}

#[derive(Clone)]
pub(crate) enum DbConnection {
    Sqlite(Arc<Mutex<rusqlite::Connection>>),
    Postgres(PgPool),
    MySql(MySqlPool),
    Mongo(MongoConnection),
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

    pub(crate) fn get_connection(&self, conn_id: &str) -> Result<DbConnection, String> {
        self.connections
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?
            .get(conn_id)
            .cloned()
            .ok_or_else(|| format!("Connection {} not found", conn_id))
    }

    fn insert_connection(&self, conn_id: String, conn: DbConnection) -> Result<(), String> {
        self.connections
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?
            .insert(conn_id, conn);
        Ok(())
    }

    fn remove_connection(&self, conn_id: &str) -> Result<(), String> {
        self.connections
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?
            .remove(conn_id);
        Ok(())
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

pub(crate) fn load_saved_connections_for_app(
    app: &tauri::AppHandle,
) -> Result<Vec<DatabaseConfig>, String> {
    let path = config_path(app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let json = std::fs::read_to_string(&path).map_err(|e| format!("Read error: {}", e))?;
    serde_json::from_str(&json).map_err(|e| format!("Parse error: {}", e))
}

#[tauri::command]
pub async fn db_save_connections(
    connections: Vec<DatabaseConfig>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let path = config_path(&app)?;
    let json = serde_json::to_string_pretty(&connections)
        .map_err(|e| format!("Serialize error: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("Write error: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn db_load_connections(app: tauri::AppHandle) -> Result<Vec<DatabaseConfig>, String> {
    load_saved_connections_for_app(&app)
}

// ── Helpers ──

fn escape_connection_part(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

fn normalize_identifier(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Identifier cannot be empty".to_string());
    }
    let valid = trimmed.chars().enumerate().all(|(index, ch)| {
        ch == '_'
            || ch.is_ascii_alphabetic()
            || (index > 0 && ch.is_ascii_digit())
            || (index > 0 && ch == '$')
    });
    if !valid {
        return Err(format!("Unsupported identifier: {}", trimmed));
    }
    Ok(trimmed.to_string())
}

fn quote_identifier(dialect: &str, value: &str) -> Result<String, String> {
    let normalized = normalize_identifier(value)?;
    Ok(match dialect {
        "mysql" => format!("`{}`", normalized),
        _ => format!("\"{}\"", normalized),
    })
}

fn build_qualified_table_ref(
    dialect: &str,
    schema: Option<&str>,
    table: &str,
) -> Result<String, String> {
    let table_ref = quote_identifier(dialect, table)?;
    match schema {
        Some(schema_name) if !schema_name.trim().is_empty() && dialect != "sqlite" => Ok(format!(
            "{}.{}",
            quote_identifier(dialect, schema_name)?,
            table_ref
        )),
        _ => Ok(table_ref),
    }
}

fn parse_table_reference(table: &str) -> (Option<String>, String) {
    table
        .split_once('.')
        .map(|(schema_name, table_only)| (Some(schema_name.to_string()), table_only.to_string()))
        .unwrap_or((None, table.to_string()))
}

fn build_connection_string(config: &DatabaseConfig) -> Result<String, String> {
    if let Some(cs) = &config.connection_string {
        if !cs.trim().is_empty() {
            return Ok(cs.clone());
        }
    }

    let host = config.host.as_deref().unwrap_or("localhost");
    let user = escape_connection_part(config.username.as_deref().unwrap_or("root"));
    let pass = escape_connection_part(config.password.as_deref().unwrap_or(""));
    match config.db_type.as_str() {
        "postgres" => {
            let db = escape_connection_part(
                config
                    .database
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or("PostgreSQL requires a database name")?,
            );
            Ok(format!(
                "postgres://{}:{}@{}:{}/{}",
                user,
                pass,
                host,
                config.port.unwrap_or(5432),
                db
            ))
        }
        "mysql" => {
            let prefix = format!(
                "mysql://{}:{}@{}:{}",
                user,
                pass,
                host,
                config.port.unwrap_or(3306),
            );
            if let Some(db) = config
                .database
                .as_deref()
                .filter(|value| !value.trim().is_empty())
            {
                Ok(format!("{}/{}", prefix, escape_connection_part(db)))
            } else {
                Ok(prefix)
            }
        }
        "mongodb" => {
            let db = escape_connection_part(
                config
                    .database
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or("MongoDB requires a database name")?,
            );
            Ok(format!(
                "mongodb://{}:{}@{}:{}/{}",
                user,
                pass,
                host,
                config.port.unwrap_or(27017),
                db
            ))
        }
        other => Err(format!("Unsupported database type: {}", other)),
    }
}

fn build_mysql_connect_options(
    config: &DatabaseConfig,
    ssl_mode: MySqlSslMode,
) -> Result<MySqlConnectOptions, String> {
    let connection_string = build_connection_string(config)?;
    let options = MySqlConnectOptions::from_str(&connection_string)
        .map_err(|e| format!("MySQL options parse failed: {}", e))?;
    Ok(options.ssl_mode(ssl_mode))
}

fn should_retry_mysql_without_tls(error: &sqlx::Error) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("expected to read 4 bytes, got 0 bytes at eof")
        || message.contains("unexpected eof")
        || message.contains("connection reset by peer")
}

async fn connect_mysql_pool_with_fallback(
    config: &DatabaseConfig,
    max_connections: u32,
    error_prefix: &str,
) -> Result<MySqlPool, String> {
    let preferred_options = build_mysql_connect_options(config, MySqlSslMode::Preferred)?;
    match MySqlPoolOptions::new()
        .max_connections(max_connections)
        .connect_with(preferred_options)
        .await
    {
        Ok(pool) => Ok(pool),
        Err(primary_error) => {
            if !should_retry_mysql_without_tls(&primary_error) {
                return Err(format!("{}: {}", error_prefix, primary_error));
            }

            let disabled_options = build_mysql_connect_options(config, MySqlSslMode::Disabled)?;
            MySqlPoolOptions::new()
                .max_connections(max_connections)
                .connect_with(disabled_options)
                .await
                .map_err(|secondary_error| {
                    format!(
                        "{}: {} (retry with ssl-mode=DISABLED also failed: {})",
                        error_prefix, primary_error, secondary_error
                    )
                })
        }
    }
}

fn is_select_like(query: &str) -> bool {
    let trimmed = query.trim_start().to_ascii_lowercase();
    trimmed.starts_with("select")
        || trimmed.starts_with("with")
        || trimmed.starts_with("pragma")
        || trimmed.starts_with("explain")
        || trimmed.starts_with("show")
        || trimmed.starts_with("describe")
}

fn sqlite_value_to_json(value: &rusqlite::types::Value) -> serde_json::Value {
    match value {
        rusqlite::types::Value::Null => serde_json::Value::Null,
        rusqlite::types::Value::Integer(n) => serde_json::json!(n),
        rusqlite::types::Value::Real(f) => serde_json::json!(f),
        rusqlite::types::Value::Text(s) => serde_json::json!(s),
        rusqlite::types::Value::Blob(b) => serde_json::json!(format!("[blob: {} bytes]", b.len())),
    }
}

fn pg_value_to_json(row: &PgRow, index: usize) -> Result<serde_json::Value, String> {
    let raw = row
        .try_get_raw(index)
        .map_err(|e| format!("Read column error: {}", e))?;
    if raw.is_null() {
        return Ok(serde_json::Value::Null);
    }

    let type_name = row.columns()[index].type_info().name().to_ascii_lowercase();
    if type_name.contains("bool") {
        if let Ok(value) = row.try_get::<bool, _>(index) {
            return Ok(serde_json::json!(value));
        }
    }
    if ["int2", "int4", "int8", "serial", "bigserial"].contains(&type_name.as_str()) {
        if let Ok(value) = row.try_get::<i64, _>(index) {
            return Ok(serde_json::json!(value));
        }
        if let Ok(value) = row.try_get::<i32, _>(index) {
            return Ok(serde_json::json!(value));
        }
    }
    if ["float4", "float8", "numeric", "decimal"].contains(&type_name.as_str()) {
        if let Ok(value) = row.try_get::<f64, _>(index) {
            return Ok(serde_json::json!(value));
        }
    }
    if type_name.contains("json") {
        if let Ok(value) = row.try_get::<serde_json::Value, _>(index) {
            return Ok(value);
        }
    }
    if type_name == "uuid" {
        if let Ok(value) = row.try_get::<uuid::Uuid, _>(index) {
            return Ok(serde_json::json!(value.to_string()));
        }
    }
    if type_name == "date" {
        if let Ok(value) = row.try_get::<chrono::NaiveDate, _>(index) {
            return Ok(serde_json::json!(value.to_string()));
        }
    }
    if type_name.contains("timestamp") {
        if let Ok(value) = row.try_get::<chrono::NaiveDateTime, _>(index) {
            return Ok(serde_json::json!(value.to_string()));
        }
        if let Ok(value) = row.try_get::<chrono::DateTime<chrono::Utc>, _>(index) {
            return Ok(serde_json::json!(value.to_rfc3339()));
        }
    }
    if type_name == "time" || type_name == "timetz" {
        if let Ok(value) = row.try_get::<chrono::NaiveTime, _>(index) {
            return Ok(serde_json::json!(value.to_string()));
        }
    }
    if type_name == "bytea" {
        if let Ok(value) = row.try_get::<Vec<u8>, _>(index) {
            return Ok(serde_json::json!(format!("[blob: {} bytes]", value.len())));
        }
    }
    if let Ok(value) = row.try_get::<String, _>(index) {
        return Ok(serde_json::json!(value));
    }
    if let Ok(value) = row.try_get::<Vec<u8>, _>(index) {
        if let Ok(text) = String::from_utf8(value.clone()) {
            return Ok(serde_json::json!(text));
        }
        return Ok(serde_json::json!(format!("[blob: {} bytes]", value.len())));
    }

    Ok(serde_json::json!(format!("[unsupported:{}]", type_name)))
}

fn mysql_value_to_json(row: &MySqlRow, index: usize) -> Result<serde_json::Value, String> {
    let raw = row
        .try_get_raw(index)
        .map_err(|e| format!("Read column error: {}", e))?;
    if raw.is_null() {
        return Ok(serde_json::Value::Null);
    }

    let type_name = row.columns()[index].type_info().name().to_ascii_lowercase();
    if type_name.contains("tinyint(1)") || type_name == "boolean" || type_name == "bool" {
        if let Ok(value) = row.try_get::<bool, _>(index) {
            return Ok(serde_json::json!(value));
        }
    }
    if type_name.contains("int") {
        if let Ok(value) = row.try_get::<i64, _>(index) {
            return Ok(serde_json::json!(value));
        }
    }
    if type_name.contains("double")
        || type_name.contains("float")
        || type_name.contains("decimal")
        || type_name.contains("numeric")
    {
        if let Ok(value) = row.try_get::<f64, _>(index) {
            return Ok(serde_json::json!(value));
        }
    }
    if type_name.contains("json") {
        if let Ok(value) = row.try_get::<serde_json::Value, _>(index) {
            return Ok(value);
        }
    }
    if type_name.contains("date")
        && !type_name.contains("datetime")
        && !type_name.contains("timestamp")
    {
        if let Ok(value) = row.try_get::<chrono::NaiveDate, _>(index) {
            return Ok(serde_json::json!(value.to_string()));
        }
    }
    if type_name.contains("timestamp") || type_name.contains("datetime") {
        if let Ok(value) = row.try_get::<chrono::NaiveDateTime, _>(index) {
            return Ok(serde_json::json!(value.to_string()));
        }
    }
    if type_name == "time" {
        if let Ok(value) = row.try_get::<chrono::NaiveTime, _>(index) {
            return Ok(serde_json::json!(value.to_string()));
        }
    }
    if type_name.contains("blob") || type_name.contains("binary") {
        if let Ok(value) = row.try_get::<Vec<u8>, _>(index) {
            return Ok(serde_json::json!(format!("[blob: {} bytes]", value.len())));
        }
    }
    if let Ok(value) = row.try_get::<String, _>(index) {
        return Ok(serde_json::json!(value));
    }
    if let Ok(value) = row.try_get::<Vec<u8>, _>(index) {
        if let Ok(text) = String::from_utf8(value.clone()) {
            return Ok(serde_json::json!(text));
        }
        return Ok(serde_json::json!(format!("[blob: {} bytes]", value.len())));
    }

    Ok(serde_json::json!(format!("[unsupported:{}]", type_name)))
}

fn flatten_bson_document(
    prefix: Option<&str>,
    document: &Document,
    fields: &mut BTreeMap<String, String>,
) {
    for (key, value) in document {
        let path = match prefix {
            Some(prefix_value) if !prefix_value.is_empty() => format!("{}.{}", prefix_value, key),
            _ => key.to_string(),
        };
        match value {
            Bson::Document(inner) => {
                fields
                    .entry(path.clone())
                    .or_insert_with(|| "object".to_string());
                flatten_bson_document(Some(&path), inner, fields);
            }
            Bson::Array(items) => {
                fields
                    .entry(path)
                    .or_insert_with(|| format!("array<{}>", infer_array_type(items)));
            }
            other => {
                fields
                    .entry(path)
                    .or_insert_with(|| bson_type_name(other).to_string());
            }
        }
    }
}

fn infer_array_type(items: &[Bson]) -> &'static str {
    items.first().map(bson_type_name).unwrap_or("unknown")
}

fn bson_type_name(value: &Bson) -> &'static str {
    match value {
        Bson::Double(_) => "double",
        Bson::String(_) => "string",
        Bson::Array(_) => "array",
        Bson::Document(_) => "object",
        Bson::Boolean(_) => "bool",
        Bson::Int32(_) => "int32",
        Bson::Int64(_) => "int64",
        Bson::Decimal128(_) => "decimal128",
        Bson::DateTime(_) => "datetime",
        Bson::ObjectId(_) => "object_id",
        Bson::Binary(_) => "binary",
        Bson::Null => "null",
        _ => "unknown",
    }
}

pub(crate) fn mongo_bson_to_json(value: &Bson) -> serde_json::Value {
    match value {
        Bson::Double(v) => serde_json::json!(v),
        Bson::String(v) => serde_json::json!(v),
        Bson::Array(items) => {
            serde_json::Value::Array(items.iter().map(mongo_bson_to_json).collect())
        }
        Bson::Document(doc) => {
            let mut map = serde_json::Map::new();
            for (key, value) in doc {
                map.insert(key.to_string(), mongo_bson_to_json(value));
            }
            serde_json::Value::Object(map)
        }
        Bson::Boolean(v) => serde_json::json!(v),
        Bson::Null => serde_json::Value::Null,
        Bson::Int32(v) => serde_json::json!(v),
        Bson::Int64(v) => serde_json::json!(v),
        Bson::Decimal128(v) => serde_json::json!(v.to_string()),
        Bson::DateTime(v) => serde_json::json!(v.try_to_rfc3339_string().unwrap_or_default()),
        Bson::ObjectId(v) => serde_json::json!(v.to_hex()),
        Bson::Binary(v) => serde_json::json!(format!("[blob: {} bytes]", v.bytes.len())),
        other => serde_json::json!(other.to_string()),
    }
}

pub(crate) async fn execute_dynamic_query(
    conn: &DbConnection,
    query: &str,
) -> Result<QueryResult, String> {
    let start = std::time::Instant::now();

    match conn {
        DbConnection::Sqlite(sqlite_conn) => {
            let sqlite_conn = sqlite_conn
                .lock()
                .map_err(|e| format!("SQLite lock error: {}", e))?;
            if is_select_like(query) {
                let mut stmt = sqlite_conn
                    .prepare(query)
                    .map_err(|e| format!("Prepare error: {}", e))?;
                let column_count = stmt.column_count();
                let columns: Vec<String> = (0..column_count)
                    .map(|i| stmt.column_name(i).unwrap_or("?").to_string())
                    .collect();

                let rows_result: Result<Vec<Vec<serde_json::Value>>, _> = stmt
                    .query_map([], |row| {
                        let mut values = Vec::new();
                        for index in 0..column_count {
                            let value: rusqlite::types::Value = row.get(index)?;
                            values.push(sqlite_value_to_json(&value));
                        }
                        Ok(values)
                    })
                    .map_err(|e| format!("Query error: {}", e))?
                    .collect();

                Ok(QueryResult {
                    columns,
                    rows: rows_result.map_err(|e| format!("Row error: {}", e))?,
                    affected: 0,
                    elapsed_ms: start.elapsed().as_millis() as u64,
                })
            } else {
                let affected = sqlite_conn
                    .execute(query, [])
                    .map_err(|e| format!("Execute error: {}", e))?;
                Ok(QueryResult {
                    columns: vec![],
                    rows: vec![],
                    affected: affected as u64,
                    elapsed_ms: start.elapsed().as_millis() as u64,
                })
            }
        }
        DbConnection::Postgres(pool) => {
            if is_select_like(query) {
                let description = pool
                    .describe(query)
                    .await
                    .map_err(|e| format!("Describe error: {}", e))?;
                let columns = description
                    .columns()
                    .iter()
                    .map(|column| column.name().to_string())
                    .collect::<Vec<_>>();
                let rows = sqlx::query(query)
                    .fetch_all(pool)
                    .await
                    .map_err(|e| format!("Query error: {}", e))?;
                let mut values = Vec::with_capacity(rows.len());
                for row in &rows {
                    let mut row_values = Vec::with_capacity(columns.len());
                    for index in 0..columns.len() {
                        row_values.push(pg_value_to_json(row, index)?);
                    }
                    values.push(row_values);
                }
                Ok(QueryResult {
                    columns,
                    rows: values,
                    affected: 0,
                    elapsed_ms: start.elapsed().as_millis() as u64,
                })
            } else {
                let result = sqlx::query(query)
                    .execute(pool)
                    .await
                    .map_err(|e| format!("Execute error: {}", e))?;
                Ok(QueryResult {
                    columns: vec![],
                    rows: vec![],
                    affected: result.rows_affected(),
                    elapsed_ms: start.elapsed().as_millis() as u64,
                })
            }
        }
        DbConnection::MySql(pool) => {
            if is_select_like(query) {
                let description = pool
                    .describe(query)
                    .await
                    .map_err(|e| format!("Describe error: {}", e))?;
                let columns = description
                    .columns()
                    .iter()
                    .map(|column| column.name().to_string())
                    .collect::<Vec<_>>();
                let rows = sqlx::query(query)
                    .fetch_all(pool)
                    .await
                    .map_err(|e| format!("Query error: {}", e))?;
                let mut values = Vec::with_capacity(rows.len());
                for row in &rows {
                    let mut row_values = Vec::with_capacity(columns.len());
                    for index in 0..columns.len() {
                        row_values.push(mysql_value_to_json(row, index)?);
                    }
                    values.push(row_values);
                }
                Ok(QueryResult {
                    columns,
                    rows: values,
                    affected: 0,
                    elapsed_ms: start.elapsed().as_millis() as u64,
                })
            } else {
                let result = sqlx::query(query)
                    .execute(pool)
                    .await
                    .map_err(|e| format!("Execute error: {}", e))?;
                Ok(QueryResult {
                    columns: vec![],
                    rows: vec![],
                    affected: result.rows_affected(),
                    elapsed_ms: start.elapsed().as_millis() as u64,
                })
            }
        }
        DbConnection::Mongo(_) => Err(
            "MongoDB 通用查询编辑器暂未开放，请使用自然语言导出链路或后续专用查询界面。"
                .to_string(),
        ),
    }
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
            DbConnection::Sqlite(Arc::new(Mutex::new(conn)))
        }
        "postgres" => {
            let pool = PgPoolOptions::new()
                .max_connections(5)
                .connect(&build_connection_string(&config)?)
                .await
                .map_err(|e| format!("PostgreSQL connect failed: {}", e))?;
            DbConnection::Postgres(pool)
        }
        "mysql" => {
            let pool = connect_mysql_pool_with_fallback(&config, 5, "MySQL connect failed").await?;
            DbConnection::MySql(pool)
        }
        "mongodb" => {
            let conn_str = build_connection_string(&config)?;
            let options = ClientOptions::parse(&conn_str)
                .await
                .map_err(|e| format!("MongoDB options parse failed: {}", e))?;
            let database_name = config
                .database
                .clone()
                .or_else(|| options.default_database.clone())
                .unwrap_or_else(|| "test".to_string());
            let client = MongoClient::with_options(options)
                .map_err(|e| format!("MongoDB client build failed: {}", e))?;
            client
                .database(&database_name)
                .run_command(doc! { "ping": 1 })
                .await
                .map_err(|e| format!("MongoDB ping failed: {}", e))?;
            DbConnection::Mongo(MongoConnection {
                client,
                database_name,
            })
        }
        _ => return Err(format!("Unsupported database type: {}", config.db_type)),
    };

    manager.insert_connection(conn_id.clone(), connection)?;
    Ok(conn_id)
}

#[tauri::command]
pub async fn db_disconnect(
    conn_id: String,
    manager: State<'_, DatabaseManager>,
) -> Result<(), String> {
    manager.remove_connection(&conn_id)
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
            rusqlite::Connection::open(path).map_err(|e| format!("SQLite test failed: {}", e))?;
            Ok(true)
        }
        "postgres" => {
            let pool = PgPoolOptions::new()
                .max_connections(1)
                .connect(&build_connection_string(&config)?)
                .await
                .map_err(|e| format!("PostgreSQL test failed: {}", e))?;
            sqlx::query("SELECT 1")
                .execute(&pool)
                .await
                .map_err(|e| format!("PostgreSQL ping failed: {}", e))?;
            pool.close().await;
            Ok(true)
        }
        "mysql" => {
            let pool = connect_mysql_pool_with_fallback(&config, 1, "MySQL test failed").await?;
            sqlx::query("SELECT 1")
                .execute(&pool)
                .await
                .map_err(|e| format!("MySQL ping failed: {}", e))?;
            pool.close().await;
            Ok(true)
        }
        "mongodb" => {
            let conn_str = build_connection_string(&config)?;
            let options = ClientOptions::parse(&conn_str)
                .await
                .map_err(|e| format!("MongoDB options parse failed: {}", e))?;
            let database_name = config
                .database
                .clone()
                .or_else(|| options.default_database.clone())
                .unwrap_or_else(|| "test".to_string());
            let client = MongoClient::with_options(options)
                .map_err(|e| format!("MongoDB client build failed: {}", e))?;
            client
                .database(&database_name)
                .run_command(doc! { "ping": 1 })
                .await
                .map_err(|e| format!("MongoDB test failed: {}", e))?;
            Ok(true)
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
    if !is_select_like(&query) {
        return Err(
            "数据库客户端当前为只读模式，只允许 SELECT / SHOW / DESCRIBE / EXPLAIN 查询。"
                .to_string(),
        );
    }
    let conn = manager.get_connection(&conn_id)?;
    execute_dynamic_query(&conn, &query).await
}

// ── Schema ──

#[tauri::command]
pub async fn db_list_schemas(
    conn_id: String,
    manager: State<'_, DatabaseManager>,
) -> Result<Vec<String>, String> {
    let conn = manager.get_connection(&conn_id)?;
    match conn {
        DbConnection::Sqlite(_) => Ok(vec!["main".to_string()]),
        DbConnection::Postgres(pool) => {
            let rows = sqlx::query(
                "SELECT schema_name
                 FROM information_schema.schemata
                 WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
                 ORDER BY schema_name",
            )
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("PostgreSQL schemas query failed: {}", e))?;
            Ok(rows
                .iter()
                .filter_map(|row| row.try_get::<String, _>(0).ok())
                .collect())
        }
        DbConnection::MySql(pool) => {
            let rows = sqlx::query("SHOW DATABASES")
                .fetch_all(&pool)
                .await
                .map_err(|e| format!("MySQL schema query failed: {}", e))?;
            Ok(rows
                .iter()
                .filter_map(|row| row.try_get::<String, _>(0).ok())
                .filter(|name| {
                    !matches!(
                        name.as_str(),
                        "information_schema" | "mysql" | "performance_schema" | "sys"
                    )
                })
                .collect())
        }
        DbConnection::Mongo(conn) => Ok(vec![conn.database_name]),
    }
}

#[tauri::command]
pub async fn db_list_tables(
    conn_id: String,
    schema: Option<String>,
    manager: State<'_, DatabaseManager>,
) -> Result<Vec<TableInfo>, String> {
    let conn = manager.get_connection(&conn_id)?;
    match conn {
        DbConnection::Sqlite(sqlite_conn) => {
            let sqlite_conn = sqlite_conn
                .lock()
                .map_err(|e| format!("SQLite lock error: {}", e))?;
            let mut stmt = sqlite_conn
                .prepare(
                    "SELECT name, type
                     FROM sqlite_master
                     WHERE type IN ('table', 'view')
                     ORDER BY name",
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
                .filter_map(|row| row.ok())
                .collect();
            Ok(tables)
        }
        DbConnection::Postgres(pool) => {
            let rows = if let Some(schema_name) = schema {
                sqlx::query(
                    "SELECT table_name, table_schema, table_type
                     FROM information_schema.tables
                     WHERE table_schema = $1
                       AND table_type IN ('BASE TABLE', 'VIEW')
                     ORDER BY table_name",
                )
                .bind(schema_name)
                .fetch_all(&pool)
                .await
                .map_err(|e| format!("PostgreSQL tables query failed: {}", e))?
            } else {
                sqlx::query(
                    "SELECT table_name, table_schema, table_type
                     FROM information_schema.tables
                     WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
                       AND table_type IN ('BASE TABLE', 'VIEW')
                     ORDER BY table_schema, table_name",
                )
                .fetch_all(&pool)
                .await
                .map_err(|e| format!("PostgreSQL tables query failed: {}", e))?
            };
            Ok(rows
                .iter()
                .map(|row| TableInfo {
                    name: row.try_get::<String, _>("table_name").unwrap_or_default(),
                    schema: row.try_get::<String, _>("table_schema").ok(),
                    table_type: row.try_get::<String, _>("table_type").ok(),
                    row_count: None,
                })
                .collect())
        }
        DbConnection::MySql(pool) => {
            let rows = sqlx::query(
                "SELECT table_name, table_schema, table_type
                 FROM information_schema.tables
                 WHERE table_schema = COALESCE(?, DATABASE())
                 ORDER BY table_name",
            )
            .bind(schema)
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("MySQL tables query failed: {}", e))?;
            Ok(rows
                .iter()
                .map(|row| TableInfo {
                    name: row.try_get::<String, _>("table_name").unwrap_or_default(),
                    schema: row.try_get::<String, _>("table_schema").ok(),
                    table_type: row.try_get::<String, _>("table_type").ok(),
                    row_count: None,
                })
                .collect())
        }
        DbConnection::Mongo(conn) => {
            let collections = conn
                .client
                .database(&conn.database_name)
                .list_collection_names()
                .await
                .map_err(|e| format!("MongoDB list collections failed: {}", e))?;
            Ok(collections
                .into_iter()
                .map(|name| TableInfo {
                    name,
                    schema: Some(conn.database_name.clone()),
                    table_type: Some("collection".to_string()),
                    row_count: None,
                })
                .collect())
        }
    }
}

#[tauri::command]
pub async fn db_search_tables(
    conn_id: String,
    keyword: String,
    schema: Option<String>,
    limit: Option<u32>,
    manager: State<'_, DatabaseManager>,
) -> Result<Vec<TableSearchResult>, String> {
    let conn = manager.get_connection(&conn_id)?;
    let search = keyword.trim().to_ascii_lowercase();
    if search.is_empty() {
        return Ok(vec![]);
    }
    let result_limit = limit.unwrap_or(12).clamp(1, 50) as usize;

    match conn {
        DbConnection::Sqlite(sqlite_conn) => {
            let sqlite_conn = sqlite_conn
                .lock()
                .map_err(|e| format!("SQLite lock error: {}", e))?;
            let mut stmt = sqlite_conn
                .prepare(
                    "SELECT name, type
                     FROM sqlite_master
                     WHERE type IN ('table', 'view')
                     ORDER BY name",
                )
                .map_err(|e| format!("Query error: {}", e))?;

            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)
                            .unwrap_or_else(|_| "table".to_string()),
                    ))
                })
                .map_err(|e| format!("Query error: {}", e))?;

            let mut matches = Vec::new();
            for row in rows {
                let (table_name, table_type) = row.map_err(|e| format!("Row error: {}", e))?;
                let mut matched_columns = Vec::new();
                if !table_name.to_ascii_lowercase().contains(&search) {
                    let pragma = format!("PRAGMA table_info('{}')", table_name.replace('\'', "''"));
                    let mut column_stmt = sqlite_conn
                        .prepare(&pragma)
                        .map_err(|e| format!("Pragma error: {}", e))?;
                    let column_rows = column_stmt
                        .query_map([], |column_row| column_row.get::<_, String>(1))
                        .map_err(|e| format!("Query error: {}", e))?;
                    for column_row in column_rows {
                        let column_name = column_row.map_err(|e| format!("Row error: {}", e))?;
                        if column_name.to_ascii_lowercase().contains(&search) {
                            matched_columns.push(column_name);
                        }
                    }
                    if matched_columns.is_empty() {
                        continue;
                    }
                }

                matches.push(TableSearchResult {
                    name: table_name,
                    schema: Some("main".to_string()),
                    table_type: Some(table_type),
                    matched_columns,
                });
                if matches.len() >= result_limit {
                    break;
                }
            }
            Ok(matches)
        }
        DbConnection::Postgres(pool) => {
            let pattern = format!("%{}%", search);
            let rows = if let Some(schema_name) = schema.clone() {
                sqlx::query(
                    "SELECT
                        t.table_name,
                        t.table_schema,
                        t.table_type,
                        COALESCE(
                          STRING_AGG(DISTINCT c.column_name, ',' ORDER BY c.column_name)
                            FILTER (WHERE LOWER(c.column_name) LIKE $2),
                          ''
                        ) AS matched_columns
                     FROM information_schema.tables t
                     LEFT JOIN information_schema.columns c
                       ON c.table_schema = t.table_schema
                      AND c.table_name = t.table_name
                     WHERE t.table_schema = $1
                       AND t.table_type IN ('BASE TABLE', 'VIEW')
                       AND (
                         LOWER(t.table_name) LIKE $2
                         OR LOWER(COALESCE(c.column_name, '')) LIKE $2
                       )
                     GROUP BY t.table_name, t.table_schema, t.table_type
                     ORDER BY t.table_schema, t.table_name
                     LIMIT $3",
                )
                .bind(schema_name)
                .bind(&pattern)
                .bind(result_limit as i64)
                .fetch_all(&pool)
                .await
                .map_err(|e| format!("PostgreSQL search tables failed: {}", e))?
            } else {
                sqlx::query(
                    "SELECT
                        t.table_name,
                        t.table_schema,
                        t.table_type,
                        COALESCE(
                          STRING_AGG(DISTINCT c.column_name, ',' ORDER BY c.column_name)
                            FILTER (WHERE LOWER(c.column_name) LIKE $1),
                          ''
                        ) AS matched_columns
                     FROM information_schema.tables t
                     LEFT JOIN information_schema.columns c
                       ON c.table_schema = t.table_schema
                      AND c.table_name = t.table_name
                     WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema')
                       AND t.table_type IN ('BASE TABLE', 'VIEW')
                       AND (
                         LOWER(t.table_name) LIKE $1
                         OR LOWER(COALESCE(c.column_name, '')) LIKE $1
                       )
                     GROUP BY t.table_name, t.table_schema, t.table_type
                     ORDER BY t.table_schema, t.table_name
                     LIMIT $2",
                )
                .bind(&pattern)
                .bind(result_limit as i64)
                .fetch_all(&pool)
                .await
                .map_err(|e| format!("PostgreSQL search tables failed: {}", e))?
            };

            Ok(rows
                .into_iter()
                .map(|row| TableSearchResult {
                    name: row.try_get::<String, _>("table_name").unwrap_or_default(),
                    schema: row.try_get::<String, _>("table_schema").ok(),
                    table_type: row.try_get::<String, _>("table_type").ok(),
                    matched_columns: row
                        .try_get::<String, _>("matched_columns")
                        .unwrap_or_default()
                        .split(',')
                        .filter_map(|item| {
                            let trimmed = item.trim();
                            (!trimmed.is_empty()).then(|| trimmed.to_string())
                        })
                        .collect(),
                })
                .collect())
        }
        DbConnection::MySql(pool) => {
            let pattern = format!("%{}%", search);
            let rows = if let Some(schema_name) = schema.clone() {
                sqlx::query(
                    "SELECT
                        t.table_name,
                        t.table_schema,
                        t.table_type,
                        COALESCE(
                          GROUP_CONCAT(DISTINCT CASE
                            WHEN LOWER(c.column_name) LIKE ? THEN c.column_name
                            ELSE NULL
                          END ORDER BY c.column_name SEPARATOR ','),
                          ''
                        ) AS matched_columns
                     FROM information_schema.tables t
                     LEFT JOIN information_schema.columns c
                       ON c.table_schema = t.table_schema
                      AND c.table_name = t.table_name
                     WHERE t.table_schema = ?
                       AND (
                         LOWER(t.table_name) LIKE ?
                         OR LOWER(COALESCE(c.column_name, '')) LIKE ?
                       )
                     GROUP BY t.table_name, t.table_schema, t.table_type
                     ORDER BY t.table_schema, t.table_name
                     LIMIT ?",
                )
                .bind(&pattern)
                .bind(schema_name)
                .bind(&pattern)
                .bind(&pattern)
                .bind(result_limit as u64)
                .fetch_all(&pool)
                .await
                .map_err(|e| format!("MySQL search tables failed: {}", e))?
            } else {
                sqlx::query(
                    "SELECT
                        t.table_name,
                        t.table_schema,
                        t.table_type,
                        COALESCE(
                          GROUP_CONCAT(DISTINCT CASE
                            WHEN LOWER(c.column_name) LIKE ? THEN c.column_name
                            ELSE NULL
                          END ORDER BY c.column_name SEPARATOR ','),
                          ''
                        ) AS matched_columns
                     FROM information_schema.tables t
                     LEFT JOIN information_schema.columns c
                       ON c.table_schema = t.table_schema
                      AND c.table_name = t.table_name
                     WHERE t.table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
                       AND (
                         LOWER(t.table_name) LIKE ?
                         OR LOWER(COALESCE(c.column_name, '')) LIKE ?
                       )
                     GROUP BY t.table_name, t.table_schema, t.table_type
                     ORDER BY t.table_schema, t.table_name
                     LIMIT ?",
                )
                .bind(&pattern)
                .bind(&pattern)
                .bind(&pattern)
                .bind(result_limit as u64)
                .fetch_all(&pool)
                .await
                .map_err(|e| format!("MySQL search tables failed: {}", e))?
            };

            Ok(rows
                .into_iter()
                .map(|row| TableSearchResult {
                    name: row.try_get::<String, _>("table_name").unwrap_or_default(),
                    schema: row.try_get::<String, _>("table_schema").ok(),
                    table_type: row.try_get::<String, _>("table_type").ok(),
                    matched_columns: row
                        .try_get::<String, _>("matched_columns")
                        .unwrap_or_default()
                        .split(',')
                        .filter_map(|item| {
                            let trimmed = item.trim();
                            (!trimmed.is_empty()).then(|| trimmed.to_string())
                        })
                        .collect(),
                })
                .collect())
        }
        DbConnection::Mongo(conn) => {
            let collections = conn
                .client
                .database(&conn.database_name)
                .list_collection_names()
                .await
                .map_err(|e| format!("MongoDB list collections failed: {}", e))?;
            Ok(collections
                .into_iter()
                .filter(|name| name.to_ascii_lowercase().contains(&search))
                .take(result_limit)
                .map(|name| TableSearchResult {
                    name,
                    schema: Some(conn.database_name.clone()),
                    table_type: Some("collection".to_string()),
                    matched_columns: vec![],
                })
                .collect())
        }
    }
}

#[tauri::command]
pub async fn db_sample_table(
    conn_id: String,
    table: String,
    limit: Option<u32>,
    manager: State<'_, DatabaseManager>,
) -> Result<QueryResult, String> {
    let conn = manager.get_connection(&conn_id)?;
    let sample_limit = limit.unwrap_or(5).clamp(1, 20);
    let (schema, table_name) = parse_table_reference(&table);

    match &conn {
        DbConnection::Mongo(mongo_conn) => {
            let collection = mongo_conn
                .client
                .database(
                    schema
                        .as_deref()
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or(&mongo_conn.database_name),
                )
                .collection::<Document>(&table_name);
            let mut cursor = collection
                .find(doc! {})
                .limit(sample_limit as i64)
                .await
                .map_err(|e| format!("MongoDB sample query failed: {}", e))?;
            let mut documents = Vec::new();
            while cursor
                .advance()
                .await
                .map_err(|e| format!("MongoDB cursor error: {}", e))?
            {
                documents.push(
                    cursor
                        .deserialize_current()
                        .map_err(|e| format!("MongoDB document decode failed: {}", e))?,
                );
            }

            let mut columns_set = BTreeMap::new();
            for document in &documents {
                flatten_bson_document(None, document, &mut columns_set);
            }
            let columns = columns_set.keys().cloned().collect::<Vec<_>>();
            let rows = documents
                .iter()
                .map(|document| {
                    columns
                        .iter()
                        .map(|column| {
                            document
                                .get(column)
                                .map(mongo_bson_to_json)
                                .unwrap_or(serde_json::Value::Null)
                        })
                        .collect::<Vec<_>>()
                })
                .collect::<Vec<_>>();
            Ok(QueryResult {
                columns,
                rows,
                affected: 0,
                elapsed_ms: 0,
            })
        }
        DbConnection::Sqlite(_) => {
            let query = format!(
                "SELECT * FROM {} LIMIT {}",
                build_qualified_table_ref("sqlite", schema.as_deref(), &table_name)?,
                sample_limit
            );
            execute_dynamic_query(&conn, &query).await
        }
        DbConnection::Postgres(_) => {
            let query = format!(
                "SELECT * FROM {} LIMIT {}",
                build_qualified_table_ref("postgres", schema.as_deref(), &table_name)?,
                sample_limit
            );
            execute_dynamic_query(&conn, &query).await
        }
        DbConnection::MySql(_) => {
            let query = format!(
                "SELECT * FROM {} LIMIT {}",
                build_qualified_table_ref("mysql", schema.as_deref(), &table_name)?,
                sample_limit
            );
            execute_dynamic_query(&conn, &query).await
        }
    }
}

#[tauri::command]
pub async fn db_describe_table(
    conn_id: String,
    table: String,
    manager: State<'_, DatabaseManager>,
) -> Result<Vec<ColumnInfo>, String> {
    let conn = manager.get_connection(&conn_id)?;
    let (schema, table_name) = table
        .split_once('.')
        .map(|(schema_name, table_only)| (Some(schema_name.to_string()), table_only.to_string()))
        .unwrap_or((None, table));

    match conn {
        DbConnection::Sqlite(sqlite_conn) => {
            let sqlite_conn = sqlite_conn
                .lock()
                .map_err(|e| format!("SQLite lock error: {}", e))?;
            let mut stmt = sqlite_conn
                .prepare(&format!(
                    "PRAGMA table_info('{}')",
                    table_name.replace('\'', "''")
                ))
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
                .filter_map(|row| row.ok())
                .collect();
            Ok(columns)
        }
        DbConnection::Postgres(pool) => {
            let rows = sqlx::query(
                "WITH target_table AS (
                    SELECT table_schema, table_name
                    FROM information_schema.tables
                    WHERE table_name = $1
                      AND (
                        ($2::text IS NOT NULL AND table_schema = $2)
                        OR ($2::text IS NULL AND table_schema NOT IN ('pg_catalog', 'information_schema'))
                      )
                    ORDER BY CASE WHEN table_schema = 'public' THEN 0 ELSE 1 END, table_schema
                    LIMIT 1
                 )
                 SELECT
                    c.column_name,
                    c.data_type,
                    c.is_nullable,
                    c.column_default,
                    EXISTS (
                        SELECT 1
                        FROM information_schema.table_constraints tc
                        JOIN information_schema.key_column_usage kcu
                          ON tc.constraint_name = kcu.constraint_name
                         AND tc.table_schema = kcu.table_schema
                        WHERE tc.constraint_type = 'PRIMARY KEY'
                          AND tc.table_schema = c.table_schema
                          AND tc.table_name = c.table_name
                          AND kcu.column_name = c.column_name
                    ) AS is_primary_key
                 FROM information_schema.columns c
                 JOIN target_table t
                   ON t.table_schema = c.table_schema
                  AND t.table_name = c.table_name
                 ORDER BY c.ordinal_position",
            )
            .bind(&table_name)
            .bind(schema)
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("PostgreSQL describe table failed: {}", e))?;
            Ok(rows
                .iter()
                .map(|row| ColumnInfo {
                    name: row.try_get::<String, _>("column_name").unwrap_or_default(),
                    data_type: row.try_get::<String, _>("data_type").unwrap_or_default(),
                    nullable: row
                        .try_get::<String, _>("is_nullable")
                        .map(|value| value == "YES")
                        .unwrap_or(true),
                    primary_key: row.try_get::<bool, _>("is_primary_key").unwrap_or(false),
                    default_value: row
                        .try_get::<Option<String>, _>("column_default")
                        .ok()
                        .flatten(),
                })
                .collect())
        }
        DbConnection::MySql(pool) => {
            let rows = sqlx::query(
                "SELECT
                    c.column_name,
                    c.data_type,
                    c.is_nullable,
                    c.column_default,
                    c.column_key
                 FROM information_schema.columns c
                 WHERE c.table_name = ?
                   AND c.table_schema = COALESCE(?, DATABASE())
                 ORDER BY c.ordinal_position",
            )
            .bind(&table_name)
            .bind(schema)
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("MySQL describe table failed: {}", e))?;
            Ok(rows
                .iter()
                .map(|row| ColumnInfo {
                    name: row.try_get::<String, _>("column_name").unwrap_or_default(),
                    data_type: row.try_get::<String, _>("data_type").unwrap_or_default(),
                    nullable: row
                        .try_get::<String, _>("is_nullable")
                        .map(|value| value == "YES")
                        .unwrap_or(true),
                    primary_key: row
                        .try_get::<String, _>("column_key")
                        .map(|value| value == "PRI")
                        .unwrap_or(false),
                    default_value: row
                        .try_get::<Option<String>, _>("column_default")
                        .ok()
                        .flatten(),
                })
                .collect())
        }
        DbConnection::Mongo(conn) => {
            let collection = conn
                .client
                .database(&conn.database_name)
                .collection::<Document>(&table_name);
            let mut cursor = collection
                .find(doc! {})
                .limit(20)
                .await
                .map_err(|e| format!("MongoDB sample query failed: {}", e))?;
            let mut fields = BTreeMap::new();
            while cursor
                .advance()
                .await
                .map_err(|e| format!("MongoDB cursor error: {}", e))?
            {
                let document = cursor
                    .deserialize_current()
                    .map_err(|e| format!("MongoDB sample document decode failed: {}", e))?;
                flatten_bson_document(None, &document, &mut fields);
            }
            Ok(fields
                .into_iter()
                .map(|(name, data_type)| ColumnInfo {
                    primary_key: name == "_id",
                    name,
                    data_type,
                    nullable: true,
                    default_value: None,
                })
                .collect())
        }
    }
}
