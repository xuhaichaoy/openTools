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

interface SkillDependencyBundle {
  skillIds: string[];
  toolNames: string[];
  mcpNames: string[];
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

function normalizeStringList(values?: string[]): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function splitLegacyDependencyValues(value?: string): string[] {
  if (!value) return [];
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getSkillDependencies(skill: AgentSkill): SkillDependencyBundle {
  const bundle: SkillDependencyBundle = {
    skillIds: normalizeStringList(skill.skillDependencies),
    toolNames: normalizeStringList(skill.toolDependencies),
    mcpNames: normalizeStringList(skill.mcpDependencies),
  };

  for (const [key, rawValue] of Object.entries(skill.dependency ?? {})) {
    const normalizedKey = key.trim().toLowerCase();
    const normalizedValue = rawValue.trim();
    if (!normalizedValue) continue;

    if (normalizedKey === "skill" || normalizedKey === "skills") {
      bundle.skillIds.push(...splitLegacyDependencyValues(normalizedValue));
      continue;
    }
    if (normalizedKey === "tool" || normalizedKey === "tools") {
      bundle.toolNames.push(...splitLegacyDependencyValues(normalizedValue));
      continue;
    }
    if (normalizedKey === "mcp" || normalizedKey === "mcps") {
      bundle.mcpNames.push(...splitLegacyDependencyValues(normalizedValue));
      continue;
    }

    const prefixedValue = normalizedValue.match(/^(skill|skills|tool|tools|mcp|mcps)[:/](.+)$/i);
    if (!prefixedValue) continue;
    const kind = prefixedValue[1].toLowerCase();
    const values = splitLegacyDependencyValues(prefixedValue[2]);
    if (kind === "skill" || kind === "skills") {
      bundle.skillIds.push(...values);
    } else if (kind === "tool" || kind === "tools") {
      bundle.toolNames.push(...values);
    } else if (kind === "mcp" || kind === "mcps") {
      bundle.mcpNames.push(...values);
    }
  }

  bundle.skillIds = normalizeStringList(bundle.skillIds);
  bundle.toolNames = normalizeStringList(bundle.toolNames);
  bundle.mcpNames = normalizeStringList(bundle.mcpNames);
  return bundle;
}

function expandSkillClosure(activeRootIds: string[], enabledSkills: AgentSkill[]): AgentSkill[] {
  if (activeRootIds.length === 0) return [];

  const skillMap = new Map(enabledSkills.map((skill) => [skill.id, skill]));
  const visible: AgentSkill[] = [];
  const seen = new Set<string>();
  const visiting = new Set<string>();

  const visit = (skillId: string) => {
    if (seen.has(skillId) || visiting.has(skillId)) return;
    const skill = skillMap.get(skillId);
    if (!skill) return;

    visiting.add(skillId);
    seen.add(skillId);
    visible.push(skill);
    for (const depId of getSkillDependencies(skill).skillIds) {
      visit(depId);
    }
    visiting.delete(skillId);
  };

  for (const rootId of activeRootIds) {
    visit(rootId);
  }

  return visible;
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
  const visibleSkills = expandSkillClosure(
    activeSkills.map((skill) => skill.id),
    enabledSkills.filter((skill) => skill.enabled),
  );

  if (activeSkills.length === 0) {
    return {
      activeSkillIds: [],
      visibleSkillIds: [],
      mergedSystemPrompt: "",
      mergedToolFilter: {},
      dependencyToolNames: [],
      dependencyMcpNames: [],
    };
  }

  const prompts = visibleSkills
    .map((s) => s.systemPrompt?.trim())
    .filter(Boolean) as string[];

  const visibleSkillNames = visibleSkills.map((skill) => skill.name);
  const activeSkillNames = activeSkills.map((skill) => skill.name);
  const mergedSystemPrompt =
    prompts.length > 0
      ? [
        "# 已激活的领域技能",
        "",
        `已激活: ${activeSkillNames.join("、")}`,
        visibleSkillNames.length > activeSkillNames.length
          ? `可见依赖: ${visibleSkillNames.filter((name) => !activeSkillNames.includes(name)).join("、")}`
          : "",
        "",
        prompts.join("\n\n---\n\n"),
      ].filter(Boolean).join("\n")
      : "";

  const filters = visibleSkills
    .map((s) => {
      if (s.allowedTools?.length) {
        return { include: s.allowedTools } as SkillToolFilter;
      }
      return s.toolFilter;
    })
    .filter(Boolean) as SkillToolFilter[];

  const dependencyToolNames = normalizeStringList(
    visibleSkills.flatMap((skill) => getSkillDependencies(skill).toolNames),
  );
  const dependencyMcpNames = normalizeStringList(
    visibleSkills.flatMap((skill) => getSkillDependencies(skill).mcpNames),
  );

  return {
    activeSkillIds: activeSkills.map((s) => s.id),
    visibleSkillIds: visibleSkills.map((s) => s.id),
    mergedSystemPrompt,
    mergedToolFilter: mergeToolFilters(filters),
    dependencyToolNames,
    dependencyMcpNames,
  };
}
