import type { ReactNode } from "react";
import type { PluginStorage } from "./storage";
import type { PluginContext } from "./context";

// ── AI SDK 接口 ──

/** OpenAI Function Calling 工具定义 */
export interface AIToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
  };
}

/** Function Calling 返回的工具调用 */
export interface AIToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

/** Core Shell 向所有插件暴露的 AI 能力 */
export interface MToolsAI {
  /** 单轮对话 */
  chat(options: {
    messages: { role: "system" | "user" | "assistant"; content: string }[];
    model?: string;
    temperature?: number;
  }): Promise<{ content: string; usage?: { tokens: number } }>;

  /** 流式对话 */
  stream(options: {
    messages: { role: string; content: string }[];
    onChunk: (chunk: string) => void;
    onDone?: (full: string) => void;
  }): Promise<void>;

  /**
   * 带工具定义的流式对话 — Agent 专用
   * 后端传递 tools 给 API，收到 tool_calls 时通知前端，不自动执行。
   * 返回值区分两种结果：纯文本回复 或 工具调用请求。
   */
  streamWithTools?(options: {
    messages: { role: string; content: string | null; tool_calls?: AIToolCall[]; tool_call_id?: string; name?: string }[];
    tools: AIToolDefinition[];
    onChunk: (chunk: string) => void;
    onDone?: (full: string) => void;
  }): Promise<
    | { type: "content"; content: string }
    | { type: "tool_calls"; toolCalls: AIToolCall[] }
  >;

  /** 文本向量化 */
  embedding(text: string): Promise<number[]>;

  /** 获取当前可用模型列表 */
  getModels(): Promise<{ id: string; name: string }[]>;
}

// ── 插件动作接口（AI tool_call 和无 UI 自动化）──

export interface PluginActionParam {
  type: "string" | "number" | "boolean" | "object";
  description?: string;
  required?: boolean;
}

/** 插件暴露给 AI 的可调用动作 */
export interface PluginAction {
  /** 动作标识 */
  name: string;
  /** AI 理解用途的自然语言描述 */
  description: string;
  /** 参数定义 */
  parameters?: Record<string, PluginActionParam>;
  /** 执行函数 */
  execute: (
    params: Record<string, unknown>,
    ctx: { ai: MToolsAI },
  ) => Promise<unknown>;
}

// ── 内置插件注册接口 ──

export interface MToolsPlugin {
  /** 唯一标识（全局唯一） */
  id: string;
  /** 显示名 */
  name: string;
  /** 一句话描述 */
  description: string;
  /** 图标 */
  icon: ReactNode;
  /** 主题色 CSS 类名 */
  color: string;
  /** 分类 */
  category: "工具" | "AI" | "数据" | "系统";
  /**
   * 层级：core 为核心能力（不可禁用），extension 为可选扩展
   * @default "extension"
   */
  tier?: "core" | "extension";
  /**
   * 是否出现在搜索结果中。
   * 设为 false 的插件仍可通过 viewId 导航，但不会被用户搜索命中。
   * @default true
   */
  searchable?: boolean;
  /** 搜索关键词（含别名、拼音触发词等） */
  keywords: string[];
  /** 视图标识 — 用于路由（与旧 View 类型兼容） */
  viewId: string;

  /**
   * 渲染函数
   * @param onBack 返回主界面
   * @param context 统一插件上下文（AI、存储、事件等）
   */
  render: (props: {
    onBack: () => void;
    context: PluginContext;
  }) => ReactNode;

  /** 插件被激活时调用（切换到该插件视图） */
  onActivate?: (context: PluginContext) => void | Promise<void>;
  /** 插件被停用时调用（切出该插件视图） */
  onDeactivate?: () => void;

  /** AI 可调用的无 UI 动作 */
  actions?: PluginAction[];
}

/** 插件组件的 Props 类型（render 函数的参数） */
export type MToolsPluginProps = {
  onBack: () => void;
  context: PluginContext;
};
