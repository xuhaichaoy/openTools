//! 插件类型定义 — PluginManifest / PluginInfo / PluginCache 等

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

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
