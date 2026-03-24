import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  aiChat: vi.fn(),
  agentRun: vi.fn(),
  getMToolsAI: vi.fn(),
  getResolvedAIConfigForMode: vi.fn(() => ({
    source: "own_key",
    model: "mock-model",
    protocol: "openai",
  })),
  buildAgentFCCompatibilityKey: vi.fn(() => "mock-fc-key"),
  loadRuntimeExportCatalog: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/core/ai/mtools-ai", () => ({
  getMToolsAI: hoisted.getMToolsAI,
}));

vi.mock("@/core/ai/resolved-ai-config-store", () => ({
  getResolvedAIConfigForMode: hoisted.getResolvedAIConfigForMode,
}));

vi.mock("@/core/agent/fc-compatibility", () => ({
  buildAgentFCCompatibilityKey: hoisted.buildAgentFCCompatibilityKey,
}));

vi.mock("./runtime-catalog", () => ({
  loadRuntimeExportCatalog: hoisted.loadRuntimeExportCatalog,
}));

vi.mock("@/plugins/builtin/SmartAgent/core/react-agent", () => ({
  ReActAgent: class {
    run(prompt: string) {
      return hoisted.agentRun(prompt);
    }
  },
}));

import { invoke } from "@tauri-apps/api/core";
import { runExportAgent } from "./export-agent";
import type { RuntimeExportSourceConfig } from "./types";

describe("runExportAgent model-first routing", () => {
  const personalMysqlSource: RuntimeExportSourceConfig = {
    id: "personal-mysql",
    scope: "personal",
    executionTarget: "local",
    originSourceId: "personal-mysql",
    name: "个人 MySQL",
    db_type: "mysql",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.getMToolsAI.mockReturnValue({
      kind: "mock-ai",
      chat: hoisted.aiChat,
    });
    hoisted.loadRuntimeExportCatalog.mockResolvedValue({
      activeTeamId: null,
      teamRuntimeAvailable: false,
      sources: [personalMysqlSource],
      datasets: [],
    });
  });

  it("executes dbproto namespace existence checks before other routing", async () => {
    hoisted.aiChat.mockResolvedValue({
      content: '{"version":"dbproto/v1","action":"namespace_exists","sourceId":"personal-mysql","namespace":"athena_user"}',
    });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "db_connect") return null;
      if (command === "db_list_schemas") return ["athena_user", "athena_basis"];
      throw new Error(`unexpected command: ${String(command)}`);
    });

    const decision = await runExportAgent({
      userInput: "里面是否有 athena_user 的库",
      originalRequest: "看一下现在都有哪些库",
    });

    expect(decision).toEqual({
      kind: "answer",
      answer: expect.stringContaining("有，当前可读取的库 / schema 里包含 athena_user。"),
    });
    expect(hoisted.agentRun).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("db_connect", { config: personalMysqlSource });
    expect(invoke).toHaveBeenCalledWith("db_list_schemas", { connId: "personal-mysql" });
  });

  it("executes dbproto table listing through readonly tools", async () => {
    hoisted.aiChat.mockResolvedValue({
      content: '{"version":"dbproto/v1","action":"list_tables","sourceId":"personal-mysql","namespace":"athena_user"}',
    });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "db_connect") return null;
      if (command === "db_list_tables") {
        return [
          { name: "company", schema: "athena_user", table_type: "BASE TABLE" },
          { name: "company_user", schema: "athena_user", table_type: "BASE TABLE" },
        ];
      }
      throw new Error(`unexpected command: ${String(command)}`);
    });

    const decision = await runExportAgent({
      userInput: "看一下 athena_user 里有哪些表",
    });

    expect(decision).toEqual({
      kind: "answer",
      answer: expect.stringContaining("company、company_user"),
    });
    expect(hoisted.agentRun).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("db_list_tables", {
      connId: "personal-mysql",
      schema: "athena_user",
    });
  });

  it("executes dbproto sample-table inspection through readonly tools", async () => {
    hoisted.aiChat.mockResolvedValue({
      content: '{"version":"dbproto/v1","action":"sample_table","sourceId":"personal-mysql","table":"athena_user.company","limit":3}',
    });
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "db_connect") return null;
      if (command === "db_describe_table") {
        return [
          { name: "id", data_type: "bigint", nullable: false, primary_key: true },
          { name: "compname", data_type: "varchar", nullable: false, primary_key: false },
        ];
      }
      if (command === "db_sample_table") {
        return {
          columns: ["id", "compname"],
          rows: [[1, "王者荣耀"]],
          affected: 1,
          elapsed_ms: 8,
        };
      }
      throw new Error(`unexpected command: ${String(command)}`);
    });

    const decision = await runExportAgent({
      userInput: "看一下 athena_user.company 的样本数据",
    });

    expect(decision).toEqual({
      kind: "answer",
      answer: expect.stringContaining("样本数据："),
    });
    if (!decision || decision.kind !== "answer") {
      throw new Error("expected protocol sample answer");
    }
    expect(decision.answer).toContain("compname（varchar");
    expect(decision.answer).toContain("1. id=1；compname=王者荣耀");
    expect(hoisted.agentRun).not.toHaveBeenCalled();
  });

  it("falls back to agent routing when dbproto delegates", async () => {
    hoisted.aiChat.mockResolvedValue({
      content: '{"version":"dbproto/v1","action":"delegate","reason":"需要进一步业务查询"}',
    });
    hoisted.agentRun.mockResolvedValue('{"kind":"answer","answer":"模型判断：当前可读取的库有 athena_user。"}');

    const decision = await runExportAgent({
      userInput: "里面是否有 athena_user 的库",
      originalRequest: "看一下现在都有哪些库",
    });

    expect(decision).toEqual({
      kind: "answer",
      answer: "模型判断：当前可读取的库有 athena_user。",
    });
    expect(hoisted.agentRun).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("falls back to deterministic metadata tools when protocol and agent routing both fail", async () => {
    hoisted.aiChat.mockRejectedValue(new Error("protocol unavailable"));
    hoisted.agentRun.mockRejectedValue(new Error("ai unavailable"));
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "db_connect") return null;
      if (command === "db_list_schemas") {
        return ["athena_user", "athena_basis"];
      }
      throw new Error(`unexpected command: ${String(command)}`);
    });

    const decision = await runExportAgent({
      userInput: "里面是否有 athena_user 的库",
      originalRequest: "看一下现在都有哪些库",
    });

    expect(decision).toEqual({
      kind: "answer",
      answer: expect.stringContaining("有，当前可读取的库 / schema 里包含 athena_user。"),
    });
    expect(invoke).toHaveBeenCalledWith("db_list_schemas", { connId: "personal-mysql" });
  });
});
