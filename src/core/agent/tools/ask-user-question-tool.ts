import type { ToolDefinition } from '../actor/types';

export const ASK_USER_QUESTION_TOOL_NAME = 'ask_user_question';

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface AskUserQuestionInput {
  questions: Question[];
}

export function createAskUserQuestionTool(): ToolDefinition {
  return {
    name: ASK_USER_QUESTION_TOOL_NAME,
    description: 'Ask user questions during execution',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              header: { type: 'string' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label', 'description'],
                },
              },
              multiSelect: { type: 'boolean' },
            },
            required: ['question', 'header', 'options', 'multiSelect'],
          },
        },
      },
      required: ['questions'],
    },
    handler: async (input: AskUserQuestionInput) => {
      // 实际实现需要与 UI 交互
      return {
        answers: {},
        message: 'User questions asked',
      };
    },
  };
}
