import { summarizeAISessionRuntimeText } from "@/core/ai/ai-session-runtime";
import type {
  AICenterHandoff,
  AICenterHandoffFileRef,
  AICenterHandoffIntent,
  AICenterHandoffSection,
  AICenterSourceRef,
} from "@/store/app-store";

function cleanText(value?: string | null): string | undefined {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function dedupeStrings(values?: readonly string[] | null, limit = 8): string[] | undefined {
  if (!values?.length) return undefined;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = cleanText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result.length ? result : undefined;
}

function normalizeSection(section: AICenterHandoffSection): AICenterHandoffSection | null {
  const title = cleanText(section.title);
  const items = dedupeStrings(section.items, 6);
  if (!title || !items?.length) return null;
  return { title, items };
}

function normalizeFiles(
  files?: readonly AICenterHandoffFileRef[] | null,
  limit = 8,
): AICenterHandoffFileRef[] | undefined {
  if (!files?.length) return undefined;
  const seen = new Set<string>();
  const result: AICenterHandoffFileRef[] = [];
  for (const file of files) {
    const path = String(file.path ?? "").trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    result.push({
      path,
      ...(cleanText(file.label) ? { label: cleanText(file.label) } : {}),
      ...(cleanText(file.reason) ? { reason: cleanText(file.reason) } : {}),
      ...(typeof file.lineStart === "number" ? { lineStart: Math.max(1, Math.floor(file.lineStart)) } : {}),
      ...(typeof file.lineEnd === "number" ? { lineEnd: Math.max(1, Math.floor(file.lineEnd)) } : {}),
    });
    if (result.length >= limit) break;
  }
  return result.length ? result : undefined;
}

export function buildAICenterHandoffFileRefs(
  paths?: readonly string[] | null,
  reason?: string,
): AICenterHandoffFileRef[] | undefined {
  const normalizedPaths = dedupeStrings(paths, 12);
  if (!normalizedPaths?.length) return undefined;
  return normalizedPaths.map((path) => ({
    path,
    label: path.split("/").pop() || path,
    ...(cleanText(reason) ? { reason: cleanText(reason) } : {}),
  }));
}

export function normalizeAICenterHandoff(handoff: AICenterHandoff): AICenterHandoff {
  const query = String(handoff.query ?? "").trim();
  const attachmentPaths = dedupeStrings(handoff.attachmentPaths, 24);
  const keyPoints = dedupeStrings(handoff.keyPoints, 6);
  const nextSteps = dedupeStrings(handoff.nextSteps, 6);
  const contextSections = handoff.contextSections
    ?.map(normalizeSection)
    .filter((section): section is AICenterHandoffSection => Boolean(section))
    .slice(0, 4);
  const files = normalizeFiles(handoff.files, 10);

  return {
    query,
    ...(attachmentPaths ? { attachmentPaths } : {}),
    ...(cleanText(handoff.title) ? { title: cleanText(handoff.title) } : {}),
    ...(cleanText(handoff.goal) ? { goal: cleanText(handoff.goal) } : {}),
    ...(handoff.intent ? { intent: handoff.intent } : {}),
    ...(keyPoints ? { keyPoints } : {}),
    ...(nextSteps ? { nextSteps } : {}),
    ...(contextSections?.length ? { contextSections } : {}),
    ...(files?.length ? { files } : {}),
    ...(handoff.sourceMode ? { sourceMode: handoff.sourceMode } : {}),
    ...(cleanText(handoff.sourceSessionId) ? { sourceSessionId: cleanText(handoff.sourceSessionId) } : {}),
    ...(cleanText(handoff.sourceLabel) ? { sourceLabel: cleanText(handoff.sourceLabel) } : {}),
    ...(cleanText(handoff.summary) ? { summary: cleanText(handoff.summary) } : {}),
  };
}

export function getAICenterHandoffTitle(handoff?: Partial<AICenterHandoff> | null): string {
  return cleanText(handoff?.title)
    || cleanText(handoff?.goal)
    || cleanText(handoff?.summary)
    || summarizeAISessionRuntimeText(handoff?.query, 48)
    || "任务接力";
}

export function describeAICenterHandoffIntent(intent?: AICenterHandoffIntent | null): string | null {
  switch (intent) {
    case "research":
      return "研究分析";
    case "delivery":
      return "落地执行";
    case "coding":
      return "编码任务";
    case "general":
      return "通用任务";
    default:
      return null;
  }
}

export function extractAICenterSourceRef(
  handoff?: Partial<AICenterHandoff> | null,
): Partial<AICenterSourceRef> | undefined {
  if (!handoff?.sourceMode) return undefined;
  return {
    sourceMode: handoff.sourceMode,
    ...(cleanText(handoff.sourceSessionId) ? { sourceSessionId: cleanText(handoff.sourceSessionId) } : {}),
    ...(cleanText(handoff.sourceLabel) ? { sourceLabel: cleanText(handoff.sourceLabel) } : {}),
    ...(cleanText(handoff.summary) ? { summary: cleanText(handoff.summary) } : {}),
  };
}
