use chrono::{Local, NaiveDateTime, TimeZone, Timelike, Utc};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use tauri_plugin_store::StoreExt;

const TASK_STORE_FILE: &str = "agent-tasks.json";
const TASK_STORE_KEY: &str = "tasks";

static SCHEDULED_TASKS: Lazy<Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>> =
    Lazy::new(|| Arc::new(Mutex::new(HashMap::new())));

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentTaskStatus {
    Pending,
    Running,
    Success,
    Error,
    Paused,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentTaskResultStatus {
    Success,
    Error,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentScheduleType {
    Once,
    Interval,
    Cron,
}

impl AgentScheduleType {
    fn from_str(value: &str) -> Option<Self> {
        match value {
            "once" => Some(Self::Once),
            "interval" => Some(Self::Interval),
            "cron" => Some(Self::Cron),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOrchestratorTask {
    pub id: String,
    pub session_id: Option<String>,
    pub query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_type: Option<AgentScheduleType>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_value: Option<String>,
    pub status: AgentTaskStatus,
    #[serde(default)]
    pub retry_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_finished_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_duration_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_result_status: Option<AgentTaskResultStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_skip_reason: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTaskStatusPatch {
    pub task_id: String,
    pub status: AgentTaskStatus,
    #[serde(default)]
    pub retry_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_finished_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_duration_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_result_status: Option<AgentTaskResultStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_skip_reason: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTaskSkippedEvent {
    pub task_id: String,
    pub reason: String,
    pub skipped_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TaskAction {
    Pause,
    Resume,
    Cancel,
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn generate_id() -> String {
    format!("agt-{}", uuid::Uuid::new_v4())
}

fn load_tasks(app: &AppHandle) -> Result<Vec<AgentOrchestratorTask>, String> {
    let store = app
        .store(TASK_STORE_FILE)
        .map_err(|e| format!("读取任务存储失败: {}", e))?;

    if let Some(val) = store.get(TASK_STORE_KEY) {
        serde_json::from_value(val).map_err(|e| format!("解析任务列表失败: {}", e))
    } else {
        Ok(Vec::new())
    }
}

fn save_tasks(app: &AppHandle, tasks: &[AgentOrchestratorTask]) -> Result<(), String> {
    let store = app
        .store(TASK_STORE_FILE)
        .map_err(|e| format!("读取任务存储失败: {}", e))?;
    store.set(
        TASK_STORE_KEY,
        serde_json::to_value(tasks).map_err(|e| format!("序列化任务失败: {}", e))?,
    );
    store.save().map_err(|e| format!("保存任务存储失败: {}", e))
}

fn emit_status(app: &AppHandle, task: &AgentOrchestratorTask) {
    let payload = AgentTaskStatusPatch {
        task_id: task.id.clone(),
        status: task.status.clone(),
        retry_count: task.retry_count,
        next_run_at: task.next_run_at,
        last_error: task.last_error.clone(),
        last_started_at: task.last_started_at,
        last_finished_at: task.last_finished_at,
        last_duration_ms: task.last_duration_ms,
        last_result_status: task.last_result_status.clone(),
        last_skip_reason: task.last_skip_reason.clone(),
        updated_at: task.updated_at,
    };
    let _ = app.emit("agent-task-status", &payload);
}

fn emit_skipped(app: &AppHandle, event: AgentTaskSkippedEvent) {
    let _ = app.emit("agent-task-skipped", &event);
}

fn emit_retry(app: &AppHandle, task: &AgentOrchestratorTask) {
    let _ = app.emit(
        "agent-task-retry",
        serde_json::json!({
            "task_id": task.id,
            "retry_count": task.retry_count,
            "next_run_at": task.next_run_at,
            "last_error": task.last_error,
            "updated_at": task.updated_at,
        }),
    );
}

fn apply_task_action(current: AgentTaskStatus, action: TaskAction) -> AgentTaskStatus {
    match action {
        TaskAction::Pause => match current {
            AgentTaskStatus::Cancelled | AgentTaskStatus::Success => current,
            _ => AgentTaskStatus::Paused,
        },
        TaskAction::Resume => match current {
            AgentTaskStatus::Paused => AgentTaskStatus::Pending,
            _ => current,
        },
        TaskAction::Cancel => AgentTaskStatus::Cancelled,
    }
}

fn parse_once_timestamp(value: &str) -> Result<i64, String> {
    if let Ok(ms) = value.trim().parse::<i64>() {
        return Ok(ms);
    }

    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(value) {
        return Ok(dt.timestamp_millis());
    }

    if let Ok(naive) = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S") {
        if let Some(local_dt) = Local.from_local_datetime(&naive).single() {
            return Ok(local_dt.timestamp_millis());
        }
    }

    Err("once 类型的 schedule_value 必须是毫秒时间戳、RFC3339 或 YYYY-MM-DDTHH:MM:SS".to_string())
}

fn parse_interval_ms(value: &str) -> Result<i64, String> {
    let parsed = value
        .trim()
        .parse::<i64>()
        .map_err(|_| "interval 类型的 schedule_value 必须是正整数毫秒".to_string())?;
    if parsed <= 0 {
        return Err("interval 类型的 schedule_value 必须大于 0".to_string());
    }
    Ok(parsed)
}

fn cron_field_matches(field: &str, value: u32) -> bool {
    if field == "*" {
        return true;
    }

    for part in field.split(',') {
        let part = part.trim();

        if part.contains('/') {
            let segs: Vec<&str> = part.split('/').collect();
            if segs.len() == 2 {
                let step = segs[1].parse::<u32>().unwrap_or(0);
                if step == 0 {
                    continue;
                }
                let base = if segs[0] == "*" {
                    0
                } else {
                    segs[0].parse::<u32>().unwrap_or(0)
                };
                if value >= base && (value - base) % step == 0 {
                    return true;
                }
            }
            continue;
        }

        if part.contains('-') {
            let segs: Vec<&str> = part.split('-').collect();
            if segs.len() == 2 {
                let lo = segs[0].parse::<u32>().unwrap_or(0);
                let hi = segs[1].parse::<u32>().unwrap_or(0);
                if value >= lo && value <= hi {
                    return true;
                }
            }
            continue;
        }

        if let Ok(v) = part.parse::<u32>() {
            if v == value {
                return true;
            }
        }
    }

    false
}

fn cron_weekday_matches(field: &str, weekday_mon0: u32) -> bool {
    if field == "*" {
        return true;
    }

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
                let mut lo = segs[0].parse::<u32>().unwrap_or(0);
                let mut hi = segs[1].parse::<u32>().unwrap_or(0);
                if lo == 7 {
                    lo = 0;
                }
                if hi == 7 {
                    hi = 0;
                }
                if lo <= hi {
                    if weekday_sun0 >= lo && weekday_sun0 <= hi {
                        return true;
                    }
                } else if weekday_sun0 >= lo || weekday_sun0 <= hi {
                    return true;
                }
            }
            continue;
        }

        if let Ok(mut v) = part.parse::<u32>() {
            if v == 7 {
                v = 0;
            }
            if v == weekday_sun0 {
                return true;
            }
        }
    }

    false
}

fn cron_matches(expr: &str, now: &chrono::DateTime<Local>) -> bool {
    use chrono::Datelike;

    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return false;
    }

    cron_field_matches(fields[0], now.minute())
        && cron_field_matches(fields[1], now.hour())
        && cron_field_matches(fields[2], now.day())
        && cron_field_matches(fields[3], now.month())
        && cron_weekday_matches(fields[4], now.weekday().num_days_from_monday())
}

fn validate_cron(expr: &str) -> Result<(), String> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return Err("cron 表达式必须是 5 段：分 时 日 月 周".to_string());
    }
    let probe = Local::now();
    let _ = cron_matches(expr, &probe);
    Ok(())
}

fn next_cron_run(expr: &str, from_ms: i64) -> Option<i64> {
    let mut cursor = Local.timestamp_millis_opt(from_ms).single()?;
    cursor = cursor + chrono::Duration::minutes(1);
    cursor = cursor.with_second(0)?.with_nanosecond(0)?;

    for _ in 0..525_600 {
        if cron_matches(expr, &cursor) {
            return Some(cursor.timestamp_millis());
        }
        cursor = cursor + chrono::Duration::minutes(1);
    }

    None
}

fn compute_next_run_at(
    schedule_type: &AgentScheduleType,
    schedule_value: &str,
    now: i64,
) -> Result<i64, String> {
    match schedule_type {
        AgentScheduleType::Once => parse_once_timestamp(schedule_value),
        AgentScheduleType::Interval => Ok(now + parse_interval_ms(schedule_value)?),
        AgentScheduleType::Cron => {
            validate_cron(schedule_value)?;
            next_cron_run(schedule_value, now)
                .ok_or_else(|| "无法计算下一次 cron 触发时间".to_string())
        }
    }
}

fn compute_next_run_after_trigger(
    schedule_type: &AgentScheduleType,
    schedule_value: &str,
    now: i64,
) -> Result<Option<i64>, String> {
    match schedule_type {
        AgentScheduleType::Once => Ok(None),
        AgentScheduleType::Interval => Ok(Some(now + parse_interval_ms(schedule_value)?)),
        AgentScheduleType::Cron => {
            validate_cron(schedule_value)?;
            Ok(next_cron_run(schedule_value, now))
        }
    }
}

fn compute_next_run_on_start(
    schedule_type: &AgentScheduleType,
    schedule_value: &str,
    now: i64,
) -> Result<Option<i64>, String> {
    match schedule_type {
        AgentScheduleType::Once => {
            let ts = parse_once_timestamp(schedule_value)?;
            if ts > now {
                Ok(Some(ts))
            } else {
                Ok(None)
            }
        }
        AgentScheduleType::Interval => Ok(Some(now + parse_interval_ms(schedule_value)?)),
        AgentScheduleType::Cron => {
            validate_cron(schedule_value)?;
            Ok(next_cron_run(schedule_value, now))
        }
    }
}

fn recover_tasks_for_scheduler_start(tasks: &mut [AgentOrchestratorTask], now: i64) -> bool {
    let mut changed = false;

    for task in tasks.iter_mut() {
        if matches!(
            task.status,
            AgentTaskStatus::Paused | AgentTaskStatus::Cancelled
        ) {
            continue;
        }

        if task.status == AgentTaskStatus::Running {
            task.status = AgentTaskStatus::Pending;
            task.last_error = Some("interrupted_by_restart".to_string());
            task.last_result_status = Some(AgentTaskResultStatus::Error);
            task.last_skip_reason = None;
            task.updated_at = now;
            changed = true;
        }

        let (Some(schedule_type), Some(schedule_value)) =
            (&task.schedule_type, &task.schedule_value)
        else {
            continue;
        };

        match compute_next_run_on_start(schedule_type, schedule_value, now) {
            Ok(next) => {
                if next.is_none() && *schedule_type == AgentScheduleType::Once {
                    if task.status != AgentTaskStatus::Success {
                        task.status = AgentTaskStatus::Success;
                        task.last_result_status = Some(AgentTaskResultStatus::Skipped);
                        task.last_skip_reason = Some("missed_while_offline".to_string());
                        task.last_error = Some("missed_while_offline".to_string());
                        task.updated_at = now;
                        changed = true;
                    }
                }
                if task.next_run_at != next {
                    task.next_run_at = next;
                    task.updated_at = now;
                    changed = true;
                }
            }
            Err(err) => {
                task.status = AgentTaskStatus::Error;
                task.last_error = Some(format!("schedule_invalid: {}", err));
                task.last_result_status = Some(AgentTaskResultStatus::Error);
                task.last_skip_reason = None;
                task.next_run_at = None;
                task.updated_at = now;
                changed = true;
            }
        }
    }

    changed
}

fn collect_schedulable_tasks(tasks: &[AgentOrchestratorTask]) -> Vec<AgentOrchestratorTask> {
    tasks
        .iter()
        .filter(|t| {
            let once_done = t.schedule_type == Some(AgentScheduleType::Once)
                && matches!(
                    t.status,
                    AgentTaskStatus::Success | AgentTaskStatus::Cancelled
                );
            t.schedule_type.is_some()
                && t.schedule_value
                    .as_ref()
                    .map(|v| !v.trim().is_empty())
                    .unwrap_or(false)
                && !matches!(
                    t.status,
                    AgentTaskStatus::Paused | AgentTaskStatus::Cancelled
                )
                && !once_done
        })
        .cloned()
        .collect()
}

async fn trigger_scheduled_task(app: &AppHandle, task_id: &str) -> Result<(), String> {
    let mut tasks = load_tasks(app)?;
    let Some(task) = tasks.iter_mut().find(|t| t.id == task_id) else {
        return Ok(());
    };

    if matches!(
        task.status,
        AgentTaskStatus::Paused | AgentTaskStatus::Cancelled
    ) {
        return Ok(());
    }

    let now = now_ms();
    if let Some(next) = task.next_run_at {
        if next > now {
            return Ok(());
        }
    }

    if task.status == AgentTaskStatus::Running {
        if let (Some(schedule_type), Some(schedule_value)) =
            (&task.schedule_type, &task.schedule_value)
        {
            task.next_run_at = compute_next_run_after_trigger(schedule_type, schedule_value, now)?;
        }
        task.last_result_status = Some(AgentTaskResultStatus::Skipped);
        task.last_skip_reason = Some("overlap_running".to_string());
        task.updated_at = now;
        let skipped_event = AgentTaskSkippedEvent {
            task_id: task.id.clone(),
            reason: "overlap_running".to_string(),
            skipped_at: now,
            next_run_at: task.next_run_at,
        };
        let snapshot = task.clone();
        save_tasks(app, &tasks)?;
        emit_status(app, &snapshot);
        emit_skipped(app, skipped_event);
        return Ok(());
    }

    task.status = AgentTaskStatus::Pending;
    task.updated_at = now;
    task.last_error = None;
    task.last_skip_reason = None;

    if let (Some(schedule_type), Some(schedule_value)) = (&task.schedule_type, &task.schedule_value)
    {
        task.next_run_at = compute_next_run_after_trigger(schedule_type, schedule_value, now)?;
    }

    let cloned = task.clone();
    save_tasks(app, &tasks)?;

    let _ = app.emit("agent-task-trigger", &cloned);
    emit_status(app, &cloned);
    Ok(())
}

fn register_schedule_task(app: AppHandle, task: AgentOrchestratorTask) {
    let task_id = task.id.clone();

    let handle = tokio::spawn(async move {
        match (task.schedule_type.clone(), task.schedule_value.clone()) {
            (Some(AgentScheduleType::Interval), Some(value)) => {
                let interval_ms = match parse_interval_ms(&value) {
                    Ok(ms) => ms,
                    Err(_) => return,
                };

                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(interval_ms as u64)).await;
                    if trigger_scheduled_task(&app, &task_id).await.is_err() {
                        continue;
                    }
                }
            }
            (Some(AgentScheduleType::Once), Some(value)) => {
                let target_ms = match parse_once_timestamp(&value) {
                    Ok(ms) => ms,
                    Err(_) => return,
                };
                let now = now_ms();
                if target_ms > now {
                    tokio::time::sleep(std::time::Duration::from_millis((target_ms - now) as u64))
                        .await;
                }
                let _ = trigger_scheduled_task(&app, &task_id).await;
            }
            (Some(AgentScheduleType::Cron), Some(value)) => {
                if validate_cron(&value).is_err() {
                    return;
                }
                loop {
                    let now = Local::now();
                    let secs_to_next_min = 60 - now.second() as u64;
                    tokio::time::sleep(std::time::Duration::from_secs(secs_to_next_min)).await;
                    let tick = Local::now();
                    if cron_matches(&value, &tick) {
                        let _ = trigger_scheduled_task(&app, &task_id).await;
                    }
                }
            }
            _ => {}
        }
    });

    if let Ok(mut guard) = SCHEDULED_TASKS.lock() {
        guard.insert(task.id, handle);
    }
}

fn stop_schedule_task(task_id: &str) {
    if let Ok(mut guard) = SCHEDULED_TASKS.lock() {
        if let Some(handle) = guard.remove(task_id) {
            handle.abort();
        }
    }
}

#[tauri::command]
pub async fn agent_task_list(app: AppHandle) -> Result<Vec<AgentOrchestratorTask>, String> {
    let mut tasks = load_tasks(&app)?;
    tasks.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(tasks)
}

#[tauri::command]
pub async fn agent_task_create(
    app: AppHandle,
    query: String,
    session_id: Option<String>,
    schedule_type: Option<String>,
    schedule_value: Option<String>,
) -> Result<AgentOrchestratorTask, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("query 不能为空".to_string());
    }

    let now = now_ms();
    let parsed_schedule_type = match schedule_type.as_deref() {
        Some(raw) => Some(
            AgentScheduleType::from_str(raw)
                .ok_or_else(|| "不支持的 schedule_type，仅支持 once/interval/cron".to_string())?,
        ),
        None => None,
    };

    let next_run_at = if let (Some(st), Some(sv)) = (&parsed_schedule_type, &schedule_value) {
        Some(compute_next_run_at(st, sv, now)?)
    } else {
        None
    };

    let task = AgentOrchestratorTask {
        id: generate_id(),
        session_id,
        query,
        schedule_type: parsed_schedule_type,
        schedule_value,
        status: AgentTaskStatus::Pending,
        retry_count: 0,
        next_run_at,
        last_error: None,
        last_started_at: None,
        last_finished_at: None,
        last_duration_ms: None,
        last_result_status: None,
        last_skip_reason: None,
        created_at: now,
        updated_at: now,
    };

    let mut tasks = load_tasks(&app)?;
    tasks.push(task.clone());
    save_tasks(&app, &tasks)?;

    emit_status(&app, &task);

    if task.schedule_type.is_some() {
        agent_scheduler_reload(app.clone(), task.id.clone()).await?;
    }

    Ok(task)
}

#[tauri::command]
pub async fn agent_task_pause(app: AppHandle, task_id: String) -> Result<(), String> {
    let mut tasks = load_tasks(&app)?;
    let Some(task) = tasks.iter_mut().find(|t| t.id == task_id) else {
        return Err("任务不存在".to_string());
    };

    task.status = apply_task_action(task.status.clone(), TaskAction::Pause);
    task.updated_at = now_ms();

    let snapshot = task.clone();
    save_tasks(&app, &tasks)?;
    stop_schedule_task(&task_id);
    emit_status(&app, &snapshot);
    Ok(())
}

#[tauri::command]
pub async fn agent_task_resume(app: AppHandle, task_id: String) -> Result<(), String> {
    let mut tasks = load_tasks(&app)?;
    let Some(task) = tasks.iter_mut().find(|t| t.id == task_id) else {
        return Err("任务不存在".to_string());
    };

    task.status = apply_task_action(task.status.clone(), TaskAction::Resume);
    task.updated_at = now_ms();
    task.last_error = None;

    if let (Some(schedule_type), Some(schedule_value)) = (&task.schedule_type, &task.schedule_value)
    {
        task.next_run_at =
            compute_next_run_on_start(schedule_type, schedule_value, task.updated_at)?;
        if task.next_run_at.is_none() && *schedule_type == AgentScheduleType::Once {
            task.status = AgentTaskStatus::Success;
            task.last_result_status = Some(AgentTaskResultStatus::Skipped);
            task.last_skip_reason = Some("missed_while_offline".to_string());
            task.last_error = Some("missed_while_offline".to_string());
        }
    }

    let snapshot = task.clone();
    save_tasks(&app, &tasks)?;
    emit_status(&app, &snapshot);

    if snapshot.schedule_type.is_some() {
        agent_scheduler_reload(app, task_id).await?;
    }

    Ok(())
}

#[tauri::command]
pub async fn agent_task_cancel(app: AppHandle, task_id: String) -> Result<(), String> {
    let mut tasks = load_tasks(&app)?;
    let Some(task) = tasks.iter_mut().find(|t| t.id == task_id) else {
        return Err("任务不存在".to_string());
    };

    task.status = apply_task_action(task.status.clone(), TaskAction::Cancel);
    task.updated_at = now_ms();
    task.next_run_at = None;
    task.last_result_status = Some(AgentTaskResultStatus::Skipped);
    task.last_skip_reason = Some("cancelled_by_user".to_string());

    let snapshot = task.clone();
    save_tasks(&app, &tasks)?;
    stop_schedule_task(&task_id);
    emit_status(&app, &snapshot);

    Ok(())
}

#[tauri::command]
pub async fn agent_task_set_status(
    app: AppHandle,
    task_id: String,
    status: String,
    retry_count: Option<u32>,
    next_run_at: Option<i64>,
    last_error: Option<String>,
    last_started_at: Option<i64>,
    last_finished_at: Option<i64>,
    last_duration_ms: Option<i64>,
    last_result_status: Option<String>,
    last_skip_reason: Option<String>,
) -> Result<(), String> {
    let status = match status.as_str() {
        "pending" => AgentTaskStatus::Pending,
        "running" => AgentTaskStatus::Running,
        "success" => AgentTaskStatus::Success,
        "error" => AgentTaskStatus::Error,
        "paused" => AgentTaskStatus::Paused,
        "cancelled" => AgentTaskStatus::Cancelled,
        _ => return Err("无效的任务状态".to_string()),
    };

    let mut tasks = load_tasks(&app)?;
    let Some(task) = tasks.iter_mut().find(|t| t.id == task_id) else {
        return Err("任务不存在".to_string());
    };

    let parsed_result = match last_result_status.as_deref() {
        Some("success") => Some(AgentTaskResultStatus::Success),
        Some("error") => Some(AgentTaskResultStatus::Error),
        Some("skipped") => Some(AgentTaskResultStatus::Skipped),
        Some(_) => return Err("无效的 last_result_status".to_string()),
        None => None,
    };

    let now = now_ms();
    task.status = status;
    if let Some(rc) = retry_count {
        task.retry_count = rc;
    }
    task.next_run_at = next_run_at;
    task.last_error = last_error;
    if let Some(v) = last_started_at {
        task.last_started_at = Some(v);
    } else if task.status == AgentTaskStatus::Running {
        task.last_started_at = Some(now);
    }
    if let Some(v) = last_finished_at {
        task.last_finished_at = Some(v);
    } else if matches!(
        task.status,
        AgentTaskStatus::Success | AgentTaskStatus::Error
    ) {
        task.last_finished_at = Some(now);
    }
    if let Some(v) = last_duration_ms {
        task.last_duration_ms = Some(v);
    } else if let (Some(started), Some(finished)) = (task.last_started_at, task.last_finished_at) {
        task.last_duration_ms = Some((finished - started).max(0));
    }
    if let Some(v) = parsed_result {
        let skipped = v == AgentTaskResultStatus::Skipped;
        task.last_result_status = Some(v);
        if skipped {
            task.last_skip_reason = last_skip_reason;
        } else {
            task.last_skip_reason = None;
        }
    } else {
        task.last_skip_reason = None;
    }
    task.updated_at = now;

    let snapshot = task.clone();
    save_tasks(&app, &tasks)?;
    emit_status(&app, &snapshot);

    if snapshot.retry_count > 0 && snapshot.status == AgentTaskStatus::Pending {
        emit_retry(&app, &snapshot);
    }

    Ok(())
}

#[tauri::command]
pub async fn agent_scheduler_start(app: AppHandle) -> Result<String, String> {
    if let Ok(mut guard) = SCHEDULED_TASKS.lock() {
        for (_, handle) in guard.drain() {
            handle.abort();
        }
    }

    let mut tasks = load_tasks(&app)?;
    let now = now_ms();
    let recovered = recover_tasks_for_scheduler_start(&mut tasks, now);
    if recovered {
        save_tasks(&app, &tasks)?;
        for task in &tasks {
            emit_status(&app, task);
        }
    }

    let schedulable = collect_schedulable_tasks(&tasks);
    let mut count = 0usize;

    for task in schedulable {
        stop_schedule_task(&task.id);
        register_schedule_task(app.clone(), task);
        count += 1;
    }

    Ok(format!("已启动 {} 个 Agent 定时任务", count))
}

#[tauri::command]
pub async fn agent_scheduler_reload(app: AppHandle, task_id: String) -> Result<(), String> {
    stop_schedule_task(&task_id);

    let tasks = load_tasks(&app)?;
    let Some(task) = tasks.into_iter().find(|t| t.id == task_id) else {
        return Ok(());
    };

    if collect_schedulable_tasks(&[task.clone()]).is_empty() {
        return Ok(());
    }

    register_schedule_task(app, task);
    Ok(())
}

#[tauri::command]
pub async fn agent_scheduler_status() -> Result<Vec<String>, String> {
    let guard = SCHEDULED_TASKS
        .lock()
        .map_err(|e| format!("获取调度状态失败: {}", e))?;
    Ok(guard.keys().cloned().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_task(id: &str, status: AgentTaskStatus) -> AgentOrchestratorTask {
        AgentOrchestratorTask {
            id: id.to_string(),
            session_id: None,
            query: "test".to_string(),
            schedule_type: Some(AgentScheduleType::Interval),
            schedule_value: Some("1000".to_string()),
            status,
            retry_count: 0,
            next_run_at: Some(123),
            last_error: None,
            last_started_at: None,
            last_finished_at: None,
            last_duration_ms: None,
            last_result_status: None,
            last_skip_reason: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn parse_once_supports_multiple_formats() {
        let rfc = parse_once_timestamp("2026-01-01T00:00:00Z").unwrap();
        assert!(rfc > 0);

        let local = parse_once_timestamp("2026-01-01T00:00:00").unwrap();
        assert!(local > 0);

        let ms = parse_once_timestamp("1735689600000").unwrap();
        assert_eq!(ms, 1_735_689_600_000);
    }

    #[test]
    fn interval_must_be_positive() {
        assert!(parse_interval_ms("1000").is_ok());
        assert!(parse_interval_ms("0").is_err());
        assert!(parse_interval_ms("-1").is_err());
    }

    #[test]
    fn cron_matching_works_for_simple_cases() {
        let dt = Local.with_ymd_and_hms(2026, 2, 22, 10, 30, 0).unwrap();
        assert!(cron_matches("30 10 * * *", &dt));
        assert!(!cron_matches("31 10 * * *", &dt));
    }

    #[test]
    fn status_action_state_machine() {
        assert_eq!(
            apply_task_action(AgentTaskStatus::Pending, TaskAction::Pause),
            AgentTaskStatus::Paused
        );
        assert_eq!(
            apply_task_action(AgentTaskStatus::Paused, TaskAction::Resume),
            AgentTaskStatus::Pending
        );
        assert_eq!(
            apply_task_action(AgentTaskStatus::Success, TaskAction::Pause),
            AgentTaskStatus::Success
        );
        assert_eq!(
            apply_task_action(AgentTaskStatus::Running, TaskAction::Cancel),
            AgentTaskStatus::Cancelled
        );
    }

    #[test]
    fn restart_recovery_collects_only_schedulable_tasks() {
        let tasks = vec![
            test_task("a", AgentTaskStatus::Pending),
            test_task("b", AgentTaskStatus::Paused),
            test_task("c", AgentTaskStatus::Cancelled),
            AgentOrchestratorTask {
                schedule_type: None,
                schedule_value: None,
                ..test_task("d", AgentTaskStatus::Pending)
            },
        ];

        let ids: Vec<String> = collect_schedulable_tasks(&tasks)
            .into_iter()
            .map(|t| t.id)
            .collect();

        assert_eq!(ids, vec!["a".to_string()]);
    }

    #[test]
    fn startup_recovery_resets_running_task_state() {
        let now = Local
            .with_ymd_and_hms(2026, 2, 23, 12, 0, 0)
            .unwrap()
            .timestamp_millis();
        let mut tasks = vec![AgentOrchestratorTask {
            status: AgentTaskStatus::Running,
            last_skip_reason: Some("overlap_running".to_string()),
            ..test_task("running", AgentTaskStatus::Running)
        }];

        let changed = recover_tasks_for_scheduler_start(&mut tasks, now);
        assert!(changed);
        assert_eq!(tasks[0].status, AgentTaskStatus::Pending);
        assert_eq!(
            tasks[0].last_error.as_deref(),
            Some("interrupted_by_restart")
        );
        assert_eq!(
            tasks[0].last_result_status,
            Some(AgentTaskResultStatus::Error)
        );
        assert_eq!(tasks[0].last_skip_reason, None);
    }

    #[test]
    fn startup_recovery_does_not_backfill_once_task() {
        let mut tasks = vec![AgentOrchestratorTask {
            schedule_type: Some(AgentScheduleType::Once),
            schedule_value: Some("2020-01-01T00:00:00".to_string()),
            ..test_task("once", AgentTaskStatus::Pending)
        }];
        let now = Local
            .with_ymd_and_hms(2026, 2, 23, 12, 0, 0)
            .unwrap()
            .timestamp_millis();

        let changed = recover_tasks_for_scheduler_start(&mut tasks, now);
        assert!(changed);
        assert_eq!(tasks[0].status, AgentTaskStatus::Success);
        assert_eq!(tasks[0].next_run_at, None);
        assert_eq!(
            tasks[0].last_result_status,
            Some(AgentTaskResultStatus::Skipped)
        );
    }
}
