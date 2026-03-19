import { describe, expect, it } from "vitest";

import {
  clampGlobalAgentMaxIterations,
  resolveActorEffectiveMaxIterations,
} from "./iteration-budget";

describe("iteration-budget", () => {
  it("uses global config for dialog actors without explicit override", () => {
    expect(resolveActorEffectiveMaxIterations({
      actorMaxIterations: 20,
      actorHasExplicitMaxIterations: false,
      globalConfiguredMaxIterations: 25,
    })).toBe(25);
  });

  it("keeps explicit actor max iterations when they are lower", () => {
    expect(resolveActorEffectiveMaxIterations({
      actorMaxIterations: 8,
      actorHasExplicitMaxIterations: true,
      globalConfiguredMaxIterations: 25,
    })).toBe(8);
  });

  it("caps actor and override requests by the global config", () => {
    expect(resolveActorEffectiveMaxIterations({
      actorMaxIterations: 40,
      actorHasExplicitMaxIterations: false,
      globalConfiguredMaxIterations: 30,
      runOverrideMaxIterations: 50,
    })).toBe(30);
  });

  it("clamps invalid global config values into supported range", () => {
    expect(clampGlobalAgentMaxIterations(2)).toBe(5);
    expect(clampGlobalAgentMaxIterations(80)).toBe(50);
  });
});
