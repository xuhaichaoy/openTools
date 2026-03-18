import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  fileContents: new Map<string, string>(),
  memorySnapshot: {
    longTermPath: "/memory/MEMORY.md",
    longTermContent: "",
    recentDailyFiles: [] as Array<{
      name: string;
      path: string;
      content: string;
    }>,
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (_command: string, payload?: { path?: string }) =>
    hoisted.fileContents.get(payload?.path || "") ?? "",
  ),
}));

vi.mock("./file-memory", () => ({
  getFileMemorySnapshot: vi.fn(async () => hoisted.memorySnapshot),
}));

import { buildBootstrapContextSnapshot } from "./bootstrap-context";

describe("bootstrap-context", () => {
  beforeEach(() => {
    hoisted.fileContents = new Map<string, string>();
    hoisted.memorySnapshot = {
      longTermPath: "/memory/MEMORY.md",
      longTermContent: "",
      recentDailyFiles: [],
    };
  });

  it("reports bootstrap truncation, omissions, and missing files", async () => {
    hoisted.fileContents = new Map<string, string>([
      ["/repo/AGENTS.md", "A".repeat(1500)],
      ["/repo/TOOLS.md", "T".repeat(1500)],
    ]);
    hoisted.memorySnapshot = {
      longTermPath: "/memory/MEMORY.md",
      longTermContent: "M".repeat(1200),
      recentDailyFiles: [
        {
          name: "2026-03-17.md",
          path: "/memory/2026-03-17.md",
          content: "D".repeat(900),
        },
      ],
    };

    const snapshot = await buildBootstrapContextSnapshot({
      workspaceRoot: "/repo",
      includeMemory: true,
      maxCharsPerFile: 600,
      totalMaxChars: 600,
      recentDailyFiles: 1,
    });

    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.diagnostics.includedFileCount).toBe(1);
    expect(snapshot.diagnostics.truncatedFileCount).toBe(1);
    expect(snapshot.diagnostics.omittedFileCount).toBe(3);
    expect(snapshot.diagnostics.missingFileCount).toBe(4);
    expect(
      snapshot.diagnostics.files
        .filter((file) => file.status === "omitted_budget")
        .map((file) => file.name),
    ).toEqual(["TOOLS.md", "MEMORY.md", "memory/2026-03-17.md"]);
    expect(snapshot.prompt).toContain("[该文件内容已按上下文预算截断]");
  });
});
