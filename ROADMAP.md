# mTools 后续维护与扩展方案

> 基于 v0.1.0 代码全量审查，结合 Launcher（Spotlight 式）产品定位编写。
> 按"必须修 → 短期优化 → 中期扩展 → 新功能扩展 → 远期方向"五层组织，每条附具体文件与改动范围。

---

## 〇、项目现状总结

| 维度 | 现状 |
|------|------|
| 定位 | AI-First Launcher 效率工具（类 Raycast），窗口 800×60，无装饰、置顶、快捷键唤起 |
| 阶段 | MVP 后期，核心功能可用，版本 0.1.0 |
| 核心模块 | AI 对话（Ask）、智能 Agent、截图/OCR、翻译、插件系统 |
| 已完成模块 | 工作流引擎、知识库 RAG、云同步、笔记中心、开发工具箱、二维码、以图搜图、取色 |
| 半成品模块 | 数据工坊（骨架）、plugin-embed 模式（已实现但未接入主流程） |
| 技术栈 | Tauri v2 + React 19 + TypeScript + Zustand + TailwindCSS v4 |
| 插件体系 | 双轨：内置插件（React 组件 + registry）+ 外部插件（uTools/Rubick 兼容 + shim） |

---

## 一、必须修复的问题（P0）

### 1.1 后端命令缺少路径/命令约束

**问题**：`read_text_file`、`write_text_file`、`run_shell_command` 无任何目录白名单或命令策略，AI Agent 或恶意提示词可操作本机任意文件。

**涉及文件**：
- `src-tauri/src/commands/system.rs` — `read_text_file`（L276）、`write_text_file`（L286）、`list_directory`（L300）、`run_shell_command`（L328）

**改动方案**：
```
1. 为 read/write/list 增加可配置的「允许根目录列表」
   - 默认值：用户 Home、Desktop、Documents、Downloads、临时目录
   - 在 config.json 中持久化，设置页可编辑
   - 后端校验：canonical 路径必须 starts_with 某个允许根目录

2. 为 run_shell_command 增加命令策略
   - 方案 A（简单）：维护禁止命令前缀列表（rm -rf /、sudo、mkfs 等）
   - 方案 B（推荐）：改为「命令需用户确认」模式，复用已有的 ConfirmDialog
   - Agent 侧已有 dangerousToolPatterns 检查，但 Ask 模式的 Function Calling
     走的是 ai.rs 的 execute_tool()，也已有 is_dangerous_tool() 检查，
     需确保两条路径策略一致

3. 在 src-tauri/src/lib.rs 的 invoke_handler 注册处增加注释标记：
   「以下命令具有系统级副作用，需配合路径/命令策略使用」
```

**预估工时**：2-3 天

---

### 1.2 iframe 嵌入插件隔离偏弱

**问题**：`PluginEmbed` 使用 `sandbox="allow-scripts allow-same-origin"`，`allow-same-origin` 会显著削弱 iframe 沙箱（脚本可访问父窗口 cookie、localStorage 等）。

**涉及文件**：
- `src/components/plugins/PluginEmbed.tsx`（L77）

**改动方案**：
```
1. 移除 allow-same-origin，改为 sandbox="allow-scripts allow-forms allow-popups"
2. 通信完全走 postMessage 桥（当前已实现，不受影响）
3. 如果某些插件确实需要同源能力，在 manifest 中声明 "sandbox": "relaxed"，
   前端按声明决定是否加 allow-same-origin，并在插件详情页提示风险
```

**预估工时**：半天

---

### 1.3 Agent 任务更新竞态风险

**问题**：`handleRun` 中用 `taskIndex`（数字索引）标识正在执行的任务，异步回调期间如果会话被切换/删除，更新可能错位或丢失。

**涉及文件**：
- `src/plugins/builtin/SmartAgent/index.tsx`（L230-L300）
- `src/store/agent-store.ts` — `updateTask`

**改动方案**：
```
1. 为 AgentTask 增加 id 字段（生成方式同 session id）
2. addTask 返回 taskId 而非 taskIndex
3. updateTask 改为按 taskId 查找更新，而非按 index
4. handleRun 中的 sessionId 和 taskId 在闭包中捕获，
   回调时先校验 session 和 task 是否仍存在
```

**预估工时**：1 天

---

### 1.4 持久化哈希校验过于粗糙

**问题**：`agent-store.ts` 的 `persistHistory` 用 `json.length + 首尾字符` 做去重哈希，极易碰撞（内容变了但长度和首尾字符没变就跳过持久化）。

**涉及文件**：
- `src/store/agent-store.ts`（L123-L124）

**改动方案**：
```
改为对 JSON 字符串做简单的 DJB2 哈希（纯 JS 实现，几行代码），
或直接去掉哈希判断——300ms 防抖已经足够限制写入频率。
```

**预估工时**：半小时

---

## 二、短期优化（1-2 周）

### 2.1 Agent 改用流式输出

**现状**：`ReActAgent.run()` 调用 `ai.chat()`（等完整响应），SDK 已实现 `ai.stream()` 但未使用。

**涉及文件**：
- `src/plugins/builtin/SmartAgent/core/react-agent.ts` — `run()` 方法（L217）

**改动方案**：
```
1. 在 run() 循环中将 ai.chat() 替换为 ai.stream()
2. stream 的 onChunk 回调中实时拼接 response，
   同时通过 onStep 回调推送 { type: "thought", content: 当前累积文本 }
3. stream 完成后再做 parseResponse()，执行工具逻辑不变
4. 好处：用户能看到 Agent "正在思考什么"，而非干等
```

**预估工时**：1-2 天

---

### 2.2 首页增加「最近使用」排序

**现状**：Dashboard 的工具网格按 registry 注册顺序固定排列。

**涉及文件**：
- `src/components/home/Dashboard.tsx`
- `src/store/app-store.ts`（新增字段）

**改动方案**：
```
1. app-store 新增 recentTools: string[]（记录最近点击的 viewId，最多 20 条）
2. 持久化到 localStorage
3. Dashboard 渲染时：将 recentTools 中出现的工具排在前面，
   其余按原顺序排列
4. 可选：第一行标题改为「最近使用」，后面跟「全部工具」
```

**预估工时**：半天

---

### 2.3 高频场景快捷入口

**现状**：quickActions 区只有百度/Google/必应/终端 4 个搜索快捷方式。

**涉及文件**：
- `src/components/home/Dashboard.tsx`（L21-L49）

**改动方案**：
```
在 quickActions 中增加：
- 「截图 OCR」：触发截图 → 自动切到 OCR 页
- 「截图翻译」：触发截图 → 自动切到翻译页
- 「AI 问答」：直接跳转 AI 助手

实现方式：调用 invoke("start_capture") 并通过事件总线设置
capture-done 后的目标视图（ocr / screen-translate）
```

**预估工时**：1 天

---

### 2.4 Ask/Agent 入口简化

**现状**：用户可通过 3 种路径进入 AI：搜索框 `ai ` 前缀 → Ask；首页点 AI 助手 → AICenter（手动切 Ask/Agent）；搜索框 `/ ` 前缀 → Shell Agent。路径多且割裂。

**涉及文件**：
- `src/components/tools/AICenter.tsx`
- `src/App.tsx`（L504-L519、L578-L600）

**改动方案**：
```
1. 保留 AICenter 的 Ask/Agent Tab，但增加智能默认：
   - 用户输入包含「执行/运行/打开/创建/删除/文件/目录/命令」等关键词时，
     自动切到 Agent 模式
   - 否则默认 Ask 模式
2. 移除搜索框的 `/ ` 前缀特殊处理（合并到 Agent 模式）
3. 搜索框的 `ai ` 前缀保留，进入后自动聚焦到对话输入框
```

**预估工时**：1 天

---

### 2.5 确认弹窗增加自然语言描述

**现状**：`ConfirmDialog` 展示工具名 + 参数 JSON，普通用户看不懂。

**涉及文件**：
- `src/plugins/builtin/SmartAgent/components/ConfirmDialog.tsx`

**改动方案**：
```
增加 describeAction(toolName, params) 函数：
- shell / run_shell_command → "即将执行命令：`{command}`"
- write_file → "即将写入文件：{path}（{content.length} 字符）"
- read_file → "即将读取文件：{path}"
展示在确认弹窗的主体区域，参数 JSON 折叠为「查看详情」
```

**预估工时**：半天

---

### 2.6 插件崩溃增加重试能力

**现状**：`PluginErrorBoundary` 只展示错误信息和"返回主页"按钮。

**涉及文件**：
- `src/components/plugins/PluginErrorBoundary.tsx`

**改动方案**：
```
增加「重试」按钮，点击后调用 this.setState({ hasError: false })
触发子组件重新渲染（React Error Boundary 标准重试模式）
```

**预估工时**：半小时

---

## 三、中期扩展（1-2 个月）

### 3.1 插件 Action 暴露为工作流节点

**现状**：工作流节点类型（`ai_chat`、`clipboard_read` 等）硬编码在后端，插件的 actions 只能被 Agent 调用，不能被工作流编排。

**涉及文件**：
- `src/core/workflows/types.ts`
- `src/core/workflows/builtin-workflows.ts`
- `src-tauri/src/commands/workflow.rs`
- `src/core/plugin-system/registry.ts`

**改动方案**：
```
1. 工作流节点类型新增 "plugin_action"，配置项为 { pluginId, actionName, params }
2. 后端 workflow_execute 遇到 plugin_action 节点时，
   通过事件通知前端执行对应 action（前端有 registry 和 AI SDK）
3. WorkflowEditor 的节点选择面板中，从 registry.getAllActions() 动态生成
   可选节点列表
4. 这样「截图 → OCR → 翻译 → 写入剪贴板」就能编排为一个工作流
```

**预估工时**：1-2 周

---

### 3.2 补全 uTools 兼容 API

**现状**：utools shim 中 `screenCapture`、`setSubInput`、`removeSubInput`、`redirect`、`copyImage` 均为 stub 或未实现。

**涉及文件**：
- `src-tauri/src/commands/plugin.rs` — `generate_utools_shim()`（L814-L903）、`plugin_api_call()`（L470-L628）

**需要补全的 API**：
```
| API             | 现状          | 补全方案 |
|-----------------|---------------|----------|
| screenCapture   | console.warn  | 调用 start_capture，监听 capture-done 事件回传图片 |
| copyImage       | 返回错误      | 将 base64 写入临时文件，调用系统剪贴板写入图片 |
| setSubInput     | stub          | 通过事件通知主窗口显示子输入框，回调数据通过 postMessage 传回 |
| redirect        | stub          | 关闭当前插件窗口，打开目标 feature |
| getFeatures     | 未实现        | 从 manifest.features 返回 |
| onDbPull        | 未实现        | 暂不支持，返回空 |
```

**预估工时**：1-2 周

---

### 3.3 plugin-embed 模式接通主流程

**现状**：`App.tsx` 中有完整的 embed 桥逻辑（postMessage、token 校验、AI SDK 代理），但没有任何入口将 `view` 设为 `plugin-embed` 并设置 `embedTarget`。外部插件只能通过 `plugin_open` 在新窗口中运行。

**涉及文件**：
- `src/App.tsx`（L136-L141、L822-L844）
- `src/store/plugin-store.ts` — `openPlugin`
- `src/components/plugins/PluginMarket.tsx`

**改动方案**：
```
1. 在 PluginMarket 的插件卡片上增加「嵌入打开」按钮（与现有的新窗口打开并列）
2. 点击时 setEmbedTarget({ pluginId, featureCode, title }) + setView("plugin-embed")
3. 搜索结果中的外部插件也支持嵌入打开（当前只走 openPlugin 新窗口）
4. 好处：用户不离开主窗口即可使用外部插件，体验更连贯
```

**预估工时**：2-3 天

---

### 3.4 外部插件的 AI 能力透传

**现状**：内置插件可通过 `actions` 字段被 Agent 调用；外部插件（uTools 格式）没有 actions 概念，Agent 看不到它们。

**涉及文件**：
- `src/core/plugin-system/registry.ts` — `getAllActions()`
- `src/store/plugin-store.ts`

**改动方案**：
```
1. 在 PluginManifest 中新增可选字段 mtools.actions（与内置插件的 PluginAction 格式相同）
2. 外部插件在 plugin.json 中声明：
   "mtools": {
     "actions": [{ "name": "xxx", "description": "...", "parameters": {...} }]
   }
3. plugin_list 返回时携带 actions 信息
4. 前端在 loadPlugins 后，将外部插件的 actions 也注册到 Agent 可调用的工具列表
5. 执行时通过 postMessage 桥（embed 模式）或 plugin_api_call 扩展方法调用

这样外部插件就能被 AI Agent 发现和调用。
```

**预估工时**：1 周

---

### 3.5 Agent 升级为结构化 Tool Calling

**现状**：`ReActAgent` 依赖 LLM 输出 `Thought/Action/Action Input/Final Answer` 文本格式，`parseResponse()` 用正则解析。对模型输出格式波动敏感，容易解析失败。

**涉及文件**：
- `src/plugins/builtin/SmartAgent/core/react-agent.ts`

**改动方案**：
```
1. 检测用户配置的模型是否支持 Function Calling（OpenAI 系、Claude 系均支持）
2. 如果支持：直接将 tools 以 OpenAI Function Calling 格式传给 API，
   复用 ai.rs 中已有的 tool_calls delta 解析逻辑
3. 如果不支持：降级为当前的文本格式解析（保持兼容）
4. 好处：消除格式解析失败，提高 Agent 执行成功率

注意：这需要 mtools-ai SDK 的 chat/stream 接口增加 tools 参数支持，
当前 MToolsAI 接口只有 messages/model/temperature。
```

**预估工时**：1-2 周

---

### 3.6 默认隐藏开发者功能

**涉及文件**：
- `src/components/plugins/PluginMarket.tsx`
- `src/components/settings/SettingsPage.tsx`

**改动方案**：
```
1. general_settings 新增 developerMode: boolean，默认 false
2. PluginMarket 中开发者 Tab 仅在 developerMode 开启时显示
3. 设置页增加「开发者模式」开关
```

**预估工时**：半天

---

## 四、新功能扩展方向

> 以下为从现有代码能力自然延伸的新功能方向，均基于项目已有基础设施，投入产出比高。

### 4.1 剪贴板历史管理

**现有基础**：已集成 `tauri-plugin-clipboard-manager`，AI 对话和插件系统频繁读写剪贴板，但无历史记录能力。剪贴板历史是 Launcher 工具的标配功能（Raycast、Alfred 均有），用户日均使用频率极高。

**涉及文件**：
- `src-tauri/src/lib.rs` — 新增剪贴板监听后台任务
- `src-tauri/src/commands/` — 新增 `clipboard.rs` 模块
- `src/store/` — 新增 `clipboard-store.ts`
- `src/App.tsx` — 搜索框增加 `cb ` 前缀匹配
- `src/plugins/builtin/index.ts` — 注册为内置插件

**改动方案**：
```
1. 后端：
   - 启动时创建后台任务，每 500ms 检测剪贴板变化（对比上次内容哈希）
   - 变化时写入内存队列（最近 200 条），持久化到 Tauri Store
   - 支持文本、图片路径、文件路径三种类型
   - 新增命令：clipboard_history_list / clipboard_history_clear / clipboard_history_write

2. 前端：
   - 搜索框输入 `cb ` 前缀 → 展示剪贴板历史列表
   - 支持关键词过滤搜索
   - 点击条目 → 写入当前剪贴板
   - 注册为内置插件，也可从 Dashboard 直接进入

3. AI 联动：
   - 选中历史条目可触发「问 AI」「翻译」「格式化 JSON」等二次操作
   - Agent 工具列表新增 read_clipboard_history（获取最近 N 条）
```

**预估工时**：1 周

---

### 4.2 文件快速搜索

**现有基础**：搜索框当前只搜内置插件和外部插件命令。文件搜索是 Launcher 最核心的能力之一（Spotlight 的本质就是文件搜索），但目前完全缺失。

**涉及文件**：
- `src-tauri/src/commands/` — 新增 `file_search.rs` 模块
- `src/App.tsx` — `getFilteredResults()` 新增文件搜索结果源
- `src/components/search/ResultList.tsx` — 文件结果渲染样式

**改动方案**：
```
1. 后端：
   - macOS：调用 mdfind（Spotlight 底层命令），速度快且自动索引
   - Windows：调用 SearchIndexer API 或 Everything SDK
   - Linux：调用 locate / find（降级方案）
   - 新增命令：file_search(query, max_results, file_types)
   - 结果包含：文件名、路径、大小、修改时间、文件类型图标

2. 前端：
   - 搜索框输入普通文本时，同时搜插件 + 文件（文件结果排在插件之后）
   - 可选：`f ` 前缀仅搜文件
   - 搜索结果操作：打开文件 / 打开所在目录 / 复制路径 / 用 AI 分析

3. 性能考虑：
   - 搜索请求增加 300ms 防抖
   - 限制返回 20 条结果
   - 文件搜索与插件搜索并行执行
```

**预估工时**：1-2 周

---

### 4.3 上下文感知增强

**现有基础**：已有 `context-action`（Ctrl+Shift+A 读取剪贴板文本，弹出 ContextActionPanel），但当前只是把文本传给 AI 面板，未做内容类型识别。

**涉及文件**：
- `src/App.tsx` — `context-action` 事件处理（L206-L216）
- `src/components/ai/ContextActionPanel.tsx`
- `src/core/` — 新增 `context-detector.ts`

**改动方案**：
```
1. 新增 context-detector.ts，识别剪贴板内容类型：
   - URL → 推荐「打开链接」「加入书签」
   - JSON → 推荐「格式化」「压缩」「校验」
   - 代码片段 → 推荐「解释代码」「优化代码」
   - 英文文本 → 推荐「翻译」
   - 中文文本 → 推荐「翻译为英文」「AI 润色」
   - 文件路径 → 推荐「打开文件」「读取内容」
   - 数字 / 时间戳 → 推荐「时间戳转换」
   - 邮箱地址 → 推荐「发送邮件」

2. ContextActionPanel 改造：
   - 顶部显示识别出的类型标签
   - 下方列出推荐操作按钮（替代当前的纯 AI 面板）
   - 每个操作对应一个 registry action 或 AI 调用
   - 用户仍可选择「自由提问 AI」作为兜底

3. 好处：从「复制文本 → 手动找工具 → 粘贴操作」缩短为「复制 → 快捷键 → 一键操作」
```

**预估工时**：3-5 天

---

### 4.4 RAG 知识库与 AI 对话打通

**现有基础**：RAG 模块（文档导入、分块、向量化、检索）和 AI 对话模块都已完整实现，但两者独立运行。AI 对话不会自动查询知识库，知识库检索结果不会注入对话上下文。

**涉及文件**：
- `src-tauri/src/commands/ai.rs` — `get_system_prompt()`、`ai_chat_stream()`
- `src-tauri/src/commands/rag.rs` — `rag_search()`
- `src/store/ai-store.ts`
- `src/components/settings/SettingsPage.tsx`

**改动方案**：
```
1. AI 设置新增开关：「对话时自动检索知识库」（默认关闭）

2. 开启后，ai_chat_stream 流程改造：
   - 收到用户消息后，先调用 rag_search(用户消息, top_k=3)
   - 如果检索到相关内容（score > 阈值），将其注入 system prompt：
     "以下是从用户知识库中检索到的相关信息，请参考回答：\n{chunks}"
   - 回答时自动标注来源文档

3. Ask 模式的 Function Calling 已有 search_knowledge_base 工具，
   但需要 AI 主动决定调用；打通后变为「自动检索 + 主动检索」双通道

4. 好处：用户导入自己的文档后，AI 回答自动变「懂你的」
```

**预估工时**：2-3 天

---

### 4.5 快捷短语 / 文本片段

**现有基础**：笔记中心（NoteHub）已有 marks 存储体系和拼音搜索能力，可复用。

**涉及文件**：
- `src/core/database/` — 新增 `snippets.ts`（或复用 marks）
- `src/store/` — 新增 `snippet-store.ts`
- `src/plugins/builtin/index.ts` — 注册为内置插件
- `src/App.tsx` — 搜索框增加 `sn ` 前缀匹配

**改动方案**：
```
1. 数据模型：
   { id, title, content, keyword, category, isDynamic, dynamicPrompt }
   - keyword：搜索框触发关键词
   - isDynamic：是否为 AI 动态生成内容
   - dynamicPrompt：动态片段的 AI 提示词模板

2. 静态片段：
   - 用户预设内容（邮箱签名、代码模板、常用回复）
   - 搜索框输入关键词 → 匹配 → 一键复制到剪贴板

3. 动态片段：
   - 内容由 AI 实时生成（如「今天日期的问候语」「随机密码」）
   - 触发时调用 ai.chat() 生成内容，再写入剪贴板

4. 管理界面：
   - 注册为内置插件 "snippets"
   - 支持增删改查、分类管理、导入导出
```

**预估工时**：1 周

---

### 4.6 系统快捷操作面板

**现有基础**：已有全局快捷键注册能力、`open_url` / `run_shell_command` 等系统命令，以及内置插件注册机制。

**涉及文件**：
- `src/plugins/builtin/index.ts` — 注册为内置插件
- `src/plugins/builtin/SystemActions/` — 新建插件目录

**改动方案**：
```
1. 注册为内置插件 "system-actions"，包含以下 actions：
   - lock_screen：锁屏（macOS: pmset displaysleepnow / Windows: rundll32）
   - toggle_dark_mode：切换系统深色模式
   - empty_trash：清空回收站
   - sleep_system：系统休眠
   - toggle_bluetooth：蓝牙开关（macOS 专属）
   - toggle_wifi：Wi-Fi 开关
   - screenshot_full：全屏截图（调用现有 start_capture）
   - show_desktop：显示桌面

2. 每个 action 同时暴露给 Agent（AI 可调用）和搜索框（用户可直接搜索触发）

3. 实现方式：每个 action 的 execute 函数调用 invoke("run_shell_command")
   执行对应的系统命令，部分操作通过 Tauri 原生 API 实现
```

**预估工时**：2-3 天

---

### 4.7 网页书签管理

**现有基础**：已有 `open_url` 命令和搜索引擎快捷指令（`bd `、`gg `、`bing `），搜索结果已支持混排。

**涉及文件**：
- `src/core/database/` — 新增 `bookmarks.ts`
- `src/store/` — 新增 `bookmark-store.ts`
- `src/App.tsx` — `getFilteredResults()` 新增书签搜索结果源
- `src/plugins/builtin/index.ts` — 注册为内置插件

**改动方案**：
```
1. 数据模型：
   { id, title, url, keyword, category, icon, createdAt }
   - keyword：可选的搜索触发词

2. 搜索整合：
   - 搜索框输入文本时，同时搜插件 + 书签（书签结果排在插件结果之后）
   - 匹配方式：标题、URL、关键词的拼音模糊匹配
   - 点击 → 调用 open_url 打开

3. 管理界面：
   - 注册为内置插件 "bookmarks"
   - 支持增删改查、分类管理
   - 进阶：支持从 Chrome / Firefox 导入书签
     （解析 ~/.config/google-chrome/Default/Bookmarks JSON 文件）

4. AI 联动：
   - Agent 工具列表新增 search_bookmarks / open_bookmark
   - 「帮我打开上次看的那个 API 文档」
```

**预估工时**：1 周

---

### 4.8 定时任务 / 提醒

**现有基础**：工作流引擎已有完整的执行能力（步骤调度、事件通知、进度展示），触发类型当前仅支持 `manual` 和 `keyword`。

**涉及文件**：
- `src/core/workflows/types.ts` — Workflow.trigger 类型扩展
- `src-tauri/src/commands/workflow.rs` — 新增定时调度逻辑
- `src/store/workflow-store.ts`
- `src/components/workflows/WorkflowEditor.tsx` — 触发器编辑 UI

**改动方案**：
```
1. 触发类型扩展：
   - "cron"：Cron 表达式（如 "0 9 * * 1-5" = 工作日早9点）
   - "interval"：固定间隔（如每 30 分钟）
   - "once"：一次性定时（指定日期时间）

2. 后端调度：
   - 应用启动时加载所有定时工作流
   - 用 tokio::time 实现定时器
   - 到达触发时间 → 调用 workflow_execute
   - 通过系统通知告知用户执行结果

3. 前端：
   - WorkflowEditor 触发器面板增加 cron / interval / once 选项
   - 工作流列表显示下次执行时间
   - 系统托盘菜单增加「即将执行的任务」

4. 场景示例：
   - 每天早上自动汇总昨日笔记
   - 每小时检查剪贴板中的待办事项
   - 定时备份设置到云端
   - 工作日下班前提醒日报
```

**预估工时**：1-2 周

---

## 五、远期方向（3-6 个月，仅规划不急于实施）

### 5.1 简易插件推荐列表

**思路**：维护一个远程 JSON 文件（GitHub/CDN），列出推荐的 uTools 插件及其下载地址。用户在插件市场看到推荐列表，点击后自动下载解压到 plugins/ 目录。不做签名、评分、自动更新，保持简单。

### 5.2 工作流市场

**思路**：类似插件推荐，维护一份社区工作流 JSON。用户一键导入到本地工作流列表。

### 5.3 MCP（Model Context Protocol）集成深化

**现状**：已有 `src-tauri/src/commands/mcp.rs`（`McpServerManager`），说明已开始接入 MCP。

**方向**：将 MCP Server 作为 Agent 的工具源之一，让 Agent 能调用外部 MCP Server 提供的能力（如数据库查询、API 调用等）。用户在设置页配置 MCP Server（本地 stdio 或远程 SSE），Agent 运行时自动发现并合并可调用的工具列表。

### 5.4 多模型策略

**思路**：不同场景用不同模型——简单问答用轻量模型（快+省），Agent 执行用强模型（准确），embedding 用专用模型。在 AI 设置中支持按场景配置模型。

### 5.5 对话记忆与个性化

**思路**：当前 AI 对话是无状态的（每次会话独立）。可增加用户偏好记忆（"我用 TypeScript"、"我喜欢简洁回复"），存储为 system prompt 片段，每次对话自动注入。结合 RAG 知识库实现个性化回答。

---

## 六、不建议做的事（避免过度工程化）

| 方向 | 为什么不做 |
|------|-----------|
| 多 Agent 架构 | Launcher 场景用完即走，单 Agent + 流式输出已足够 |
| 插件权限系统 / Capability 抽象 | 0.1.0 阶段插件数量少，投入产出比低 |
| 企业化功能（策略下发/审计/RBAC） | 产品定位是个人效率工具 |
| 历史任务转模板/工作流 | 增加认知负担，不符合 Launcher 轻量特性 |
| 插件签名校验/自动更新 | 等插件生态真正起来再做 |
| 浏览器插件 | Launcher 应保持桌面端独立性 |
| 移动端 | Launcher 交互模式不适合手机 |
| 协作/多人功能 | 个人效率工具，不需要团队功能 |

---

## 七、按文件索引的改动清单

方便开发时快速定位，按文件聚合所有涉及的改动点：

### 前端

| 文件 | 改动项 |
|------|--------|
| `src/plugins/builtin/SmartAgent/core/react-agent.ts` | 2.1 流式输出；3.5 结构化 Tool Calling |
| `src/plugins/builtin/SmartAgent/index.tsx` | 1.3 taskId 替换 taskIndex |
| `src/plugins/builtin/SmartAgent/components/ConfirmDialog.tsx` | 2.5 自然语言描述 |
| `src/store/agent-store.ts` | 1.3 taskId 机制；1.4 哈希修复 |
| `src/components/home/Dashboard.tsx` | 2.2 最近使用排序；2.3 快捷场景入口 |
| `src/store/app-store.ts` | 2.2 新增 recentTools 字段 |
| `src/components/tools/AICenter.tsx` | 2.4 智能模式切换 |
| `src/App.tsx` | 2.4 移除 `/ ` 前缀处理；3.3 embed 入口；4.1 `cb ` 前缀；4.2 文件搜索结果；4.3 上下文感知；4.7 书签搜索 |
| `src/components/plugins/PluginEmbed.tsx` | 1.2 sandbox 策略 |
| `src/components/plugins/PluginErrorBoundary.tsx` | 2.6 重试按钮 |
| `src/components/plugins/PluginMarket.tsx` | 3.3 嵌入打开按钮；3.6 开发者 Tab 隐藏 |
| `src/core/plugin-system/registry.ts` | 3.4 外部插件 action 注册 |
| `src/core/plugin-system/plugin-interface.ts` | 3.5 MToolsAI 接口增加 tools 参数 |
| `src/core/ai/mtools-ai.ts` | 3.5 chat/stream 增加 tools 支持 |
| `src/store/plugin-store.ts` | 3.4 外部插件 action 加载 |
| `src/plugins/builtin/index.ts` | 4.1 剪贴板插件注册；4.5 快捷短语注册；4.6 系统操作注册；4.7 书签插件注册 |
| `src/components/ai/ContextActionPanel.tsx` | 4.3 上下文感知推荐操作 |
| `src/store/ai-store.ts` | 4.4 RAG 自动检索开关 |
| `src/core/workflows/types.ts` | 4.8 触发类型扩展（cron/interval/once） |
| `src/components/workflows/WorkflowEditor.tsx` | 4.8 触发器编辑 UI |

### 后端（Rust）

| 文件 | 改动项 |
|------|--------|
| `src-tauri/src/commands/system.rs` | 1.1 路径白名单；命令策略 |
| `src-tauri/src/commands/plugin.rs` | 3.2 补全 uTools API |
| `src-tauri/src/commands/ai.rs` | 3.5 工具参数透传；4.4 RAG 自动检索注入 |
| `src-tauri/src/lib.rs` | 1.1 注释标记危险命令；4.1 剪贴板监听任务；4.2 文件搜索命令注册 |
| `src-tauri/src/commands/clipboard.rs`（新增） | 4.1 剪贴板历史管理 |
| `src-tauri/src/commands/file_search.rs`（新增） | 4.2 文件快速搜索 |
| `src-tauri/src/commands/workflow.rs` | 3.1 plugin_action 节点；4.8 定时调度 |

### 新增文件

| 文件 | 用途 |
|------|------|
| `src/core/context-detector.ts` | 4.3 剪贴板内容类型识别 |
| `src/core/database/snippets.ts` | 4.5 快捷短语数据模型 |
| `src/store/snippet-store.ts` | 4.5 快捷短语状态管理 |
| `src/store/clipboard-store.ts` | 4.1 剪贴板历史状态管理 |
| `src/store/bookmark-store.ts` | 4.7 书签状态管理 |
| `src/core/database/bookmarks.ts` | 4.7 书签数据模型 |
| `src/plugins/builtin/SystemActions/index.tsx` | 4.6 系统快捷操作插件 |
| `src-tauri/src/commands/clipboard.rs` | 4.1 剪贴板历史后端 |
| `src-tauri/src/commands/file_search.rs` | 4.2 文件搜索后端 |

---

## 八、扩展方向投入产出比排序

| 排名 | 方向 | 投入 | 用户价值 | 依赖现有能力 | 建议阶段 |
|------|------|------|----------|-------------|---------|
| 1 | 4.1 剪贴板历史 | 1 周 | 极高 | clipboard-manager | 第 9-10 周 |
| 2 | 4.3 上下文感知增强 | 3-5 天 | 高 | context-action | 第 9 周 |
| 3 | 4.4 RAG 与 AI 对话打通 | 2-3 天 | 高 | RAG + AI 对话 | 第 9 周 |
| 4 | 4.2 文件快速搜索 | 1-2 周 | 极高 | 搜索框 + Tauri shell | 第 10-11 周 |
| 5 | 4.6 系统快捷操作 | 2-3 天 | 中 | run_shell_command + 插件注册 | 第 11 周 |
| 6 | 4.5 快捷短语 | 1 周 | 中 | 笔记存储 + 拼音搜索 | 第 12 周 |
| 7 | 4.7 网页书签 | 1 周 | 中 | open_url + 搜索混排 | 第 12-13 周 |
| 8 | 4.8 定时任务 | 1-2 周 | 中 | 工作流引擎 | 第 13-14 周 |
| 9 | 5.3 MCP 深化 | 2 周 | 高 | mcp.rs 骨架 | 第 15-16 周 |
| 10 | 5.4 多模型策略 | 1 周 | 中 | AI 配置体系 | 第 16 周 |

---

## 九、建议执行顺序（完整时间线）

```
第 1 周：P0 安全修复
  ├── 1.1 后端路径/命令约束
  ├── 1.2 iframe sandbox 收紧
  ├── 1.3 Agent taskId 替换
  └── 1.4 持久化哈希修复

第 2 周：短期体验优化
  ├── 2.1 Agent 流式输出
  ├── 2.2 首页最近使用排序
  ├── 2.3 快捷场景入口
  ├── 2.5 确认弹窗自然语言
  └── 2.6 插件崩溃重试

第 3 周：入口与模式优化
  ├── 2.4 Ask/Agent 智能切换
  ├── 3.3 plugin-embed 接通主流程
  └── 3.6 隐藏开发者 Tab

第 4-6 周：能力扩展
  ├── 3.1 插件 Action 作为工作流节点
  ├── 3.2 补全 uTools 兼容 API
  └── 3.4 外部插件 AI 能力透传

第 7-8 周：Agent 稳定性升级
  └── 3.5 结构化 Tool Calling

第 9 周：低成本高回报扩展
  ├── 4.3 上下文感知增强
  └── 4.4 RAG 与 AI 对话打通

第 9-10 周：Launcher 核心能力补全
  └── 4.1 剪贴板历史管理

第 10-11 周：搜索能力增强
  └── 4.2 文件快速搜索

第 11-12 周：效率工具扩展
  ├── 4.6 系统快捷操作面板
  └── 4.5 快捷短语 / 文本片段

第 12-13 周：搜索生态补全
  └── 4.7 网页书签管理

第 13-14 周：自动化增强
  └── 4.8 定时任务 / 提醒

第 15-16 周：AI 生态扩展
  ├── 5.3 MCP 集成深化
  └── 5.4 多模型策略
```

---

*文档生成时间：2026-02-15，基于 mTools v0.1.0 代码全量审查*
