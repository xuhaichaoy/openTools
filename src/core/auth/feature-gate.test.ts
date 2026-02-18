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

function setAuthState(isLoggedIn: boolean, energy = 0) {
  (useAuthStore as any).setState({
    isLoggedIn,
    user: isLoggedIn ? { energy } : null,
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
    setAuthState(true, 100);
    expect(checkFeatureAccess("cloud_sync").allowed).toBe(true);
  });

  // ── platform_ai ──

  it("platform_ai: should deny when not logged in", () => {
    const result = checkFeatureAccess("platform_ai");
    expect(result.allowed).toBe(false);
    expect(result.action).toBe("login");
  });

  it("platform_ai: should deny when logged in but no energy", () => {
    setAuthState(true, 0);
    const result = checkFeatureAccess("platform_ai");
    expect(result.allowed).toBe(false);
    expect(result.action).toBe("recharge");
  });

  it("platform_ai: should allow when logged in with energy", () => {
    setAuthState(true, 50);
    expect(checkFeatureAccess("platform_ai").allowed).toBe(true);
  });

  // ── team_ai ──

  it("team_ai: should deny when not logged in", () => {
    expect(checkFeatureAccess("team_ai").allowed).toBe(false);
  });

  it("team_ai: should allow when logged in (regardless of energy)", () => {
    setAuthState(true, 0);
    expect(checkFeatureAccess("team_ai").allowed).toBe(true);
  });

  // ── advanced_tools ──

  it("advanced_tools: should always allow", () => {
    expect(checkFeatureAccess("advanced_tools").allowed).toBe(true);
    setAuthState(true, 100);
    expect(checkFeatureAccess("advanced_tools").allowed).toBe(true);
  });

  // ── energy_purchase ──

  it("energy_purchase: should deny when not logged in", () => {
    expect(checkFeatureAccess("energy_purchase").action).toBe("login");
  });

  it("energy_purchase: should allow when logged in", () => {
    setAuthState(true);
    expect(checkFeatureAccess("energy_purchase").allowed).toBe(true);
  });
});
