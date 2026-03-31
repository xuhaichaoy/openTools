import { describe, expect, it } from "vitest";

import {
  buildWorkerProfileToolPolicy,
  resolveWorkerProfile,
} from "./worker-profiles";

describe("worker-profiles", () => {
  it("promotes structured content tasks into content workers when the lead opts into worker routing", () => {
    const profile = resolveWorkerProfile({
      roleBoundary: "general",
      task: "请根据附件整理课程清单，并输出结构化字段结果。",
      allowGeneralPromotion: true,
    });

    expect(profile.id).toBe("content_worker");
    expect(profile.roleBoundary).toBe("executor");
    expect(profile.executionIntent).toBe("content_executor");
  });

  it("keeps spreadsheet inline-result workers on the spreadsheet profile", () => {
    const profile = resolveWorkerProfile({
      roleBoundary: "executor",
      task: "整理这批课程并直接返回结构化结果。",
      resultContract: "inline_structured_result",
    });

    expect(profile.id).toBe("spreadsheet_worker");
    expect(profile.executionIntent).toBe("content_executor");
  });

  it("routes clear coding tasks to the coding worker profile", () => {
    const profile = resolveWorkerProfile({
      roleBoundary: "executor",
      task: "修复 /Users/demo/project/src/App.tsx 的渲染 bug。",
    });

    expect(profile.id).toBe("coding_worker");
    expect(profile.executionIntent).toBe("coding_executor");
  });

  it("honors an explicit worker profile ahead of heuristics", () => {
    const profile = resolveWorkerProfile({
      roleBoundary: "executor",
      task: "修复 /Users/demo/project/src/App.tsx 的渲染 bug。",
      explicitWorkerProfileId: "review_worker",
    });

    expect(profile.id).toBe("review_worker");
    expect(profile.executionIntent).toBe("reviewer");
  });

  it("builds spreadsheet worker tool policy from the profile definition", () => {
    const toolPolicy = buildWorkerProfileToolPolicy({
      profileId: "spreadsheet_worker",
      resultContract: "inline_structured_result",
    });

    expect(toolPolicy).toEqual({
      allow: ["task_done", "read_document", "read_file_range"],
      deny: expect.arrayContaining([
        "delegate_task",
        "calculate",
        "write_file",
        "export_spreadsheet",
      ]),
    });
  });
});
