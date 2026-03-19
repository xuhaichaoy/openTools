---
name: Dialog Agent 管理增强
overview: 为 Dialog 模式的 Agent 设置面板增加三项能力：Agent 排序、默认发送 Agent 切换、单个 Agent 编辑。
todos:
  - id: agent-actor-update
    content: "agent-actor.ts: 新增 updateConfig 方法，modelOverride 去掉 readonly"
    status: done
  - id: actor-system-reorder
    content: "actor-system.ts: 新增 reorderActors 方法"
    status: done
  - id: store-actions
    content: "actor-system-store.ts: 新增 setCoordinator / reorderActors / updateActorConfig actions"
    status: done
  - id: ui-enhancement
    content: "ActorChatPanel.tsx: LiveActorRow 增加排序、默认、编辑功能 + handlers"
    status: done
  - id: lint-final
    content: lint 检查并修复所有改动文件
    status: done
isProject: false
---

# Dialog Agent 管理增强

## 现状分析

当前 Agent 设置面板（`ActorChatPanel.tsx:6480-6578`）只支持：

- 添加 Agent（`AddAgentForm`）
- 删除 Agent（`LiveActorRow` 的 X 按钮）
- 应用预设

缺失三项核心功能：

1. **Agent 排序**：列表顺序由 `ActorSystem.actors` Map 插入顺序决定，无法调整
2. **默认发送切换**：coordinator 由首次 spawn 的 Agent 自动成为，无 UI 手动指定
3. **Agent 编辑**：`LiveActorRow` 只读展示 + 删除，无法修改已有 Agent 的模型、能力等

---

## 改动方案

### 1. ActorSystem 新增 `reorderActors` 方法

**文件**: [src/core/agent/actor/actor-system.ts](src/core/agent/actor/actor-system.ts)

`actors` 是 `Map`，按插入顺序迭代。新增 `reorderActors(orderedIds: string[])` 方法，将 Map 按指定 ID 顺序重建：

```typescript
reorderActors(orderedIds: string[]): void {
  const reordered = new Map<string, AgentActor>();
  for (const id of orderedIds) {
    const actor = this.actors.get(id);
    if (actor) reordered.set(id, actor);
  }
  // 追加未出现在 orderedIds 中的 actor（防御性）
  for (const [id, actor] of this.actors) {
    if (!reordered.has(id)) reordered.set(id, actor);
  }
  this.actors = reordered;
}
```

注意：`actors` 当前声明为 `private actors = new Map<string, AgentActor>()`，需要确认可赋值。

### 2. AgentActor 新增 `updateConfig` 方法

**文件**: [src/core/agent/actor/agent-actor.ts](src/core/agent/actor/agent-actor.ts)

当前 `modelOverride` 是 `readonly`，其他字段是 private 无 setter。新增一个安全的热更新方法，仅在 idle 状态允许更新：

```typescript
updateConfig(patch: {
  name?: string;
  modelOverride?: string;
  workspace?: string;
  thinkingLevel?: ThinkingLevel;
  toolPolicy?: ToolPolicy;
  middlewareOverrides?: MiddlewareOverrides;
  capabilities?: AgentCapabilities;
}): void {
  if (this._status !== "idle") throw new Error("Cannot update config while running");
  if (patch.name !== undefined) this.role.name = patch.name;
  if (patch.modelOverride !== undefined) (this as any).modelOverride = patch.modelOverride;
  if (patch.workspace !== undefined) this._workspace = patch.workspace || undefined;
  if (patch.thinkingLevel !== undefined) this._thinkingLevel = patch.thinkingLevel;
  if (patch.toolPolicy !== undefined) this._toolPolicy = patch.toolPolicy;
  if (patch.middlewareOverrides !== undefined) this._middlewareOverrides = patch.middlewareOverrides;
  if (patch.capabilities !== undefined) this._capabilities = patch.capabilities;
}
```

将 `modelOverride` 从 `readonly` 改为普通属性（或通过 setter 包装）。

### 3. Store 层新增 actions

**文件**: [src/store/actor-system-store.ts](src/store/actor-system-store.ts)

在 `ActorSystemState` interface 和 store 实现中新增：

- `setCoordinator(actorId: string)`: 调用 `system.setCoordinator(actorId)` 并 sync
- `reorderActors(orderedIds: string[])`: 调用 `system.reorderActors(orderedIds)` 并 sync
- `updateActorConfig(actorId: string, patch: ActorConfigPatch)`: 调用 `actor.updateConfig(patch)` 并 sync

### 4. LiveActorRow 增强 UI

**文件**: [src/plugins/builtin/SmartAgent/components/actor/ActorChatPanel.tsx](src/plugins/builtin/SmartAgent/components/actor/ActorChatPanel.tsx)

#### 4a. 排序按钮

在 `LiveActorRow` 中添加上移/下移按钮（ChevronUp / ChevronDown），点击时调用 `onMoveUp` / `onMoveDown`。

#### 4b. 设为默认发送

在 `LiveActorRow` 中添加"设为默认"按钮（或 star 图标），当前 coordinator 高亮显示。点击时调用 `onSetDefault`。

#### 4c. 编辑面板

点击 Agent 行展开一个内联编辑区（类似 `AddAgentForm` 但预填当前值），提供保存/取消按钮。可编辑字段：名称、模型、能力标签、工作区、工具策略、思考深度。

#### 外层变化

`ActorChatPanel.tsx` 中循环渲染 `LiveActorRow` 处（约 6550-6557 行）传入新的 props：

```typescript
<LiveActorRow
  key={actor.id}
  actor={actor}
  index={i}
  isCoordinator={actor.id === coordinatorActorId}
  isFirst={i === 0}
  isLast={i === actors.length - 1}
  onRemove={() => handleRemoveAgent(actor.id)}
  onMoveUp={() => handleMoveAgent(actor.id, -1)}
  onMoveDown={() => handleMoveAgent(actor.id, 1)}
  onSetDefault={() => handleSetCoordinator(actor.id)}
  onUpdate={(patch) => handleUpdateAgent(actor.id, patch)}
  models={models}
/>
```

新增对应的 handler 函数（`handleMoveAgent`、`handleSetCoordinator`、`handleUpdateAgent`）。

---

## 涉及文件

- `src/core/agent/actor/actor-system.ts` — 新增 `reorderActors` 方法
- `src/core/agent/actor/agent-actor.ts` — 新增 `updateConfig` 方法，`modelOverride` 去掉 readonly
- `src/store/actor-system-store.ts` — 新增 3 个 store actions
- `src/plugins/builtin/SmartAgent/components/actor/ActorChatPanel.tsx` — `LiveActorRow` 增强 + 新增 handlers

## 执行顺序

1. 先改底层：`agent-actor.ts`（updateConfig + readonly 改造）
2. 改 `actor-system.ts`（reorderActors）
3. 改 `actor-system-store.ts`（3 个 actions）
4. 改 `ActorChatPanel.tsx`（UI 增强）
5. lint 检查

