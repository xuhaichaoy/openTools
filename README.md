# mTools

AI-First 桌面效率工具箱，基于 Tauri v2 + React 19。

## 功能特性

- **AI 对话**：支持 OpenAI 兼容 API（GPT/Claude/DeepSeek/智谱/通义等），流式输出
- **全局快捷键**：`Alt+Space` 随时唤起搜索框
- **多模式搜索框**：
  - 无前缀 → 搜索插件/工具
  - `ai ` → AI 对话
  - `bd ` → 百度搜索
  - `gg ` → Google 搜索
  - `/ ` → AI Agent shell 模式
  - `data ` → 数据工坊
- **插件系统**：兼容 uTools/Rubick 插件格式（规划中）
- **数据工坊**：AI 驱动的数据导入导出平台（规划中）

## 技术栈

| 模块 | 技术 |
|------|------|
| 桌面框架 | Tauri v2 (Rust) |
| 前端 | React 19 + TypeScript + Vite |
| UI | TailwindCSS v4 |
| 状态管理 | Zustand |
| LLM | OpenAI 兼容 API |
| 包管理 | pnpm + Node 20 |

## 开发

### 环境要求

- Node.js 20+ (推荐使用 nvm)
- pnpm 10+
- Rust 1.77+
- macOS / Windows / Linux

### 快速开始

```bash
# 切换 Node 版本
nvm use 20

# 安装依赖
pnpm install

# 开发模式（前端 + Tauri）
pnpm tauri:dev

# 构建发布包
pnpm tauri:build
```

### 质量门禁

```bash
# 前端构建 + 前端测试 + Rust 测试
pnpm quality:check
```

### 项目结构

```
src/                    # React 前端
├── components/         # UI 组件
│   ├── search/         # 搜索框 + 结果列表
│   ├── ai/             # AI 对话界面
│   └── settings/       # 设置页面
├── store/              # Zustand 状态管理
├── core/               # 核心逻辑
└── App.tsx             # 主组件

src-tauri/              # Tauri Rust 后端
├── src/
│   ├── commands/       # IPC 命令
│   │   ├── ai.rs       # AI 对话（流式 SSE）
│   │   ├── window.rs   # 窗口控制
│   │   └── system.rs   # 系统操作（Python 执行等）
│   └── lib.rs          # 主入口（快捷键/托盘/插件注册）
└── tauri.conf.json     # Tauri 配置
```
