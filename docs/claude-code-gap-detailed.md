# 51ToolBox 与 Claude Code 差距详细分析

更新时间：2026-04-02  
对照基线：`/Users/haichao/Desktop/work/claude-code/src`  
当前项目：`/Users/haichao/Desktop/work/51ToolBox`

---

## 1. 结论摘要

当前 51ToolBox 和 Claude Code 的差距，已经**不在最表层的“能不能多 agent / 能不能 resume”**。

这两块最近已经补上了不少，尤其是：

- `spawn_task` / `delegate_task` 的 **implicit fork**
- 并发达到上限后的 **queue**
- `resumeMessages` / transcript resume
- host-managed workbook 导出的 **quality gate / repair shard / blocker 收尾**

但离“**完整对齐 Claude Code**”仍有一段关键差距。现在最大的缺口不是某一个点功能缺失，而是：

> **Claude Code 的 AgentTool/SendMessage/LocalAgentTask/sidechain transcript 这条主链路，还没有在 51ToolBox 里成为唯一事实来源。**

换句话说：

- 51ToolBox 已经有不少“像 Claude Code”的能力；
- 但当前仍是**多套运行时/多套工具入口并存**；
- 因此产品行为、上下文一致性、后台任务生命周期、权限与 resume 的稳定性，仍达不到 Claude Code 的一体化程度。

---

## 2. 本次对照范围

本次主要对照了以下关键实现。

### 2.1 Claude Code 对照文件

- ` /Users/haichao/Desktop/work/claude-code/src/tools/AgentTool/AgentTool.tsx `
- ` /Users/haichao/Desktop/work/claude-code/src/tools/AgentTool/runAgent.ts `
- ` /Users/haichao/Desktop/work/claude-code/src/tools/AgentTool/forkSubagent.ts `
- ` /Users/haichao/Desktop/work/claude-code/src/tools/AgentTool/agentToolUtils.ts `
- ` /Users/haichao/Desktop/work/claude-code/src/tasks/LocalAgentTask/LocalAgentTask.tsx `
- ` /Users/haichao/Desktop/work/claude-code/src/utils/sessionStorage.ts `

### 2.2 51ToolBox 当前关键文件

- ` /Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/actor-tools.ts `
- ` /Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/actor-system.ts `
- ` /Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/agent-actor.ts `
- ` /Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/agent-resume-service.ts `
- ` /Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/actor-transcript-fs.ts `
- ` /Users/haichao/Desktop/work/51ToolBox/src/core/agent/runtime/transcript-messages.ts `
- ` /Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/core/react-agent.ts `
- ` /Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/core/default-tools.ts `
- ` /Users/haichao/Desktop/work/51ToolBox/src/core/agent/tools/agent-tool.ts `
- ` /Users/haichao/Desktop/work/51ToolBox/src/core/agent/tools/send-message-tool.ts `
- ` /Users/haichao/Desktop/work/51ToolBox/src/core/task-center/local-agent-task.ts `

---

## 3. 当前已经基本对齐的部分

## 3.1 多子任务派发：从“目标不存在即失败”到 implicit fork + queue

这一块已经不是主差距。

当前 51ToolBox 在：

- `src/core/agent/actor/actor-tools.ts`
- `src/core/agent/actor/actor-system.ts`

已经具备以下行为：

1. `target_agent` 留空时，不再直接报错，可自动创建临时 child  
2. 目标名不存在时，可按隐式 fork 路径继续  
3. `content_worker` / `spreadsheet_worker` 在并发满时，会自动 queue  
4. queue 后可在空位释放时自动补派  

这部分语义上已经接近 Claude Code 的“不要轻易因目标名缺失而中断协作”。

### 判断

- **能力层面**：已基本具备
- **实现形态**：还不是 Claude Code 的原生 fork session 语义

也就是说，它**能工作**，但实现方式仍更像“增强版 actor spawn”，而不是 Claude Code 的 byte-identical fork。

---

## 3.2 transcript resume：基础恢复链路已接上

当前 51ToolBox 已新增：

- `src/core/agent/runtime/transcript-messages.ts`

并且：

- `src/plugins/builtin/SmartAgent/core/react-agent.ts`
  - 已接入 `resumeMessages`
  - 已接入 `onConversationMessagesUpdated`
- `src/core/agent/actor/agent-resume-service.ts`
  - 已能保存和恢复 transcript messages
  - 已能合并 session history / transcript metadata / tool result replacement snapshot
- `src/core/agent/actor/actor-transcript-fs.ts`
  - 已持久化 resume metadata

### 判断

- **恢复能力**：已从“几乎没有”提升到“可用”
- **与 Claude Code 的差距**：仍在“完整 sidechain transcript 生命周期”

---

## 3.3 表格交付闭环：host export gate 已明显补强

这是最近提升最大的一块。

现在：

- `src/core/agent/actor/agent-actor.ts`
- `src/core/agent/actor/dynamic-workbook-builder.ts`
- `src/core/agent/actor/agent-actor-host-workbook.test.ts`

已经不是过去那种：

- 子任务有 blocker
- 主线程知道有问题
- 但最后仍继续 `export_spreadsheet`

现在已补上：

1. **structured result exportability summary**
2. **host export blocked**
3. **repair plan**
4. **repair round**
5. **final blocker fallback**

也就是说，如果：

- 子任务 rows=0
- 结构化 JSON 不合法
- 结果只是“执行计划”
- 主题覆盖不够

系统现在会更倾向于：

- 阻断导出
- 补派 repair shard
- 最终返回真实 blocker

而不是继续导出半成品。

### 测试验证

已跑通：

- `src/core/agent/actor/agent-actor-host-workbook.test.ts`
- `src/core/agent/tools/agent-tool.test.ts`

合计 `21` 个测试通过。

---

## 4. 现在和 Claude Code 的核心差距

下面这些，才是当前最关键的真实差距。

---

## 4.1 最大差距一：主链路没有收口，存在三套并存体系

这是当前最重要的问题。

### 现状

51ToolBox 目前至少存在三套相邻但不完全统一的能力层：

#### A. Dialog / Actor 主链路

- `src/core/agent/actor/actor-tools.ts`
- `src/core/agent/actor/actor-system.ts`
- `src/core/agent/actor/agent-actor.ts`

这是当前真正跑业务、跑 Dialog、多 agent 协作的主路径。

#### B. SmartAgent 默认工具池

- `src/plugins/builtin/SmartAgent/core/default-tools.ts`

这里定义了大量本地工具：

- `read_file`
- `read_document`
- `write_file`
- `export_spreadsheet`
- `web_search`
- `persistent_shell`
- memory 工具等

这是主 Agent 实际能看到的一大块工具面。

#### C. 新增的 Claude Code 风格 tools 层

- `src/core/agent/tools/agent-tool.ts`
- `src/core/agent/tools/send-message-tool.ts`
- `src/core/agent/tools/register-tools.ts`
- `src/core/task-center/local-agent-task.ts`

这一层已经有：

- `agent`
- `send_message`
- task center
- output file
- resumable background agent

但当前从调用关系上看，这层**并没有成为 SmartAgent/Dialog 主链路的唯一入口**。

### 证据

- `src/core/agent/tools/register-tools.ts` 定义了 `registerAllTools()`
- 但仓内搜索 `registerAllTools(`，只看到定义，几乎没有主链路消费
- Dialog 实际还主要依赖：
  - `actor-tools.ts`
  - `default-tools.ts`
  - `agent-actor.ts`

### 这会导致什么

1. **同名能力在不同层重复实现**
   - `send_message` 在 `actor-tools.ts` 里有一套
   - `send-message-tool.ts` 里又有一套

2. **行为不一致**
   - 某些场景走 actor runtime
   - 某些场景走 task-center resumable tool
   - 某些场景根本走不到新逻辑

3. **你会产生“我明明改了，为什么没生效”的错觉**
   - 因为某些新实现是对的
   - 但实际产品入口仍走旧路径

### 结论

这不是“代码风格问题”，而是**架构未收口问题**。

如果不把主链路统一，后面即使继续“抄 Claude Code”，也会持续出现：

- 新能力写了
- 测试能过
- 但线上实际不稳定

---

## 4.2 fork 语义还不是 Claude Code 的 byte-identical fork

Claude Code 的关键点不只是“自动创建 child”，而是：

> child 继承父的完整 conversation context、完整 assistant 消息、完整 tool_use 前缀，并尽量做到 prompt cache 前缀字节级一致。

### Claude Code 的做法

见：

- `claude-code/src/tools/AgentTool/forkSubagent.ts`
- `claude-code/src/tools/AgentTool/runAgent.ts`

核心点：

1. `buildForkedMessages()` 保留父 assistant 完整消息  
2. 对所有 `tool_use` 构造占位 `tool_result`  
3. child 的请求前缀几乎只在最后 directive 上有差异  
4. `override.systemPrompt` 直接传父已渲染好的 prompt bytes  
5. `useExactTools` 传父精确 tool pool  

这是一种典型的 **cache-identical fork**。

### 51ToolBox 当前状态

当前更像：

- 根据当前任务生成一个 child prompt
- 限制 child 工具面
- 按 worker profile 创建 actor

这能解决“协作”和“补派”，但不是 Claude Code 的原生 fork。

### 差异影响

1. child 不一定继承到父当前那一轮 assistant 完整上下文  
2. prompt cache 命中能力差很多  
3. fork 后的行为更像“重新开一个子任务”，而不是“继承父上下文继续干活”  
4. 某些复杂任务里，Claude Code child 更稳定，51ToolBox child 仍更容易出现偏题或格式漂移

### 结论

- **功能层**：已接近
- **底层语义层**：仍明显落后 Claude Code

---

## 4.3 后台任务生命周期仍不是 Claude Code 的统一模型

Claude Code 的 AgentTool 设计，本质上是：

> 所有 subagent 都能自然进入 foreground / background / notification / outputFile / resume / continue 的统一生命周期。

关键文件：

- `claude-code/src/tools/AgentTool/AgentTool.tsx`
- `claude-code/src/tasks/LocalAgentTask/LocalAgentTask.tsx`

### Claude Code 特点

1. agent 可以同步启动，也可以自动后台化  
2. 后台化后会统一进入 `LocalAgentTask`  
3. 有 output file  
4. 有 task notification  
5. 有 progress summary  
6. 完成后会自动发通知  
7. 用户和主线程可以继续 `SendMessage`

### 51ToolBox 当前状态

有这些雏形：

- `src/core/agent/tools/agent-tool.ts`
- `src/core/task-center/agent-task-manager.ts`
- `src/core/task-center/agent-task-output-file.ts`
- `src/core/agent/actor/background-agent-registry.ts`
- `src/core/agent/actor/agent-resume-service.ts`

但当前主产品链路仍然主要是：

- `spawn_task`
- `wait_for_spawned_tasks`
- host follow-up synthesis

### 实际差距

51ToolBox 更像：

- “主线程协调 + 局部后台能力”

Claude Code 更像：

- “agent/task 本身就是一等运行时对象”

### 结论

现在 51ToolBox 不是没有后台任务，而是：

> **后台任务这套还没有成为主运行时范式。**

---

## 4.4 resume 有了，但还不是完整 sidechain transcript 体系

Claude Code 在：

- `claude-code/src/utils/sessionStorage.ts`

里对 subagent transcript 的处理非常完整：

1. 独立 sidechain transcript 文件  
2. agent metadata sidecar  
3. transcript subdir grouping  
4. worktree path 持久化  
5. description 持久化  
6. resume 时按 sidechain 恢复  

### 51ToolBox 当前状态

已有：

- `actor-transcript-fs.ts` 的 metadata 持久化
- `agent-resume-service.ts` 的 transcript/history 恢复

但还没有 Claude Code 这种完整能力：

1. **真正独立的 sidechain 会话体系**  
2. **resume 与 notification、outputFile、agent metadata 的统一闭环**  
3. **subdir/worktree grouping 级别的 transcript 管理**  

### 直接影响

现在 51ToolBox 虽然能恢复：

- 历史消息
- transcript messages
- tool replacement snapshot

但还不够像 Claude Code 那种：

- “这是一个持续存在的 agent session”
- “它有自己的 sidechain transcript”
- “它的 cwd / worktree / metadata / output file 可完整续跑”

---

## 4.5 SendMessage 能力已部分具备，但体验闭环没完全统一

当前 51ToolBox 已有两套相关能力：

### 已有

- `src/core/agent/actor/actor-tools.ts` 中的 `send_message`
- `src/core/agent/tools/send-message-tool.ts`

并且测试表明：

- 正在运行的 agent 可收消息
- 不在内存中的 agent 可从 resume metadata 恢复后继续

### 但问题在于

这套能力当前并没有完全统一到唯一主入口。

也就是说：

- **能力本身不是缺失**
- **主产品链路对它的依赖还不稳定**

### 结论

这块差距不是“没有 SendMessage”，而是：

> **还没有达到 Claude Code 那种所有 async agent 都天然支持继续对话的产品一致性。**

---

## 4.6 worktree / remote backend 仍明显落后

Claude Code 在 `runAgent.ts` 里已经完整接了：

- worktree 创建
- fork + worktree notice
- worktree cleanup
- metadata 持久化
- remote / async 承载

### 51ToolBox 当前状态

虽然目录里已经有：

- `src/core/agent/backends/worktree-backend.ts`
- `src/core/agent/backends/remote-backend.ts`

但从当前实现看：

- `remote-backend.ts` 仍处于“尚未接入远程执行承载层”的状态
- worktree 也还没有进入当前主 Dialog 运行时闭环

### 结论

这部分现在仍明显不如 Claude Code。

---

## 4.7 权限系统和 Bash 安全策略，和 Claude Code 不是一个量级

Claude Code 的 Bash/Permission 体系非常重：

- read-only 判定
- deny / ask / allow 优先级
- compound command 处理
- path validation
- prefix suggestion
- sandbox 语义

见：

- `claude-code/src/tools/BashTool/*`

### 51ToolBox 当前状态

有：

- 基础审批模式
- 命令拒绝
- 一些 tool policy / execution policy

但没有 Claude Code 那种成熟度的：

- Bash 权限决策系统
- path-aware / command-aware rule match
- 复杂子命令安全分析

### 结论

这一块如果目标是“完全照 Claude Code 实现”，当前仍是明显差距。

---

## 5. 表格交付这块，现在到什么程度了

这是当前最容易误判的一块，因为它已经明显变好了，但还没有完全等于最终业务需求。

## 5.1 目前已经补上的

- host export 不能随便放行
- zero-row child 不再当成功结果
- plan-like reply 会被转 blocker
- host export blocked 后会尝试 repair shard
- 最终综合阶段会被 repair guidance 约束

这些能力从测试上已经成立。

## 5.2 当前仍需注意的点

虽然导出 gate 已经更硬，但这只是“**不轻易交半成品**”。

如果目标是完全对齐你想要的采购模板业务结果，还要区分两个层面：

### A. 运行时正确性

这一层最近已补很多。

### B. 业务交付模板正确性

如果你的最终要求是：

- 回填原模板
- 保留采购表结构
- 映射培训项目 + 课程主题
- 保证每个主题 coverage
- 输出更多列

那当前还需要继续补**模板契约层**。

当前 `dynamic-workbook-builder.ts` 更偏：

- 动态 sheet 聚合
- 结构化 rows 汇总

而不是“完全复刻采购模板右侧响应列”的专用模板输出器。

### 结论

这块当前状态应判断为：

- **运行时 gate：大幅提升**
- **最终业务模板：仍未完全对齐你的采购场景**

---

## 6. 目前哪些改动已经真正用上，哪些存在“可能没走到”的风险

这个问题非常关键。

## 6.1 已明确用上的

以下改动已经明显进入主链路或有强测试覆盖：

- `src/core/agent/actor/actor-tools.ts`
  - implicit fork
  - queue if busy
- `src/core/agent/actor/actor-system.ts`
  - deferred spawn queue
  - spawn runtime
- `src/plugins/builtin/SmartAgent/core/react-agent.ts`
  - resumeMessages
  - conversation message update
- `src/core/agent/runtime/transcript-messages.ts`
  - transcript 恢复整理
- `src/core/agent/actor/agent-actor.ts`
  - deterministic host export
  - repair round
  - blocker fallback
- `src/core/agent/actor/dynamic-workbook-builder.ts`
  - structured rows 聚合
  - completeness validation

## 6.2 存在“写了但未成为主入口”的

以下需要重点警惕：

- `src/core/agent/tools/agent-tool.ts`
- `src/core/agent/tools/send-message-tool.ts`
- `src/core/agent/tools/register-tools.ts`
- `src/core/task-center/local-agent-task.ts`

这些实现不是没价值，而是**当前没有证据表明它们已经成为 Dialog / SmartAgent 的唯一运行时入口**。

### 风险判断

它们更像：

- 已经具备能力
- 已有测试
- 但主业务流未完全切过去

因此不能简单说“完全没用”，但也不能说“当前所有产品行为都一定走这套”。

---

## 7. 和 Claude Code 对齐时，最合理的收口方向

如果目标是“不要业务包袱，尽量和 Claude Code 保持一致”，建议按下面顺序收口。

## 7.1 第一阶段：确定唯一 agent 主链路

必须先决定以下二选一：

### 方案 A：以 `actor-tools.ts + agent-actor.ts` 为主，吸收 `agent-tool.ts`

做法：

- 保留当前 Dialog/Actor 主运行时
- 把 `agent-tool.ts` / `send-message-tool.ts` 的 background / outputFile / resume 机制下沉整合到 actor 主链路

### 方案 B：以 `agent-tool.ts + task-center` 为主，反向替换 actor 的部分语义

做法：

- 让 `agent` 成为真正的一等工具入口
- `spawn_task` / `delegate_task` 收敛为围绕 `agent` 的薄封装

### 建议

更现实的是 **方案 A**，因为当前真正跑起来的是 actor 主链路。

---

## 7.2 第二阶段：让 `send_message` 只保留一套

当前应收口为：

- 只有一个权威 `send_message` 入口
- 所有续聊和恢复都走同一条 resume service / task center / transcript metadata

否则后面会继续出现：

- IM 场景一套
- Dialog 场景一套
- Task Center 一套

---

## 7.3 第三阶段：把 fork 语义提升到 Claude Code 级别

重点是：

1. child 继承父完整 messages  
2. child 继承父 rendered system prompt  
3. child 继承父 exact tool pool  
4. child 继承 content replacement state  
5. 统一 fork child recursion guard  

这一步做完，才算真的接近 Claude Code 的 fork。

---

## 7.4 第四阶段：让后台任务成为默认范式

目标是：

- subagent 默认可后台运行
- 有 output file
- 有 notification
- 有 progress
- 有 SendMessage continuation
- 有 resume

也就是把当前“Dialog 等待子任务”模式，逐步提升为“后台 agent lifecycle”模式。

---

## 7.5 第五阶段：补 worktree / remote

如果真要“完整抄 Claude Code”，这一层迟早要补：

- worktree spawn
- worktree notice
- worktree cleanup
- metadata
- remote task backend

---

## 8. 当前优先级建议

基于当前状态，建议优先级如下。

### P0：必须优先做

1. **统一主链路**
   - 决定到底谁是唯一 agent/task/tool 运行时
2. **清理重复实现**
   - `send_message`
   - `agent`
   - task lifecycle
3. **确认产品入口**
   - 当前 Dialog、IM、Task Center 到底分别走哪套

### P1：紧接着做

4. **对齐 Claude fork 语义**
5. **统一后台任务 lifecycle**
6. **统一 resume / transcript / outputFile**

### P2：后续增强

7. **worktree / remote**
8. **Bash 权限体系**
9. **模板化业务交付器**

---

## 9. 一句话最终判断

当前 51ToolBox 已经从“离 Claude Code 很远”进展到：

> **底层协作能力、resume 能力、host export gate 都已有明显对齐，但架构上仍未完成主链路收口，因此还不能算“完整按照 Claude Code 实现”。**

如果必须用一句最直接的话来概括：

> **现在最大差距不是能力缺失，而是运行时没有统一。Claude Code 是一套系统；51ToolBox 现在还是几套相邻系统拼在一起。**

---

## 10. 本次验证记录

本次已直接运行并通过：

```bash
pnpm vitest run src/core/agent/actor/agent-actor-host-workbook.test.ts src/core/agent/tools/agent-tool.test.ts
```

结果：

- `2` 个测试文件通过
- `21` 个测试通过

测试过程中出现了若干 Tauri store `invoke` 相关 stderr 警告，但未影响本次核心测试结论。

---

## 11. 推荐下一步

如果下一步继续推进“完全对齐 Claude Code”，建议直接开做一份实施文档，标题可以是：

`Claude Code 主链路收口实施方案`

这份实施方案应明确：

1. 保留哪些入口  
2. 删除或废弃哪些重复能力  
3. 如何把 `agent-tool.ts` 合并进当前 Dialog 主链路  
4. 如何把 `send_message`、background task、resume、outputFile 统一成一套  
5. 如何引入真正的 full-context fork  

这会比继续零散修 bug 更有效。
