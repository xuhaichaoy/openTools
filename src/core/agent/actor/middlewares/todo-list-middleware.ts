/**
 * TodoListMiddleware — Agent Todo 管理中间件
 *
 * 灵感来源：Yuxi-Know 的 TodoListMiddleware（用于 DeepAgent 深度分析场景）
 *
 * 为 Agent 提供 todo_add / todo_update / todo_list 工具，
 * 让 Agent 能管理任务列表，追踪复杂任务的进度。
 * Todo 状态在 session 期间持久化。
 */

import type { AgentTool } from "@/plugins/builtin/SmartAgent/core/react-agent";
import type { ActorMiddleware, ActorRunContext } from "../actor-middleware";

export interface TodoItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "done" | "cancelled";
  priority: "high" | "medium" | "low";
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

/** Per-actor todo storage (session-scoped) */
const actorTodos = new Map<string, TodoItem[]>();

function getActorTodos(actorId: string): TodoItem[] {
  if (!actorTodos.has(actorId)) actorTodos.set(actorId, []);
  return actorTodos.get(actorId)!;
}

function generateTodoId(): string {
  return `todo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function createTodoTools(actorId: string): AgentTool[] {
  return [
    {
      name: "todo_add",
      description: "添加一个待办事项到任务列表。用于追踪复杂任务的各个步骤。",
      parameters: {
        title: { type: "string", description: "待办事项标题", required: true },
        priority: { type: "string", description: "优先级: high/medium/low，默认 medium", required: false },
        notes: { type: "string", description: "备注信息", required: false },
      },
      readonly: false,
      execute: async (params) => {
        const todos = getActorTodos(actorId);
        const item: TodoItem = {
          id: generateTodoId(),
          title: String(params.title ?? ""),
          status: "pending",
          priority: (params.priority as TodoItem["priority"]) ?? "medium",
          notes: params.notes ? String(params.notes) : undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        todos.push(item);
        return { added: true, id: item.id, total: todos.length };
      },
    },
    {
      name: "todo_update",
      description: "更新待办事项的状态。status 可选: pending/in_progress/done/cancelled",
      parameters: {
        id: { type: "string", description: "待办事项 ID", required: true },
        status: { type: "string", description: "新状态: pending/in_progress/done/cancelled", required: false },
        notes: { type: "string", description: "更新备注", required: false },
      },
      readonly: false,
      execute: async (params) => {
        const todos = getActorTodos(actorId);
        const item = todos.find((t) => t.id === String(params.id));
        if (!item) return { error: `Todo ${params.id} not found` };
        if (params.status) item.status = params.status as TodoItem["status"];
        if (params.notes) item.notes = String(params.notes);
        item.updatedAt = Date.now();
        return { updated: true, item };
      },
    },
    {
      name: "todo_list",
      description: "列出当前所有待办事项及其状态。用于检查任务进度。",
      parameters: {
        filter: { type: "string", description: "过滤状态: all/pending/in_progress/done，默认 all", required: false },
      },
      readonly: true,
      execute: async (params) => {
        const todos = getActorTodos(actorId);
        const filter = String(params.filter ?? "all");
        const filtered = filter === "all"
          ? todos
          : todos.filter((t) => t.status === filter);
        return {
          items: filtered.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            priority: t.priority,
            notes: t.notes,
          })),
          summary: {
            total: todos.length,
            pending: todos.filter((t) => t.status === "pending").length,
            in_progress: todos.filter((t) => t.status === "in_progress").length,
            done: todos.filter((t) => t.status === "done").length,
            cancelled: todos.filter((t) => t.status === "cancelled").length,
          },
        };
      },
    },
  ];
}

export class TodoListMiddleware implements ActorMiddleware {
  readonly name = "TodoList";

  async apply(ctx: ActorRunContext): Promise<void> {
    const todoTools = createTodoTools(ctx.actorId);
    ctx.tools = [...ctx.tools, ...todoTools];

    // Inject current todo status into context if there are active todos
    const todos = getActorTodos(ctx.actorId);
    const active = todos.filter((t) => t.status === "pending" || t.status === "in_progress");
    if (active.length > 0) {
      const todoSummary = active.map((t) =>
        `- [${t.status === "in_progress" ? "进行中" : "待办"}] ${t.title}${t.notes ? ` (${t.notes})` : ""}`,
      ).join("\n");
      ctx.contextMessages = [
        {
          role: "user" as const,
          content: [
            "[系统提醒] 你之前创建的待办列表依然有效，即使原始工具调用已经不在当前上下文里。",
            "当前活跃待办如下：",
            todoSummary,
            "当任何事项状态变化时，请主动调用 todo_update 保持待办列表同步。",
          ].join("\n"),
        },
        ...ctx.contextMessages,
      ];
    }
  }
}

/** Clear todos for an actor (call on session reset) */
export function clearActorTodos(actorId: string): void {
  actorTodos.delete(actorId);
}

/** Clear all actor todos */
export function clearAllTodos(): void {
  actorTodos.clear();
}

/** Get todos for external access (e.g., UI display) */
export function getActorTodoList(actorId: string): readonly TodoItem[] {
  return getActorTodos(actorId);
}

/** Replace todos for an actor (used by session restore / external sync) */
export function replaceActorTodoList(actorId: string, items: readonly TodoItem[]): void {
  actorTodos.set(
    actorId,
    items.map((item) => ({
      ...item,
    })),
  );
}
