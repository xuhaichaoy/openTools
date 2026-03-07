use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager};

use super::is_dangerous_tool;
use crate::commands::ai::stream::ToolConfirmationState;

/// 执行指定工具并返回结果
pub async fn execute_tool(app: &AppHandle, name: &str, args: &str) -> Result<String, String> {
    let args_value: serde_json::Value =
        serde_json::from_str(args).unwrap_or(serde_json::Value::Object(Default::default()));

    // 对危险工具，先请求用户确认
    if is_dangerous_tool(name) {
        let approved = request_tool_confirmation(app, name, args).await?;
        if !approved {
            return Ok("用户拒绝执行此操作。".to_string());
        }
    }

    match name {
        "search_data_scripts" => {
            let query = args_value["query"].as_str().unwrap_or("").to_string();
            let results =
                crate::commands::data_forge::dataforge_search_scripts(app.clone(), query).await?;
            Ok(serde_json::to_string_pretty(&results).unwrap_or_default())
        }
        "run_data_script" => {
            let script_id = args_value["script_id"].as_str().unwrap_or("").to_string();
            let params: HashMap<String, serde_json::Value> = args_value["params"]
                .as_object()
                .map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                .unwrap_or_default();
            let result =
                crate::commands::data_forge::dataforge_run_script(app.clone(), script_id, params)
                    .await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "run_shell_command" => {
            let command = args_value["command"].as_str().unwrap_or("echo hello");
            let result = crate::commands::system::run_shell_command(command.to_string()).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "read_clipboard" => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let text = app.clipboard().read_text().unwrap_or_default();
            Ok(text)
        }
        "write_clipboard" => {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let text = args_value["text"].as_str().unwrap_or("").to_string();
            app.clipboard()
                .write_text(&text)
                .map_err(|e| e.to_string())?;
            Ok("已写入剪贴板".to_string())
        }
        "web_search" => {
            let query = args_value["query"].as_str().unwrap_or("").to_string();
            if query.trim().is_empty() {
                return Err("搜索关键词不能为空".to_string());
            }
            let max_results = args_value["max_results"].as_u64().unwrap_or(5) as usize;
            let max_results = max_results.min(10).max(1);
            crate::commands::system::web_search_impl(query, max_results).await
        }
        "web_fetch" => {
            let url = args_value["url"].as_str().unwrap_or("").to_string();
            if url.is_empty() {
                return Err("url 不能为空".to_string());
            }
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err(format!("无效的 URL（必须以 http:// 或 https:// 开头）: {}", url));
            }
            let body = crate::commands::system::web_fetch_url(url.clone()).await?;
            let trimmed = body.trim();
            if trimmed.is_empty() {
                Ok(format!("已获取 {} 但内容为空。", url))
            } else {
                let max_chars = 8000;
                if trimmed.len() > max_chars {
                    Ok(format!(
                        "{}\n\n[内容已截断，共 {} 字符，显示前 {} 字符]",
                        &trimmed[..max_chars],
                        trimmed.len(),
                        max_chars
                    ))
                } else {
                    Ok(trimmed.to_string())
                }
            }
        }
        "list_knowledge_docs" => {
            let summaries = crate::commands::rag::rag_list_doc_summaries(app.clone()).await?;
            if summaries.is_empty() {
                Ok("知识库为空，用户尚未导入任何文档。".to_string())
            } else {
                let mut output = format!("知识库中共 {} 个文档:\n\n", summaries.len());
                for (i, s) in summaries.iter().enumerate() {
                    output.push_str(&format!(
                        "{}. [{}] {} ({}, {} 块, ~{} tokens)\n   标签: {:?} | 状态: {}\n",
                        i + 1,
                        s["id"].as_str().unwrap_or(""),
                        s["name"].as_str().unwrap_or(""),
                        s["format"].as_str().unwrap_or(""),
                        s["chunkCount"].as_u64().unwrap_or(0),
                        s["tokenCount"].as_u64().unwrap_or(0),
                        s["tags"],
                        s["status"].as_str().unwrap_or(""),
                    ));
                }
                Ok(output)
            }
        }
        "search_docs" => {
            let query = args_value["query"].as_str().unwrap_or("").to_string();
            let top_k = args_value["top_k"].as_u64().map(|v| v as usize);
            let results =
                match crate::commands::rag::rag_search(app.clone(), query.clone(), top_k, None)
                    .await
                {
                    Ok(r) => r,
                    Err(_) => {
                        crate::commands::rag::rag_keyword_search(app.clone(), query, top_k).await?
                    }
                };
            if results.is_empty() {
                Ok(
                    "知识库中未找到与该问题相关的内容。请直接用你的知识回答用户，不要再次搜索。"
                        .to_string(),
                )
            } else {
                let mut output = format!("找到 {} 个相关片段:\n\n", results.len());
                for (i, r) in results.iter().enumerate() {
                    let content = &r.chunk.content;
                    let display = if content.chars().count() <= 500 {
                        content.clone()
                    } else {
                        format!(
                            "{}…（已截断，用 read_doc_chunks 读取完整内容）",
                            content.chars().take(500).collect::<String>()
                        )
                    };
                    output.push_str(&format!(
                        "--- 片段 {} [doc_id={}, chunk={}, 来源={}, 相关度={:.0}%] ---\n{}\n\n",
                        i + 1,
                        r.chunk.doc_id,
                        r.chunk.index,
                        r.chunk.metadata.source,
                        r.score * 100.0,
                        display,
                    ));
                }
                output
                    .push_str("如果以上内容已包含答案，直接回答即可，无需再调用 read_doc_chunks。");
                Ok(output)
            }
        }
        "read_doc_chunks" => {
            let doc_id = args_value["doc_id"].as_str().unwrap_or("").to_string();
            let chunk_indices: Vec<usize> = args_value["chunk_indices"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_u64().map(|n| n as usize))
                        .collect()
                })
                .unwrap_or_default();
            let context_window = args_value["context_window"].as_u64().map(|v| v as usize);
            let chunks = crate::commands::rag::rag_read_doc_chunks(
                app.clone(),
                doc_id,
                chunk_indices,
                context_window,
            )
            .await?;
            if chunks.is_empty() {
                Ok("未找到指定的 chunk 内容。".to_string())
            } else {
                let mut output = String::new();
                for chunk in &chunks {
                    let is_target = chunk["isTarget"].as_bool().unwrap_or(false);
                    let marker = if is_target { ">>>" } else { "   " };
                    output.push_str(&format!(
                        "{} [chunk {}] ({} tokens)\n{}\n\n",
                        marker,
                        chunk["index"].as_u64().unwrap_or(0),
                        chunk["tokenCount"].as_u64().unwrap_or(0),
                        chunk["content"].as_str().unwrap_or(""),
                    ));
                }
                Ok(output)
            }
        }
        // backward compat: old tool name → redirect to keyword search
        "search_knowledge_base" => {
            let query = args_value["query"].as_str().unwrap_or("").to_string();
            let top_k = args_value["top_k"].as_u64().map(|v| v as usize);
            let results =
                crate::commands::rag::rag_keyword_search(app.clone(), query, top_k).await?;
            if results.is_empty() {
                Ok("知识库中未找到相关内容。".to_string())
            } else {
                let mut output = format!("在知识库中找到 {} 个相关片段:\n\n", results.len());
                for (i, r) in results.iter().enumerate() {
                    output.push_str(&format!(
                        "--- 片段 {} (来源: {}, 相关度: {:.1}%) ---\n{}\n\n",
                        i + 1,
                        r.chunk.metadata.source,
                        r.score * 100.0,
                        r.chunk.content
                    ));
                }
                Ok(output)
            }
        }
        "read_file" => {
            let path = args_value["path"].as_str().unwrap_or("").to_string();
            crate::commands::system::validate_path_access(app, &path)?;
            let max_bytes = args_value["max_bytes"].as_u64().unwrap_or(102400) as usize;
            let file_path = std::path::Path::new(&path);
            if !file_path.exists() {
                return Err(format!("文件不存在: {}", path));
            }
            let bytes = std::fs::read(&file_path).map_err(|e| format!("读取失败: {}", e))?;
            let truncated = if bytes.len() > max_bytes {
                &bytes[..max_bytes]
            } else {
                &bytes
            };
            let content = String::from_utf8_lossy(truncated).to_string();
            if bytes.len() > max_bytes {
                Ok(format!(
                    "{}\n\n[文件截断，已读取 {}/{} 字节]",
                    content,
                    max_bytes,
                    bytes.len()
                ))
            } else {
                Ok(content)
            }
        }
        "read_file_range" => {
            let path = args_value["path"].as_str().unwrap_or("").to_string();
            if path.trim().is_empty() {
                return Err("path 不能为空".to_string());
            }
            let start_line = args_value["start_line"].as_u64().map(|v| v as usize);
            let end_line = args_value["end_line"].as_u64().map(|v| v as usize);
            let max_lines = args_value["max_lines"].as_u64().map(|v| v as usize);
            crate::commands::system::read_text_file_range(
                app.clone(),
                path,
                start_line,
                end_line,
                max_lines,
            )
            .await
        }
        "write_file" => {
            let path = args_value["path"].as_str().unwrap_or("").to_string();
            let content = args_value["content"].as_str().unwrap_or("").to_string();
            let result =
                crate::commands::system::write_text_file(app.clone(), path, content).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "list_directory" => {
            let path = args_value["path"].as_str().unwrap_or(".").to_string();
            crate::commands::system::validate_path_access(app, &path)?;
            let dir_path = std::path::Path::new(&path);
            if !dir_path.exists() {
                return Err(format!("目录不存在: {}", path));
            }
            if !dir_path.is_dir() {
                return Err(format!("不是目录: {}", path));
            }
            let mut entries = Vec::new();
            let read_dir =
                std::fs::read_dir(&dir_path).map_err(|e| format!("读取目录失败: {}", e))?;
            for entry in read_dir {
                if let Ok(entry) = entry {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let ft = entry
                        .file_type()
                        .map(|t| {
                            if t.is_dir() {
                                "📁"
                            } else if t.is_symlink() {
                                "🔗"
                            } else {
                                "📄"
                            }
                        })
                        .unwrap_or("❓");
                    let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                    if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                        entries.push(format!("{} {}/", ft, name));
                    } else {
                        entries.push(format!("{} {} ({} bytes)", ft, name, size));
                    }
                }
            }
            entries.sort();
            Ok(format!(
                "目录 {} 下共 {} 项:\n{}",
                path,
                entries.len(),
                entries.join("\n")
            ))
        }
        "search_in_files" => {
            let path = args_value["path"].as_str().unwrap_or("").to_string();
            if path.trim().is_empty() {
                return Err("path 不能为空".to_string());
            }
            let query = args_value["query"].as_str().unwrap_or("").to_string();
            if query.trim().is_empty() {
                return Err("query 不能为空".to_string());
            }
            let case_sensitive = args_value["case_sensitive"].as_bool();
            let max_results = args_value["max_results"].as_u64().map(|v| v as usize);
            let file_pattern = args_value["file_pattern"].as_str().map(|s| s.to_string());
            crate::commands::system::search_in_files(
                app.clone(),
                path,
                query,
                case_sensitive,
                max_results,
                file_pattern,
            )
            .await
        }
        "get_system_info" => {
            let os = std::env::consts::OS;
            let arch = std::env::consts::ARCH;
            let hostname = hostname::get()
                .map(|h| h.to_string_lossy().to_string())
                .unwrap_or_else(|_| "unknown".to_string());
            let username = std::env::var("USER")
                .or_else(|_| std::env::var("USERNAME"))
                .unwrap_or_else(|_| "unknown".to_string());
            let home = dirs::home_dir()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "unknown".to_string());
            let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
            Ok(format!(
                "操作系统: {} {}\n主机名: {}\n用户名: {}\nHome目录: {}\n当前时间: {}",
                os, arch, hostname, username, home, now
            ))
        }
        "open_url" => {
            let url = args_value["url"].as_str().unwrap_or("").to_string();
            if url.is_empty() {
                return Err("URL 不能为空".to_string());
            }
            open::that(&url).map_err(|e| format!("打开失败: {}", e))?;
            Ok(format!("已在默认浏览器打开: {}", url))
        }
        "open_path" => {
            let path = args_value["path"].as_str().unwrap_or("").to_string();
            if path.is_empty() {
                return Err("路径不能为空".to_string());
            }
            crate::commands::system::validate_path_access(app, &path)?;
            open::that(&path).map_err(|e| format!("打开失败: {}", e))?;
            Ok(format!("已打开: {}", path))
        }
        "get_running_processes" => {
            let output = if cfg!(target_os = "windows") {
                tokio::process::Command::new("cmd")
                    .args(["/C", "tasklist"])
                    .output()
                    .await
            } else {
                tokio::process::Command::new("ps")
                    .args(["aux"])
                    .output()
                    .await
            }
            .map_err(|e| format!("获取进程列表失败: {}", e))?;
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let lines: Vec<&str> = stdout.lines().collect();
            let top_lines: Vec<&str> = lines.iter().take(31).copied().collect();
            Ok(format!("当前运行进程 (前30):\n{}", top_lines.join("\n")))
        }
        // ── 原生应用工具 ──
        "native_calendar_create_event" => {
            let title = args_value["title"].as_str().unwrap_or("").to_string();
            let start_date = args_value["start_date"].as_str().unwrap_or("").to_string();
            let end_date = args_value["end_date"].as_str().map(|s| s.to_string());
            let calendar = args_value["calendar"].as_str().map(|s| s.to_string());
            let location = args_value["location"].as_str().map(|s| s.to_string());
            let notes = args_value["notes"].as_str().map(|s| s.to_string());
            let all_day = args_value["all_day"].as_bool();
            let result = crate::commands::native_apps::native_calendar_create_event(
                calendar, title, start_date, end_date, location, notes, all_day,
            )
            .await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "native_calendar_list_events" => {
            let days = args_value["days"].as_i64().map(|d| d as i32);
            let result = crate::commands::native_apps::native_calendar_list_events(days).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "native_reminder_create" => {
            let title = args_value["title"].as_str().unwrap_or("").to_string();
            let list_name = args_value["list_name"].as_str().map(|s| s.to_string());
            let notes = args_value["notes"].as_str().map(|s| s.to_string());
            let due_date = args_value["due_date"].as_str().map(|s| s.to_string());
            let priority = args_value["priority"].as_i64().map(|p| p as i32);
            let result = crate::commands::native_apps::native_reminder_create(
                list_name, title, notes, due_date, priority,
            )
            .await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "native_reminder_list_incomplete" => {
            let list_name = args_value["list_name"].as_str().map(|s| s.to_string());
            let result =
                crate::commands::native_apps::native_reminder_list_incomplete(list_name).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "native_notes_create" => {
            let title = args_value["title"].as_str().unwrap_or("").to_string();
            let body = args_value["body"].as_str().unwrap_or("").to_string();
            let folder = args_value["folder"].as_str().map(|s| s.to_string());
            let result =
                crate::commands::native_apps::native_notes_create(folder, title, body).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "native_notes_search" => {
            let query = args_value["query"].as_str().unwrap_or("").to_string();
            let limit = args_value["limit"].as_u64().map(|l| l as usize);
            let result = crate::commands::native_apps::native_notes_search(query, limit).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "native_mail_create" => {
            let to: Vec<String> = args_value["to"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
                .unwrap_or_default();
            let subject = args_value["subject"].as_str().unwrap_or("").to_string();
            let body = args_value["body"].as_str().unwrap_or("").to_string();
            let cc: Option<Vec<String>> = args_value["cc"].as_array().map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            });
            let result =
                crate::commands::native_apps::native_mail_create(to, subject, body, cc).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "native_shortcuts_run" => {
            let shortcut_name = args_value["name"].as_str().unwrap_or("").to_string();
            let input = args_value["input"].as_str().map(|s| s.to_string());
            let result =
                crate::commands::native_apps::native_shortcuts_run(shortcut_name, input).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "native_app_open" => {
            let app_name = args_value["app_name"].as_str().unwrap_or("").to_string();
            let result = crate::commands::native_apps::native_app_open(app_name).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "native_app_list_interactive" => {
            let result = crate::commands::native_apps::native_app_list_interactive().await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        "win_open_settings" => {
            let page = args_value["page"].as_str().map(|s| s.to_string());
            let result = crate::commands::native_apps::win_open_settings(page).await?;
            Ok(serde_json::to_string_pretty(&result).unwrap_or_default())
        }
        _ => {
            // 尝试前端工具桥接（MCP/插件工具由前端执行）
            request_frontend_tool_execution(app, name, args).await
        }
    }
}

/// 将未知工具调用转发到前端执行（MCP/插件工具桥接）
async fn request_frontend_tool_execution(
    app: &AppHandle,
    name: &str,
    args: &str,
) -> Result<String, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();

    {
        let state = app.state::<super::super::stream::FrontendToolState>();
        let mut pending = state
            .pending
            .lock()
            .map_err(|e| format!("锁获取失败: {}", e))?;
        *pending = Some(tx);
    }

    let _ = app.emit(
        "ai-frontend-tool-call",
        serde_json::json!({
            "name": name,
            "arguments": args,
        }),
    );

    match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(format!("前端工具 {} 执行通道关闭", name)),
        Err(_) => {
            let state = app.state::<super::super::stream::FrontendToolState>();
            let mut pending = state
                .pending
                .lock()
                .map_err(|e| format!("锁获取失败: {}", e))?;
            *pending = None;
            Err(format!("前端工具 {} 执行超时（120s）", name))
        }
    }
}

/// 请求用户确认危险工具的执行
pub async fn request_tool_confirmation(
    app: &AppHandle,
    name: &str,
    args: &str,
) -> Result<bool, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<bool>();

    {
        let state = app.state::<ToolConfirmationState>();
        let mut pending = state
            .pending
            .lock()
            .map_err(|e| format!("锁获取失败: {}", e))?;
        *pending = Some(tx);
    }

    let _ = app.emit(
        "ai-tool-confirm-request",
        serde_json::json!({
            "name": name,
            "arguments": args,
        }),
    );

    match tokio::time::timeout(std::time::Duration::from_secs(60), rx).await {
        Ok(Ok(approved)) => Ok(approved),
        Ok(Err(_)) => Ok(false),
        Err(_) => {
            let state = app.state::<ToolConfirmationState>();
            let mut pending = state
                .pending
                .lock()
                .map_err(|e| format!("锁获取失败: {}", e))?;
            *pending = None;
            Ok(false)
        }
    }
}
