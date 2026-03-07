/**
 * Context Budget Manager
 *
 * 控制 system prompt 各段落的总 token 预算。
 * 当总量超出时，按优先级从低到高截断。
 */

export interface PromptSection {
  /** 段落标识（调试用） */
  name: string;
  /** 段落内容 */
  content: string;
  /**
   * 优先级（数值越小优先级越高，越晚被截断）。
   * 推荐值:
   *   10 = identity, 20 = rules, 30 = codingBlock,
   *   40 = skills, 50 = memory, 60 = codingHint
   */
  priority: number;
  /** 单段落最大 token（可选，超过则强制截断） */
  maxTokens?: number;
}

export interface BudgetResult {
  /** 截断后的段落（保持原始顺序） */
  sections: { name: string; content: string }[];
  /** 估算总 token */
  totalTokens: number;
  /** 被截断的段落名 */
  truncated: string[];
}

/**
 * 粗略估算 token 数。
 * CJK 字符约 1.5 token/字，ASCII 约 0.25 token/字。
 * 这是一个快速近似，不依赖 tiktoken。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let ascii = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk++;
    } else {
      ascii++;
    }
  }
  return Math.ceil(cjk * 1.5 + ascii * 0.25);
}

function truncateToTokens(text: string, maxTokens: number): string {
  const current = estimateTokens(text);
  if (current <= maxTokens) return text;
  const ratio = maxTokens / current;
  const cutLen = Math.max(1, Math.floor(text.length * ratio) - 20);
  return text.slice(0, cutLen) + "\n…(已截断)";
}

/**
 * 对各段落施加 budget 约束。
 *
 * @param sections  按输出顺序排列的段落
 * @param totalBudget  总 token 预算（0 或负数 = 不限）
 */
export function applyContextBudget(
  sections: PromptSection[],
  totalBudget: number,
): BudgetResult {
  if (totalBudget <= 0) {
    const out = sections
      .filter((s) => s.content)
      .map((s) => ({ name: s.name, content: s.content }));
    return {
      sections: out,
      totalTokens: out.reduce((sum, s) => sum + estimateTokens(s.content), 0),
      truncated: [],
    };
  }

  const items = sections
    .filter((s) => s.content)
    .map((s) => {
      let content = s.content;
      if (s.maxTokens && s.maxTokens > 0) {
        content = truncateToTokens(content, s.maxTokens);
      }
      return { ...s, content, tokens: estimateTokens(content) };
    });

  let total = items.reduce((sum, it) => sum + it.tokens, 0);
  const truncated: string[] = [];

  if (total > totalBudget) {
    const sorted = [...items].sort((a, b) => b.priority - a.priority);
    for (const item of sorted) {
      if (total <= totalBudget) break;
      const excess = total - totalBudget;
      const targetTokens = Math.max(0, item.tokens - excess);
      if (targetTokens === 0) {
        total -= item.tokens;
        item.content = "";
        item.tokens = 0;
        truncated.push(item.name);
      } else {
        item.content = truncateToTokens(item.content, targetTokens);
        const newTokens = estimateTokens(item.content);
        total -= item.tokens - newTokens;
        item.tokens = newTokens;
        truncated.push(item.name);
      }
    }
  }

  return {
    sections: items
      .filter((it) => it.content)
      .map((it) => ({ name: it.name, content: it.content })),
    totalTokens: total,
    truncated,
  };
}
