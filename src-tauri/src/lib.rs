pub mod branding;
mod commands;
pub mod crypto;
pub mod error;
mod mtplugin;

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, PhysicalPosition, Position,
};

const MAIN_TRAY_ID: &str = "main-tray";

/// 当前生效的全局快捷键（用于 handler 比对与重载时 unregister）
#[cfg(not(any(target_os = "android", target_os = "ios")))]
struct CurrentShortcuts {
    toggle: tauri_plugin_global_shortcut::Shortcut,
    context: tauri_plugin_global_shortcut::Shortcut,
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
impl Default for CurrentShortcuts {
    fn default() -> Self {
        Self {
            toggle: "Super+Digit2".parse().expect("default toggle shortcut"),
            context: "Control+Shift+KeyA"
                .parse()
                .expect("default context shortcut"),
        }
    }
}

/// 从 general_settings JSON 重载全局快捷键（保存设置后由前端调用）
#[cfg(not(any(target_os = "android", target_os = "ios")))]
#[tauri::command]
fn reload_global_shortcuts(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    use tauri_plugin_store::StoreExt;

    let store = app.store("config.json").map_err(|e| e.to_string())?;
    let json_str = store
        .get("general_settings")
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_else(|| "{}".to_string());
    let json: serde_json::Value = serde_json::from_str(&json_str).unwrap_or(serde_json::json!({}));

    let toggle_str = json
        .get("shortcutToggle")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Super+Digit2");
    let context_str = json
        .get("shortcutContext")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Control+Shift+KeyA");

    let new_toggle: Shortcut = toggle_str
        .parse()
        .map_err(|e| format!("无效唤醒快捷键: {}", e))?;
    let new_context: Shortcut = context_str
        .parse()
        .map_err(|e| format!("无效上下文快捷键: {}", e))?;

    let state = app
        .try_state::<Mutex<CurrentShortcuts>>()
        .ok_or_else(|| "CurrentShortcuts state not found".to_string())?;
    let mut cur = state.lock().map_err(|e| e.to_string())?;
    let _ = app.global_shortcut().unregister(cur.toggle.clone());
    let _ = app.global_shortcut().unregister(cur.context.clone());
    if app.global_shortcut().register(new_toggle.clone()).is_err() {
        log::warn!("全局快捷键 {} 注册失败（可能已被占用）", toggle_str);
    }
    if app.global_shortcut().register(new_context.clone()).is_err() {
        log::warn!("全局快捷键 {} 注册失败（可能已被占用）", context_str);
    }
    *cur = CurrentShortcuts {
        toggle: new_toggle,
        context: new_context,
    };
    Ok(())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
#[tauri::command]
fn reload_global_shortcuts(_app: tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn set_tray_attention_count(app: tauri::AppHandle, count: u32) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(MAIN_TRAY_ID) else {
        return Err("tray not found".to_string());
    };

    let display_count = count.min(99);
    let tooltip = if count == 0 {
        branding::APP_NAME.to_string()
    } else {
        format!("{} - {} 个待处理询问", branding::APP_NAME, count)
    };

    tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;

    #[cfg(target_os = "macos")]
    tray.set_title(if count == 0 {
        None::<String>
    } else {
        Some(display_count.to_string())
    })
    .map_err(|e| e.to_string())?;

    #[cfg(not(target_os = "macos"))]
    let _ = display_count;

    Ok(())
}

fn is_subpath_of(path: &std::path::Path, root: &std::path::Path) -> bool {
    path.starts_with(root)
}

/// 构建 URI scheme 错误响应，避免到处写 unwrap
fn http_error_response(status: u16, body: &[u8]) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", "text/plain")
        .body(body.to_vec())
        .unwrap_or_else(|_| {
            tauri::http::Response::builder()
                .status(500)
                .body(b"Internal Error".to_vec())
                .expect("fallback response must succeed")
        })
}

fn allowed_mtplugin_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();

    // 1) 打包资源中的 plugins 目录
    if let Ok(resource_dir) = app.path().resource_dir() {
        roots.push(resource_dir.join("plugins"));
    }
    // 2) 开发目录中的 plugins 目录
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.join("plugins"));
    }
    // 3) 开发者插件目录（来自 plugin-settings.json 的 devDirs）
    {
        use tauri_plugin_store::StoreExt;
        if let Ok(store) = app.store("plugin-settings.json") {
            if let Some(dirs) = store.get("devDirs") {
                if let Some(arr) = dirs.as_array() {
                    for v in arr {
                        if let Some(s) = v.as_str() {
                            roots.push(PathBuf::from(s));
                        }
                    }
                }
            }
        }
    }
    // 4) 临时文件目录（插件中转图片等）
    roots.push(std::env::temp_dir());
    // 5) 官方市场插件目录（AppData/plugins/official）
    if let Ok(app_data_dir) = app.path().app_data_dir() {
        roots.push(app_data_dir.join("plugins").join("official"));
    }

    // 只保留可规范化的目录，避免无效路径干扰判断
    roots
        .into_iter()
        .filter_map(|p| p.canonicalize().ok())
        .collect()
}

fn is_allowed_mtplugin_path(app: &tauri::AppHandle, canonical: &std::path::Path) -> bool {
    let roots = allowed_mtplugin_roots(app);
    roots.iter().any(|root| is_subpath_of(canonical, root))
}

/// 显示窗口的统一帮助函数：显示 → 聚焦，并临时抑制失焦隐藏
fn show_window(window: &tauri::WebviewWindow, suppress: &Arc<AtomicUsize>) {
    // 增加生成代数，表示新的抑制周期开始（非0即为抑制状态）
    let gen = suppress.fetch_add(1, Ordering::SeqCst) + 1;
    // let _ = window.center(); // removed to keep last position
    let _ = window.show();
    let _ = window.set_focus();
    // 1.5 秒后取消抑制，但只有当当前代数未发生变化时才重置（避免覆盖新的抑制请求）
    let s = suppress.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let _ = s.compare_exchange(gen, 0, Ordering::SeqCst, Ordering::SeqCst);
    });
}

/// 启动时将主窗口放到当前屏幕“居中偏上”（仅初始化位置）
fn place_main_window_top_center(window: &tauri::WebviewWindow) {
    // 先交给系统做跨平台居中，避免不同平台/多显示器坐标系差异。
    if window.center().is_err() {
        return;
    }

    let monitor = match window.current_monitor() {
        Ok(Some(m)) => m,
        _ => return,
    };
    let monitor_pos = monitor.position();
    let monitor_h = monitor.size().height as i32;
    let centered_pos = match window.outer_position() {
        Ok(p) => p,
        Err(_) => return,
    };

    // 以屏幕高度为基准向上偏移（百分比），避免“贴底/贴顶”。
    let upward_ratio = 0.08_f64;
    let upward_offset = (monitor_h as f64 * upward_ratio).round() as i32;
    let min_y = monitor_pos.y + 24; // 留一点安全边距
    let y = (centered_pos.y - upward_offset).max(min_y);

    let _ = window.set_position(Position::Physical(PhysicalPosition {
        x: centered_pos.x,
        y,
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(commands::ai::ToolConfirmationState {
            pending: std::sync::Mutex::new(None),
        })
        .manage(commands::ai::FrontendToolState {
            pending: std::sync::Mutex::new(None),
        })
        .manage(commands::ai::StreamCancellation::new())
        .manage(std::sync::Mutex::new(commands::plugin::PluginCache::new()))
        .manage(std::sync::Mutex::new(
            commands::plugin::PluginDevState::new(),
        ))
        .manage(commands::mcp::McpServerManager::new())
        .manage(commands::ssh::SshManager::new())
        .manage(commands::database::DatabaseManager::new())
        .manage(commands::ding::DingManager::new())
        .manage(commands::dingtalk_stream::DingTalkStreamManager::new())
        .manage(commands::feishu_ws::FeishuWsManager::new())
        .manage(commands::im_callback::ImCallbackServerManager::new())
        // 自定义协议：为插件文件提供 Tauri IPC 支持
        // 用 mtplugin://localhost/绝对路径 替代 file:// URL
        .register_uri_scheme_protocol("mtplugin", |app, request| {
            let raw_path = request.uri().path();
            let decoded = mtplugin::decode_mtplugin_request_path(raw_path);
            let file_path = PathBuf::from(&decoded);

            // 安全校验：规范化路径并拒绝包含 ".." 的路径遍历攻击
            let canonical = match file_path.canonicalize() {
                Ok(p) => p,
                Err(_) => {
                    return http_error_response(404, b"Not Found");
                }
            };
            // 阻止 .. 路径遍历：解码后的路径不应包含 ".."
            if decoded.contains("..") {
                return http_error_response(403, b"Forbidden: path traversal");
            }

            if !canonical.exists() {
                return http_error_response(404, b"Not Found");
            }
            // 仅允许访问白名单根目录，避免任意文件读取
            if !is_allowed_mtplugin_path(&app.app_handle(), &canonical) {
                return http_error_response(403, b"Forbidden: path not allowed");
            }
            // 仅允许读取文件，不允许目录
            if !canonical.is_file() {
                return http_error_response(403, b"Forbidden: file only");
            }

            let content = std::fs::read(&canonical).unwrap_or_default();
            let mime = match file_path.extension().and_then(|e| e.to_str()) {
                Some("html") | Some("htm") => "text/html; charset=utf-8",
                Some("js") | Some("mjs") => "application/javascript; charset=utf-8",
                Some("css") => "text/css; charset=utf-8",
                Some("json") => "application/json; charset=utf-8",
                Some("png") => "image/png",
                Some("jpg") | Some("jpeg") => "image/jpeg",
                Some("gif") => "image/gif",
                Some("bmp") => "image/bmp",
                Some("svg") => "image/svg+xml",
                Some("ico") => "image/x-icon",
                Some("woff") => "font/woff",
                Some("woff2") => "font/woff2",
                Some("ttf") => "font/ttf",
                Some("webp") => "image/webp",
                _ => "application/octet-stream",
            };

            tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", mime)
                .header("Access-Control-Allow-Origin", "*")
                // 禁止缓存（截图文件每次都不同，防止 webview 显示旧图）
                .header("Cache-Control", "no-store, no-cache, must-revalidate")
                .header("Pragma", "no-cache")
                .body(content)
                .unwrap_or_else(|_| http_error_response(500, b"Response build error"))
        })
        .invoke_handler(tauri::generate_handler![
            // ── AI ──
            commands::ai::ai_chat,
            commands::ai::ai_chat_stream,
            commands::ai::ai_get_config,
            commands::ai::ai_set_config,
            commands::ai::ai_get_own_keys,
            commands::ai::ai_set_own_keys,
            commands::ai::ai_confirm_tool,
            commands::ai::ai_frontend_tool_result,
            commands::ai::ai_stop_stream,
            commands::ai::ai_save_chat_image,
            commands::ai::ai_embedding,
            commands::ai::ai_list_models,
            commands::ai::agent::ai_agent_stream,
            // ── Agent Orchestrator ──
            commands::agent_orchestrator::agent_task_create,
            commands::agent_orchestrator::agent_task_list,
            commands::agent_orchestrator::agent_task_pause,
            commands::agent_orchestrator::agent_task_resume,
            commands::agent_orchestrator::agent_task_cancel,
            commands::agent_orchestrator::agent_task_delete,
            commands::agent_orchestrator::agent_task_set_status,
            commands::agent_orchestrator::agent_scheduler_start,
            commands::agent_orchestrator::agent_scheduler_reload,
            commands::agent_orchestrator::agent_scheduler_status,
            // ── Agent Runtime (Docker) ──
            commands::agent_runtime::agent_container_available,
            commands::agent_runtime::agent_container_run_shell,
            commands::agent_runtime::agent_container_write_file,
            // ── Window ──
            commands::window::toggle_main_window,
            commands::window::resize_window,
            commands::window::hide_window,
            commands::window::show_window_cmd,
            commands::window::start_drag,
            commands::window::stop_drag,
            set_tray_attention_count,
            // ── System / File ──
            commands::system::run_python_script,
            commands::system::get_python_path,
            commands::system::read_file_base64,
            commands::system::preview_file,
            commands::system::open_url,
            commands::system::open_file_location,
            commands::system::save_chat_history,
            commands::system::load_chat_history,
            commands::system::save_agent_history,
            commands::system::load_agent_history,
            commands::system::web_fetch_url,
            commands::system::web_search,
            commands::system::save_general_settings,
            commands::system::load_general_settings,
            reload_global_shortcuts,
            commands::system::clean_old_chat_images,
            commands::system::read_text_file,
            commands::system::read_text_file_range,
            commands::system::write_text_file,
            commands::system::create_directory,
            commands::system::delete_file,
            commands::system::move_file,
            commands::system::list_directory,
            commands::system::search_in_files,
            commands::system::run_shell_command,
            commands::system::extract_spreadsheet_text,
            commands::system::extract_document_text,
            commands::system::export_spreadsheet,
            // ── File Search ──
            commands::file_search::file_search,
            commands::file_search::file_open,
            commands::file_search::file_show_in_folder,
            commands::file_search::app_search,
            // ── Plugin ──
            commands::plugin::lifecycle::plugin_list,
            commands::plugin::lifecycle::plugin_add_dev_dir,
            commands::plugin::lifecycle::plugin_remove_dev_dir,
            commands::plugin::lifecycle::plugin_set_enabled,
            commands::plugin::lifecycle::plugin_market_install,
            commands::plugin::lifecycle::plugin_market_install_official_local,
            commands::plugin::lifecycle::plugin_market_uninstall,
            commands::plugin::lifecycle::plugin_market_clear_data,
            commands::plugin::lifecycle::plugin_dev_watch_start,
            commands::plugin::lifecycle::plugin_dev_watch_stop,
            commands::plugin::lifecycle::plugin_dev_watch_status,
            commands::plugin::lifecycle::plugin_dev_get_trace_buffer,
            commands::plugin::lifecycle::plugin_dev_clear_trace_buffer,
            commands::plugin::api_bridge::plugin_open,
            commands::plugin::api_bridge::plugin_close,
            commands::plugin::api_bridge::plugin_action_callback,
            commands::plugin::api_bridge::plugin_api_call,
            commands::plugin::api_bridge::plugin_get_embed_html,
            commands::plugin::api_bridge::plugin_dev_simulate_event,
            commands::plugin::api_bridge::plugin_dev_open_devtools,
            commands::plugin::api_bridge::plugin_dev_storage_dump,
            commands::plugin::api_bridge::plugin_dev_storage_clear,
            commands::plugin::plugin_start_color_picker,
            commands::plugin::plugin_get_pixel_at,
            // ── Workflow ──
            commands::workflow::workflow_list,
            commands::workflow::workflow_create,
            commands::workflow::workflow_update,
            commands::workflow::workflow_delete,
            commands::workflow::engine::workflow_execute,
            commands::workflow::scheduler::workflow_scheduler_start,
            commands::workflow::scheduler::workflow_scheduler_stop,
            commands::workflow::scheduler::workflow_scheduler_reload,
            commands::workflow::scheduler::workflow_scheduler_status,
            // ── OCR ──
            commands::ocr::ocr_detect,
            commands::ocr::ocr_detect_advanced,
            commands::ocr::ocr_list_models,
            commands::ocr::ocr_get_runtime_info,
            commands::ocr::ocr_open_model_dir,
            // ── RAG ──
            commands::rag::rag_list_docs,
            commands::rag::rag_import_doc,
            commands::rag::rag_import_from_content,
            commands::rag::rag_parse_doc,
            commands::rag::rag_index_doc,
            commands::rag::rag_retry_doc,
            commands::rag::rag_remove_doc,
            commands::rag::rag_reindex_doc,
            commands::rag::rag_search,
            commands::rag::rag_keyword_search,
            commands::rag::rag_list_doc_summaries,
            commands::rag::rag_read_doc_chunks,
            commands::rag::rag_get_stats,
            commands::rag::rag_get_config,
            commands::rag::rag_set_config,
            // ── DataForge ──
            commands::data_forge::dataforge_get_scripts,
            commands::data_forge::dataforge_search_scripts,
            commands::data_forge::dataforge_run_script,
            commands::data_forge::dataforge_get_history,
            commands::data_forge::dataforge_save_credential,
            commands::data_forge::dataforge_get_credentials,
            // ── Ding (置顶贴图) ──
            commands::ding::ding_create,
            commands::ding::ding_close,
            commands::ding::ding_start_drag,
            commands::ding::ding_resize,
            commands::ding::ding_set_opacity,
            commands::ding::ding_list,
            commands::ding::ding_close_all,
            // ── Clipboard ──
            commands::clipboard::clipboard_history_list,
            commands::clipboard::clipboard_history_clear,
            commands::clipboard::clipboard_history_delete,
            commands::clipboard::clipboard_history_write,
            // ── Cloud Sync ──
            commands::mtools_sync::mtools_sync_test,
            commands::mtools_sync::mtools_sync_push,
            commands::mtools_sync::mtools_sync_pull,
            // ── CKG (Code Knowledge Graph) ──
            commands::ckg::ckg_index_project,
            commands::ckg::ckg_search_function,
            commands::ckg::ckg_search_class,
            commands::ckg::ckg_search_class_method,
            commands::ckg::ckg_get_stats,
            // ── MCP / Translate / Collection ──
            commands::mcp::start_mcp_stdio_server,
            commands::mcp::stop_mcp_server,
            commands::mcp::send_mcp_message,
            commands::mcp::mcp_send_sse_message,
            commands::mcp::mcp_save_config,
            commands::mcp::mcp_load_config,
            commands::mcp::mcp_list_servers,
            commands::mcp::mcp_get_server_status,
            commands::dingtalk_stream::start_dingtalk_stream_channel,
            commands::dingtalk_stream::stop_dingtalk_stream_channel,
            commands::dingtalk_stream::get_dingtalk_stream_channel_status,
            commands::dingtalk_stream::dingtalk_send_app_message,
            commands::dingtalk_stream::dingtalk_send_webhook_message,
            commands::agent_orchestrator::agent_show_notification,
            commands::feishu_ws::start_feishu_ws_channel,
            commands::feishu_ws::stop_feishu_ws_channel,
            commands::feishu_ws::get_feishu_ws_channel_status,
            commands::feishu_ws::feishu_refresh_tenant_access_token,
            commands::feishu_ws::feishu_send_app_message,
            commands::feishu_ws::feishu_add_typing_reaction,
            commands::feishu_ws::feishu_remove_typing_reaction,
            commands::feishu_ws::feishu_send_webhook_message,
            commands::im_callback::start_im_callback_server,
            commands::im_callback::stop_im_callback_server,
            commands::im_callback::get_im_callback_server_status,
            commands::translate::translate_text,
            commands::collection::collection_get_all,
            commands::collection::collection_create,
            commands::collection::collection_update,
            commands::collection::collection_delete,
            commands::collection::collection_set_all,
            // ── SSH ──
            commands::ssh::ssh_connect,
            commands::ssh::ssh_disconnect,
            commands::ssh::ssh_shell_open,
            commands::ssh::ssh_shell_write,
            commands::ssh::ssh_shell_resize,
            commands::ssh::ssh_sftp_list,
            commands::ssh::ssh_sftp_read,
            commands::ssh::ssh_sftp_write,
            commands::ssh::ssh_sftp_mkdir,
            commands::ssh::ssh_sftp_remove,
            commands::ssh::ssh_sftp_rename,
            commands::ssh::ssh_save_connections,
            commands::ssh::ssh_load_connections,
            // ── Database ──
            commands::database::db_connect,
            commands::database::db_disconnect,
            commands::database::db_test_connection,
            commands::database::db_execute_query,
            commands::database::db_list_schemas,
            commands::database::db_list_tables,
            commands::database::db_describe_table,
            commands::database::db_save_connections,
            commands::database::db_load_connections,
            // ── Native Apps ──
            commands::native_apps::native_calendar_list,
            commands::native_apps::native_calendar_create_event,
            commands::native_apps::native_calendar_list_events,
            commands::native_apps::native_reminder_lists,
            commands::native_apps::native_reminder_create,
            commands::native_apps::native_reminder_list_incomplete,
            commands::native_apps::native_notes_create,
            commands::native_apps::native_notes_search,
            commands::native_apps::native_mail_create,
            commands::native_apps::native_shortcuts_list,
            commands::native_apps::native_shortcuts_run,
            commands::native_apps::native_app_open,
            commands::native_apps::native_app_list_interactive,
            commands::native_apps::win_open_settings,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                // Hide app icon from Dock (menu-bar/accessory app behavior).
                let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            let suppress_hide = Arc::new(AtomicUsize::new(0));
            setup_tray(app, &suppress_hide)?;
            setup_shortcuts(app, &suppress_hide)?;
            let Some(main_window) = app.get_webview_window("main") else {
                return Err("main window not found".into());
            };
            place_main_window_top_center(&main_window);
            setup_window_events(&main_window, app.handle(), &suppress_hide);
            setup_macos_window(&main_window);
            show_window(&main_window, &suppress_hide);
            schedule_cleanup(app.handle());
            commands::clipboard::start_clipboard_watcher(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── Setup 子函数 ──

/// 创建系统托盘
fn setup_tray(
    app: &tauri::App,
    suppress_hide: &Arc<AtomicUsize>,
) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &settings, &quit])?;

    let suppress_for_menu = suppress_hide.clone();
    let suppress_for_tray = suppress_hide.clone();
    let mut tray_builder = TrayIconBuilder::with_id(MAIN_TRAY_ID)
        .menu(&menu)
        .tooltip(branding::APP_NAME)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    show_window(&window, &suppress_for_menu);
                }
            }
            "quit" => {
                #[cfg(not(any(target_os = "android", target_os = "ios")))]
                {
                    use tauri_plugin_global_shortcut::GlobalShortcutExt;
                    if let Some(state) = app.try_state::<Mutex<CurrentShortcuts>>() {
                        if let Ok(cur) = state.lock() {
                            let _ = app.global_shortcut().unregister(cur.toggle.clone());
                            let _ = app.global_shortcut().unregister(cur.context.clone());
                        }
                    }
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    show_window(&window, &suppress_for_tray);
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray_builder = tray_builder.icon(icon.clone());
    } else {
        log::warn!("未找到默认窗口图标，托盘将使用系统默认图标");
    }
    tray_builder.build(app)?;
    Ok(())
}

/// 注册全局快捷键（使用 CurrentShortcuts 状态，支持后续 reload_global_shortcuts 重载）
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn setup_shortcuts(
    app: &tauri::App,
    suppress_hide: &Arc<AtomicUsize>,
) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let default = CurrentShortcuts::default();
    app.manage(Mutex::new(CurrentShortcuts::default()));

    let suppress_for_shortcut = suppress_hide.clone();
    app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }
                if let Some(state) = app.try_state::<Mutex<CurrentShortcuts>>() {
                    if let Ok(cur) = state.lock() {
                        if *shortcut == cur.toggle {
                            if let Some(window) = app.get_webview_window("main") {
                                if window.is_visible().unwrap_or(false) {
                                    let _ = window.hide();
                                } else {
                                    show_window(&window, &suppress_for_shortcut);
                                }
                            }
                        } else if *shortcut == cur.context {
                            use tauri_plugin_clipboard_manager::ClipboardExt;
                            let text = app.clipboard().read_text().unwrap_or_default();
                            if !text.is_empty() {
                                use tauri::Emitter;
                                let _ =
                                    app.emit("context-action", serde_json::json!({ "text": text }));
                                if let Some(window) = app.get_webview_window("main") {
                                    show_window(&window, &suppress_for_shortcut);
                                }
                            }
                        }
                    }
                }
            })
            .build(),
    )?;
    if app
        .global_shortcut()
        .register(default.toggle.clone())
        .is_err()
    {
        log::warn!("全局快捷键 唤醒/隐藏 注册失败（可能已被占用），将不生效");
    }
    if app
        .global_shortcut()
        .register(default.context.clone())
        .is_err()
    {
        log::warn!("全局快捷键 上下文操作 注册失败（可能已被占用），将不生效");
    }
    Ok(())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn setup_shortcuts(
    _app: &tauri::App,
    _suppress_hide: &Arc<AtomicUsize>,
) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

/// 设置主窗口失焦隐藏行为
fn setup_window_events(
    main_window: &tauri::WebviewWindow,
    app_handle: &tauri::AppHandle,
    suppress_hide: &Arc<AtomicUsize>,
) {
    let window_clone = main_window.clone();
    let suppress_for_focus = suppress_hide.clone();
    let app_handle_for_focus = app_handle.clone();
    main_window.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(false) = event {
            if suppress_for_focus.load(Ordering::SeqCst) > 0 {
                return;
            }
            let (hide_on_blur, always_on_top) = {
                use tauri_plugin_store::StoreExt;
                let settings = app_handle_for_focus
                    .store("config.json")
                    .ok()
                    .and_then(|store| store.get("general_settings"))
                    .and_then(|v| v.as_str().map(|s| s.to_string()))
                    .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok());
                let hide = settings
                    .as_ref()
                    .and_then(|obj| obj.get("hideOnBlur").and_then(|v| v.as_bool()))
                    .unwrap_or(true);
                let top = settings
                    .as_ref()
                    .and_then(|obj| obj.get("alwaysOnTop").and_then(|v| v.as_bool()))
                    .unwrap_or(true);
                (hide, top)
            };
            let _ = window_clone.set_always_on_top(always_on_top);
            if !hide_on_blur {
                return;
            }
            let w = window_clone.clone();
            let s = suppress_for_focus.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(500));
                if s.load(Ordering::SeqCst) == 0 && !w.is_focused().unwrap_or(true) {
                    let _ = w.hide();
                }
            });
        }
    });
}

/// macOS: 设置窗口在所有桌面可见
fn setup_macos_window(_main_window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    #[allow(deprecated)]
    unsafe {
        use cocoa::appkit::{NSWindow, NSWindowCollectionBehavior};
        use cocoa::base::id;
        if let Ok(raw) = _main_window.ns_window() {
            let ns_window = raw as id;
            let behavior = ns_window.collectionBehavior();
            ns_window.setCollectionBehavior_(
                behavior | NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces,
            );
        } else {
            log::warn!("无法获取 macOS 原生窗口句柄，跳过 all-spaces 设置");
        }
    }
}

/// 启动时异步清理过期图片
fn schedule_cleanup(app_handle: &tauri::AppHandle) {
    let handle = app_handle.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(5));
        if let Err(e) =
            tauri::async_runtime::block_on(commands::system::clean_old_chat_images(handle, 7))
        {
            log::warn!("自动清理图片失败: {}", e);
        }
    });
}
