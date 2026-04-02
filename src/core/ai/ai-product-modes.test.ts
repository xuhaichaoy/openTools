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
    expect(getAICenterProductMode("agent")).toBe("dialog");
    expect(getAICenterProductMode("cluster")).toBe("dialog");
    expect(getAICenterProductMode("dialog")).toBe("dialog");
  });

  it("maps runtime modes onto stable product labels", () => {
    expect(getRuntimeProductMode("im_conversation")).toBe("im_conversation");
    expect(getDefaultRuntimeSessionLabel("ask")).toBe("Explore 对话");
    expect(getDefaultRuntimeSessionLabel("cluster")).toBe("Dialog 房间");
    expect(formatAICenterProductLabel("agent")).toBe("Dialog");
  });
});
