import { describe, expect, it } from "vitest";

import {
  buildDynamicWorkbook,
  deriveWorkbookFileName,
  extractStructuredJsonCandidate,
  inferColumnsFromRows,
  extractNormalizedStructuredRows,
  validateWorkbookCompleteness,
} from "./dynamic-workbook-builder";
import type { DialogStructuredSubtaskResult } from "./dialog-subtask-runtime";

function makeStructuredResult(params: {
  runId: string;
  label: string;
  task: string;
  deliveryTargetLabel?: string;
  terminalResult: string;
}): DialogStructuredSubtaskResult {
  return {
    runId: params.runId,
    subtaskId: params.runId,
    targetActorId: `${params.runId}-actor`,
    targetActorName: params.label,
    deliveryTargetLabel: params.deliveryTargetLabel,
    label: params.label,
    task: params.task,
    mode: "run",
    roleBoundary: "executor",
    profile: "executor",
    executionIntent: "content_executor",
    status: "completed",
    terminalResult: params.terminalResult,
    startedAt: 1,
    completedAt: 2,
    timeoutSeconds: 600,
    eventCount: 2,
    resultKind: "structured_rows",
  };
}

describe("dynamic-workbook-builder", () => {
  it("infers columns by frequency and order", () => {
    expect(inferColumnsFromRows([
      { 标题: "A", 摘要: "B" },
      { 标题: "C", 标签: "D" },
      { 标题: "E", 摘要: "F" },
    ])).toEqual(["标题", "摘要", "标签"]);
  });

  it("merges structured child rows into a dynamic workbook", () => {
    const workbook = buildDynamicWorkbook({
      taskText: "根据 /Users/demo/Downloads/source.xlsx 生成结果并导出 Excel",
      structuredResults: [
        makeStructuredResult({
          runId: "run-1",
          label: "结果清单生成（第1组）",
          task: "处理前 2 个条目",
          deliveryTargetLabel: "结果清单",
          terminalResult: JSON.stringify([
            { sourceItemId: "source-item-1", topicIndex: 1, topicTitle: "主题A", coverageType: "direct", 课程名称: "课程A", 课程介绍: "介绍A" },
            { sourceItemId: "source-item-2", topicIndex: 2, topicTitle: "主题B", coverageType: "direct", 课程名称: "课程B", 课程介绍: "介绍B" },
          ]),
        }),
        makeStructuredResult({
          runId: "run-2",
          label: "结果清单生成（第2组）",
          task: "处理后 2 个条目",
          deliveryTargetLabel: "结果清单",
          terminalResult: JSON.stringify([
            { sourceItemId: "source-item-2", topicIndex: 2, topicTitle: "主题B", coverageType: "direct", 课程名称: "课程B", 课程介绍: "介绍B" },
            { sourceItemId: "source-item-3", topicIndex: 3, topicTitle: "主题C", coverageType: "direct", 课程名称: "课程C", 课程介绍: "介绍C" },
          ]),
        }),
      ],
    });

    expect("blocker" in workbook).toBe(false);
    if ("blocker" in workbook) return;
    expect(workbook.fileName).toBe("source.xlsx");
    expect(workbook.sheets).toHaveLength(1);
    expect(workbook.totalRowCount).toBe(3);
    expect(workbook.duplicateRowCount).toBe(1);
    expect(workbook.coverageSourceItemIds).toEqual(["source-item-1", "source-item-2", "source-item-3"]);
    expect(workbook.directCoverageSourceItemIds).toEqual(["source-item-1", "source-item-2", "source-item-3"]);
  });

  it("does not deduplicate away two different topics that share the same course text", () => {
    const workbook = buildDynamicWorkbook({
      taskText: "根据 /Users/demo/Downloads/source.xlsx 生成结果并导出 Excel",
      structuredResults: [
        makeStructuredResult({
          runId: "run-1",
          label: "结果清单生成（第1组）",
          task: "处理前 1 个条目",
          deliveryTargetLabel: "结果清单",
          terminalResult: JSON.stringify([
            { sourceItemId: "source-item-1", topicIndex: 1, topicTitle: "主题A", coverageType: "direct", 课程名称: "通用课程", 课程介绍: "同一介绍" },
          ]),
        }),
        makeStructuredResult({
          runId: "run-2",
          label: "结果清单生成（第2组）",
          task: "处理后 1 个条目",
          deliveryTargetLabel: "结果清单",
          terminalResult: JSON.stringify([
            { sourceItemId: "source-item-2", topicIndex: 2, topicTitle: "主题B", coverageType: "direct", 课程名称: "通用课程", 课程介绍: "同一介绍" },
          ]),
        }),
      ],
    });

    expect("blocker" in workbook).toBe(false);
    if ("blocker" in workbook) return;
    expect(workbook.totalRowCount).toBe(2);
    expect(workbook.duplicateRowCount).toBe(0);
    expect(workbook.rowCoverage).toEqual([
      expect.objectContaining({ sourceItemIds: ["source-item-1"], topicIndexes: [1] }),
      expect.objectContaining({ sourceItemIds: ["source-item-2"], topicIndexes: [2] }),
    ]);
  });

  it("maps camelCase course fields onto the requested chinese schema", () => {
    const result = makeStructuredResult({
      runId: "run-alias",
      label: "结果清单生成（别名）",
      task: "处理别名字段",
      deliveryTargetLabel: "结果清单",
      terminalResult: JSON.stringify([
        {
          sourceItemId: "source-item-1",
          topicIndex: 1,
          topicTitle: "主题A",
          coverageType: "direct",
          courseName: "课程A",
          courseIntro: "介绍A",
        },
      ]),
    });

    expect(extractNormalizedStructuredRows({
      result,
      resultSchema: {
        fields: [
          { label: "课程名称" },
          { label: "课程介绍" },
        ],
      },
    })).toEqual([
      {
        "课程名称": "课程A",
        "课程介绍": "介绍A",
      },
    ]);
  });

  it("extracts balanced structured json even when wrapped by extra text", () => {
    const wrapped = [
      "已完成本组课程生成，结构化结果如下：",
      "[",
      "{\"courseName\":\"课程A\",\"courseIntro\":\"介绍A\"}",
      "]",
      "请父 Agent 继续汇总。",
    ].join("\n");

    expect(extractStructuredJsonCandidate(wrapped)).toBe(
      "[\n{\"courseName\":\"课程A\",\"courseIntro\":\"介绍A\"}\n]",
    );
    expect(extractNormalizedStructuredRows({
      result: makeStructuredResult({
        runId: "run-wrapped",
        label: "结果清单生成（包装）",
        task: "处理包装 JSON",
        deliveryTargetLabel: "结果清单",
        terminalResult: wrapped,
      }),
      resultSchema: {
        fields: [
          { label: "课程名称" },
          { label: "课程介绍" },
        ],
      },
    })).toEqual([
      {
        "课程名称": "课程A",
        "课程介绍": "介绍A",
      },
    ]);
  });

  it("validates minimum row coverage", () => {
    const blocker = validateWorkbookCompleteness({
      workbookPlan: {
        fileName: "导出结果.xlsx",
        sheets: [
          { name: "结果清单", headers: ["标题"], rows: [["A"]] },
        ],
        totalRowCount: 1,
        sourceRowCount: 1,
        duplicateRowCount: 0,
        sheetRowCounts: { 结果清单: 1 },
        coverageSourceItemIds: ["source-item-1"],
        directCoverageSourceItemIds: ["source-item-1"],
        coverageTopicIndexes: [1],
        unmappedRowCount: 0,
        rowCoverage: [],
      },
      expectedMinRows: 2,
    });

    expect(blocker).toContain("expected_min_rows=2");
    expect(deriveWorkbookFileName("请导出表格")).toBe("导出结果.xlsx");
  });
});
