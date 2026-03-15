import { describe, expect, it } from "vitest";
import { matchPlugins } from "./command-matcher";
import type { PluginCommand, PluginInstance } from "./types";

function createPlugin(cmds: (string | PluginCommand)[]): PluginInstance {
  return {
    id: "plugin-test",
    manifest: {
      pluginName: "Utility Suite",
      description: "Test plugin",
      version: "1.0.0",
      features: [
        {
          code: "feature-a",
          explain: "Feature entry",
          cmds,
        },
      ],
    },
    dirPath: "/tmp/plugin-test",
    enabled: true,
    isBuiltin: false,
  };
}

describe("matchPlugins", () => {
  it("should respect minLength and maxLength for command objects", () => {
    const plugin = createPlugin([
      {
        type: "text",
        label: "clip",
        minLength: 3,
        maxLength: 4,
      },
    ]);

    expect(matchPlugins([plugin], "cl")).toHaveLength(0);
    expect(matchPlugins([plugin], "clip")).toHaveLength(1);
    expect(matchPlugins([plugin], "clipx")).toHaveLength(0);
  });

  it("should allow capability-based commands to match non-text enter contexts", () => {
    const plugin = createPlugin([
      {
        type: "img",
        label: "Image Handler",
      },
    ]);

    expect(matchPlugins([plugin], "", { type: "img" })).toHaveLength(1);
    expect(matchPlugins([plugin], "", { type: "text" })).toHaveLength(0);
  });
});
