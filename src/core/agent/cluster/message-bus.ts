import type { AgentMessage, AgentMessageType } from "./types";

type MessageHandler = (message: AgentMessage) => void;

let nextMsgId = 0;

/**
 * Agent 间通信总线：Blackboard（共享黑板）+ Pub/Sub 事件。
 *
 * - Blackboard: 各 Agent 可读写共享上下文（key-value），用于传递中间结果
 * - Pub/Sub: 点对点或广播消息，用于实时协调
 *
 * 本地模式下为纯内存实现，零延迟。
 * 远程模式可通过 Tauri Event / MCP 消息转发扩展。
 */
const MAX_MESSAGE_HISTORY = 2000;

export class ClusterMessageBus {
  private blackboard = new Map<string, unknown>();
  private subscribers = new Map<string, MessageHandler[]>();
  private globalSubscribers: MessageHandler[] = [];
  private messageHistory: AgentMessage[] = [];
  private maxHistory: number;

  constructor(maxHistory = MAX_MESSAGE_HISTORY) {
    this.maxHistory = maxHistory;
  }

  // ── Blackboard ──

  getContext<T = unknown>(key: string): T | undefined {
    return this.blackboard.get(key) as T | undefined;
  }

  setContext(key: string, value: unknown): void {
    this.blackboard.set(key, value);
  }

  hasContext(key: string): boolean {
    return this.blackboard.has(key);
  }

  deleteContext(key: string): boolean {
    return this.blackboard.delete(key);
  }

  getAllContext(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [k, v] of this.blackboard) {
      result[k] = v;
    }
    return result;
  }

  /**
   * 从 blackboard 中按 inputMapping 提取子集上下文。
   * mapping 格式: { localKey: "blackboardKey" }
   */
  resolveInputMapping(mapping: Record<string, string>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [localKey, bbKey] of Object.entries(mapping)) {
      if (this.blackboard.has(bbKey)) {
        result[localKey] = this.blackboard.get(bbKey);
      }
    }
    return result;
  }

  // ── Pub/Sub ──

  publish(message: Omit<AgentMessage, "id" | "timestamp">): AgentMessage {
    const full: AgentMessage = {
      ...message,
      id: `msg-${nextMsgId++}`,
      timestamp: Date.now(),
    };
    this.messageHistory.push(full);
    if (this.messageHistory.length > this.maxHistory) {
      this.messageHistory = this.messageHistory.slice(-Math.floor(this.maxHistory * 0.8));
    }

    if (full.to) {
      const handlers = this.subscribers.get(full.to) ?? [];
      for (const h of handlers) h(full);
    } else {
      for (const handlers of this.subscribers.values()) {
        for (const h of handlers) h(full);
      }
    }
    for (const h of this.globalSubscribers) h(full);
    return full;
  }

  subscribe(agentId: string, handler: MessageHandler): () => void {
    const list = this.subscribers.get(agentId) ?? [];
    list.push(handler);
    this.subscribers.set(agentId, list);
    return () => {
      const current = this.subscribers.get(agentId) ?? [];
      this.subscribers.set(
        agentId,
        current.filter((h) => h !== handler),
      );
    };
  }

  onAnyMessage(handler: MessageHandler): () => void {
    this.globalSubscribers.push(handler);
    return () => {
      this.globalSubscribers = this.globalSubscribers.filter((h) => h !== handler);
    };
  }

  getMessageHistory(): AgentMessage[] {
    return [...this.messageHistory];
  }

  getMessagesFrom(agentId: string): AgentMessage[] {
    return this.messageHistory.filter((m) => m.from === agentId);
  }

  getMessagesOfType(type: AgentMessageType): AgentMessage[] {
    return this.messageHistory.filter((m) => m.type === type);
  }

  // ── Lifecycle ──

  clear(): void {
    this.blackboard.clear();
    this.subscribers.clear();
    this.globalSubscribers = [];
    this.messageHistory = [];
  }

  snapshot(): {
    blackboard: Record<string, unknown>;
    messages: AgentMessage[];
  } {
    return {
      blackboard: this.getAllContext(),
      messages: this.getMessageHistory(),
    };
  }
}
