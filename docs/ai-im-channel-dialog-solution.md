# IM 通道 / Dialog 房间收敛方案

面向当前 `51ToolBox` 在钉钉、飞书等 IM 通道接入后的产品与架构收敛方案。

这份方案重点回答 4 个问题：

1. IM 通道是否应该默认连接
2. 右下角运行状态为什么不该一直显示 `Dialog 房间`
3. 钉钉场景下“四种模式”是否应该直出给用户，是否需要“新开窗口 / 重置”
4. 钉钉当前对话为什么像阻塞式，最优解应该是什么

## 0. 截至 2026-03-24 的现状修订（以本节为准）

这份文档原本更多是方案；当前实现已经前进到下面这个状态：

### 0.1 已经落地的部分

1. IM 运行态已经有独立 `im_conversation` 语义，不再把 IM topic 默认注册成桌面 `Dialog 房间`。
2. `im-conversation-runtime-manager` 已经以 `(channelId, conversationId, topicId)` 维度维护 `CollaborationSessionController`，topic 级别的 `activeContract`、pending interaction、queued follow-up、child session projection 都能进入 snapshot。
3. IM surface 默认仍是 parent-first：用户继续给 parent 发消息，child session 主要作为内部后台线程，不要求 IM 用户先理解子线程再操作。
4. 审批入口已经不再是“每条任务都必须人工确认”，当前链路会先走 policy 和 auto-review，模型拿不准或策略要求时才升级到 human。

### 0.2 仍然没做透的部分

1. 会话连续性还没有彻底收口到统一 `SessionControlPlane`，因此“历史记录偶尔丢 / topic 恢复不稳 / compaction 后 continuity 不够清晰”这类问题还没完全消失。
2. 缺 OpenClaw 风格的 per-peer / per-channel-peer isolation、identity linking、session maintenance、thread binding/announce retry。
3. IM 数据查询、导出、渠道适配已经各自有 runtime，但还没有完全被同一个 session / security / maintenance control plane 接住。

### 0.3 当前最合理的产品心智

对 IM 用户最合理的表达仍然是：

`IM 会话 = 用户入口`

`AI runtime = 内部执行与协作真相`

内部可以升级为 agent / collab / background thread，但对外默认继续显示“当前会话正在处理”，而不是把内部实现名词直接抛给用户。

---

## 1. 结论先行

### 1.1 总体结论

当前最合适的方向不是“把桌面端四种模式原封不动搬到钉钉里”，而是：

1. **桌面端保留 `Ask / Agent / Cluster / Dialog` 四模式**
2. **IM 通道对外只暴露一种默认体验：`会话模式`**
3. **内部执行策略可以仍然用 Agent / Cluster / Dialog，但不要把这个内部实现细节直接显示成用户主状态**
4. **每个 IM 会话都要绑定自己的独立运行时，而不是共用全局单个 Dialog 房间**

这会直接解决现在几个核心问题：

1. 默认连接可以稳定自动恢复
2. 右下角状态不会再错把 IM 会话显示成 `Dialog 房间`
3. 钉钉用户不会被“四种模式切换”干扰
4. 不同 IM 会话之间可以并行，不再像全局阻塞

### 1.2 推荐产品心智

建议把 IM 通道统一定义为：

```text
IM 会话 = 外部入口
AI 会话 = 内部运行时
执行策略 = Ask / Agent / Cluster / Dialog（内部自动选择）
```

也就是说：

1. 用户在钉钉里看到的是“当前会话 / 当前话题 / 当前任务”
2. 系统内部可以选择单 Agent、并行分工或协作房间来完成
3. 右下角状态应该展示“来源 + 会话 + 当前阶段”，而不是内部实现名词

---

## 2. 问题诊断

### 2.1 IM 通道默认不连接

当前实现里 IM 通道是通过 `ChannelConfigPanel` 手动注册的，保存的通道配置没有在应用启动时自动恢复连接。

结果：

1. 用户配置完 IM 通道后，重新打开应用并不会自动在线
2. “作为桌面常驻 IM 助手”这件事心智不成立

### 2.2 右下角状态显示 `Dialog 房间`

当前运行时状态复用了 `dialog` 模式的 fallback title 和 status，默认显示：

1. `Dialog 房间`
2. `协作中`
3. 某条很长的任务摘要

这在桌面端多 Agent 面板里是合理的，但在 IM 通道场景下不合理，因为：

1. 用户并不关心内部是不是 Dialog
2. IM 用户感知的是“钉钉会话正在处理”
3. 如果内部只是为了完成钉钉消息而临时借用了 Dialog/Cluster，这不应该反映到主状态 UI

### 2.3 钉钉下“四种模式”不适合直接暴露

当前产品默认有四种模式，但 IM 用户并没有完整桌面界面能力：

1. 没法自然切模式
2. 没法方便地新开房间 / 重置房间 / fork 新任务
3. 没法理解“当前消息为什么落进 Dialog，而不是 Agent”

所以如果继续显示 `Dialog 模式`，只会造成：

1. 概念泄漏
2. 状态误导
3. 会话控制能力缺失

### 2.4 钉钉像阻塞式，只能一件事做到底

根因不是钉钉本身，而是当前路由心智更接近：

```text
所有 IM 消息 -> 统一进入一个共享协作运行时
```

这样会导致：

1. 当前任务没结束时，新消息只能排队
2. 用户再发一句话，系统倾向于当作“继续当前任务”
3. 没有每个会话自己的隔离上下文和生命周期

这对桌面协作房间合理，但对 IM 直聊不合理。

---

## 3. 目标方案

## 3.1 通道启动策略：IM 通道默认自动连接

### 目标

已保存且启用的 IM 通道，在应用启动后自动连接。

### 推荐规则

1. `enabled=true` 的通道默认自动连接
2. 启动失败时保留失败状态，并支持自动重连
3. 允许用户单独关闭“开机自动连接”

### 配置模型建议

在 `ChannelConfig` 上新增：

```ts
autoConnect?: boolean; // 默认 true
```

并把当前本地存储的 IM 配置，从“只是配置面板的临时存储”升级为“通道运行时的正式配置源”。

### 启动流程建议

```text
应用启动
  -> ActorSystem 初始化
  -> ChannelManager 初始化
  -> 读取已保存 IM 通道
  -> 对 enabled + autoConnect 的通道自动 register/connect
  -> 同步状态到 UI
```

### UI 建议

在 IM 通道面板里区分两类状态：

1. `已启用（开机自动连）`
2. `当前在线 / 连接中 / 离线 / 异常`

不要把“是否保存”与“是否在线”混在一起。

---

## 3.2 右下角状态栏重构：从“内部模式”改成“用户语义”

### 当前问题

状态栏使用的是内部运行时标签：

1. `Dialog 房间`
2. `Agent 任务`
3. `Cluster 会话`

这对开发者有意义，对 IM 用户没有意义。

### 推荐改法

右下角状态栏拆成 3 层：

1. **来源**
2. **对象**
3. **阶段**

建议文案结构：

```text
钉钉 · 采购群
处理中 · 正在分析需求
00:43
```

或者：

```text
飞书 · 张三私聊
等待回复
```

### 新的状态标签建议

新增一个“展示层 runtime label”，不要直接复用 `mode`：

```ts
displayKind:
  | "ask_conversation"
  | "agent_task"
  | "workflow_task"
  | "collaboration_room"
  | "im_conversation"
```

其中：

1. 桌面真正进入 Dialog 面板时，显示 `collaboration_room`
2. 钉钉 / 飞书触发的运行时，一律显示 `im_conversation`
3. 内部如果借用了 Dialog 执行，也只作为 execution strategy，不上浮到主状态

### 钉钉场景状态文案建议

1. `钉钉会话`
2. `钉钉 · 群聊`
3. `钉钉 · 私聊`
4. `钉钉 · 当前话题`

不要再显示 `Dialog 房间`。

---

## 3.3 模式策略：IM 场景不直接暴露四种模式

### 结论

**钉钉场景下，不适合直接给用户暴露四种模式切换。**

更合适的方案是：

1. 用户侧只看到一个“AI 会话”
2. 系统内部自动决定执行策略

### 推荐执行策略层

为 IM 通道增加 `executionProfile`：

```ts
type IMExecutionProfile =
  | "direct"          // 默认，单轮直答
  | "tool_agent"      // 需要读写文件/命令时升级
  | "background_task" // 长任务后台执行
  | "collab"          // 明确进入协作/评审房间
```

### 默认规则

1. 钉钉默认 `direct`
2. 当消息命中 coding / debug / 多步执行时，自动升级 `tool_agent`
3. 当任务明显复杂，需要分工或复核时，内部升级 `background_task` 或 `collab`
4. 但外部仍展示为“当前会话正在处理”

### Dialog 模式是否适合显示

**不适合默认显示。**

只有两种情况可以显示成“协作房间”：

1. 用户明确在桌面端进入 Dialog 页签
2. 用户在 IM 中显式触发“进入协作模式 / 开评审房间”

否则一律只显示：

1. `钉钉会话`
2. `后台协作中`
3. `已升级为多 Agent 处理`

而不是直接显示 `Dialog 房间`。

---

## 3.4 新开窗口 / 重置：IM 场景要改成“话题管理”

在桌面端，“新开窗口 / 重置房间”是合理的。

在 IM 场景下，更合适的不是窗口，而是：

1. **新话题**
2. **重置当前话题**
3. **查看当前话题状态**
4. **结束后台任务**

### 推荐会话模型

把当前 IM 会话绑定从：

```text
channel + conversationId
```

升级成：

```text
channel + conversationId + topicId
```

其中：

1. 默认 `topicId = default`
2. 用户发“新话题”时创建新的 topic
3. “重置”只重置当前 topic，不影响整个聊天关系

### 钉钉命令建议

建议支持以下轻命令：

1. `/new`：新开话题
2. `/reset`：重置当前话题上下文
3. `/status`：查看当前任务状态
4. `/stop`：停止当前任务
5. `/topics`：列出最近话题

### 桌面配套能力

桌面端增加一个“IM 会话管理台”即可，不需要真的“新开窗口”：

1. 查看每个通道下活跃会话
2. 查看每个会话下的当前 topic
3. 手动重置 / 结束 / 转协作

这比“新开窗口”更符合 IM 使用形态。

---

## 3.5 并发与阻塞：最优解是“按会话隔离，并在会话内串行”

### 当前问题

当前像阻塞式，本质是缺少“按 conversation 隔离的运行时”。

### 最优解

推荐采用：

```text
跨会话并行
会话内串行
可中断
可新话题
可后台化
```

### 具体策略

#### A. 不同会话之间

完全并行。

例如：

1. 钉钉 A 群正在跑长任务
2. 飞书 B 私聊仍然可以立即响应
3. 钉钉 C 私聊也不应被 A 阻塞

#### B. 同一会话之内

默认串行。

也就是：

1. 同一 conversation/topic 在同一时间只执行一个主任务
2. 新消息可以进入 follow-up queue
3. 用户可通过 `/stop` 中断
4. 用户可通过 `/new` 切到新 topic

这样能兼顾稳定性与可理解性。

#### C. 长任务的最优表现

长任务不要一直占住“对话入口”，而要升级成后台任务：

1. 先立即 ACK
2. 再异步执行
3. 中间发阶段更新
4. 最终回结果

钉钉如果走 AI 助理接口，还可以进一步支持：

1. `prepare`
2. `update`
3. `finish`

这样可以模拟更好的“输入中 / 处理中”体验。

### 推荐运行时模型

新增：

```ts
IMConversationRuntime {
  channel: "dingtalk" | "feishu";
  conversationId: string;
  topicId: string;
  title?: string;
  status: "idle" | "running" | "waiting" | "queued";
  strategy: "direct" | "tool_agent" | "background_task" | "collab";
  currentTaskId?: string;
}
```

然后由 `IMConversationRuntimeManager` 维护：

1. 每个会话一个 runtime
2. 每个 runtime 自己的队列
3. 每个 runtime 自己的 reset/stop/new-topic

这才是 IM 产品最合理的形态。

---

## 4. 钉钉专属建议

## 4.1 钉钉默认模式

钉钉默认应该是：

1. **会话模式**
2. **短答优先**
3. **复杂任务后台化**

而不是默认把用户扔进 `Dialog`。

## 4.2 钉钉“输入中”建议

如果继续沿用普通机器人回复链路：

1. 没有飞书 reaction 那样自然的 typing 能力
2. 不建议用“假消息”硬模拟

最优解是：

1. 普通机器人链路下：用“快速 ACK + 阶段更新”替代 typing
2. 如果要做真正更像 OpenClaw 的体验：升级到钉钉 AI 助理分步发送接口

## 4.3 钉钉消息更新建议

推荐统一成 3 段式：

1. `已收到，正在处理`
2. `处理中：正在检索 / 正在分析 / 正在生成`
3. `最终结果`

如果后续接入 AI 助理接口，可映射成真正的 prepare/update/finish。

---

## 5. 分阶段落地建议

## Phase 1：状态与连接收敛

目标：

1. IM 通道开机自动连接
2. 右下角不再显示 `Dialog 房间`
3. 增加 `im_conversation` display kind

实施点：

1. 新增 `IM channel bootstrap`
2. 新增 `autoConnect`
3. 重构 runtime indicator 文案与显示层标签

## Phase 2：会话隔离

目标：

1. 每个 IM 会话独立 runtime
2. 不同会话并行
3. 同一会话串行 + follow-up queue

实施点：

1. 引入 `IMConversationRuntimeManager`
2. 路由键从 `conversationId` 升级为 `channel + conversationId + topicId`
3. 让 IM 不再直接绑定全局单 Dialog runtime

## Phase 3：话题管理

目标：

1. 支持 `/new`
2. 支持 `/reset`
3. 支持 `/status`
4. 支持 `/stop`

实施点：

1. 新增 topic store
2. 新增 IM 会话管理台
3. 新增桌面端“当前 IM 会话”调试视图

## Phase 4：钉钉高级体验

目标：

1. 钉钉长任务阶段更新
2. 更好的“处理中”体验
3. 可选升级到 AI 助理 prepare/update/finish

实施点：

1. 抽象统一的 `ChannelProgressEmitter`
2. 飞书映射 typing + reply
3. 钉钉映射 ack/update/final

---

## 6. 这 4 个问题的最终建议

### 问题 1：IM 通道默认要连接

建议：**是，默认自动连接**。

前提：

1. 配置已保存
2. 通道已启用
3. `autoConnect=true`

### 问题 2：右下角 `Dialog 房间` 状态不对

建议：**改成来源导向的状态展示，不再显示内部模式名**。

应显示：

1. `钉钉会话`
2. `飞书会话`
3. `桌面协作房间`

而不是统一 `Dialog 房间`。

### 问题 3：钉钉下四种模式是否适合显示

建议：**不适合**。

最合适的做法是：

1. 钉钉只显示“会话模式”
2. 内部自动升级到 Agent / Cluster / Dialog
3. 如需控制会话，提供 `/new` `/reset` `/stop` `/status`

### 问题 4：钉钉阻塞式、只能连续做一件事，最优解是什么

建议：**按 IM 会话隔离运行时**。

最优策略：

1. 跨会话并行
2. 会话内串行
3. 长任务后台化
4. 提供 stop / reset / new-topic

不要继续把所有 IM 输入都塞进一个共享 Dialog 房间。

---

## 7. 推荐优先级

如果只做一轮最有价值的改造，推荐顺序是：

1. 自动连接 IM 通道
2. 右下角状态改成 `im_conversation`
3. 把 IM 路由从“全局 Dialog 房间”改成“按会话隔离”
4. 增加 `/reset` `/new` `/stop`
5. 最后再做钉钉高级阶段更新能力

这条顺序收益最高，也最不容易把系统越改越乱。
