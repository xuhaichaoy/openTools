use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

// ── 类型定义 ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkflowTrigger {
    #[serde(rename = "type")]
    pub trigger_type: String, // manual | keyword | hotkey | clipboard | cron | interval | once
    #[serde(default)]
    pub keyword: Option<String>,
    #[serde(default)]
    pub hotkey: Option<String>,
    /// Cron 表达式（type=cron 时使用）
    #[serde(default)]
    pub cron: Option<String>,
    /// 间隔秒数（type=interval 时使用）
    #[serde(default, rename = "intervalSeconds")]
    pub interval_seconds: Option<u64>,
    /// 一次性触发时间 ISO 字符串（type=once 时使用）
    #[serde(default, rename = "onceAt")]
    pub once_at: Option<String>,
    /// 定时任务是否启用
    #[serde(default)]
    pub enabled: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkflowVariable {
    pub name: String,
    pub label: String,
    #[serde(rename = "type")]
    pub var_type: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub options: Option<Vec<SelectOption>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SelectOption {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkflowStep {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub step_type: String,
    pub config: serde_json::Value,
    #[serde(default)]
    pub output_var: Option<String>,
    #[serde(default)]
    pub condition: Option<String>,
    #[serde(default)]
    pub on_error: Option<String>,
}

// 可视化画布节点
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkflowGraphNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub label: String,
    #[serde(default)]
    pub config: serde_json::Value,
    #[serde(default)]
    pub output_var: Option<String>,
    #[serde(default)]
    pub on_error: Option<String>,
    pub position: GraphPosition,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GraphPosition {
    pub x: f64,
    pub y: f64,
}

// 可视化画布连线
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorkflowGraphEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    #[serde(default, rename = "sourceHandle")]
    pub source_handle: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub description: String,
    #[serde(default)]
    pub category: String,
    pub trigger: WorkflowTrigger,
    pub steps: Vec<WorkflowStep>,
    #[serde(default)]
    pub nodes: Option<Vec<WorkflowGraphNode>>,
    #[serde(default)]
    pub edges: Option<Vec<WorkflowGraphEdge>>,
    #[serde(default)]
    pub variables: Option<Vec<WorkflowVariable>>,
    pub builtin: bool,
    pub created_at: u64,
}

pub(super) fn get_workflows_dir(app: &AppHandle) -> PathBuf {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let dir = data_dir.join("workflows");
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    dir
}
