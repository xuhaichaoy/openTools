mod protocol;
mod screenshot;
mod stitcher;
mod export;
mod recorder;

use protocol::*;
use serde_json::Value;
use std::io::{self, BufRead, Write};
use std::sync::mpsc;

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .init();

    log::info!("screen-capture-helper v{} 启动", env!("CARGO_PKG_VERSION"));

    // 事件通道: 后台线程 (录制等) 发送事件 → 主线程输出到 stdout
    let (event_tx, event_rx) = mpsc::channel::<String>();

    let stdin = io::stdin();
    let stdout = io::stdout();

    // 启动事件推送线程
    let stdout_lock = std::sync::Arc::new(std::sync::Mutex::new(stdout));
    let out_for_events = stdout_lock.clone();
    std::thread::spawn(move || {
        for event_line in event_rx {
            let mut out = out_for_events.lock().unwrap();
            let _ = writeln!(out, "{}", event_line);
            let _ = out.flush();
        }
    });

    // 主循环: 读取 stdin JSON-RPC 请求
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l.trim().to_string(),
            Err(_) => break,
        };
        if line.is_empty() {
            continue;
        }

        let request: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let resp = Response::err(0, format!("JSON 解析失败: {e}"));
                let mut out = stdout_lock.lock().unwrap();
                let _ = writeln!(out, "{}", serde_json::to_string(&resp).unwrap());
                let _ = out.flush();
                continue;
            }
        };

        let response = handle_request(request, &event_tx);
        let mut out = stdout_lock.lock().unwrap();
        let _ = writeln!(out, "{}", serde_json::to_string(&response).unwrap());
        let _ = out.flush();
    }

    log::info!("screen-capture-helper 退出");
}

fn handle_request(req: Request, event_tx: &mpsc::Sender<String>) -> Response {
    let id = req.id;
    match req.method.as_str() {
        // ===== 查询 =====
        "ping" => {
            Response::ok(id, serde_json::json!({
                "version": env!("CARGO_PKG_VERSION"),
                "status": "ok"
            }))
        }

        "list_monitors" => {
            match screenshot::list_monitors() {
                Ok(monitors) => Response::ok(id, serde_json::to_value(&monitors).unwrap()),
                Err(e) => Response::err(id, e),
            }
        }

        "list_windows" => {
            match screenshot::list_windows() {
                Ok(windows) => Response::ok(id, serde_json::to_value(&windows).unwrap()),
                Err(e) => Response::err(id, e),
            }
        }

        // ===== 截图 =====
        "capture_fullscreen" => {
            let params: CaptureFullscreenParams = match serde_json::from_value(req.params) {
                Ok(p) => p,
                Err(e) => return Response::err(id, format!("参数错误: {e}")),
            };
            match screenshot::capture_fullscreen(params.monitor_id) {
                Ok(path) => Response::ok(id, serde_json::json!({ "path": path })),
                Err(e) => Response::err(id, e),
            }
        }

        "capture_window" => {
            let window_id: u64 = match serde_json::from_value(req.params.get("window_id").cloned().unwrap_or_default()) {
                Ok(v) => v,
                Err(e) => return Response::err(id, format!("参数错误: {e}")),
            };
            match screenshot::capture_window(window_id) {
                Ok(path) => Response::ok(id, serde_json::json!({ "path": path })),
                Err(e) => Response::err(id, e),
            }
        }

        "crop_region" => {
            let params: CropRegionParams = match serde_json::from_value(req.params) {
                Ok(p) => p,
                Err(e) => return Response::err(id, format!("参数错误: {e}")),
            };
            match screenshot::crop_region(params) {
                Ok(path) => Response::ok(id, serde_json::json!({ "path": path })),
                Err(e) => Response::err(id, e),
            }
        }

        // ===== 滚动长截图 =====
        "scroll_capture" => {
            let params: ScrollCaptureParams = match serde_json::from_value(req.params) {
                Ok(p) => p,
                Err(e) => return Response::err(id, format!("参数错误: {e}")),
            };
            match do_scroll_capture(params, event_tx) {
                Ok(path) => Response::ok(id, serde_json::json!({ "path": path })),
                Err(e) => Response::err(id, e),
            }
        }

        // ===== 保存/导出 =====
        "save" => {
            let params: SaveParams = match serde_json::from_value(req.params) {
                Ok(p) => p,
                Err(e) => return Response::err(id, format!("参数错误: {e}")),
            };
            match export::save_image(
                &params.source_path,
                &params.target_path,
                &params.format,
                params.quality,
                params.pdf_mode.as_deref(),
            ) {
                Ok(()) => Response::ok(id, serde_json::json!({ "path": params.target_path })),
                Err(e) => Response::err(id, e),
            }
        }

        // ===== 录制 =====
        "recorder_start" => {
            let params: RecorderStartParams = match serde_json::from_value(req.params) {
                Ok(p) => p,
                Err(e) => return Response::err(id, format!("参数错误: {e}")),
            };

            let output = params.output_path.clone().unwrap_or_else(|| {
                let ext = if params.format == "gif" { "gif" } else { "mp4" };
                let ts = chrono_timestamp();
                format!("{}/mtools-recording-{}.{}", std::env::temp_dir().display(), ts, ext)
            });

            let monitor_id = match &params.target {
                RecordTarget::FullScreen { monitor_id } => *monitor_id,
                _ => None,
            };

            let result = match params.format.as_str() {
                "gif" => recorder::start_gif_recording(
                    monitor_id,
                    &output,
                    params.fps.unwrap_or(10),
                    params.max_width,
                    event_tx,
                ),
                "mp4" => {
                    // 查找 ffmpeg
                    let ffmpeg = find_ffmpeg();
                    match ffmpeg {
                        Some(path) => recorder::start_mp4_recording(
                            monitor_id,
                            &output,
                            params.fps.unwrap_or(30),
                            &path,
                            event_tx,
                        ),
                        None => Err("未找到 ffmpeg，请先下载".to_string()),
                    }
                }
                other => Err(format!("不支持的录制格式: {}", other)),
            };

            match result {
                Ok(()) => Response::ok(id, serde_json::json!({ "output_path": output })),
                Err(e) => Response::err(id, e),
            }
        }

        "recorder_pause" => {
            match recorder::pause_recording() {
                Ok(paused) => Response::ok(id, serde_json::json!({ "is_paused": paused })),
                Err(e) => Response::err(id, e),
            }
        }

        "recorder_stop" => {
            match recorder::stop_recording() {
                Ok(()) => Response::ok(id, serde_json::json!({ "status": "stopping" })),
                Err(e) => Response::err(id, e),
            }
        }

        "recorder_status" => {
            Response::ok(id, recorder::get_recorder_status())
        }

        _ => Response::err(id, format!("未知方法: {}", req.method)),
    }
}

/// 执行滚动长截图
fn do_scroll_capture(
    params: ScrollCaptureParams,
    event_tx: &mpsc::Sender<String>,
) -> Result<String, String> {
    use xcap::Window;

    // 查找目标窗口
    let windows = Window::all().map_err(|e| format!("枚举窗口失败: {e}"))?;
    let window = if let Some(wid) = params.window_id {
        windows.into_iter()
            .find(|w| w.id() as u64 == wid)
            .ok_or_else(|| format!("窗口 {} 不存在", wid))?
    } else if let Some(title) = &params.window_title {
        windows.into_iter()
            .find(|w| w.title().unwrap_or_default().contains(title.as_str()))
            .ok_or_else(|| format!("未找到标题包含 '{}' 的窗口", title))?
    } else {
        return Err("需要 window_id 或 window_title".to_string());
    };

    let max_scrolls = params.max_scrolls.unwrap_or(50);
    let scroll_delay = std::time::Duration::from_millis(params.scroll_delay_ms.unwrap_or(400));

    let mut stitch = stitcher::Stitcher::new();

    // 初始截取
    let first_frame = window.capture_image()
        .map_err(|e| format!("截取窗口失败: {e}"))?;
    stitch.push_frame(first_frame);

    // 初始化 enigo 用于滚动模拟
    let mut enigo = enigo::Enigo::new(&enigo::Settings::default())
        .map_err(|e| format!("初始化输入模拟失败: {e}"))?;

    for i in 0..max_scrolls {
        // 发送进度
        let _ = event_tx.send(serde_json::json!({
            "id": null,
            "event": "scroll_progress",
            "data": { "current": i + 1, "max": max_scrolls }
        }).to_string());

        // 模拟滚动 (向下滚动 5 个单位)
        use enigo::{Enigo, Mouse, Axis, Direction};
        enigo.scroll(5, Axis::Vertical)
            .map_err(|e| format!("滚动失败: {e}"))?;

        // 等待渲染
        std::thread::sleep(scroll_delay);

        // 截取新帧
        let frame = window.capture_image()
            .map_err(|e| format!("截取窗口失败: {e}"))?;
        stitch.push_frame(frame);

        // 检查是否到底部
        if stitch.is_at_bottom() {
            log::info!("检测到已到底部，共 {} 帧", stitch.frame_count());
            break;
        }
    }

    // 拼接
    let result = stitch.stitch()?;

    // 保存到临时文件
    let tmp = tempfile::Builder::new()
        .prefix("mtools-longshot-")
        .suffix(".png")
        .tempfile()
        .map_err(|e| format!("创建临时文件失败: {e}"))?;
    let path = tmp.path().to_string_lossy().to_string();
    tmp.keep().map_err(|e| format!("保持临时文件失败: {e}"))?;

    result.save(&path).map_err(|e| format!("保存长截图失败: {e}"))?;
    Ok(path)
}

/// 查找 ffmpeg 二进制
fn find_ffmpeg() -> Option<String> {
    // 1. 检查同目录下
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidates = if cfg!(windows) {
        vec![exe_dir.join("ffmpeg.exe")]
    } else {
        vec![exe_dir.join("ffmpeg")]
    };

    for c in &candidates {
        if c.exists() {
            return Some(c.to_string_lossy().to_string());
        }
    }

    // 2. 检查 PATH
    if let Ok(output) = std::process::Command::new("which").arg("ffmpeg").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path);
            }
        }
    }

    // Windows: where ffmpeg
    #[cfg(windows)]
    if let Ok(output) = std::process::Command::new("where").arg("ffmpeg").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if let Some(first) = path.lines().next() {
                return Some(first.to_string());
            }
        }
    }

    None
}

fn chrono_timestamp() -> String {
    use std::time::SystemTime;
    let d = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", d.as_secs())
}
