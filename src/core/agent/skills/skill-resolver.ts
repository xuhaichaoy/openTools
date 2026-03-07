/**
 * Skill 解析器
 *
 * 根据用户输入自动匹配并激活相关 Skill，
 * 将多个 Skill 的 systemPrompt 和 toolFilter 合并为统一视图。
 */

import type { AgentSkill, ResolvedSkillContext, SkillToolFilter } from "./types";

const MAX_ACTIVE_SKILLS = 3;

interface NamedTool {
  name: string;
}

// ── 正则缓存 ──

const regexCache = new Map<string, RegExp | null>();
const REGEX_CACHE_MAX_SIZE = 200;

/**
 * 获取缓存的 RegExp，无效模式返回 null
 */
function getCachedRegex(pattern: string): RegExp | null {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;

  if (regexCache.size >= REGEX_CACHE_MAX_SIZE) {
    const first = regexCache.keys().next().value;
    if (first !== undefined) regexCache.delete(first);
  }

  try {
    const re = new RegExp(pattern, "i");
    regexCache.set(pattern, re);
    return re;
  } catch {
    regexCache.set(pattern, null);
    return null;
  }
}

/** 清除正则缓存（测试或 Skill 变更后调用） */
export function clearRegexCache(): void {
  regexCache.clear();
}

function testPattern(pattern: string, text: string): boolean {
  const re = getCachedRegex(pattern);
  if (re) return re.test(text);
  return text.includes(pattern.toLowerCase());
}

/**
 * 检测单个 Skill 是否应被当前查询激活
 */
function shouldActivate(skill: AgentSkill, query: string): boolean {
  if (!skill.enabled) return false;
  if (!skill.autoActivate) return false;
  if (!skill.triggerPatterns?.length) return false;

  const lowerQuery = query.toLowerCase();
  return skill.triggerPatterns.some((p) => testPattern(p, lowerQuery));
}

/**
 * 计算 Skill 与查询的匹配得分（匹配的 pattern 数量）
 */
function matchScore(skill: AgentSkill, query: string): number {
  if (!skill.triggerPatterns?.length) return 0;
  const lowerQuery = query.toLowerCase();
  let score = 0;
  for (const pattern of skill.triggerPatterns) {
    if (testPattern(pattern, lowerQuery)) score++;
  }
  return score;
}

/**
 * 合并多个工具过滤器
 *
 * 策略：
 * - include: 取并集（允许任何 Skill 要求的工具）
 * - exclude: 取交集（只有所有 Skill 都排除的工具才排除）
 */
function mergeToolFilters(filters: SkillToolFilter[]): SkillToolFilter {
  const nonEmpty = filters.filter(
    (f) => f.include?.length || f.exclude?.length,
  );
  if (nonEmpty.length === 0) return {};

  const hasIncludes = nonEmpty.filter((f) => f.include?.length);
  const hasExcludes = nonEmpty.filter((f) => f.exclude?.length);

  const result: SkillToolFilter = {};

  if (hasIncludes.length > 0) {
    const union = new Set<string>();
    for (const f of hasIncludes) {
      for (const t of f.include!) union.add(t);
    }
    result.include = [...union];
  }

  if (hasExcludes.length > 0) {
    const excludeSets = hasExcludes.map((f) => new Set(f.exclude!));
    const first = excludeSets[0];
    const intersection = [...first].filter((t) =>
      excludeSets.every((s) => s.has(t)),
    );
    if (intersection.length > 0) {
      result.exclude = intersection;
    }
  }

  return result;
}

/**
 * 根据 Skill 工具过滤规则筛选工具列表
 *
 * 规则：
 * - include 存在时，仅保留 include 中的工具
 * - exclude 存在时，从当前结果中排除 exclude 中的工具
 */
export function applySkillToolFilter<T extends NamedTool>(
  tools: T[],
  filter?: SkillToolFilter,
): T[] {
  if (!filter) return tools;

  let filtered = tools;
  if (filter.include?.length) {
    const includeSet = new Set(filter.include);
    filtered = filtered.filter((tool) => includeSet.has(tool.name));
  }
  if (filter.exclude?.length) {
    const excludeSet = new Set(filter.exclude);
    filtered = filtered.filter((tool) => !excludeSet.has(tool.name));
  }

  return filtered;
}

/**
 * 角色 → 应排除的 Skill category 映射。
 * Cluster 内不同角色只注入相关 Skills。
 */
const ROLE_CATEGORY_EXCLUDE: Record<string, string[]> = {
  researcher: ["coding"],
  coder: ["writing"],
  reviewer: ["writing"],
};

/**
 * 根据用户查询解析应激活的 Skill
 *
 * @param enabledSkills 当前已启用的所有 Skill
 * @param query 用户输入的查询文本
 * @param manualSkillIds 手动指定激活的 Skill ID（总是包含，不受 autoActivate 限制）
 * @param roleHint Cluster 角色标识（如 "researcher"），用于排除不相关的 Skill category
 */
export function resolveSkills(
  enabledSkills: AgentSkill[],
  query: string,
  manualSkillIds?: string[],
  roleHint?: string,
): ResolvedSkillContext {
  const manualSet = new Set(manualSkillIds ?? []);

  const excludeCategories = roleHint
    ? new Set(ROLE_CATEGORY_EXCLUDE[roleHint] ?? [])
    : undefined;

  const isExcludedByRole = (s: AgentSkill) =>
    excludeCategories?.size && s.category && excludeCategories.has(s.category);

  const manualSkills = enabledSkills.filter(
    (s) => manualSet.has(s.id) && !isExcludedByRole(s),
  );

  const autoSkills = enabledSkills
    .filter((s) => !manualSet.has(s.id) && !isExcludedByRole(s) && shouldActivate(s, query))
    .map((s) => ({ skill: s, score: matchScore(s, query) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, MAX_ACTIVE_SKILLS - manualSkills.length))
    .map((e) => e.skill);

  const activeSkills = [...manualSkills, ...autoSkills];

  if (activeSkills.length === 0) {
    return {
      activeSkillIds: [],
      mergedSystemPrompt: "",
      mergedToolFilter: {},
    };
  }

  const prompts = activeSkills
    .map((s) => s.systemPrompt?.trim())
    .filter(Boolean) as string[];

  const mergedSystemPrompt =
    prompts.length > 0
      ? `# 已激活的领域技能\n\n${prompts.join("\n\n---\n\n")}`
      : "";

  const filters = activeSkills
    .map((s) => s.toolFilter)
    .filter(Boolean) as SkillToolFilter[];

  return {
    activeSkillIds: activeSkills.map((s) => s.id),
    mergedSystemPrompt,
    mergedToolFilter: mergeToolFilters(filters),
  };
}
