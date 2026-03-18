# AI 助手对标 OpenClaw 体验开发总方案

基于当前 `51ToolBox` 实现、现有改造文档，以及本地 `openclaw` 代码和文档整理出的后续开发主施工单。

相关文档：
- [AI 助手上下文与长期记忆全量改造方案](./ai-context-memory-full-overhaul-plan.md)
- [AI 助手三模式架构审查报告](./ai-assistant-architecture-review.md)
- [AI 助手改进执行计划](./ai-assistant-improvement-plan.md)
- [IM 通道 / Dialog 房间收敛方案](./ai-im-channel-dialog-solution.md)
- [AI 长期记忆说明](./ai-long-term-memory.md)
- [OpenClaw 主体 + MEMO 增强层实施图](./ai-openclaw-memo-layered-architecture.md)
- [Agent Cluster 架构审查](./agent-cluster-architecture-review.md)

---

## 1. 文档目标

这份文档要解决的不是“补几个功能点”，而是把 `51ToolBox` 的 AI 助手系统持续推进到接近 `openclaw` 的整体体验：

1. 大项目连续开发时，上下文稳定、不乱串、不频繁回到“重新分析项目”。
2. 无关新任务进入时，系统能及时切换上下文边界，而不是继续沿用旧项目。
3. 长期记忆默认静默、稳定、可追溯，不再频繁打断。
4. 长会话压缩后，模型仍然记得目标、关键文件、关键规则和风险。
5. `Ask / Agent / Cluster / Dialog` 四个模式使用一致的上下文、记忆、恢复、权限与状态心智。
6. 用户离开页面后再回来，过程、状态、停止能力、待确认交互都能恢复。
7. 整套系统具备可观测性和可回归测试，不再依赖临时日志排查。

这份文档同时承担 3 个角色：

1. 后续阶段开发总规划
2. 文件级施工清单
3. 最终验收标准

---

## 2. 这里说的“达到 OpenClaw 体验”是什么意思

不是照抄 `openclaw` 的代码结构，而是达到下面这些用户感知层效果：

### 2.1 用户侧体验目标

1. 发一个大型项目任务后，系统能持续记住当前工作区、关键文件、当前目标和最近结论。
2. 用户中途切一个完全无关的新任务时，系统不会继续被旧仓库污染。
3. 用户说“以后默认用中文、先给结论、天气默认按我的常驻地查”，系统能长期记住，并在需要时自动召回。
4. 历史问题、偏好、待办、过去决策类问题，系统会稳定先检索记忆，再回答。
5. 长会话跑很久之后，系统压缩历史也不会明显降智。
6. 离开页面再进入，不会出现“过程打不开”“停止无效”“状态乱掉”。
7. 用户能看懂系统当前为什么继续旧任务、为什么切了新任务、为什么这轮用了这些记忆。

### 2.2 系统侧能力目标

1. 上下文管理从 `snapshot-first` 升级为 `context-runtime-first`
2. 工作区成为第一边界，而不是仅靠聊天历史拼接
3. 记忆形成“会话笔记 + 长期记忆 + 审查候选”的稳定分层
4. 压缩从“摘要一下”升级为“带 safeguard 的上下文续航机制”
5. 模式之间共用同一套上下文与 ingest 生命周期
6. 调试、观测、回归测试形成长期可维护体系

---

## 3. 当前状态判断

### 3.1 已经具备的关键基础

当前项目已经完成了下面这些重要基础能力：

1. 已有 `context-runtime` 目录和 `Task Scope / Continuity / Ingest / Compaction Orchestrator / Debug Report` 基础模块。
2. `Agent` 执行链路已经接入上下文计划、工作区切换、上下文快照、执行后 ingest。
3. 会话笔记、长期记忆、候选队列已经开始分层。
4. 文件型记忆已经落地为 `MEMORY.md + memory/YYYY-MM-DD.md`。
5. 当前上下文卡片、上下文条带、记忆管理页已经开始具备解释能力。
6. 已经有受控调试开关，不再完全靠临时日志。

### 3.2 当前仍然存在的核心问题

和 `openclaw` 相比，当前仍然有 8 个主要差距：

1. 还没有真正统一的 `Context Engine` 生命周期接口
2. `Ask / Agent / Cluster / Dialog` 仍然是多套上下文装配链路
3. 工作区切换策略还偏简单，缺少“锁定工作区”和更细粒度的相关性判断
4. Bootstrap 上下文预算与截断可解释性不足
5. 预压缩 memory flush 还没有做到真正的“压缩前静默自救”
6. 会话恢复更偏 UI 恢复，不是完整运行时恢复
7. 记忆召回的解释能力还不够，尤其是“这条回答用了哪些记忆”
8. 大量核心逻辑仍然堆在 `use-agent-execution.ts` 等重文件中

### 3.3 当前总体判断

当前系统不是“没做出来”，而是：

```text
Agent 路径已经进入上下文运行时雏形阶段，
但整个产品还没有达到 OpenClaw 那种统一、稳定、可恢复、可观测的整体成熟度。
```

---

## 4. 总体设计原则

后续开发统一遵守下面 10 条原则。

### 4.1 Workspace First

一旦存在明确工作区，工作区是第一边界。

### 4.2 Context Engine First

上下文的 assemble / ingest / compact / afterTurn 不应散落在 UI Hook 中。

### 4.3 Memory Silent by Default

长期记忆默认静默自动化，只把少量低置信内容放进后台审查。

### 4.4 Session Notes First, Durable Memory Second

当前会话连续性优先依赖会话笔记，不把所有运行痕迹都当长期记忆。

### 4.5 Compaction is Continuity Preservation

压缩不是删历史，而是保住目标、关键文件、规则、风险和下一步。

### 4.6 Observable by Default

每轮都应该能解释：

1. 为什么继续当前会话
2. 为什么切工作区
3. 为什么压缩
4. 为什么召回这些记忆
5. 为什么建议分叉

### 4.7 Same Runtime, Different Surfaces

四种模式可以有不同 UI，但底层上下文运行时、记忆 ingest、调试快照应尽量复用。

### 4.8 Recovery Must Be Durable

恢复不能只恢复页面外观，要恢复运行态、等待态、停止能力、待确认交互。

### 4.9 Progressive Rollout

按阶段上线，每个阶段都可验证、可回退。

### 4.10 Preserve 51ToolBox Identity

借鉴 `openclaw` 的上下文和记忆体系，但保留 `51ToolBox` 原有的多模式中心、管理中心、本地工具和桌面产品心智。

---

## 5. 目标架构

目标主链路：

```text
用户输入
  -> Scope Resolver
  -> Session Continuity Policy
  -> Context Runtime Manager
  -> Context Assembler
  -> Execution Runtime (Ask / Agent / Cluster / Dialog)
  -> Turn Ingest
  -> Memory Flush / Session Notes / Compaction
  -> Session Runtime State Sync
  -> UI Context Snapshot / Debug Report
```

### 5.1 需要形成的核心层

#### A. Scope Resolver

负责判断：

1. 本轮属于哪个工作区
2. 是继续当前任务、切子目录、切新项目，还是完全无关
3. 当前 query 的 intent 是 coding / research / delivery / general

#### B. Continuity Policy

负责决定：

1. `inherit_full`
2. `inherit_recent_only`
3. `inherit_summary_only`
4. `soft_reset`
5. `fork_session`

#### C. Context Assembler

负责统一输出：

1. bootstrap 文件
2. 历史摘要
3. 最近 live steps
4. 召回记忆
5. 当前工作集
6. 上下文调试快照

#### D. Turn Ingest Pipeline

负责统一处理：

1. session note 写入
2. long-term memory 提取
3. compaction 触发与回写
4. debug report 持久化

#### E. Runtime Recovery Layer

负责页面离开/回来时恢复：

1. 当前运行状态
2. abort/stop 句柄绑定状态
3. 等待确认状态
4. 队列中的 follow-up
5. 最近执行快照

---

## 6. 对标 OpenClaw 的能力矩阵

### 6.1 已对齐或部分对齐

1. 已有工作区推断
2. 已有上下文快照展示
3. 已有会话压缩
4. 已有记忆工具 `memory_search / memory_get / memory_save`
5. 已有会话笔记沉淀
6. 已有受控调试开关

### 6.2 仍未对齐的关键能力

1. `ContextEngine` 统一接口与全模式接入
2. 更强的 bootstrap budget / truncation diagnosis
3. pre-threshold 静默 memory flush
4. post-compaction context refresh 的统一注入链路
5. session transcript 纳入召回源
6. workspace lock
7. durable runtime recovery
8. 回答级记忆引用解释
9. mode-consistent permission / waiting / stop UX

---

## 7. 后续开发总阶段

建议按 7 个阶段推进。

### 第 0 阶段：文档冻结与施工基线

目标：

1. 以本文件作为主施工单
2. 只允许在文档定义的工作流上增量实现

完成标志：

1. 当前核心差距已列清
2. 每阶段输出物明确

### 第 1 阶段：Context Engine 成型

目标：把 `Agent` 现有上下文运行时抽成真正可复用的统一接口。

当前实施进度（2026-03-17）：

1. 已新增 [context-assembler.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/context-assembler.ts)，统一输出 bootstrap、session summary、prompt context、effective files。
2. 已将 [use-agent-execution.ts](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/hooks/use-agent-execution.ts) 中最重的 assemble 逻辑切到 assembler，Hook 不再直接拼 bootstrap / summary / prompt context。
3. 已补充 [context-assembler.test.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/context-assembler.test.ts)，覆盖 continuity 对 files / handoff / prompt 的影响。
4. 已将 [prompt-build-middleware.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/middlewares/prompt-build-middleware.ts)、[local-agent-bridge.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/cluster/local-agent-bridge.ts)、[agent-runner-service.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/agent-runner-service.ts) 接到 assembler，减少 `Actor / Cluster / 后台任务` 的分散 prompt 装配。
5. 已补充 `Actor / Cluster` 侧接入测试，确保后续继续重构时不会退回到多套 assemble 逻辑。
6. 已将 [cluster-orchestrator.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/cluster/cluster-orchestrator.ts) 的 `plan / review / aggregate` 三段接入 assembled context，`Cluster` 主编排链也开始共享同一套 runtime prompt 组装。
7. 已补充 [cluster-orchestrator.test.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/cluster/cluster-orchestrator.test.ts)，验证 planner / reviewer / aggregator 都会注入 assembled context。
8. 已新增 [runtime-state.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/runtime-state.ts)，把 `Agent / Cluster / Ask / Dialog` 共享的前台会话、面板可见性、等待阶段和 abort 句柄抽成统一本地运行态。
9. 已将 [agent-running-store.ts](/Users/haichao/Desktop/work/51ToolBox/src/store/agent-running-store.ts)、[active-orchestrator.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/cluster/active-orchestrator.ts)、[ai-store.ts](/Users/haichao/Desktop/work/51ToolBox/src/store/ai-store.ts)、[actor-system-store.ts](/Users/haichao/Desktop/work/51ToolBox/src/store/actor-system-store.ts) 接入 shared runtime-state，补齐 `Ask / Agent / Cluster / Dialog` 的 active runtime metadata。
10. 已在 [ChatView.tsx](/Users/haichao/Desktop/work/51ToolBox/src/components/ai/ChatView.tsx)、[index.tsx](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/index.tsx)、[ActorChatPanel.tsx](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/components/actor/ActorChatPanel.tsx)、[ClusterPanel.tsx](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/components/cluster/ClusterPanel.tsx) 同步 panel visibility / foreground session，为后续页面离开再进入时的恢复打底。
11. 已将 [ClusterFloatingIndicator.tsx](/Users/haichao/Desktop/work/51ToolBox/src/components/cluster/ClusterFloatingIndicator.tsx) 改为统一读取 shared runtime-state，右下角全局提示现在能覆盖 `Ask / Agent / Cluster / Dialog`，停止按钮也统一走 runtime abort handler。
12. 已新增 [runtime-indicator.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/runtime-indicator.ts) 与 [runtime-indicator.test.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/runtime-indicator.test.ts)，把运行态标签、等待态文案、悬浮提示细节抽成可测试的共享逻辑。
13. 已在 [agent-store.ts](/Users/haichao/Desktop/work/51ToolBox/src/store/agent-store.ts)、[scope-resolver.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/scope-resolver.ts)、[continuity-policy.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/continuity-policy.ts) 与 [context-runtime-manager.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/context-runtime-manager.ts) 补齐 `repoRoot / lastActivePaths / lastTaskIntent / workspaceLocked / lastSoftResetAt` 这一组会话边界字段。
14. 已支持手动 `锁定当前工作区`，并在没有新路径/附件/handoff 信号时优先沿用当前工作区；如果 query 自带明确绝对路径，仍允许切换，不会被锁死。
15. 已新增“同工作区但路径焦点切换”的连续性判定：当新请求明确指向同仓库下另一组路径时，系统会退到 `inherit_summary_only`，保留摘要但不再继承旧的 live files / handoff，直接减少“大项目分析后做无关子目录任务”时的上下文污染。
16. 当前优先继续处理 `统一 ingest 风格`、`Dialog/Ask 的等待态恢复`，以及把共享 runtime-state 接到更完整的恢复入口，而不只是状态展示。

完成标志：

1. `Agent` 不再在 Hook 里直接做大量 assemble 逻辑
2. `Context Assembler` 和 `Turn Ingest` 形成稳定边界
3. 能稳定处理无关任务切换

### 第 2 阶段：四模式接入统一上下文链路

目标：让 `Ask / Agent / Cluster / Dialog` 全部接入统一 runtime。

完成标志：

1. 四模式都有一致结构的上下文快照
2. handoff / workspaceRoot / source summary 统一传递
3. 模式切换明显减少上下文丢失

### 第 3 阶段：长期记忆与召回升级

目标：达到更接近 `openclaw` 的静默记忆体验。

完成标志：

1. 长期偏好和常驻地可稳定自动保存
2. 回答级可查看“用了哪些记忆”
3. 历史问题默认稳定走检索

### 第 4 阶段：Compaction Safeguard 升级

目标：让长会话稳定跑得住。

完成标志：

1. 触发预压缩 memory flush
2. 压缩后自动做上下文刷新
3. 不再出现压缩后立刻二次无意义压缩

### 第 5 阶段：恢复、停止与等待态重构

目标：补齐“离开页面回来”的运行时体验。

完成标志：

1. 过程可恢复
2. 停止按钮稳定有效
3. 用户确认态、排队态、等待态可恢复

### 第 6 阶段：UI 和解释性体验打磨

目标：让用户真的感知到系统变聪明了。

完成标志：

1. 能看懂为什么继续旧项目或切新任务
2. 能看懂为什么用了这些记忆
3. 长上下文和压缩态可视化清晰

---

## 8. 详细改造流

### 8.1 改造流 A：Context Engine 核心层

### 目标

把当前 `Agent` 路径中的上下文决策抽象成真正可复用的统一接口，对标 `openclaw` 的 `bootstrap / assemble / ingest / afterTurn / compact` 生命周期。

### 新增或重构模块

建议补齐并收口到：

```text
src/core/agent/context-runtime/
  types.ts
  scope-resolver.ts
  continuity-policy.ts
  context-runtime-manager.ts
  context-assembler.ts
  context-ingest.ts
  compaction-orchestrator.ts
  runtime-state.ts
  debug-report.ts
```

### 重点任务

1. 新增 `context-assembler.ts`
   - 统一输出 assembled prompt inputs
   - 不再让 `use-agent-execution.ts` 自己拼 bootstrap、summary、memory、history
2. 新增 `runtime-state.ts`
   - 管理当前 turn 的 runtime metadata
   - 可被 `Agent / Cluster / Dialog / Ask` 共用
3. 给 `context-runtime-manager.ts` 增加标准出参
   - `scope`
   - `continuity`
   - `effectiveWorkspaceRoot`
   - `bootstrapPlan`
   - `memoryRecallPlan`
   - `inheritancePlan`
4. `persist*ContextIngest` 统一风格
   - `ask-context-ingest.ts`
   - `context-ingest.ts`
   - `cluster-context-ingest.ts`

### 直接改造文件

1. [use-agent-execution.ts](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/hooks/use-agent-execution.ts)
2. [context-runtime-manager.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/context-runtime-manager.ts)
3. [context-ingest.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/context-ingest.ts)
4. [ask-context-ingest.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/ask-context-ingest.ts)
5. [cluster-context-ingest.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/cluster-context-ingest.ts)

### 验收标准

1. `Agent` 主执行链路减少直接拼装代码
2. 四模式都能复用 assembler / ingest 能力
3. 每轮上下文快照结构一致

### 8.2 改造流 B：工作区边界与会话绑定增强

### 目标

从“推断工作区”升级到“明确的上下文边界策略”。

### 当前实施进度（2026-03-17）

1. 会话级边界字段已落到 [agent-store.ts](/Users/haichao/Desktop/work/51ToolBox/src/store/agent-store.ts)，并随持久化 / fork / migrate 一起保留。
2. [scope-resolver.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/scope-resolver.ts) 已能识别 query 中的绝对路径提示，并写入 `queryPathHints / workspaceSource`。
3. [context-runtime-manager.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/context-runtime-manager.ts) 已支持工作区锁定：没有外部路径信号时沿用当前工作区，有明确路径信号时允许切走。
4. [continuity-policy.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/continuity-policy.ts) 已覆盖：
   - 工作区切换
   - 明确新任务
   - query topic switch
   - 同工作区路径焦点切换
5. [AgentSessionContextStrip.tsx](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/components/AgentSessionContextStrip.tsx) 已显示当前连续性策略、原因和工作区锁定状态。
6. 这一流目前剩下的重点不是基础判定，而是把同样的边界心智继续接到 `Ask / Dialog / Cluster`，并补更细的子目录相关性评分。

### 需要新增的会话字段

在 [agent-store.ts](/Users/haichao/Desktop/work/51ToolBox/src/store/agent-store.ts) 中增加：

1. `repoRoot?: string`
2. `lastActivePaths?: string[]`
3. `lastTaskIntent?: AgentQueryIntent`
4. `workspaceLocked?: boolean`
5. `workspaceLockReason?: "user" | "session_policy"`
6. `lastSoftResetAt?: number`

### 行为要求

1. 明确工作区切换时：
   - 默认 `soft_reset` 或 `fork_session`
   - UI 明确提示
2. 新 query 明显无关时：
   - 默认建议分叉
3. 同仓库不同子目录：
   - 保留摘要和规则
   - 不保留无关 live files
4. 支持手动锁定工作区：
   - 锁定后优先保持当前 workspaceRoot

### 直接改造文件

1. [scope-resolver.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/scope-resolver.ts)
2. [continuity-policy.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/continuity-policy.ts)
3. [agent-store.ts](/Users/haichao/Desktop/work/51ToolBox/src/store/agent-store.ts)
4. [bootstrap-context.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/ai/bootstrap-context.ts)
5. Agent 相关会话列表与条带 UI

### 验收标准

1. “分析大项目后去另一个目录生成独立页面”不再污染
2. 可在会话列表看到主要工作区
3. 可手动锁定工作区

### 8.3 改造流 C：Bootstrap Context 与预算体系

### 目标

让系统像 `openclaw` 一样对 bootstrap 文件有明确预算、截断说明和扩展机制。

### 当前实施进度（2026-03-17）

1. [bootstrap-context.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/ai/bootstrap-context.ts) 已新增 bootstrap diagnostics，当前会记录：
   - 单文件预算
   - 总预算
   - 已使用字符数
   - 截断文件数
   - 超预算未注入文件数
   - 未找到文件数
2. 同一份 diagnostics 已透传到 [context-assembler.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/context-assembler.ts) 与 [prompt-context.ts](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/core/prompt-context.ts)，进入统一的 `current context` 快照。
3. [AgentPromptContextCard.tsx](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/components/AgentPromptContextCard.tsx) 已显示 `Bootstrap / 截断 / 略过` 标签，展开后可直接看到预算、被截断文件、未注入文件和缺失文件。
4. [debug-report.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/debug-report.ts) 已纳入 bootstrap budget 指标，后续排查上下文不全时可以直接看报告。
5. 已补充 [bootstrap-context.test.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/ai/bootstrap-context.test.ts)、[prompt-context.test.ts](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/core/prompt-context.test.ts) 与 [context-assembler.test.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/context-assembler.test.ts) 覆盖这条链路。
6. 这一流剩下的重点是：
   - monorepo extra bootstrap patterns
   - 更细的 section-level truncation diagnosis
   - bootstrap budget debug flag 独立开关

### 需要新增的能力

1. `bootstrapMaxChars`
2. `bootstrapTotalMaxChars`
3. bootstrap truncation report
4. monorepo extra bootstrap files
5. 工作区内 `MEMORY.md / memory.md` 优先级规则

### 具体要求

1. 给 [bootstrap-context.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/ai/bootstrap-context.ts) 增加预算分析结果
2. 当前上下文卡片增加：
   - 哪些 bootstrap 文件被注入
   - 哪些被截断
   - 是否接近预算上限
3. 支持额外 bootstrap patterns
   - 如 `packages/*/AGENTS.md`
   - 如 `apps/*/TOOLS.md`
4. 当截断发生时，当前上下文面板明确显示

### 验收标准

1. 用户能看见为什么某些规则文件没被完整带上
2. monorepo 场景下上下文命中率更高
3. bootstrap 超限不再是黑盒

### 8.4 改造流 D：长期记忆与召回体系升级

### 目标

进一步接近 `openclaw` 的静默、稳定、持续记忆体验。

### 当前实施进度（2026-03-17）

1. [assistant-memory.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/ai/assistant-memory.ts) 已把召回结果升级为 bundle，除 prompt 外还会返回：
   - `searched`
   - `hitCount`
   - `memoryIds`
   - `memoryPreview`
2. [agent-memory-store.ts](/Users/haichao/Desktop/work/51ToolBox/src/store/agent-memory-store.ts) 已新增 `getMemoryRecallBundleAsync(...)`，Agent 链路不再只能拿到一段不可解释的 prompt 字符串。
3. [use-agent-execution.ts](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/hooks/use-agent-execution.ts) 已在执行前记录：
   - 本轮是否发起长期记忆检索
   - 命中的 memory ids
   - 命中预览文本
   并把这些信息回写到 task / session / prompt snapshot。
4. [agent-store.ts](/Users/haichao/Desktop/work/51ToolBox/src/store/agent-store.ts) 已持久化：
   - task 级 `memoryRecallAttempted / appliedMemoryIds / appliedMemoryPreview`
   - session 级 `lastMemoryRecallAttempted / lastMemoryRecallPreview`
   - session 级 `lastTranscriptRecallAttempted / lastTranscriptRecallHitCount / lastTranscriptRecallPreview`
5. [prompt-context.ts](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/core/prompt-context.ts)、[AgentPromptContextCard.tsx](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/components/AgentPromptContextCard.tsx)、[AgentTaskBlock.tsx](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/components/AgentTaskBlock.tsx) 已支持两类解释：
   - 已检索但本轮未命中
   - 本轮用了哪些记忆的预览
6. [assistant-memory.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/ai/assistant-memory.ts) 已新增 `session transcript recall` 第一版：
   - 仅在 Agent 侧启用
   - 只在长期记忆不足时回补
   - 当前会从 `Ask / Agent / Cluster / Dialog` 的本地会话轨迹里抓取相关片段并生成独立 transcript prompt block
7. [use-agent-execution.ts](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/hooks/use-agent-execution.ts)、[index.tsx](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/index.tsx) 与 [debug-report.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/debug-report.ts) 已把 transcript fallback 的命中数和预览接到 prompt snapshot / debug report。
8. [AgentTaskBlock.tsx](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/components/AgentTaskBlock.tsx) 已开始在任务卡片里直接显示“已回补会话轨迹 N 条”和命中预览，Agent 页不再只能去上下文卡片里间接查看。
9. [MessageBubble.tsx](/Users/haichao/Desktop/work/51ToolBox/src/components/ai/MessageBubble.tsx)、[ai-store.ts](/Users/haichao/Desktop/work/51ToolBox/src/store/ai-store.ts) 与 [ask-context-snapshot.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/ai/ask-context-snapshot.ts) 已把 transcript fallback 接到 Ask 回答区与 Ask 上下文快照，Ask 侧也能直接看到本轮回补了哪些会话轨迹。
10. 已补充 [assistant-memory.test.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/ai/assistant-memory.test.ts)、[use-agent-execution.test.tsx](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/hooks/use-agent-execution.test.tsx)、[prompt-context.test.ts](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/core/prompt-context.test.ts) 与 [ask-context-snapshot.test.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/ai/ask-context-snapshot.test.ts)，覆盖 transcript fallback + 记忆可解释性链路。
11. [local-agent-bridge.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/cluster/local-agent-bridge.ts)、[cluster-context-snapshot.ts](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/core/cluster-context-snapshot.ts)、[ClusterContextStrip.tsx](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/components/cluster/ClusterContextStrip.tsx) 已把 Cluster 子 Agent 的长期记忆检索与 transcript fallback 命中数/预览回写到会话上下文说明里，Cluster 不再只是“暗中用了回补”。
12. [memory-middleware.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/middlewares/memory-middleware.ts)、[actor-system-store.ts](/Users/haichao/Desktop/work/51ToolBox/src/store/actor-system-store.ts)、[dialog-context-snapshot.ts](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/core/dialog-context-snapshot.ts) 与 [DialogContextStrip.tsx](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/components/actor/DialogContextStrip.tsx) 已把 Dialog 房间内 Actor 最近一次记忆召回/轨迹回补状态接到房间 context strip 与上下文说明面板。
13. [actor-system.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/actor-system.ts)、[types.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/types.ts) 与 [ActorChatPanel.tsx](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/components/actor/ActorChatPanel.tsx) 已进一步把 recall explainability 下沉到消息级：
   - `agent_message / agent_result` 会自动携带本轮 recall 元数据
   - Dialog 房间里可以直接在具体消息下看到“已用记忆 / 已回补轨迹”和命中预览
14. 已补充 [local-agent-bridge.test.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/cluster/local-agent-bridge.test.ts)、[memory-middleware.test.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/middlewares/memory-middleware.test.ts)、[cluster-context-snapshot.test.ts](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/core/cluster-context-snapshot.test.ts)、[dialog-context-snapshot.test.ts](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/core/dialog-context-snapshot.test.ts) 与 [actor-system.test.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/actor-system.test.ts)，覆盖这轮 Cluster / Dialog explainability 改造。
15. 这一流目前还没完全对齐 `openclaw` 的地方，重点剩在：
   - 更强的 durable memory 自动提炼规则
   - 让 `Cluster / Dialog` 的 explainability 继续接到统一 debug report / runtime recovery

### 需要强化的层次

1. Session Notes
2. Durable Memory
3. Candidate Review Queue
4. File Memory
5. Session Transcript Recall

### 需要完成的关键能力

1. 扩展自动 durable memory 规则
   - 不只支持槽位型偏好
   - 还要覆盖长期项目目标、稳定工作流规则、稳定身份背景
2. 回答级记忆引用
   - 记录本轮用了哪些记忆
   - 在 UI 中可查看
3. 检索未命中时要求显式说明“已检查但未命中”
4. 支持 session transcript 作为次级召回源
   - 默认不强注入
   - 仅在 memory_search 高相关但长期记忆不足时回补

### 直接改造文件

1. [memory-store.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/ai/memory-store.ts)
2. [file-memory.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/ai/file-memory.ts)
3. [actor-memory.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/actor-memory.ts)
4. [react-agent.ts](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/core/react-agent.ts)
5. [ai-store.ts](/Users/haichao/Desktop/work/51ToolBox/src/store/ai-store.ts)
6. 记忆管理页和上下文条带 UI

### 验收标准

1. 普通消息不再频繁弹候选
2. “以后默认这样做”类偏好可自动沉淀
3. 回答时可解释用了哪些记忆
4. Ask / Agent / Dialog 都能稳定走记忆检索

### 8.5 改造流 E：Compaction Safeguard 完整化

### 目标

对标 `openclaw` 的 compaction safeguard 与 memory flush 体验。

### 必做能力

1. pre-threshold memory flush
2. identifier policy
3. post-compaction context refresh
4. post-compaction memory sync
5. compaction diagnostics
6. 压缩态 UI

### 具体要求

1. 在接近压缩阈值时先触发静默 flush
   - 不给用户输出
   - 写入 `memory/YYYY-MM-DD.md`
   - 一轮 compaction cycle 只执行一次
2. 压缩后自动从 `AGENTS.md` 回注关键章节
3. 压缩报告必须包含：
   - tokens before / after
   - compacted task count
   - preserved identifiers
   - bootstrap reinjection sections
4. 压缩态在 UI 中明确显示

### 直接改造文件

1. [session-compaction.ts](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/core/session-compaction.ts)
2. [compaction-orchestrator.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/compaction-orchestrator.ts)
3. [bootstrap-context.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/ai/bootstrap-context.ts)
4. [use-agent-execution.ts](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/hooks/use-agent-execution.ts)
5. 相关测试文件

### 验收标准

1. 压缩前完成静默 memory flush
2. 压缩后不忘关键规则和关键文件
3. 不出现无意义的二次紧邻压缩

### 8.6 改造流 F：运行时恢复、停止与等待态重构

### 目标

解决“离开页面回来后过程打不开、停止无效、状态错乱”的问题。

### 当前主要问题

当前 [agent-running-store.ts](/Users/haichao/Desktop/work/51ToolBox/src/store/agent-running-store.ts) 只保存内存态 `abortFn`，页面层恢复能力有限。

### 需要新增的能力

1. 持久化 runtime session state
2. 运行中的 session 重新绑定 stop/abort 能力
3. 等待确认态恢复
4. follow-up queue 恢复
5. Cluster / Dialog 运行态恢复

### 行为要求

1. 用户离开 Agent 页面再回来：
   - 过程折叠还能打开
   - 当前等待阶段正确显示
   - 停止按钮可用
2. 用户退出后重新进入：
   - 如果运行已经结束，看到最终状态
   - 如果仍在等待用户确认，恢复该交互入口
3. 对 Cluster / Dialog 统一恢复策略

### 验收标准

1. 不再依赖页面内内存态才能正确停止
2. 页面重进后状态稳定
3. 待确认交互不会丢

### 8.7 改造流 G：四模式统一

### 目标

让 `Ask / Agent / Cluster / Dialog` 的上下文、记忆、状态表达尽量统一。

### 统一范围

1. 工作区与 handoff
2. 上下文快照结构
3. ingest 结果
4. 调试报告
5. 等待态 / 停止态 / 运行态
6. 权限申请样式

### 具体要求

1. `Ask` 不再自己单独维护一套上下文逻辑
2. `Dialog` Actor middleware 复用统一 assembler
3. `Cluster` 统一 context plan / ingest / debug report 样式
4. 所有模式都能输出一致结构的 `current context`

### 验收标准

1. 模式切换不明显丢上下文
2. 四模式上下文结构一致
3. 用户能在任意模式看到类似的解释信息

### 8.8 改造流 H：UI、解释性与管理中心

### 目标

让用户真正理解系统行为，而不是只能靠开发者推断。

### 重点区域

1. Agent 页面顶部状态区
2. 上下文条带
3. 当前上下文卡片
4. 记忆管理中心
5. 会话列表 / 任务列表
6. 托盘与通知

### 要补的关键体验

1. 当前会话工作区
2. 当前连续性策略
3. 是否继承摘要 / recent steps / files
4. 本轮召回记忆数量与明细入口
5. 是否处于压缩态
6. 是否发生工作区切换
7. bootstrap 截断提示
8. 当前正在等待什么

### 验收标准

1. 用户看得懂这轮为什么和上一轮上下文不同
2. 用户能分辨是继续旧项目还是切新任务
3. 长期记忆不再以打断式弹窗为主

### 8.9 改造流 I：观测、调试与回归体系

### 目标

把当前零散调试能力升级成长期可维护体系。

### 必做项

1. Debug flags 继续扩展
2. 上下文快照持久化
3. compaction diagnostics
4. memory recall diagnostics
5. file regeneration diagnostics
6. 场景级回归测试

### 建议调试开关

1. `context_runtime`
2. `workspace_switch`
3. `memory_pipeline`
4. `memory_recall`
5. `bootstrap_budget`
6. `compaction`
7. `runtime_recovery`

### 验收标准

1. 默认日志足够安静
2. 开启 flag 后能快速定位上下文错误来源
3. 关键回归场景都有测试覆盖

---

## 9. 详细文件改造优先级

### 第一优先级

1. [use-agent-execution.ts](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/hooks/use-agent-execution.ts)
2. [context-runtime-manager.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/context-runtime-manager.ts)
3. [continuity-policy.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/context-runtime/continuity-policy.ts)
4. [bootstrap-context.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/ai/bootstrap-context.ts)
5. [memory-store.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/ai/memory-store.ts)
6. [session-compaction.ts](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/core/session-compaction.ts)

### 第二优先级

1. [file-memory.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/ai/file-memory.ts)
2. [actor-memory.ts](/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/actor-memory.ts)
3. [react-agent.ts](/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/core/react-agent.ts)
4. [agent-store.ts](/Users/haichao/Desktop/work/51ToolBox/src/store/agent-store.ts)
5. [ai-store.ts](/Users/haichao/Desktop/work/51ToolBox/src/store/ai-store.ts)
6. [agent-running-store.ts](/Users/haichao/Desktop/work/51ToolBox/src/store/agent-running-store.ts)

### 第三优先级

1. Ask / Agent / Cluster / Dialog 的 context strip / context card 组件
2. 记忆管理中心
3. 会话列表与工作台
4. 权限和停止交互 UI

---

## 10. 最终验收场景

### 场景 1：大型项目连续开发

用户先让 Agent 分析整个仓库，再让它继续修改多个页面、组件和逻辑。

期望：

1. 不重复从头分析
2. 能延续关键文件、摘要和最近步骤
3. 长会话后仍能继续

### 场景 2：切无关任务

用户分析完大项目后说：“帮我去另一个目录生成一个独立网页文件。”

期望：

1. 不继承旧项目文件集
2. 明确 soft reset 或 fork
3. UI 能解释为什么

### 场景 3：长期偏好记忆

用户说：“以后默认中文回答，先给结论，再列修改点。”

期望：

1. 自动长期保存
2. 下次能召回
3. 不再弹大量候选

### 场景 4：历史回忆

用户问：“我之前让你怎么处理这个模块的？”

期望：

1. 先检索记忆
2. 引用命中内容
3. 没找到时明确说已检查

### 场景 5：退出页面再回来

运行中离开页面后回来。

期望：

1. 过程仍可展开
2. 等待态正确
3. 停止按钮仍有效

### 场景 6：压缩后续跑

连续多轮后自动触发压缩。

期望：

1. 不忘目标
2. 不忘关键文件
3. 不忘 AGENTS 关键规则
4. 不立刻再次无意义压缩

### 场景 7：多模式切换

Ask -> Agent -> Cluster -> Dialog 来回切。

期望：

1. handoff 信息不丢
2. 工作区不飘
3. 当前上下文解释一致

---

## 11. 上线顺序建议

建议分 4 波上线。

### 第一波

1. Context Engine 成型
2. 工作区边界增强
3. Agent 主链路抽干净

### 第二波

1. Ask / Cluster / Dialog 接统一上下文链路
2. 记忆召回升级
3. 回答级记忆引用

### 第三波

1. pre-threshold memory flush
2. compaction safeguard 升级
3. bootstrap budget 与截断说明

### 第四波

1. 恢复与停止能力重构
2. UI 统一
3. 全场景回归和打磨

---

## 12. 风险与控制

### 12.1 风险

1. 一次性重构过大，影响现有功能
2. 四模式链路统一时引入新的状态同步问题
3. 记忆自动化过强，可能引入噪音
4. compaction 过 aggressive，导致上下文丢失
5. 恢复机制做不好会让 stop/abort 更混乱

### 12.2 控制策略

1. 每阶段独立上线
2. 保留 feature flag
3. 每阶段必须跑验收场景
4. 默认关闭高噪音调试输出
5. 不替换原功能，先做并行兼容，再逐步切主链路

---

## 13. 结论

如果后续要真正达到接近 `openclaw` 的体验，重点不是继续零散修点，而是按这份文档完成三件事：

1. 把上下文管理升级成统一 `Context Engine`
2. 把记忆和压缩升级成真正的持续运行系统
3. 把恢复、解释性和四模式一致性补齐

当下面 6 条同时满足时，可以认为本项目已经基本达到目标：

1. 大项目长会话可稳定连续工作
2. 无关任务不会默认继承旧项目
3. 长期记忆默认静默稳定
4. 压缩后仍然可持续工作
5. 离开页面后再回来状态稳定
6. 四模式上下文和权限心智基本统一

后续开发建议以本文件为总施工单，以 [ai-context-memory-full-overhaul-plan.md](/Users/haichao/Desktop/work/51ToolBox/docs/ai-context-memory-full-overhaul-plan.md) 作为上下文与记忆专项文档，不再分散式修补单点问题。
