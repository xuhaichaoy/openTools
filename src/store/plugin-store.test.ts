import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInstance } from "@/core/plugin-system/types";

const { invoke, matchPluginsMock, registerExternalActions } = vi.hoisted(() => ({
  invoke: vi.fn(),
  matchPluginsMock: vi.fn(),
  registerExternalActions: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke,
}));

vi.mock("@/core/errors", () => ({
  handleError: vi.fn(),
}));

vi.mock("@/core/plugin-system/command-matcher", () => ({
  matchPlugins: (...args: unknown[]) => matchPluginsMock(...args),
}));

vi.mock("@/core/plugin-system/registry", () => ({
  registry: {
    registerExternalActions,
  },
}));

import { usePluginStore } from "./plugin-store";

function makePlugin(id: string): PluginInstance {
  return {
    id,
    manifest: {
      pluginName: `Plugin ${id}`,
      description: "Test plugin",
      version: "1.0.0",
      features: [],
    },
    dirPath: `/tmp/${id}`,
    enabled: true,
    isBuiltin: false,
  };
}

describe("plugin-store", () => {
  beforeEach(() => {
    invoke.mockReset();
    matchPluginsMock.mockReset();
    registerExternalActions.mockReset();
    usePluginStore.setState({
      plugins: [],
      isLoading: false,
      devDirs: [],
    });
  });

  it("should forward plugin match context to the matcher", () => {
    const plugin = makePlugin("plugin-a");
    const context = { type: "img" as const, payload: { path: "/tmp/a.png" } };

    usePluginStore.setState({ plugins: [plugin] });
    matchPluginsMock.mockReturnValue([]);

    usePluginStore.getState().matchInput("", context);

    expect(matchPluginsMock).toHaveBeenCalledWith([plugin], "", context);
  });
});
