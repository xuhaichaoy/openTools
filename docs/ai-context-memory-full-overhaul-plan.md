# AI 助手上下文与长期记忆全量改造方案

基于当前 `HiClow` 实现、近期已完成的改动，以及对 `openclaw` 大型项目 Agent 处理方式的对比整理。

相关文档：

- [AI 长期记忆说明](./ai-long-term-memory.md)
- [AI 助手对标 OpenClaw 体验开发总方案](./ai-openclaw-parity-development-roadmap.md)

---

## 1. 文档目标

这份文档不是概念讨论，而是后续可以直接照着施工的全量改造方案。

目标有 5 个：

1. 把当前 AI 助手从“快照式 prompt 组装”为主，升级为“上下文运行时 + 记忆 + 压缩”的持续会话体系。
2. 解决大型项目场景里最核心的 3 个问题：
   - 上下文容易黏住旧项目
   - 会话越长越容易退化
   - 长期记忆体验不稳定、噪音多
3. 让 `Ask / Agent / Cluster / Dialog` 四个模式在“上下文、记忆、权限、工作区”上具备统一心智。
4. 在保持当前项目结构和交互风格的前提下，吸收 `openclaw` 的可借鉴做法，但不做生搬硬套。
5. 把后续改造拆成可渐进落地的阶段，避免一次性重构把当前功能打崩。

---

## 2. 当前基线判断

### 2.1 已经具备的能力

当前项目已经不再是“纯聊天框 + 一次性 prompt”了，已经有以下基础：

1. 有工作区 bootstrap 上下文：
   - `src/core/ai/bootstrap-context.ts`
2. 有会话级历史压缩：
   - `src/plugins/builtin/SmartAgent/core/session-compaction.ts`
3. 有长期记忆工具与语义召回：
   - `src/core/agent/actor/actor-memory.ts`
   - `src/core/ai/memory-store.ts`
4. 有会话级 `workspaceRoot` 持久化与切换隔离：
   - `src/store/agent-store.ts`
   - `src/plugins/builtin/SmartAgent/hooks/use-agent-execution.ts`
5. 有运行时兜底规则，要求记忆相关问题先走 `memory_search / memory_get`：
   - `src/plugins/builtin/SmartAgent/core/react-agent.ts`

### 2.2 当前本质上仍然是什么

虽然已经有会话摘要、工作区根目录和长期记忆，但当前核心仍然是：

- 每次发送消息时，重新拼一份 prompt 快照
- 由执行层临时决定本轮带哪些历史
- 上下文的生命周期更多存在于 UI/Hook 层，而不是独立的上下文运行时

因此当前最准确的判断是：

- 不是纯快照
- 但仍然是 `snapshot-first`
- 还不是 `context-engine-first`

### 2.3 当前距离 openclaw 的主要差距

差距不是“模型差”，也不是“工具不够多”，而是下面 6 类系统能力：

1. 缺少独立的上下文运行时生命周期
2. 工作区绑定仍偏推断，缺少强约束
3. 会话压缩仍偏单次摘要，缺少 safeguard 机制
4. 长期记忆还没有真正做到“静默、稳定、持续”
5. 模式之间上下文和权限心智仍不统一
6. 缺少面向长期运行的恢复、调试、状态可解释性

---

## 3. 总体改造原则

后续所有实现统一遵守下面 8 条原则。

### 3.1 Workspace First

只要任务存在明确工作区，就优先以工作区为第一边界，而不是以“当前聊天历史”为第一边界。

### 3.2 Context Runtime First

上下文的决定权不应分散在多个 Hook 和组件里，而应由独立的上下文运行时统一管理：

- 本轮该继承什么
- 该丢掉什么
- 是否需要分叉会话
- 是否需要压缩
- 是否需要写入长期记忆

### 3.3 Memory Silent by Default

长期记忆默认应是“自动筛选、自动入库、可追溯审查”，不是每轮弹一个候选框让用户点。

### 3.4 Session Note != Long-Term Memory

必须明确分成三层：

1. 短期运行上下文
2. 会话笔记 / 会话摘要
3. 长期记忆

这三层不能混在一起。

### 3.5 Compaction Must Preserve Continuity

压缩不是简单截断历史，而是要保证压缩后仍然保留：

- 当前目标
- 关键文件
- 已做决策
- 风险和失败
- 关键标识符
- 需要重新注入的启动规则

### 3.6 Mode Consistency

`Ask / Agent / Cluster / Dialog` 在下列方面必须尽量统一：

- 工作区识别
- 记忆召回规则
- 权限申请方式
- 运行状态表达
- 会话延续策略

### 3.7 Observable by Design

用户和开发者都应该能看到：

- 本轮到底用了哪些上下文
- 为什么切到了新工作区
- 为什么压缩了
- 为什么触发了长期记忆
- 为什么没有继续上轮大型项目

### 3.8 Progressive Rollout

不做一次性大爆炸重构。每一步都要能单独上线、单独验证、单独回退。

---

## 4. 目标架构

目标不是照抄 `openclaw`，而是在当前项目里形成一套更适合 `HiClow` 的轻量版上下文引擎。

### 4.1 目标链路

```text
用户输入
  -> Task Scope Resolver
  -> Session Continuity Policy
  -> Context Runtime Manager
  -> Prompt Assembler
  -> ReAct / Actor / Cluster 执行
  -> Turn Ingest
  -> Memory Flush / Session Notes / Compaction
  -> Index Sync / UI 状态刷新
```

### 4.2 核心组件

#### A. Task Scope Resolver

负责判断这轮任务到底属于哪个范围：

- 继续当前工作区
- 切换到新工作区
- 没有工作区，仅是泛任务
- 属于当前项目，但切换到新子目录
- 和当前会话完全无关，应建议开新分支

#### B. Session Continuity Policy

负责决定本轮是：

- 继承历史
- 仅继承最近任务
- 继承历史摘要但不继承原始步骤
- 直接软重置
- 自动分叉成新会话

#### C. Context Runtime Manager

这是本次改造的核心。它负责统一管理：

- 当前有效工作区
- 当前可继承上下文
- 需要注入的 bootstrap 文件
- 会话摘要
- 召回的长期记忆
- 当前回合的运行痕迹

#### D. Durable Memory Pipeline

负责长期记忆的提取、过滤、写入、召回、重排与审查。

#### E. Compaction Service

负责在上下文过大时：

- 触发预压缩记忆写入
- 生成高质量结构化摘要
- 保留关键标识符
- 重新注入 AGENTS 启动规则
- 通知 UI 当前会话已进入压缩态

---

## 5. 全量修改范围

本次全量改造分成 8 个改造流。

---

## 6. 改造流 A：上下文运行时重构

### 6.1 目标

把目前散落在 `use-agent-execution.ts`、`prompt-context.ts`、`session-compaction.ts` 等处的上下文决策，收拢为一个独立的运行时层。

### 6.2 新增模块

建议新增目录：

```text
src/core/agent/context-runtime/
  types.ts
  scope-resolver.ts
  continuity-policy.ts
  context-runtime-manager.ts
  context-assembler.ts
  context-ingest.ts
  compaction-orchestrator.ts
  debug-report.ts
```

### 6.3 新增核心类型

建议新增：

```ts
interface TaskScopeSnapshot {
  workspaceRoot?: string;
  repoRoot?: string;
  attachmentPaths: string[];
  imagePaths: string[];
  handoffPaths: string[];
  queryIntent: "coding" | "research" | "delivery" | "general";
  unrelatedToPrevious: boolean;
}

interface ContinuityDecision {
  strategy:
    | "inherit_full"
    | "inherit_summary_only"
    | "inherit_recent_only"
    | "soft_reset"
    | "fork_session";
  reason:
    | "same_workspace"
    | "workspace_switch"
    | "query_topic_switch"
    | "context_pressure"
    | "explicit_new_task";
  carrySummary: boolean;
  carryRecentSteps: boolean;
  carryFiles: boolean;
  carryHandoff: boolean;
}

interface RuntimeContextPack {
  workspaceRoot?: string;
  bootstrapPrompt?: string;
  sessionSummaryMessages: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  recalledMemoryPrompt?: string;
  knowledgeMessages: Array<{ role: "user" | "assistant"; content: string }>;
  currentFiles: string[];
  contextReport: string[];
}
```

### 6.4 需要修改的现有文件

1. `src/plugins/builtin/SmartAgent/hooks/use-agent-execution.ts`
   - 从“直接做上下文拼装”降级为“调用 Context Runtime Manager”
2. `src/plugins/builtin/SmartAgent/core/prompt-context.ts`
   - 改成纯展示层，不再自己推断太多信息
3. `src/plugins/builtin/SmartAgent/core/session-compaction.ts`
   - 只保留压缩和结构化摘要逻辑，不再承担完整上下文决策
4. `src/store/agent-store.ts`
   - 增加更多会话级上下文字段
5. `src/core/agent/cluster/local-agent-bridge.ts`
   - Cluster 子 Agent 也走同一上下文运行时
6. `src/core/agent/actor/middlewares/prompt-build-middleware.ts`
   - Actor / Dialog 的 prompt 构建也接入统一上下文源

### 6.5 新行为

每轮发送时统一经过：

1. 解析任务范围
2. 计算连续性决策
3. 生成上下文包
4. 输出 prompt 快照和调试报告
5. 执行结束后再统一 ingest 结果

### 6.6 验收标准

1. 当用户从一个大型项目切换到另一个目录任务时，不再默认沿用旧项目文件上下文。
2. 当用户继续当前项目时，不会丢失最近步骤、关键文件和历史摘要。
3. Ask / Agent / Cluster / Dialog 都能产出一致结构的上下文报告。

---

## 7. 改造流 B：工作区与会话绑定增强

### 7.1 目标

把“工作区切换”从被动推断，升级成明确的会话边界策略。

### 7.2 需要修改的现有文件

1. `src/store/agent-store.ts`
2. `src/core/ai/bootstrap-context.ts`
3. `src/plugins/builtin/SmartAgent/hooks/use-agent-execution.ts`
4. `src/plugins/builtin/SmartAgent/core/session-insights.ts`
5. `src/store/app-store.ts`

### 7.3 新增会话字段

建议新增：

```ts
interface AgentSessionWorkspaceState {
  workspaceRoot?: string;
  repoRoot?: string;
  lastActivePaths?: string[];
  lastTaskIntent?: "coding" | "research" | "delivery" | "general";
  lastContinuityReason?: string;
  lastSoftResetAt?: number;
}
```

### 7.4 行为改造

#### A. 软重置

用户切到新工作区时：

- 不强制开新会话
- 但本轮默认不继承旧项目的历史步骤、旧文件集、旧 handoff
- UI 提示“已按新工作区重置继承上下文”

#### B. 自动分叉会话

满足任一条件时，默认建议分叉：

1. 新旧 `workspaceRoot` 不同
2. 新 query 明确要求“保存到另一个完全不同目录”
3. 上轮是大项目 coding，本轮是无关页面/文案/研究任务

#### C. 手动固定工作区

后续在 UI 中支持“锁定当前工作区”：

- 锁定后除非用户显式切换，否则不自动漂移

### 7.5 验收标准

1. “刚分析完大型项目，后面让我去另一个目录生成页面”时，不再沿用旧项目上下文。
2. 当前会话列表中能够看到会话主要工作区。
3. 对同一项目内不同子目录切换时，能保留必要的摘要与规则，不会过度清空。

---

## 8. 改造流 C：长期记忆体系重做

### 8.1 目标

把当前“候选弹窗太频繁”的长期记忆体验，改成“静默自动化 + 可审计”的体系。

### 8.2 当前问题

1. 用户几乎每次发消息都可能收到长期记忆候选
2. 低价值内容太多
3. 会话笔记和长期记忆边界不清
4. 模型虽能搜记忆，但不一定稳定触发

### 8.3 长期记忆分层

后续强制拆成 3 层：

#### A. Session Notes

只服务当前会话连续性：

- 当前目标
- 当前结论
- 已改文件
- 未完成事项
- 工具失败记录

不作为长期记忆，不弹窗，不要求用户确认。

#### B. Durable Memory

只保存稳定信息：

- 长期偏好
- 长期约束
- 稳定事实
- 长期目标

默认静默自动入库。

#### C. Candidate Review Queue

只保留少量低置信候选，给用户在“记忆管理中心”里批量审查，不在主对话流程里高频打断。

### 8.4 需要修改的现有文件

1. `src/core/ai/memory-store.ts`
2. `src/core/agent/actor/actor-memory.ts`
3. `src/core/ai/assistant-memory.ts`
4. `src/store/agent-memory-store.ts`
5. `src/core/ai/file-memory.ts`
6. `src/plugins/builtin/SmartAgent/core/react-agent.ts`
7. 相关记忆 UI 文件

### 8.5 自动录入规则

只有命中以下条件才进入 Durable Memory：

1. 用户显式使用“记住”“以后都这样”“默认按这个处理”
2. 明确的长期偏好
3. 长期约束
4. 明确身份信息或稳定背景
5. 长期项目目标

必须排除：

1. 一次性任务
2. 临时目录和临时文件
3. 当前会话临时状态
4. 当日性信息
5. 模型猜测或总结出来但用户没明确表达的内容

### 8.6 召回规则

后续要形成两级召回：

1. Prompt 预召回
   - 每轮只注入 3 到 6 条高价值摘要
2. Tool 精召回
   - 涉及历史/偏好/待办/决策时强制用 `memory_search + memory_get`

### 8.7 预压缩记忆写入

当会话接近压缩阈值时，增加一次静默 memory flush：

- 从当前会话提取 durable items
- 直接写入 `memory/YYYY-MM-DD.md` 或统一长期记忆存储
- 不弹窗
- 写入结果进入后台日志和记忆管理页

### 8.8 UI 改造

1. 移除主聊天中高频候选弹窗
2. 改为：
   - 记忆自动保存提示条
   - 记忆管理中心统一审查低置信候选
3. 增加“这条回答用了哪些记忆”的查看能力

### 8.9 验收标准

1. 普通消息不会再频繁弹长期记忆候选。
2. “以后默认这样处理”类消息能自动长期保存。
3. 问“我常驻地是哪里”“我偏好什么输出格式”时，能先检索记忆再回答。
4. 记忆召回结果可解释、可追溯。

---

## 9. 改造流 D：Compaction 升级为 Safeguard 模式

### 9.1 目标

把当前的“结构化摘要”升级为真正适合大型项目会话的压缩机制。

### 9.2 需要增加的能力

1. 标识符保留
2. 关键文件保留
3. 错误与风险保留
4. 压缩后重新注入 AGENTS 关键章节
5. 支持预压缩记忆写入
6. 压缩后强制刷新会话上下文报告

### 9.3 需要修改的现有文件

1. `src/plugins/builtin/SmartAgent/core/session-compaction.ts`
2. `src/plugins/builtin/SmartAgent/core/session-compaction.test.ts`
3. `src/core/ai/bootstrap-context.ts`
4. `src/plugins/builtin/SmartAgent/hooks/use-agent-execution.ts`

### 9.4 需要新增的逻辑

#### A. Identifier Policy

压缩摘要时，强制保留下列内容：

- 文件名
- 目录名
- 工具名
- ticket / issue / host / port / env / branch 名

#### B. Post-Compaction Reinjection

压缩完成后，从当前工作区 `AGENTS.md` 中重新注入关键 section。

建议优先支持：

- `Session Startup`
- `Red Lines`
- 兼容旧标题

#### C. 压缩态 UI

会话列表、上下文条带、任务页都应明确显示：

- 会话已压缩
- 压缩了多少任务
- 当前仍保留哪些关键上下文

### 9.5 验收标准

1. 大型项目长会话压缩后，模型仍记得当前主目标和关键文件。
2. 压缩不会让模型忘记 AGENTS 中的重要规则。
3. 压缩后下一轮不会立刻又触发一次无意义压缩。

---

## 10. 改造流 E：四模式上下文与权限统一

### 10.1 目标

让 `Ask / Agent / Cluster / Dialog` 的用户体验更统一。

### 10.2 需要修改的现有文件

1. `src/store/app-store.ts`
2. `src/store/ai-store.ts`
3. `src/plugins/builtin/SmartAgent/index.tsx`
4. `src/plugins/builtin/SmartAgent/components/...`
5. `src/core/ai/ai-center-routing.ts`

### 10.3 要统一的能力

#### A. 工作区与 handoff

四个模式都统一传递：

- 当前 query
- attachmentPaths
- images
- source session
- source summary
- workspaceRoot

#### B. 权限申请框

统一危险操作、宿主机降级、运行时权限、写文件确认的 UI 入口和交互。

#### C. 当前上下文展示

都支持显示：

- 当前工作区
- 当前模式
- 继承了哪些历史
- 当前是否压缩态
- 本轮是否切换过上下文

#### D. 任务续跑和离开页面恢复

用户退出页面再进来时，应能恢复：

- 折叠过程
- 当前执行状态
- 是否在等用户确认
- 停止按钮状态

### 10.4 验收标准

1. 四个模式的权限提醒样式一致。
2. 模式切换不再明显丢上下文。
3. 离开 Agent 页面再回来，不会出现过程打不开、状态错乱。

---

## 11. 改造流 F：UI 与交互改造

### 11.1 目标

把底层能力变化正确映射到 UI，不然用户仍会觉得“它没有变聪明”。

### 11.2 需要改造的区域

1. Agent 页面主结构
2. 上下文条带
3. 长期记忆管理页
4. 任务列表与会话列表
5. 权限申请弹窗
6. 状态栏 / 托盘通知

### 11.3 具体改造点

#### A. Agent 页面

建议重构为 4 个信息层：

1. 顶部：当前任务、工作区、模式、运行状态
2. 中部：主对话与过程
3. 侧边或下拉：当前上下文报告
4. 底部：输入区、附件区、运行配置

#### B. 上下文条带

建议展示：

- 当前工作区
- 是否继承历史摘要
- 是否召回长期记忆
- 是否处于压缩态
- 是否切换了工作区

#### C. 长期记忆管理

建议分成 3 个 Tab：

1. 已确认长期记忆
2. 会话笔记
3. 待审查候选

### 11.4 验收标准

1. 用户能明显看到“为什么这轮和上一轮上下文不一样”。
2. 用户能直接判断当前是在继续旧项目，还是已经切到新任务。
3. 长期记忆不再以打断式弹窗为主。

---

## 12. 改造流 G：观测与调试体系

### 12.1 目标

后续必须避免“靠临时 console.log 排查”的状态。

### 12.2 需要新增的能力

#### A. Debug Flag

统一增加可控调试开关，例如：

- `debug_context_runtime`
- `debug_memory_pipeline`
- `debug_compaction`
- `debug_workspace_switch`

默认关闭，只在需要时开启。

#### B. 上下文报告快照

每轮保留一个结构化调试快照，至少包含：

- 当前工作区
- 连续性决策
- 注入了哪些 bootstrap 文件
- 注入了多少历史消息
- 注入了多少记忆
- 是否触发压缩

#### C. 文件重复生成追踪

保留当前已有的重复文件写入追踪思路，但改成受控调试输出，不再长期刷屏。

### 12.3 验收标准

1. 开发者工具中不再被大量常规日志淹没。
2. 出现“重复生成文件”“一直回到旧项目”时，可以一眼看出是哪层决策出了问题。

---

## 13. 改造流 H：测试、迁移与发布

### 13.1 测试补全

至少补下面几类测试：

#### A. 单元测试

1. `scope-resolver`
2. `continuity-policy`
3. `memory flush`
4. `post-compaction reinjection`
5. `workspace switch soft reset`

#### B. 集成测试

1. 同项目多轮连续任务
2. 大型项目切换到无关目录任务
3. 有长期记忆召回的问题
4. 压缩前后连续性

#### C. UI 测试

1. 退出页面再进入恢复状态
2. 权限申请框一致性
3. 长期记忆管理中心行为

### 13.2 数据迁移

需要保证旧数据不丢：

1. 旧 `AgentSession` 自动迁移
2. 旧 compaction 字段继续兼容
3. 旧 memory candidates 和 confirmed memories 自动兼容
4. 新字段一律允许为空

### 13.3 发布策略

建议分 3 波：

1. 第一波：只上上下文运行时和工作区切换
2. 第二波：上长期记忆静默化和 compaction 升级
3. 第三波：上 UI 重构与四模式统一

---

## 14. 推荐实施顺序

不建议“全部同时改”。推荐按下面顺序落地。

### 第 1 阶段：上下文运行时成型

目标：解决最核心的“项目串上下文”问题。

改动：

1. 改造流 A
2. 改造流 B 的核心部分

完成标志：

- 能稳定判断是否继续当前工作区
- 能在无关任务时软重置 / 分叉

### 第 2 阶段：长期记忆静默化

目标：解决“每次都弹长期记忆候选”问题。

改动：

1. 改造流 C
2. 对应 UI 最小改造

完成标志：

- 普通消息不再频繁打断
- 重要长期偏好可自动沉淀

### 第 3 阶段：Compaction 升级

目标：解决长会话退化问题。

改动：

1. 改造流 D
2. 补充测试

完成标志：

- 大型项目跑长会话后仍可连续工作

### 第 4 阶段：四模式统一

目标：提升整体产品一致性。

改动：

1. 改造流 E
2. 改造流 F
3. 改造流 G

完成标志：

- 四个模式在上下文、权限、状态表达上基本一致

---

## 15. 本次全量修改要优先落的文件

如果按“先解决真正痛点”排序，优先级最高的是下面这些文件：

### 第一优先级

1. `src/plugins/builtin/SmartAgent/hooks/use-agent-execution.ts`
2. `src/store/agent-store.ts`
3. `src/core/ai/bootstrap-context.ts`
4. `src/plugins/builtin/SmartAgent/core/session-compaction.ts`
5. `src/core/ai/memory-store.ts`

### 第二优先级

1. `src/plugins/builtin/SmartAgent/core/react-agent.ts`
2. `src/core/agent/actor/actor-memory.ts`
3. `src/store/agent-memory-store.ts`
4. `src/plugins/builtin/SmartAgent/core/prompt-context.ts`
5. `src/plugins/builtin/SmartAgent/core/session-insights.ts`

### 第三优先级

1. `src/store/ai-store.ts`
2. `src/store/app-store.ts`
3. `src/plugins/builtin/SmartAgent/index.tsx`
4. 相关 SmartAgent UI 组件

---

## 16. 验收场景清单

后续每做完一个阶段，都必须回归下面这些场景。

### 场景 1：大型项目连续实现

用户先让 Agent 分析整个项目，再继续让它修改其中几个页面和逻辑。

期望：

- 能延续项目上下文
- 不重复从头分析
- 长会话后仍然可持续工作

### 场景 2：大型项目后切到无关任务

用户先分析项目，再要求“帮我在另一个目录生成一个独立网页文件”。

期望：

- 不再沿用旧项目结构
- 自动软重置或建议分叉会话

### 场景 3：长期偏好记忆

用户说：“以后默认给我简洁版回答，并优先列出代码修改点。”

期望：

- 自动长期保存
- 下次回答时能召回
- 不用每次弹确认框

### 场景 4：历史问题回忆

用户问：“我之前让你怎么处理这个模块的？”

期望：

- 先走 `memory_search / memory_get`
- 再回答
- 如果没搜到，要明确说已检查但未命中

### 场景 5：退出页面再回来

Agent 正在跑时用户离开页面，再返回。

期望：

- 能恢复过程
- 停止按钮可用
- 状态不乱

### 场景 6：长会话压缩

连续跑很多轮后触发 compaction。

期望：

- 不忘当前目标
- 不忘关键文件
- 不忘 AGENTS 关键规则

---

## 17. 最终目标判断标准

当以下条件同时满足时，可以认为这次全量改造基本达标：

1. 大型项目长会话可稳定连续执行，不会频繁回到“重新分析项目”
2. 无关新任务不会默认继承旧项目上下文
3. 长期记忆默认静默工作，不再频繁打断
4. 压缩后仍可持续工作，不明显降智
5. 四个模式在上下文和权限心智上趋于一致
6. 用户和开发者都能看懂系统当前为什么这么决策

---

## 18. 结论

这次全量修改的核心不是“多加几个工具”，而是把 AI 助手从：

```text
每轮临时拼 prompt 的执行器
```

升级成：

```text
带工作区边界、会话连续性、长期记忆、压缩与恢复能力的上下文运行系统
```

如果只做局部修修补补，最多只能继续缓解现有问题，不能真正接近 `openclaw` 在大型项目场景下的稳定性。

后续开发建议把这份文档作为主施工单，按阶段逐步完成，而不是分散地修单点问题。
