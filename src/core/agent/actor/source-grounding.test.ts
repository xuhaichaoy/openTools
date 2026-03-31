import { describe, expect, it } from "vitest";

import {
  buildSourceGroundingSnapshot,
  inferRequestedOutputSchema,
} from "./source-grounding";

describe("source-grounding", () => {
  it("extracts source paths, items, and explicit counts from embedded file content", () => {
    const snapshot = buildSourceGroundingSnapshot([
      "## 🗂️ 工作上下文 - 项目路径: `/Users/demo/Downloads/source.xlsx`",
      "以下是用户提供的文件内容（路径均为绝对路径），请根据用户指令进行处理。",
      "### 文件 /Users/demo/Downloads/source.xlsx",
      "课程主题",
      "1. AI 应用开发工程化实战",
      "2. 智能体知识库落地",
      "3. 安全治理与评测",
      "用户要求：根据这 3 个课程主题生成结果，字段只有课程名称和课程介绍，最终给我一个 Excel 文件。",
    ].join("\n"));

    expect(snapshot.sourcePaths).toEqual(["/Users/demo/Downloads/source.xlsx"]);
    expect(snapshot.expectedItemCount).toBe(3);
    expect(snapshot.items).toHaveLength(3);
    expect(snapshot.items.map((item) => item.label)).toEqual([
      "AI 应用开发工程化实战",
      "智能体知识库落地",
      "安全治理与评测",
    ]);
    expect(snapshot.workbookBaseName).toBe("source");
  });

  it("infers requested output schema from field instructions", () => {
    const schema = inferRequestedOutputSchema("需要提供的字段只有课程名称和课程介绍，最终导出 Excel。");

    expect(schema?.fields.map((field) => field.label)).toEqual(["课程名称", "课程介绍"]);
  });

  it("extracts tabular spreadsheet rows into grounded items", () => {
    const snapshot = buildSourceGroundingSnapshot([
      "### 文件 /Users/demo/Downloads/data.xlsx",
      "## Sheet: Sheet1",
      "主题\t培训目标\t培训对象",
      "AI 应用开发\t完成应用落地\t技术团队",
      "AI 运营增长\t提升增长效率\t运营团队",
    ].join("\n"));

    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items[0]?.label).toBe("AI 应用开发");
    expect(snapshot.items[0]?.topicIndex).toBe(1);
    expect(snapshot.items[0]?.topicTitle).toBe("AI 应用开发");
    expect(snapshot.items[0]?.trainingTarget).toBe("完成应用落地");
    expect(snapshot.items[1]?.trainingAudience).toBe("运营团队");
  });
});
