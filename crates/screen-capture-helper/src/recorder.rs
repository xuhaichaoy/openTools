use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use xcap::Monitor;

/// 录制状态
pub struct RecorderState {
    pub is_recording: bool,
    pub is_paused: bool,
    pub start_time: Option<Instant>,
    pub frame_count: u64,
    pub output_path: String,
    pub format: String,
    pub fps: u32,
    stop_flag: Arc<AtomicBool>,
    pause_flag: Arc<AtomicBool>,
}

impl RecorderState {
    pub fn new() -> Self {
        Self {
            is_recording: false,
            is_paused: false,
            start_time: None,
            frame_count: 0,
            output_path: String::new(),
            format: String::new(),
            fps: 30,
            stop_flag: Arc::new(AtomicBool::new(false)),
            pause_flag: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn duration_secs(&self) -> f64 {
        self.start_time
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0)
    }
}

/// 全局录制状态
pub static RECORDER: std::sync::LazyLock<Mutex<RecorderState>> =
    std::sync::LazyLock::new(|| Mutex::new(RecorderState::new()));

/// 启动 GIF 录制
pub fn start_gif_recording(
    monitor_id: Option<u32>,
    output_path: &str,
    fps: u32,
    max_width: Option<u32>,
    event_sender: &std::sync::mpsc::Sender<String>,
) -> Result<(), String> {
    let monitors = Monitor::all().map_err(|e| format!("枚举显示器失败: {e}"))?;
    let monitor_index = if let Some(id) = monitor_id {
        let i = id as usize;
        if i >= monitors.len() {
            return Err(format!("显示器 {} 不存在", id));
        }
        i
    } else {
        monitors.iter()
            .position(|m| m.is_primary().unwrap_or(false))
            .or(Some(0))
            .unwrap_or(0)
    };

    let fps = fps.max(1).min(30);
    let frame_interval = Duration::from_millis(1000 / fps as u64);
    let max_w = max_width.unwrap_or(640);
    let output = output_path.to_string();
    let sender = event_sender.clone();

    // 设置录制状态
    {
        let mut state = RECORDER.lock().unwrap();
        state.is_recording = true;
        state.is_paused = false;
        state.start_time = Some(Instant::now());
        state.frame_count = 0;
        state.output_path = output.clone();
        state.format = "gif".to_string();
        state.fps = fps;
        state.stop_flag.store(false, Ordering::SeqCst);
        state.pause_flag.store(false, Ordering::SeqCst);
    }

    let stop_flag = RECORDER.lock().unwrap().stop_flag.clone();
    let pause_flag = RECORDER.lock().unwrap().pause_flag.clone();

    // 在新线程中录制（在线程内按索引取 Monitor，避免把非 Send 的 HMONITOR 跨线程）
    std::thread::spawn(move || {
        let monitors = match Monitor::all() {
            Ok(m) => m,
            Err(e) => {
                let _ = sender.send(serde_json::json!({
                    "id": null, "event": "recorder_error",
                    "data": { "error": format!("枚举显示器失败: {e}") }
                }).to_string());
                return;
            }
        };
        let monitor = match monitors.get(monitor_index) {
            Some(m) => m.clone(),
            None => {
                let _ = sender.send(serde_json::json!({
                    "id": null, "event": "recorder_error",
                    "data": { "error": "显示器不存在" }
                }).to_string());
                return;
            }
        };

        let mut frames: Vec<(Vec<u8>, u32, u32, u16)> = Vec::new(); // (rgba, w, h, delay)
        let mut last_capture = Instant::now();

        loop {
            if stop_flag.load(Ordering::SeqCst) {
                break;
            }

            if pause_flag.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }

            // 等待下一帧
            let elapsed = last_capture.elapsed();
            if elapsed < frame_interval {
                std::thread::sleep(frame_interval - elapsed);
            }
            last_capture = Instant::now();

            // 截取一帧
            match monitor.capture_image() {
                Ok(img) => {
                    // 缩放到 max_width
                    let w = img.width();
                    let h = img.height();
                    let (tw, th) = if w > max_w {
                        let scale = max_w as f32 / w as f32;
                        (max_w, (h as f32 * scale) as u32)
                    } else {
                        (w, h)
                    };
                    let resized = ::image::imageops::resize(
                        &img, tw, th,
                        ::image::imageops::FilterType::Nearest,
                    );
                    let delay = (frame_interval.as_millis() / 10) as u16; // GIF delay 单位是 10ms
                    frames.push((resized.into_raw(), tw, th, delay));

                    let frame_count = frames.len() as u64;
                    {
                        let mut state = RECORDER.lock().unwrap();
                        state.frame_count = frame_count;
                    }

                    // 发送进度事件
                    let _ = sender.send(serde_json::json!({
                        "id": null,
                        "event": "recorder_status",
                        "data": {
                            "frame_count": frame_count,
                            "duration_secs": RECORDER.lock().unwrap().duration_secs(),
                        }
                    }).to_string());
                }
                Err(e) => {
                    log::warn!("截帧失败: {e}");
                }
            }
        }

        // 编码 GIF
        let _ = sender.send(serde_json::json!({
            "id": null,
            "event": "recorder_encoding",
            "data": { "total_frames": frames.len() }
        }).to_string());

        if let Some((_, w, h, _)) = frames.first() {
            let file = std::fs::File::create(&output).unwrap();
            let mut encoder = gif::Encoder::new(file, *w as u16, *h as u16, &[]).unwrap();
            encoder.set_repeat(gif::Repeat::Infinite).unwrap();

            for (rgba_data, fw, fh, delay) in &frames {
                // RGBA → RGB 用于 gif crate
                let mut rgb: Vec<u8> = Vec::with_capacity((fw * fh * 3) as usize);
                for chunk in rgba_data.chunks(4) {
                    rgb.push(chunk[0]);
                    rgb.push(chunk[1]);
                    rgb.push(chunk[2]);
                }

                let mut frame = gif::Frame::from_rgb(*fw as u16, *fh as u16, &rgb);
                frame.delay = *delay;
                let _ = encoder.write_frame(&frame);
            }
        }

        // 完成
        {
            let mut state = RECORDER.lock().unwrap();
            state.is_recording = false;
        }

        let _ = sender.send(serde_json::json!({
            "id": null,
            "event": "recorder_done",
            "data": { "output_path": output, "frame_count": frames.len() }
        }).to_string());
    });

    Ok(())
}

/// 启动 MP4 录制 (需要 ffmpeg)
pub fn start_mp4_recording(
    monitor_id: Option<u32>,
    output_path: &str,
    fps: u32,
    ffmpeg_path: &str,
    event_sender: &std::sync::mpsc::Sender<String>,
) -> Result<(), String> {
    let monitors = Monitor::all().map_err(|e| format!("枚举显示器失败: {e}"))?;
    let monitor_index = if let Some(id) = monitor_id {
        let i = id as usize;
        if i >= monitors.len() {
            return Err(format!("显示器 {} 不存在", id));
        }
        i
    } else {
        monitors.iter()
            .position(|m| m.is_primary().unwrap_or(false))
            .or(Some(0))
            .unwrap_or(0)
    };

    let monitor_ref = monitors.get(monitor_index).unwrap();
    let cap_w = monitor_ref.width().unwrap_or(1920);
    let cap_h = monitor_ref.height().unwrap_or(1080);
    let enc_w = cap_w & !1;
    let enc_h = cap_h & !1;

    let fps = fps.max(1).min(60);
    let frame_interval = Duration::from_millis(1000 / fps as u64);
    let output = output_path.to_string();
    let ffmpeg = ffmpeg_path.to_string();
    let sender = event_sender.clone();

    // 设置录制状态
    {
        let mut state = RECORDER.lock().unwrap();
        state.is_recording = true;
        state.is_paused = false;
        state.start_time = Some(Instant::now());
        state.frame_count = 0;
        state.output_path = output.clone();
        state.format = "mp4".to_string();
        state.fps = fps;
        state.stop_flag.store(false, Ordering::SeqCst);
        state.pause_flag.store(false, Ordering::SeqCst);
    }

    let stop_flag = RECORDER.lock().unwrap().stop_flag.clone();
    let pause_flag = RECORDER.lock().unwrap().pause_flag.clone();

    std::thread::spawn(move || {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let monitors = match Monitor::all() {
            Ok(m) => m,
            Err(e) => {
                let _ = sender.send(serde_json::json!({
                    "id": null, "event": "recorder_error",
                    "data": { "error": format!("枚举显示器失败: {e}") }
                }).to_string());
                return;
            }
        };
        let monitor = match monitors.get(monitor_index) {
            Some(m) => m.clone(),
            None => {
                let _ = sender.send(serde_json::json!({
                    "id": null, "event": "recorder_error",
                    "data": { "error": "显示器不存在" }
                }).to_string());
                return;
            }
        };

        // 启动 ffmpeg 进程
        let mut child = match Command::new(&ffmpeg)
            .args([
                "-f", "rawvideo",
                "-pix_fmt", "rgb24",
                "-s", &format!("{}x{}", enc_w, enc_h),
                "-r", &fps.to_string(),
                "-i", "pipe:0",
                "-c:v", "libx264",
                "-preset", "fast",
                "-crf", "23",
                "-pix_fmt", "yuv420p",
                "-y",
                &output,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let _ = sender.send(serde_json::json!({
                    "id": null, "event": "recorder_error",
                    "data": { "error": format!("启动 ffmpeg 失败: {e}") }
                }).to_string());
                let mut state = RECORDER.lock().unwrap();
                state.is_recording = false;
                return;
            }
        };

        let mut stdin = child.stdin.take().unwrap();
        let mut frame_count: u64 = 0;
        let mut last_capture = Instant::now();

        loop {
            if stop_flag.load(Ordering::SeqCst) {
                break;
            }

            if pause_flag.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }

            let elapsed = last_capture.elapsed();
            if elapsed < frame_interval {
                std::thread::sleep(frame_interval - elapsed);
            }
            last_capture = Instant::now();

            match monitor.capture_image() {
                Ok(img) => {
                    // RGBA → RGB, 裁剪到偶数尺寸
                    let iw = img.width();
                    let ih = img.height();
                    let cropped = if iw != enc_w || ih != enc_h {
                        ::image::imageops::crop_imm(&img, 0, 0, enc_w, enc_h).to_image()
                    } else {
                        img
                    };

                    let rgb: Vec<u8> = cropped.pixels()
                        .flat_map(|p| [p[0], p[1], p[2]])
                        .collect();

                    if stdin.write_all(&rgb).is_err() {
                        break;
                    }

                    frame_count += 1;
                    {
                        let mut state = RECORDER.lock().unwrap();
                        state.frame_count = frame_count;
                    }

                    if frame_count % 30 == 0 {
                        let _ = sender.send(serde_json::json!({
                            "id": null, "event": "recorder_status",
                            "data": {
                                "frame_count": frame_count,
                                "duration_secs": RECORDER.lock().unwrap().duration_secs(),
                            }
                        }).to_string());
                    }
                }
                Err(e) => {
                    log::warn!("截帧失败: {e}");
                }
            }
        }

        // 关闭 stdin，等 ffmpeg 完成编码
        drop(stdin);
        let _ = child.wait();

        {
            let mut state = RECORDER.lock().unwrap();
            state.is_recording = false;
        }

        let _ = sender.send(serde_json::json!({
            "id": null, "event": "recorder_done",
            "data": { "output_path": output, "frame_count": frame_count }
        }).to_string());
    });

    Ok(())
}

/// 暂停/恢复录制
pub fn pause_recording() -> Result<bool, String> {
    let mut state = RECORDER.lock().unwrap();
    if !state.is_recording {
        return Err("当前没有在录制".to_string());
    }
    let new_paused = !state.is_paused;
    state.is_paused = new_paused;
    state.pause_flag.store(new_paused, Ordering::SeqCst);
    Ok(new_paused)
}

/// 停止录制
pub fn stop_recording() -> Result<(), String> {
    let state = RECORDER.lock().unwrap();
    if !state.is_recording {
        return Err("当前没有在录制".to_string());
    }
    state.stop_flag.store(true, Ordering::SeqCst);
    Ok(())
}

/// 获取录制状态
pub fn get_recorder_status() -> serde_json::Value {
    let state = RECORDER.lock().unwrap();
    serde_json::json!({
        "is_recording": state.is_recording,
        "is_paused": state.is_paused,
        "frame_count": state.frame_count,
        "duration_secs": state.duration_secs(),
        "format": state.format,
        "output_path": state.output_path,
    })
}
