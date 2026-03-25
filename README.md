# HiClow

AI-First 桌面效率工具箱，基于 `Tauri v2 + React 19 + TypeScript`。  
它现在不只是一个启动器，而是一个把 **Launcher、AI 助手、Dialog 协作、IM 渠道、数据库查询导出、MCP 工具扩展** 放在同一桌面工作台里的本地应用。

## 当前定位

- **桌面 Launcher**：`Alt+Space` 唤起，统一打开搜索、插件和 AI 工作台
- **AI 工作台**：支持 `Explore / Build / Plan / Dialog`
- **协作运行时**：本地 Dialog 已有 `ExecutionContract + child session + contractDelegations`
- **IM 渠道助手**：支持钉钉、飞书会话接入，并以 `im_conversation` 运行时隔离
- **数据查询与导出**：数据库客户端 + 自然语言导出 + `dbproto/v1`
- **MCP / 插件 / Skills 扩展**：可通过 MCP 服务器、内置插件、技能为 Agent 增强能力

## 产品优点

- **一体化工作台**：Launcher、AI 工作台、Dialog 协作、IM 渠道、数据库导出、MCP 扩展都在一个桌面应用里完成
- **主 Agent 优先的协作心智**：Dialog 默认由主 Agent 决定是否派工，用户不需要盯着子线程做路由判断
- **本地 + 渠道双运行时**：既能在桌面本地持续协作，也能接住钉钉 / 飞书对话，并保持 `im_conversation` 独立语义
- **结构化数据能力开始成型**：不是只有自然语言 prompt，数据库查询 / 导出已经进入 `dbproto/v1 + protocol context` 路径
- **桌面原生扩展能力强**：支持文件、图片、本地路径、MCP、插件、技能，多种能力可以组合进同一任务流
- **仍在快速收口但方向清晰**：当前已经有协作内核、审批链路和 compaction 基础闭环，后续重点就是统一 session / mode / security 真相

## 如何使用

### 1. 启动入口

- **`Alt+Space`**：唤起主窗口
- **默认输入**：搜索内置工具、插件和常用入口
- **`ai `**：进入 AI 对话 / 工作台入口
- **`/ `**：快速走执行型 AI 路径
- **`bd ` / `gg `**：快速网页搜索
- **`data `**：进入数据工坊 / 数据相关入口

### 2. 常见工作流

- **快速问答 / 读图**：用 `Explore`
- **改代码 / 跑命令 / 落地实现**：用 `Build`
- **复杂任务先拆解**：用 `Plan`
- **多 Agent 讨论 / 派工 / 汇总**：用 `Dialog`
- **外部聊天渠道接入**：在管理中心配置钉钉 / 飞书，再由 `im_conversation` runtime 承载
- **自然语言查库 / 导出**：在数据库客户端配置数据源后，走自然语言导出与 `dbproto/v1`

## 主要能力

### 1. AI 工作台

- **Explore**：快速问答、轻量检索、图片输入、单轮工具协助
- **Build**：单 Agent 持续执行，适合读代码、改文件、跑命令、验证结果
- **Plan**：复杂任务拆解、并行规划和汇总
- **Dialog**：多 Agent 协作房间，默认 parent-first，由主 Agent 决定是否派工给子会话
- **Review lane 已分层**：目前更多作为只读审查执行边界和运行策略存在，仍在继续产品化收口

### 2. Dialog / 协作内核

- 已落地 `ExecutionContract`
- 已落地 `CollaborationSessionController`
- 已支持 child session / spawned task graph
- 已支持 `contractDelegations` 投影
- 已有 `policy -> auto_review -> human` 三层审批链路
- 已支持房间级上下文压力检测与 compaction 基础闭环

当前最接近的心智是：

`用户 -> 主 Agent ->（必要时）派工给子 Agent -> 子结果回流主 Agent -> 主 Agent 汇总回复`

### 3. IM 渠道与会话运行时

- 支持 **钉钉**、**飞书**
- 每个 `(channelId, conversationId, topicId)` 对应独立运行时
- IM 运行态已从本地 `dialog` 语义拆出，使用 `im_conversation`
- 默认只暴露 parent 视角，不要求 IM 用户直接理解 child session
- 已有 topic 级 snapshot / restore / pending interaction / follow-up 持久化

### 4. 数据库与自然语言导出

- 内置数据库客户端：`SQLite / PostgreSQL / MySQL / MongoDB`
- 支持自然语言导出入口、导出预览与确认导出
- `dbproto/v1` 已支持：
  - `list_namespaces`
  - `namespace_exists`
  - `list_tables`
  - `describe_table`
  - `sample_table`
  - `search_tables`
  - `list_datasets`
  - `describe_dataset`
- IM 数据导出 runtime 会保留 `lastProtocolContext`，让 follow-up 不再完全依赖模型重猜

### 5. MCP、插件与技能

- 内置 **MCP 服务器管理页**
- 支持 MCP server 配置、启动、工具发现和调用
- stdio transport 已按标准 `Content-Length` framing 实现
- `initialize` 后发送真实 `notifications/initialized`
- 支持通过 **插件系统**、**技能系统**、**MCP 工具** 为 Agent 扩展能力

### 6. 内置工具与插件

当前仓库已包含多类内置能力，例如：

- OCR / 截图 / 取色
- 图片编辑
- SSH 管理
- 数据库客户端
- 管理中心
- 二维码、书签、开发辅助等工具

### 7. 输入与附件

- 支持 **文本输入**
- 支持 **图片输入**
- 支持 **文件附件 / 本地路径附件**
- Agent / Dialog 路径会把图片和附件纳入上下文与任务工作集
- 当前模型若不支持视觉输入，系统会明确降级提示，而不是假装“看到了图片”

## 当前不是最终形态的部分

- `Review` 已有执行边界和模式定义，但仍在继续做成更完整的产品入口
- `SessionControlPlane` 还在继续收口，local dialog / IM / runtime-state / persistence 还没有完全统一到单一真相
- 安全策略虽然已有 `policy -> auto_review -> human` 三层链路，但仍在继续向更统一的 surface policy 收口
- 上下文 compaction 已能运行，但还在继续补 session maintenance、rotate/prune、archive retention 等运维层能力

## 技术栈

| 模块 | 技术 |
|------|------|
| 桌面框架 | `Tauri v2` / Rust |
| 前端 | `React 19` + `TypeScript` + `Vite` |
| UI | `TailwindCSS v4` |
| 状态管理 | `Zustand` |
| AI / LLM | OpenAI 兼容 API |
| 运行时扩展 | MCP / 插件 / Skills |
| 包管理 | `pnpm` + `Node 20` |

## 快速开始

### 环境要求

- Node.js `20+`
- pnpm `10+`
- Rust `1.77+`
- macOS / Windows / Linux

### 开发命令

```bash
# 切换 Node 版本
nvm use 20

# 安装依赖
pnpm install

# 启动前端 + Tauri
pnpm tauri:dev

# 构建
pnpm tauri:build
```

### 常用检查

```bash
# 全量质量门禁
pnpm quality:check

# 类型检查
pnpm -s tsc --noEmit

# 单元测试
pnpm test
```

## 项目结构

```text
src/
├── components/                  # 通用 UI、窗口层、AI 视图
├── core/
│   ├── ai/                      # AI 路由、产品模式、运行时
│   ├── collaboration/           # ExecutionContract / controller / child session / persistence
│   ├── channels/                # 钉钉 / 飞书 / IM conversation runtime
│   ├── data-export/             # dbproto/v1、导出协议、运行时
│   ├── session-control-plane/   # session 身份、恢复与控制平面（进行中）
│   └── agent/actor/             # ActorSystem、Dialog、审批、执行策略
├── plugins/builtin/             # 内置插件（AI、数据库、管理中心、OCR、SSH 等）
├── shell/                       # 主窗口、路由、launcher 交互
└── store/                       # Zustand store

src-tauri/
├── src/
│   ├── commands/                # Tauri IPC 命令
│   ├── tray.rs                  # 托盘与窗口入口
│   ├── mtplugin.rs              # 插件资源与协议辅助
│   └── lib.rs                   # Tauri 入口
└── tauri.conf.json
```

## 推荐阅读

- `./docs/README.md`
- `./docs/dialog-mode-refactor-status-and-next-wave.md`
- `./docs/ai-im-channel-dialog-solution.md`
- `./docs/ai-openclaw-parity-development-roadmap.md`
- `./docs/data-export-query-and-mcp-status.md`

## 当前阶段判断

当前项目已经不是“AI 输入框 + 几个工具”的阶段，而是进入了：

- **本地 AI 工作台可用**
- **Dialog 协作内核基本成型**
- **IM 渠道运行时可用**
- **数据库查询/导出协议开始稳定**
- **MCP 扩展链路可用**

但也仍在继续推进几个关键方向：

- `SessionControlPlane` 单一真相
- 真实产品模式分层
- 更统一的安全/审批策略对象
- 更运维化的 compaction / maintenance 生命周期

## License

当前仓库未在本文件中单独声明开源许可证，请以仓库实际发布策略为准。
