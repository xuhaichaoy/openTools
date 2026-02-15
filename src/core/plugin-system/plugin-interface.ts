import type { ReactNode } from "react";

// ── AI SDK 接口 ──

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
  /** 搜索关键词（含别名、拼音触发词等） */
  keywords: string[];
  /** 视图标识 — 用于路由（与旧 View 类型兼容） */
  viewId: string;

  /**
   * 渲染函数
   * @param onBack 返回主界面
   * @param ai 核心壳提供的 AI SDK
   */
  render: (props: { onBack: () => void; ai: MToolsAI }) => ReactNode;

  /** AI 可调用的无 UI 动作 */
  actions?: PluginAction[];
}
