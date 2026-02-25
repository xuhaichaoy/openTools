//! 插件类型定义 — PluginManifest / PluginInfo / PluginCache 等

use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginMtoolsManifest {
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default, alias = "data_profile")]
    pub data_profile: Option<String>,
    #[serde(default, alias = "open_mode")]
    pub open_mode: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[allow(dead_code)]
pub struct PluginCommand {
    #[serde(rename = "type", default)]
    pub cmd_type: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(rename = "match", default)]
    pub match_pattern: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PluginFeature {
    pub code: String,
    #[serde(default)]
    pub explain: String,
    #[serde(default)]
    pub cmds: Vec<serde_json::Value>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub platform: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    #[serde(alias = "name")]
    pub plugin_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_version")]
    pub version: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub logo: Option<String>,
    #[serde(default)]
    pub main: Option<String>,
    #[serde(default)]
    pub preload: Option<String>,
    #[serde(default)]
    pub features: Vec<PluginFeature>,
    #[serde(default)]
    pub plugin_type: Option<String>,
    #[serde(default)]
    pub development: Option<serde_json::Value>,
    #[serde(default)]
    pub workflows: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub mtools: Option<PluginMtoolsManifest>,
}

fn default_version() -> String {
    "0.0.0".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub manifest: PluginManifest,
    pub dir_path: String,
    pub enabled: bool,
    pub is_builtin: bool,
    pub source: String,
    pub slug: Option<String>,
    pub is_official: bool,
    pub data_profile: String,
}

pub struct PluginCache {
    pub plugins: Vec<PluginInfo>,
    pub dev_dirs: HashSet<String>,
    pub disabled_ids: HashSet<String>,
}

impl PluginCache {
    pub fn new() -> Self {
        Self {
            plugins: Vec::new(),
            dev_dirs: HashSet::new(),
            disabled_ids: HashSet::new(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginDevTraceItem {
    pub plugin_id: String,
    pub method: String,
    pub call_id: u64,
    pub duration_ms: u128,
    pub success: bool,
    pub error: Option<String>,
    pub permission_decision: String,
    pub permission_reason: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginDevWatchStatus {
    pub running: bool,
    pub watched_dirs: Vec<String>,
    pub plugin_id: Option<String>,
    pub changed_count: u64,
    pub last_changed_at: Option<String>,
    pub last_error: Option<String>,
}

impl Default for PluginDevWatchStatus {
    fn default() -> Self {
        Self {
            running: false,
            watched_dirs: Vec::new(),
            plugin_id: None,
            changed_count: 0,
            last_changed_at: None,
            last_error: None,
        }
    }
}

pub struct PluginDevWatcherRuntime {
    pub stop_tx: Option<tokio::sync::oneshot::Sender<()>>,
    pub task: Option<tauri::async_runtime::JoinHandle<()>>,
}

pub struct PluginDevState {
    pub trace_buffer: VecDeque<PluginDevTraceItem>,
    pub trace_limit: usize,
    pub watcher: Option<PluginDevWatcherRuntime>,
    pub watch_status: PluginDevWatchStatus,
}

impl PluginDevState {
    pub fn new() -> Self {
        Self {
            trace_buffer: VecDeque::new(),
            trace_limit: 1000,
            watcher: None,
            watch_status: PluginDevWatchStatus::default(),
        }
    }
}
