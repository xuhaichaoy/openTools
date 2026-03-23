import { describe, expect, it } from "vitest";

import {
  formatAICenterProductLabel,
  getAICenterProductMode,
  getDefaultRuntimeSessionLabel,
  getRuntimeProductMode,
} from "./ai-product-modes";

describe("ai-product-modes", () => {
  it("maps legacy ai center modes onto product semantics", () => {
    expect(getAICenterProductMode("ask")).toBe("explore");
    expect(getAICenterProductMode("agent")).toBe("build");
    expect(getAICenterProductMode("cluster")).toBe("plan");
    expect(getAICenterProductMode("dialog")).toBe("dialog");
  });

  it("maps runtime modes onto stable product labels", () => {
    expect(getRuntimeProductMode("im_conversation")).toBe("im_conversation");
    expect(getDefaultRuntimeSessionLabel("ask")).toBe("Explore 对话");
    expect(getDefaultRuntimeSessionLabel("cluster")).toBe("Plan 会话");
    expect(formatAICenterProductLabel("agent")).toBe("Build");
  });
});
