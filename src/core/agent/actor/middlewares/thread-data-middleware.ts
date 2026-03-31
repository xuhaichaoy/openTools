/**
 * ThreadDataMiddleware — 对齐 DeerFlow 的 thread data runtime 基础设施
 *
 * 浏览器/Tauri 运行时不能静态依赖 node:fs，所以这里使用：
 * - Tauri 环境：优先 appLocalDataDir + plugin-fs mkdir
 * - Node/测试环境：fallback 到 os.tmpdir + fs/promises.mkdir
 */

import type { ActorMiddleware, ActorRunContext, ThreadDataContext } from "../actor-middleware";

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

async function resolveThreadRootBasePath(): Promise<string> {
  try {
    const pathMod = await import("@tauri-apps/api/path");
    if (typeof pathMod.appLocalDataDir === "function") {
      const base = await pathMod.appLocalDataDir();
      if (base?.trim()) return base.trim().replace(/[\\/]+$/g, "");
    }
  } catch {
    // fall through to node/test fallback
  }

  try {
    const osMod = await import("node:os");
    return osMod.tmpdir().replace(/[\\/]+$/g, "");
  } catch {
    return "/tmp";
  }
}

async function ensureThreadDataDirs(threadData: ThreadDataContext): Promise<void> {
  try {
    const fsMod = await import("@tauri-apps/plugin-fs");
    if (typeof fsMod.mkdir === "function") {
      await Promise.all([
        fsMod.mkdir(threadData.workspacePath, { recursive: true }),
        fsMod.mkdir(threadData.uploadsPath, { recursive: true }),
        fsMod.mkdir(threadData.outputsPath, { recursive: true }),
      ]);
      return;
    }
  } catch {
    // fall through to node/test fallback
  }

  try {
    const fsMod = await import("node:fs/promises");
    await Promise.all([
      fsMod.mkdir(threadData.workspacePath, { recursive: true }),
      fsMod.mkdir(threadData.uploadsPath, { recursive: true }),
      fsMod.mkdir(threadData.outputsPath, { recursive: true }),
    ]);
  } catch {
    // Best effort only: prompt-level thread data still works without eager mkdir
  }
}

async function buildThreadData(sessionId: string): Promise<ThreadDataContext> {
  const basePath = await resolveThreadRootBasePath();
  const rootPath = joinPath(basePath, "51toolbox", "threads", sessionId, "user-data");
  return {
    sessionId,
    rootPath,
    workspacePath: joinPath(rootPath, "workspace"),
    uploadsPath: joinPath(rootPath, "uploads"),
    outputsPath: joinPath(rootPath, "outputs"),
  };
}

export class ThreadDataMiddleware implements ActorMiddleware {
  readonly name = "ThreadData";
  private readonly lazyInit: boolean;

  constructor(lazyInit = false) {
    this.lazyInit = lazyInit;
  }

  async apply(ctx: ActorRunContext): Promise<void> {
    const sessionId = ctx.actorSystem?.sessionId?.trim();
    if (!sessionId) return;

    const threadData = await buildThreadData(sessionId);
    if (!this.lazyInit) {
      await ensureThreadDataDirs(threadData);
    }
    ctx.threadData = threadData;
  }
}

export async function buildThreadDataPaths(sessionId: string): Promise<ThreadDataContext> {
  return buildThreadData(sessionId);
}
