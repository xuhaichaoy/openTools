use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

// ── 类型定义 ──

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
    pub cmds: Vec<serde_json::Value>, // 可以是 string 或 PluginCommand 对象
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
    // mTools 扩展 — 插件可携带工作流
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

// ── 插件缓存 & 开发者目录 ──

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

// ── 插件扫描 ──

fn get_plugins_dir(app: &AppHandle) -> PathBuf {
    let resource_dir = app.path().resource_dir().unwrap_or_default();
    let plugins_dir = resource_dir.join("plugins");
    if plugins_dir.exists() {
        return plugins_dir;
    }
    std::env::current_dir().unwrap_or_default().join("plugins")
}

fn scan_plugin_dir(dir: &PathBuf) -> Option<(PluginManifest, String)> {
    // 优先检查 plugin.json (uTools 格式)
    let plugin_json = dir.join("plugin.json");
    if plugin_json.exists() {
        if let Ok(content) = std::fs::read_to_string(&plugin_json) {
            if let Ok(manifest) = serde_json::from_str::<PluginManifest>(&content) {
                return Some((manifest, "plugin.json".to_string()));
            }
        }
    }

    // 再检查 package.json (Rubick 格式)
    let package_json = dir.join("package.json");
    if package_json.exists() {
        if let Ok(content) = std::fs::read_to_string(&package_json) {
            if let Ok(manifest) = serde_json::from_str::<PluginManifest>(&content) {
                // 只有有 features 字段的才认为是插件
                if !manifest.features.is_empty() {
                    return Some((manifest, "package.json".to_string()));
                }
            }
        }
    }

    None
}

/// 从单个目录生成稳定的插件 ID（目录名 + 插件名组合）
fn make_plugin_id(dir: &PathBuf, manifest: &PluginManifest) -> String {
    let dir_name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let name_part = manifest
        .plugin_name
        .to_lowercase()
        .replace(' ', "-")
        .replace(['/', '\\', '.'], "");
    if dir_name.is_empty() || dir_name == name_part {
        name_part
    } else {
        format!("{}-{}", dir_name, name_part)
    }
}

/// 扫描一组目录，返回去重后的插件列表
fn scan_dirs(dirs: &[PathBuf], disabled_ids: &HashSet<String>) -> Vec<PluginInfo> {
    let mut plugins = Vec::new();
    let mut seen_ids = HashSet::new();

    for base_dir in dirs {
        if !base_dir.exists() {
            continue;
        }

        // 先检查 base_dir 本身是否就是一个插件目录
        if scan_plugin_dir(base_dir).is_some() {
            if let Some((manifest, _)) = scan_plugin_dir(base_dir) {
                let id = make_plugin_id(base_dir, &manifest);
                if seen_ids.insert(id.clone()) {
                    plugins.push(PluginInfo {
                        enabled: !disabled_ids.contains(&id),
                        id,
                        is_builtin: false,
                        manifest,
                        dir_path: base_dir.to_string_lossy().to_string(),
                    });
                }
            }
            continue;
        }

        // 否则遍历子目录
        if let Ok(entries) = std::fs::read_dir(base_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }

                if let Some((manifest, _)) = scan_plugin_dir(&path) {
                    let id = make_plugin_id(&path, &manifest);
                    if seen_ids.insert(id.clone()) {
                        let is_builtin = path
                            .file_name()
                            .map(|n| n.to_string_lossy().starts_with("builtin-"))
                            .unwrap_or(false);

                        plugins.push(PluginInfo {
                            enabled: !disabled_ids.contains(&id),
                            id,
                            manifest,
                            dir_path: path.to_string_lossy().to_string(),
                            is_builtin,
                        });
                    }
                }
            }
        }
    }

    plugins
}

/// 重新扫描并更新缓存，返回最新列表
fn refresh_plugin_cache(app: &AppHandle) -> Vec<PluginInfo> {
    let cache = app.state::<Mutex<PluginCache>>();
    let mut cache = cache.lock().unwrap();

    let mut dirs = vec![get_plugins_dir(app)];
    for dev_dir in &cache.dev_dirs {
        dirs.push(PathBuf::from(dev_dir));
    }

    cache.plugins = scan_dirs(&dirs, &cache.disabled_ids);
    cache.plugins.clone()
}

/// 从缓存获取插件列表（不重新扫描）
fn get_cached_plugins(app: &AppHandle) -> Vec<PluginInfo> {
    let cache = app.state::<Mutex<PluginCache>>();
    let cache = cache.lock().unwrap();
    if cache.plugins.is_empty() {
        drop(cache);
        return refresh_plugin_cache(app);
    }
    cache.plugins.clone()
}

// ── Tauri Commands ──

/// 获取所有已安装的插件（刷新扫描）
#[tauri::command]
pub async fn plugin_list(app: AppHandle) -> Result<Vec<PluginInfo>, String> {
    Ok(refresh_plugin_cache(&app))
}

/// 添加开发者插件目录
#[tauri::command]
pub async fn plugin_add_dev_dir(app: AppHandle, dir_path: String) -> Result<Vec<PluginInfo>, String> {
    {
        let cache = app.state::<Mutex<PluginCache>>();
        let mut cache = cache.lock().unwrap();
        cache.dev_dirs.insert(dir_path);
    }
    Ok(refresh_plugin_cache(&app))
}

/// 移除开发者插件目录
#[tauri::command]
pub async fn plugin_remove_dev_dir(app: AppHandle, dir_path: String) -> Result<Vec<PluginInfo>, String> {
    {
        let cache = app.state::<Mutex<PluginCache>>();
        let mut cache = cache.lock().unwrap();
        cache.dev_dirs.remove(&dir_path);
    }
    Ok(refresh_plugin_cache(&app))
}

/// 启用/禁用插件
#[tauri::command]
pub async fn plugin_set_enabled(app: AppHandle, plugin_id: String, enabled: bool) -> Result<Vec<PluginInfo>, String> {
    {
        let cache = app.state::<Mutex<PluginCache>>();
        let mut cache = cache.lock().unwrap();
        if enabled {
            cache.disabled_ids.remove(&plugin_id);
        } else {
            cache.disabled_ids.insert(plugin_id);
        }
    }
    Ok(refresh_plugin_cache(&app))
}

/// 在新窗口中打开插件
/// 关键：使用 WebviewUrl::App 加载（保证 __TAURI__ IPC 可用），
/// 然后通过 initialization_script + document.write() 替换文档为插件 HTML。
/// window 对象不变，__TAURI__ 和 utools 依然存活。
#[tauri::command]
pub async fn plugin_open(
    app: AppHandle,
    plugin_id: String,
    feature_code: String,
) -> Result<(), String> {
    let plugins = get_cached_plugins(&app);
    let plugin = plugins
        .iter()
        .find(|p| p.id == plugin_id)
        .ok_or_else(|| format!("插件 {} 不存在", plugin_id))?;

    if !plugin.enabled {
        return Err(format!("插件 {} 已被禁用", plugin_id));
    }

    let feature = plugin
        .manifest
        .features
        .iter()
        .find(|f| f.code == feature_code)
        .ok_or_else(|| format!("功能 {} 不存在", feature_code))?;

    let window_label = format!("plugin-{}-{}", plugin_id, feature_code);

    // 如果窗口已存在，直接显示
    if let Some(window) = app.get_webview_window(&window_label) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let title = format!(
        "{} - {}",
        plugin.manifest.plugin_name, feature.explain
    );

    let shim_script = generate_utools_shim(&plugin_id);

    // 开发模式：直接加载开发服务器 URL（开发服务器通常与 app 同源，IPC 可用）
    if let Some(dev) = &plugin.manifest.development {
        if let Some(main_url) = dev.get("main").and_then(|v| v.as_str()) {
            let url = WebviewUrl::External(
                main_url.parse().map_err(|e| format!("无效 URL: {}", e))?,
            );
            let enter_script = generate_plugin_enter_script(&feature_code, "text", None);
            WebviewWindowBuilder::new(&app, &window_label, url)
                .title(&title)
                .inner_size(800.0, 600.0)
                .center()
                .initialization_script(&shim_script)
                .initialization_script(&enter_script)
                .build()
                .map_err(|e| format!("创建窗口失败: {}", e))?;
            return Ok(());
        }
    }

    // 读取插件 HTML 文件
    let main_file = plugin
        .manifest
        .main
        .as_deref()
        .ok_or("插件缺少 main 入口")?;
    let main_path = PathBuf::from(&plugin.dir_path).join(main_file);
    if !main_path.exists() {
        return Err(format!("插件入口文件不存在: {}", main_path.display()));
    }
    let html_content = std::fs::read_to_string(&main_path)
        .map_err(|e| format!("读取插件文件失败: {}", e))?;

    // 为相对路径资源添加 <base> 标签，指向 mtplugin:// 协议
    let base_url = format!(
        "mtplugin://localhost{}/",
        plugin.dir_path.replace('\\', "/")
    );
    let html_with_base = inject_base_tag(&html_content, &base_url);

    // JSON 序列化 HTML → 安全的 JS 字符串字面量
    let json_html =
        serde_json::to_string(&html_with_base).map_err(|e| e.to_string())?;

    // 注入脚本：用 document.write 替换文档；延迟一帧执行确保 Tauri IPC 已注入
    let inject_script = format!(
        r#"(function(){{
if(window.__mtools_injected)return;
window.__mtools_injected=true;
var __h={json_html};
function __replace(){{
  document.open();document.write(__h);document.close();
  setTimeout(function(){{if(window.__utoolsOnEnterCallback)window.__utoolsOnEnterCallback({{code:'{code}',type:'text',payload:undefined}});}},200);
}}
function __run(){{
  if(document.readyState==='loading'){{
    document.addEventListener('DOMContentLoaded',function(){{ setTimeout(__replace,0); }},{{once:true}});
  }}else{{
    setTimeout(__replace,0);
  }}
}}
setTimeout(__run,0);
}})();"#,
        json_html = json_html,
        code = feature_code,
    );

    // 使用 App 自身 origin 创建窗口 → IPC 桥自动注入
    let window = WebviewWindowBuilder::new(
        &app,
        &window_label,
        WebviewUrl::App(PathBuf::from("index.html")),
    )
    .title(&title)
    .inner_size(800.0, 600.0)
    .center()
    .initialization_script(&shim_script)
    .initialization_script(&inject_script)
    .build()
    .map_err(|e| format!("创建窗口失败: {}", e))?;

    // preload 脚本延迟注入（等文档替换完成）
    if let Some(preload) = &plugin.manifest.preload {
        let preload_path = PathBuf::from(&plugin.dir_path).join(preload);
        if preload_path.exists() {
            if let Ok(preload_content) = std::fs::read_to_string(&preload_path) {
                let w = window.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    let _ = w.eval(&preload_content);
                });
            }
        }
    }

    Ok(())
}

/// 关闭插件窗口
#[tauri::command]
pub async fn plugin_close(app: AppHandle, plugin_id: String, feature_code: String) -> Result<(), String> {
    let window_label = format!("plugin-{}-{}", plugin_id, feature_code);
    if let Some(window) = app.get_webview_window(&window_label) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 处理插件内 utools API 调用
#[tauri::command]
pub async fn plugin_api_call(
    app: AppHandle,
    plugin_id: String,
    method: String,
    args: String,
    call_id: u64,
) -> Result<String, String> {
    let _ = call_id; // 保留以备异步场景使用
    let args: serde_json::Value = serde_json::from_str(&args).unwrap_or(serde_json::Value::Null);

    match method.as_str() {
        "hideMainWindow" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
            Ok("null".to_string())
        }
        "showMainWindow" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
            Ok("null".to_string())
        }
        "setExpendHeight" => {
            let height = args.get("height").and_then(|v| v.as_f64()).unwrap_or(600.0);
            // 找到对应插件窗口并调整高度
            for (label, window) in app.webview_windows() {
                if label.starts_with(&format!("plugin-{}", plugin_id)) {
                    let size = window.inner_size().map_err(|e| e.to_string())?;
                    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                        width: size.width,
                        height: height as u32,
                    }));
                    break;
                }
            }
            Ok("null".to_string())
        }
        "copyText" => {
            let text = args.get("text").and_then(|v| v.as_str()).unwrap_or("");
            use tauri_plugin_clipboard_manager::ClipboardExt;
            app.clipboard().write_text(text).map_err(|e| e.to_string())?;
            Ok("true".to_string())
        }
        "showNotification" => {
            let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("");
            use tauri_plugin_notification::NotificationExt;
            app.notification()
                .builder()
                .title("mTools")
                .body(body)
                .show()
                .map_err(|e| e.to_string())?;
            Ok("null".to_string())
        }
        "shellOpenExternal" => {
            let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let _ = open::that(url);
            Ok("null".to_string())
        }
        "dbStorage.setItem" => {
            use tauri_plugin_store::StoreExt;
            let key = args.get("key").and_then(|v| v.as_str()).unwrap_or("");
            let value = args.get("value").cloned().unwrap_or(serde_json::Value::Null);
            let store_name = format!("plugin-{}.json", plugin_id);
            let store = app.store(&store_name).map_err(|e| e.to_string())?;
            store.set(key, value);
            Ok("null".to_string())
        }
        "dbStorage.getItem" => {
            use tauri_plugin_store::StoreExt;
            let key = args.get("key").and_then(|v| v.as_str()).unwrap_or("");
            let store_name = format!("plugin-{}.json", plugin_id);
            let store = app.store(&store_name).map_err(|e| e.to_string())?;
            let value = store.get(key).unwrap_or(serde_json::Value::Null);
            Ok(serde_json::to_string(&value).unwrap_or("null".to_string()))
        }
        "dbStorage.removeItem" => {
            use tauri_plugin_store::StoreExt;
            let key = args.get("key").and_then(|v| v.as_str()).unwrap_or("");
            let store_name = format!("plugin-{}.json", plugin_id);
            let store = app.store(&store_name).map_err(|e| e.to_string())?;
            let _ = store.delete(key);
            Ok("null".to_string())
        }
        "outPlugin" => {
            // 关闭插件窗口
            for (label, window) in app.webview_windows() {
                if label.starts_with(&format!("plugin-{}", plugin_id)) {
                    let _ = window.close();
                }
            }
            Ok("null".to_string())
        }
        _ => {
            log::warn!("插件 {} 调用了未实现的 API: {}", plugin_id, method);
            Err(format!("API 未实现: {}", method))
        }
    }
}

// ── 屏幕取色（直接按坐标取像素，不截全屏） ──

/// 按屏幕坐标取单点颜色，返回 "#RRGGBB"
#[tauri::command]
pub async fn plugin_get_pixel_at(x: i32, y: i32) -> Result<String, String> {
    get_pixel_at_screen(x, y)
}

#[cfg(target_os = "macos")]
fn get_pixel_at_screen(sx: i32, sy: i32) -> Result<String, String> {
    let path = std::env::temp_dir().join("mtools_pixel.png");
    let status = std::process::Command::new("screencapture")
        .args(["-x", "-R", &format!("{},{},1,1", sx, sy), path.to_str().unwrap()])
        .status()
        .map_err(|e| format!("screencapture 失败: {}", e))?;
    if !status.success() {
        return Err("截取像素失败，请检查屏幕录制权限".to_string());
    }
    let buf = std::fs::read(&path).map_err(|e| e.to_string())?;
    let img = image::load_from_memory(&buf).map_err(|e| e.to_string())?;
    let rgb = img.to_rgb8();
    let p = rgb.get_pixel(0, 0);
    let (r, g, b) = (p[0], p[1], p[2]);
    let _ = std::fs::remove_file(&path);
    Ok(format!("#{:02X}{:02X}{:02X}", r, g, b))
}

#[cfg(target_os = "windows")]
fn get_pixel_at_screen(sx: i32, sy: i32) -> Result<String, String> {
    use windows::Win32::Foundation::COLORREF;
    use windows::Win32::Graphics::Gdi::{GetDC, GetPixel, ReleaseDC, SRCCOPY};
    use windows::Win32::UI::WindowsAndMessaging::GetDesktopWindow;
    unsafe {
        let hwnd = GetDesktopWindow();
        let hdc = GetDC(hwnd).map_err(|e| format!("GetDC 失败: {}", e))?;
        let color = GetPixel(hdc, sx, sy);
        let _ = ReleaseDC(hwnd, hdc);
        if color.0 == 0xFFFFFFFF {
            return Err("GetPixel 无效".to_string());
        }
        let r = (color.0 & 0xFF) as u8;
        let g = ((color.0 >> 8) & 0xFF) as u8;
        let b = ((color.0 >> 16) & 0xFF) as u8;
        Ok(format!("#{:02X}{:02X}{:02X}", r, g, b))
    }
}

#[cfg(target_os = "linux")]
fn get_pixel_at_screen(_x: i32, _y: i32) -> Result<String, String> {
    Err("Linux 暂不支持直接取色，请使用截图模式".to_string())
}

/// 启动屏幕取色 — 直接取色，不截屏；取到色值后由后端写入剪贴板（避免前端 clipboard 权限问题）
/// macOS: 调用系统 NSColorSampler（自带放大镜，无需屏幕录制权限）
/// Windows: 前端用 EyeDropper API
#[tauri::command]
pub async fn plugin_start_color_picker(app: AppHandle) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let hex = macos_native_color_pick().await?;
        if !hex.is_empty() {
            use tauri_plugin_clipboard_manager::ClipboardExt;
            let _ = app.clipboard().write_text(hex.clone());
        }
        return Ok(hex);
    }

    #[cfg(target_os = "windows")]
    {
        let _ = app;
        return Err("Windows 请使用 EyeDropper 取色".to_string());
    }

    #[cfg(target_os = "linux")]
    {
        let _ = app;
        return Err("Linux 暂不支持直接取色".to_string());
    }
}

/// macOS: 编译并运行 NSColorSampler 小程序，直接取色（不截屏）
#[cfg(target_os = "macos")]
async fn macos_native_color_pick() -> Result<String, String> {
    let cache_dir = std::env::temp_dir();
    let binary_path = cache_dir.join("mtools_color_sampler");
    let source_path = cache_dir.join("mtools_color_sampler.m");

    if !binary_path.exists() {
        let objc_code = include_str!("picker_macos.m");
        std::fs::write(&source_path, objc_code)
            .map_err(|e| format!("写入源文件失败: {}", e))?;

        let compile = tokio::process::Command::new("/usr/bin/clang")
            .args([
                "-framework", "Cocoa",
                "-o", binary_path.to_str().unwrap(),
                source_path.to_str().unwrap(),
            ])
            .output()
            .await
            .map_err(|e| format!("clang 编译失败: {}", e))?;

        let _ = std::fs::remove_file(&source_path);

        if !compile.status.success() {
            let _ = std::fs::remove_file(&binary_path);
            let msg = format!("编译取色程序失败: {}",
                String::from_utf8_lossy(&compile.stderr).trim());
            log::error!("{}", msg);
            return Err(msg);
        }
    }

    let output = tokio::process::Command::new(binary_path.to_str().unwrap())
        .output()
        .await
        .map_err(|e| {
            let msg = format!("启动取色器失败: {}", e);
            log::error!("{}", msg);
            msg
        })?;

    let hex = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if hex.starts_with('#') && hex.len() == 7 {
        Ok(hex)
    } else if hex.is_empty() {
        Ok(String::new())
    } else {
        let msg = format!(
            "取色返回异常 stdout={:?} stderr={}",
            hex,
            if stderr.is_empty() { "(空)" } else { stderr.as_str() }
        );
        log::error!("{}", msg);
        Err(msg)
    }
}



// ── 工具函数 ──

/// 在 HTML 的 <head> 标签后注入 <base> 标签，使相对路径资源指向插件目录
fn inject_base_tag(html: &str, base_url: &str) -> String {
    let base_tag = format!("<base href=\"{}\">", base_url);
    let lower = html.to_lowercase();
    if let Some(pos) = lower.find("<head>") {
        let insert_pos = pos + 6;
        format!(
            "{}{}{}",
            &html[..insert_pos],
            base_tag,
            &html[insert_pos..]
        )
    } else if let Some(pos) = lower.find("<html>") {
        let insert_pos = pos + 6;
        format!(
            "{}<head>{}</head>{}",
            &html[..insert_pos],
            base_tag,
            &html[insert_pos..]
        )
    } else {
        format!("<head>{}</head>{}", base_tag, html)
    }
}


// ── utools API Shim 生成 (Rust 侧) ──

fn generate_utools_shim(plugin_id: &str) -> String {
    format!(r#"
(function() {{
  'use strict';
  const __pluginId = '{plugin_id}';
  let __callId = 0;

  function __invoke(method, args) {{
    return new Promise((resolve, reject) => {{
      if (!window.__TAURI__ || !window.__TAURI__.core) {{
        console.warn('[mTools] Tauri IPC 不可用, 方法:', method);
        reject(new Error('Tauri IPC not available'));
        return;
      }}
      const id = ++__callId;
      window.__TAURI__.core.invoke('plugin_api_call', {{
        pluginId: __pluginId,
        method: method,
        args: JSON.stringify(args || {{}}),
        callId: id,
      }}).then(result => {{
        resolve(JSON.parse(result || 'null'));
      }}).catch(err => {{
        reject(err);
      }});
    }});
  }}

  const utools = {{
    hideMainWindow() {{ __invoke('hideMainWindow'); }},
    showMainWindow() {{ __invoke('showMainWindow'); }},
    setExpendHeight(height) {{ __invoke('setExpendHeight', {{ height }}); }},
    setSubInput(onChange, placeholder, isFocus) {{
      window.__utoolsSubInputCallback = onChange;
      __invoke('setSubInput', {{ placeholder, isFocus }});
    }},
    removeSubInput() {{
      window.__utoolsSubInputCallback = null;
      __invoke('removeSubInput');
    }},
    copyText(text) {{ return __invoke('copyText', {{ text }}); }},
    copyImage(base64) {{ return __invoke('copyImage', {{ base64 }}); }},
    getCopyedFiles() {{ return []; }},
    dbStorage: {{
      setItem(key, value) {{ return __invoke('dbStorage.setItem', {{ key, value }}); }},
      getItem(key) {{ return __invoke('dbStorage.getItem', {{ key }}); }},
      removeItem(key) {{ return __invoke('dbStorage.removeItem', {{ key }}); }},
    }},
    getPath(name) {{ return __invoke('getPath', {{ name }}); }},
    showNotification(body, clickFeatureCode) {{ __invoke('showNotification', {{ body, clickFeatureCode }}); }},
    shellOpenExternal(url) {{ __invoke('shellOpenExternal', {{ url }}); }},
    shellOpenPath(path) {{ __invoke('shellOpenPath', {{ path }}); }},
    shellShowItemInFolder(path) {{ __invoke('shellShowItemInFolder', {{ path }}); }},
    screenCapture(callback) {{ console.warn('[mTools] screenCapture 暂未实现'); callback && callback(null); }},
    screenColorPick(callback) {{
      if (!window.__TAURI__ || !window.__TAURI__.core) {{
        console.error('[mTools] Tauri IPC 不可用，无法取色');
        callback && callback(null);
        return;
      }}
      window.__TAURI__.core.invoke('plugin_start_color_picker').then(function(hex) {{
        callback && callback(hex || null);
      }}).catch(function(err) {{
        console.error('[mTools] 取色失败:', err);
        callback && callback(null);
      }});
    }},
    getUser() {{ return {{ avatar: '', nickname: '本地用户', type: 'member' }}; }},
    getAppVersion() {{ return '0.1.0'; }},
    isDarkColors() {{ return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }},
    isMacOS() {{ return navigator.platform.toLowerCase().includes('mac'); }},
    isWindows() {{ return navigator.platform.toLowerCase().includes('win'); }},
    isLinux() {{ return navigator.platform.toLowerCase().includes('linux'); }},
    onPluginReady(callback) {{ if (callback) setTimeout(callback, 0); }},
    onPluginEnter(callback) {{ window.__utoolsOnEnterCallback = callback; }},
    onPluginOut(callback) {{ window.__utoolsOnOutCallback = callback; }},
    redirect(label, payload) {{ __invoke('redirect', {{ label, payload }}); }},
    outPlugin() {{ __invoke('outPlugin'); }},
  }};

  window.utools = utools;
  window.rubick = utools;
  console.log('[mTools] utools API shim 已注入, pluginId:', __pluginId);
}})();
"#, plugin_id = plugin_id)
}

/// 获取用于 iframe 嵌入的插件 HTML（带 postMessage 桥，无新窗口）
#[tauri::command]
pub async fn plugin_get_embed_html(
    app: AppHandle,
    plugin_id: String,
    feature_code: String,
) -> Result<String, String> {
    let plugins = get_cached_plugins(&app);
    let plugin = plugins
        .iter()
        .find(|p| p.id == plugin_id)
        .ok_or_else(|| format!("插件 {} 不存在", plugin_id))?;
    if !plugin.enabled {
        return Err(format!("插件 {} 已被禁用", plugin_id));
    }
    let _feature = plugin
        .manifest
        .features
        .iter()
        .find(|f| f.code == feature_code)
        .ok_or_else(|| format!("功能 {} 不存在", feature_code))?;

    let main_file = plugin
        .manifest
        .main
        .as_deref()
        .ok_or("插件缺少 main 入口")?;
    let main_path = PathBuf::from(&plugin.dir_path).join(main_file);
    if !main_path.exists() {
        return Err(format!("插件入口文件不存在: {}", main_path.display()));
    }
    let html_content = std::fs::read_to_string(&main_path)
        .map_err(|e| format!("读取插件文件失败: {}", e))?;

    let base_url = format!(
        "mtplugin://localhost{}/",
        plugin.dir_path.replace('\\', "/")
    );
    let html_with_base = inject_base_tag(&html_content, &base_url);
    let bridge = generate_embed_bridge(&plugin_id);
    let html_with_bridge = inject_embed_bridge(&html_with_base, &bridge);
    Ok(html_with_bridge)
}

/// 在 <head> 开头注入 iframe 用 postMessage 桥脚本
fn inject_embed_bridge(html: &str, bridge_script: &str) -> String {
    let script_tag = format!("<script>{}</script>", bridge_script);
    let lower = html.to_lowercase();
    if let Some(pos) = lower.find("<head>") {
        let insert_pos = pos + 6;
        format!("{}{}{}", &html[..insert_pos], script_tag, &html[insert_pos..])
    } else if let Some(pos) = lower.find("<html>") {
        let insert_pos = pos + 6;
        format!("{}<head>{}</head>{}", &html[..insert_pos], script_tag, &html[insert_pos..])
    } else {
        format!("<head>{}</head>{}", script_tag, html)
    }
}

/// 转义 plugin_id 用于注入到 JS 字符串，避免破坏脚本
fn escape_js_string(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('\'', "\\'")
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
}

/// iframe 内使用的 __TAURI__ 桥：通过 postMessage 让父窗口代为 invoke
fn generate_embed_bridge(plugin_id: &str) -> String {
    let plugin_id_esc = escape_js_string(plugin_id);
    format!(r#"
(function(){{
  var __pluginId = '{plugin_id_esc}';
  var __invokeId = 0;
  function __invoke(cmd, args) {{
    return new Promise(function(resolve, reject) {{
      var id = 'inv-' + (++__invokeId);
      var done = false;
      function onResp(e) {{
        if (e.data && e.data.type === 'mtools-embed-result' && e.data.id === id) {{
          done = true;
          window.removeEventListener('message', onResp);
          if (e.data.error) reject(new Error(e.data.error)); else resolve(e.data.result);
        }}
      }}
      window.addEventListener('message', onResp);
      try {{
        window.parent.postMessage({{ type: 'mtools-embed-invoke', id: id, cmd: cmd, args: args || {{}} }}, '*');
      }} catch (err) {{
        if (!done) {{ window.removeEventListener('message', onResp); reject(err); }}
      }}
      setTimeout(function() {{
        if (!done) {{ done = true; window.removeEventListener('message', onResp); reject(new Error('embed invoke timeout')); }}
      }}, 30000);
    }});
  }}
  window.__TAURI__ = {{
    core: {{ invoke: __invoke }},
    event: {{ listen: function(name, cb) {{ return __invoke('event-listen', {{ name: name }}).then(function() {{ return function() {{}}; }}); }} }}
  }};
  var __callId = 0;
  function __apiInvoke(method, args) {{
    return __invoke('plugin_api_call', {{ pluginId: __pluginId, method: method, args: JSON.stringify(args || {{}}), callId: ++__callId }}).then(function(r) {{ return JSON.parse(r || 'null'); }});
  }}
  window.utools = window.rubick = {{
    hideMainWindow: function() {{ return __apiInvoke('hideMainWindow'); }},
    showMainWindow: function() {{ return __apiInvoke('showMainWindow'); }},
    setExpendHeight: function(o) {{ return __apiInvoke('setExpendHeight', o); }},
    setSubInput: function(onChange, p, f) {{ window.__utoolsSubInputCallback = onChange; return __apiInvoke('setSubInput', {{ placeholder: p, isFocus: f }}); }},
    removeSubInput: function() {{ window.__utoolsSubInputCallback = null; return __apiInvoke('removeSubInput'); }},
    copyText: function(t) {{ return __apiInvoke('copyText', {{ text: t }}); }},
    copyImage: function(b) {{ return __apiInvoke('copyImage', {{ base64: b }}); }},
    getCopyedFiles: function() {{ return []; }},
    dbStorage: {{ setItem: function(k,v) {{ return __apiInvoke('dbStorage.setItem', {{ key: k, value: v }}); }}, getItem: function(k) {{ return __apiInvoke('dbStorage.getItem', {{ key: k }}); }}, removeItem: function(k) {{ return __apiInvoke('dbStorage.removeItem', {{ key: k }}); }} }},
    getPath: function(n) {{ return __apiInvoke('getPath', {{ name: n }}); }},
    showNotification: function(b,c) {{ return __apiInvoke('showNotification', {{ body: b, clickFeatureCode: c }}); }},
    shellOpenExternal: function(u) {{ return __apiInvoke('shellOpenExternal', {{ url: u }}); }},
    shellOpenPath: function(p) {{ return __apiInvoke('shellOpenPath', {{ path: p }}); }},
    shellShowItemInFolder: function(p) {{ return __apiInvoke('shellShowItemInFolder', {{ path: p }}); }},
    screenCapture: function(cb) {{ if (cb) cb(null); }},
    screenColorPick: function(cb) {{ __invoke('plugin_start_color_picker').then(function(hex) {{ if (cb) cb(hex || null); }}).catch(function() {{ if (cb) cb(null); }}); }},
    getUser: function() {{ return {{ avatar: '', nickname: '本地用户', type: 'member' }}; }},
    getAppVersion: function() {{ return '0.1.0'; }},
    isDarkColors: function() {{ return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }},
    isMacOS: function() {{ return /mac/i.test(navigator.platform); }},
    isWindows: function() {{ return /win/i.test(navigator.platform); }},
    isLinux: function() {{ return /linux/i.test(navigator.platform); }},
    onPluginReady: function(cb) {{ if (cb) setTimeout(cb, 0); }},
    onPluginEnter: function(cb) {{ window.__utoolsOnEnterCallback = cb; }},
    onPluginOut: function(cb) {{ window.__utoolsOnOutCallback = cb; }},
    redirect: function(l, p) {{ return __apiInvoke('redirect', {{ label: l, payload: p }}); }},
    outPlugin: function() {{ return __apiInvoke('outPlugin'); }}
  }};
}})();
"#, plugin_id_esc = plugin_id_esc)
}

fn generate_plugin_enter_script(code: &str, cmd_type: &str, payload: Option<&str>) -> String {
    let payload_js = match payload {
        Some(p) => format!("'{}'", p.replace('\'', "\\'")),
        None => "undefined".to_string(),
    };
    format!(r#"
(function() {{
  // 延迟触发，确保插件 onPluginEnter 已注册
  setTimeout(function() {{
    if (window.__utoolsOnEnterCallback) {{
      window.__utoolsOnEnterCallback({{
        code: '{code}',
        type: '{cmd_type}',
        payload: {payload_js},
      }});
    }}
  }}, 100);
}})();
"#, code = code, cmd_type = cmd_type, payload_js = payload_js)
}
