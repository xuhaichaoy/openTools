# HiClow 文档索引

这份索引用来说明当前 `docs/` 目录里还保留哪些文档、分别适合什么时候看。

原则上，这里只保留：

- 对当前产品能力仍有解释价值的状态文档
- 对后续路线仍有指导意义的架构 / 方案文档
- 平台能力和基础质量门禁这类长期会复用的说明

不再保留明显属于阶段性审查稿、临时施工计划、一次性过程记录的文档。

## 产品与现状

- [`dialog-mode-refactor-status-and-next-wave.md`](./dialog-mode-refactor-status-and-next-wave.md)
  - Dialog 协作内核当前做到哪里、还差什么、下一波最该做什么
- [`ai-im-channel-dialog-solution.md`](./ai-im-channel-dialog-solution.md)
  - IM 渠道、Dialog 房间、`im_conversation` 运行时的当前状态与收敛方向
- [`data-export-query-and-mcp-status.md`](./data-export-query-and-mcp-status.md)
  - 数据查询 / 导出协议现状，以及 MCP transport 修复状态

## 架构与路线

- [`ai-openclaw-parity-development-roadmap.md`](./ai-openclaw-parity-development-roadmap.md)
  - 对齐 OpenClaw / Codex / Claude Code 的主路线文档
- [`ai-context-memory-full-overhaul-plan.md`](./ai-context-memory-full-overhaul-plan.md)
  - 上下文、长期记忆、压缩与恢复的专项改造方案
- [`ai-openclaw-memo-layered-architecture.md`](./ai-openclaw-memo-layered-architecture.md)
  - OpenClaw 与 MEMO 思路在当前项目里的分层参考
- [`ai-long-term-memory.md`](./ai-long-term-memory.md)
  - 长期记忆的目标、边界和使用原则

## 插件与平台

- [`builtin-plugin-platform-capability-matrix.md`](./builtin-plugin-platform-capability-matrix.md)
  - 内置插件在 Windows / macOS 的能力矩阵
- [`color-picker-options.md`](./color-picker-options.md)
  - 屏幕取色能力与平台差异说明
- [`team-skill-marketplace-optimal-architecture.md`](./team-skill-marketplace-optimal-architecture.md)
  - 团队技能市场方向与设计记录

## 开发与质量

- [`quality-gate.md`](./quality-gate.md)
  - 本地质量门禁和检查命令

## 建议阅读顺序

如果你是第一次看这个项目的文档，推荐顺序：

1. 先看 [`../README.md`](../README.md)
2. 再看 [`dialog-mode-refactor-status-and-next-wave.md`](./dialog-mode-refactor-status-and-next-wave.md)
3. 然后看 [`ai-im-channel-dialog-solution.md`](./ai-im-channel-dialog-solution.md)
4. 再看 [`data-export-query-and-mcp-status.md`](./data-export-query-and-mcp-status.md)
5. 最后再进入 [`ai-openclaw-parity-development-roadmap.md`](./ai-openclaw-parity-development-roadmap.md)

## 维护约定

- 新增文档前，优先判断它是否属于“长期保留文档”
- 审查稿、一次性计划稿、临时 TODO 文档，原则上不进入长期 `docs/` 集合
- 如果某份文档只是为了阶段性推进，完成后应合并回状态文档或路线文档，再删除过程稿
