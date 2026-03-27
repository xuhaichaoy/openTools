const EXECUTION_PLAN_HEADER_PATTERN = /(执行计划|行动计划|实施计划|任务拆解|Execution Plan)/i;
const EXECUTION_PLAN_MARKERS = [
  /(?:^|\n)\s*(?:步骤\s*[0-9一二三四五六七八九十]+|Step\s*\d+)\s*[:：]/i,
  /(?:^|\n)\s*(?:工具|Tools?)\s*[:：]/i,
  /(?:^|\n)\s*(?:目的|目标|依赖|前置|Dependencies?|产出|输出)\s*[:：]/i,
  /(?:^|\n)\s*\d+\.\s*(?:第\s*\d+\s*步|Step\s*\d+|收集|分析|执行|验证|整理|检查)/i,
  /各步骤之间的依赖关系/,
];

const PLAN_REQUEST_PATTERNS = [
  /执行计划|行动计划|实施计划|任务拆解|Execution Plan/i,
  /给我.*(?:计划|方案)|输出.*(?:计划|方案)|整理.*(?:计划|方案)/iu,
];

export function isLikelyExecutionPlanReply(content: string | null | undefined): boolean {
  const normalized = String(content ?? "").trim();
  if (!normalized) return false;

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return false;

  let score = 0;
  if (EXECUTION_PLAN_HEADER_PATTERN.test(lines[0] ?? "")) {
    score += 3;
  }

  for (const pattern of EXECUTION_PLAN_MARKERS) {
    if (pattern.test(normalized)) score += 1;
  }

  const stepLineCount = lines.filter((line) =>
    /^(?:[-*]\s*)?(?:步骤\s*[0-9一二三四五六七八九十]+|Step\s*\d+|\d+\.)/.test(line)
  ).length;
  if (stepLineCount >= 2) {
    score += 2;
  }

  if (score >= 4) return true;
  return score >= 3 && normalized.length <= 1600;
}

export function taskExplicitlyRequestsPlan(task: string | null | undefined): boolean {
  const normalized = String(task ?? "").trim();
  if (!normalized) return false;
  return PLAN_REQUEST_PATTERNS.some((pattern) => pattern.test(normalized));
}
