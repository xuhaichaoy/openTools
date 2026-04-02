export interface ContextInjectionOptions {
  systemPrompt: string;
  memories: string[];
  messages: any[];
  maxTokens: number;
}

export class ContextInjectionManager {
  inject(options: ContextInjectionOptions): any[] {
    const result = [];

    // 1. System prompt (最高优先级)
    result.push({
      role: 'system',
      content: options.systemPrompt,
    });

    // 2. Memory (在 system 之后)
    if (options.memories.length > 0) {
      result.push({
        role: 'system',
        content: `Relevant memories:\n${options.memories.join('\n\n')}`,
      });
    }

    // 3. 历史消息
    result.push(...options.messages);

    return result;
  }
}
