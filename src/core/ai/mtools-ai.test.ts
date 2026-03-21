import { describe, expect, it } from "vitest";
import { shouldDeferManagedAuthStreamError } from "./mtools-ai";

describe("shouldDeferManagedAuthStreamError", () => {
  it("matches managed auth 401 errors", () => {
    expect(shouldDeferManagedAuthStreamError(
      { source: "team" },
      'API 错误 (HTTP 401): {"code":"UNAUTHORIZED","message":"Invalid token"}',
    )).toBe(true);

    expect(shouldDeferManagedAuthStreamError(
      { source: "platform" },
      "unauthorized",
    )).toBe(true);
  });

  it("does not defer non-auth errors or own-key errors", () => {
    expect(shouldDeferManagedAuthStreamError(
      { source: "team" },
      "API 错误 (HTTP 500): internal server error",
    )).toBe(false);

    expect(shouldDeferManagedAuthStreamError(
      { source: "own_key" },
      'API 错误 (HTTP 401): {"code":"UNAUTHORIZED","message":"Invalid token"}',
    )).toBe(false);
  });
});
