# 51ToolBox：OpenClaw 主体 + MEMO 增强层实施图

基于当前 `51ToolBox` 的 AI 助手现状、既有改造文档，以及对 `openclaw` 和 MEMO 思路的对比整理。

这份文档回答一个核心问题：

```text
如果要继续把 51ToolBox 做到更接近 OpenClaw 的产品体验，
同时吸收 MEMO 在记忆与稳定性上的优势，
应该按什么分层来做，而不是把两者混成一团。
```

相关文档：
- [AI 助手对标 OpenClaw 体验开发总方案](./ai-openclaw-parity-development-roadmap.md)
- [AI 助手上下文与长期记忆全量改造方案](./ai-context-memory-full-overhaul-plan.md)
- [AI 长期记忆说明](./ai-long-term-memory.md)

---

## 1. 总结论

对 `51ToolBox` 最合理的路线不是：

- 只学 `openclaw`
- 或只学 MEMO

而是下面这个组合：

```text
OpenClaw = 主体运行时与产品体验骨架
MEMO      = 记忆优化层 + 回放排序层 + 稳定性评估层
```

可以把两者关系理解为：

1. `OpenClaw` 负责把系统做成“能持续工作的大项目 Agent”。
2. MEMO 负责把系统做成“多轮多 Agent 下更稳定、更会利用历史经验的 Agent”。

一句话：

```text
OpenClaw 决定系统怎么跑，
MEMO 决定系统跑久了以后会不会越来越稳。
```

---

## 2. 为什么不能把两者混成一个方案

### 2.1 OpenClaw 更像产品级主干

它解决的核心是：

1. 工作区边界
2. 会话连续性
3. bootstrap / assemble / compact / afterTurn 生命周期
4. 多 Agent 的主协调者 + 子任务执行流程
5. 长会话恢复、上下文解释、桌面端交互体验

这部分是 `51ToolBox` 当前最缺、也最该先补齐的主干。

### 2.2 MEMO 更像增强层

它解决的核心是：

1. 记忆如何写入 memory bank
2. 历史经验如何按优先级回放，而不是全部塞回上下文
3. 同一个多 Agent 系统多跑几次时，结果为什么会漂
4. 如何把 `variance / instability / prompt sensitivity` 纳入评估目标

这部分很重要，但前提是主干运行时已经成型。

### 2.3 对 51ToolBox 的直接含义

如果现在把 MEMO 当主线，会有两个问题：

1. 你会过早投入“记忆优化”和“稳定性评估”，但底层上下文生命周期还不统一。
2. 系统还没做到 OpenClaw 那种基本连续性，就开始优化 replay，收益会被底层不稳定吃掉。

所以顺序必须是：

```text
先把 OpenClaw 主体做稳
再把 MEMO 增强层嫁接上去
```

---

## 3. 目标分层图

建议把未来架构分成 6 层。

### 第 0 层：执行与会话主干层

目标：对齐 OpenClaw 的产品骨架。

负责：

1. 工作区边界
2. 会话连续性判断
3. Context Runtime 生命周期
4. bootstrap / assemble / ingest / compact / recovery
5. Ask / Agent / Cluster / Dialog 四模式统一上下文链路

对应当前项目的重点模块：

- `src/core/agent/context-runtime/`
- `src/plugins/builtin/SmartAgent/core/prompt-context.ts`
- `src/plugins/builtin/SmartAgent/core/session-compaction.ts`
- `src/store/actor-system-store.ts`
- `src/store/agent-store.ts`

这一层的验收标准：

1. 大项目连续开发时不明显“重新分析项目”
2. 切到无关任务时能主动切边界
3. 压缩后仍保留目标、关键文件、规则、风险
4. 离开页面再回来能恢复运行态和等待态

### 第 1 层：多 Agent 编排层

目标：对齐 OpenClaw 的协作心智。

负责：

1. 协调者优先
2. 执行 Agent、独立审查 Agent、验证 Agent 分离
3. 子任务树和父子责任边界
4. 临时子 Agent 创建
5. 计划边界和执行边界分离

对应当前项目的重点模块：

- `src/core/agent/actor/actor-system.ts`
- `src/core/agent/actor/actor-tools.ts`
- `src/core/agent/actor/dialog-dispatch-plan.ts`
- `src/core/agent/actor/middlewares/prompt-build-middleware.ts`

这一层的验收标准：

1. 协调者负责理解、派活、review、收束
2. 执行者默认不抢协调权
3. 审查者尽量独立，减少实现上下文污染
4. 子任务可以继续拆，但责任链清晰

### 第 2 层：记忆分层与静默沉淀层

目标：这是 MEMO 真正开始接入的第一层。

负责把“记忆”拆成 4 类，而不是混成一个桶：

1. `session notes`
   - 当前会话 / 当前工作区的阶段性结论
2. `durable memory`
   - 用户偏好、约束、长期事实
3. `experience memory`
   - 某类任务的成功策略、失败模式、review 规则、验证规则
4. `runtime cache`
   - 本轮短期上下文缓存，不进长期库

建议新增或升级的数据结构：

```ts
interface ExperienceMemoryRecord {
  id: string;
  kind:
    | "workflow_rule"
    | "task_strategy"
    | "failure_pattern"
    | "review_rule"
    | "validation_rule";
  scope: "global" | "workspace" | "session" | "actor";
  content: string;
  workspaceId?: string;
  actorRole?: string;
  taskFingerprint?: string;
  outcome: "success" | "failure" | "mixed" | "unknown";
  confidence: number;
  useCount: number;
  lastUsedAt: number;
  createdAt: number;
  updatedAt: number;
  sourceSessionId?: string;
  sourceRunId?: string;
}
```

推荐挂载点：

- `src/core/ai/memory-store.ts`
- `src/core/ai/assistant-memory.ts`
- `src/core/agent/actor/actor-memory.ts`

这一层的验收标准：

1. 长期记忆不再频繁弹窗打断
2. 会话笔记和长期记忆边界明确
3. 经验记忆可追溯、可失效、可合并

### 第 3 层：Prioritized Replay / Context Replay 层

目标：落地 MEMO 最有价值的“不是全带，而是优先带”。

负责：

1. 给记忆、会话笔记、历史轨迹打分
2. 决定本轮只带哪些最相关上下文
3. 在预算内优先带“高价值经验”而不是“最近消息”

建议引入统一评分器：

```text
score =
  relevance      * 0.45 +
  outcomeValue   * 0.20 +
  recency        * 0.15 +
  scopeMatch     * 0.10 +
  roleMatch      * 0.05 +
  stabilityBoost * 0.05
```

其中：

- `relevance`
  当前任务与记忆内容的语义相关度
- `outcomeValue`
  成功经验加分，失败规避规则也可加分
- `scopeMatch`
  同工作区 / 同项目 / 同会话优先
- `roleMatch`
  review 规则优先给 reviewer，验证规则优先给 tester
- `stabilityBoost`
  过去在类似任务上反复有效的经验加权

建议模块：

- `src/core/agent/context-runtime/replay-ranker.ts`
- `src/core/agent/context-runtime/memory-retriever.ts`

这一层的验收标准：

1. 模型注入的记忆更少但更准
2. 无关历史明显减少
3. 大项目上下文污染明显下降

### 第 4 层：稳定性评估层

目标：这是 MEMO 比 OpenClaw 更领先的部分。

负责：

1. 不只看平均结果，还看运行方差
2. 同任务多跑几次，检查：
   - 分工是否漂移
   - 记忆命中是否漂移
   - 最终结果是否漂移
3. 发现高漂移链路并回溯来源

建议新增指标：

1. `task_decomposition_variance`
2. `memory_recall_variance`
3. `result_consistency_score`
4. `review_catch_rate`
5. `validation_followthrough_rate`

建议新增目录：

```text
src/core/agent/evaluation/
  stability-evaluator.ts
  task-fingerprint.ts
  run-comparator.ts
  metrics-store.ts
```

这一层的验收标准：

1. 同一任务多次运行的漂移能被看见
2. 可以识别“模型没变，但系统不稳定”的问题
3. 后续调优有明确指标，而不是主观感觉

### 第 5 层：未来高级优化层

这是可选层，短期不建议投入。

包括：

1. prompt evolution
2. 自动策略搜索
3. 自博弈式经验沉淀
4. 角色 prompt 自动重排

这一层更偏研究，不是当前主线。

---

## 4. 对 51ToolBox 的直接实施顺序

建议分 4 波，而不是 6 层同时开工。

### 第一波：把 OpenClaw 主体彻底做稳

先完成：

1. 统一 Context Runtime
2. 统一四模式上下文链路
3. 工作区边界和 continuity policy
4. compaction safeguard
5. durable runtime recovery

不做：

1. 复杂经验记忆
2. 复杂 replay 排序
3. 稳定性评估系统

### 第二波：补经验记忆层

新增：

1. experience memory 数据结构
2. 自动写回成功 / 失败经验
3. 记忆失效 / 合并 / 编辑

### 第三波：接 prioritized replay

新增：

1. replay ranker
2. top-k 注入策略
3. role-aware / workspace-aware recall

### 第四波：做稳定性评估

新增：

1. benchmark task set
2. repeated-run evaluation
3. variance dashboard / metrics report

---

## 5. 当前代码映射建议

### 5.1 保持不动或只增量增强的部分

这些模块更适合作为 OpenClaw 主体的承载点：

- `src/core/agent/context-runtime/`
- `src/core/agent/actor/actor-system.ts`
- `src/core/agent/actor/dialog-dispatch-plan.ts`
- `src/core/agent/actor/middlewares/`
- `src/plugins/builtin/SmartAgent/core/session-compaction.ts`

### 5.2 建议升级为 MEMO 增强层入口的部分

- `src/core/ai/memory-store.ts`
- `src/core/ai/assistant-memory.ts`
- `src/core/agent/actor/actor-memory.ts`
- `src/plugins/builtin/ManagementCenter/components/MemoryTab.tsx`

### 5.3 建议新增的模块

```text
src/core/agent/context-runtime/replay-ranker.ts
src/core/agent/context-runtime/experience-memory.ts
src/core/agent/context-runtime/experience-ingest.ts
src/core/agent/evaluation/stability-evaluator.ts
src/core/agent/evaluation/run-comparator.ts
src/core/agent/evaluation/task-fingerprint.ts
```

---

## 6. 你现在最该做什么

如果只选 3 件事，建议是：

1. 继续完成 `OpenClaw 主体层`
   - 统一上下文运行时
   - 工作区边界
   - 恢复与压缩
2. 给记忆系统补 `experience memory`
   - 不是只记用户偏好，还要记“这类任务怎么做更稳”
3. 给多 Agent 加 `stability evaluation`
   - 不只看能不能做出来，还看是不是稳定做出来

最不建议现在投入的，是：

1. prompt evolution
2. 自博弈优化
3. 复杂 benchmark 排名系统

---

## 7. 最终判断

### 7.1 如果只问“哪个更适合拿来做 51ToolBox 主体”

答案是：

```text
OpenClaw 更适合作为主体实现参考
```

因为它更接近产品级运行时和产品级体验。

### 7.2 如果只问“哪个更值得拿来提升长期上限”

答案是：

```text
MEMO 更适合作为增强层参考
```

因为它真正把“记忆与稳定性”提升成了系统目标，而不是附属功能。

### 7.3 对 51ToolBox 的最终路线

最合理的路线不是二选一，而是：

```text
OpenClaw 打底
MEMO 增强
```

也就是：

1. 用 OpenClaw 的思路把 `51ToolBox` 先做成一套稳的上下文与协作系统
2. 再用 MEMO 的思路把它做成一套会积累经验、会优先回放关键经验、且可测稳定性的系统

---

## 8. 后续文档关系

后续建议按下面关系继续推进：

1. [AI 助手对标 OpenClaw 体验开发总方案](./ai-openclaw-parity-development-roadmap.md)
   负责主路线与阶段施工
2. [AI 助手上下文与长期记忆全量改造方案](./ai-context-memory-full-overhaul-plan.md)
   负责 Context Engine 与 Memory 主专项
3. 本文档
   负责解释 `OpenClaw 主体 + MEMO 增强层` 的最终分层关系

如果后续继续拆施工单，建议下一份文档直接进入：

```text
Experience Memory + Prioritized Replay 实施方案
```

而不是继续做泛讨论。
