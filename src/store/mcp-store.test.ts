import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { buildMcpToolName, parseMcpToolName } from "./mcp-store";
import { executeMcpTool, useMcpStore } from "./mcp-store";
import { invoke } from "@tauri-apps/api/core";

describe("mcp-store tool naming", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    useMcpStore.setState((state) => ({
      ...state,
      servers: [],
      serverStatus: {},
      serverTools: {},
      serverResources: {},
      serverPrompts: {},
    }));
  });

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

  it("materializes MCP image content into OpenClaw-style MEDIA lines", async () => {
    useMcpStore.setState((state) => ({
      ...state,
      servers: [
        {
          id: "mcp-browser",
          name: "Browser",
          transport: "stdio",
          enabled: true,
        },
      ],
    }));

    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "send_mcp_message") {
        return JSON.stringify({
          result: {
            content: [
              { type: "text", text: "天气截图如下" },
              { type: "image", data: "ZmFrZS1zY3JlZW5zaG90", mimeType: "image/png" },
            ],
          },
        });
      }
      if (command === "ai_save_chat_image") {
        expect(args).toMatchObject({
          imageData: "ZmFrZS1zY3JlZW5zaG90",
        });
        return "/tmp/weather.png";
      }
      throw new Error(`unexpected invoke: ${String(command)}`);
    });

    const result = await executeMcpTool(
      buildMcpToolName("mcp-browser", "take_screenshot"),
      "{}",
    );

    expect(result).toEqual({
      success: true,
      result: "天气截图如下\nMEDIA:/tmp/weather.png",
    });
  });

  it("starts stdio MCP with initialize request plus initialized notification", async () => {
    useMcpStore.setState((state) => ({
      ...state,
      servers: [
        {
          id: "mcp-chrome",
          name: "Chrome DevTools MCP",
          transport: "stdio",
          command: "npx",
          args: ["-y", "chrome-devtools-mcp@latest"],
          enabled: true,
        },
      ],
      serverStatus: {},
      serverTools: {},
      serverResources: {},
      serverPrompts: {},
    }));

    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "start_mcp_stdio_server") {
        return "Server mcp-chrome started";
      }
      if (command === "send_mcp_message") {
        const parsed = JSON.parse(String((args as { message: string }).message));
        expect(parsed.method).toBeTypeOf("string");
        return JSON.stringify({ result: { tools: [] } });
      }
      if (command === "send_mcp_notification") {
        const parsed = JSON.parse(String((args as { message: string }).message));
        expect(parsed.id).toBeUndefined();
        expect(parsed.method).toBe("notifications/initialized");
        return null;
      }
      return null;
    });

    await useMcpStore.getState().startServer("mcp-chrome");

    expect(vi.mocked(invoke)).toHaveBeenCalledWith("send_mcp_notification", {
      serverId: "mcp-chrome",
      message: expect.stringContaining("\"method\":\"notifications/initialized\""),
    });
  });
});
