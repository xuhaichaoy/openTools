import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelIncomingMessage } from "@/core/channels/types";
import { useIMConversationRuntimeStore } from "@/store/im-conversation-runtime-store";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
  })),
}));

vi.mock("./export-agent", () => ({
  ensureExportSourceConnected: vi.fn(),
  runExportAgent: vi.fn(),
}));

vi.mock("./runtime-catalog", () => ({
  loadRuntimeExportCatalog: vi.fn(),
}));

vi.mock("./team-data-export-api", () => ({
  confirmTeamDataExport: vi.fn(),
  isTeamDataExportApiUnavailable: vi.fn(() => false),
  previewTeamDataExport: vi.fn(),
}));

import { runExportAgent } from "./export-agent";
import { IMDataExportRuntimeManager } from "./im-data-export-runtime-manager";
import { loadRuntimeExportCatalog } from "./runtime-catalog";
import { invoke } from "@tauri-apps/api/core";

function makeMessage(text: string, overrides?: Partial<ChannelIncomingMessage>): ChannelIncomingMessage {
  return {
    messageId: overrides?.messageId ?? `msg-${Date.now()}`,
    senderId: overrides?.senderId ?? "user-1",
    senderName: overrides?.senderName ?? "海超",
    text,
    messageType: overrides?.messageType ?? "text",
    conversationId: overrides?.conversationId ?? "conv-1",
    conversationType: overrides?.conversationType ?? "private",
    timestamp: overrides?.timestamp ?? 1710000000000,
    ...overrides,
  };
}

describe("IMDataExportRuntimeManager explicit database mode", () => {
  beforeEach(() => {
    useIMConversationRuntimeStore.getState().reset();
    vi.clearAllMocks();
  });

  it("enters database mode only via the explicit command", async () => {
    const onReply = vi.fn().mockResolvedValue(undefined);
    const manager = new IMDataExportRuntimeManager({ onReply });

    const result = await manager.handleIncoming({
      channelId: "channel-1",
      channelType: "dingtalk",
      msg: makeMessage("数据库操作", { messageId: "msg-enter" }),
    });

    expect(result).toEqual({ handled: true });
    expect(onReply).toHaveBeenCalledWith({
      channelId: "channel-1",
      conversationId: "conv-1",
      messageId: "msg-enter",
      text: "已进入数据库操作模式。接下来你可以直接描述查数或导出需求，如需退出请发送“退出数据库操作”。",
    });

    const snapshot = useIMConversationRuntimeStore.getState();
    expect(snapshot.conversations).toHaveLength(1);
    expect(snapshot.conversations[0]?.conversationMode).toBe("database_operation");
    const activeSessionId = snapshot.conversations[0]?.activeSessionId;
    const preview = activeSessionId ? snapshot.sessionPreviews[activeSessionId] : undefined;
    expect(preview?.conversationMode).toBe("database_operation");
    expect(preview?.dialogHistory.map((item) => item.content)).toEqual([
      "数据库操作",
      "已进入数据库操作模式。接下来你可以直接描述查数或导出需求，如需退出请发送“退出数据库操作”。",
    ]);
  });

  it("routes all follow-up messages to export lane until explicit exit", async () => {
    const onReply = vi.fn().mockResolvedValue(undefined);
    const manager = new IMDataExportRuntimeManager({ onReply });
    vi.mocked(runExportAgent).mockResolvedValue({
      kind: "answer",
      answer: "请告诉我你想导出哪些字段。",
    });

    await manager.handleIncoming({
      channelId: "channel-1",
      channelType: "dingtalk",
      msg: makeMessage("数据库操作", { messageId: "msg-enter" }),
    });

    const followupResult = await manager.handleIncoming({
      channelId: "channel-1",
      channelType: "dingtalk",
      msg: makeMessage("王者荣耀", { messageId: "msg-followup", timestamp: 1710000001000 }),
    });

    expect(followupResult).toEqual({ handled: true });
    expect(runExportAgent).toHaveBeenCalledWith({
      userInput: "王者荣耀",
      originalRequest: undefined,
    });

    let snapshot = useIMConversationRuntimeStore.getState();
    let activeSessionId = snapshot.conversations[0]?.activeSessionId;
    let preview = activeSessionId ? snapshot.sessionPreviews[activeSessionId] : undefined;
    expect(preview?.conversationMode).toBe("database_operation");
    expect(preview?.dialogHistory.map((item) => item.content)).toContain("请告诉我你想导出哪些字段。");

    const exitResult = await manager.handleIncoming({
      channelId: "channel-1",
      channelType: "dingtalk",
      msg: makeMessage("退出数据库操作", { messageId: "msg-exit", timestamp: 1710000002000 }),
    });

    expect(exitResult).toEqual({ handled: true });
    snapshot = useIMConversationRuntimeStore.getState();
    activeSessionId = snapshot.conversations[0]?.activeSessionId;
    preview = activeSessionId ? snapshot.sessionPreviews[activeSessionId] : undefined;
    expect(snapshot.conversations[0]?.conversationMode).toBe("normal");
    expect(preview?.conversationMode).toBe("normal");
    expect(preview?.dialogHistory.map((item) => item.content)).toContain("退出数据库操作");
    expect(preview?.dialogHistory.at(-1)?.content).toBe("已退出数据库操作模式，后续消息将按普通对话处理。");

    const normalResult = await manager.handleIncoming({
      channelId: "channel-1",
      channelType: "dingtalk",
      msg: makeMessage("帮我总结今天的会议", { messageId: "msg-normal", timestamp: 1710000003000 }),
    });

    expect(normalResult).toEqual({ handled: false });
    expect(runExportAgent).toHaveBeenCalledTimes(1);
  });

  it("passes the last protocol context into follow-up export queries", async () => {
    const onReply = vi.fn().mockResolvedValue(undefined);
    const manager = new IMDataExportRuntimeManager({ onReply });
    vi.mocked(runExportAgent)
      .mockResolvedValueOnce({
        kind: "answer",
        answer: "有，当前可读取的库 / schema 里包含 athena_user。",
        protocolContext: {
          action: "namespace_exists",
          sourceId: "personal-mysql",
          sourceScope: "personal",
          namespace: "athena_user",
        },
      })
      .mockResolvedValueOnce({
        kind: "answer",
        answer: "在 athena_user 里可读的表有 company、company_user。",
        protocolContext: {
          action: "list_tables",
          sourceId: "personal-mysql",
          sourceScope: "personal",
          namespace: "athena_user",
        },
      });

    await manager.handleIncoming({
      channelId: "channel-1",
      channelType: "dingtalk",
      msg: makeMessage("数据库操作", { messageId: "msg-enter" }),
    });

    await manager.handleIncoming({
      channelId: "channel-1",
      channelType: "dingtalk",
      msg: makeMessage("athena_user", { messageId: "msg-ns", timestamp: 1710000001000 }),
    });

    await manager.handleIncoming({
      channelId: "channel-1",
      channelType: "dingtalk",
      msg: makeMessage("看一下这个库内可用的表", { messageId: "msg-tables", timestamp: 1710000002000 }),
    });

    expect(vi.mocked(runExportAgent)).toHaveBeenNthCalledWith(1, {
      userInput: "athena_user",
      originalRequest: undefined,
      protocolContext: undefined,
    });
    expect(vi.mocked(runExportAgent)).toHaveBeenNthCalledWith(2, {
      userInput: "看一下这个库内可用的表",
      originalRequest: "athena_user",
      protocolContext: {
        action: "namespace_exists",
        sourceId: "personal-mysql",
        sourceScope: "personal",
        namespace: "athena_user",
      },
    });
  });

  it("does not hijack database-related natural language before entering the mode", async () => {
    const onReply = vi.fn().mockResolvedValue(undefined);
    const manager = new IMDataExportRuntimeManager({ onReply });

    const result = await manager.handleIncoming({
      channelId: "channel-1",
      channelType: "dingtalk",
      msg: makeMessage("数据库内查询 公司表 找王者荣耀", { messageId: "msg-plain" }),
    });

    expect(result).toEqual({ handled: false });
    expect(runExportAgent).not.toHaveBeenCalled();
    expect(onReply).not.toHaveBeenCalled();
    expect(useIMConversationRuntimeStore.getState().conversations).toHaveLength(0);
  });

  it("does not keep confirmation state when preview returns zero rows", async () => {
    const onReply = vi.fn().mockResolvedValue(undefined);
    const manager = new IMDataExportRuntimeManager({ onReply });
    vi.mocked(runExportAgent).mockResolvedValue({
      kind: "intent",
      summary: "我理解的是：查询该企业的基础信息。",
      intent: {
        sourceId: "personal-mysql",
        entityName: "company",
        entityType: "table",
        schema: "athena_user",
        baseAlias: "c",
        fields: [{ field: "c.compname", alias: "企业名称" }],
        filters: [{ field: "c.compname", op: "contains_compact", value: "第一企kkk" }],
        outputFormat: "csv",
      },
    });
    vi.mocked(loadRuntimeExportCatalog).mockResolvedValue({
      activeTeamId: null,
      teamRuntimeAvailable: false,
      sources: [
        {
          id: "personal-mysql",
          scope: "personal",
          executionTarget: "local",
          originSourceId: "personal-mysql",
          name: "个人 MySQL",
          db_type: "mysql",
        },
      ],
      datasets: [],
    });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "data_export_preview") {
        return {
          previewToken: "preview-1",
          sourceKind: "mysql",
          canonicalQuery: "select ...",
          columns: ["企业名称"],
          rows: [],
          previewRowCount: 0,
          estimatedTotal: 0,
        };
      }
      return null;
    });

    await manager.handleIncoming({
      channelId: "channel-1",
      channelType: "dingtalk",
      msg: makeMessage("数据库操作", { messageId: "msg-enter" }),
    });

    const result = await manager.handleIncoming({
      channelId: "channel-1",
      channelType: "dingtalk",
      msg: makeMessage("查询 第一企kkk 这个公司的信息", { messageId: "msg-query", timestamp: 1710000001000 }),
    });

    expect(result).toEqual({ handled: true });
    const lastReply = onReply.mock.calls.at(-1)?.[0];
    expect(lastReply?.text).toContain("当前没有查到匹配记录。");
    expect(lastReply?.text).not.toContain("确认导出");
  });

  it("does not start duplicate exports when confirm arrives twice while exporting", async () => {
    const onReply = vi.fn().mockResolvedValue(undefined);
    const manager = new IMDataExportRuntimeManager({ onReply });

    let resolveExport: ((value: unknown) => void) | undefined;
    const exportPending = new Promise((resolve) => {
      resolveExport = resolve;
    });

    vi.mocked(runExportAgent).mockResolvedValue({
      kind: "intent",
      summary: "我理解的是：导出公司数据。",
      intent: {
        sourceId: "personal-mysql",
        entityName: "company",
        entityType: "table",
        schema: "athena_user",
        fields: ["compname"],
        outputFormat: "csv",
      },
    });
    vi.mocked(loadRuntimeExportCatalog).mockResolvedValue({
      activeTeamId: null,
      teamRuntimeAvailable: false,
      sources: [
        {
          id: "personal-mysql",
          scope: "personal",
          executionTarget: "local",
          originSourceId: "personal-mysql",
          name: "个人 MySQL",
          db_type: "mysql",
        },
      ],
      datasets: [],
    });
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === "data_export_preview") {
        return Promise.resolve({
          previewToken: "preview-dup-1",
          sourceKind: "mysql",
          canonicalQuery: "select compname from company",
          columns: ["compname"],
          rows: [{ compname: "王者荣耀" }],
          previewRowCount: 1,
          estimatedTotal: 1,
        });
      }
      if (command === "data_export_confirm_csv_export") {
        return exportPending as Promise<unknown>;
      }
      return Promise.resolve(null);
    });

    await manager.handleIncoming({
      channelId: "channel-1",
      channelType: "dingtalk",
      msg: makeMessage("数据库操作", { messageId: "msg-enter" }),
    });

    await manager.handleIncoming({
      channelId: "channel-1",
      channelType: "dingtalk",
      msg: makeMessage("导出公司数据", { messageId: "msg-query", timestamp: 1710000001000 }),
    });

    const firstConfirmPromise = manager.handleIncoming({
      channelId: "channel-1",
      channelType: "dingtalk",
      msg: makeMessage("确认导出", { messageId: "msg-confirm-1", timestamp: 1710000002000 }),
    });

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("data_export_confirm_csv_export", {
        previewToken: "preview-dup-1",
      });
    });

    const secondConfirmResult = await manager.handleIncoming({
      channelId: "channel-1",
      channelType: "dingtalk",
      msg: makeMessage("确认导出", { messageId: "msg-confirm-2", timestamp: 1710000003000 }),
    });

    expect(secondConfirmResult).toEqual({ handled: true });
    expect(
      vi.mocked(invoke).mock.calls.filter(([command]) => command === "data_export_confirm_csv_export"),
    ).toHaveLength(1);

    resolveExport?.({
      previewToken: "preview-dup-1",
      filePath: "/tmp/export-preview-dup-1.csv",
      rowCount: 1,
      columns: ["compname"],
    });

    await expect(firstConfirmPromise).resolves.toEqual({ handled: true });

    const completionReplies = onReply.mock.calls
      .map(([payload]) => payload)
      .filter((payload) => payload.attachments?.[0]?.path === "/tmp/export-preview-dup-1.csv");
    expect(completionReplies).toHaveLength(1);
  });
});
