import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  invoke: vi.fn(async (command: string) => {
    if (command === "extract_spreadsheet_text") {
      return "## Sheet: Sheet1\n姓名\t部门\nAlice\t培训部\n";
    }
    if (command === "extract_document_text") {
      return "## Slide 1\n培训目标\n";
    }
    if (command === "read_text_file") {
      return "# 培训说明\n- 面向内部讲师\n";
    }
    if (command === "export_document") {
      return {
        path: "/Users/haichao/Downloads/课程方案.docx",
        format: "docx",
        message: "已导出文档到 /Users/haichao/Downloads/课程方案.docx",
      };
    }
    throw new Error(`unexpected command: ${command}`);
  }),
  runShellCommand: vi.fn(async (command: string) => ({
    output: `executed: ${command}`,
    exit_code: 0,
  })),
  writeTextFile: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: hoisted.invoke,
}));

vi.mock("@/core/agent/runtime", () => ({
  agentRuntimeManager: {
    runShellCommand: hoisted.runShellCommand,
    writeTextFile: hoisted.writeTextFile,
  },
}));

import { createBuiltinAgentTools } from "./default-tools";

describe("default-tools read_document", () => {
  it("routes xlsx files to spreadsheet extraction", async () => {
    const { tools } = createBuiltinAgentTools(async () => true);
    const tool = tools.find((item) => item.name === "read_document");

    expect(tool).toBeTruthy();

    const result = await tool!.execute({
      path: "/Users/haichao/Downloads/AI培训课程需求.xlsx",
      max_rows: 20,
    });

    expect(result).toContain("Sheet1");
    expect(hoisted.invoke).toHaveBeenCalledWith("extract_spreadsheet_text", {
      filePath: "/Users/haichao/Downloads/AI培训课程需求.xlsx",
      maxRows: 20,
    });
  });

  it("routes markdown documents to text reading", async () => {
    const { tools } = createBuiltinAgentTools(async () => true);
    const tool = tools.find((item) => item.name === "read_document");

    const result = await tool!.execute({
      path: "/Users/haichao/Downloads/培训说明.md",
    });

    expect(result).toContain("培训说明");
    expect(hoisted.invoke).toHaveBeenCalledWith("read_text_file", {
      path: "/Users/haichao/Downloads/培训说明.md",
    });
  });

  it("routes pdf documents to document extraction", async () => {
    const { tools } = createBuiltinAgentTools(async () => true);
    const tool = tools.find((item) => item.name === "read_document");

    const result = await tool!.execute({
      path: "/Users/haichao/Downloads/培训介绍.pdf",
    });

    expect(result).toContain("Slide 1");
    expect(hoisted.invoke).toHaveBeenCalledWith("extract_document_text", {
      path: "/Users/haichao/Downloads/培训介绍.pdf",
    });
  });

  it("blocks shell-based reads of office documents and redirects to read_document", async () => {
    const { tools } = createBuiltinAgentTools(async () => true);
    const tool = tools.find((item) => item.name === "run_shell_command");

    const result = await tool!.execute({
      command: "wc -l /Users/haichao/Downloads/AI培训课程需求.xlsx",
    });

    expect(result).toMatchObject({
      error: expect.stringContaining("正在直接读取文档/Office 文件"),
      hint: expect.stringContaining("请改用 read_document"),
    });
    expect(hoisted.runShellCommand).not.toHaveBeenCalled();
  });

  it("exports docx documents via export_document", async () => {
    const { tools } = createBuiltinAgentTools(async () => true);
    const tool = tools.find((item) => item.name === "export_document");

    const result = await tool!.execute({
      path: "/Users/haichao/Downloads/课程方案.docx",
      content: "# 培训课程方案\n\n- 目标：完成课程设计",
      title: "课程方案",
    });

    expect(result).toMatchObject({
      path: "/Users/haichao/Downloads/课程方案.docx",
      format: "docx",
    });
    expect(hoisted.invoke).toHaveBeenCalledWith("export_document", {
      outputPath: "/Users/haichao/Downloads/课程方案.docx",
      content: "# 培训课程方案\n\n- 目标：完成课程设计",
      title: "课程方案",
    });
  });

  it("blocks write_file from pretending to create word-compatible files", async () => {
    const { tools } = createBuiltinAgentTools(async () => true);
    const tool = tools.find((item) => item.name === "write_file");

    const result = await tool!.execute({
      path: "/Users/haichao/Downloads/课程方案.rtf",
      content: "{\\\\rtf1 fake}",
    });

    expect(result).toMatchObject({
      error: expect.stringContaining("不能读取或编辑二进制文件 (.rtf)"),
      hint: expect.stringContaining("export_document"),
    });
    expect(hoisted.writeTextFile).not.toHaveBeenCalled();
  });
});
