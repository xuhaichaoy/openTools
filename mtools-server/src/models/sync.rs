use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct SyncRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub data_type: String, // marks, tags, bookmarks, snippets, workflows, settings
    pub data_id: String,
    pub content: Value,
    pub version: i32,
    pub deleted: bool,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct SyncPushRequest {
    pub data_type: String,
    pub items: Vec<SyncItem>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SyncItem {
    pub data_id: String,
    pub content: Value,
    pub version: i32,
    pub deleted: bool,
}

#[derive(Debug, Serialize)]
pub struct SyncPullResponse {
    pub items: Vec<SyncRow>,
    pub latest_version: i32,
}
