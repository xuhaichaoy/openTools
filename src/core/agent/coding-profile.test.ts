import { describe, expect, it } from "vitest";

import {
  buildAgentCodingSystemHint,
  describeCodingExecutionProfile,
  inferCodingExecutionProfile,
  isLikelyCodingPath,
  resolveCodingExecutionProfile,
} from "./coding-profile";

describe("coding-profile", () => {
  it("detects coding paths", () => {
    expect(isLikelyCodingPath("/tmp/project/src/App.tsx")).toBe(true);
    expect(isLikelyCodingPath("/tmp/project/package.json")).toBe(true);
    expect(isLikelyCodingPath("/tmp/project/docs/spec.md")).toBe(false);
  });

  it("infers coding and large-project profile from task context", () => {
    const resolved = inferCodingExecutionProfile({
      query: "请在整个仓库里修复构建报错并补上测试",
      attachmentPaths: [
        "/tmp/project/src/App.tsx",
        "/tmp/project/src/main.ts",
        "/tmp/project/package.json",
        "/tmp/project/tsconfig.json",
      ],
    });

    expect(resolved.profile).toEqual({
      codingMode: true,
      largeProjectMode: true,
      openClawMode: false,
    });
    expect(resolved.autoDetected).toBe(true);
    expect(describeCodingExecutionProfile(resolved.profile)).toBe("Coding · 大项目");
  });

  it("prefers manual profile over auto detection", () => {
    const resolved = resolveCodingExecutionProfile({
      manualProfile: {
        codingMode: true,
        largeProjectMode: false,
        openClawMode: false,
      },
      query: "看一下整个仓库",
      attachmentPaths: ["/tmp/project/src/App.tsx", "/tmp/project/src/main.ts"],
    });

    expect(resolved.profile).toEqual({
      codingMode: true,
      largeProjectMode: false,
      openClawMode: false,
    });
    expect(resolved.autoDetected).toBe(false);
  });

  it("does not auto-enable coding for spreadsheet content delivery tasks", () => {
    const resolved = inferCodingExecutionProfile({
      query: "请根据附件 xlsx 生成 20 门课程候选，并最终导出 Excel 文件",
      attachmentPaths: ["/tmp/uploads/课程清单.xlsx"],
    });

    expect(resolved.profile).toEqual({
      codingMode: false,
      largeProjectMode: false,
      openClawMode: false,
    });
    expect(resolved.autoDetected).toBe(false);
    expect(resolved.reasons).toContain("识别为表格/内容交付任务，默认不自动启用 Coding");
  });

  it("reminds coding mode to directly create clear standalone artifacts when appropriate", () => {
    const hint = buildAgentCodingSystemHint({
      codingMode: true,
      largeProjectMode: false,
      openClawMode: false,
    });

    expect(hint).toContain("从零生成独立页面");
    expect(hint).toContain("不要为了“先读后改”陷入无意义的仓库分析");
  });
});
