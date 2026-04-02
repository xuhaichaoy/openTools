import type { AIConfig } from './ai-config-manager';

export interface ValidationError {
  field: string;
  message: string;
}

export class AIConfigValidator {
  validate(config: Partial<AIConfig>): ValidationError[] {
    const errors: ValidationError[] = [];

    if (config.temperature !== undefined) {
      if (config.temperature < 0 || config.temperature > 1) {
        errors.push({ field: 'temperature', message: 'Must be between 0 and 1' });
      }
    }

    if (config.max_tokens !== undefined && config.max_tokens !== null) {
      if (config.max_tokens < 1) {
        errors.push({ field: 'max_tokens', message: 'Must be positive' });
      }
    }

    return errors;
  }
}
