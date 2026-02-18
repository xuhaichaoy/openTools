/**
 * permission-guard.ts 单元测试
 */

import { describe, it, expect } from "vitest";
import {
  checkPermission,
  getDeclaredPermissions,
  PERMISSION_LABELS,
} from "./permission-guard";
import type { PluginInstance } from "./types";

function makePlugin(
  overrides: Partial<PluginInstance> & {
    permissions?: string[];
  } = {},
): PluginInstance {
  const { permissions, ...rest } = overrides;
  return {
    id: "test-plugin",
    manifest: {
      pluginName: "Test Plugin",
      description: "A test plugin",
      version: "1.0.0",
      features: [],
      mtools: {
        permissions: permissions as any,
      },
    },
    dirPath: "/tmp/test",
    enabled: true,
    isBuiltin: false,
    ...rest,
  };
}

describe("checkPermission", () => {
  it("should allow builtin plugins to call anything", () => {
    const plugin = makePlugin({ isBuiltin: true });
    expect(checkPermission(plugin, "run_shell_command")).toEqual({
      allowed: true,
    });
    expect(checkPermission(plugin, "read_file")).toEqual({ allowed: true });
  });

  it("should allow when permission is declared", () => {
    const plugin = makePlugin({ permissions: ["shell"] });
    expect(checkPermission(plugin, "run_shell_command")).toEqual({
      allowed: true,
    });
  });

  it("should deny when permission is not declared", () => {
    const plugin = makePlugin({ permissions: ["clipboard"] });
    const result = checkPermission(plugin, "run_shell_command");
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("shell");
      expect(result.reason).toContain("Test Plugin");
    }
  });

  it("should allow unmapped methods by default", () => {
    const plugin = makePlugin({ permissions: [] });
    expect(checkPermission(plugin, "get_theme")).toEqual({ allowed: true });
  });

  it("should deny filesystem access without declaration", () => {
    const plugin = makePlugin({ permissions: ["network"] });
    expect(checkPermission(plugin, "read_file").allowed).toBe(false);
    expect(checkPermission(plugin, "write_file").allowed).toBe(false);
    expect(checkPermission(plugin, "list_dir").allowed).toBe(false);
  });

  it("should allow multiple declared permissions", () => {
    const plugin = makePlugin({
      permissions: ["filesystem", "network", "clipboard"],
    });
    expect(checkPermission(plugin, "read_file").allowed).toBe(true);
    expect(checkPermission(plugin, "http_request").allowed).toBe(true);
    expect(checkPermission(plugin, "clipboard_read").allowed).toBe(true);
    expect(checkPermission(plugin, "run_shell_command").allowed).toBe(false);
  });
});

describe("getDeclaredPermissions", () => {
  it("should return all permissions for builtin plugins", () => {
    const plugin = makePlugin({ isBuiltin: true });
    const perms = getDeclaredPermissions(plugin);
    expect(perms).toContain("shell");
    expect(perms).toContain("filesystem");
    expect(perms).toContain("network");
    expect(perms.length).toBe(6);
  });

  it("should return declared permissions for external plugins", () => {
    const plugin = makePlugin({ permissions: ["clipboard", "network"] });
    const perms = getDeclaredPermissions(plugin);
    expect(perms).toEqual(["clipboard", "network"]);
  });

  it("should return empty array when no permissions declared", () => {
    const plugin = makePlugin({});
    // mtools.permissions is undefined when overrides doesn't set it
    const noPermsPlugin = {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        mtools: undefined,
      },
    };
    expect(getDeclaredPermissions(noPermsPlugin)).toEqual([]);
  });
});

describe("PERMISSION_LABELS", () => {
  it("should have labels for all permission types", () => {
    const keys = Object.keys(PERMISSION_LABELS);
    expect(keys).toContain("clipboard");
    expect(keys).toContain("network");
    expect(keys).toContain("filesystem");
    expect(keys).toContain("shell");
    expect(keys).toContain("notification");
    expect(keys).toContain("system");
    expect(keys.length).toBe(6);
  });
});
