import { describe, expect, it } from "vitest";

import { validateStructuredSpreadsheetQuality } from "./delivery-quality-gate";
import type { StructuredDeliveryManifest } from "./structured-delivery-strategy";

describe("delivery-quality-gate", () => {
  it("blocks export when produced rows do not cover grounded source items", () => {
    const manifest: StructuredDeliveryManifest = {
      source: "strategy",
      strategyId: "dynamic_spreadsheet",
      deliveryContract: "spreadsheet",
      parentContract: "single_workbook",
      requiresSpreadsheetOutput: true,
      applyInitialIsolation: true,
      sourceSnapshot: {
        sourcePaths: ["/Users/demo/Downloads/source.xlsx"],
        sections: [],
        items: [
          { id: "source-item-1", label: "主题1", raw: "1. 主题1", order: 1, topicIndex: 1, topicTitle: "主题1" },
          { id: "source-item-2", label: "主题2", raw: "2. 主题2", order: 2, topicIndex: 2, topicTitle: "主题2" },
          { id: "source-item-3", label: "主题3", raw: "3. 主题3", order: 3, topicIndex: 3, topicTitle: "主题3" },
        ],
        expectedItemCount: 3,
        workbookBaseName: "source",
        warnings: [],
      },
      targets: [
        {
          id: "sheet-main-batch-1",
          label: "结果清单",
          metadata: { sourceItemCount: 3, sourceItemIds: ["source-item-1", "source-item-2", "source-item-3"] },
        },
      ],
      exportSpec: {
        mode: "single_workbook",
        format: "spreadsheet",
        targetLabels: ["结果清单"],
      },
    };

    const blocker = validateStructuredSpreadsheetQuality({
      manifest,
      workbookPlan: {
        fileName: "导出结果.xlsx",
        sheets: [
          {
            name: "结果清单",
            headers: ["课程名称", "课程介绍"],
            rows: [["课程A", "介绍A"], ["课程B", "介绍B"]],
          },
        ],
        totalRowCount: 2,
        sourceRowCount: 2,
        duplicateRowCount: 0,
        sheetRowCounts: { 结果清单: 2 },
        coverageSourceItemIds: ["source-item-1", "source-item-2"],
        directCoverageSourceItemIds: ["source-item-1", "source-item-2"],
        coverageTopicIndexes: [1, 2],
        unmappedRowCount: 0,
        rowCoverage: [],
      },
    });

    expect(blocker).toContain("missing_source_item_count=1");
    expect(blocker).toContain("missing_topics=3.主题3");
    expect(blocker).toContain("missing_themes=主题3");
  });

  it("blocks export when rows are not explicitly mapped to source topics", () => {
    const manifest: StructuredDeliveryManifest = {
      source: "strategy",
      strategyId: "dynamic_spreadsheet",
      deliveryContract: "spreadsheet",
      parentContract: "single_workbook",
      requiresSpreadsheetOutput: true,
      applyInitialIsolation: true,
      targets: [
        {
          id: "sheet-main-batch-1",
          label: "结果清单",
          metadata: { sourceItemCount: 1, sourceItemIds: ["source-item-1"] },
        },
      ],
      exportSpec: {
        mode: "single_workbook",
        format: "spreadsheet",
        targetLabels: ["结果清单"],
      },
    };

    const blocker = validateStructuredSpreadsheetQuality({
      manifest,
      workbookPlan: {
        fileName: "导出结果.xlsx",
        sheets: [
          {
            name: "结果清单",
            headers: ["课程名称", "课程介绍"],
            rows: [["课程A", "介绍A"]],
          },
        ],
        totalRowCount: 1,
        sourceRowCount: 1,
        duplicateRowCount: 0,
        sheetRowCounts: { 结果清单: 1 },
        coverageSourceItemIds: [],
        directCoverageSourceItemIds: [],
        coverageTopicIndexes: [],
        unmappedRowCount: 1,
        rowCoverage: [],
      },
    });

    expect(blocker).toContain("unmapped_row_count=1");
  });

  it("allows export when grounded rows drift above the explicit topic count but structured coverage reaches the requested baseline", () => {
    const manifest: StructuredDeliveryManifest = {
      source: "strategy",
      strategyId: "dynamic_spreadsheet",
      deliveryContract: "spreadsheet",
      parentContract: "single_workbook",
      requiresSpreadsheetOutput: true,
      applyInitialIsolation: true,
      sourceSnapshot: {
        sourcePaths: ["/Users/demo/Downloads/source.xlsx"],
        sections: [],
        items: [
          { id: "source-item-1", label: "主题1-重复A", raw: "row-1", order: 1, topicIndex: 1, topicTitle: "主题1" },
          { id: "source-item-2", label: "主题1-重复B", raw: "row-2", order: 2, topicIndex: 2, topicTitle: "主题1" },
          { id: "source-item-3", label: "主题2-重复A", raw: "row-3", order: 3, topicIndex: 3, topicTitle: "主题2" },
          { id: "source-item-4", label: "主题2-重复B", raw: "row-4", order: 4, topicIndex: 4, topicTitle: "主题2" },
        ],
        expectedItemCount: 2,
        workbookBaseName: "source",
        warnings: ["expected_item_count=2 but grounded_items=4"],
      },
      targets: [
        {
          id: "sheet-main-batch-1",
          label: "结果清单",
          metadata: { sourceItemCount: 4, sourceItemIds: ["source-item-1", "source-item-2", "source-item-3", "source-item-4"] },
        },
      ],
      exportSpec: {
        mode: "single_workbook",
        format: "spreadsheet",
        targetLabels: ["结果清单"],
      },
    };

    const blocker = validateStructuredSpreadsheetQuality({
      manifest,
      workbookPlan: {
        fileName: "导出结果.xlsx",
        sheets: [
          {
            name: "结果清单",
            headers: ["课程名称", "课程介绍"],
            rows: [["课程A", "介绍A"], ["课程B", "介绍B"]],
          },
        ],
        totalRowCount: 2,
        sourceRowCount: 2,
        duplicateRowCount: 0,
        sheetRowCounts: { 结果清单: 2 },
        coverageSourceItemIds: ["source-item-1", "source-item-3"],
        directCoverageSourceItemIds: ["source-item-1", "source-item-3"],
        coverageTopicIndexes: [1, 2],
        unmappedRowCount: 0,
        rowCoverage: [],
      },
    });

    expect(blocker).toBeNull();
  });

  it("blocks export when grounding drift is satisfied numerically but direct theme coverage still misses a real theme", () => {
    const manifest: StructuredDeliveryManifest = {
      source: "strategy",
      strategyId: "dynamic_spreadsheet",
      deliveryContract: "spreadsheet",
      parentContract: "single_workbook",
      requiresSpreadsheetOutput: true,
      applyInitialIsolation: true,
      sourceSnapshot: {
        sourcePaths: ["/Users/demo/Downloads/source.xlsx"],
        sections: [],
        items: [
          { id: "source-item-1", label: "主题1-重复A", raw: "row-1", order: 1, topicIndex: 1, topicTitle: "主题1" },
          { id: "source-item-2", label: "主题1-重复B", raw: "row-2", order: 2, topicIndex: 2, topicTitle: "主题1" },
          { id: "source-item-3", label: "主题2-重复A", raw: "row-3", order: 3, topicIndex: 3, topicTitle: "主题2" },
          { id: "source-item-4", label: "主题2-重复B", raw: "row-4", order: 4, topicIndex: 4, topicTitle: "主题2" },
        ],
        expectedItemCount: 2,
        workbookBaseName: "source",
        warnings: ["expected_item_count=2 but grounded_items=4"],
      },
      targets: [
        {
          id: "sheet-main-batch-1",
          label: "结果清单",
          metadata: { sourceItemCount: 4, sourceItemIds: ["source-item-1", "source-item-2", "source-item-3", "source-item-4"] },
        },
      ],
      exportSpec: {
        mode: "single_workbook",
        format: "spreadsheet",
        targetLabels: ["结果清单"],
      },
    };

    const blocker = validateStructuredSpreadsheetQuality({
      manifest,
      workbookPlan: {
        fileName: "导出结果.xlsx",
        sheets: [
          {
            name: "结果清单",
            headers: ["课程名称", "课程介绍"],
            rows: [["课程A", "介绍A"], ["课程A2", "介绍A2"]],
          },
        ],
        totalRowCount: 2,
        sourceRowCount: 2,
        duplicateRowCount: 0,
        sheetRowCounts: { 结果清单: 2 },
        coverageSourceItemIds: ["source-item-1", "source-item-2"],
        directCoverageSourceItemIds: ["source-item-1", "source-item-2"],
        coverageTopicIndexes: [1, 2],
        unmappedRowCount: 0,
        rowCoverage: [
          { sheetName: "结果清单", rowIndex: 0, sourceItemIds: ["source-item-1"], topicIndexes: [1], coverageType: "direct" },
          { sheetName: "结果清单", rowIndex: 1, sourceItemIds: ["source-item-2"], topicIndexes: [2], coverageType: "direct" },
        ],
      },
    });

    expect(blocker).toContain("grounding_drift=true");
    expect(blocker).toContain("expected_theme_count=2");
    expect(blocker).toContain("direct_covered_theme_count=1");
    expect(blocker).toContain("missing_theme_count=1");
    expect(blocker).toContain("missing_themes=主题2");
  });

  it("blocks export when a single row binds multiple source topics", () => {
    const manifest: StructuredDeliveryManifest = {
      source: "strategy",
      strategyId: "dynamic_spreadsheet",
      deliveryContract: "spreadsheet",
      parentContract: "single_workbook",
      requiresSpreadsheetOutput: true,
      applyInitialIsolation: true,
      sourceSnapshot: {
        sourcePaths: ["/Users/demo/Downloads/source.xlsx"],
        sections: [],
        items: [
          { id: "source-item-1", label: "主题1", raw: "1. 主题1", order: 1, topicIndex: 1, topicTitle: "主题1" },
          { id: "source-item-2", label: "主题2", raw: "2. 主题2", order: 2, topicIndex: 2, topicTitle: "主题2" },
        ],
        expectedItemCount: 2,
        workbookBaseName: "source",
        warnings: [],
      },
      targets: [
        {
          id: "sheet-main-batch-1",
          label: "结果清单",
          metadata: { sourceItemCount: 2, sourceItemIds: ["source-item-1", "source-item-2"] },
        },
      ],
      exportSpec: {
        mode: "single_workbook",
        format: "spreadsheet",
        targetLabels: ["结果清单"],
      },
    };

    const blocker = validateStructuredSpreadsheetQuality({
      manifest,
      workbookPlan: {
        fileName: "导出结果.xlsx",
        sheets: [
          {
            name: "结果清单",
            headers: ["课程名称", "课程介绍"],
            rows: [["课程A", "介绍A"], ["课程B", "介绍B"]],
          },
        ],
        totalRowCount: 2,
        sourceRowCount: 2,
        duplicateRowCount: 0,
        sheetRowCounts: { 结果清单: 2 },
        coverageSourceItemIds: ["source-item-1", "source-item-2"],
        directCoverageSourceItemIds: ["source-item-2"],
        coverageTopicIndexes: [1, 2],
        unmappedRowCount: 0,
        rowCoverage: [
          { sheetName: "结果清单", rowIndex: 0, sourceItemIds: ["source-item-1", "source-item-2"], topicIndexes: [1, 2], coverageType: "direct" },
          { sheetName: "结果清单", rowIndex: 1, sourceItemIds: ["source-item-2"], topicIndexes: [2], coverageType: "direct" },
        ],
      },
    });

    expect(blocker).toContain("单行绑定多个主题/sourceItemId");
    expect(blocker).toContain("multi_topic_row_count=1");
  });
});
