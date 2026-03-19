import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { buildMcpToolName, parseMcpToolName } from "./mcp-store";

describe("mcp-store tool naming", () => {
  it("keeps Chrome DevTools MCP tool names within OpenAI tool name limits", () => {
    const toolName = buildMcpToolName(
      "mcp-chrome-devtools-1773898231482",
      "performance_analyze_insight",
    );

    expect(toolName.length).toBeLessThanOrEqual(64);
    expect(toolName).toMatch(/^mcp_[^_]+_performance_analyze_insight$/);
  });

  it("parses alias-based tool names back to the original server and tool", () => {
    const serverId = "mcp-chrome-devtools-1773898231482";
    const realToolName = "take_screenshot";
    const toolName = buildMcpToolName(serverId, realToolName);

    expect(
      parseMcpToolName(toolName, [{ id: serverId }]),
    ).toEqual({
      serverId,
      realToolName,
    });
  });

  it("remains compatible with the legacy full-server-id tool prefix", () => {
    const serverId = "mcp-chrome-devtools-1773898231482";

    expect(
      parseMcpToolName(`mcp_${serverId}_take_snapshot`, [{ id: serverId }]),
    ).toEqual({
      serverId,
      realToolName: "take_snapshot",
    });
  });
});
