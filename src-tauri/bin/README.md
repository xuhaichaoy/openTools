# 截图录屏随包二进制

- **Windows**：构建时会把 `screen-capture-helper.exe` 放到此目录，随安装包一起分发，用户无需再下载或本地编译。
- 构建 Windows 安装包前请执行：`pnpm tauri:build:win`（会先编译 helper 并复制到此处，再执行 tauri build）。

## 从 GitHub 手动放 NSIS（避免构建时下载卡住）

若 `pnpm tauri:build:win` 在下载 NSIS 或 nsis_tauri_utils.dll 时超时，可手动下载后放到 Tauri 缓存目录，再重新构建即可直接使用。

**缓存目录（Windows）**：`%LOCALAPPDATA%\tauri`，即：
`C:\Users\<你的用户名>\AppData\Local\tauri`

**步骤：**

1. **NSIS 主包**  
   - 下载：<https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.11/nsis-3.11.zip>  
   - 解压到：`%LOCALAPPDATA%\tauri\NSIS`  
   - 确保该目录下直接有 `makensis.exe`、`Stubs`、`Plugins` 等（若 zip 里有一层 `nsis-3.11`，请把里面的内容放到 `tauri\NSIS`，不要多一层 `nsis-3.11`）。

2. **nsis_tauri_utils.dll**  
   - 下载：<https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll>  
   - 放到：`%LOCALAPPDATA%\tauri\NSIS\Plugins\x86-unicode\additional\nsis_tauri_utils.dll`  
   - 若 `Plugins\x86-unicode\additional` 不存在，请先创建再放入该 dll。

完成上述两步后，直接再执行 `pnpm tauri:build:win`，构建会使用本地文件，不再从 GitHub 下载。
