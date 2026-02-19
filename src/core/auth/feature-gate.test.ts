/**
 * feature-gate.ts 单元测试
 *
 * 测试 checkFeatureAccess 的各种场景。
 * 由于 checkFeatureAccess 内部读取 useAuthStore.getState()，
 * 我们需要模拟 auth-store。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the auth store before importing the module under test
vi.mock("@/store/auth-store", () => {
  let state = {
    isLoggedIn: false,
    user: null as any,
  };

  const useAuthStore = Object.assign(
    (selector?: any) => (selector ? selector(state) : state),
    {
      getState: () => state,
      setState: (newState: any) => {
        state = { ...state, ...newState };
      },
    },
  );

  return { useAuthStore };
});

import { checkFeatureAccess } from "./feature-gate";
import { useAuthStore } from "@/store/auth-store";

function setAuthState(
  isLoggedIn: boolean,
  opts?: { plan?: "free" | "pro"; planExpiresAt?: string | null; energy?: number },
) {
  const plan = opts?.plan ?? "free";
  const energy = opts?.energy ?? 0;
  (useAuthStore as any).setState({
    isLoggedIn,
    user: isLoggedIn
      ? {
          energy,
          plan,
          plan_expires_at: opts?.planExpiresAt ?? null,
        }
      : null,
  });
}

describe("checkFeatureAccess", () => {
  beforeEach(() => {
    setAuthState(false);
  });

  // ── cloud_sync ──

  it("cloud_sync: should deny when not logged in", () => {
    const result = checkFeatureAccess("cloud_sync");
    expect(result.allowed).toBe(false);
    expect(result.action).toBe("login");
  });

  it("cloud_sync: should allow when logged in", () => {
    setAuthState(true, { plan: "pro", energy: 100 });
    expect(checkFeatureAccess("cloud_sync").allowed).toBe(true);
  });

  it("cloud_sync: should deny for free users", () => {
    setAuthState(true, { plan: "free", energy: 100 });
    const result = checkFeatureAccess("cloud_sync");
    expect(result.allowed).toBe(false);
    expect(result.action).toBe("upgrade");
  });

  // ── platform_ai ──

  it("platform_ai: should deny when not logged in", () => {
    const result = checkFeatureAccess("platform_ai");
    expect(result.allowed).toBe(false);
    expect(result.action).toBe("login");
  });

  it("platform_ai: should deny when logged in", () => {
    setAuthState(true, { plan: "pro", energy: 100 });
    const result = checkFeatureAccess("platform_ai");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("暂未开放");
  });

  // ── team_ai ──

  it("team_ai: should deny when not logged in", () => {
    expect(checkFeatureAccess("team_ai").allowed).toBe(false);
  });

  it("team_ai: should allow when logged in (regardless of energy)", () => {
    setAuthState(true, { plan: "free", energy: 0 });
    expect(checkFeatureAccess("team_ai").allowed).toBe(true);
  });

  // ── advanced_tools ──

  it("advanced_tools: should always allow", () => {
    expect(checkFeatureAccess("advanced_tools").allowed).toBe(true);
    setAuthState(true, { plan: "free", energy: 100 });
    expect(checkFeatureAccess("advanced_tools").allowed).toBe(true);
  });

  // ── energy_purchase ──

  it("energy_purchase: should deny when not logged in", () => {
    expect(checkFeatureAccess("energy_purchase").action).toBe("login");
  });

  it("energy_purchase: should allow when logged in", () => {
    setAuthState(true, { plan: "free" });
    expect(checkFeatureAccess("energy_purchase").allowed).toBe(true);
  });
});
