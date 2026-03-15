import { describe, expect, it } from "vitest";

import { isRetryableError } from "./model-retry-middleware";

describe("model-retry-middleware", () => {
  it("treats transient transport disconnect errors as retryable", () => {
    expect(
      isRetryableError(
        new Error(
          "请求失败: error sending request for url (http://example.com/chat/completions) (source: Some(hyper_util::client::legacy::Error(SendRequest, hyper::Error(IncompleteMessage))))",
        ),
      ),
    ).toBe(true);
    expect(isRetryableError(new Error("upstream connection closed unexpectedly"))).toBe(true);
    expect(isRetryableError(new Error("unexpected EOF while reading response body"))).toBe(true);
  });

  it("keeps auth and quota failures non-retryable", () => {
    expect(isRetryableError(new Error("401 unauthorized"))).toBe(false);
    expect(isRetryableError(new Error("quota exceeded"))).toBe(false);
  });
});
