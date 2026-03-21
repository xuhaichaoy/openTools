import { describe, expect, it } from "vitest";

import {
  deriveShareableIMMediaFromText,
  sanitizeIMReplyTextForMedia,
  shouldExplicitlyDeliverMediaToIM,
} from "./im-media-delivery";

describe("shouldExplicitlyDeliverMediaToIM", () => {
  it("returns true for explicit send requests", () => {
    expect(shouldExplicitlyDeliverMediaToIM("发给我")).toBe(true);
    expect(shouldExplicitlyDeliverMediaToIM("把截图发我")).toBe(true);
    expect(shouldExplicitlyDeliverMediaToIM("把文件传给我")).toBe(true);
    expect(shouldExplicitlyDeliverMediaToIM("send it to me")).toBe(true);
  });

  it("returns false for ordinary result requests", () => {
    expect(shouldExplicitlyDeliverMediaToIM("帮我截图百度首页")).toBe(false);
    expect(shouldExplicitlyDeliverMediaToIM("保存到 Downloads")).toBe(false);
    expect(shouldExplicitlyDeliverMediaToIM("看一下这个文件")).toBe(false);
    expect(shouldExplicitlyDeliverMediaToIM("")).toBe(false);
  });

  it("derives shareable screenshot paths from final answer text", () => {
    expect(deriveShareableIMMediaFromText("已完成，文件路径：/Users/haichao/Downloads/baidu-homepage.png")).toEqual({
      mediaUrl: "/Users/haichao/Downloads/baidu-homepage.png",
      mediaUrls: ["/Users/haichao/Downloads/baidu-homepage.png"],
      images: ["/Users/haichao/Downloads/baidu-homepage.png"],
    });
  });

  it("derives markdown image refs and file URLs for explicit IM delivery", () => {
    expect(deriveShareableIMMediaFromText([
      "已完成，见下图：",
      "![截图](file:///Users/haichao/Downloads/baidu-homepage.png)",
      "远程图：![渲染图](https://example.com/rendered.png)",
    ].join("\n"))).toEqual({
      mediaUrl: "/Users/haichao/Downloads/baidu-homepage.png",
      mediaUrls: [
        "/Users/haichao/Downloads/baidu-homepage.png",
        "https://example.com/rendered.png",
      ],
      images: [
        "/Users/haichao/Downloads/baidu-homepage.png",
        "https://example.com/rendered.png",
      ],
    });
  });

  it("filters channel denial lines once media is actually available", () => {
    expect(sanitizeIMReplyTextForMedia([
      "已截好。",
      "文件路径：/Users/haichao/Downloads/baidu-homepage.png",
      "当前渠道不能直接把本地文件当作附件发出",
      "回到本机打开即可",
    ].join("\n"))).toBe([
      "已截好。",
      "文件路径：/Users/haichao/Downloads/baidu-homepage.png",
    ].join("\n"));
  });

  it("removes standalone markdown image lines after media extraction", () => {
    expect(sanitizeIMReplyTextForMedia([
      "已截好。",
      "![截图](/Users/haichao/Downloads/baidu-homepage.png)",
      "请直接查看图片。",
    ].join("\n"))).toBe([
      "已截好。",
      "请直接查看图片。",
    ].join("\n"));
  });
});
