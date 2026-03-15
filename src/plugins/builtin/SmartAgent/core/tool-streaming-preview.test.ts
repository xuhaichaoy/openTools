import { describe, expect, it } from "vitest";
import {
  decodePartialToolContent,
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

  it("decodes escaped preview text", () => {
    expect(decodePartialToolContent("\\\"hello\\\"\\nworld")).toBe("\"hello\"\nworld");
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
});
