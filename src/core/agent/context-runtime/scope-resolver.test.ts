import { describe, expect, it } from "vitest";
import { collectContextPathHints } from "./scope-resolver";

describe("collectContextPathHints", () => {
  it("collects nested absolute paths from structured context payloads", () => {
    const hints = collectContextPathHints({
      artifact: {
        path: "/repo/src/pages/DialogRoom.tsx",
      },
      files: [
        { filePath: "/repo/package.json" },
        "/repo/src/components/App.tsx",
      ],
      note: "输出保存到了 /repo/docs/result.md，请继续处理",
      ignoredRelative: "src/local.ts",
    });

    expect(hints).toEqual([
      "/repo/src/pages/DialogRoom.tsx",
      "/repo/package.json",
      "/repo/src/components/App.tsx",
      "/repo/docs/result.md",
    ]);
  });
});
