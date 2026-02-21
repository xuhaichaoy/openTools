# 插件体系手工发布验收清单（Windows x64 + macOS 13+）

## 0. 范围与目标

- 目标：发布前确认插件体系在 `Windows 10/11 x64` 与 `macOS 13+` 可稳定运行。
- 范围：外部插件链路 + 全部内置插件。
- 策略：对平台不支持能力采用“隐藏”。
- 参考能力清单：`docs/builtin-plugin-platform-capability-matrix.md`

## 1. 构建产物验收

### 1.1 macOS

- 执行：`pnpm tauri:build`
- 结果：
  - [ ] 构建成功，无阻断错误
  - [ ] 应用可启动，主窗口/托盘正常

### 1.2 Windows x64

- 执行：`pnpm tauri:build`
- 结果：
  - [ ] 构建成功，无阻断错误
  - [ ] 应用可启动，主窗口/托盘正常

## 2. 外部插件链路（双平台）

### 2.1 市场安装与卸载

- [ ] 插件市场列表可加载
- [ ] 安装官方插件成功
- [ ] 重装（同 slug 新版本）覆盖安装成功
- [ ] 卸载成功（官方目录插件）
- [ ] 有 `dataProfile` 的插件可清数据

### 2.2 加载与打开

- [ ] 外部插件详情页可展示
- [ ] “打开”按钮可用时可正常打开
- [ ] “嵌入”按钮可用时可正常嵌入
- [ ] `feature.platform` 不匹配时，“打开/嵌入”被隐藏
- [ ] 后端返回 `PLUGIN_PLATFORM_NOT_SUPPORTED` 时前端无崩溃

### 2.3 资源与路径

- [ ] 外部插件 `index.html + js + css + image` 资源均可加载（重点在 Windows）
- [ ] 插件目录包含空格/中文时可正常加载

### 2.4 权限模型

- [ ] 未声明权限调用受限 API 返回 `PLUGIN_PERMISSION_DENIED`
- [ ] 声明权限后对应 API 可调用

## 3. 关键差异功能（双平台）

### 3.1 取色器

- [ ] Windows：优先 EyeDropper，可成功取色
- [ ] Windows：EyeDropper 不可用时走降级分支，不崩溃
- [ ] macOS：原生取色链路可成功取色

### 3.2 系统操作插件

- [ ] Windows：仅显示有 Windows 实现的动作
- [ ] Windows：无“点击后才提示不支持”的动作
- [ ] macOS：原有动作可正常执行

### 3.3 截图 / OCR

- [ ] 截图（全屏、区域、窗口）可用
- [ ] OCR 模型检测、识别流程可用

## 4. 内置插件 Smoke（双平台）

每个插件至少完成 1 次“打开 -> 关键操作 -> 返回”。

- [ ] `dev-toolbox`
- [ ] `screen-capture`
- [ ] `ocr`
- [ ] `screen-translate`
- [ ] `note-hub`
- [ ] `ai-center`
- [ ] `workflows`
- [ ] `knowledge-base`
- [ ] `color`
- [ ] `qr-code`
- [ ] `data-forge`
- [ ] `image-search`
- [ ] `plugins`
- [ ] `cloud-sync`
- [ ] `system-actions`
- [ ] `clipboard-history`
- [ ] `snippets`
- [ ] `bookmarks`
- [ ] `management-center`

## 5. 发布签字

- macOS 验收人：`__________`  日期：`__________`
- Windows 验收人：`__________`  日期：`__________`
- 发布负责人：`__________`  日期：`__________`
