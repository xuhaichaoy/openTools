import { describe, expect, it } from "vitest";
import {
  decodePartialToolContent,
  formatArtifactPreviewBody,
  hasArtifactPayloadKey,
  parsePartialToolJSON,
  recoverArtifactBodyFromRaw,
} from "./tool-streaming-preview";

describe("tool-streaming-preview", () => {
  it("extracts write_file content from standard JSON tool args", () => {
    const parsed = parsePartialToolJSON(
      "{\"path\":\"/tmp/demo.html\",\"content\":\"<!DOCTYPE html>\\n<div class=\\\"app\\\">hello</div>\"}",
    );

    expect(parsed.path).toBe("/tmp/demo.html");
    expect(parsed.content).toBe("<!DOCTYPE html>\n<div class=\"app\">hello</div>");
  });

  it("extracts partial artifact content without keeping the wrapper JSON", () => {
    const parsed = parsePartialToolJSON(
      "{\"path\":\"/tmp/demo.html\",content:\"<!DOCTYPE html>\\n<body>partial",
    );

    expect(parsed.path).toBe("/tmp/demo.html");
    expect(parsed.content).toBe("<!DOCTYPE html>\n<body>partial");
    expect(hasArtifactPayloadKey("{\"path\":\"/tmp/demo.html\",content:\"<!DOCTYPE html>")).toBe(true);
  });

  it("extracts malformed streaming payloads even when the content key is missing a colon", () => {
    const parsed = parsePartialToolJSON(
      "{\"path\":\"/tmp/demo.html\",content \"<!DOCTYPE html>\\n<section>hello</section>",
    );

    expect(parsed.path).toBe("/tmp/demo.html");
    expect(parsed.content).toBe("<!DOCTYPE html>\n<section>hello</section>");
    expect(
      hasArtifactPayloadKey("{\"path\":\"/tmp/demo.html\",content \"<!DOCTYPE html>"),
    ).toBe(true);
  });

  it("extracts sequential thinking payload fields", () => {
    const parsed = parsePartialToolJSON(
      "{\"thought\":\"先分析页面结构\",\"thought_number\":1,\"total_thoughts\":4,\"next_thought_needed\":true}",
    );

    expect(parsed.thought).toBe("先分析页面结构");
    expect(parsed.thoughtNumber).toBe(1);
    expect(parsed.totalThoughts).toBe(4);
  });

  it("extracts spawn_task payload fields", () => {
    const parsed = parsePartialToolJSON(
      "{\"target_agent\":\"Specialist\",\"task\":\"创建完整 HTML 页面\",\"label\":\"页面实现\",\"role_boundary\":\"executor\"}",
    );

    expect(parsed.targetAgent).toBe("Specialist");
    expect(parsed.task).toBe("创建完整 HTML 页面");
    expect(parsed.label).toBe("页面实现");
    expect(parsed.roleBoundary).toBe("executor");
  });

  it("decodes escaped preview text", () => {
    expect(decodePartialToolContent("\\\"hello\\\"\\nworld")).toBe("\"hello\"\nworld");
  });

  it("decodes double-escaped preview text into real line breaks", () => {
    expect(
      decodePartialToolContent("<!DOCTYPE html>\\\\n<html>\\\\n  <body>ok</body>\\\\n</html>"),
    ).toBe("<!DOCTYPE html>\n<html>\n  <body>ok</body>\n</html>");
  });

  it("falls back to html body content when raw tool args still contain the wrapper", () => {
    const recovered = recoverArtifactBodyFromRaw(
      "{\"path\":\"/tmp/demo.html\",content \"<!DOCTYPE html>\\n<html><body>ok</body></html>",
      "/tmp/demo.html",
    );

    expect(recovered).toBe("<!DOCTYPE html>\n<html><body>ok</body></html>");
  });

  it("keeps multiline html when content contains unescaped attribute quotes", () => {
    const parsed = parsePartialToolJSON(
      "{\"path\":\"/tmp/demo.html\",\"content\":\"<!doctype html>\n<html lang=\"zh-CN\">\n  <head>\n    <meta charset=\"UTF-8\" />\n  </head>\n  <body>\n    <div class=\"app\">hello</div>\n  </body>\n</html>\"}",
    );

    expect(parsed.path).toBe("/tmp/demo.html");
    expect(parsed.content).toContain("<html lang=\"zh-CN\">");
    expect(parsed.content).toContain("<div class=\"app\">hello</div>");
    expect(parsed.content.split("\n").length).toBeGreaterThan(6);
  });

  it("recovers double-escaped html from raw tool args", () => {
    const recovered = recoverArtifactBodyFromRaw(
      "{\"path\":\"/tmp/demo.html\",\"content\":\"<!DOCTYPE html>\\\\n<html>\\\\n  <body>ok</body>\\\\n</html>\"}",
      "/tmp/demo.html",
    );

    expect(recovered).toBe("<!DOCTYPE html>\n<html>\n  <body>ok</body>\n</html>");
  });

  it("formats single-line html previews into readable multiline code", () => {
    const formatted = formatArtifactPreviewBody(
      "/tmp/demo.html",
      "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\"><style>body { margin: 0; padding: 0; } .app { display: flex; }</style></head><body><div class=\"app\">hello</div></body></html>",
    );

    expect(formatted).toContain("<html lang=\"zh-CN\">");
    expect(formatted).toContain("\n  <head>");
    expect(formatted).toContain("\n      body {");
    expect(formatted).toContain("\n      .app {");
    expect(formatted.split("\n").length).toBeGreaterThan(8);
  });

  it("normalizes backslash-newline html streaming chunks into readable multiline code", () => {
    const formatted = formatArtifactPreviewBody(
      "/tmp/demo.html",
      "<!DOCTYPE html>\\\n<html lang=\"zh-CN\">\\\n<head>\\\n<meta charset=\"UTF-8\" />\\\n</head>\\\n<body><div class=\"app\">hello</div></body>\\\n</html>",
    );

    expect(formatted).toContain("<!DOCTYPE html>");
    expect(formatted).toContain("\n<html lang=\"zh-CN\">");
    expect(formatted).toContain("\n  <head>");
    expect(formatted).not.toContain("\\\n");
  });

  it("formats multiline html previews when multiple tags are still compressed into the same line", () => {
    const formatted = formatArtifactPreviewBody(
      "/tmp/demo.html",
      "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head><meta charset=\"UTF-8\"><title>Demo</title><style>body { margin: 0; padding: 0; } .app { display: flex; }</style></head>\n<body><div class=\"app\">hello</div></body>\n</html>",
    );

    expect(formatted).toContain("\n  <head>");
    expect(formatted).toContain("\n    <meta charset=\"UTF-8\">");
    expect(formatted).toContain("\n      body {");
    expect(formatted).toContain("\n  <body>");
  });

  it("keeps existing multiline artifact previews unchanged", () => {
    const source = "<!DOCTYPE html>\n<html>\n  <body>ok</body>\n</html>";
    expect(formatArtifactPreviewBody("/tmp/demo.html", source)).toBe(source);
  });
});
