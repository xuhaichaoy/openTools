import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { ChannelConfig } from "./types";
import { FeishuChannel } from "./feishu-channel";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);
const APP_CONFIG: ChannelConfig = {
  id: "feishu-test",
  type: "feishu",
  name: "Feishu Test",
  enabled: true,
  platformConfig: {
    appId: "feishu-app-id",
    appSecret: "feishu-app-secret",
    webhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/test",
  },
};

beforeEach(() => {
  invokeMock.mockReset();
});

describe("FeishuChannel.send", () => {
  it("uploads each attachment only once", async () => {
    invokeMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("file-key-1")
      .mockResolvedValueOnce(undefined);

    const channel = new FeishuChannel();
    await channel.connect(APP_CONFIG);
    await channel.send({
      conversationId: "oc_test_conv",
      attachments: [
        {
          path: "/tmp/export.xlsx",
          fileName: "export.xlsx",
        },
      ],
    });

    expect(invokeMock).toHaveBeenCalledWith("feishu_upload_file", {
      appId: "feishu-app-id",
      appSecret: "feishu-app-secret",
      baseUrl: "https://open.feishu.cn",
      filePath: "/tmp/export.xlsx",
      fileType: "xlsx",
    });
    expect(invokeMock).toHaveBeenCalledTimes(3);
    expect(invokeMock).toHaveBeenLastCalledWith("feishu_send_app_message", {
      appId: "feishu-app-id",
      appSecret: "feishu-app-secret",
      baseUrl: "https://open.feishu.cn",
      receiveId: "oc_test_conv",
      msgType: "file",
      content: JSON.stringify({ file_key: "file-key-1" }),
      replyToMessageId: null,
    });
  });
});
