mod commands;

use tauri::{
    Manager,
    PhysicalPosition,
    Position,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    menu::{Menu, MenuItem},
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::path::PathBuf;

fn is_subpath_of(path: &std::path::Path, root: &std::path::Path) -> bool {
    path.starts_with(root)
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
    // 4) 截图预览等临时文件目录
    roots.push(std::env::temp_dir());

    // 只保留可规范化的目录，避免无效路径干扰判断
    roots
        .into_iter()
        .filter_map(|p| p.canonicalize().ok())
        .collect()
}

fn is_allowed_mtplugin_path(app: &tauri::AppHandle, canonical: &std::path::Path) -> bool {
    let roots = allowed_mtplugin_roots(app);
    roots
        .iter()
        .any(|root| is_subpath_of(canonical, root))
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
        // CAS: 只有当当前值仍等于 gen 时，才将其重置为 0
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
        .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(commands::ai::ToolConfirmationState {
            pending: std::sync::Mutex::new(None),
        })
        .manage(commands::ai::StreamCancellation::new())
        .manage(std::sync::Mutex::new(commands::plugin::PluginCache::new()))
        .manage(commands::mcp::McpServerManager::new())
        .manage(commands::ding::DingManager::new())
        // 自定义协议：为插件文件提供 Tauri IPC 支持
        // 用 mtplugin://localhost/绝对路径 替代 file:// URL
        .register_uri_scheme_protocol("mtplugin", |app, request| {
            let raw_path = request.uri().path();
            let decoded = url_decode(raw_path);
            let file_path = PathBuf::from(&decoded);

            // 安全校验：规范化路径并拒绝包含 ".." 的路径遍历攻击
            let canonical = match file_path.canonicalize() {
                Ok(p) => p,
                Err(_) => {
                    return tauri::http::Response::builder()
                        .status(404)
                        .header("Content-Type", "text/plain")
                        .body(b"Not Found".to_vec())
                        .unwrap();
                }
            };
            // 阻止 .. 路径遍历：解码后的路径不应包含 ".."
            if decoded.contains("..") {
                return tauri::http::Response::builder()
                    .status(403)
                    .header("Content-Type", "text/plain")
                    .body(b"Forbidden: path traversal".to_vec())
                    .unwrap();
            }

            if !canonical.exists() {
                return tauri::http::Response::builder()
                    .status(404)
                    .header("Content-Type", "text/plain")
                    .body(b"Not Found".to_vec())
                    .unwrap();
            }
            // 仅允许访问白名单根目录，避免任意文件读取
            if !is_allowed_mtplugin_path(&app.app_handle(), &canonical) {
                return tauri::http::Response::builder()
                    .status(403)
                    .header("Content-Type", "text/plain")
                    .body(b"Forbidden: path not allowed".to_vec())
                    .unwrap();
            }
            // 仅允许读取文件，不允许目录
            if !canonical.is_file() {
                return tauri::http::Response::builder()
                    .status(403)
                    .header("Content-Type", "text/plain")
                    .body(b"Forbidden: file only".to_vec())
                    .unwrap();
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
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![
            commands::ai::ai_chat,
            commands::ai::ai_chat_stream,
            commands::ai::ai_get_config,
            commands::ai::ai_set_config,
            commands::ai::ai_confirm_tool,
            commands::ai::ai_stop_stream,
            commands::ai::ai_save_chat_image,
            commands::window::toggle_main_window,
            commands::window::resize_window,
            commands::window::hide_window,
            commands::window::show_window_cmd,
            commands::window::start_drag,
            commands::window::stop_drag,
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
            commands::system::save_general_settings,
            commands::system::load_general_settings,
            commands::system::clean_old_chat_images,
            commands::system::read_text_file,
            commands::system::write_text_file,
            commands::system::list_directory,
            commands::system::run_shell_command,
            commands::data_forge::dataforge_get_scripts,
            commands::data_forge::dataforge_search_scripts,
            commands::data_forge::dataforge_run_script,
            commands::data_forge::dataforge_get_history,
            commands::data_forge::dataforge_save_credential,
            commands::data_forge::dataforge_get_credentials,
            commands::plugin::plugin_list,
            commands::plugin::plugin_open,
            commands::plugin::plugin_get_embed_html,
            commands::plugin::plugin_close,
            commands::plugin::plugin_api_call,
            commands::plugin::plugin_add_dev_dir,
            commands::plugin::plugin_remove_dev_dir,
            commands::plugin::plugin_set_enabled,
            commands::plugin::plugin_start_color_picker,
            commands::plugin::plugin_get_pixel_at,
            commands::rag::rag_list_docs,
            commands::rag::rag_import_doc,
            commands::rag::rag_remove_doc,
            commands::rag::rag_reindex_doc,
            commands::rag::rag_search,
            commands::rag::rag_get_stats,
            commands::rag::rag_set_config,
            commands::workflow::workflow_list,
            commands::workflow::workflow_create,
            commands::workflow::workflow_update,
            commands::workflow::workflow_delete,
            commands::workflow::workflow_execute,
            commands::workflow::workflow_scheduler_start,
            commands::workflow::workflow_scheduler_stop,
            commands::workflow::workflow_scheduler_reload,
            commands::workflow::workflow_scheduler_status,
            commands::screen_capture::screen_capture_check,
            commands::screen_capture::screen_capture_download,
            commands::screen_capture::screen_capture_call,
            commands::screen_capture::init_screenshot_window,
            commands::screen_capture::screenshot_window_ready,
            commands::screen_capture::show_screenshot_window,
            commands::screen_capture::start_capture,
            commands::screen_capture::finish_capture,
            commands::screen_capture::cancel_capture,
            commands::screen_capture::get_last_screenshot,
            commands::screen_capture::capture_all_windows,
            commands::screen_capture::list_windows_xcap,
            commands::screen_capture::capture_window_xcap_by_id,
            commands::webdav::webdav_test,
            commands::webdav::webdav_create_dir,
            commands::ocr::ocr_detect,
            commands::ocr::ocr_detect_advanced,
            commands::ocr::ocr_list_models,
            commands::mcp::start_mcp_stdio_server,
            commands::mcp::stop_mcp_server,
            commands::mcp::send_mcp_message,
            commands::ding::ding_create,
            commands::ding::ding_close,
            commands::ding::ding_start_drag,
            commands::ding::ding_resize,
            commands::ding::ding_set_opacity,
            commands::ding::ding_list,
            commands::ding::ding_close_all,
            commands::translate::translate_text,
            commands::git_sync::git_sync_push,
            commands::git_sync::git_sync_pull,
            commands::git_sync::git_sync_status,
            commands::mtools_sync::mtools_sync_test,
            commands::mtools_sync::mtools_sync_push,
            commands::mtools_sync::mtools_sync_pull,
            commands::clipboard::clipboard_history_list,
            commands::clipboard::clipboard_history_clear,
            commands::clipboard::clipboard_history_delete,
            commands::clipboard::clipboard_history_write,
            commands::ai::ai_agent_stream,
            commands::file_search::file_search,
            commands::file_search::file_open,
            commands::file_search::file_show_in_folder,
            commands::file_search::app_search,
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
        ])
        .setup(|app| {
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
fn setup_tray(app: &tauri::App, suppress_hide: &Arc<AtomicUsize>) -> Result<(), Box<dyn std::error::Error>> {
    let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &settings, &quit])?;

    let suppress_for_menu = suppress_hide.clone();
    let suppress_for_tray = suppress_hide.clone();
    let mut tray_builder = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("mTools")
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    show_window(&window, &suppress_for_menu);
                }
            }
            "quit" => { app.exit(0); }
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

/// 注册全局快捷键
fn setup_shortcuts(app: &tauri::App, suppress_hide: &Arc<AtomicUsize>) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState, GlobalShortcutExt};

    let toggle_shortcut = Shortcut::new(Some(Modifiers::META), Code::Digit2);
    let context_shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyA);

    let suppress_for_shortcut = suppress_hide.clone();
    app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    if shortcut == &toggle_shortcut {
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                show_window(&window, &suppress_for_shortcut);
                            }
                        }
                    }
                    if shortcut == &context_shortcut {
                        use tauri_plugin_clipboard_manager::ClipboardExt;
                        let text = app.clipboard().read_text().unwrap_or_default();
                        if !text.is_empty() {
                            use tauri::Emitter;
                            let _ = app.emit("context-action", serde_json::json!({ "text": text }));
                            if let Some(window) = app.get_webview_window("main") {
                                show_window(&window, &suppress_for_shortcut);
                            }
                        }
                    }
                }
            })
            .build(),
    )?;
    app.global_shortcut().register(toggle_shortcut)?;
    app.global_shortcut().register(context_shortcut)?;
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
                let settings = app_handle_for_focus.store("config.json").ok()
                    .and_then(|store| store.get("general_settings"))
                    .and_then(|v| v.as_str().map(|s| s.to_string()))
                    .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok());
                let hide = settings.as_ref()
                    .and_then(|obj| obj.get("hideOnBlur").and_then(|v| v.as_bool()))
                    .unwrap_or(true);
                let top = settings.as_ref()
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
        if let Err(e) = tauri::async_runtime::block_on(
            commands::system::clean_old_chat_images(handle, 7),
        ) {
            log::warn!("自动清理图片失败: {}", e);
        }
    });
}

/// URL percent-decode：将 %20 等还原为原始字符
fn url_decode(input: &str) -> String {
    let mut result = Vec::new();
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                result.push(byte);
                i += 3;
                continue;
            }
        }
        result.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&result).to_string()
}
