import type { Workflow } from './types'

const now = Date.now()

export const builtinWorkflows: Workflow[] = [
  {
    id: 'translate-clipboard',
    name: '剪贴板翻译',
    icon: '🌐',
    description: '读取剪贴板内容，翻译为英文，写回剪贴板',
    category: '翻译',
    trigger: { type: 'keyword', keyword: '翻译剪贴板' },
    steps: [
      {
        id: 'read',
        name: '读取剪贴板',
        type: 'clipboard_read',
        config: {},
        output_var: 'clipboard_text',
      },
      {
        id: 'translate',
        name: 'AI 翻译',
        type: 'ai_chat',
        config: {
          prompt: '将以下中文翻译为地道的英文，只输出翻译结果，不要解释：\n\n{{clipboard_text}}',
          system_prompt: '你是一位专业翻译，擅长中译英。只输出翻译结果。',
          temperature: 0.3,
        },
        output_var: 'translated',
      },
      {
        id: 'write',
        name: '写入剪贴板',
        type: 'clipboard_write',
        config: { text: '{{translated}}' },
      },
      {
        id: 'notify',
        name: '完成通知',
        type: 'notification',
        config: { message: '翻译完成，已复制到剪贴板' },
      },
    ],
    builtin: true,
    created_at: now,
  },
  {
    id: 'polish-clipboard',
    name: '剪贴板润色',
    icon: '✨',
    description: '读取剪贴板内容，AI 润色后写回剪贴板',
    category: '写作',
    trigger: { type: 'keyword', keyword: '润色剪贴板' },
    steps: [
      {
        id: 'read',
        name: '读取剪贴板',
        type: 'clipboard_read',
        config: {},
        output_var: 'clipboard_text',
      },
      {
        id: 'polish',
        name: 'AI 润色',
        type: 'ai_chat',
        config: {
          prompt: '请帮我润色以下文字，使其更加通顺、专业、有条理。只输出润色后的文字，不要解释：\n\n{{clipboard_text}}',
          temperature: 0.6,
        },
        output_var: 'polished',
      },
      {
        id: 'write',
        name: '写入剪贴板',
        type: 'clipboard_write',
        config: { text: '{{polished}}' },
      },
      {
        id: 'notify',
        name: '完成通知',
        type: 'notification',
        config: { message: '润色完成，已复制到剪贴板' },
      },
    ],
    builtin: true,
    created_at: now,
  },
  {
    id: 'summarize-clipboard',
    name: '剪贴板摘要',
    icon: '📋',
    description: '读取剪贴板内容，AI 生成摘要后写回剪贴板',
    category: '写作',
    trigger: { type: 'keyword', keyword: '摘要剪贴板' },
    steps: [
      {
        id: 'read',
        name: '读取剪贴板',
        type: 'clipboard_read',
        config: {},
        output_var: 'clipboard_text',
      },
      {
        id: 'summarize',
        name: 'AI 摘要',
        type: 'ai_chat',
        config: {
          prompt: '请帮我总结以下内容的核心要点，使用简洁的中文，用列表形式呈现：\n\n{{clipboard_text}}',
          temperature: 0.4,
        },
        output_var: 'summary',
      },
      {
        id: 'write',
        name: '写入剪贴板',
        type: 'clipboard_write',
        config: { text: '{{summary}}' },
      },
      {
        id: 'notify',
        name: '完成通知',
        type: 'notification',
        config: { message: '摘要完成，已复制到剪贴板' },
      },
    ],
    builtin: true,
    created_at: now,
  },
  {
    id: 'code-explain',
    name: '解释代码',
    icon: '📖',
    description: '读取剪贴板中的代码，AI 逐行解释',
    category: '编程',
    trigger: { type: 'keyword', keyword: '解释代码' },
    steps: [
      {
        id: 'read',
        name: '读取剪贴板',
        type: 'clipboard_read',
        config: {},
        output_var: 'code',
      },
      {
        id: 'explain',
        name: 'AI 解释',
        type: 'ai_chat',
        config: {
          prompt: '请逐行解释以下代码的功能，使用中文，清晰简洁：\n\n```\n{{code}}\n```',
          temperature: 0.3,
        },
        output_var: 'explanation',
      },
      {
        id: 'write',
        name: '写入剪贴板',
        type: 'clipboard_write',
        config: { text: '{{explanation}}' },
      },
      {
        id: 'notify',
        name: '完成通知',
        type: 'notification',
        config: { message: '代码解释完成，已复制到剪贴板' },
      },
    ],
    builtin: true,
    created_at: now,
  },
]
