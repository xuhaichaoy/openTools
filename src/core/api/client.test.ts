import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = {
  token: "test-token",
  tokenUpdatedAt: Date.now(),
  refreshToken: null as string | null,
  isLoggedIn: true,
  logout: vi.fn(),
  login: vi.fn(),
};

vi.mock("@/store/auth-store", () => ({
  useAuthStore: {
    getState: () => authState,
  },
}));

vi.mock("@/store/server-store", () => ({
  getServerUrl: () => "http://localhost:3000",
}));

vi.mock("@/core/errors", () => ({
  handleError: vi.fn(),
}));

import { api, ApiError, assertResponseShape } from "./client";

describe("api client", () => {
  beforeEach(() => {
    authState.logout.mockReset();
    authState.login.mockReset();
    authState.token = "test-token";
    authState.tokenUpdatedAt = Date.now();
    authState.refreshToken = null;
    authState.isLoggedIn = true;
    global.fetch = vi.fn();
  });

  it("should throw structured ApiError for non-2xx responses", async () => {
    (global.fetch as any).mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "TEAM_QUOTA_EXCEEDED",
          message: "本月额度已用尽",
          details: { remaining: 0 },
        }),
        { status: 429 },
      ),
    );

    await expect(api.get("/teams/demo/ai-quota")).rejects.toMatchObject({
      name: "ApiError",
      code: "TEAM_QUOTA_EXCEEDED",
      status: 429,
      message: "本月额度已用尽",
      path: "/teams/demo/ai-quota",
    });
  });

  it("should throw INVALID_JSON_RESPONSE when success body is not JSON", async () => {
    (global.fetch as any).mockResolvedValue(
      new Response("<html>not json</html>", { status: 200 }),
    );

    await expect(api.get("/broken")).rejects.toMatchObject({
      name: "ApiError",
      code: "INVALID_JSON_RESPONSE",
      status: 200,
      path: "/broken",
    });
  });

  it("assertResponseShape should throw INVALID_RESPONSE_SHAPE", () => {
    const guard = (input: unknown): input is { ok: true } =>
      !!input && typeof input === "object" && (input as any).ok === true;

    expect(() =>
      assertResponseShape({ ok: false }, guard, "/shape-test"),
    ).toThrow(ApiError);

    try {
      assertResponseShape({ ok: false }, guard, "/shape-test");
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.code).toBe("INVALID_RESPONSE_SHAPE");
      expect(apiError.path).toBe("/shape-test");
    }
  });

  it("refreshes an aging token before sending protected requests", async () => {
    authState.token = "stale-token";
    authState.refreshToken = "refresh-token";
    authState.tokenUpdatedAt = Date.now() - 21 * 60 * 1000;

    authState.login.mockImplementation((_user, token, refreshToken) => {
      authState.token = token;
      authState.refreshToken = refreshToken ?? null;
      authState.tokenUpdatedAt = Date.now();
      authState.isLoggedIn = true;
    });

    (global.fetch as any)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user: { id: "user-1" },
            access_token: "fresh-token",
            refresh_token: "fresh-refresh-token",
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    const result = await api.get<{ ok: boolean }>("/protected");

    expect(result).toEqual({ ok: true });
    expect(authState.login).toHaveBeenCalledWith(
      { id: "user-1" },
      "fresh-token",
      "fresh-refresh-token",
    );
    expect((global.fetch as any).mock.calls[1]?.[1]?.headers?.Authorization).toBe("Bearer fresh-token");
  });
});
