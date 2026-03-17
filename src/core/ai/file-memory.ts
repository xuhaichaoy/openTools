import { invoke } from "@tauri-apps/api/core";
import { homeDir, join } from "@tauri-apps/api/path";

export interface FileMemoryRecord {
  id?: string;
  content: string;
  kind: string;
  tags?: string[];
  scope?: string;
  conversation_id?: string;
  workspace_id?: string;
  updated_at?: number;
  deleted?: boolean;
}

export interface DailyMemoryEntry {
  content: string;
  kind: string;
  source?: string;
  scope?: string;
  conversationId?: string;
  workspaceId?: string;
  timestamp?: number;
}

export interface FileMemoryRecentFile {
  name: string;
  path: string;
  content: string;
}

export interface FileMemorySnapshot {
  rootDir: string;
  longTermPath: string;
  dailyDir: string;
  todayPath: string;
  longTermContent: string;
  todayContent: string;
  recentDailyFiles: FileMemoryRecentFile[];
}

export interface FileMemorySearchHit {
  path: string;
  absPath: string;
  snippet: string;
  startLine: number;
  endLine: number;
  score: number;
  source: "long_term" | "daily";
  citation: string;
}

export interface FileMemoryReadResult {
  path: string;
  absPath: string;
  text: string;
  startLine: number;
  endLine: number;
}

type DirectoryEntry = {
  name?: string;
  is_dir?: boolean;
  size?: number;
};

const ROOT_SEGMENTS = [".config", "51toolbox", "ai-memory"] as const;
const LONG_TERM_FILENAME = "MEMORY.md";
const DAILY_DIRNAME = "memory";
const DEFAULT_RECENT_DAYS = 5;
const MAX_MEMORY_READ_LINES = 200;

const KIND_TITLES: Record<string, string> = {
  constraint: "约束与规则",
  preference: "偏好",
  behavior: "行为与工作流",
  goal: "目标",
  project_context: "项目上下文",
  knowledge: "知识背景",
  fact: "事实",
};

let rootDirPromise: Promise<string> | null = null;
let fileMemoryWriteQueue: Promise<void> = Promise.resolve();

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function tokenizeSearchQuery(query: string): string[] {
  const normalized = normalizeWhitespace(query).toLowerCase();
  if (!normalized) return [];
  const parts = normalized
    .replace(/[^\w\u4e00-\u9fa5]+/g, " ")
    .split(/\s+/)
    .filter((part) => part.length >= 2);
  const cjk = normalized.replace(/[^\u4e00-\u9fa5]/g, "");
  const ngrams: string[] = [];
  for (let size = 2; size <= 3; size += 1) {
    for (let index = 0; index <= cjk.length - size; index += 1) {
      ngrams.push(cjk.slice(index, index + size));
    }
  }
  return [...new Set([...parts, ...ngrams])];
}

function formatDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour12: false,
  });
}

async function ensureDirectory(path: string): Promise<void> {
  await invoke("create_directory", { path, recursive: true }).catch(() => undefined);
}

async function readTextFile(path: string): Promise<string> {
  try {
    return await invoke<string>("read_text_file", { path });
  } catch {
    return "";
  }
}

async function writeTextFile(path: string, content: string): Promise<void> {
  await invoke("write_text_file", { path, content });
}

async function listDirectory(path: string): Promise<DirectoryEntry[]> {
  try {
    const result = await invoke<unknown>("list_directory", { path });
    if (Array.isArray(result)) {
      return result as DirectoryEntry[];
    }
    if (typeof result === "string") {
      const parsed = JSON.parse(result) as unknown;
      return Array.isArray(parsed) ? (parsed as DirectoryEntry[]) : [];
    }
  } catch {
    // ignore
  }
  return [];
}

async function resolveRootDir(): Promise<string> {
  if (!rootDirPromise) {
    rootDirPromise = (async () => {
      const home = await homeDir();
      const dir = await join(home, ...ROOT_SEGMENTS);
      await ensureDirectory(dir);
      await ensureDirectory(await join(dir, DAILY_DIRNAME));
      return dir;
    })();
  }
  return rootDirPromise;
}

export async function resolveFileMemoryRootDir(): Promise<string> {
  return resolveRootDir();
}

export async function resolveLongTermMemoryPath(): Promise<string> {
  const root = await resolveRootDir();
  return join(root, LONG_TERM_FILENAME);
}

export async function resolveDailyMemoryDir(): Promise<string> {
  const root = await resolveRootDir();
  const dailyDir = await join(root, DAILY_DIRNAME);
  await ensureDirectory(dailyDir);
  return dailyDir;
}

export async function resolveDailyMemoryPath(timestamp = Date.now()): Promise<string> {
  const dailyDir = await resolveDailyMemoryDir();
  return join(dailyDir, `${formatDateKey(timestamp)}.md`);
}

function normalizeRelativeMemoryPath(path: string): string | null {
  const normalized = String(path || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/^\/+/, "");
  if (!normalized) return null;
  if (normalized === LONG_TERM_FILENAME) return normalized;
  if (/^memory\/\d{4}-\d{2}-\d{2}\.md$/i.test(normalized)) {
    return normalized;
  }
  return null;
}

async function resolveAbsoluteMemoryPath(relPath: string): Promise<string> {
  const normalized = normalizeRelativeMemoryPath(relPath);
  if (!normalized) {
    throw new Error("只允许读取 MEMORY.md 或 memory/YYYY-MM-DD.md");
  }
  const root = await resolveRootDir();
  if (normalized === LONG_TERM_FILENAME) {
    return join(root, normalized);
  }
  const dailyDir = await resolveDailyMemoryDir();
  return join(dailyDir, normalized.replace(/^memory\//i, ""));
}

function groupLongTermRecords(records: readonly FileMemoryRecord[]): Array<{
  title: string;
  items: FileMemoryRecord[];
}> {
  const active = records.filter((record) =>
    !record.deleted
    && record.kind !== "session_note"
    && record.kind !== "conversation_summary",
  );
  const grouped = new Map<string, FileMemoryRecord[]>();

  for (const record of active) {
    const key = record.kind || "fact";
    const bucket = grouped.get(key) ?? [];
    bucket.push(record);
    grouped.set(key, bucket);
  }

  return Object.entries(KIND_TITLES)
    .map(([kind, title]) => ({
      title,
      items: (grouped.get(kind) ?? []).sort(
        (a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0),
      ),
    }))
    .filter((group) => group.items.length > 0);
}

function renderLongTermMemory(records: readonly FileMemoryRecord[]): string {
  const lines: string[] = [
    "# 51ToolBox AI Memory",
    "",
    "> 这里保存已经确认生效的长期记忆。当前用户指令优先于这里的历史记忆。",
    `> 最后同步：${new Date().toLocaleString("zh-CN")}`,
  ];

  const groups = groupLongTermRecords(records);
  if (groups.length === 0) {
    lines.push("", "## 暂无正式长期记忆", "", "- 当前还没有已确认的长期记忆。");
    return `${lines.join("\n").trimEnd()}\n`;
  }

  for (const group of groups) {
    lines.push("", `## ${group.title}`, "");
    for (const item of group.items) {
      const meta: string[] = [];
      if (item.scope && item.scope !== "global") meta.push(`scope=${item.scope}`);
      if (item.workspace_id) meta.push(`workspace=${item.workspace_id}`);
      if (item.conversation_id) meta.push(`conversation=${item.conversation_id}`);
      if (item.tags?.length) meta.push(`tags=${item.tags.join(",")}`);

      lines.push(`- ${item.content}`);
      if (meta.length > 0) {
        lines.push(`  - ${meta.join(" | ")}`);
      }
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function renderDailyMemoryEntry(entry: DailyMemoryEntry): string {
  const timestamp = entry.timestamp ?? Date.now();
  const meta = [
    entry.source || "assistant",
    entry.kind,
    entry.scope || "global",
  ];
  if (entry.workspaceId) meta.push(`workspace=${entry.workspaceId}`);
  if (entry.conversationId) meta.push(`conversation=${entry.conversationId}`);

  return [
    `## ${formatTime(timestamp)} · ${meta.join(" / ")}`,
    entry.content.trim(),
  ].join("\n");
}

function enqueueFileMemoryWrite(task: () => Promise<void>): Promise<void> {
  fileMemoryWriteQueue = fileMemoryWriteQueue
    .catch(() => undefined)
    .then(task);
  return fileMemoryWriteQueue;
}

export function queueSyncConfirmedMemoriesToFile(
  records: readonly FileMemoryRecord[],
): Promise<void> {
  return enqueueFileMemoryWrite(async () => {
    const longTermPath = await resolveLongTermMemoryPath();
    const content = renderLongTermMemory(records);
    await writeTextFile(longTermPath, content);
  });
}

export function queueAppendDailyMemoryEntry(entry: DailyMemoryEntry): Promise<void> {
  return enqueueFileMemoryWrite(async () => {
    const normalized = normalizeWhitespace(entry.content);
    if (!normalized) return;

    const dailyPath = await resolveDailyMemoryPath(entry.timestamp);
    const existing = await readTextFile(dailyPath);
    if (
      existing
      && existing
        .split(/\n{2,}/)
        .some((block) => normalizeWhitespace(block).includes(normalized))
    ) {
      return;
    }

    const next = `${existing.trimEnd()}\n\n${renderDailyMemoryEntry({
      ...entry,
      content: normalized,
    })}\n`.trimStart();
    await writeTextFile(dailyPath, next);
  });
}

export async function readRecentDailyMemoryText(days = DEFAULT_RECENT_DAYS): Promise<string> {
  const snapshot = await getFileMemorySnapshot({ recentDays: days });
  return snapshot.recentDailyFiles
    .map((file) => file.content.trim())
    .filter(Boolean)
    .join("\n\n");
}

async function listAllDailyMemoryFiles(): Promise<FileMemoryRecentFile[]> {
  const dailyDir = await resolveDailyMemoryDir();
  const dailyEntries = await listDirectory(dailyDir);
  return (
    await Promise.all(
      dailyEntries
        .filter((entry) => entry && !entry.is_dir && /\.md$/i.test(entry.name ?? ""))
        .sort((a, b) => String(b.name ?? "").localeCompare(String(a.name ?? "")))
        .map(async (entry) => {
          const name = String(entry.name ?? "").trim();
          const path = await join(dailyDir, name);
          return {
            name,
            path,
            content: await readTextFile(path),
          };
        }),
    )
  ).filter((file) => file.content.trim());
}

function buildCitation(path: string, startLine: number, endLine: number): string {
  return startLine === endLine
    ? `${path}#L${startLine}`
    : `${path}#L${startLine}-L${endLine}`;
}

function scoreSearchLine(line: string, query: string, tokens: string[]): number {
  const normalizedLine = normalizeWhitespace(line).toLowerCase();
  const normalizedQuery = normalizeWhitespace(query).toLowerCase();
  if (!normalizedLine) return 0;

  let score = 0;
  if (normalizedQuery && normalizedLine.includes(normalizedQuery)) {
    score += 2;
  }
  for (const token of tokens) {
    if (normalizedLine.includes(token)) {
      score += 0.45;
    }
  }
  if (/^[-#>]/.test(normalizedLine)) {
    score += 0.1;
  }
  return score;
}

function buildSnippet(lines: string[], start: number, end: number): string {
  return lines
    .slice(start, end + 1)
    .join("\n")
    .trim();
}

export async function searchFileMemories(
  query: string,
  options?: { topK?: number },
): Promise<FileMemorySearchHit[]> {
  const normalizedQuery = normalizeWhitespace(query);
  if (!normalizedQuery) return [];

  const topK = Math.max(1, options?.topK ?? 8);
  const [longTermPath, longTermContent, dailyFiles] = await Promise.all([
    resolveLongTermMemoryPath(),
    resolveLongTermMemoryPath().then(readTextFile),
    listAllDailyMemoryFiles(),
  ]);

  const files: Array<{
    path: string;
    relPath: string;
    content: string;
    source: "long_term" | "daily";
  }> = [
    {
      path: longTermPath,
      relPath: LONG_TERM_FILENAME,
      content: longTermContent,
      source: "long_term" as const,
    },
    ...dailyFiles.map((file) => ({
      path: file.path,
      relPath: `memory/${file.name}`,
      content: file.content,
      source: "daily" as const,
    })),
  ].filter((file) => file.content.trim());

  const queryTokens = tokenizeSearchQuery(normalizedQuery);
  const hits: FileMemorySearchHit[] = [];

  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const score = scoreSearchLine(line, normalizedQuery, queryTokens);
      if (score <= 0) continue;

      const start = Math.max(0, index - 1);
      const end = Math.min(lines.length - 1, index + 2);
      const snippet = buildSnippet(lines, start, end);
      if (!snippet) continue;

      hits.push({
        path: file.relPath,
        absPath: file.path,
        snippet,
        startLine: start + 1,
        endLine: end + 1,
        score,
        source: file.source,
        citation: buildCitation(file.relPath, start + 1, end + 1),
      });
    }
  }

  const dedup = new Map<string, FileMemorySearchHit>();
  for (const hit of hits) {
    const key = `${hit.path}:${hit.startLine}:${hit.endLine}`;
    const current = dedup.get(key);
    if (!current || hit.score > current.score) {
      dedup.set(key, hit);
    }
  }

  return [...dedup.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.path.localeCompare(a.path);
    })
    .slice(0, topK);
}

export async function readFileMemorySnippet(params: {
  path: string;
  from?: number;
  lines?: number;
}): Promise<FileMemoryReadResult> {
  const relPath = normalizeRelativeMemoryPath(params.path);
  if (!relPath) {
    throw new Error("只允许读取 MEMORY.md 或 memory/YYYY-MM-DD.md");
  }

  const absPath = await resolveAbsoluteMemoryPath(relPath);
  const content = await readTextFile(absPath);
  const allLines = content.split(/\r?\n/);
  const maxLine = allLines.length > 0 ? allLines.length : 1;
  const startLine = Math.min(maxLine, Math.max(1, Math.floor(params.from ?? 1)));
  const defaultLineCount = maxLine;
  const lineCount = Math.max(
    1,
    Math.min(MAX_MEMORY_READ_LINES, Math.floor(params.lines ?? defaultLineCount)),
  );
  const endLine = Math.min(maxLine, startLine + lineCount - 1);

  return {
    path: relPath,
    absPath,
    text: allLines.slice(startLine - 1, endLine).join("\n"),
    startLine,
    endLine,
  };
}

export async function getFileMemorySnapshot(options?: {
  recentDays?: number;
}): Promise<FileMemorySnapshot> {
  const recentDays = Math.max(1, options?.recentDays ?? DEFAULT_RECENT_DAYS);
  const rootDir = await resolveRootDir();
  const longTermPath = await resolveLongTermMemoryPath();
  const dailyDir = await resolveDailyMemoryDir();
  const todayPath = await resolveDailyMemoryPath();
  const [longTermContent, todayContent, dailyEntries] = await Promise.all([
    readTextFile(longTermPath),
    readTextFile(todayPath),
    listDirectory(dailyDir),
  ]);

  const recentDailyFiles = (
    await Promise.all(
      dailyEntries
        .filter((entry) => entry && !entry.is_dir && /\.md$/i.test(entry.name ?? ""))
        .sort((a, b) => String(b.name ?? "").localeCompare(String(a.name ?? "")))
        .slice(0, recentDays)
        .map(async (entry) => {
          const name = String(entry.name ?? "").trim();
          const path = await join(dailyDir, name);
          return {
            name,
            path,
            content: await readTextFile(path),
          };
        }),
    )
  ).filter((file) => file.content.trim());

  return {
    rootDir,
    longTermPath,
    dailyDir,
    todayPath,
    longTermContent,
    todayContent,
    recentDailyFiles,
  };
}
