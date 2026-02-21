# 屏幕取色方案（不截图的替代）

## 1. EyeDropper API（推荐，Windows 优先）

- **是什么**：浏览器标准 API，`new EyeDropper().open()` 后由系统/浏览器提供取色光标，点哪取哪，**不截屏**。
- **Tauri 各平台**：
  - **Windows**：WebView2 基于 Chromium，已支持。当前实现里（React 取色器 + 内置插件页）均**优先使用 EyeDropper**，不可用时再降级到宿主取色能力。
  - **macOS**：WKWebView（Safari 内核）**不支持**，WebKit 有 [bug 229755](https://bugs.webkit.org/show_bug.cgi?id=229755) 在跟踪，未实现。
  - **Linux**：webkit2gtk 同样不支持。
- **参考**：[MDN EyeDropper](https://developer.mozilla.org/en-US/docs/Web/API/EyeDropper_API)、[Chrome 能力说明](https://developer.chrome.com/docs/capabilities/web-apis/eyedropper)

## 2. 按坐标实时取 1 像素（不截全屏）

- **做法**：全屏透明 overlay，鼠标移动时用系统 API 只取**当前点 1 像素**（或 1×1 小区域）。
- **macOS**：`screencapture -R x,y,1,1` 或 `CGDisplayCreateImageForRect(display, rect)`（需 core-graphics / core-graphics2）。
- **Windows**：GDI `GetPixel(screenDC, x, y)`。
- **特点**：不截整屏，但界面上看不到“桌面画面”，只有放大镜 + 颜色；macOS 上每次取色都是一次 1×1 捕获，有调用频率/权限考虑。
- **当前实现**：Rust 已提供 `plugin_get_pixel_at(x, y)`，可用于“实时 1 像素”模式（之前做过一版全屏透明 + 节流 invoke）。

## 3. 先截全屏再在图上取（当前 macOS/Linux 默认）

- **做法**：截整屏 → 全屏窗口里显示截图画 → 在画面上移动/点击取色。
- **特点**：体验像“在截图上取色”，需要一次全屏截图；macOS/Linux 上目前用此方案。

## 小结

| 方案           | 是否截图 | Windows              | macOS / Linux      |
|----------------|----------|----------------------|--------------------|
| EyeDropper API | 否       | ✅ 已优先用（有降级） | ❌ WebView 不支持  |
| 实时 1 像素    | 否       | ✅ 可用     | ✅ 可用（1×1 捕获）|
| 截全屏再取     | 是       | 可做       | ✅ 当前默认         |

- **不想截图时**：  
  - 在 **Windows** 上已优先走 EyeDropper，不截图。  
  - 在 **macOS/Linux** 上，若不想截全屏，只能走“实时 1 像素”模式（全屏透明 + 节流调用 `plugin_get_pixel_at`），看不到桌面画面，只有取色 UI。  
- 若希望 macOS 上也不依赖 `screencapture` 全屏，可考虑用 **core-graphics2** 的 `CGDisplayCreateImageForRect` 在 Rust 里只截 1×1，减少进程调用。
