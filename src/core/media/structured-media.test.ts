import { describe, expect, it } from "vitest";

import { mergeStructuredMedia } from "./structured-media";

describe("mergeStructuredMedia", () => {
  it("extracts bare local image paths from assistant text", () => {
    const result = mergeStructuredMedia({
      text: "已从 Downloads 选择并发送图片 /Users/haichao/Downloads/demo.png",
    });

    expect(result.text).toBe("已从 Downloads 选择并发送图片 /Users/haichao/Downloads/demo.png");
    expect(result.images).toEqual(["/Users/haichao/Downloads/demo.png"]);
  });

  it("extracts quoted local attachments with spaces from assistant text", () => {
    const result = mergeStructuredMedia({
      text: "导出完成，文件在 \"/Users/haichao/Downloads/My Report Final.pdf\"",
    });

    expect(result.attachments).toEqual([
      {
        path: "/Users/haichao/Downloads/My Report Final.pdf",
        fileName: "My Report Final.pdf",
      },
    ]);
  });

  it("ignores code fence paths when inferring loose media refs", () => {
    const result = mergeStructuredMedia({
      text: [
        "结果如下：",
        "```bash",
        "echo /Users/haichao/Downloads/demo.png",
        "```",
      ].join("\n"),
    });

    expect(result.images).toBeUndefined();
    expect(result.attachments).toBeUndefined();
  });
});
