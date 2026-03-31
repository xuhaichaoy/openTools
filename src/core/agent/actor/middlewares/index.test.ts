import { describe, expect, it } from "vitest";

import {
  createDefaultMiddlewares,
  createLeadRuntimeMiddlewares,
  createSharedRuntimeMiddlewares,
  createSubagentRuntimeMiddlewares,
} from "./index";

describe("middleware runtime layering", () => {
  it("builds a shared runtime chain that excludes lead-only guardrails", () => {
    const names = createSharedRuntimeMiddlewares().map((middleware) => middleware.name);

    expect(names).toContain("ThreadData");
    expect(names).toContain("ToolErrorHandling");
    expect(names).not.toContain("DanglingToolCall");
    expect(names).not.toContain("LoopDetection");
  });

  it("keeps dangling-tool-call and loop detection on lead runtime only", () => {
    const leadNames = createLeadRuntimeMiddlewares().map((middleware) => middleware.name);
    const subagentNames = createSubagentRuntimeMiddlewares().map((middleware) => middleware.name);

    expect(leadNames).toContain("DanglingToolCall");
    expect(leadNames).toContain("LoopDetection");
    expect(subagentNames).not.toContain("DanglingToolCall");
    expect(subagentNames).not.toContain("LoopDetection");
    expect(subagentNames.at(-1)).toBe("PromptBuild");
  });

  it("uses lead runtime by default and subagent runtime when requested", () => {
    expect(createDefaultMiddlewares().map((middleware) => middleware.name)).toEqual(
      createLeadRuntimeMiddlewares().map((middleware) => middleware.name),
    );
    expect(createDefaultMiddlewares({ isSubagent: true }).map((middleware) => middleware.name)).toEqual(
      createSubagentRuntimeMiddlewares().map((middleware) => middleware.name),
    );
  });
});
