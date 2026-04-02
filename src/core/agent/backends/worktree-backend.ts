import { createLogger } from "@/core/logger";
import type {
  AgentBackendMessageRequest,
  AgentBackendMessageResult,
  AgentBackendStatus,
  AgentBackendTaskRequest,
  AgentExecutorBackend,
} from "./types";

const log = createLogger("WorktreeBackend");
let nextWorktreeTaskId = 0;

interface WorktreeInfo {
  path: string;
  branch: string;
  taskId: string;
}

function sanitizeSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function createWorktreeTaskId(request: AgentBackendTaskRequest): string {
  const targetSegment = sanitizeSegment(
    request.target.name ?? request.target.actorName ?? request.label ?? "worker",
    "worker",
  );
  const taskSegment = sanitizeSegment(request.label ?? request.task.slice(0, 32), "task");
  nextWorktreeTaskId += 1;
  return `worktree-${targetSegment}-${taskSegment}-${Date.now().toString(36)}-${nextWorktreeTaskId}`;
}

export class WorktreeAgentBackend implements AgentExecutorBackend {
  readonly id = "worktree";
  readonly kind = "worktree" as const;
  readonly label = "Worktree Backend";

  private worktrees = new Map<string, WorktreeInfo>();

  getStatus(): AgentBackendStatus {
    // Only available in Node.js environment
    if (typeof window !== "undefined") {
      return { available: false, reason: "Not available in browser" };
    }

    try {
      const { execSync } = require("child_process");
      execSync("git --version", { stdio: "ignore" });
      return { available: true };
    } catch {
      return { available: false, reason: "Git not available" };
    }
  }

  async dispatchTask(request: AgentBackendTaskRequest) {
    if (typeof window !== "undefined") {
      return { error: "Worktree backend not available in browser" };
    }

    try {
      const { execSync } = require("child_process");
      const { existsSync, mkdirSync } = require("fs");
      const { join } = require("path");

      const repoRoot = process.cwd();
      const taskId = createWorktreeTaskId(request);
      const slug = sanitizeSegment(taskId, `task-${Date.now().toString(36)}`);
      const worktreePath = join(repoRoot, ".claude", "worktrees", slug);
      const branchName = `worktree-${slug}`;

      mkdirSync(join(repoRoot, ".claude", "worktrees"), { recursive: true });

      if (!existsSync(worktreePath)) {
        execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, {
          cwd: repoRoot,
          stdio: "pipe",
        });
        log.info(`Created worktree: ${worktreePath}`);
      }

      this.worktrees.set(taskId, {
        path: worktreePath,
        branch: branchName,
        taskId,
      });

      return {
        taskId,
        status: "running" as const,
        summary: `已创建 worktree：${worktreePath}`,
        outputPath: worktreePath,
        metadata: {
          backendId: this.id,
          worktreePath,
          branchName,
          requestedLabel: request.label,
          requestedTarget: request.target.name ?? request.target.actorName ?? request.target.actorId,
        },
      };
    } catch (error) {
      log.error("Failed to create worktree", error);
      return { error: String(error) };
    }
  }

  async sendMessage(_request: AgentBackendMessageRequest): Promise<AgentBackendMessageResult> {
    return {
      sent: false,
      backendId: this.id,
      error: "Message sending not supported in worktree backend",
    };
  }

  async cleanupWorktree(taskId: string): Promise<void> {
    if (typeof window !== "undefined") return;

    const info = this.worktrees.get(taskId);
    if (!info) return;

    try {
      const { execSync } = require("child_process");
      const repoRoot = process.cwd();

      execSync(`git worktree remove "${info.path}" --force`, {
        cwd: repoRoot,
        stdio: "pipe",
      });
      execSync(`git branch -D "${info.branch}"`, {
        cwd: repoRoot,
        stdio: "pipe",
      });
      this.worktrees.delete(taskId);
      log.info(`Cleaned up worktree: ${info.path}`);
    } catch (error) {
      log.error("Failed to cleanup worktree", error);
    }
  }
}
