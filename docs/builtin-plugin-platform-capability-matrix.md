# 内置插件平台能力清单（Windows x64 + macOS 13+）

状态定义：

- `supported`：Windows / macOS 都可用，行为无关键差异。
- `partial`：双平台都可用，但存在明确的平台行为差异（需在发布验收里单独验证）。

| pluginId | 插件 | Windows 10/11 x64 | macOS 13+ | 状态 | 说明 |
|---|---|---|---|---|---|
| `dev-toolbox` | 开发工具箱 | supported | supported | supported | 纯前端转换工具。 |
| `screen-capture` | 截图 | supported | supported | supported | 双平台可用，需各自系统权限。 |
| `ocr` | OCR | supported | supported | supported | 双平台可用，依赖本地 OCR 资源与截图链路。 |
| `screen-translate` | 屏幕翻译 | supported | supported | supported | 双平台可用，依赖截图/OCR链路。 |
| `note-hub` | 笔记中心 | supported | supported | supported | 双平台一致。 |
| `ai-center` | AI 助手 | partial | partial | partial | Windows 隐藏并关闭“本机原生应用工具”；macOS 可启用。 |
| `workflows` | 工作流 | supported | supported | supported | 双平台一致。 |
| `knowledge-base` | 知识库 | supported | supported | supported | 双平台一致。 |
| `color` | 颜色 | partial | partial | partial | Windows 优先 EyeDropper；macOS 走宿主原生取色。 |
| `qr-code` | 二维码 | supported | supported | supported | 双平台一致。 |
| `data-forge` | 数据工坊 | supported | supported | supported | 双平台一致。 |
| `image-search` | 以图搜图 | supported | supported | supported | 双平台一致。 |
| `plugins` | 插件中心 | supported | supported | supported | 双平台一致；外部插件按 `feature.platform` 控制入口。 |
| `cloud-sync` | 云同步 | supported | supported | supported | 双平台一致。 |
| `system-actions` | 系统操作 | partial | partial | partial | Windows 仅显示有 `winCommand` 的动作，mac-only 动作隐藏。 |
| `clipboard-history` | 剪贴板 | supported | supported | supported | 双平台可用，受系统剪贴板权限约束。 |
| `snippets` | 快捷短语 | supported | supported | supported | 双平台一致。 |
| `bookmarks` | 网页书签 | supported | supported | supported | 双平台一致。 |
| `management-center` | 管理中心 | supported | supported | supported | 双平台一致。 |

## 发布验收使用方式

1. 先完成一次双平台 Smoke（至少覆盖启动、托盘、主窗口、AI 助手、截图/OCR、插件中心）。
2. 对矩阵中 `partial` 项逐项走差异路径（特别是 `color`、`system-actions`、`ai-center`）。
3. 出现平台偏差时，先确认是否符合“隐藏不支持能力”的既定策略，再决定是否阻断发布。
