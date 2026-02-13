mod commands;

use tauri::{
    Manager,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    menu::{Menu, MenuItem},
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// 显示窗口的统一帮助函数：居中 → 显示 → 聚焦，并临时抑制失焦隐藏
fn show_window(window: &tauri::WebviewWindow, suppress: &Arc<AtomicBool>) {
    suppress.store(true, Ordering::SeqCst);
    let _ = window.center();
    let _ = window.show();
    let _ = window.set_focus();
    // 1.5 秒后取消抑制，给窗口足够时间获取焦点
    let s = suppress.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        s.store(false, Ordering::SeqCst);
    });
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
        .invoke_handler(tauri::generate_handler![
            commands::ai::ai_chat,
            commands::ai::ai_chat_stream,
            commands::ai::ai_get_config,
            commands::ai::ai_set_config,
            commands::window::toggle_main_window,
            commands::window::resize_window,
            commands::window::hide_window,
            commands::window::start_drag,
            commands::window::stop_drag,
            commands::system::run_python_script,
            commands::system::get_python_path,
            commands::system::preview_file,
            commands::system::open_url,
            commands::system::open_file_location,
            commands::system::save_chat_history,
            commands::system::load_chat_history,
            commands::system::save_general_settings,
            commands::system::load_general_settings,
            commands::data_forge::dataforge_get_scripts,
            commands::data_forge::dataforge_search_scripts,
            commands::data_forge::dataforge_run_script,
            commands::data_forge::dataforge_get_history,
            commands::data_forge::dataforge_save_credential,
            commands::data_forge::dataforge_get_credentials,
            commands::plugin::plugin_list,
            commands::plugin::plugin_open,
            commands::plugin::plugin_close,
            commands::plugin::plugin_api_call,
            commands::rag::rag_list_docs,
            commands::rag::rag_import_doc,
            commands::rag::rag_remove_doc,
            commands::rag::rag_reindex_doc,
            commands::rag::rag_search,
            commands::rag::rag_get_stats,
            commands::rag::rag_set_config,
        ])
        .setup(|app| {
            // 失焦隐藏的抑制标志（显示窗口后短时间内不自动隐藏）
            let suppress_hide = Arc::new(AtomicBool::new(false));

            // 创建系统托盘
            let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &settings, &quit])?;

            let suppress_for_menu = suppress_hide.clone();
            let suppress_for_tray = suppress_hide.clone();
            TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("51ToolBox")
                .icon(app.default_window_icon().unwrap().clone())
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            show_window(&window, &suppress_for_menu);
                        }
                    }
                    "quit" => {
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
                })
                .build(app)?;

            // 注册全局快捷键
            use tauri_plugin_global_shortcut::ShortcutState;
            let suppress_for_shortcut = suppress_hide.clone();
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(move |app, shortcut, event| {
                        if event.state == ShortcutState::Pressed {
                            let shortcut_str = shortcut.to_string();

                            // Alt+Space → 切换主窗口
                            if shortcut_str.contains("Alt") && shortcut_str.contains("Space")
                                && !shortcut_str.contains("Shift")
                                && !shortcut_str.contains("Control")
                            {
                                if let Some(window) = app.get_webview_window("main") {
                                    if window.is_visible().unwrap_or(false) {
                                        let _ = window.hide();
                                    } else {
                                        show_window(&window, &suppress_for_shortcut);
                                    }
                                }
                            }

                            // Ctrl+Shift+A → 上下文操作（读取剪贴板并发送给前端）
                            if shortcut_str.contains("Control") && shortcut_str.contains("Shift")
                                && shortcut_str.contains("KeyA")
                            {
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

            // 注册快捷键
            use tauri_plugin_global_shortcut::GlobalShortcutExt;
            app.global_shortcut().register("Alt+Space")?;
            app.global_shortcut().register("Control+Shift+A")?;

            // 主窗口失焦隐藏（读取用户设置决定是否启用）
            let main_window = app.get_webview_window("main").unwrap();
            let window_clone = main_window.clone();
            let suppress_for_focus = suppress_hide.clone();
            let app_handle_for_focus = app.handle().clone();
            main_window.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(false) = event {
                    // 如果处于抑制期（刚主动显示窗口），跳过自动隐藏
                    if suppress_for_focus.load(Ordering::SeqCst) {
                        return;
                    }
                    // 读取用户设置，未配置时默认启用
                    let hide_on_blur = {
                        use tauri_plugin_store::StoreExt;
                        app_handle_for_focus.store("config.json").ok()
                            .and_then(|store| store.get("general_settings"))
                            .and_then(|v| v.as_str().map(|s| s.to_string()))
                            .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
                            .and_then(|obj| obj.get("hideOnBlur").and_then(|v| v.as_bool()))
                            .unwrap_or(true)
                    };
                    if !hide_on_blur {
                        return;
                    }
                    // 失焦时隐藏窗口（延迟判断，防止误触）
                    let w = window_clone.clone();
                    let s = suppress_for_focus.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        // 再次检查抑制标志和焦点状态
                        if !s.load(Ordering::SeqCst) && !w.is_focused().unwrap_or(true) {
                            let _ = w.hide();
                        }
                    });
                }
            });

            // 启动时显示窗口
            show_window(&main_window, &suppress_hide);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
