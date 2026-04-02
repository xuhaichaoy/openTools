import { beforeEach, describe, expect, it, vi } from "vitest";

import { useToolTrustStore } from "@/store/command-allowlist-store";
import type { MToolsAI } from "@/core/plugin-system/plugin-interface";
import { resolveInteractiveToolApproval } from "./interactive-tool-approval";

function createMockAI(content: string): MToolsAI {
  return {
    chat: vi.fn(async () => ({ content })),
    stream: vi.fn(async () => {}),
    streamWithTools: vi.fn(),
    embedding: vi.fn(async () => []),
    getModels: vi.fn(async () => []),
  };
}

describe("interactive-tool-approval", () => {
  beforeEach(() => {
    localStorage.clear();
    useToolTrustStore.getState().setTrustLevel("auto_approve_file");
    useToolTrustStore.getState().clearDecisionCache();
  });

  it("auto-allows after high-confidence model review for uncertain shell reads", async () => {
    const ai = createMockAI('{"decision":"allow","confidence":"high","reason":"命令意图是只读统计文件行数，没有写入副作用。"}');
    const openConfirmDialog = vi.fn(async () => true);

    const approved = await resolveInteractiveToolApproval({
      ai,
      toolName: "run_shell_command",
      params: {
        command: "fd '.ts$' src",
      },
      source: "actor_dialog",
      openConfirmDialog,
    });

    expect(approved).toBe(true);
    expect(ai.chat).toHaveBeenCalledTimes(1);
    expect(openConfirmDialog).not.toHaveBeenCalled();
  });

  it("falls back to human approval when model review stays uncertain", async () => {
    const ai = createMockAI('{"decision":"ask_human","confidence":"medium","reason":"无法高置信度确认该命令不会触发副作用。"}');
    const openConfirmDialog = vi.fn(async () => true);

    const approved = await resolveInteractiveToolApproval({
      ai,
      toolName: "run_shell_command",
      params: {
        command: "fd '.ts$' src",
      },
      source: "actor_dialog",
      openConfirmDialog,
    });

    expect(approved).toBe(true);
    expect(ai.chat).toHaveBeenCalledTimes(1);
    expect(openConfirmDialog).toHaveBeenCalledTimes(1);
    expect(openConfirmDialog.mock.calls[0]?.[0]).toMatchObject({
      reviewedByModel: true,
      source: "actor_dialog",
    });
    expect(String(openConfirmDialog.mock.calls[0]?.[0]?.reason ?? "")).toBe("无法高置信度确认该命令不会触发副作用。");
  });

  it("skips model review in strict manual mode", async () => {
    useToolTrustStore.getState().setTrustLevel("always_ask");
    const ai = createMockAI('{"decision":"allow","confidence":"high","reason":"不会生效"}');
    const openConfirmDialog = vi.fn(async () => true);

    const approved = await resolveInteractiveToolApproval({
      ai,
      toolName: "run_shell_command",
      params: {
        command: "npm test -- --runInBand",
      },
      source: "agent",
      openConfirmDialog,
    });

    expect(approved).toBe(true);
    expect(ai.chat).not.toHaveBeenCalled();
    expect(openConfirmDialog).toHaveBeenCalledTimes(1);
  });

  it("keeps policy denies from being auto-approved", async () => {
    const ai = createMockAI('{"decision":"allow","confidence":"high","reason":"不应被使用"}');
    const openConfirmDialog = vi.fn(async () => true);

    const approved = await resolveInteractiveToolApproval({
      ai,
      toolName: "write_file",
      params: {
        path: "/tmp/demo.txt",
        content: "demo",
      },
      source: "actor_dialog",
      openConfirmDialog,
      executionPolicy: {
        accessMode: "read_only",
        approvalMode: "off",
      },
      workspace: "/tmp",
    });

    expect(approved).toBe(false);
    expect(ai.chat).not.toHaveBeenCalled();
    expect(openConfirmDialog).not.toHaveBeenCalled();
  });

  it("denies suspicious malformed shell commands before opening approval", async () => {
    const ai = createMockAI('{"decision":"allow","confidence":"high","reason":"不会生效"}');
    const openConfirmDialog = vi.fn(async () => true);

    const approved = await resolveInteractiveToolApproval({
      ai,
      toolName: "run_shell_command",
      params: {
        command: "find/Users/haichao/Desktop/work/51ToolBox -name '*.ts'",
      },
      source: "actor_dialog",
      openConfirmDialog,
    });

    expect(approved).toBe(false);
    expect(ai.chat).not.toHaveBeenCalled();
    expect(openConfirmDialog).not.toHaveBeenCalled();
  });
});
