# Dialog 模式稳内核重构与下一波改造清单

## 1. 文档目的

这份文档用于收敛最近几轮关于 Dialog 模式的结论，统一回答下面几类问题：

- 当前 `Dialog` 稳内核重构到底落地到了什么程度
- 哪些地方已经接近目标，哪些地方仍处于“混合态”
- 为什么主 `agent -> 子 agent` 的协作方式应该继续向 Codex 靠拢
- 工作台抽屉、上下文展示、上下文压缩、压缩后记忆保留，接下来应该怎么改

本文默认把改造目标定义为：

- 内核层：从“房间语义 + plan 兼容层 + 执行引擎”收敛到“显式协作内核 + 显式 parent/child 派工”
- 产品层：用户默认只和主 Agent 对话，子线程默认后台化
- 上下文层：不只是显示 token 估算，而是具备真正的“上下文过长后自动压缩并继续”的能力

---

## 2. 当前状态总结

### 2.1 已经具备的基础

- `src/core/collaboration/` 已存在，`ExecutionContract`、`CollaborationSessionController`、`CollaborationChildSession`、snapshot / persistence / presentation 都已落地。
- 本地 Dialog 已接入 controller，发送链已经走 draft -> sealed contract -> dispatch 主路径。
- IM 已与本地 Dialog 语义分离，运行模式中已存在 `im_conversation`。
- 子任务 / 子会话已经是 runtime 中的一等对象，不再只是 UI 假概念。
- 工具审批已经有 `policy -> auto_review -> human` 三层雏形。

### 2.2 当前仍然是“混合态”

- `ActorSystem` 内部仍深度持有 legacy `dialogExecutionPlan`。
- `ExecutionContract` 目前仍需要和 legacy `DialogExecutionPlan` 相互转换。
- `plannedSpawns` 还是“建议主协调者去 spawn”，不是纯粹的一等 parent -> child 派工对象。
- Dialog 有“早期协作摘要”和 token 估算，但还没有真正的房间级 compaction 闭环。

### 2.3 当前体验层的真实心智模型

现在产品表面上已经更接近下面这个模型：

`用户 -> 主 Agent -> 子 Agent -> 主 Agent 汇总 -> 返回用户`

但底层实际还是：

`用户输入 -> 生成计划建议 -> 给协调者 bootstrap 提示 -> 协调者自行 spawn_task -> 子任务回流`

也就是说，方向已经对了，但还没完全收口成 Codex 式显式派工。

---

## 3. 本轮已经确认的改造项

## 3.1 主 Agent -> 子 Agent 派工内核继续向 Codex 靠拢

### 目标

把当前“建议派工”进一步收敛成“显式派工”：

- 主 Agent 明确决定是否创建子线程
- 子任务成为显式 parent/child runtime 对象
- 子任务结果默认只回流给父 Agent
- 用户默认只看主 Agent，不需要介入子线程判断

### 当前问题

- `plannedSpawns` 仍然是协作计划里的建议项
- `ActorSystem` 仍通过 bootstrap 提示协调者“自己去 spawn”
- 派工动作在产品上不够一等，不够直观

### 要改成什么

- 把 `spawn_task` 语义提升为真正的一等运行时动作
- `plannedDelegations` 保留为允许边界与建议，不再承担“派工本体”的语义
- 子线程创建、延续、关闭、结果回流统一围绕 parent/child run graph 展开
- 主页面不再强调“你正在查看某个子线程”，而是只告诉用户“后台线程正在被主 Agent 复用”

### 重点改造文件

- `src/core/agent/actor/actor-system.ts`
- `src/core/collaboration/session-controller.ts`
- `src/core/collaboration/child-session.ts`
- `src/plugins/builtin/SmartAgent/components/actor/ActorChatPanel.tsx`
- `src/plugins/builtin/SmartAgent/components/actor/actor-chat-panel/WorkspaceDock.tsx`

---

## 3.2 彻底收口 ActorSystem，减少 legacy plan 混合

### 当前问题

- `ActorSystem` 还负责 legacy `dialogExecutionPlan`
- controller 仍需要 `ExecutionContract <-> DialogExecutionPlan` 双向转换
- 执行内核和产品语义还没完全解耦

### 目标状态

- `ActorSystem` 只负责：
  - actor 生命周期
  - 消息收发
  - pending interaction
  - spawned task 生命周期
  - transcript / artifact / upload 记录
- 协作语义统一由 collaboration kernel 负责
- `ExecutionContract` 成为唯一执行契约

### 需要推进的动作

- 弱化并逐步移除 `dialogExecutionPlan` 内部状态
- 让 `ActorSystem` 只做 contract 校验和 runtime enforcement
- 将“计划激活 / finalize / bootstrap / route 语义”从 `ActorSystem` 继续外移

---

## 3.3 统一权限、审批、继承规则

### 当前问题

- `toolPolicy`
- `approvalLevel`
- `trustMode`
- `workspace`
- `middlewareOverrides`
- `roleBoundary`

这些约束现在仍分散在多个层级，尚未形成单一继承源。

### 目标状态

形成统一策略对象，类似：

- `AccessMode = read_only | auto | full_access`
- `ApprovalMode = strict | normal | permissive | off`

并明确 parent -> child 继承规则：

- child 默认不能比 parent 更宽
- reviewer / validator 自动收紧
- executor 继承 parent 上限但不能向上放宽
- 默认禁止 nested spawn，至少第一阶段只允许顶层协调者创建 child session

### 重点改造文件

- `src/core/collaboration/execution-contract.ts`
- `src/core/agent/actor/actor-system.ts`
- `src/core/agent/actor/middlewares/human-approval-middleware.ts`
- `src/core/agent/actor/tool-approval-policy.ts`

---

## 3.4 工作台抽屉需要更大、更像任务中心

### 已完成

本轮已经把 Dialog 工作台抽屉从窄侧栏放大为和任务中心同级的 overlay 宽度：

- 原来：`md:w-[min(420px,calc(100%-1rem))]`
- 现在：`md:w-[min(760px,calc(100%-1rem))]`

修改文件：

- `src/plugins/builtin/SmartAgent/components/actor/actor-chat-panel/WorkspaceDock.tsx`

### 后续仍建议继续优化

- 让“上下文 / 子任务 / 计划”三个密度最高的面板默认走宽模式
- 把上下文页改成更明显的两段结构：
  - 上半部分：当前可继续执行的上下文结论
  - 下半部分：成本分析与细项拆解
- 避免一上来先展示一排高密度 token 卡片，让用户误以为这是调试页而不是协作页

---

## 3.5 Dialog 上下文过长时，需要具备真正的“自动压缩后继续”

### 当前真实情况

#### 当前已经有的能力

- 每个 Actor 默认 middleware 链里有 `SummarizationMiddleware`
- 当 `contextMessages` 逼近预算阈值时，会把旧消息压缩为摘要，只保留最近几条继续执行

也就是说，系统不是完全没有自动压缩。

#### 当前不足

这套能力更像“单次模型调用前的上下文瘦身”，而不是 Codex 式房间级 compaction：

- 没有统一的 `Dialog room compaction state`
- 没有“压缩成功后房间继续运行”的显式生命周期
- 没有把被压缩掉的历史稳定地转存为 Dialog 级结构化记忆
- UI 目前展示的是“早期协作摘要”，但这主要还是摘要展示，不是可持续 reinjection 的完整机制

### 目标状态

Dialog 需要新增房间级 compaction 闭环：

1. 检测房间上下文压力
2. 选取更早的房间消息、子任务进展、产物、上传、交互结论
3. 生成结构化房间摘要
4. 将稳定事实与项目记忆写入 memory store
5. 用“房间摘要 + 最近消息 + 关键工作集 + 子线程检查点”继续后续执行
6. 在 UI 中明确告诉用户：房间已压缩，但上下文已保留并继续

### 建议新增的数据结构

- `DialogRoomCompactionState`
  - `summary`
  - `compactedMessageCount`
  - `compactedSpawnedTaskCount`
  - `compactedArtifactCount`
  - `preservedIdentifiers`
  - `memoryFlushNoteId`
  - `memoryIngestResult`
  - `updatedAt`

### 触发条件建议

- 房间共享工作集超过预算阈值
- 某些 actor 的预计总上下文占用长期超过 budget
- provider 明确返回上下文压力错误
- 长对话持续累积，且旧消息已明显失去逐条保留价值

### 压缩后的 reinjection 建议

下一轮执行不再注入完整旧历史，而是注入：

- 房间级结构化摘要
- 最近未压缩消息
- 当前仍相关的上传、产物、子任务检查点
- 长期记忆命中
- 会话轨迹命中

---

## 3.6 压缩后的记忆如何保留

### 当前已有三层能力

#### 1. 房间摘要

Dialog 现在已经会把较早消息整理成 `DialogContextSummary`，用于：

- 上下文面板展示
- handoff 给 Agent / 其他模式
- 近期上下文提示

#### 2. 长期记忆

- 用户在 Dialog 中输入时，会异步提取记忆候选
- actor 在任务完成后也会自动提取记忆候选

#### 3. 轨迹 / 命中预览

`contextSnapshot` 中已经会保存：

- `memoryRecallAttempted`
- `memoryPreview`
- `transcriptRecallAttempted`
- `transcriptPreview`

### 仍然缺的关键一层

缺少“房间压缩产物 -> 稳定记忆沉淀 -> 之后继续自动回补”的统一闭环。

### 推荐保留策略

压缩后的内容分三类保留：

#### A. Continuity Summary

用于保证当前房间继续执行：

- 当前目标
- 已完成结论
- 当前未完成事项
- 关键文件 / 路径
- 子线程阶段性结果

#### B. Durable Memory

用于跨轮次、跨模式、跨线程复用：

- 用户长期偏好
- 项目稳定背景
- 反复出现的业务术语
- 已确认的工程边界

#### C. Runtime Checkpoints

用于继续接住仍在后台保留的子线程：

- child session 最近结果摘要
- 最近错误
- 当前 next step
- 关联产物路径

### 目标效果

压缩后，系统应能做到：

- 用户不需要重新讲前情
- 主 Agent 不会失去已形成结论
- 后台子线程不会因为房间压缩而完全断掉语义
- 重新进入房间时，能看到“压缩保留了什么”

---

## 3.7 工作台里的“上下文”页需要从“诊断页”升级为“可执行协作页”

### 当前问题

当前上下文页更偏向“token 估算与成本拆解”：

- 对开发者有价值
- 对普通使用者不够直观
- 用户容易问“这个页面到底在干什么”

### 目标状态

优先回答三个问题：

1. 当前房间会沿用什么上下文继续执行
2. 如果上下文很重，系统会怎么处理
3. 已压缩 / 已保留 / 已命中的记忆到底有哪些

### 推荐展示顺序

#### 第一屏：执行层

- 当前会沿用的工作区
- 当前是否有房间摘要
- 当前是否有记忆命中
- 当前是否有开放子线程
- 当前是否存在待回复交互

#### 第二屏：压缩层

- 是否已触发房间压缩
- 压缩了多少消息 / 子任务 / 产物
- 压缩后保留了哪些关键结论
- 下一轮会重新注入哪些内容

#### 第三屏：成本层

- 共享工作集
- 历史记忆
- 运行现场
- 各 agent 的估算占用

这样“上下文”页就不是单纯告诉用户“你超预算了”，而是告诉用户“系统怎么接住这个复杂房间”。

---

## 4. 推荐落地顺序

## 第一阶段：收口当前混合态

1. 继续把 `ActorSystem` 中 legacy `dialogExecutionPlan` 职责外移
2. 将 parent -> child 派工收口为显式 runtime 动作
3. 把权限继承、审批继承统一到 collaboration policy 层

## 第二阶段：补齐房间级上下文能力

4. 为 Dialog 新增 `room compaction state`
5. 打通“房间压缩 -> 记忆沉淀 -> 后续 reinjection”
6. 在工作台上下文页展示 compaction 状态与保留结果

## 第三阶段：完善产品形态

7. 让工作台上下文页从“估算中心”升级为“协作上下文中心”
8. 继续弱化子线程前台感，强调主 Agent 为唯一主入口
9. 在更高层继续推进 `Plan / Build / Review / Explore / Dialog / IM Conversation` 主模式分层

---

## 5. 验收标准

### 派工内核验收

- 用户默认只给主 Agent 发消息
- 主 Agent 显式创建和复用子线程
- 子线程结果默认回父 Agent，不污染主房间
- 用户不需要通过观察子线程来判断下一步

### 上下文压缩验收

- Dialog 在上下文压力过大时可自动房间级压缩
- 压缩后可继续执行，不要求用户重讲前情
- 压缩后的稳定结论可以被后续轮次重新注入
- 长期记忆、轨迹记忆、房间摘要三者职责清晰

### UI 验收

- 工作台抽屉宽度足以承载上下文分析与子任务详情
- 上下文页第一屏就能解释“这个页面的作用”
- 用户能明确看见：
  - 当前沿用了什么上下文
  - 是否发生过压缩
  - 压缩后保留了什么

---

## 6. 一句话结论

当前 Dialog 已经完成了“新协作内核的搭建”，但还没有完成“Codex 式显式派工 + 房间级上下文压缩续跑”的收口。

下一波最值钱的改造，不是继续堆更多面板，而是把这两件事做透：

- 显式 parent -> child 派工线程模型
- Dialog room compaction + memory retention + reinjection 闭环

这两件事做完，Dialog 才会真正从“复杂但有潜力的协作房间”，变成“能长期跑复杂任务、且用户心智清晰的协作系统”。
