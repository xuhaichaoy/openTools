import { describe, expect, it } from "vitest";
import {
  buildRuntimeIndicatorDetail,
  getRuntimeIndicatorMeta,
  getRuntimeIndicatorStatus,
  shouldPulseRuntimeIndicator,
} from "./runtime-indicator";
import type { RuntimeSessionRecord } from "./runtime-state";

function createRecord(
  patch: Partial<RuntimeSessionRecord>,
): RuntimeSessionRecord {
  return {
    key: `${patch.mode ?? "agent"}:${patch.sessionId ?? "session-1"}`,
    mode: patch.mode ?? "agent",
    sessionId: patch.sessionId ?? "session-1",
    query: patch.query ?? "修复当前页面的滚动与布局问题",
    startedAt: patch.startedAt ?? 1,
    updatedAt: patch.updatedAt ?? 2,
    status: patch.status ?? "running",
    ...(typeof patch.displayLabel === "string" ? { displayLabel: patch.displayLabel } : {}),
    ...(typeof patch.displayDetail === "string" ? { displayDetail: patch.displayDetail } : {}),
    ...(patch.workspaceRoot ? { workspaceRoot: patch.workspaceRoot } : {}),
    ...(patch.waitingStage ? { waitingStage: patch.waitingStage } : {}),
    ...(typeof patch.roomCompactionSummaryPreview === "string"
      ? { roomCompactionSummaryPreview: patch.roomCompactionSummaryPreview }
      : {}),
    ...(typeof patch.roomCompactionUpdatedAt === "number"
      ? { roomCompactionUpdatedAt: patch.roomCompactionUpdatedAt }
      : {}),
    ...(typeof patch.roomCompactionMessageCount === "number"
      ? { roomCompactionMessageCount: patch.roomCompactionMessageCount }
      : {}),
    ...(typeof patch.roomCompactionTaskCount === "number"
      ? { roomCompactionTaskCount: patch.roomCompactionTaskCount }
      : {}),
    ...(typeof patch.roomCompactionArtifactCount === "number"
      ? { roomCompactionArtifactCount: patch.roomCompactionArtifactCount }
      : {}),
    ...(patch.roomCompactionPreservedIdentifiers
      ? { roomCompactionPreservedIdentifiers: patch.roomCompactionPreservedIdentifiers }
      : {}),
  };
}

describe("runtime-indicator", () => {
  it("builds waiting labels for interactive stages", () => {
    expect(
      getRuntimeIndicatorStatus(
        createRecord({ mode: "agent", waitingStage: "user_confirm" }),
      ),
    ).toBe("等待确认");
    expect(
      getRuntimeIndicatorStatus(
        createRecord({ mode: "dialog", waitingStage: "user_confirm" }),
      ),
    ).toBe("等待审批");
    expect(
      getRuntimeIndicatorStatus(
        createRecord({ mode: "ask", waitingStage: "model_generating" }),
      ),
    ).toBe("生成中");
  });

  it("builds compact cluster detail with count", () => {
    const detail = buildRuntimeIndicatorDetail(
      createRecord({ mode: "cluster", status: "running" }),
      3,
    );
    expect(detail).toBe("执行中 · 3 个任务");
  });

  it("includes compaction continuity in dialog/im detail", () => {
    const detail = buildRuntimeIndicatorDetail(
      createRecord({
        mode: "im_conversation",
        waitingStage: "running",
        displayDetail: "钉钉 · 群聊",
        roomCompactionMessageCount: 18,
      }),
    );
    expect(detail).toBe("处理中 · 钉钉 · 群聊 · 已整理 18 条上下文");
  });

  it("marks waiting sessions as pulse indicators", () => {
    expect(
      shouldPulseRuntimeIndicator(
        createRecord({ mode: "dialog", waitingStage: "user_reply" }),
      ),
    ).toBe(true);
    expect(
      shouldPulseRuntimeIndicator(
        createRecord({ mode: "agent", waitingStage: "model_generating" }),
      ),
    ).toBe(false);
  });

  it("returns mode presentation metadata", () => {
    expect(getRuntimeIndicatorMeta("ask").label).toBe("Explore 对话");
    expect(getRuntimeIndicatorMeta("cluster").color).toBe("var(--color-accent)");
  });
});
