# 51ToolBox 对齐 Claude Code 的完整迁移 RFC

## 1. 文档目标

本文档定义 `51ToolBox` 在多 Agent / 强执行 / 长生命周期协作方向上，对齐 `claude-code` 架构的目标形态、能力缺口、模块映射与迁移路线。

这不是一份“某一轮改了什么”的施工记录，而是一份长期有效的迁移基线文档，用来回答：

1. 当前 `51ToolBox` 已经有什么
2. 如果要在能力上真正接近 `claude-code`，还差什么
3. 哪些能力应该迁，哪些能力应该保留本项目自己的实现
4. 应该按什么顺序落地，才能避免大规模重写与系统失稳

---

## 2. 结论摘要

一句话结论：

> `51ToolBox` 已经有较强的 Actor Runtime、Execution Contract、Spreadsheet Structured Delivery 与 IM Runtime 底座，但距离 `claude-code` 级别的“强 Agent 平台”，仍缺少统一运行时内核、Agent 任务模型、Coordinator Mode、Team/Swarm 产品层、执行后端抽象、后台恢复机制和产品化专用 Agent 体系。

当前最合理的路线不是“推翻现有 ActorSystem 重写一套 Claude Code”，而是：

- 保留 `51ToolBox` 的底层优势
- 在其之上补齐 Claude Code 风格的上层运行时与产品化抽象

也就是说：

> 不是替换底盘，而是在现有底盘上补一个更完整的 Agent OS 上层。

---

## 3. 审计范围

本 RFC 基于以下代码范围的定向审计整理而成。

### 3.1 51ToolBox 关键模块

- `src/core/agent/actor/agent-actor.ts`
- `src/core/agent/actor/actor-system.ts`
- `src/core/agent/actor/actor-tools.ts`
- `src/core/agent/actor/dialog-subtask-runtime.ts`
- `src/core/collaboration/execution-contract.ts`
- `src/core/channels/im-conversation-runtime-manager.ts`

### 3.2 Claude Code 关键模块

- `src/QueryEngine.ts`
- `src/tools.ts`
- `src/tools/AgentTool/AgentTool.tsx`
- `src/tasks/LocalAgentTask/LocalAgentTask.tsx`
- `src/coordinator/coordinatorMode.ts`
- `src/tools/shared/spawnMultiAgent.ts`
- `src/utils/swarm/backends/registry.ts`
- `src/tools/TeamCreateTool/TeamCreateTool.ts`
- `src/tools/SendMessageTool/SendMessageTool.ts`
- `src/tools/AgentTool/built-in/planAgent.ts`
- `src/tools/AgentTool/built-in/verificationAgent.ts`

---

## 4. 当前 51ToolBox 的真实优势

先明确一点：`51ToolBox` 不是从零开始。

### 4.1 已经具备的底座能力

#### A. Actor Runtime

`51ToolBox` 已经有一套成熟的 Actor 协作底座：

- `AgentActor`
- `ActorSystem`
- `DialogSubtaskRuntime`

这意味着当前系统已经具备：

- spawn / 子任务生命周期
- follow-up / takeover
- timeout / idle lease / budget
- structured subtask result 回流
- task-level trace / timeline 事件

#### B. Execution Contract

`51ToolBox` 当前的 `ExecutionContract` 明显强于多数通用 Agent 产品：

- 明确的 actor roster
- allowed spawn pairs
- allowed message pairs
- planned delegations
- executionStrategy
- structuredDeliveryManifest

这让它天然适合：

- IM 会话审批
- 企业内部多方协作
- 房间式协作图约束

#### C. Structured Spreadsheet Delivery

这是 `51ToolBox` 的独特优势：

- `structured-delivery-strategy`
- `dynamic-spreadsheet-strategy`
- source grounding
- scoped source shard
- quality gate
- deterministic host export

这部分不但不比 `claude-code` 弱，在表格交付这个垂直场景上反而更强。

#### D. IM Runtime

`im-conversation-runtime-manager` 已经把：

- topic
- approval
- runtime persistence
- external channel
- background topic
- active contract

连成了一条完整链路。

对于企业 IM 场景，这一层是 `51ToolBox` 的核心资产，不应被 `claude-code` 风格的 CLI 运行时替代。

---

## 5. Claude Code 的强点到底是什么

`claude-code` 的“强”，不主要在 prompt，而在运行时抽象。

### 5.1 统一运行时内核

核心是 `QueryEngine`：

- 持有会话消息
- 负责多轮 query 生命周期
- 统一 tool loop
- 统一 transcript 持久化
- 统一 retry
- 统一 compact / snip
- 统一 structured output enforcement

这使它的 REPL、SDK、headless、bridge 都可以共用同一个执行内核。

### 5.2 把 agent 当 task 管理

`LocalAgentTask` 不是简单的 “spawn 记录”，而是一等任务对象，包含：

- taskId
- 状态
- result / error
- progress
- recent activities
- pending messages
- foreground / background
- output file
- completion notification

### 5.3 协调者与执行者真分层

`coordinatorMode` 不是提示词补丁，而是：

- coordinator 专属系统提示
- worker 能力上下文
- worker result 协议
- 协调者工作守则

### 5.4 Team / Swarm 抽象

Claude Code 不是只会“开一个子 agent”，而是可以：

- create team
- maintain teammate roster
- route by teammate name
- send direct message
- broadcast
- choose backend

### 5.5 可替换的执行后端

多 agent 执行后端被抽象成统一接口，可运行在：

- in-process
- tmux
- iTerm2 pane
- remote

### 5.6 产品化专用 Agent

它有内建的：

- `plan`
- `verification`
- `explore`
- `general purpose`

这些不是单纯 prompt 模板，而是：

- 工具限制
- 角色约束
- 输出协议
- 背景/同步策略

---

## 6. 对齐 Claude Code 还差什么

下面按层说明缺口。

### 6.1 缺统一的 QueryEngine 级运行时内核

#### Claude Code 现状

`QueryEngine` 统一管理：

- message store
- tool loop
- streaming
- retry
- transcript
- system prompt construction
- compact / snip

#### 51ToolBox 当前现状

这些逻辑大量分散在：

- `agent-actor.ts`
- middlewares
- transcript
- runtime manager
- validator / repair loop

#### 缺口判断

这是当前最大的结构性缺口之一。

`AgentActor` 目前承担了过多职责，导致：

- 本地 dialog 与 IM runtime 难以共享完全一致的运行逻辑
- 重试、fallback、收尾语义容易漂移
- 后续引入 background/remote agent 时难以复用

#### 迁移目标

新增统一内核层：

- `src/core/agent/runtime/query-engine.ts`
- `src/core/agent/runtime/runtime-message-store.ts`
- `src/core/agent/runtime/runtime-tool-loop.ts`
- `src/core/agent/runtime/runtime-retry-policy.ts`
- `src/core/agent/runtime/runtime-transcript-bridge.ts`

目标是把：

- `AgentActor` 变成 orchestration shell
- 真正的消息循环和 tool loop 统一收进 runtime kernel

---

### 6.2 缺“一等任务模型”的 Agent Lifecycle System

#### Claude Code 现状

`LocalAgentTask` 让每个 agent 都变成一个真正的任务对象。

#### 51ToolBox 当前现状

当前主要有：

- `SpawnedTaskRecord`
- `DialogStructuredSubtaskResult`
- runtime announce / trace / follow-up

这些已经足够支持协作，但还不够构成“任务操作系统”。

#### 缺什么

- 稳定 taskId 作为 UI 主索引
- foreground/background 切换
- task output sink
- recent activity summary
- token/tool-use progress tracker
- pending message queue for a running agent
- attach / detach / resume

#### 迁移目标

以 `task-center` 为基础扩展：

- `AgentTask`
- `AgentTaskManager`
- `AgentTaskProgress`
- `AgentTaskNotification`
- `AgentTaskOutputSink`

让：

- local child
- background child
- remote child
- verification child

都进入统一任务中心。

---

### 6.3 缺真正的 Coordinator Mode

#### Claude Code 现状

`coordinatorMode.ts` 明确规定：

- 协调者角色
- Worker 工具能力
- Worker 结果通知协议
- 协调者在何时 spawn、何时 synthesize、何时 stop worker

#### 51ToolBox 当前现状

虽然当前系统已经有 coordinator actor 和 execution contract，但缺少：

- coordinator 专属工具池
- coordinator 专属系统提示规范
- coordinator 专属 worker result 协议
- 主 Agent 汇总阶段的标准模式化约束

#### 迁移目标

新增：

- `src/core/agent/actor/coordinator-mode.ts`
- `src/core/agent/actor/coordinator-tool-pool.ts`
- `src/core/agent/actor/coordinator-result-protocol.ts`

使 coordinator：

- 不再只是“默认主 actor”
- 而是一个明确模式

---

### 6.4 缺 Built-in Specialized Agents

#### Claude Code 现状

使用产品化内建 agent：

- `plan`
- `verification`
- `explore`
- `general purpose`

#### 51ToolBox 当前现状

当前更偏向：

- `worker_profile`
- `executionIntent`
- `roleBoundary`

这能限制工具与执行意图，但还不是完整“角色产品”。

#### 缺口判断

这会导致：

- 不同角色行为靠 prompt 拼接
- 验证/规划/探索能力不可视化
- UI / 任务中心 / runtime 很难对角色做稳定识别

#### 迁移目标

新增 built-in agent 定义层：

- `plan_agent`
- `verification_agent`
- `explore_agent`
- `implementation_agent`
- `spreadsheet_generation_agent`
- `review_agent`

建议目录：

- `src/core/agent/definitions/builtin/*`

每个 agent 定义包含：

- 何时使用
- 工具白/黑名单
- 输出协议
- 默认执行模式
- 默认模型 / reasoning level

---

### 6.5 缺 Team / Swarm 产品层

#### Claude Code 现状

除了 `AgentTool` 之外，还有：

- `TeamCreateTool`
- `TeamDeleteTool`
- `SendMessageTool`
- team file / mailbox / teammate roster

#### 51ToolBox 当前现状

当前的 `send_message` 更接近 actor 间通信，而不是 team 协作产品层。

没有稳定的：

- team registry
- teammate roster
- mailbox
- named teammate routing
- broadcast API

#### 迁移目标

新增：

- `src/core/agent/swarm/team-registry.ts`
- `src/core/agent/swarm/team-context.ts`
- `src/core/agent/swarm/team-mailbox.ts`
- `src/core/agent/swarm/teammate-directory.ts`
- `src/core/agent/swarm/teammate-routing.ts`

以及工具：

- `create_team`
- `delete_team`
- `send_team_message`
- `broadcast_team_message`

---

### 6.6 缺执行后端抽象

#### Claude Code 现状

通过 swarm backend registry 统一管理：

- in-process
- tmux
- iTerm2
- remote

#### 51ToolBox 当前现状

当前基本还是：

- in-process actor runtime

#### 缺口判断

这意味着：

- 多 agent 不能自然扩展到多终端/多隔离环境
- 无法选择不同后端满足不同任务类型
- 也缺少 worktree / remote 的执行承载层

#### 迁移目标

新增统一后端接口：

- `AgentExecutorBackend`
- `InProcessBackend`
- `WorktreeBackend`
- `RemoteBackend`
- 可选 `TmuxBackend`

建议目录：

- `src/core/agent/backends/*`

---

### 6.7 缺 worktree / remote isolation

#### Claude Code 现状

spawn agent 时可选择：

- `worktree`
- `remote`

并带清理和保留逻辑。

#### 51ToolBox 当前现状

当前 child 大多共享：

- 同一工作区
- 同一进程
- 同一文件视图

#### 缺口判断

这会限制：

- 实现与验证并行
- 多 child 修改文件时的隔离
- 高风险任务的安全执行

#### 迁移目标

新增：

- `src/core/agent/isolation/worktree.ts`
- `src/core/agent/isolation/remote.ts`
- `src/core/agent/isolation/artifact-sync.ts`

优先做：

1. in-process
2. worktree
3. remote

tmux / iTerm 作为扩展项。

---

### 6.8 缺统一任务通知协议

#### Claude Code 现状

子任务完成后，通过统一的 task notification 回灌：

- task_id
- status
- summary
- result
- usage
- output file

#### 51ToolBox 当前现状

已有 child result 回流，但协议仍然更偏 runtime 内部事件，不是完整的“任务通知层”。

#### 迁移目标

统一为：

- `task_started`
- `task_progress`
- `task_completed`
- `task_failed`
- `task_aborted`
- `task_notification`

作为：

- task-center
- IM runtime
- actor timeline
- future SDK/desktop bridge

共享的消息协议。

---

### 6.9 缺 background / resume 生命周期

#### Claude Code 现状

`AgentTool` 支持：

- foreground spawn
- background async spawn
- 任务完成通知
- output file
- 后续继续 / resume

#### 51ToolBox 当前现状

当前已经有：

- `spawn_task`
- `wait_for_spawned_tasks`
- `follow_up_buffered`
- `child_terminal_result_received`

但还没有完整的：

- detach / attach
- background execution registry
- async output sink
- resume API

#### 迁移目标

新增：

- `BackgroundAgentRegistry`
- `AgentResumeService`
- `AgentOutputSink`
- `AgentForegroundAttachmentState`

---

### 6.10 缺验证工作流产品化

#### Claude Code 现状

`verificationAgent` 是成熟的验证角色，具备：

- 独立工具约束
- 必须给 PASS / FAIL / PARTIAL verdict
- 明确的验证策略和输出格式

#### 51ToolBox 当前现状

当前已有：

- reviewer / validator boundary

但仍偏底层约束，不是“验证产品层”。

#### 迁移目标

补齐：

- verification agent definition
- verification evidence schema
- verdict protocol
- 和 task-center / publish flow / approval flow 的联动

---

## 7. 当前 51ToolBox 应保留、不应被覆盖的部分

迁移时必须注意，不是所有能力都该替换成 Claude Code 风格。

### 7.1 Structured Delivery 必须保留

`51ToolBox` 的：

- source grounding
- structured delivery manifest
- scoped source shard
- quality gate
- deterministic host export

在 spreadsheet 交付场景下比 Claude Code 更强，应当保留。

### 7.2 Execution Contract 必须保留

Claude Code 的协作更偏开放式 runtime；  
`51ToolBox` 的 `ExecutionContract` 更适合企业协作、审批与 IM 场景。

### 7.3 IM Runtime 必须保留

`IMConversationRuntimeManager` 是 `51ToolBox` 的核心资产，不应让位于 CLI-first 的会话模型。

---

## 8. 推荐目标架构

建议把目标架构拆成 7 层。

### 8.1 Runtime Kernel

- QueryEngine
- message store
- tool loop
- retry policy
- transcript bridge

### 8.2 Coordination Layer

- coordinator mode
- execution contract
- structured delivery planner
- repair / synthesis policy

### 8.3 Agent Lifecycle Layer

- AgentTask
- AgentTaskManager
- AgentTaskProgress
- AgentTaskNotification

### 8.4 Swarm Layer

- team registry
- teammate routing
- mailbox
- broadcast
- team context

### 8.5 Isolation Layer

- in-process backend
- worktree backend
- remote backend

### 8.6 Agent Definition Layer

- built-in specialized agents
- worker profile defaults
- tool presets

### 8.7 UI / Channel Layer

- local dialog
- IM runtime
- task-center
- swarm/team UI

---

## 9. 模块映射表

| Claude Code | 51ToolBox 目标模块 |
|---|---|
| `QueryEngine.ts` | `src/core/agent/runtime/query-engine.ts` |
| `tools.ts` | `src/core/agent/runtime/tool-pool.ts` |
| `coordinatorMode.ts` | `src/core/agent/actor/coordinator-mode.ts` |
| `AgentTool.tsx` | `src/core/agent/tools/agent-task-tool.ts` |
| `LocalAgentTask.tsx` | `src/core/task-center/agent-task-manager.ts` |
| `SendMessageTool.ts` | `src/core/agent/swarm/send-agent-message.ts` |
| `TeamCreateTool.ts` | `src/core/agent/swarm/create-team.ts` |
| `spawnMultiAgent.ts` | `src/core/agent/swarm/spawn-agent.ts` |
| `swarm/backends/registry.ts` | `src/core/agent/backends/registry.ts` |
| `planAgent.ts` | `src/core/agent/definitions/builtin/plan-agent.ts` |
| `verificationAgent.ts` | `src/core/agent/definitions/builtin/verification-agent.ts` |

---

## 10. 分阶段迁移路线

### Phase 1：抽 QueryEngine 内核

目标：

- 把 `AgentActor` 从“大一统执行器”拆成“编排器 + 统一运行时内核调用者”

交付物：

- `query-engine.ts`
- `runtime-message-store.ts`
- `runtime-tool-loop.ts`
- `runtime-retry-policy.ts`
- `runtime-transcript-bridge.ts`

验收：

- 本地 dialog 和 IM runtime 共用同一内核
- 工具循环和重试逻辑统一

### Phase 2：建立 AgentTask 系统

目标：

- 让 child / background / remote agent 都进入统一任务中心

交付物：

- `AgentTask`
- `AgentTaskManager`
- `AgentTaskProgress`
- `AgentTaskNotification`

验收：

- 每个 agent 都有稳定 taskId
- UI 能展示 agent task 列表与状态

### Phase 3：引入 Coordinator Mode

目标：

- 把主协调者模式化，而不是靠 prompt 拼接

交付物：

- coordinator prompt/profile
- coordinator tool pool
- worker result protocol

验收：

- 主 Agent 与 worker 拥有清晰不同的运行策略

### Phase 4：引入 Specialized Agents

首批建议：

- plan
- verification
- explore
- implementation
- spreadsheet-generation
- review

验收：

- Agent 定义可被任务中心、UI、runtime 识别
- 不同 agent 有稳定的工具限制和输出契约

### Phase 5：补 Team / Swarm 抽象

交付物：

- team registry
- named teammate routing
- mailbox
- broadcast

验收：

- 可创建 team
- 可按 teammate 名称发消息
- 可广播

### Phase 6：引入隔离执行后端

优先顺序：

1. in-process backend
2. worktree backend
3. remote backend

验收：

- 不同 agent 可运行在不同隔离模式
- worktree 生命周期可控

### Phase 7：补齐 background / resume

验收：

- agent 可后台执行
- 主线程不必阻塞等待
- agent 可恢复、继续、附着

### Phase 8：收口 fallback / reliability

这一阶段专门解决运行时稳定性问题，包括：

- fallback policy
- queue drain guarantees
- synthesis failover
- host export success lock
- API / streaming resilience

---

## 11. 优先级建议

### P0

- QueryEngine 内核
- AgentTask 模型
- Coordinator Mode
- Built-in specialized agents

### P1

- Team / Swarm
- named teammate messaging
- background / resume
- worktree backend

### P2

- remote backend
- tmux / iTerm backend
- richer swarm UI

---

## 12. 风险与迁移边界

### 12.1 不建议一次性重写

原因：

- `51ToolBox` 已经有成熟的 Actor Runtime 与 IM Runtime
- 一次性替换底层会把现有稳定能力一起打散

### 12.2 应避免覆盖 51ToolBox 优势能力

尤其不要在迁移过程中削弱：

- structured spreadsheet delivery
- execution contract
- IM conversation runtime

### 12.3 最大风险

迁移中最容易出现的问题：

- Runtime 重复实现，形成两套执行内核
- AgentTask 与 SpawnedTaskRecord 双轨并存太久
- Team/Swarm 与 ExecutionContract 出现职责重叠
- 背景任务与 IM runtime 的完成通知语义不一致

---

## 13. 最终推荐策略

推荐策略不是：

- “重写成 Claude Code”

而是：

- “保持 `51ToolBox` 的 Actor / Contract / Spreadsheet / IM 底座不动”
- “在其上补齐 Claude Code 风格的 Agent OS 上层”

最终目标形态应是：

> `51ToolBox = Claude Code 风格的 Agent Runtime Product Layer + 51ToolBox 自己的协作合同与结构化交付底座`

这是最稳妥、也最符合当前代码现实的路线。

---

## 14. 下一步建议

如果要开始正式落地，建议下一份文档不要再写成“分析稿”，而是进入：

### 《Phase 1 QueryEngine 与 AgentTask 迁移设计》

它应该直接定义：

- 目录结构
- 核心接口
- 状态模型
- 对现有 `AgentActor` / `ActorSystem` 的侵入点
- 首批替换步骤

这会是从 RFC 进入实施阶段的第一份工程设计文档。
