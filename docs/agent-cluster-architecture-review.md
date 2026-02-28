# Agent Cluster 架构 / 逻辑 / 设计 审查报告

> 审查范围：`src/core/agent/cluster/*`、`ClusterPanel`、`cluster-store`、`active-orchestrator`、全局浮窗与 AICenter 集成。  
> 结论按「架构 / 逻辑 / 设计」分类，并标注严重程度（Critical / Medium / Low / 建议）。

---

## 一、架构层面

### 1.1 整体流程（清晰）

- **Plan → Approval(可选) → Dispatch(拓扑分层并行) → Review-Fix(可选) → Aggregate** 流程清晰，职责分明。
- **ClusterMessageBus** 作为 Blackboard + Pub/Sub 抽象合理，本地零依赖，便于后续扩展远程转发。
- **AgentBridge** 抽象（Local / MCP / HTTP）使本地与远程 Agent 统一入口，扩展性好。

### 1.2 模块级「活跃编排器」与 UI 解耦（合理）

- **active-orchestrator.ts** 用模块级变量保存当前运行的 `ClusterOrchestrator`，使「离开 Cluster 页再回来」不中断执行，设计正确。
- **ClusterPanel** 卸载时只做 UI 侧清理（如审批 Promise reject），不 abort 编排器；状态通过 zustand 持久化，重新挂载时从 store 恢复并同步 `busy`，逻辑一致。

### 1.3 单例活跃编排器（Medium）

- **问题**：`active-orchestrator` 仅保存**一个** `ActiveEntry`。若用户快速连续发起两个集群任务，后者会覆盖前者，前者失去「快速返回」入口且其 session 仍可能在 store 中处于 running 状态，易造成状态不一致。
- **建议**：改为「当前仅允许一个集群任务在跑」的明确约束（UI 在 busy 时禁用「运行」），或在文档/UI 中明确说明；若未来支持多任务并行，需改为 `Map<sessionId, ActiveEntry>` 并让浮窗/列表能区分多任务。

### 1.4 cluster-store 持久化策略（合理）

- 仅持久化 `status === "done" | "error"` 的 session，且对 `instance.result`、`finalAnswer`、`steps` 做截断，避免存储膨胀，设计合理。
- `partialize` 中 `agentInstances: []` 避免与 `sessions[].instances` 重复，正确。

### 1.5 状态流（清晰）

- **cluster-store**：sessions / currentSessionId / 增删改查。
- **ClusterOrchestrator**：内部 `instances` Map + `messageBus`，通过 `onStatusChange` / `onInstanceUpdate` / `onProgress` 回写 store。
- **ClusterPanel**：只读 store + 调用 `createSession`、`updateSession`、`updateInstance`（通过回调间接），不直接持有编排器引用（引用在 active-orchestrator），数据流清晰。

---

## 二、逻辑层面

### 2.1 规划阶段 JSON 与 fallback（健壮）

- 支持多种字段名（`steps`/`tasks`/`plan`、`description`/`task`、`depends_on`/`dependencies`、`output_key`/`outputKey`）。
- `repairJsonString` 处理 markdown 包裹、尾逗号等；空 steps 时 fallback 单步 researcher，避免崩溃。

### 2.2 parallel_split 强制无依赖（正确）

- `planPhase` 中若 `planMode === "parallel_split"` 会清空所有步骤的 `dependencies` 并清空 `inputMapping`，与「并行分治」语义一致。

### 2.3 依赖失败传递（正确）

- `executeStep` 中通过 `isErrorResult` 识别前置错误，全部依赖失败则跳过并写入 error；部分失败则注入警告到 task 文案，逻辑正确。

### 2.4 拓扑排序环路（已降级处理）

- `topologicalSort` 在出现未解析依赖（如环路）时打 `console.warn` 并将剩余步骤压入同一层并行执行，避免死循环；`validatePlan` 中 `hasCycle` 会在计划验证阶段拒绝含环 DAG，双重保障。

### 2.5 Review-Fix 与实例查找（正确）

- `getLatestInstanceForStep(stepId, "done")` 按 `startedAt` 取最新实例，避免重试后误用旧实例，Review-Fix 循环逻辑正确。

### 2.6 超时与取消（正确）

- `ClusterOrchestrator` 内部 `internalAbort` 与外部 `options.signal` 组合，`execute` 内 `setTimeout` 到点调用 `internalAbort.abort` 和 `abortBridges()`，各阶段使用 `this.signal`，超时能传导到 AI 调用与 bridge。

### 2.7 汇总阶段长度保护（正确）

- `aggregatePhase` 中按步骤数动态计算 `maxPerStep`，对单步结果截断，总长约 12000 字符上限，避免上下文溢出。

### 2.8 LocalAgentBridge 与 builtin tools（正确）

- 每次 `run` 调用 `getBuiltinTools(askUser)` 新实例并 `resetPerRunState()`，无跨会话/跨并发共享状态，并发安全。

---

## 三、设计 / 体验层面

### 3.1 Human-in-the-Loop 审批（合理）

- `onPlanApproval` 可选；审批期间组件卸载会 reject 当前 Promise，避免悬空等待，设计合理。

### 3.2 模式记忆与全局浮窗（已落实）

- AICenter 当前 tab 存于 `app-store.aiCenterMode`，离开再进仍为上次模式。
- 集群运行中时，全局 `ClusterFloatingIndicator` 在任意页面展示，点击即 `setAiCenterMode("cluster")` + `pushView("ai-center")`，行为符合预期。

### 3.3 会话卡片展示模式（已落实）

- Session 创建时写入 `mode`，会话卡片展示「并行」/「协作」标签，与 `ClusterSession.mode` 一致。

### 3.4 addInstanceStep 未被使用（Low）

- **cluster-store** 提供 `addInstanceStep`，但当前编排器只通过 `onInstanceUpdate` 整实例更新，未调用 `addInstanceStep`。若未来希望「步骤级增量写入」可启用；否则可视为冗余 API 或保留作扩展。

### 3.5 ClusterPanel 输入框 mode 与 session.mode（一致）

- 当前会话的「模式」由创建时全局的 `mode`（并行/协作）决定并写入 `session.mode`；新会话再次使用当前全局 `mode`，逻辑一致。若未来支持「单会话独立模式」，需在 UI 上区分「全局默认」与「本会话覆盖」。

### 3.6 MCP Bridge 单次工具调用（已存在实现）

- MCP 桥当前按「任务级」与 MCP 通信（如整段任务交给远程），若 MCP 侧是「单次 tool call」语义，需在协议层约定好；当前架构可支持，属集成与配置问题而非架构缺陷。

---

## 四、潜在问题与建议汇总

| 严重程度 | 项 | 说明 |
|----------|----|------|
| **Medium** | 单例活跃编排器 | 仅支持一个运行中集群，快速连续发起会覆盖；建议 UI 在 busy 时禁用「运行」或文档说明，或未来改为多任务 Map。 |
| **Low** | addInstanceStep 未使用 | store 有此 API 但编排器未用；可保留作扩展或删除以减少混淆。 |
| **建议** | 错误上报与日志 | 关键路径（如 plan 解析失败、validatePlan 失败、aggregate 失败）可增加结构化错误上报或日志，便于排查。 |
| **建议** | 进度事件与 UI | 已有 `onProgress` 与多种事件类型；若 UI 需要「进度条/阶段展示」，可基于 `step_started`/`step_completed`/`aggregation_started` 等做细粒度展示。 |

---

## 五、结论

- **架构**：Plan → Approval → Dispatch → Review-Fix → Aggregate 清晰；MessageBus、Bridge、active-orchestrator 与 store 职责分明，扩展性良好。
- **逻辑**：规划解析、并行分治强制、依赖失败传递、拓扑与环路处理、超时/取消、汇总长度保护、Review-Fix 实例查找、builtin tools 并发等均正确或已加固。
- **设计**：模式记忆、全局浮窗、会话模式展示、人审与卸载安全已落实；仅「单例活跃编排器」需在产品上明确约束或后续扩展多任务。

整体实现质量高，未发现 Critical 级架构或逻辑缺陷；上述 Medium/Low 与建议可在迭代中按需处理。
