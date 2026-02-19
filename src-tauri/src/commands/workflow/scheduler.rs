use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use super::types::*;
use super::workflow_list;

// ── 定时调度 ──

/// 活跃定时任务: workflow_id → JoinHandle（用于取消）
static SCHEDULED_TASKS: Lazy<Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

/// 启动所有定时工作流的调度（应用启动时调用）
#[tauri::command]
pub async fn workflow_scheduler_start(app: AppHandle) -> Result<String, String> {
    let workflows = workflow_list(app.clone()).await?;
    let mut count = 0;
    for wf in &workflows {
        let trigger = &wf.trigger;
        let enabled = trigger.enabled.unwrap_or(true);
        if !enabled {
            continue;
        }
        match trigger.trigger_type.as_str() {
            "cron" | "interval" | "once" => {
                schedule_workflow(app.clone(), wf.clone());
                count += 1;
            }
            _ => {}
        }
    }
    Ok(format!("已启动 {} 个定时任务", count))
}

/// 停止所有定时任务
#[tauri::command]
pub async fn workflow_scheduler_stop() -> Result<(), String> {
    if let Ok(mut tasks) = SCHEDULED_TASKS.lock() {
        for (_, handle) in tasks.drain() {
            handle.abort();
        }
    }
    Ok(())
}

/// 重新加载单个工作流的调度（创建/更新/删除后调用）
#[tauri::command]
pub async fn workflow_scheduler_reload(app: AppHandle, workflow_id: String) -> Result<(), String> {
    // 先取消旧任务
    if let Ok(mut tasks) = SCHEDULED_TASKS.lock() {
        if let Some(handle) = tasks.remove(&workflow_id) {
            handle.abort();
        }
    }

    // 如果工作流仍存在且是定时类型，重新调度
    let dir = get_workflows_dir(&app);
    let path = dir.join(format!("{}.json", workflow_id));
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(wf) = serde_json::from_str::<Workflow>(&content) {
                let enabled = wf.trigger.enabled.unwrap_or(true);
                if enabled {
                    match wf.trigger.trigger_type.as_str() {
                        "cron" | "interval" | "once" => {
                            schedule_workflow(app, wf);
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    Ok(())
}

/// 获取所有定时任务的状态
#[tauri::command]
pub async fn workflow_scheduler_status() -> Result<Vec<String>, String> {
    let ids: Vec<String> = SCHEDULED_TASKS
        .lock()
        .map_err(|e| e.to_string())?
        .keys()
        .cloned()
        .collect();
    Ok(ids)
}

fn schedule_workflow(app: AppHandle, wf: Workflow) {
    let wf_id = wf.id.clone();
    let trigger = wf.trigger.clone();

    let handle = tokio::spawn(async move {
        match trigger.trigger_type.as_str() {
            "interval" => {
                let secs = trigger.interval_seconds.unwrap_or(3600);
                let duration = std::time::Duration::from_secs(secs);
                loop {
                    tokio::time::sleep(duration).await;
                    let _ = trigger_workflow_execution(&app, &wf.id, &wf.name).await;
                }
            }
            "once" => {
                if let Some(once_at) = &trigger.once_at {
                    if let Ok(target) = chrono::DateTime::parse_from_rfc3339(once_at) {
                        let now = chrono::Utc::now();
                        let target_utc = target.with_timezone(&chrono::Utc);
                        if target_utc > now {
                            let wait = (target_utc - now).to_std().unwrap_or_default();
                            tokio::time::sleep(wait).await;
                            let _ = trigger_workflow_execution(&app, &wf.id, &wf.name).await;
                        }
                    }
                }
            }
            "cron" => {
                if let Some(cron_expr) = &trigger.cron {
                    use chrono::Timelike;
                    // 简易 cron 调度：每分钟检查一次是否匹配
                    // 支持 "分 时 日 月 周" 五字段格式
                    let expr = cron_expr.clone();
                    loop {
                        // 等到下一个整分钟
                        let now = chrono::Local::now();
                        let secs_to_next_min = 60 - now.second() as u64;
                        tokio::time::sleep(std::time::Duration::from_secs(secs_to_next_min)).await;

                        let now = chrono::Local::now();
                        if cron_matches(&expr, &now) {
                            let _ = trigger_workflow_execution(&app, &wf.id, &wf.name).await;
                        }
                    }
                }
            }
            _ => {}
        }
    });

    if let Ok(mut tasks) = SCHEDULED_TASKS.lock() {
        tasks.insert(wf_id, handle);
    }
}

/// 触发工作流执行并发送系统通知
async fn trigger_workflow_execution(
    app: &AppHandle,
    wf_id: &str,
    wf_name: &str,
) -> Result<(), String> {
    // 通过事件通知前端执行工作流
    let _ = app.emit(
        "workflow-scheduled-trigger",
        serde_json::json!({
            "workflowId": wf_id,
            "workflowName": wf_name,
            "time": chrono::Local::now().format("%H:%M:%S").to_string(),
        }),
    );

    // 发送系统通知
    let _ = app.emit(
        "send-notification",
        serde_json::json!({
            "title": "定时任务触发",
            "body": format!("工作流「{}」已开始执行", wf_name),
        }),
    );

    Ok(())
}

/// 简易 cron 匹配（支持 5 字段：分 时 日 月 周）
fn cron_matches(expr: &str, now: &chrono::DateTime<chrono::Local>) -> bool {
    use chrono::Datelike;
    use chrono::Timelike;
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return false;
    }

    let minute = now.minute();
    let hour = now.hour();
    let day = now.day();
    let month = now.month();
    let weekday = now.weekday().num_days_from_monday(); // 0=Mon, 6=Sun

    cron_field_matches(fields[0], minute)
        && cron_field_matches(fields[1], hour)
        && cron_field_matches(fields[2], day)
        && cron_field_matches(fields[3], month)
        && cron_field_matches_weekday(fields[4], weekday)
}

/// 匹配单个 cron 字段（支持 *, 数字, 逗号列表, 范围 x-y, 步进 */n）
fn cron_field_matches(field: &str, value: u32) -> bool {
    if field == "*" {
        return true;
    }
    for part in field.split(',') {
        let part = part.trim();
        // 步进: */n 或 x/n
        if part.contains('/') {
            let segs: Vec<&str> = part.split('/').collect();
            if segs.len() == 2 {
                let step: u32 = segs[1].parse().unwrap_or(1);
                if step == 0 {
                    continue;
                }
                let base: u32 = if segs[0] == "*" {
                    0
                } else {
                    segs[0].parse().unwrap_or(0)
                };
                if (value >= base) && ((value - base) % step == 0) {
                    return true;
                }
            }
            continue;
        }
        // 范围: x-y
        if part.contains('-') {
            let segs: Vec<&str> = part.split('-').collect();
            if segs.len() == 2 {
                let lo: u32 = segs[0].parse().unwrap_or(0);
                let hi: u32 = segs[1].parse().unwrap_or(0);
                if value >= lo && value <= hi {
                    return true;
                }
            }
            continue;
        }
        // 精确匹配
        if let Ok(v) = part.parse::<u32>() {
            if v == value {
                return true;
            }
        }
    }
    false
}

/// 周几字段匹配（支持 0-7 格式，0 和 7 都表示周日）
fn cron_field_matches_weekday(field: &str, weekday_mon0: u32) -> bool {
    if field == "*" {
        return true;
    }
    // 将 Monday=0 格式转为 Sunday=0 格式（cron 标准）
    let weekday_sun0 = if weekday_mon0 == 6 {
        0
    } else {
        weekday_mon0 + 1
    };
    for part in field.split(',') {
        let part = part.trim();
        if part.contains('-') {
            let segs: Vec<&str> = part.split('-').collect();
            if segs.len() == 2 {
                let lo: u32 = segs[0].parse().unwrap_or(0);
                let hi: u32 = segs[1].parse().unwrap_or(0);
                // 处理 0/7 统一为 Sunday
                let lo = if lo == 7 { 0 } else { lo };
                let hi = if hi == 7 { 0 } else { hi };
                if lo <= hi {
                    if weekday_sun0 >= lo && weekday_sun0 <= hi {
                        return true;
                    }
                } else {
                    // 跨周 (如 5-1 表示周五到周一)
                    if weekday_sun0 >= lo || weekday_sun0 <= hi {
                        return true;
                    }
                }
            }
            continue;
        }
        if let Ok(v) = part.parse::<u32>() {
            let v = if v == 7 { 0 } else { v };
            if v == weekday_sun0 {
                return true;
            }
        }
    }
    false
}
