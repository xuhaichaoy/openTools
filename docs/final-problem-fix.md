# Dialog Runtime 与 Spreadsheet 交付最终修复文档

更新时间：2026-04-02  
适用范围：`/Users/haichao/Desktop/work/51ToolBox`  
相关日志：`/Users/haichao/51toolbox-dialog-step-trace.txt`  
相关计划草案：`/Users/haichao/.claude/plans/crystalline-swinging-rain.md`

## 一、最终结论

当前问题不是单一问题，而是**两层问题叠加**：

1. **当前阻塞问题（P0）**：`ActorSystem` 生命周期与 trace 归属混乱  
   - 最新日志（`2026-04-01 23:56:30` 到 `2026-04-01 23:57:05`）只显示：
     - `system_instance_created`
     - `system_instance_replaced`
     - `session_started`
     - 少量旧 session 的 `status_change`
   - 这说明当前 run 甚至**还没真正进入 LLM / tool / spreadsheet 导出主链**，就已经在 system/runtime 层发生抖动。
   - 因此，**最新问题的第一优先级不是 spreadsheet repair，而是 runtime/session 稳定性修复**。

2. **历史深层问题（P1/P2）**：dialog spreadsheet 交付链路与 Claude Code 风格严重偏离  
   - 这部分是 `crystalline-swinging-rain.md` 中判断最准确的部分。
   - 真实问题包括：
     - 多控制面工具池
     - `single_workbook / host_export / validation_repair` 平行控制流过重
     - `export_spreadsheet.sheets` 仍然是 JSON 字符串
     - prompt 与真实可见工具漂移
   - 这会导致历史上出现的：
     - 先文本答复并过早 `task_done`
     - 之后进入 `validation_repair`
     - repair 阶段重复调用 `export_spreadsheet`
     - 因 `sheets` 不是有效 JSON 而失败

**最终判断**：  
`crystalline-swinging-rain.md` 对 **spreadsheet 架构问题** 的判断大体正确；  
但它把 **当前最新日志问题** 也定性成 spreadsheet 导出故障，这一点不对。  
正确做法是：**先修 P0 runtime/session 问题，再推进 P1/P2 spreadsheet 架构迁移。**

---

## 二、最新日志真实暴露的问题

### 2.1 日志事实

最新日志只有 14 行，核心模式如下：

- `system_instance_created`
- 紧接着数毫秒内出现 `system_instance_replaced`
- 又立刻 `system_instance_created`
- 最终才落 `session_started`
- 同时夹杂旧 session 的 `status_change`

这说明：

1. **短时间内创建了多个 `ActorSystem`**
2. **trace 把这些实例视为“替换关系”**
3. **旧实例没有完全停止就还在写事件**
4. **同一个 trace 文件混入了多个 runtime / session 的事件**

### 2.2 为什么这是当前第一问题

因为如果 `ActorSystem` 本身都在抖：

- tool 调度链路再正确也不稳定
- session 记忆、inbox、pending interaction 可能归属错 session
- `dialog_step_trace` 会把不同实例事件串在一起，误导后续定位
- 任何 spreadsheet 导出失败都可能是“前面实例已经切换/重建”带来的次生问题

换句话说，**当前必须先把“系统是不是同一个系统”这个问题解决掉**。

---

## 三、当前根因模型（最终版）

## 3.1 P0：ActorSystem 生命周期 / trace 归属问题

### 根因 A：`ActorSystem` 的“替换”判定是全局的，不区分 surface / runtime

关键文件：

- `/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/actor-system.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/dialog-step-trace.ts`

当前代码里存在：

- 模块级全局变量：
  - `lastTracedActorSystemSessionId`
  - `lastTracedActorSystemCreatedAt`
- 只要 1.5 秒内又 new 了一个 `ActorSystem`，就会被记成 `system_instance_replaced`

问题在于：

- 它**没有区分本地 dialog surface** 和 **IM conversation runtime**
- 也没有区分“同一个 runtime 真替换”还是“另一个 runtime 正常创建”

所以：

- 多 runtime 并存时，trace 很容易出现**假 replacement**

### 根因 B：多个入口都能创建 `ActorSystem`

关键入口：

- `/Users/haichao/Desktop/work/51ToolBox/src/store/actor-system-store.ts`
  - 本地 dialog 主系统
- `/Users/haichao/Desktop/work/51ToolBox/src/core/channels/im-conversation-runtime-manager.ts`
  - IM conversation runtime 也会 `new ActorSystem()`

这本身未必是 bug，**问题是没有在 trace/归属层做强区分**。

### 根因 C：trace 文件是全局共用的

关键文件：

- `/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/dialog-step-trace.ts`

当前写到：

- `~/51toolbox-dialog-step-trace.txt`

问题：

- 所有 ActorSystem 实例都往同一个文件写
- 旧实例、IM runtime、本地 dialog runtime 会互相污染观察结果

### 根因 D：旧实例/旧监听器可能没有完全退场

从日志上看，新的 `system_instance_created` 之后，旧 session 还在发 `status_change`。  
这通常意味着至少存在以下一种情况：

1. 旧 `ActorSystem` 还活着
2. 旧 runtime 还活着
3. 旧事件订阅还没解绑
4. 某些异步任务仍持有旧系统引用

需要重点审计：

- `/Users/haichao/Desktop/work/51ToolBox/src/store/actor-system-store.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/core/channels/channel-manager.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/core/channels/im-conversation-runtime-manager.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/core/collaboration/session-controller.ts`

---

## 3.2 P1：Spreadsheet 交付链路控制面过多

这部分是 `crystalline-swinging-rain.md` 里最正确的判断。

关键文件：

- `/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/agent-actor.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/structured-delivery-strategy.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/dynamic-spreadsheet-strategy.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/actor-tools.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/core/react-agent.ts`

当前真实存在的控制面：

1. structured delivery 策略面
2. actor runtime 工具限制面
3. prompt 提示面
4. host-managed export 面
5. validation repair 面

结果就是：

- prompt 以为可以做 A
- visible tools 只允许做 B

- runtime 又会接管成 C
- repair 再走 D

这和 Claude Code 的 **单一 query loop + 单一工具编排面** 完全不是一个模型。

---

## 3.3 P2：`export_spreadsheet` 的 schema 本身脆弱

关键文件：

- `/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/core/default-tools.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src-tauri/src/commands/system.rs`

当前主问题：

- `export_spreadsheet.sheets` 仍然要求字符串化 JSON
- 这等于让模型输出“JSON 字符串里的 JSON”

这会天然带来：

- 转义错误
- 引号错误
- repair 阶段越修越乱
- runtime 再次 stringify / parse 的二次脆弱性

所以这里不是“模型不够聪明”，而是**工具契约设计本身不稳**。

---

## 3.4 P3：Prompt 与真实工具池漂移

关键文件：

- `/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/core/react-agent.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/middlewares/prompt-build-middleware.ts`

历史上出现过：

- prompt 继续鼓励 `sequential_thinking`
- 但当前回合实际工具池里可能没有它

这会导致：

- 模型提议不可用工具
- 运行时报 not_found
- repair / follow-up 轮数被白白浪费

---

## 四、对 `crystalline-swinging-rain.md` 的最终取舍

## 4.1 应保留的判断

以下判断保留，并作为最终修复方案的一部分：

1. **统一 effective tool pool**
2. **废弃 spreadsheet 的 host-managed export 主链地位**
3. **把 `export_spreadsheet.sheets` 改成结构化数组**
4. **把 validation 改为普通工具校验 + workbook 语义校验 + 最终交付校验**
5. **prompt 只能描述当前真实可见工具**

## 4.2 必须修正的地方

以下地方必须改写，不可直接照抄：

1. 不能把“当前问题”直接定性成 spreadsheet 导出问题
2. 不能在 P0 未稳定前就直接大拆 host-export 主链
3. 不能忽略 ActorSystem 生命周期/trace 混乱这个更前置的问题
4. 不能把“参考 Claude Code”误写成“直接删除所有现有 dialog 控制层”

更准确的策略是：

- **先稳定 runtime/session**
- **再统一工具池**
- **再结构化 export schema**
- **最后下沉/移除 host export 主链**

---

## 五、最终修复方案（按优先级）

## P0：先修 ActorSystem 生命周期与 trace 归属

### 目标

先确保：

- 一个 runtime 的事件只属于它自己
- 不同 surface 不会互相伪装成 replacement
- 旧实例不再继续污染 trace

### 必改文件

- `/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/actor-system.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/dialog-step-trace.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/store/actor-system-store.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/core/channels/im-conversation-runtime-manager.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/core/channels/channel-manager.ts`

### 实施要点

1. **给 `ActorSystemOptions` 增加 trace 归属元信息**
   - 建议至少加：
     - `traceSurface: "local_dialog" | "im_conversation"`
     - `traceOwnerId?: string`
     - `traceRuntimeKey?: string`

2. **`system_instance_replaced` 只在同 surface + 同 owner 下判定**
   - 不能再用全局单例时间窗粗暴判定
   - IM runtime 和本地 dialog 并存时，不得互相记成 replacement

3. **trace 行里补充归属字段**
   - 至少加：
     - `surface`
     - `owner`
     - `runtime_key`

4. **补 `system_instance_disposed` / `runtime_disposed` 事件**
   - 让日志能明确看到旧实例何时退出

5. **清理旧监听器和旧 runtime**
   - 明确 store destroy / runtime dispose / channel reconnect 的解绑路径
   - 避免旧 session 在新 session 启动后继续写 `status_change`

### P0 完成标准

- 打开本地 dialog 时，trace 不再在几十毫秒内连续出现 2~3 次 replacement
- 同一轮操作里，只能看到一个主 session 持续输出
- IM runtime 的创建不能再污染本地 dialog replacement 判断

---

## P1：统一单一权威工具池

### 目标

把当前多控制面工具池收敛成：

- **每轮只计算一次**
- prompt / visible tools / runtime execute 共用一套结果

### 必改文件

- `/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/agent-actor.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/actor-tools.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/middlewares/tool-policy-middleware.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/core/agent/runtime/runtime-tool-loop.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/core/react-agent.ts`

### 实施要点

1. 抽出统一的 per-turn effective tool pool builder
2. `react-agent.ts` 只基于 `getAvailableTools()` 生成 prompt
3. structured delivery 不再单独主导 prompt 暴露和 runtime 工具面
4. `visibleToolNames` 与实际执行器读取的工具集合完全一致

### P1 完成标准

- 不再出现 prompt 推荐不可用工具
- `visibleToolNames`、function schema、执行结果三者一致

---

## P2：把 `export_spreadsheet` 改成结构化 schema

### 目标

彻底消灭 `sheets 参数不是有效的 JSON` 这一类错误。

### 必改文件

- `/Users/haichao/Desktop/work/51ToolBox/src/plugins/builtin/SmartAgent/core/default-tools.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src-tauri/src/commands/system.rs`

### 目标 schema

从：

- `file_name: string`
- `sheets: string`

改成：

- `file_name: string`
- `sheets: Array<{ name: string; headers: string[]; rows: Array<Array<string | number | boolean | null>> }>`

### 实施要点

1. 主路径只接受结构化数组
2. `normalizeSpreadsheetSheetsJson(...)` 最多保留为兼容 fallback
3. Rust 侧也直接收结构化输入，不再 `from_str`

### P2 完成标准

- 调用日志里 `export_spreadsheet.sheets` 不再是字符串化 JSON
- repair 轮次不再因为 JSON 转义失败而反复卡死

---

## P3：把 host-managed spreadsheet export 从主路径降级

### 目标

不再让正常 spreadsheet 交付依赖：

- `single_workbook`
- `buildHostExportPlan()`
- `executeDeterministicHostExport()`
- `validation_repair` 专属导出接管

而改成：

- parent actor 聚合结果
- 直接普通 tool call 调 `export_spreadsheet`

### 必改文件

- `/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/agent-actor.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/structured-delivery-strategy.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/dynamic-spreadsheet-strategy.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/dialog-dispatch-plan.ts`

### 实施要点

1. structured delivery 只保留“结构化结果收集”职责
2. host export 不再是主交付路径
3. repair 不再走 host takeover，而是正常 tool retry / blocker 返回

### 注意

这一步必须在 **P0 + P1 + P2** 之后做。  
否则只是把旧不稳定 runtime 上的问题换一种形式继续放大。

---

## P4：重写 validation 语义

### 目标

保留“必须真的交付表格文件”的硬约束，但去掉 dialog 专属 repair 控制面。

### 三层校验

1. **工具输入校验**
   - `export_spreadsheet` schema 合法

2. **workbook 语义校验**
   - sheet 非空
   - headers/rows 对齐
   - 必要列存在

3. **最终交付校验**
   - 必须有真实 `.xlsx` 输出路径
   - 文本答案不能冒充交付成功

### 必改文件

- `/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/delivery-quality-gate.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/dynamic-workbook-builder.ts`
- `/Users/haichao/Desktop/work/51ToolBox/src/core/agent/actor/spawned-task-result-validator.ts`

---

## 六、最终实施顺序

### 第 1 阶段：先稳 runtime

1. 修 `ActorSystem` trace surface / owner / runtime key
2. 修 replacement 判定范围
3. 补 dispose 事件
4. 清理旧 runtime 监听器

### 第 2 阶段：统一工具池

1. 抽 effective tool pool
2. prompt / runtime / visible tools 全部对齐
3. 去掉 prompt 中静态不可用工具推荐

### 第 3 阶段：修 export schema

1. `export_spreadsheet.sheets` 结构化
2. JS/Rust 端到端结构化
3. 兼容旧 string 仅作 fallback

### 第 4 阶段：降级 host export

1. 保留 structured result
2. 去主路径 host export
3. parent 直接普通 tool call 导出

### 第 5 阶段：收口 validation

1. 普通校验
2. 普通 blocker / retry
3. 最终真实 artifact 校验

---

## 七、验证标准

## 7.1 P0 验证（必须先过）

复现本地 dialog 启动：

- 日志不再在 20ms 内连续出现多个 `system_instance_replaced`
- 同一轮只看到一个主 session 连续输出
- 旧 session 不再在新 session 创建后继续刷 `status_change`

## 7.2 Spreadsheet 验证

输入：

- `/Users/haichao/Downloads/AI培训课程需求.xlsx`

回归要求：

- 不再把 `host_export_*` 当正常主路径
- 不再依赖 `single_workbook_mode` / `export_plan_selected` 控制最终导出
- `export_spreadsheet.sheets` 不再是字符串
- 最终必须输出真实 `.xlsx` 路径

## 7.3 Prompt / tool pool 验证

- prompt 里不再推荐当前不可用工具
- `visibleToolNames` 与实际运行工具池一致
- 不再出现 `sequential_thinking` not_found 这类漂移故障

---

## 八、最终裁决

这次问题的**正确修复方向**不是二选一，而是：

1. **承认 `crystalline-swinging-rain.md` 对 spreadsheet 深层问题判断基本正确**
2. **同时修正它对“当前问题”的误判**

最终的正确策略是：

- **先修 runtime / ActorSystem 生命周期与 trace 归属**
- **再按 Claude Code 思路收敛工具池和工具编排**
- **再把 spreadsheet 交付从 host-managed 平行控制面迁回普通 tool call 主链**

只有这样，才能同时解决：

- 当前“系统层先抖”的问题
- 历史“spreadsheet 导出链路失稳”的问题

---

## 九、最小可执行版本（建议立即开始）

如果只做最关键的第一批修复，建议按下面顺序落地：

1. `ActorSystemOptions` 增加 `traceSurface / traceOwnerId / traceRuntimeKey`
2. `dialog-step-trace.ts` 和 `actor-system.ts` 的 replacement 判定改成同 surface/owner 范围内比较
3. trace 行补 `surface / runtime_key`
4. 补 `system_instance_disposed`
5. `export_spreadsheet.sheets` 改结构化 schema
6. `react-agent.ts` 只基于真实工具池生成工具提示

这 6 项完成后，系统会先从“难以观察、难以定位”变成“行为稳定、日志可解释”，之后再做 host-export 主链下沉才不会失控。
