use crate::commands::database::{
    execute_dynamic_query, load_saved_connections_for_app, mongo_bson_to_json, DatabaseManager,
    DbConnection,
};
use mongodb::bson::{doc, Bson, Document};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::Mutex;
use tauri::{AppHandle, State};

const DEFAULT_PREVIEW_LIMIT: u64 = 50;
const DEFAULT_EXPORT_LIMIT: u64 = 10_000;
const MAX_PREVIEW_CACHE_SIZE: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFilter {
    pub field: String,
    pub op: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSort {
    pub field: String,
    pub direction: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredExportIntent {
    pub source_id: String,
    pub entity_name: String,
    pub entity_type: Option<String>,
    pub schema: Option<String>,
    pub fields: Option<Vec<String>>,
    pub filters: Option<Vec<ExportFilter>>,
    pub sort: Option<Vec<ExportSort>>,
    pub limit: Option<u64>,
    pub output_format: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPreview {
    pub preview_token: String,
    pub source_kind: String,
    pub canonical_query: String,
    pub columns: Vec<String>,
    pub rows: Vec<HashMap<String, serde_json::Value>>,
    pub preview_row_count: usize,
    pub estimated_total: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub preview_token: String,
    pub file_path: String,
    pub row_count: usize,
    pub columns: Vec<String>,
}

#[derive(Clone)]
enum CompiledExportPlan {
    Sql {
        query: String,
    },
    Mongo {
        collection_name: String,
        filter: Document,
        projection: Option<Document>,
        sort: Option<Document>,
        limit: i64,
        columns: Vec<String>,
    },
}

#[derive(Clone)]
struct CachedPreviewPlan {
    preview_token: String,
    source_id: String,
    entity_name: String,
    compiled_plan: CompiledExportPlan,
}

pub struct DataExportManager {
    previews: Mutex<HashMap<String, CachedPreviewPlan>>,
}

impl DataExportManager {
    pub fn new() -> Self {
        Self {
            previews: Mutex::new(HashMap::new()),
        }
    }

    fn store_preview(&self, preview: CachedPreviewPlan) -> Result<(), String> {
        let mut previews = self
            .previews
            .lock()
            .map_err(|e| format!("Preview cache lock error: {}", e))?;
        if previews.len() >= MAX_PREVIEW_CACHE_SIZE {
            if let Some(first_key) = previews.keys().next().cloned() {
                previews.remove(&first_key);
            }
        }
        previews.insert(preview.preview_token.clone(), preview);
        Ok(())
    }

    fn get_preview(&self, preview_token: &str) -> Result<CachedPreviewPlan, String> {
        self.previews
            .lock()
            .map_err(|e| format!("Preview cache lock error: {}", e))?
            .get(preview_token)
            .cloned()
            .ok_or_else(|| format!("Preview token not found: {}", preview_token))
    }
}

fn normalize_identifier(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Identifier cannot be empty".to_string());
    }
    let valid = trimmed
        .chars()
        .enumerate()
        .all(|(index, ch)| {
            (ch == '_' || ch.is_ascii_alphabetic() || (index > 0 && ch.is_ascii_digit()))
                || (index > 0 && ch == '$')
        });
    if !valid {
        return Err(format!("Unsupported identifier: {}", trimmed));
    }
    Ok(trimmed.to_string())
}

fn normalize_field_path(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Field path cannot be empty".to_string());
    }
    let parts = trimmed
        .split('.')
        .map(normalize_identifier)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(parts.join("."))
}

fn quote_sql_identifier(dialect: &str, identifier: &str) -> Result<String, String> {
    let normalized = normalize_identifier(identifier)?;
    Ok(match dialect {
        "mysql" => format!("`{}`", normalized),
        _ => format!("\"{}\"", normalized),
    })
}

fn json_literal_to_sql(value: &serde_json::Value) -> Result<String, String> {
    match value {
        serde_json::Value::Null => Ok("NULL".to_string()),
        serde_json::Value::Bool(v) => Ok(if *v { "TRUE".to_string() } else { "FALSE".to_string() }),
        serde_json::Value::Number(v) => Ok(v.to_string()),
        serde_json::Value::String(v) => Ok(format!("'{}'", v.replace('\'', "''"))),
        serde_json::Value::Array(values) => Ok(format!(
            "({})",
            values
                .iter()
                .map(json_literal_to_sql)
                .collect::<Result<Vec<_>, _>>()?
                .join(", ")
        )),
        serde_json::Value::Object(_) => Err("Object literal is not supported in SQL filters".to_string()),
    }
}

fn escape_regex_literal(value: &str) -> String {
    value
        .chars()
        .flat_map(|ch| match ch {
            '.' | '*' | '+' | '?' | '^' | '$' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '\\' => {
                ['\\', ch].into_iter().collect::<Vec<_>>()
            }
            _ => vec![ch],
        })
        .collect()
}

fn resolve_export_limit(
    app: &AppHandle,
    source_id: &str,
    requested_limit: Option<u64>,
) -> Result<u64, String> {
    let configs = load_saved_connections_for_app(app)?;
    let config = configs
        .iter()
        .find(|item| item.id == source_id)
        .cloned();
    let configured = config
        .and_then(|item| item.max_export_rows)
        .unwrap_or(DEFAULT_EXPORT_LIMIT);
    let requested = requested_limit.unwrap_or(configured);
    Ok(requested.clamp(1, configured.max(1)))
}

fn resolve_default_schema(app: &AppHandle, source_id: &str) -> Result<Option<String>, String> {
    let configs = load_saved_connections_for_app(app)?;
    Ok(configs
        .iter()
        .find(|item| item.id == source_id)
        .and_then(|item| item.export_default_schema.clone())
        .filter(|value| !value.trim().is_empty()))
}

fn compile_sql_filter(
    dialect: &str,
    filter: &ExportFilter,
) -> Result<String, String> {
    let field = quote_sql_identifier(dialect, &filter.field)?;
    let op = filter.op.trim().to_ascii_lowercase();
    match op.as_str() {
        "eq" | "=" => {
            if filter.value.is_null() {
                Ok(format!("{} IS NULL", field))
            } else {
                Ok(format!("{} = {}", field, json_literal_to_sql(&filter.value)?))
            }
        }
        "neq" | "!=" | "<>" => {
            if filter.value.is_null() {
                Ok(format!("{} IS NOT NULL", field))
            } else {
                Ok(format!("{} <> {}", field, json_literal_to_sql(&filter.value)?))
            }
        }
        "gt" => Ok(format!("{} > {}", field, json_literal_to_sql(&filter.value)?)),
        "gte" => Ok(format!("{} >= {}", field, json_literal_to_sql(&filter.value)?)),
        "lt" => Ok(format!("{} < {}", field, json_literal_to_sql(&filter.value)?)),
        "lte" => Ok(format!("{} <= {}", field, json_literal_to_sql(&filter.value)?)),
        "like" => {
            let value = filter
                .value
                .as_str()
                .ok_or_else(|| "LIKE filter requires string value".to_string())?;
            let pattern = json_literal_to_sql(&serde_json::json!(value))?;
            if dialect == "postgres" {
                Ok(format!("{} ILIKE {}", field, pattern))
            } else {
                Ok(format!("{} LIKE {}", field, pattern))
            }
        }
        "contains" => {
            let value = filter
                .value
                .as_str()
                .ok_or_else(|| "CONTAINS filter requires string value".to_string())?;
            let pattern = json_literal_to_sql(&serde_json::json!(format!("%{}%", value)))?;
            if dialect == "postgres" {
                Ok(format!("{} ILIKE {}", field, pattern))
            } else {
                Ok(format!("{} LIKE {}", field, pattern))
            }
        }
        "in" => {
            let values = filter
                .value
                .as_array()
                .ok_or_else(|| "IN filter requires array value".to_string())?;
            if values.is_empty() {
                return Err("IN filter cannot be empty".to_string());
            }
            Ok(format!("{} IN {}", field, json_literal_to_sql(&filter.value)?))
        }
        other => Err(format!("Unsupported SQL filter op: {}", other)),
    }
}

fn compile_sql_query(
    dialect: &str,
    intent: &StructuredExportIntent,
    default_schema: Option<&str>,
    limit: u64,
    preview_mode: bool,
) -> Result<String, String> {
    let entity_name = quote_sql_identifier(dialect, &intent.entity_name)?;
    let schema = intent
        .schema
        .as_deref()
        .map(normalize_identifier)
        .transpose()?
        .or_else(|| default_schema.map(|value| value.to_string()));
    let table_ref = match schema.as_deref() {
        Some(schema_name) if dialect != "sqlite" => {
            format!("{}.{}", quote_sql_identifier(dialect, schema_name)?, entity_name)
        }
        _ => entity_name,
    };

    let select_clause = if let Some(fields) = &intent.fields {
        if fields.is_empty() {
            "*".to_string()
        } else {
            fields
                .iter()
                .map(|field| quote_sql_identifier(dialect, field))
                .collect::<Result<Vec<_>, _>>()?
                .join(", ")
        }
    } else {
        "*".to_string()
    };

    let mut query = format!("SELECT {} FROM {}", select_clause, table_ref);

    if let Some(filters) = &intent.filters {
        if !filters.is_empty() {
            let clauses = filters
                .iter()
                .map(|filter| compile_sql_filter(dialect, filter))
                .collect::<Result<Vec<_>, _>>()?;
            query.push_str(&format!(" WHERE {}", clauses.join(" AND ")));
        }
    }

    if let Some(sort_fields) = &intent.sort {
        if !sort_fields.is_empty() {
            let order_by = sort_fields
                .iter()
                .map(|item| {
                    let direction = item.direction.trim().to_ascii_uppercase();
                    let normalized_direction = if direction == "DESC" { "DESC" } else { "ASC" };
                    Ok(format!(
                        "{} {}",
                        quote_sql_identifier(dialect, &item.field)?,
                        normalized_direction
                    ))
                })
                .collect::<Result<Vec<_>, String>>()?;
            query.push_str(&format!(" ORDER BY {}", order_by.join(", ")));
        }
    }

    let capped_limit = if preview_mode {
        limit.min(DEFAULT_PREVIEW_LIMIT).max(1)
    } else {
        limit.max(1)
    };
    query.push_str(&format!(" LIMIT {}", capped_limit));
    Ok(query)
}

fn json_to_bson(value: &serde_json::Value) -> Result<Bson, String> {
    mongodb::bson::to_bson(value).map_err(|e| format!("Convert json to bson failed: {}", e))
}

fn compile_mongo_filter(filter: &ExportFilter) -> Result<Document, String> {
    let field = normalize_field_path(&filter.field)?;
    let op = filter.op.trim().to_ascii_lowercase();
    let bson_value = json_to_bson(&filter.value)?;
    let mut result = Document::new();
    match op.as_str() {
        "eq" | "=" => {
            result.insert(field, bson_value);
        }
        "gt" => {
            result.insert(field, doc! { "$gt": bson_value });
        }
        "gte" => {
            result.insert(field, doc! { "$gte": bson_value });
        }
        "lt" => {
            result.insert(field, doc! { "$lt": bson_value });
        }
        "lte" => {
            result.insert(field, doc! { "$lte": bson_value });
        }
        "in" => {
            let values = filter
                .value
                .as_array()
                .ok_or_else(|| "Mongo IN filter requires array value".to_string())?;
            result.insert(
                field,
                doc! {
                    "$in": values
                        .iter()
                        .map(json_to_bson)
                        .collect::<Result<Vec<_>, _>>()?
                },
            );
        }
        "like" | "contains" => {
            let raw = filter
                .value
                .as_str()
                .ok_or_else(|| "Mongo text filter requires string value".to_string())?;
            let pattern = escape_regex_literal(raw);
            result.insert(field, doc! { "$regex": pattern, "$options": "i" });
        }
        other => return Err(format!("Unsupported Mongo filter op: {}", other)),
    }
    Ok(result)
}

fn merge_filter_documents(filters: &[ExportFilter]) -> Result<Document, String> {
    let mut clauses = Vec::new();
    for filter in filters {
        clauses.push(Bson::Document(compile_mongo_filter(filter)?));
    }
    if clauses.is_empty() {
        Ok(doc! {})
    } else if clauses.len() == 1 {
        match clauses.into_iter().next() {
            Some(Bson::Document(doc)) => Ok(doc),
            _ => Ok(doc! {}),
        }
    } else {
        Ok(doc! { "$and": clauses })
    }
}

fn extract_document_path(document: &Document, path: &str) -> Option<Bson> {
    let mut current = Bson::Document(document.clone());
    for part in path.split('.') {
        current = match current {
            Bson::Document(doc) => doc.get(part).cloned()?,
            _ => return None,
        };
    }
    Some(current)
}

fn build_row_maps(columns: &[String], rows: &[Vec<serde_json::Value>]) -> Vec<HashMap<String, serde_json::Value>> {
    rows.iter()
        .map(|row| {
            columns
                .iter()
                .enumerate()
                .map(|(index, key)| {
                    (
                        key.clone(),
                        row.get(index).cloned().unwrap_or(serde_json::Value::Null),
                    )
                })
                .collect()
        })
        .collect()
}

fn write_csv_value(writer: &mut BufWriter<File>, value: &serde_json::Value) -> Result<(), String> {
    let raw = match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::Bool(v) => v.to_string(),
        serde_json::Value::Number(v) => v.to_string(),
        serde_json::Value::String(v) => v.clone(),
        other => serde_json::to_string(other).map_err(|e| format!("Serialize CSV cell failed: {}", e))?,
    };
    let escaped = raw.replace('"', "\"\"");
    write!(writer, "\"{}\"", escaped).map_err(|e| format!("Write CSV cell failed: {}", e))
}

fn write_csv_file(
    file_path: &std::path::Path,
    columns: &[String],
    rows: &[Vec<serde_json::Value>],
) -> Result<(), String> {
    let file = File::create(file_path).map_err(|e| format!("Create export file failed: {}", e))?;
    let mut writer = BufWriter::new(file);

    for (index, column) in columns.iter().enumerate() {
        if index > 0 {
            write!(writer, ",").map_err(|e| format!("Write CSV separator failed: {}", e))?;
        }
        write_csv_value(&mut writer, &serde_json::json!(column))?;
    }
    writeln!(writer).map_err(|e| format!("Write CSV newline failed: {}", e))?;

    for row in rows {
        for (index, value) in row.iter().enumerate() {
            if index > 0 {
                write!(writer, ",").map_err(|e| format!("Write CSV separator failed: {}", e))?;
            }
            write_csv_value(&mut writer, value)?;
        }
        writeln!(writer).map_err(|e| format!("Write CSV row failed: {}", e))?;
    }

    writer.flush().map_err(|e| format!("Flush CSV file failed: {}", e))
}

fn build_export_file_path(entity_name: &str) -> Result<std::path::PathBuf, String> {
    let sanitized = entity_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let dir = std::env::temp_dir().join("51toolbox-exports");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Create export directory failed: {}", e))?;
    Ok(dir.join(format!(
        "{}-{}.csv",
        sanitized,
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    )))
}

fn infer_sql_dialect(conn: &DbConnection) -> Option<&'static str> {
    match conn {
        DbConnection::Sqlite(_) => Some("sqlite"),
        DbConnection::Postgres(_) => Some("postgres"),
        DbConnection::MySql(_) => Some("mysql"),
        DbConnection::Mongo(_) => None,
    }
}

fn infer_source_kind(conn: &DbConnection) -> &'static str {
    match conn {
        DbConnection::Sqlite(_) => "sqlite",
        DbConnection::Postgres(_) => "postgres",
        DbConnection::MySql(_) => "mysql",
        DbConnection::Mongo(_) => "mongodb",
    }
}

fn filter_columns_from_intent(fields: &Option<Vec<String>>) -> Result<Option<Vec<String>>, String> {
    let Some(values) = fields else {
        return Ok(None);
    };
    if values.is_empty() {
        return Ok(None);
    }
    Ok(Some(
        values
            .iter()
            .map(|value| normalize_field_path(value))
            .collect::<Result<Vec<_>, _>>()?,
    ))
}

async fn execute_mongo_plan(
    conn: &crate::commands::database::MongoConnection,
    collection_name: &str,
    filter: Document,
    projection: Option<Document>,
    sort: Option<Document>,
    limit: i64,
    fixed_columns: Option<&[String]>,
) -> Result<(Vec<String>, Vec<Vec<serde_json::Value>>), String> {
    let collection = conn
        .client
        .database(&conn.database_name)
        .collection::<Document>(collection_name);
    let mut action = collection.find(filter);
    if let Some(projection_doc) = projection {
        action = action.projection(projection_doc);
    }
    if let Some(sort_doc) = sort {
        action = action.sort(sort_doc);
    }
    action = action.limit(limit);
    let mut cursor = action
        .await
        .map_err(|e| format!("MongoDB execute export plan failed: {}", e))?;

    let mut documents = Vec::new();
    while cursor
        .advance()
        .await
        .map_err(|e| format!("MongoDB cursor advance failed: {}", e))?
    {
        let current = cursor
            .deserialize_current()
            .map_err(|e| format!("MongoDB row decode failed: {}", e))?;
        documents.push(current);
    }

    let columns = if let Some(columns) = fixed_columns {
        columns.to_vec()
    } else {
        let mut set = BTreeSet::new();
        for document in &documents {
            for key in document.keys() {
                set.insert(key.to_string());
            }
        }
        set.into_iter().collect()
    };

    let rows = documents
        .iter()
        .map(|document| {
            columns
                .iter()
                .map(|column| {
                    extract_document_path(document, column)
                        .map(|value| mongo_bson_to_json(&value))
                        .unwrap_or(serde_json::Value::Null)
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();

    Ok((columns, rows))
}

#[tauri::command]
pub async fn data_export_preview(
    intent: StructuredExportIntent,
    app: AppHandle,
    db_manager: State<'_, DatabaseManager>,
    export_manager: State<'_, DataExportManager>,
) -> Result<ExportPreview, String> {
    let conn = db_manager.get_connection(&intent.source_id)?;
    let source_kind = infer_source_kind(&conn).to_string();
    let preview_token = uuid::Uuid::new_v4().to_string();
    let export_limit = resolve_export_limit(&app, &intent.source_id, intent.limit)?;
    let default_schema = resolve_default_schema(&app, &intent.source_id)?;

    let (canonical_query, compiled_plan, columns, rows) = match &conn {
        DbConnection::Mongo(mongo_conn) => {
            let projection_columns = filter_columns_from_intent(&intent.fields)?;
            let projection = projection_columns.as_ref().map(|fields| {
                let mut projection_doc = Document::new();
                for field in fields {
                    projection_doc.insert(field, 1);
                }
                projection_doc
            });
            let filter = merge_filter_documents(intent.filters.as_deref().unwrap_or(&[]))?;
            let sort = if let Some(items) = &intent.sort {
                if items.is_empty() {
                    None
                } else {
                    let mut sort_doc = Document::new();
                    for item in items {
                        sort_doc.insert(
                            normalize_field_path(&item.field)?,
                            if item.direction.trim().eq_ignore_ascii_case("desc") {
                                -1
                            } else {
                                1
                            },
                        );
                    }
                    Some(sort_doc)
                }
            } else {
                None
            };
            let preview_limit = export_limit.min(DEFAULT_PREVIEW_LIMIT) as i64;
            let (columns, rows) = execute_mongo_plan(
                mongo_conn,
                &intent.entity_name,
                filter.clone(),
                projection.clone(),
                sort.clone(),
                preview_limit,
                projection_columns.as_deref(),
            )
            .await?;
            let canonical_query = serde_json::to_string_pretty(&serde_json::json!({
                "collection": intent.entity_name,
                "filter": filter,
                "projection": projection,
                "sort": sort,
                "limit": preview_limit,
            }))
            .map_err(|e| format!("Serialize mongo preview query failed: {}", e))?;
            (
                canonical_query.clone(),
                CompiledExportPlan::Mongo {
                    collection_name: intent.entity_name.clone(),
                    filter,
                    projection,
                    sort,
                    limit: export_limit as i64,
                    columns: columns.clone(),
                },
                columns,
                rows,
            )
        }
        _ => {
            let dialect = infer_sql_dialect(&conn).ok_or_else(|| "Unsupported SQL export source".to_string())?;
            let query = compile_sql_query(
                dialect,
                &intent,
                default_schema.as_deref(),
                export_limit,
                true,
            )?;
            let result = execute_dynamic_query(&conn, &query).await?;
            (
                query.clone(),
                CompiledExportPlan::Sql { query },
                result.columns,
                result.rows,
            )
        }
    };

    export_manager.store_preview(CachedPreviewPlan {
        preview_token: preview_token.clone(),
        source_id: intent.source_id.clone(),
        entity_name: intent.entity_name.clone(),
        compiled_plan,
    })?;

    Ok(ExportPreview {
        preview_token,
        source_kind,
        canonical_query,
        preview_row_count: rows.len(),
        estimated_total: Some(rows.len() as u64),
        rows: build_row_maps(&columns, &rows),
        columns,
    })
}

#[tauri::command]
pub async fn data_export_confirm_csv_export(
    preview_token: String,
    app: AppHandle,
    db_manager: State<'_, DatabaseManager>,
    export_manager: State<'_, DataExportManager>,
) -> Result<ExportResult, String> {
    let cached = export_manager.get_preview(&preview_token)?;
    let conn = db_manager.get_connection(&cached.source_id)?;

    let (columns, rows) = match (&cached.compiled_plan, &conn) {
        (CompiledExportPlan::Sql { query }, _) => {
            let result = execute_dynamic_query(&conn, query).await?;
            (result.columns, result.rows)
        }
        (
            CompiledExportPlan::Mongo {
                collection_name,
                filter,
                projection,
                sort,
                limit,
                columns,
                ..
            },
            DbConnection::Mongo(mongo_conn),
        ) => execute_mongo_plan(
            mongo_conn,
            collection_name,
            filter.clone(),
            projection.clone(),
            sort.clone(),
            *limit,
            Some(columns.as_slice()),
        )
        .await?,
        _ => return Err("Preview token and connection type do not match".to_string()),
    };

    let file_path = build_export_file_path(&cached.entity_name)?;
    write_csv_file(&file_path, &columns, &rows)?;

    let _ = app;
    Ok(ExportResult {
        preview_token,
        file_path: file_path.to_string_lossy().to_string(),
        row_count: rows.len(),
        columns,
    })
}
