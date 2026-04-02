import { MessageCompactor } from '../agent/runtime/message-compactor';
import { findRelevantMemories } from './memory-recall-optimized';

export interface ContextCoordinatorOptions {
  memoryDir: string;
  maxMessages: number;
  maxMemories: number;
}

export class ContextCoordinator {
  private readonly options: ContextCoordinatorOptions;
  private readonly compactor: MessageCompactor;
  private loadedMemories = new Set<string>();

  constructor(options: ContextCoordinatorOptions) {
    this.options = options;
    this.compactor = new MessageCompactor(options.maxMessages);
  }

  async prepareContext(query: string, messages: any[]): Promise<{
    messages: any[];
    memories: string[];
  }> {
    // 1. 压缩消息
    const { compactedMessages } = this.compactor.compact(messages);

    // 2. 召回 memory（排除已加载的）
    const memories = await findRelevantMemories(
      query,
      this.options.memoryDir,
      this.options.maxMemories,
    );

    const newMemories = memories
      .filter(m => !this.loadedMemories.has(m.path))
      .map(m => m.path);

    newMemories.forEach(p => this.loadedMemories.add(p));

    return {
      messages: compactedMessages,
      memories: newMemories,
    };
  }

  reset(): void {
    this.loadedMemories.clear();
  }
}
