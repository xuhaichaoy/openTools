/**
 * Agent Skill 类型定义
 *
 * Skill 是可复用的"知识 + 指令 + 工具过滤"包，用于在特定场景下增强 Agent 能力。
 * 与 Plugin Action（提供工具）和 MCP（提供外部工具）互补：
 * - Skill 侧重于注入 **领域知识和行为约束**
 * - Skill 可按上下文自动激活，无需用户手动切换
 */

export type SkillSource = "builtin" | "user" | "marketplace" | "skillmd";

export interface SkillToolFilter {
  include?: string[];
  exclude?: string[];
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;

  /** 是否启用 */
  enabled: boolean;
  /** 是否根据用户输入自动激活（需配合 triggerPatterns） */
  autoActivate: boolean;
  /**
   * 触发激活的正则模式列表（任意一个匹配即激活）。
   * 仅在 autoActivate=true 时生效。
   */
  triggerPatterns?: string[];

  /**
   * 注入到 Agent system prompt 中的领域知识和行为约束。
   * 支持 Markdown 格式。
   */
  systemPrompt?: string;

  /**
   * 技能激活时的工具过滤规则。
   * include: 仅保留列表中的工具（白名单）
   * exclude: 排除列表中的工具（黑名单）
   * 多 Skill 合并策略：
   * - include 取并集
   * - exclude 取交集
   */
  toolFilter?: SkillToolFilter;

  /**
   * Allowed tools whitelist (deer-flow SKILL.md `allowed-tools` pattern).
   * When set, only these tools are available when the skill is active.
   * More declarative than toolFilter — maps to toolFilter.include internally.
   */
  allowedTools?: string[];

  /** 分类标签（如 "coding", "writing", "devops"） */
  category?: string;
  tags?: string[];
  icon?: string;

  createdAt: number;
  updatedAt: number;

  source: SkillSource;

  /** Dependencies (deer-flow SKILL.md `dependency` field) */
  dependency?: Record<string, string>;
}

/**
 * SKILL.md frontmatter schema (deer-flow compatible).
 * Parsed from YAML between `---` delimiters.
 */
export interface SkillMdFrontmatter {
  name: string;
  description: string;
  version?: string;
  author?: string;
  category?: string;
  tags?: string[];
  icon?: string;
  "allowed-tools"?: string[];
  "trigger-patterns"?: string[];
  "auto-activate"?: boolean;
  dependency?: Record<string, string>;
}

/** 创建新 Skill 时的输入（省略自动生成的字段） */
export type AgentSkillInput = Omit<AgentSkill, "id" | "createdAt" | "updatedAt">;

/** Skill 解析结果：已激活 Skill 的合并视图 */
export interface ResolvedSkillContext {
  /** 当前激活的 Skill ID 列表 */
  activeSkillIds: string[];
  /** 合并后的 system prompt 片段（多个 Skill 用分隔符拼接） */
  mergedSystemPrompt: string;
  /** 合并后的工具过滤器 */
  mergedToolFilter: SkillToolFilter;
}
