# AI 助手三模式架构审查报告

## 一、架构总览

```
AICenter (mode: ask | agent | cluster)
 ├── Ask    → ChatView → Rust 后端 (ai_chat_stream) → 工具执行
 ├── Agent  → SmartAgent → ReActAgent (前端) → FC/Text 循环 → 工具执行
 └── Cluster → ClusterOrchestrator → 多 ReActAgent 实例 → 分步执行+聚合
```

三个模式在**提示词构建、工具体系、上下文注入**上各自独立实现，存在大量重复和不一致。

---

## 二、各模式问题分析

### Ask 模式

#### 1. 提示词构建完全在 Rust 后端，前端不可控

Ask 的 system prompt 由 `build_guarded_system_prompt`（Rust）生成，前端只能通过 `config.system_prompt` 注入少量自定义文本。这意味着：

- Skills 系统完全不生效（Skills 只在 Agent/Cluster 中集成）
- 前端无法检查或调试实际发给模型的完整 prompt
- CodingProfile 的编程指引也不会注入

**关键文件**: `src-tauri/src/commands/ai/tools/mod.rs`

#### 2. 记忆注入时序风险

记忆召回有 500ms 超时（`recallMemories` with timeout），数据库慢时会丢弃记忆。且记忆作为 system message 前置，但 Rust 后端会将所有 system messages 合并到自己的 system prompt 里作为"调用方补充上下文"——位置和优先级不受前端控制。

**关键文件**: `src/store/ai-store.ts`（~L400-450）

#### 3. RAG 和记忆是两套独立管道

- RAG：Rust 后端预搜索知识库，3s 超时，追加到 system prompt
- Memory：前端召回用户记忆，作为 system message 发送

两者没有协调——可能同时注入重复信息，也可能互相稀释 context 预算。

#### 4. 工具能力受限于 Rust 定义

Ask 的工具完全在 Rust 定义（base/advanced/native），与 Agent 的前端工具体系（插件 Actions、MCP 工具）完全隔离。用户在 Ask 模式无法使用 MCP 工具和插件 Actions。

**关键文件**: `src-tauri/src/commands/ai/tools/definitions.rs`

#### 5. `continueInAgent` 丢失上下文

只取最后 6 条消息的文本摘要，不带附件、不带工具调用历史、不带会话结构。

**关键文件**: `src/components/ai/ChatView.tsx`（continueInAgent 方法）

---

### Agent 模式

#### 1. System Prompt 膨胀

FC 模式的 `buildFCSystemPrompt` 注入了多达 12 个 section：

| 位置 | 内容 | Token 估计 |
|------|------|-----------|
| 1 | 身份声明 | ~50 |
| 2 | 核心行为规则 | ~300 |
| 3 | 模式切换说明 | ~100 |
| 4 | 复杂任务策略 | ~150 |
| 5 | 工具使用规则 | ~200 |
| 6 | codingBlock（7步法） | ~400 |
| 7 | skillsPrompt（多技能合并） | ~200-800 |
| 8 | 回答质量 | ~100 |
| 9 | userMemoryPrompt | ~100-500 |
| **总计** | | **~1600-2600** |

再加上 `systemHint`（Coding Execution Policy + fileContextBlock）注入到 user message 里，一个编程任务的首轮 prompt 可达 3000-5000 tokens 纯指令。

**关键文件**: `src/plugins/builtin/SmartAgent/core/react-agent.ts`（buildFCSystemPrompt）

#### 2. FC 和 Text 模式的 prompt 重复构建

`buildFCSystemPrompt` 和 `buildSystemPrompt` 内容高度重叠（身份、规则、策略等），但各自独立维护。任何改动都要同步两处。

#### 3. systemHint 注入位置不当

`buildAgentCodingSystemHint` 作为 `systemHint` 被拼到 user message 的前面。在多轮对话中，第一条 user message 会带着一大段 Coding Policy 进入历史，永远占位。

**关键文件**: `src/plugins/builtin/SmartAgent/hooks/use-agent-run-actions.ts`（handleRun）

#### 4. 危险操作确认是同步阻塞

`confirmDangerousAction` 弹出确认对话框等待用户响应，期间 Agent 执行完全挂起。定时任务（`agent-runner-service`）使用 `allowUnattendedHostFallback: true` 但这只影响写文件/shell，不影响前台的 `confirmDangerousAction`。

#### 5. `delegate_subtask` 深度硬编码为 2

不可配置，且子 Agent 继承父的全部 tools 和 skills，无法针对子任务定制。

#### 6. Memory 加载存在首轮空问题

`useAgentMemoryStore` 的快照模式和 skillStore 一样——load 前获取快照，load 后快照过期。

**关键文件**: `src/plugins/builtin/SmartAgent/hooks/use-agent-execution.ts`（~L279-281）

---

### Cluster 模式

#### 1. Planner 的 JSON 解析脆弱

Planner 依赖 LLM 输出结构化 JSON plan。解析失败 fallback 为单步 researcher plan——放弃多角色协作。没有 retry with stronger prompt 或 structured output 机制。

**关键文件**: `src/core/agent/cluster/cluster-orchestrator.ts`（planPhase）

#### 2. Skills 全局应用，无法按角色/步骤定制

所有 Cluster Agent 实例共享同一套 resolved skills。Coder 和 Researcher 不需要相同的 Skill 集合。

**关键文件**: `src/core/agent/cluster/local-agent-bridge.ts`

#### 3. MessageBus 的 Pub/Sub 基本未使用

`publish`/`subscribe` 定义了完整的消息系统，但实际 Agent 之间只通过 context（Blackboard）传递数据。消息系统设计过度。

#### 4. 失败步骤不阻塞下游

依赖步骤失败后，下游仍会运行——只收到降级 context 字符串，可能基于错误前提工作。

#### 5. 聚合阶段 Token 预算分配简陋

按步骤数平均分配预算，不考虑实际输出长度。

#### 6. 无自定义角色 UI

`agent-role.ts` 支持自定义角色存储，但没有 UI 入口。

---

## 三、跨模式共性问题

### 1. 三套工具体系互不相通

| | Ask | Agent | Cluster |
|---|---|---|---|
| 工具来源 | Rust (base/advanced/native) | 前端 (plugin + builtin + MCP) | 同 Agent |
| 工具执行 | Rust | 前端 JS | 前端 JS |
| Skills 过滤 | 无 | 有 | 有 |

### 2. 模式切换丢失全部上下文

- 附件：各模式独立 `useInputAttachments`，切换丢失
- 输入文本：不共享
- 对话历史：Ask → Agent 只传文本摘要；Agent → Ask 无路径

### 3. 记忆注入方式不统一

| | 注入方式 | 时机 |
|---|---|---|
| Ask | `buildMemoryPromptBlock` → system message → Rust 合并 | 每次发送 |
| Agent | `getMemoriesForPrompt()` → system prompt 末尾 | Agent 创建时 |
| Cluster | 同 Agent | 每个 Agent 实例创建时 |

### 4. 没有统一的 Context 预算管理

三个模式都在往 system prompt 里塞东西，但没有谁在管总 token 消耗。

---

## 四、优化方向

### 短期（低成本高回报）

1. 修复 memoryStore 同名快照问题
2. 提取 system prompt builder 为共享模块（FC/Text 去重）
3. 将 systemHint 改为注入 system prompt 而非 user message
4. 为 Ask 模式集成 Skills
5. `continueInAgent` 携带附件和结构化上下文

### 中期（架构改进）

6. 统一工具体系（至少让 MCP 工具在 Ask 中可用）
7. Cluster Skills 按角色定制
8. Context Budget Manager
9. Planner 使用 Structured Output
10. 失败步骤阻塞策略

### 长期（架构演进）

11. 统一 AI 后端（消除 Ask/Agent 架构割裂）
12. 模式融合（按需自动升级 Ask → Agent → Cluster）
13. Skill 提供工具能力（领域 Skill = 知识 + 工具）
14. 跨模式会话延续
15. 自定义角色 UI + Marketplace
