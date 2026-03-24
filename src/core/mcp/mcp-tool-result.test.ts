import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { materializeMcpToolResult } from "./mcp-tool-result";

describe("materializeMcpToolResult", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("keeps text blocks and emits MEDIA for image blocks", async () => {
    vi.mocked(invoke).mockResolvedValue("/tmp/weather-shot.png");

    const result = await materializeMcpToolResult({
      content: [
        { type: "text", text: "已完成截图" },
        { type: "image", data: "ZmFrZS1pbWFnZQ==", mimeType: "image/png" },
      ],
    });

    expect(result).toBe("已完成截图\nMEDIA:/tmp/weather-shot.png");
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("ai_save_chat_image", expect.objectContaining({
      imageData: "ZmFrZS1pbWFnZQ==",
    }));
  });

  it("passes through resource links as MEDIA directives", async () => {
    const result = await materializeMcpToolResult({
      content: [
        { type: "resource_link", uri: "file:///tmp/baidu weather.png", mimeType: "image/png" },
      ],
    });

    expect(result).toBe("MEDIA:`file:///tmp/baidu weather.png`");
    expect(vi.mocked(invoke)).not.toHaveBeenCalled();
  });

  it("materializes image blobs nested under resource payloads", async () => {
    vi.mocked(invoke).mockResolvedValue("/tmp/nested.png");

    const result = await materializeMcpToolResult({
      content: [
        {
          type: "resource",
          resource: {
            uri: "mcp://browser/screenshot",
            mimeType: "image/png",
            blob: "data:image/png;base64,QUJDRA==",
          },
        },
      ],
    });

    expect(result).toBe("MEDIA:/tmp/nested.png");
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
  });

  it("falls back to JSON for unknown payloads", async () => {
    const result = await materializeMcpToolResult({ ok: true });
    expect(result).toBe(JSON.stringify({ ok: true }));
  });

  it("extracts MEDIA from screenshot tool text outputs", async () => {
    const result = await materializeMcpToolResult({
      content: [
        {
          type: "text",
          text: "Took a screenshot of the current page's viewport.\nSaved screenshot to /tmp/baidu_today_weather.png.",
        },
      ],
    });

    expect(result).toBe(
      "Took a screenshot of the current page's viewport.\nSaved screenshot to /tmp/baidu_today_weather.png.\nMEDIA:/tmp/baidu_today_weather.png",
    );
  });
});
