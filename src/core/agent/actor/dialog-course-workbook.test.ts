import { describe, expect, it } from "vitest";
import {
  buildDeterministicCourseShardPlan,
  buildDeterministicCourseWorkbook,
  buildDeterministicCourseWorkbookReply,
  DETERMINISTIC_COURSE_WORKBOOK_SHEET_NAMES,
  extractDeterministicCourseThemes,
} from "./dialog-course-workbook";
import type { DialogStructuredSubtaskResult } from "./dialog-subtask-runtime";

function makeStructuredResult(params: {
  runId: string;
  label: string;
  task: string;
  terminalResult: string;
  deliveryTargetLabel?: string;
  sheetName?: string;
}): DialogStructuredSubtaskResult {
  return {
    runId: params.runId,
    subtaskId: params.runId,
    targetActorId: `${params.runId}-actor`,
    targetActorName: params.label,
    deliveryTargetLabel: params.deliveryTargetLabel,
    sheetName: params.sheetName,
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
    eventCount: 3,
    resultKind: "structured_rows",
  };
}

describe("dialog-course-workbook", () => {
  it("extracts numbered themes and builds a fixed three-shard plan", () => {
    const query = [
      "根据课程主题生成课程清单，最终给我一个 Excel 文件。",
      "1. AI应用开发工程化实战",
      "2. 智能体开发与知识库落地",
      "3. 大模型安全治理与测试",
      "4. AI产品需求转化与方案设计",
      "5. AI产品运营增长与商业闭环",
      "6. 银行AI解决方案咨询方法论",
      "7. 数据分析与经营洞察实战",
      "8. 全员AI办公赋能与协同提效",
      "9. AI通识与智能素养提升",
    ].join("\n");

    const themes = extractDeterministicCourseThemes(query);
    expect(themes).toHaveLength(9);

    const plan = buildDeterministicCourseShardPlan(query);
    expect(plan).not.toBeNull();
    expect(plan?.shards).toHaveLength(3);
    expect(plan?.shards.map((shard) => shard.sheetName)).toEqual(DETERMINISTIC_COURSE_WORKBOOK_SHEET_NAMES);
    expect(plan?.shards[0]?.task).toContain("技术方向课程");
    expect(plan?.shards[1]?.task).toContain("产品运营方向课程");
    expect(plan?.shards[2]?.task).toContain("数据与通识方向课程");
  });

  it("merges structured child rows into a single deterministic workbook", () => {
    const workbook = buildDeterministicCourseWorkbook({
      taskText: "根据 /Users/demo/Downloads/AI培训课程需求.xlsx 生成课程并导出 Excel",
      structuredResults: [
        makeStructuredResult({
          runId: "run-tech-a",
          label: "AI应用开发方向课程生成",
          task: "为技术方向整理课程",
          sheetName: "技术方向课程",
          terminalResult: JSON.stringify([
            { 课程名称: "大模型应用开发精讲", 课程介绍: "覆盖 Prompt、RAG 与部署落地。" },
          ]),
        }),
        makeStructuredResult({
          runId: "run-tech-b",
          label: "AI模型算法工程化方向课程生成",
          task: "为技术方向整理课程",
          sheetName: "技术方向课程",
          terminalResult: JSON.stringify([
            { 课程名称: "模型评测与安全验证", 课程介绍: "覆盖评测、红队与安全治理。" },
          ]),
        }),
        makeStructuredResult({
          runId: "run-product-a",
          label: "AI应用解决方案方向课程生成",
          task: "为产品运营方向整理课程",
          sheetName: "产品运营方向课程",
          terminalResult: JSON.stringify([
            { 课程名称: "AI产品方案设计工作坊", 课程介绍: "覆盖需求转化与方案包装。" },
          ]),
        }),
        makeStructuredResult({
          runId: "run-product-b",
          label: "AI应用运营方向课程生成",
          task: "为产品运营方向整理课程",
          sheetName: "产品运营方向课程",
          terminalResult: JSON.stringify([
            { 课程名称: "AI运营增长闭环", 课程介绍: "覆盖增长、运营与价值验证。" },
          ]),
        }),
        makeStructuredResult({
          runId: "run-data",
          label: "AI数据能力提升与全员赋能课程生成",
          task: "为数据与通识方向整理课程",
          sheetName: "数据与通识方向课程",
          terminalResult: JSON.stringify([
            { 课程名称: "数据洞察与经营分析", 课程介绍: "覆盖数据分析、经营洞察与决策支持。" },
          ]),
        }),
      ],
    });

    expect("blocker" in workbook).toBe(false);
    if ("blocker" in workbook) return;
    expect(workbook.fileName).toBe("AI培训课程体系.xlsx");
    expect(workbook.sheets).toHaveLength(3);
    expect(workbook.sheetRowCounts["技术方向课程"]).toBe(2);
    expect(workbook.sheetRowCounts["产品运营方向课程"]).toBe(2);
    expect(workbook.sheetRowCounts["数据与通识方向课程"]).toBe(1);
    expect(workbook.totalRowCount).toBe(5);

    const reply = buildDeterministicCourseWorkbookReply({
      exportPath: "/Users/demo/Downloads/AI培训课程体系.xlsx",
      workbookPlan: workbook,
      structuredTaskCount: 5,
    });
    expect(reply).toContain("已导出 Excel 文件：/Users/demo/Downloads/AI培训课程体系.xlsx");
    expect(reply).toContain("技术方向课程：2门");
  });

  it("prefers explicit sheet metadata when task text is ambiguous", () => {
    const workbook = buildDeterministicCourseWorkbook({
      taskText: "生成课程并导出 Excel",
      structuredResults: [
        makeStructuredResult({
          runId: "run-tech",
          label: "课程生成",
          task: "围绕业务需求、数据分析与产品方案整理课程，最终归入技术方向。",
          deliveryTargetLabel: "技术方向课程",
          terminalResult: JSON.stringify([
            { 课程名称: "智能体工程化开发实战", 课程介绍: "覆盖开发、评测与部署。" },
          ]),
        }),
        makeStructuredResult({
          runId: "run-product",
          label: "课程生成",
          task: "围绕业务需求、数据分析与产品方案整理课程，最终归入产品运营方向。",
          deliveryTargetLabel: "产品运营方向课程",
          terminalResult: JSON.stringify([
            { 课程名称: "AI需求转化与方案设计", 课程介绍: "覆盖需求澄清与方案包装。" },
          ]),
        }),
        makeStructuredResult({
          runId: "run-data",
          label: "课程生成",
          task: "围绕业务需求、数据分析与产品方案整理课程，最终归入数据与通识方向。",
          deliveryTargetLabel: "数据与通识方向课程",
          terminalResult: JSON.stringify([
            { 课程名称: "数据分析与经营洞察", 课程介绍: "覆盖经营分析与数据素养。" },
          ]),
        }),
      ],
    });

    expect("blocker" in workbook).toBe(false);
    if ("blocker" in workbook) return;
    expect(workbook.sheetRowCounts["技术方向课程"]).toBe(1);
    expect(workbook.sheetRowCounts["产品运营方向课程"]).toBe(1);
    expect(workbook.sheetRowCounts["数据与通识方向课程"]).toBe(1);
  });

  it("returns a blocker when any fixed sheet is missing", () => {
    const workbook = buildDeterministicCourseWorkbook({
      taskText: "生成课程并导出 Excel",
      structuredResults: [
        makeStructuredResult({
          runId: "run-tech-only",
          label: "AI应用开发方向课程生成",
          task: "为技术方向整理课程",
          sheetName: "技术方向课程",
          terminalResult: JSON.stringify([
            { 课程名称: "大模型应用开发精讲", 课程介绍: "覆盖 Prompt、RAG 与部署落地。" },
          ]),
        }),
      ],
    });

    expect(workbook).toEqual({
      blocker: "结构化结果未能覆盖固定工作簿要求，缺少 sheet：产品运营方向课程、数据与通识方向课程。",
    });
  });
});
