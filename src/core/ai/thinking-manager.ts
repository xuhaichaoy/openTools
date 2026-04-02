export interface ThinkingBlock {
  type: 'thinking';
  content: string;
  timestamp: number;
}

export class ThinkingManager {
  private blocks: ThinkingBlock[] = [];

  add(content: string): void {
    this.blocks.push({
      type: 'thinking',
      content,
      timestamp: Date.now(),
    });
  }

  getAll(): ThinkingBlock[] {
    return [...this.blocks];
  }

  clear(): void {
    this.blocks = [];
  }
}
