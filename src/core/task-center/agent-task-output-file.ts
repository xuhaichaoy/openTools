import { buildThreadDataPaths } from "@/core/agent/actor/middlewares/thread-data-middleware";

function joinPath(...parts: string[]): string {
  const normalized = parts
    .map((part, index) => {
      const value = String(part ?? "");
      if (index === 0) return value.replace(/[\\/]+$/g, "");
      return value.replace(/^[\\/]+|[\\/]+$/g, "");
    })
    .filter(Boolean);
  return normalized.join("/");
}

function sanitizeFileName(value: string): string {
  const normalized = String(value ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "agent-task";
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    const fsMod = await import("@tauri-apps/plugin-fs");
    if (typeof fsMod.mkdir === "function") {
      await fsMod.mkdir(path, { recursive: true });
      return;
    }
  } catch {
    // fall through to node/test fallback
  }

  try {
    const fsMod = await import("node:fs/promises");
    await fsMod.mkdir(path, { recursive: true });
  } catch {
    // best effort
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    const fsMod = await import("@tauri-apps/plugin-fs");
    if (typeof fsMod.readTextFile === "function") {
      return await fsMod.readTextFile(path);
    }
  } catch {
    // fall through to node/test fallback
  }

  try {
    const fsMod = await import("node:fs/promises");
    return await fsMod.readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}

async function writeText(path: string, content: string): Promise<void> {
  try {
    const fsMod = await import("@tauri-apps/plugin-fs");
    if (typeof fsMod.writeTextFile === "function") {
      await fsMod.writeTextFile(path, content);
      return;
    }
  } catch {
    // fall through to node/test fallback
  }

  try {
    const fsMod = await import("node:fs/promises");
    await fsMod.writeFile(path, content, "utf-8");
  } catch {
    // best effort
  }
}

function buildHeader(params: {
  taskId: string;
  agentName: string;
  title?: string;
  description?: string;
  prompt?: string;
}): string {
  const lines = [
    "# Agent Task Output",
    "",
    `- Task ID: ${params.taskId}`,
    `- Agent: ${params.agentName}`,
    params.title ? `- Title: ${params.title}` : "",
    params.description ? `- Description: ${params.description}` : "",
    params.prompt ? `- Initial Prompt: ${params.prompt}` : "",
    "",
    "任务已启动，等待结果…",
  ].filter(Boolean);
  return `${lines.join("\n")}\n`;
}

function buildSection(params: {
  prompt?: string;
  status: "completed" | "failed" | "aborted";
  result?: string;
  error?: string;
  timestamp?: number;
}): string {
  const label = params.status === "completed"
    ? "Completed"
    : params.status === "aborted"
      ? "Aborted"
      : "Failed";
  const at = new Date(params.timestamp ?? Date.now()).toISOString();
  const body = params.status === "completed"
    ? String(params.result ?? "").trim()
    : String(params.error ?? "").trim();

  const lines = [
    `## ${label} @ ${at}`,
    params.prompt ? `### Prompt\n${params.prompt}` : "",
    body ? `### ${params.status === "completed" ? "Result" : "Error"}\n${body}` : "",
  ].filter(Boolean);

  return `${lines.join("\n\n")}\n`;
}

export async function ensureAgentTaskOutputFile(params: {
  sessionId: string;
  taskId: string;
  agentName: string;
  title?: string;
  description?: string;
  prompt?: string;
}): Promise<string> {
  const threadData = await buildThreadDataPaths(params.sessionId);
  await ensureDirectory(threadData.outputsPath);
  const outputFile = joinPath(
    threadData.outputsPath,
    `${sanitizeFileName(params.taskId)}.output.md`,
  );

  const existing = await readText(outputFile);
  if (typeof existing === "string" && existing.trim()) {
    return outputFile;
  }

  await writeText(outputFile, buildHeader(params));
  return outputFile;
}

export async function appendAgentTaskOutputFile(params: {
  outputFile: string;
  prompt?: string;
  status: "completed" | "failed" | "aborted";
  result?: string;
  error?: string;
  timestamp?: number;
}): Promise<void> {
  const existing = await readText(params.outputFile);
  const next = `${String(existing ?? "").trimEnd()}\n\n${buildSection(params)}`.trimStart();
  await writeText(params.outputFile, `${next}\n`);
}

export async function readAgentTaskOutputFile(path: string): Promise<string | undefined> {
  return readText(path);
}
