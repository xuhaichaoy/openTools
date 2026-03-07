# AI 助手改进执行计划

基于 [架构审查报告](./ai-assistant-architecture-review.md) 的发现，按优先级和依赖关系排列。

---

## 阶段 1：修复已知缺陷（1-2 天）

> 目标：消除当前已确认的 bug 和不一致，零功能变更。

### 1.1 修复 memoryStore 首轮空快照

**问题**: `useAgentMemoryStore.getState()` 在 `load()` 前获取快照，`load()` 后快照过期。

**改动范围**:
- `src/plugins/builtin/SmartAgent/hooks/use-agent-execution.ts` (~L279)
- `src/core/agent/cluster/local-agent-bridge.ts` (~L127)

**做法**: 与 skillStore 修复方式一致——`load()` 后重新 `getState()`。

**验证**: Agent 冷启动时 system prompt 中包含用户记忆内容。

### 1.2 提取 system prompt builder 共享函数

**问题**: `buildFCSystemPrompt` 和 `buildSystemPrompt` 高度重叠，维护成本高。

**改动范围**:
- `src/plugins/builtin/SmartAgent/core/react-agent.ts`

**做法**:
1. 提取 `buildSharedPromptSections()` 返回各 section 字符串
2. `buildFCSystemPrompt` 和 `buildSystemPrompt` 各自组装格式，共享 sections
3. 不改变最终 prompt 内容，只消除重复代码

**验证**: 两种模式的 system prompt 输出与修改前一致。

---

## 阶段 2：Ask 模式增强（2-3 天）

> 目标：让 Ask 模式也能受益于 Skills 和前端能力。

### 2.1 Ask 模式集成 Skills

**问题**: Skills 只在 Agent/Cluster 中生效，Ask 模式完全没有。

**改动范围**:
- `src/store/ai-store.ts`（sendMessage 流程）
- `src/core/agent/skills/skill-resolver.ts`（复用）

**做法**:
1. 在 `sendMessage` 中调用 `resolveSkills(enabledSkills, content, manualActiveIds)`
2. 将 `mergedSystemPrompt` 作为额外的 system message 发送给 Rust 后端
3. Rust 后端已支持前端传入 system messages（"调用方补充上下文"），无需改 Rust

**验证**: Ask 模式下发送编程问题，观察后端日志确认 skillsPrompt 被注入。

### 2.2 改进 `continueInAgent` 上下文传递

**问题**: 只传最后 6 条消息的文本摘要。

**改动范围**:
- `src/components/ai/ChatView.tsx`（continueInAgent 方法）
- `src/store/app-store.ts`（pendingAgentInitialQuery 扩展为结构体）
- `src/plugins/builtin/SmartAgent/index.tsx`（消费扩展数据）

**做法**:
1. `continueInAgent` 收集：完整消息文本 + 当前附件路径 + 最后使用的工具名
2. `pendingAgentInitialQuery` 从 `string` 改为 `{ query: string; attachmentPaths?: string[]; context?: string }`
3. SmartAgent 消费时恢复附件和上下文

**验证**: Ask 中带附件对话后点"在 Agent 中继续"，Agent 中能看到附件。

---

## 阶段 3：Prompt 架构优化（2-3 天）

> 目标：减少 token 浪费，提升 prompt 可维护性。

### 3.1 将 systemHint 从 user message 移入 system prompt

**问题**: `buildAgentCodingSystemHint` 拼到 user message 里，永远占历史空间。

**改动范围**:
- `src/plugins/builtin/SmartAgent/hooks/use-agent-run-actions.ts`（handleRun）
- `src/plugins/builtin/SmartAgent/hooks/use-agent-execution.ts`（executeAgentTask）
- `src/plugins/builtin/SmartAgent/core/react-agent.ts`（AgentConfig 新增 `contextHint`）

**做法**:
1. AgentConfig 新增 `contextHint?: string`
2. `buildFCSystemPrompt`/`buildSystemPrompt` 在末尾注入 `contextHint`
3. 不再拼到 effectiveQuery 里

**注意**: 只迁移 `buildAgentCodingSystemHint`，`fileContextBlock` 仍留在 user message（因为它是用户提供的上下文）。

**验证**: 多轮对话中第一条 user message 不再包含 Coding Policy 长文本。

### 3.2 实现基础 Context Budget Manager

**问题**: 各种注入无限堆叠，无人管总 token。

**改动范围**:
- 新建 `src/core/agent/context-budget.ts`

**做法**:
1. 定义优先级：`identity > rules > codingBlock > skills > memory > contextHint`
2. 给每个 section 一个 max token 上限（可配置）
3. `buildFCSystemPrompt`/`buildSystemPrompt` 使用 budget manager 裁剪
4. 裁剪策略：低优先级 section 先截断

**验证**: 设置一个较小的 budget (2000 tokens)，观察低优先级 section 被截断。

---

## 阶段 4：Cluster 模式加固（2-3 天）

> 目标：提升 Cluster 执行的可靠性。

### 4.1 Planner 使用 Structured Output / 重试

**问题**: JSON 解析失败直接 fallback 到单步 plan。

**改动范围**:
- `src/core/agent/cluster/cluster-orchestrator.ts`（planPhase）

**做法**:
1. 第一次 JSON 解析失败后，将 LLM 输出 + 解析错误作为 context 再次调用（"你的 JSON 格式有误，请修正"）
2. 如果模型支持 `response_format: { type: "json_object" }`，优先使用
3. 第二次仍失败再 fallback

**验证**: 用一个故意输出不规范 JSON 的 mock 测试重试机制。

### 4.2 失败步骤阻塞策略

**问题**: 依赖失败后下游仍运行。

**改动范围**:
- `src/core/agent/cluster/cluster-orchestrator.ts`（dispatchPhase/executeStep）

**做法**:
1. 步骤新增 `critical?: boolean` 字段（默认 true）
2. critical 依赖失败 → 跳过下游步骤，标记为 `skipped`
3. non-critical 依赖失败 → 降级 context 继续（当前行为）
4. Planner prompt 中加入 critical 字段说明

**验证**: 构造一个 critical 依赖失败场景，验证下游被 skip。

### 4.3 Cluster Skills 按角色定制

**问题**: 所有 Agent 实例共享全局 Skills。

**改动范围**:
- `src/core/agent/cluster/local-agent-bridge.ts`
- `src/core/agent/skills/skill-resolver.ts`（可选）

**做法**:
1. `resolveSkills` 增加可选参数 `roleHint?: string`
2. 当 `roleHint` 为 `"researcher"` 时，排除 `category: "coding"` 的 Skills
3. 当 `roleHint` 为 `"coder"` 时，排除 `category: "writing"` 的 Skills
4. 在 `LocalAgentBridge` 中传入 `role.id` 作为 `roleHint`

**验证**: Researcher Agent 的 system prompt 中不包含编程工作流 Skill。

---

## 阶段 5：工具体系统一（3-5 天）

> 目标：让 Ask 模式也能使用 MCP 工具和插件 Actions。

### 5.1 前端工具桥接到 Rust 后端

**问题**: Ask 的工具在 Rust 执行，Agent 的工具在前端执行，两套互不相通。

**方案评估**:

| 方案 | 描述 | 工作量 | 风险 |
|------|------|--------|------|
| A. Ask 调前端工具 | Rust 的工具调用通过事件转发到前端执行 | 中 | 需改 Rust 流式循环 |
| B. Agent 用 Rust 工具 | Agent 的工具定义增加 Rust invoke 后端 | 小 | 工具重复 |
| C. MCP 工具注入 Ask | 将 MCP 工具定义传给 Rust，Rust 调 MCP | 大 | MCP 连接管理 |
| **D. Ask 使用前端流** | Ask 也走前端 ReActAgent（简化版） | 中 | 改变 Ask 架构 |

**推荐方案 A**：最小改动，在 Rust 工具执行器中增加一个 `frontend_tool_call` 事件类型，前端监听并执行，结果通过 `frontend_tool_result` 事件回传。

**做法**:
1. Rust 工具定义中新增 `source: "frontend"` 类型
2. 前端在 `sendMessage` 时将 MCP 工具定义传给 Rust（作为 tools 参数）
3. Rust 遇到 frontend tool call 时发射事件，等待前端执行结果
4. 前端监听事件、执行、回传

**验证**: Ask 模式中能调用 MCP 工具。

---

## 阶段 6：模式融合探索（5-7 天）

> 目标：减少用户手动选模式的认知负担。

### 6.1 Ask 自动升级为 Agent

**做法**:
1. Ask 检测到需要多步工具调用（如修改文件、执行命令）时，提示用户"此任务需要 Agent 模式，是否切换？"
2. 或者在 Ask 中内置一个轻量级 single-turn agent（只执行一轮工具调用+回答，不做多轮 ReAct）

### 6.2 跨模式会话延续

**做法**:
1. 统一会话 ID 格式，Ask/Agent/Cluster 的会话可以相互引用
2. 切换模式时，将当前会话 ID 传递给目标模式
3. 目标模式加载时读取源会话的历史

---

## 执行优先级排序

```
阶段 1 (Day 1-2)     → 修复缺陷，零风险
阶段 2 (Day 3-5)     → Ask 增强，用户可感知
阶段 3 (Day 5-7)     → Prompt 优化，降低 token 消耗
阶段 4 (Day 7-9)     → Cluster 加固，提升可靠性
阶段 5 (Day 10-14)   → 工具统一，大架构改进
阶段 6 (Day 15-21)   → 模式融合，长期方向
```

## 依赖关系

```
1.1 (memoryStore fix) ── 无依赖
1.2 (prompt builder)  ── 无依赖
2.1 (Ask Skills)      ── 无依赖
2.2 (continueInAgent) ── 无依赖
3.1 (systemHint 迁移)  ←── 1.2 (共享 prompt builder)
3.2 (budget manager)   ←── 1.2, 3.1
4.1 (Planner retry)   ── 无依赖
4.2 (失败阻塞)         ── 无依赖
4.3 (角色 Skills)      ── 无依赖
5.1 (工具统一)          ←── 2.1
6.1 (模式融合)          ←── 5.1
6.2 (会话延续)          ←── 2.2
```
