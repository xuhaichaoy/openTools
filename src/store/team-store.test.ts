import { beforeEach, describe, expect, it, vi } from "vitest";

const authState = {
  token: "test-token",
  refreshToken: null as string | null,
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

import { useTeamStore } from "./team-store";

describe("team-store listSharedResources", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it("should parse { resources: [] } response", async () => {
    (global.fetch as any).mockResolvedValue(
      new Response(
        JSON.stringify({
          resources: [
            {
              id: "r1",
              team_id: "t1",
              user_id: "u1",
              resource_type: "workflow",
              resource_id: "wf1",
              resource_name: "模板 A",
              shared_at: "2026-02-19T00:00:00Z",
              username: "alice",
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await useTeamStore.getState().listSharedResources("t1", "workflow");
    expect(result).toHaveLength(1);
    expect(result[0].resource_name).toBe("模板 A");
  });

  it("should throw INVALID_RESPONSE_SHAPE for wrong response contract", async () => {
    (global.fetch as any).mockResolvedValue(
      new Response(JSON.stringify([{"id":"r1"}]), { status: 200 }),
    );

    await expect(
      useTeamStore.getState().listSharedResources("t1"),
    ).rejects.toMatchObject({
      code: "INVALID_RESPONSE_SHAPE",
      path: "/teams/t1/resources",
    });
  });
});
