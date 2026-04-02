export interface AIConfig {
  model: string;
  temperature: number;
  max_tokens: number | null;
  system_prompt: string;
  thinking_enabled: boolean;
}

export const DEFAULT_AI_CONFIG: AIConfig = {
  model: 'claude-opus-4',
  temperature: 0.7,
  max_tokens: null,
  system_prompt: '',
  thinking_enabled: false,
};

export class AIConfigManager {
  private config: AIConfig;

  constructor(config?: Partial<AIConfig>) {
    this.config = { ...DEFAULT_AI_CONFIG, ...config };
  }

  get(key: keyof AIConfig): any {
    return this.config[key];
  }

  set(key: keyof AIConfig, value: any): void {
    this.config[key] = value;
  }

  getAll(): AIConfig {
    return { ...this.config };
  }

  update(updates: Partial<AIConfig>): void {
    this.config = { ...this.config, ...updates };
  }
}
