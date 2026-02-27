//! 原生应用桥接模块
//!
//! 提供与操作系统原生应用交互的能力（日历、提醒事项、备忘录、邮件、快捷指令等）。
//! macOS 通过 AppleScript 实现，Windows/Linux 后续可扩展。

use serde::{Deserialize, Serialize};
use std::process::Command;

// ── 公共类型 ──

#[derive(Debug, Serialize, Deserialize)]
pub struct NativeAppResult {
    pub success: bool,
    pub message: String,
    pub data: Option<serde_json::Value>,
}

impl NativeAppResult {
    fn ok(message: impl Into<String>) -> Self {
        Self {
            success: true,
            message: message.into(),
            data: None,
        }
    }
    fn ok_with_data(message: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            success: true,
            message: message.into(),
            data: Some(data),
        }
    }
    fn err(message: impl Into<String>) -> Self {
        Self {
            success: false,
            message: message.into(),
            data: None,
        }
    }
}

// ── AppleScript 执行器 ──

#[cfg(target_os = "macos")]
#[allow(dead_code)]
fn run_applescript(script: &str) -> Result<String, String> {
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("执行 AppleScript 失败: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("AppleScript 错误: {}", stderr))
    }
}

#[cfg(target_os = "macos")]
#[allow(dead_code)]
fn run_applescript_multiline(lines: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("osascript");
    for line in lines {
        cmd.arg("-e").arg(*line);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("执行 AppleScript 失败: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("AppleScript 错误: {}", stderr))
    }
}

// ── JXA (JavaScript for Automation) 执行器 ──

#[cfg(target_os = "macos")]
fn run_jxa(script: &str) -> Result<String, String> {
    let output = Command::new("osascript")
        .arg("-l")
        .arg("JavaScript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("执行 JXA 失败: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("JXA 错误: {}", stderr))
    }
}

// ── 非 macOS 平台的 fallback ──

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
fn run_applescript(_script: &str) -> Result<String, String> {
    Err("AppleScript 仅支持 macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
#[allow(dead_code)]
fn run_applescript_multiline(_lines: &[&str]) -> Result<String, String> {
    Err("AppleScript 仅支持 macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
fn run_jxa(_script: &str) -> Result<String, String> {
    Err("JXA 仅支持 macOS".to_string())
}

// ══════════════════════════════════════════════
//  日历 (Calendar.app)
// ══════════════════════════════════════════════

/// 列出所有日历
#[tauri::command]
pub async fn native_calendar_list() -> Result<NativeAppResult, String> {
    let script = r#"
        var app = Application("Calendar");
        var cals = app.calendars();
        var result = [];
        for (var i = 0; i < cals.length; i++) {
            result.push({name: cals[i].name(), id: cals[i].id()});
        }
        JSON.stringify(result);
    "#;
    match run_jxa(script) {
        Ok(output) => {
            let data: serde_json::Value =
                serde_json::from_str(&output).unwrap_or(serde_json::Value::String(output));
            Ok(NativeAppResult::ok_with_data("获取日历列表成功", data))
        }
        Err(e) => Ok(NativeAppResult::err(e)),
    }
}

/// 创建日历事件
#[tauri::command]
pub async fn native_calendar_create_event(
    calendar: Option<String>,
    title: String,
    start_date: String,
    end_date: Option<String>,
    location: Option<String>,
    notes: Option<String>,
    all_day: Option<bool>,
) -> Result<NativeAppResult, String> {
    let cal_name = calendar.unwrap_or_else(|| "日历".to_string());
    let end = end_date.unwrap_or_else(|| {
        // 默认1小时后结束
        start_date.clone()
    });
    let loc = location.unwrap_or_default();
    let note = notes.unwrap_or_default();
    let is_all_day = all_day.unwrap_or(false);

    let script = format!(
        r#"
        var app = Application("Calendar");
        var cals = app.calendars.whose({{name: "{}"}});
        var cal;
        if (cals.length > 0) {{
            cal = cals[0];
        }} else {{
            cal = app.calendars[0];
        }}
        var evt = app.Event({{
            summary: "{}",
            startDate: new Date("{}"),
            endDate: new Date("{}"),
            location: "{}",
            description: "{}",
            alldayEvent: {}
        }});
        cal.events.push(evt);
        JSON.stringify({{id: evt.uid(), summary: evt.summary()}});
        "#,
        escape_js(&cal_name),
        escape_js(&title),
        escape_js(&start_date),
        escape_js(&end),
        escape_js(&loc),
        escape_js(&note),
        is_all_day
    );

    match run_jxa(&script) {
        Ok(output) => {
            let data: serde_json::Value =
                serde_json::from_str(&output).unwrap_or(serde_json::Value::String(output));
            Ok(NativeAppResult::ok_with_data(
                format!("已在日历「{}」中创建事件「{}」", cal_name, title),
                data,
            ))
        }
        Err(e) => Ok(NativeAppResult::err(e)),
    }
}

/// 查询今日/近期日历事件
#[tauri::command]
pub async fn native_calendar_list_events(days: Option<i32>) -> Result<NativeAppResult, String> {
    let range_days = days.unwrap_or(1);
    let script = format!(
        r#"
        var app = Application("Calendar");
        var now = new Date();
        var end = new Date();
        end.setDate(end.getDate() + {});
        now.setHours(0, 0, 0, 0);
        end.setHours(23, 59, 59, 999);
        var result = [];
        var cals = app.calendars();
        for (var c = 0; c < cals.length; c++) {{
            var evts = cals[c].events.whose({{
                startDate: {{_greaterThan: now}},
                endDate: {{_lessThan: end}}
            }});
            for (var i = 0; i < evts.length; i++) {{
                try {{
                    result.push({{
                        calendar: cals[c].name(),
                        title: evts[i].summary(),
                        start: evts[i].startDate().toISOString(),
                        end: evts[i].endDate().toISOString(),
                        location: evts[i].location() || "",
                        notes: evts[i].description() || ""
                    }});
                }} catch(e) {{}}
            }}
        }}
        result.sort(function(a,b){{ return new Date(a.start) - new Date(b.start); }});
        JSON.stringify(result);
        "#,
        range_days
    );

    match run_jxa(&script) {
        Ok(output) => {
            let data: serde_json::Value =
                serde_json::from_str(&output).unwrap_or(serde_json::Value::String(output));
            let count = data.as_array().map(|a| a.len()).unwrap_or(0);
            Ok(NativeAppResult::ok_with_data(
                format!("找到 {} 个日程事件（未来 {} 天）", count, range_days),
                data,
            ))
        }
        Err(e) => Ok(NativeAppResult::err(e)),
    }
}

// ══════════════════════════════════════════════
//  提醒事项 (Reminders.app)
// ══════════════════════════════════════════════

/// 列出提醒事项列表
#[tauri::command]
pub async fn native_reminder_lists() -> Result<NativeAppResult, String> {
    let script = r#"
        var app = Application("Reminders");
        var lists = app.lists();
        var result = [];
        for (var i = 0; i < lists.length; i++) {
            result.push({name: lists[i].name(), id: lists[i].id()});
        }
        JSON.stringify(result);
    "#;
    match run_jxa(script) {
        Ok(output) => {
            let data: serde_json::Value =
                serde_json::from_str(&output).unwrap_or(serde_json::Value::String(output));
            Ok(NativeAppResult::ok_with_data("获取提醒列表成功", data))
        }
        Err(e) => Ok(NativeAppResult::err(e)),
    }
}

/// 创建提醒事项
#[tauri::command]
pub async fn native_reminder_create(
    list_name: Option<String>,
    title: String,
    notes: Option<String>,
    due_date: Option<String>,
    priority: Option<i32>,
) -> Result<NativeAppResult, String> {
    let list = list_name.unwrap_or_else(|| "提醒事项".to_string());
    let note = notes.unwrap_or_default();
    let prio = priority.unwrap_or(0); // 0=none, 1=high, 5=medium, 9=low

    let due_part = if let Some(ref d) = due_date {
        format!(r#"rem.dueDate = new Date("{}");"#, escape_js(d))
    } else {
        String::new()
    };

    let script = format!(
        r#"
        var app = Application("Reminders");
        var lists = app.lists.whose({{name: "{}"}});
        var targetList;
        if (lists.length > 0) {{
            targetList = lists[0];
        }} else {{
            targetList = app.defaultList();
        }}
        var rem = app.Reminder({{
            name: "{}",
            body: "{}",
            priority: {}
        }});
        targetList.reminders.push(rem);
        {}
        JSON.stringify({{name: rem.name(), id: rem.id()}});
        "#,
        escape_js(&list),
        escape_js(&title),
        escape_js(&note),
        prio,
        due_part,
    );

    match run_jxa(&script) {
        Ok(output) => {
            let data: serde_json::Value =
                serde_json::from_str(&output).unwrap_or(serde_json::Value::String(output));
            Ok(NativeAppResult::ok_with_data(
                format!("已创建提醒「{}」", title),
                data,
            ))
        }
        Err(e) => Ok(NativeAppResult::err(e)),
    }
}

/// 查询未完成的提醒事项
#[tauri::command]
pub async fn native_reminder_list_incomplete(
    list_name: Option<String>,
) -> Result<NativeAppResult, String> {
    let list_filter = if let Some(ref name) = list_name {
        format!(
            r#"var lists = app.lists.whose({{name: "{}"}});
            var targetLists = lists.length > 0 ? [lists[0]] : app.lists();"#,
            escape_js(name)
        )
    } else {
        "var targetLists = app.lists();".to_string()
    };

    let script = format!(
        r#"
        var app = Application("Reminders");
        {}
        var result = [];
        for (var c = 0; c < targetLists.length; c++) {{
            var rems = targetLists[c].reminders.whose({{completed: false}});
            for (var i = 0; i < rems.length; i++) {{
                try {{
                    var r = {{
                        list: targetLists[c].name(),
                        title: rems[i].name(),
                        notes: rems[i].body() || "",
                        priority: rems[i].priority()
                    }};
                    try {{ r.dueDate = rems[i].dueDate().toISOString(); }} catch(e) {{}}
                    result.push(r);
                }} catch(e) {{}}
            }}
        }}
        JSON.stringify(result);
        "#,
        list_filter,
    );

    match run_jxa(&script) {
        Ok(output) => {
            let data: serde_json::Value =
                serde_json::from_str(&output).unwrap_or(serde_json::Value::String(output));
            let count = data.as_array().map(|a| a.len()).unwrap_or(0);
            Ok(NativeAppResult::ok_with_data(
                format!("找到 {} 个未完成提醒", count),
                data,
            ))
        }
        Err(e) => Ok(NativeAppResult::err(e)),
    }
}

// ══════════════════════════════════════════════
//  备忘录 (Notes.app)
// ══════════════════════════════════════════════

/// 创建备忘录
#[tauri::command]
pub async fn native_notes_create(
    folder: Option<String>,
    title: String,
    body: String,
) -> Result<NativeAppResult, String> {
    let folder_name = folder.unwrap_or_else(|| "备忘录".to_string());

    let script = format!(
        r#"
        var app = Application("Notes");
        var folders = app.folders.whose({{name: "{}"}});
        var target;
        if (folders.length > 0) {{
            target = folders[0];
        }} else {{
            target = app.defaultAccount().folders[0];
        }}
        var note = app.Note({{
            name: "{}",
            body: "{}"
        }});
        target.notes.push(note);
        JSON.stringify({{name: note.name(), id: note.id()}});
        "#,
        escape_js(&folder_name),
        escape_js(&title),
        escape_js(&body),
    );

    match run_jxa(&script) {
        Ok(output) => {
            let data: serde_json::Value =
                serde_json::from_str(&output).unwrap_or(serde_json::Value::String(output));
            Ok(NativeAppResult::ok_with_data(
                format!("已创建备忘录「{}」", title),
                data,
            ))
        }
        Err(e) => Ok(NativeAppResult::err(e)),
    }
}

/// 搜索备忘录
#[tauri::command]
pub async fn native_notes_search(
    query: String,
    limit: Option<usize>,
) -> Result<NativeAppResult, String> {
    let max = limit.unwrap_or(10);
    let script = format!(
        r#"
        var app = Application("Notes");
        var notes = app.notes();
        var query = "{}".toLowerCase();
        var result = [];
        for (var i = 0; i < notes.length && result.length < {}; i++) {{
            try {{
                var name = notes[i].name();
                var body = notes[i].plaintext();
                if (name.toLowerCase().indexOf(query) >= 0 || body.toLowerCase().indexOf(query) >= 0) {{
                    result.push({{
                        title: name,
                        snippet: body.substring(0, 200),
                        modified: notes[i].modificationDate().toISOString()
                    }});
                }}
            }} catch(e) {{}}
        }}
        JSON.stringify(result);
        "#,
        escape_js(&query),
        max,
    );

    match run_jxa(&script) {
        Ok(output) => {
            let data: serde_json::Value =
                serde_json::from_str(&output).unwrap_or(serde_json::Value::String(output));
            let count = data.as_array().map(|a| a.len()).unwrap_or(0);
            Ok(NativeAppResult::ok_with_data(
                format!("找到 {} 条相关备忘录", count),
                data,
            ))
        }
        Err(e) => Ok(NativeAppResult::err(e)),
    }
}

// ══════════════════════════════════════════════
//  邮件 (Mail.app)
// ══════════════════════════════════════════════

/// 创建邮件草稿（打开邮件编辑窗口）
#[tauri::command]
pub async fn native_mail_create(
    to: Vec<String>,
    subject: String,
    body: String,
    cc: Option<Vec<String>>,
) -> Result<NativeAppResult, String> {
    let to_recipients = to
        .iter()
        .map(|addr| {
            format!(
                r#"msg.toRecipients.push(app.Recipient({{address: "{}"}}));"#,
                escape_js(addr)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let cc_recipients = cc
        .unwrap_or_default()
        .iter()
        .map(|addr| {
            format!(
                r#"msg.ccRecipients.push(app.Recipient({{address: "{}"}}));"#,
                escape_js(addr)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let script = format!(
        r#"
        var app = Application("Mail");
        app.activate();
        var msg = app.OutgoingMessage({{
            subject: "{}",
            content: "{}",
            visible: true
        }});
        app.outgoingMessages.push(msg);
        {}
        {}
        "ok";
        "#,
        escape_js(&subject),
        escape_js(&body),
        to_recipients,
        cc_recipients,
    );

    match run_jxa(&script) {
        Ok(_) => Ok(NativeAppResult::ok(format!(
            "已创建邮件草稿：收件人 {}，主题「{}」",
            to.join(", "),
            subject
        ))),
        Err(e) => Ok(NativeAppResult::err(e)),
    }
}

// ══════════════════════════════════════════════
//  快捷指令 (Shortcuts.app)
// ══════════════════════════════════════════════

/// 列出所有快捷指令
#[tauri::command]
pub async fn native_shortcuts_list() -> Result<NativeAppResult, String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("shortcuts")
            .arg("list")
            .output()
            .map_err(|e| format!("获取快捷指令列表失败: {}", e))?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let shortcuts: Vec<serde_json::Value> = stdout
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(|name| serde_json::json!({"name": name.trim()}))
                .collect();
            let count = shortcuts.len();
            Ok(NativeAppResult::ok_with_data(
                format!("找到 {} 个快捷指令", count),
                serde_json::Value::Array(shortcuts),
            ))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Ok(NativeAppResult::err(format!(
                "获取快捷指令失败: {}",
                stderr
            )))
        }
    }
    #[cfg(not(target_os = "macos"))]
    Ok(NativeAppResult::err("快捷指令仅支持 macOS"))
}

/// 运行快捷指令
#[tauri::command]
pub async fn native_shortcuts_run(
    name: String,
    input: Option<String>,
) -> Result<NativeAppResult, String> {
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("shortcuts");
        cmd.arg("run").arg(&name);
        if let Some(ref inp) = input {
            cmd.arg("-i").arg(inp);
        }
        let output = cmd
            .output()
            .map_err(|e| format!("运行快捷指令失败: {}", e))?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok(NativeAppResult::ok_with_data(
                format!("已运行快捷指令「{}」", name),
                serde_json::json!({"output": stdout}),
            ))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Ok(NativeAppResult::err(format!("运行失败: {}", stderr)))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = input;
        Ok(NativeAppResult::err("快捷指令仅支持 macOS"))
    }
}

// ══════════════════════════════════════════════
//  通用：打开/切换到指定应用
// ══════════════════════════════════════════════

/// 打开/激活一个应用程序
#[tauri::command]
pub async fn native_app_open(app_name: String) -> Result<NativeAppResult, String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("open")
            .arg("-a")
            .arg(&app_name)
            .output()
            .map_err(|e| format!("打开应用失败: {}", e))?;

        if output.status.success() {
            Ok(NativeAppResult::ok(format!("已打开应用「{}」", app_name)))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Ok(NativeAppResult::err(format!("打开失败: {}", stderr)))
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        open::that(&app_name).map_err(|e| format!("打开失败: {}", e))?;
        Ok(NativeAppResult::ok(format!("已打开「{}」", app_name)))
    }
}

/// 列出已安装的可交互应用
#[tauri::command]
pub async fn native_app_list_interactive() -> Result<NativeAppResult, String> {
    #[cfg(target_os = "macos")]
    {
        let apps = serde_json::json!([
            {"name": "日历", "app": "Calendar", "capabilities": ["创建事件", "查看日程", "列出日历"]},
            {"name": "提醒事项", "app": "Reminders", "capabilities": ["创建提醒", "查看提醒", "列出列表"]},
            {"name": "备忘录", "app": "Notes", "capabilities": ["创建备忘录", "搜索备忘录"]},
            {"name": "邮件", "app": "Mail", "capabilities": ["创建草稿"]},
            {"name": "快捷指令", "app": "Shortcuts", "capabilities": ["列出指令", "运行指令"]},
            {"name": "访达", "app": "Finder", "capabilities": ["打开文件夹"]},
            {"name": "终端", "app": "Terminal", "capabilities": ["执行命令"]},
            {"name": "系统偏好设置", "app": "System Preferences", "capabilities": ["打开设置"]},
        ]);
        Ok(NativeAppResult::ok_with_data("可交互的本机应用列表", apps))
    }
    #[cfg(target_os = "windows")]
    {
        let apps = serde_json::json!([
            {"name": "系统设置", "tool": "win_open_settings", "capabilities": ["打开设置首页", "显示/网络/蓝牙/通知/声音/存储/应用/隐私/更新等页面"], "example_page": "display"},
            {"name": "打开应用", "tool": "native_app_open", "capabilities": ["记事本(notepad)", "计算器(calc)", "资源管理器(explorer)", "cmd", "PowerShell(powershell)", "Edge(msedge)", "Chrome(chrome) 等"]},
        ]);
        Ok(NativeAppResult::ok_with_data("Windows 上可供 AI 调用的原生能力", apps))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Ok(NativeAppResult::err("当前系统暂无原生应用列表"))
}

// ══════════════════════════════════════════════
//  Windows 原生能力
// ══════════════════════════════════════════════

/// 打开 Windows 系统设置页面（供 AI 助手调用）
#[tauri::command]
pub async fn win_open_settings(_page: Option<String>) -> Result<NativeAppResult, String> {
    #[cfg(target_os = "windows")]
    {
        let uri = _page
            .as_deref()
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
            .map(|p| format!("ms-settings:{}", p))
            .unwrap_or_else(|| "ms-settings:".to_string());
        open::that(&uri).map_err(|e| format!("打开设置失败: {}", e))?;
        let msg = _page
            .as_deref()
            .filter(|p| !p.is_empty())
            .map(|p| format!("已打开设置页面「{}」", p))
            .unwrap_or_else(|| "已打开系统设置".to_string());
        Ok(NativeAppResult::ok(msg))
    }
    #[cfg(not(target_os = "windows"))]
    Ok(NativeAppResult::err("win_open_settings 仅支持 Windows"))
}

// ── 工具函数 ──

fn escape_js(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}
