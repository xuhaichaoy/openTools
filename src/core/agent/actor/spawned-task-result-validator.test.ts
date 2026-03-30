import { describe, expect, it } from "vitest";
import {
  buildSpawnTaskExecutionHint,
  validateActorTaskResult,
  validateSpawnedTaskResult,
} from "./spawned-task-result-validator";
import type { DialogArtifactRecord, SpawnedTaskRecord } from "./types";
import type { AgentStep } from "@/plugins/builtin/SmartAgent/core/react-agent";

function makeTask(task: string, label?: string): SpawnedTaskRecord {
  return {
    runId: "run-1",
    spawnerActorId: "coordinator",
    targetActorId: "specialist",
    task,
    label,
    status: "running",
    spawnedAt: 1000,
    mode: "run",
    expectsCompletionMessage: true,
    cleanup: "keep",
  };
}

describe("spawned-task-result-validator", () => {
  it("adds stronger execution hints for concrete coding or page-generation tasks", () => {
    const hint = buildSpawnTaskExecutionHint("请创建一个多 Agent 协作房间网页");
    expect(hint).toContain("需要具体产物或可验证结果");
    expect(hint).toContain("文件路径");
  });

  it("rejects obviously unrelated arithmetic output for a page creation task", () => {
    const validation = validateSpawnedTaskResult({
      task: makeTask("请创建一个多 Agent 协作房间网页", "创建协作网页"),
      result: "1024+768 = 1792",
      artifacts: [],
    });

    expect(validation.accepted).toBe(false);
    expect(validation.reason).toContain("算术结果");
    expect(validation.requiresConcreteOutput).toBe(true);
  });

  it("accepts page-generation results when there is concrete artifact evidence", () => {
    const artifacts: DialogArtifactRecord[] = [
      {
        id: "artifact-1",
        actorId: "specialist",
        path: "/repo/src/pages/DialogRoom.tsx",
        fileName: "DialogRoom.tsx",
        directory: "/repo/src/pages",
        source: "tool_write",
        toolName: "write_file",
        summary: "创建了多 Agent 协作房间页面",
        timestamp: 1500,
        relatedRunId: "run-1",
      },
    ];
    const validation = validateSpawnedTaskResult({
      task: makeTask("请创建一个多 Agent 协作房间网页", "创建协作网页"),
      result: "已创建 /repo/src/pages/DialogRoom.tsx，并完成页面结构与基础样式。",
      artifacts,
    });

    expect(validation.accepted).toBe(true);
    expect(validation.requiresConcreteOutput).toBe(true);
  });

  it("rejects bogus top-level results for concrete artifact tasks", () => {
    const validation = validateActorTaskResult({
      taskText: "参照图片生成网页并保存到 Downloads",
      result: "1+1 = 2",
      actorId: "coordinator",
      startedAt: 1000,
      completedAt: 2000,
      artifacts: [],
    });

    expect(validation.accepted).toBe(false);
    expect(validation.reason).toContain("算术结果");
  });

  it("accepts top-level results when actor actually produced the artifact", () => {
    const validation = validateActorTaskResult({
      taskText: "参照图片生成网页并保存到 Downloads",
      result: "已生成 /Users/demo/Downloads/room.html，并完成基础布局与交互。",
      actorId: "coordinator",
      startedAt: 1000,
      completedAt: 2000,
      artifacts: [
        {
          id: "artifact-2",
          actorId: "coordinator",
          path: "/Users/demo/Downloads/room.html",
          fileName: "room.html",
          directory: "/Users/demo/Downloads",
          source: "tool_write",
          toolName: "write_file",
          summary: "生成网页文件",
          timestamp: 1500,
        },
      ],
    });

    expect(validation.accepted).toBe(true);
    expect(validation.requiresConcreteOutput).toBe(true);
  });

  it("rejects coordination summaries that do not contain real deliverable evidence", () => {
    const validation = validateActorTaskResult({
      taskText: "基于 xlsx 生成完整课程方案并保存到 Downloads",
      result: `一、已确认源文件
文件：/Users/demo/Downloads/AI培训课程需求.xlsx
二、已完成4个分段任务
三、当前缺口
主题 8-14：仅确认完成状态
四、产物位置
历史文档产物：/Users/demo/Downloads/1.docx`,
      actorId: "coordinator",
      startedAt: 1000,
      completedAt: 2000,
      artifacts: [],
    });

    expect(validation.accepted).toBe(false);
    expect(validation.reason).toContain("协作过程总结");
  });

  it("rejects execution-plan style results for spreadsheet deliverables", () => {
    const validation = validateActorTaskResult({
      taskText: "根据课程主题生成课程清单，最终给我一个 Excel 文件",
      result: `执行计划
步骤1：读取并归纳课程需求结构
工具：read_document、memory_search
步骤2：并行拆分主题方向，委派多 Agent 生成候选
工具：spawn_task、wait_for_spawned_tasks
步骤3：主 Agent 接管超时子任务，补齐全部课程清单
输出：/Users/demo/Downloads/课程候选A_主接管.json`,
      actorId: "coordinator",
      startedAt: 1000,
      completedAt: 2000,
      artifacts: [
        {
          id: "artifact-plan-json",
          actorId: "coordinator",
          path: "/Users/demo/Downloads/课程候选A_主接管.json",
          fileName: "课程候选A_主接管.json",
          directory: "/Users/demo/Downloads",
          source: "tool_write",
          toolName: "write_file",
          summary: "主接管中间清单",
          timestamp: 1500,
        },
      ],
    });

    expect(validation.accepted).toBe(false);
    expect(validation.reason).toContain("执行计划");
  });

  it("accepts spreadsheet deliverables when xlsx export evidence exists", () => {
    const steps: AgentStep[] = [
      {
        type: "action",
        content: "调用 export_spreadsheet",
        toolName: "export_spreadsheet",
        toolInput: {
          file_name: "课程清单.xlsx",
          sheets: "[]",
        },
        timestamp: 1000,
      },
      {
        type: "observation",
        content: "Excel 导出完成",
        toolName: "export_spreadsheet",
        toolOutput: "已导出 Excel 文件: /Users/demo/Downloads/课程清单.xlsx",
        timestamp: 1200,
      },
    ];

    const validation = validateActorTaskResult({
      taskText: "根据课程主题生成课程清单，最终给我一个 Excel 文件",
      result: "已导出 Excel 文件: /Users/demo/Downloads/课程清单.xlsx",
      actorId: "coordinator",
      startedAt: 1000,
      completedAt: 2000,
      artifacts: [],
      steps,
    });

    expect(validation.accepted).toBe(true);
  });

  it("rejects memory-confirmation answers for spreadsheet deliverables even when they mention an xlsx path", () => {
    const steps: AgentStep[] = [
      {
        type: "action",
        content: "调用 export_spreadsheet",
        toolName: "export_spreadsheet",
        toolInput: {
          file_name: "课程清单.xlsx",
          sheets: "[]",
        },
        timestamp: 1000,
      },
      {
        type: "observation",
        content: "Excel 导出完成",
        toolName: "export_spreadsheet",
        toolOutput: "已导出 Excel 文件: /Users/demo/Downloads/课程清单.xlsx",
        timestamp: 1200,
      },
    ];

    const validation = validateActorTaskResult({
      taskText: "根据课程主题生成课程清单，最终给我一个 Excel 文件",
      result: "根据记忆检索结果，我确认以下历史信息：目标 Excel 文件存在：/Users/demo/Downloads/课程清单.xlsx",
      actorId: "coordinator",
      startedAt: 1000,
      completedAt: 2000,
      artifacts: [],
      steps,
    });

    expect(validation.accepted).toBe(false);
    expect(validation.reason).toContain("历史产物的确认");
  });

  it("rejects csv-only deliverables when task explicitly requires Excel", () => {
    const validation = validateActorTaskResult({
      taskText: "根据课程主题生成课程清单，最终给我一个 Excel 文件",
      result: "已导出 CSV 文件: /Users/demo/Downloads/课程清单.csv",
      actorId: "coordinator",
      startedAt: 1000,
      completedAt: 2000,
      artifacts: [
        {
          id: "artifact-csv",
          actorId: "coordinator",
          path: "/Users/demo/Downloads/课程清单.csv",
          fileName: "课程清单.csv",
          directory: "/Users/demo/Downloads",
          source: "tool_write",
          toolName: "write_file",
          summary: "导出 CSV 文件",
          timestamp: 1200,
        },
      ],
    });

    expect(validation.accepted).toBe(false);
    expect(validation.reason).toContain("Excel 文件");
  });

  it("rejects incomplete spreadsheet results even when xlsx export evidence exists", () => {
    const steps: AgentStep[] = [
      {
        type: "action",
        content: "调用 export_spreadsheet",
        toolName: "export_spreadsheet",
        toolInput: {
          file_name: "课程清单.xlsx",
          sheets: "[]",
        },
        timestamp: 1000,
      },
      {
        type: "observation",
        content: "Excel 导出完成",
        toolName: "export_spreadsheet",
        toolOutput: "已导出 Excel 文件: /Users/demo/Downloads/课程清单.xlsx",
        timestamp: 1200,
      },
    ];

    const validation = validateActorTaskResult({
      taskText: "根据课程主题生成课程清单，最终给我一个 Excel 文件",
      result: "已导出 Excel 文件: /Users/demo/Downloads/课程清单.xlsx（注意：任务在迭代限制内未能完全完成）",
      actorId: "coordinator",
      startedAt: 1000,
      completedAt: 2000,
      artifacts: [],
      steps,
    });

    expect(validation.accepted).toBe(false);
    expect(validation.reason).toContain("尚未完整完成");
  });

  it("does not force delegated children to export spreadsheets when excel is only an input attachment", () => {
    const validation = validateSpawnedTaskResult({
      task: makeTask("读取Excel附件，围绕课程主题生成课程候选，并在 terminal result 返回课程名称和课程介绍。", "课程候选生成"),
      result: "已生成 20 门课程候选，以下为课程名称和课程介绍。",
      artifacts: [],
    });

    expect(validation.accepted).toBe(true);
    expect(validation.requiresConcreteOutput).toBe(true);
  });

  it("still rejects vague inline terminal-result claims without real content evidence", () => {
    const validation = validateSpawnedTaskResult({
      task: makeTask("读取Excel附件，并在 terminal result 返回课程名称和课程介绍。", "课程候选生成"),
      result: "已经处理好了。",
      artifacts: [],
    });

    expect(validation.accepted).toBe(false);
    expect(validation.reason).toContain("结果过短");
  });

  it("accepts honest blocker replies for spreadsheet delivery tasks", () => {
    const validation = validateActorTaskResult({
      taskText: "导出最终 Excel 文件",
      result: "阻塞原因：export_spreadsheet 当前持续返回参数校验失败，尚未生成 xlsx 文件。",
      actorId: "lead",
      startedAt: 10,
      completedAt: 20,
      artifacts: [],
      steps: [],
    });

    expect(validation).toEqual({
      accepted: true,
      requiresConcreteOutput: true,
    });
  });

  it("rejects spreadsheet success replies that only rely on tool evidence without a concrete path", () => {
    const validation = validateActorTaskResult({
      taskText: "请导出最终 Excel 文件",
      result: "已导出 Excel 文件。",
      actorId: "lead",
      startedAt: 100,
      completedAt: 200,
      artifacts: [],
      steps: [
        {
          type: "observation",
          content: "调用 export_spreadsheet",
          toolName: "export_spreadsheet",
          toolOutput: "已导出 Excel 文件",
          timestamp: 150,
        },
      ],
    });

    expect(validation.accepted).toBe(false);
    expect(validation.reason).toContain("真实文件路径");
  });

  it("rejects schedule success claims without real scheduling tool calls", () => {
    const validation = validateActorTaskResult({
      taskText: "再创建一个任务 每隔两分钟提醒我喝水",
      result: "已创建新的喝水提醒任务，首次提醒 10:27，任务 ID：agt-old-id",
      steps: [],
    });

    expect(validation.accepted).toBe(false);
    expect(validation.reason).toContain("真实工具调用证据");
  });

  it("accepts schedule success claims when schedule_task was actually called", () => {
    const steps: AgentStep[] = [
      {
        type: "action",
        content: "调用 schedule_task",
        toolName: "schedule_task",
        toolInput: {
          target_agent: "邪恶小菠萝",
          task: "提醒用户喝水",
          type: "interval",
          delay_seconds: 120,
        },
        timestamp: 1000,
      },
    ];

    const validation = validateActorTaskResult({
      taskText: "再创建一个任务 每隔两分钟提醒我喝水",
      result: "已创建新的喝水提醒任务，首次提醒 10:27，任务 ID：agt-new-id",
      steps,
    });

    expect(validation.accepted).toBe(true);
  });
});
