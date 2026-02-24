import { describe, expect, it } from "vitest";
import {
  buildPlanRequestPolicy,
  shouldEnablePlanKBByKeyword,
} from "./plan-mode";

describe("plan KB policy", () => {
  it("should detect explicit KB keywords", () => {
    expect(shouldEnablePlanKBByKeyword("请基于知识库给我计划")).toBe(true);
    expect(shouldEnablePlanKBByKeyword("can you draft this from docs")).toBe(true);
    expect(shouldEnablePlanKBByKeyword("普通计划，不要查资料")).toBe(false);
  });

  it("should map disabled KB to strict request policy", () => {
    expect(buildPlanRequestPolicy(false)).toEqual({
      ragMode: "off",
      forceProductRag: "off",
    });
  });

  it("should map enabled KB to explicit RAG policy", () => {
    expect(buildPlanRequestPolicy(true)).toEqual({
      ragMode: "on",
      forceProductRag: "inherit",
    });
  });
});
