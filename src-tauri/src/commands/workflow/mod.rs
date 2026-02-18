pub mod types;
pub mod engine;
pub mod scheduler;

pub use types::*;

use tauri::AppHandle;
use types::get_workflows_dir;

// ── CRUD ──

#[tauri::command]
pub async fn workflow_list(app: AppHandle) -> Result<Vec<Workflow>, String> {
    let dir = get_workflows_dir(&app);
    let mut workflows = Vec::new();

    if !dir.exists() {
        return Ok(workflows);
    }

    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|e| e == "json").unwrap_or(false) {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if let Ok(wf) = serde_json::from_str::<Workflow>(&content) {
                        workflows.push(wf);
                    }
                }
            }
        }
    }

    workflows.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(workflows)
}

#[tauri::command]
pub async fn workflow_create(app: AppHandle, workflow: Workflow) -> Result<Workflow, String> {
    let dir = get_workflows_dir(&app);
    let file_path = dir.join(format!("{}.json", workflow.id));
    let json = serde_json::to_string_pretty(&workflow).map_err(|e| e.to_string())?;
    std::fs::write(&file_path, json).map_err(|e| format!("保存工作流失败: {}", e))?;
    Ok(workflow)
}

#[tauri::command]
pub async fn workflow_update(app: AppHandle, workflow: Workflow) -> Result<Workflow, String> {
    let dir = get_workflows_dir(&app);
    let file_path = dir.join(format!("{}.json", workflow.id));
    let json = serde_json::to_string_pretty(&workflow).map_err(|e| e.to_string())?;
    std::fs::write(&file_path, json).map_err(|e| format!("更新工作流失败: {}", e))?;
    Ok(workflow)
}

#[tauri::command]
pub async fn workflow_delete(app: AppHandle, id: String) -> Result<(), String> {
    let dir = get_workflows_dir(&app);
    let file_path = dir.join(format!("{}.json", id));
    if file_path.exists() {
        std::fs::remove_file(&file_path).map_err(|e| format!("删除工作流失败: {}", e))?;
    }
    Ok(())
}
