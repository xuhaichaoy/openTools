import { invoke } from "@tauri-apps/api/core";
import { getFileMemorySnapshot } from "./file-memory";

export interface BootstrapContextFile {
  name: string;
  path: string;
  content: string;
  source: "workspace" | "memory";
  truncated: boolean;
}

export interface BootstrapContextSnapshot {
  workspaceRoot?: string;
  files: BootstrapContextFile[];
  prompt: string;
}

export interface BootstrapReinjectionSectionPreview {
  title: string;
  lines: string[];
}

const WORKSPACE_BOOTSTRAP_FILENAMES = [
  "AGENTS.md",
  "BOOTSTRAP.md",
  "USER.md",
  "IDENTITY.md",
  "TOOLS.md",
  "SOUL.md",
] as const;

const PROJECT_MARKER_FILENAMES = [
  "AGENTS.md",
  "package.json",
  "pnpm-workspace.yaml",
  "Cargo.toml",
  "pyproject.toml",
] as const;

const DEFAULT_MAX_CHARS_PER_FILE = 4_000;
const DEFAULT_TOTAL_MAX_CHARS = 12_000;
const MAX_CANDIDATE_ANCESTORS = 6;
const DEFAULT_REINJECTION_SECTION_COUNT = 3;
const DEFAULT_REINJECTION_LINES_PER_SECTION = 2;

function normalizePath(path: string): string {
  const normalized = String(path || "").trim().replace(/\\/g, "/");
  if (!normalized) return "";
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

function joinPath(base: string, name: string): string {
  const normalizedBase = normalizePath(base);
  if (!normalizedBase) return name;
  if (normalizedBase.endsWith("/")) return `${normalizedBase}${name}`;
  return `${normalizedBase}/${name}`;
}

function dirnameOf(path: string): string {
  const normalized = normalizePath(path);
  if (!normalized) return "";
  const slashIndex = normalized.lastIndexOf("/");
  if (slashIndex <= 0) {
    if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}/`;
    return "/";
  }
  return normalized.slice(0, slashIndex) || "/";
}

function isLikelyFilePath(path: string): boolean {
  const normalized = normalizePath(path);
  const lastSegment = normalized.split("/").pop() || "";
  return /\.[A-Za-z0-9_-]{1,12}$/.test(lastSegment);
}

function buildAncestorCandidates(path: string): string[] {
  const normalized = normalizePath(path);
  if (!normalized || !isAbsolutePath(normalized)) return [];

  const start = isLikelyFilePath(normalized) ? dirnameOf(normalized) : normalized;
  if (!start) return [];

  const candidates: string[] = [];
  let current = start;
  for (let depth = 0; depth < MAX_CANDIDATE_ANCESTORS && current; depth += 1) {
    candidates.push(current);
    const parent = dirnameOf(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return candidates;
}

function collectAbsolutePathHints(text?: string): string[] {
  const normalized = String(text || "").trim();
  if (!normalized) return [];
  const matches = normalized.match(/(?:\/[^\s"'`<>|]+|[A-Za-z]:\/[^\s"'`<>|]+)/g) || [];
  return matches
    .map((item) => normalizePath(item))
    .filter((item) => isAbsolutePath(item));
}

async function readTextFileSafe(path: string): Promise<string> {
  try {
    return await invoke<string>("read_text_file", { path });
  } catch {
    return "";
  }
}

function truncateContent(content: string, maxChars: number): {
  content: string;
  truncated: boolean;
} {
  const normalized = String(content || "").trim();
  if (!normalized) {
    return { content: "", truncated: false };
  }
  if (normalized.length <= maxChars) {
    return { content: normalized, truncated: false };
  }
  return {
    content: `${normalized.slice(0, Math.max(0, maxChars - 18)).trimEnd()}\n...[已截断]...`,
    truncated: true,
  };
}

function cleanHeadingTitle(title: string): string {
  return title
    .replace(/\s+/g, " ")
    .replace(/[：:]+$/, "")
    .trim();
}

function scoreReinjectionSectionTitle(title: string): number {
  const normalized = cleanHeadingTitle(title).toLowerCase();
  if (!normalized) return -1;
  if (/session startup|startup|启动|初始化/.test(normalized)) return 12;
  if (/red lines?|hard rules?|non[- ]?negotiable|禁止|红线/.test(normalized)) return 11;
  if (/working rules?|agent working rules?|rules?|规范|约束/.test(normalized)) return 9;
  if (/scan policy|扫描|搜索策略|search strategy/.test(normalized)) return 8;
  if (/workflow|执行流程|协作/.test(normalized)) return 7;
  if (/safety|权限|工具/.test(normalized)) return 6;
  return 2;
}

function buildSectionPreviewLines(
  bodyLines: readonly string[],
  maxLines: number,
): string[] {
  const cleaned = bodyLines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
  if (cleaned.length === 0) return [];
  return cleaned.slice(0, Math.max(1, maxLines));
}

async function scoreWorkspaceCandidate(candidate: string, pathHints: readonly string[]): Promise<number> {
  const coverageScore = pathHints.filter((path) => path === candidate || path.startsWith(`${candidate}/`)).length;
  if (coverageScore === 0) return -1;

  const checks = await Promise.all(
    PROJECT_MARKER_FILENAMES.map(async (name) => {
      const content = await readTextFileSafe(joinPath(candidate, name));
      return content.trim().length > 0;
    }),
  );

  let score = coverageScore * 3;
  for (let index = 0; index < PROJECT_MARKER_FILENAMES.length; index += 1) {
    if (!checks[index]) continue;
    score += PROJECT_MARKER_FILENAMES[index] === "AGENTS.md" ? 5 : 2;
  }
  return score;
}

export async function resolveBootstrapWorkspaceRoot(params?: {
  explicitWorkspace?: string;
  filePaths?: readonly string[];
  handoffPaths?: readonly string[];
  query?: string;
}): Promise<string | undefined> {
  const explicitWorkspace = normalizePath(params?.explicitWorkspace || "");
  if (explicitWorkspace) return explicitWorkspace;

  const pathHints = [
    ...(params?.filePaths || []),
    ...(params?.handoffPaths || []),
    ...collectAbsolutePathHints(params?.query),
  ]
    .map((path) => normalizePath(path))
    .filter((path) => isAbsolutePath(path));

  if (pathHints.length === 0) return undefined;

  const candidates = [...new Set(pathHints.flatMap((path) => buildAncestorCandidates(path)))];
  if (candidates.length === 0) return undefined;

  const scored = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      score: await scoreWorkspaceCandidate(candidate, pathHints),
    })),
  );

  const best = scored
    .filter((item) => item.score >= 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.candidate.length - a.candidate.length;
    })[0];

  return best?.candidate;
}

export async function buildBootstrapContextSnapshot(params?: {
  workspaceRoot?: string;
  filePaths?: readonly string[];
  handoffPaths?: readonly string[];
  query?: string;
  includeMemory?: boolean;
  maxCharsPerFile?: number;
  totalMaxChars?: number;
  recentDailyFiles?: number;
}): Promise<BootstrapContextSnapshot> {
  const maxCharsPerFile = Math.max(600, params?.maxCharsPerFile ?? DEFAULT_MAX_CHARS_PER_FILE);
  const totalMaxChars = Math.max(maxCharsPerFile, params?.totalMaxChars ?? DEFAULT_TOTAL_MAX_CHARS);
  const includeMemory = params?.includeMemory !== false;
  const workspaceRoot = await resolveBootstrapWorkspaceRoot({
    explicitWorkspace: params?.workspaceRoot,
    filePaths: params?.filePaths,
    handoffPaths: params?.handoffPaths,
    query: params?.query,
  });

  const files: BootstrapContextFile[] = [];
  let remainingChars = totalMaxChars;

  const pushFile = (file: BootstrapContextFile) => {
    if (!file.content.trim() || remainingChars <= 0) return;
    const truncated = truncateContent(file.content, Math.min(maxCharsPerFile, remainingChars));
    if (!truncated.content.trim()) return;
    files.push({
      ...file,
      content: truncated.content,
      truncated: file.truncated || truncated.truncated,
    });
    remainingChars -= truncated.content.length;
  };

  if (workspaceRoot) {
    for (const name of WORKSPACE_BOOTSTRAP_FILENAMES) {
      if (remainingChars <= 0) break;
      const path = joinPath(workspaceRoot, name);
      const content = await readTextFileSafe(path);
      if (!content.trim()) continue;
      pushFile({
        name,
        path,
        content,
        source: "workspace",
        truncated: false,
      });
    }
  }

  if (includeMemory && remainingChars > 0) {
    const snapshot = await getFileMemorySnapshot({
      recentDays: Math.max(1, params?.recentDailyFiles ?? 1),
    }).catch(() => null);
    if (snapshot?.longTermContent?.trim()) {
      pushFile({
        name: "MEMORY.md",
        path: snapshot.longTermPath,
        content: snapshot.longTermContent,
        source: "memory",
        truncated: false,
      });
    }
    for (const dailyFile of snapshot?.recentDailyFiles ?? []) {
      if (remainingChars <= 0) break;
      pushFile({
        name: `memory/${dailyFile.name}`,
        path: dailyFile.path,
        content: dailyFile.content,
        source: "memory",
        truncated: false,
      });
    }
  }

  return {
    workspaceRoot,
    files,
    prompt: buildBootstrapContextPrompt(files, workspaceRoot),
  };
}

export function extractBootstrapReinjectionSections(
  content: string,
  options?: {
    maxSections?: number;
    maxLinesPerSection?: number;
  },
): BootstrapReinjectionSectionPreview[] {
  const normalized = String(content || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const maxSections = Math.max(1, options?.maxSections ?? DEFAULT_REINJECTION_SECTION_COUNT);
  const maxLinesPerSection = Math.max(
    1,
    options?.maxLinesPerSection ?? DEFAULT_REINJECTION_LINES_PER_SECTION,
  );
  const lines = normalized.split("\n");
  const sections: Array<BootstrapReinjectionSectionPreview & { score: number; order: number }> = [];

  let currentTitle = "";
  let currentLines: string[] = [];
  let order = 0;

  const pushSection = () => {
    const title = cleanHeadingTitle(currentTitle);
    if (!title) return;
    const previewLines = buildSectionPreviewLines(currentLines, maxLinesPerSection);
    if (previewLines.length === 0) return;
    sections.push({
      title,
      lines: previewLines,
      score: scoreReinjectionSectionTitle(title),
      order,
    });
    order += 1;
  };

  for (const rawLine of lines) {
    const headingMatch = rawLine.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
    if (headingMatch) {
      pushSection();
      currentTitle = headingMatch[1] || "";
      currentLines = [];
      continue;
    }
    currentLines.push(rawLine);
  }
  pushSection();

  const selected = sections
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.order - b.order;
    })
    .slice(0, maxSections)
    .sort((a, b) => a.order - b.order)
    .map(({ title, lines: previewLines }) => ({
      title,
      lines: previewLines,
    }));

  if (selected.length > 0) {
    return selected;
  }

  const fallbackLines = buildSectionPreviewLines(lines, maxLinesPerSection);
  if (fallbackLines.length === 0) return [];
  return [
    {
      title: "AGENTS.md",
      lines: fallbackLines,
    },
  ];
}

export function extractBootstrapReinjectionPreview(
  content: string,
  options?: {
    maxSections?: number;
    maxLinesPerSection?: number;
  },
): string[] {
  return extractBootstrapReinjectionSections(content, options).map((section) => {
    const joined = section.lines.join(" / ");
    return `${section.title}：${joined}`;
  });
}

export async function loadBootstrapReinjectionPreview(params: {
  workspaceRoot?: string;
  maxSections?: number;
  maxLinesPerSection?: number;
}): Promise<string[]> {
  const workspaceRoot = normalizePath(params.workspaceRoot || "");
  if (!workspaceRoot) return [];

  const content = await readTextFileSafe(joinPath(workspaceRoot, "AGENTS.md"));
  if (!content.trim()) return [];
  return extractBootstrapReinjectionPreview(content, {
    maxSections: params.maxSections,
    maxLinesPerSection: params.maxLinesPerSection,
  });
}

export function buildBootstrapContextPrompt(
  files: readonly BootstrapContextFile[],
  workspaceRoot?: string,
): string {
  if (!files.length) return "";

  const lines = [
    "## Bootstrap Context Files",
    "以下文件属于系统自动挂载的持续上下文，用于继承工作区规则、用户信息和长期记忆。它们不是新的用户消息。",
    "- 最新用户要求优先于旧任务摘要与旧工作流。",
    "- 若当前请求明显切换到新项目、新目录或新主题，立即重置工作范围，不要继续沿用旧项目假设。",
    "- 回答涉及过往工作、决策、日期、人物、偏好或待办事项时，仍应优先使用 memory_search / memory_get 做精确回忆，不要只凭印象。",
    workspaceRoot ? `- 推断工作区根目录：${workspaceRoot}` : "- 当前未能稳定推断工作区根目录，因此仅挂载了可确定的上下文文件。",
    "",
    "<bootstrap-context>",
  ];

  for (const file of files) {
    lines.push(`### ${file.name}`);
    lines.push(`Path: ${file.path}`);
    lines.push(file.content);
    if (file.truncated) {
      lines.push("[该文件内容已按上下文预算截断]");
    }
    lines.push("");
  }

  lines.push("</bootstrap-context>");
  return lines.join("\n").trim();
}
