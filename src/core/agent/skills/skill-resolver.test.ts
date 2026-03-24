import { describe, it, expect, beforeEach } from "vitest";
import { applySkillToolFilter, resolveSkills, clearRegexCache } from "./skill-resolver";
import { SKILL_DATA_EXPORT } from "./builtin-skills";
import type { AgentSkill } from "./types";

function makeSkill(overrides: Partial<AgentSkill>): AgentSkill {
  return {
    id: "test-skill",
    name: "Test",
    description: "test skill",
    version: "1.0.0",
    enabled: true,
    autoActivate: true,
    triggerPatterns: ["test"],
    source: "user",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("resolveSkills", () => {
  beforeEach(() => {
    clearRegexCache();
  });

  it("returns empty when no skills match", () => {
    const skills = [makeSkill({ triggerPatterns: ["react"] })];
    const result = resolveSkills(skills, "deploy to production");
    expect(result.activeSkillIds).toHaveLength(0);
    expect(result.mergedSystemPrompt).toBe("");
  });

  it("activates skill matching trigger pattern", () => {
    const skills = [
      makeSkill({ id: "s1", triggerPatterns: ["react|vue"], systemPrompt: "Use React best practices" }),
    ];
    const result = resolveSkills(skills, "create a react component");
    expect(result.activeSkillIds).toEqual(["s1"]);
    expect(result.visibleSkillIds).toEqual(["s1"]);
    expect(result.mergedSystemPrompt).toContain("Use React best practices");
  });

  it("skips disabled skills", () => {
    const skills = [
      makeSkill({ id: "s1", enabled: false, triggerPatterns: ["react"] }),
    ];
    const result = resolveSkills(skills, "react component");
    expect(result.activeSkillIds).toHaveLength(0);
  });

  it("skips non-autoActivate skills unless manually pinned", () => {
    const skills = [
      makeSkill({ id: "s1", autoActivate: false, triggerPatterns: ["react"] }),
    ];
    const auto = resolveSkills(skills, "react component");
    expect(auto.activeSkillIds).toHaveLength(0);

    const manual = resolveSkills(skills, "react component", ["s1"]);
    expect(manual.activeSkillIds).toEqual(["s1"]);
  });

  it("limits auto-activated skills to 3", () => {
    const skills = [
      makeSkill({ id: "s1", triggerPatterns: ["test"], systemPrompt: "P1" }),
      makeSkill({ id: "s2", triggerPatterns: ["test"], systemPrompt: "P2" }),
      makeSkill({ id: "s3", triggerPatterns: ["test"], systemPrompt: "P3" }),
      makeSkill({ id: "s4", triggerPatterns: ["test"], systemPrompt: "P4" }),
    ];
    const result = resolveSkills(skills, "test something");
    expect(result.activeSkillIds).toHaveLength(3);
  });

  it("manually pinned skills always included regardless of limit", () => {
    const skills = [
      makeSkill({ id: "s1", triggerPatterns: ["test"], systemPrompt: "P1" }),
      makeSkill({ id: "s2", triggerPatterns: ["test"], systemPrompt: "P2" }),
      makeSkill({ id: "s3", triggerPatterns: ["test"], systemPrompt: "P3" }),
      makeSkill({ id: "s4", autoActivate: false, systemPrompt: "P4" }),
    ];
    const result = resolveSkills(skills, "test something", ["s4"]);
    expect(result.activeSkillIds).toContain("s4");
  });

  it("does not select auto skills when manual skills already exceed max limit", () => {
    const skills = [
      makeSkill({ id: "m1", autoActivate: false }),
      makeSkill({ id: "m2", autoActivate: false }),
      makeSkill({ id: "m3", autoActivate: false }),
      makeSkill({ id: "m4", autoActivate: false }),
      makeSkill({ id: "auto-1", triggerPatterns: ["test"] }),
      makeSkill({ id: "auto-2", triggerPatterns: ["test"] }),
    ];
    const result = resolveSkills(skills, "test query", ["m1", "m2", "m3", "m4"]);
    expect(result.activeSkillIds).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("merges tool filters with union includes and intersection excludes", () => {
    const skills = [
      makeSkill({
        id: "s1",
        triggerPatterns: ["test"],
        toolFilter: { include: ["read_file"], exclude: ["write_file", "run_shell"] },
      }),
      makeSkill({
        id: "s2",
        triggerPatterns: ["test"],
        toolFilter: { include: ["search_in_files"], exclude: ["write_file", "delete"] },
      }),
    ];
    const result = resolveSkills(skills, "test query");
    expect(result.mergedToolFilter.include?.sort()).toEqual(["read_file", "search_in_files"]);
    expect(result.mergedToolFilter.exclude).toEqual(["write_file"]);
  });

  it("ranks skills by match score", () => {
    const skills = [
      makeSkill({ id: "low", triggerPatterns: ["react"] }),
      makeSkill({ id: "high", triggerPatterns: ["react", "component", "tsx"] }),
    ];
    const result = resolveSkills(skills, "create a react component in tsx");
    expect(result.activeSkillIds[0]).toBe("high");
  });

  it("applies include/exclude tool filter in sequence", () => {
    const tools = [
      { name: "read_file" },
      { name: "write_file" },
      { name: "search_in_files" },
    ];
    const filtered = applySkillToolFilter(tools, {
      include: ["read_file", "write_file"],
      exclude: ["write_file"],
    });
    expect(filtered.map((t) => t.name)).toEqual(["read_file"]);
  });

  it("returns consistent results with regex caching across calls", () => {
    const skills = [
      makeSkill({ id: "s1", triggerPatterns: ["\\breact\\b|\\bvue\\b"], systemPrompt: "P1" }),
    ];
    const r1 = resolveSkills(skills, "create a react component");
    const r2 = resolveSkills(skills, "create a react component");
    expect(r1.activeSkillIds).toEqual(r2.activeSkillIds);
    expect(r1.mergedSystemPrompt).toEqual(r2.mergedSystemPrompt);
  });

  it("handles invalid regex patterns gracefully with cache", () => {
    const skills = [
      makeSkill({ id: "s1", triggerPatterns: ["[invalid", "react"], systemPrompt: "P1" }),
    ];
    const result = resolveSkills(skills, "react component");
    expect(result.activeSkillIds).toEqual(["s1"]);
  });

  it("expands visible skills through dependency closure", () => {
    const skills = [
      makeSkill({ id: "root", triggerPatterns: ["react"], systemPrompt: "Root", skillDependencies: ["dep-skill"] }),
      makeSkill({ id: "dep-skill", autoActivate: false, systemPrompt: "Dependency prompt" }),
    ];
    const result = resolveSkills(skills, "build react ui");
    expect(result.activeSkillIds).toEqual(["root"]);
    expect(result.visibleSkillIds).toEqual(["root", "dep-skill"]);
    expect(result.mergedSystemPrompt).toContain("Dependency prompt");
  });

  it("collects tool and mcp dependencies from visible skills", () => {
    const skills = [
      makeSkill({
        id: "root",
        triggerPatterns: ["deploy"],
        toolDependencies: ["read_file"],
        mcpDependencies: ["filesystem"],
      }),
      makeSkill({
        id: "dep",
        autoActivate: false,
        skillDependencies: [],
        toolDependencies: ["search_in_files"],
      }),
      makeSkill({
        id: "root-2",
        triggerPatterns: ["deploy"],
        skillDependencies: ["dep"],
      }),
    ];
    const result = resolveSkills(skills, "deploy service");
    expect(result.visibleSkillIds).toEqual(["root", "root-2", "dep"]);
    expect(result.dependencyToolNames.sort()).toEqual(["read_file", "search_in_files"]);
    expect(result.dependencyMcpNames).toEqual(["filesystem"]);
  });

  it("activates builtin data export skill only for explicit export phrases", () => {
    const exportResult = resolveSkills(
      [{ ...SKILL_DATA_EXPORT }],
      "帮我从数据库导出昨天已支付订单明细",
    );
    expect(exportResult.activeSkillIds).toEqual(["builtin-data-export"]);

    const nonExportResult = resolveSkills(
      [{ ...SKILL_DATA_EXPORT }],
      "数据库索引怎么优化更快",
    );
    expect(nonExportResult.activeSkillIds).toEqual([]);
  });
});
