import { getMToolsAI } from "@/core/ai/mtools-ai";

export interface ComplexityAnalysis {
  isComplex: boolean;
  suggestedMode: "single" | "parallel_split" | "multi_role";
  reason: string;
  confidence: number;
}

const COMPLEXITY_MARKERS = [
  /同时|并行|分别|各自|一方面.*另一方面/,
  /首先.*然后.*最后|第一步.*第二步/,
  /分析.*实现.*测试|研究.*编写.*审查/,
  /多个|多种|多方面|各个/,
  /对比|比较.*和|与.*进行比较/,
  /重构|迁移|架构|全面/,
];

/**
 * 快速启发式检测：仅使用正则匹配，不消耗 LLM token。
 * 适合作为第一道筛选。
 */
export function quickComplexityCheck(query: string): ComplexityAnalysis {
  const trimmed = query.trim();

  if (trimmed.length < 20) {
    return { isComplex: false, suggestedMode: "single", reason: "查询过短", confidence: 0.9 };
  }

  let score = 0;
  const matchedPatterns: string[] = [];

  for (const marker of COMPLEXITY_MARKERS) {
    if (marker.test(trimmed)) {
      score += 1;
      matchedPatterns.push(marker.source);
    }
  }

  const sentences = trimmed.split(/[。？！\n；;]/).filter((s) => s.trim().length > 0);
  if (sentences.length >= 4) score += 1;
  if (trimmed.length > 200) score += 1;

  if (score >= 3) {
    return {
      isComplex: true,
      suggestedMode: "multi_role",
      reason: `匹配 ${matchedPatterns.length} 个复杂度标记，${sentences.length} 个语句`,
      confidence: Math.min(0.6 + score * 0.1, 0.9),
    };
  }

  if (score >= 2) {
    return {
      isComplex: true,
      suggestedMode: "parallel_split",
      reason: `匹配 ${matchedPatterns.length} 个复杂度标记`,
      confidence: Math.min(0.5 + score * 0.1, 0.8),
    };
  }

  return {
    isComplex: false,
    suggestedMode: "single",
    reason: "未达到复杂度阈值",
    confidence: 0.7,
  };
}

/**
 * LLM 辅助的精确复杂度检测。消耗少量 token，但判断更准确。
 * 仅在 quickComplexityCheck 结果不确定时使用。
 */
export async function aiComplexityCheck(
  query: string,
  signal?: AbortSignal,
): Promise<ComplexityAnalysis> {
  const ai = getMToolsAI();

  const response = await ai.chat({
    messages: [
      {
        role: "system",
        content: `你是任务复杂度分析器。判断用户任务是否需要多 Agent 协作。
只返回 JSON: { "isComplex": bool, "suggestedMode": "single"|"parallel_split"|"multi_role", "reason": "简短原因", "confidence": 0-1 }`,
      },
      { role: "user", content: query },
    ],
    temperature: 0.1,
    signal,
  });

  try {
    const match = response.content.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as ComplexityAnalysis;
      return {
        isComplex: !!parsed.isComplex,
        suggestedMode: parsed.suggestedMode || "single",
        reason: parsed.reason || "",
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      };
    }
  } catch {
    // fallback
  }

  return quickComplexityCheck(query);
}

/**
 * 综合检测：先用启发式规则快速判断，若信心不足则调 LLM。
 */
export async function detectComplexity(
  query: string,
  options?: { signal?: AbortSignal; confidenceThreshold?: number },
): Promise<ComplexityAnalysis> {
  const quick = quickComplexityCheck(query);
  const threshold = options?.confidenceThreshold ?? 0.75;

  if (quick.confidence >= threshold) return quick;

  return aiComplexityCheck(query, options?.signal);
}
