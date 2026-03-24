import { describe, expect, it } from "vitest";

import { splitStructuredIMMediaReply } from "./im-media-delivery";

describe("splitStructuredIMMediaReply", () => {
  it("extracts openclaw-style MEDIA lines and strips them from visible text", () => {
    expect(splitStructuredIMMediaReply([
      "已完成，见截图。",
      "MEDIA:/Users/haichao/Downloads/baidu-homepage.png",
    ].join("\n"))).toEqual({
      text: "已完成，见截图。",
      mediaUrl: "/Users/haichao/Downloads/baidu-homepage.png",
      mediaUrls: ["/Users/haichao/Downloads/baidu-homepage.png"],
      images: ["/Users/haichao/Downloads/baidu-homepage.png"],
    });
  });

  it("supports quoted paths with spaces", () => {
    expect(splitStructuredIMMediaReply([
      "海报已生成。",
      "MEDIA:\"/Users/haichao/Desktop/My Poster Final.png\"",
    ].join("\n"))).toEqual({
      text: "海报已生成。",
      mediaUrl: "/Users/haichao/Desktop/My Poster Final.png",
      mediaUrls: ["/Users/haichao/Desktop/My Poster Final.png"],
      images: ["/Users/haichao/Desktop/My Poster Final.png"],
    });
  });

  it("supports multiple MEDIA lines for mixed image and file delivery", () => {
    expect(splitStructuredIMMediaReply([
      "已完成，附件如下。",
      "MEDIA:/tmp/weather.png",
      "MEDIA:https://example.com/report.pdf",
    ].join("\n"))).toEqual({
      text: "已完成，附件如下。",
      mediaUrl: "/tmp/weather.png",
      mediaUrls: ["/tmp/weather.png", "https://example.com/report.pdf"],
      images: ["/tmp/weather.png"],
      attachments: [{ path: "https://example.com/report.pdf", fileName: "report.pdf" }],
    });
  });

  it("ignores MEDIA tokens inside fenced code blocks", () => {
    expect(splitStructuredIMMediaReply([
      "下面是示例命令：",
      "```bash",
      "echo 'MEDIA:/tmp/debug.png'",
      "```",
    ].join("\n"))).toEqual({
      text: [
        "下面是示例命令：",
        "```bash",
        "echo 'MEDIA:/tmp/debug.png'",
        "```",
      ].join("\n"),
    });
  });

  it("does not treat raw absolute paths as outbound media without MEDIA directives", () => {
    expect(splitStructuredIMMediaReply(
      "已完成，文件路径：/Users/haichao/Downloads/baidu-homepage.png",
    )).toEqual({
      text: "已完成，文件路径：/Users/haichao/Downloads/baidu-homepage.png",
    });
  });
});
