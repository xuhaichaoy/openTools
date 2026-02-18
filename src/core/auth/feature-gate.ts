import { useAuthStore } from "@/store/auth-store";

export type Feature =
  | "cloud_sync"
  | "platform_ai"
  | "team_ai"
  | "team_features"
  | "energy_purchase"
  | "advanced_tools";

export type GateResult = {
  allowed: boolean;
  reason?: string;
  action?: "login" | "upgrade" | "recharge";
};

/**
 * 根据登录状态和用户信息计算功能门控结果
 */
function computeGateResult(
  feature: Feature,
  isLoggedIn: boolean,
  energy: number,
): GateResult {
  switch (feature) {
    case "cloud_sync":
      if (!isLoggedIn) {
        return {
          allowed: false,
          reason: "登录后即可使用云同步功能",
          action: "login",
        };
      }
      return { allowed: true };

    case "platform_ai":
      if (!isLoggedIn) {
        return {
          allowed: false,
          reason: "登录后可使用平台 AI 服务",
          action: "login",
        };
      }
      if (energy <= 0) {
        return {
          allowed: false,
          reason: "AI 能量不足，请充值",
          action: "recharge",
        };
      }
      return { allowed: true };

    case "team_ai":
      if (!isLoggedIn) {
        return {
          allowed: false,
          reason: "请先登录",
          action: "login",
        };
      }
      return { allowed: true };

    case "team_features":
      if (!isLoggedIn) {
        return {
          allowed: false,
          reason: "登录后可使用团队功能",
          action: "login",
        };
      }
      return { allowed: true };

    case "energy_purchase":
      if (!isLoggedIn) {
        return {
          allowed: false,
          reason: "请先登录",
          action: "login",
        };
      }
      return { allowed: true };

    case "advanced_tools":
      return { allowed: true };

    default:
      return { allowed: true };
  }
}

/**
 * 功能门控：检查当前用户是否有权使用指定功能（非响应式，用于事件回调等非组件场景）
 */
export function checkFeatureAccess(feature: Feature): GateResult {
  const { isLoggedIn, user } = useAuthStore.getState();
  return computeGateResult(feature, isLoggedIn, user?.energy || 0);
}

/**
 * React Hook 版本的功能门控（响应式，登录状态变化时自动重渲染）
 */
export function useFeatureGate(feature: Feature): GateResult {
  const isLoggedIn = useAuthStore((s) => s.isLoggedIn);
  const energy = useAuthStore((s) => s.user?.energy || 0);
  return computeGateResult(feature, isLoggedIn, energy);
}

/**
 * 触发门控引导动作
 */
export function triggerGateAction(action: "login" | "upgrade" | "recharge") {
  switch (action) {
    case "login":
      window.dispatchEvent(new CustomEvent("open-login-modal"));
      break;
    case "upgrade":
      window.dispatchEvent(
        new CustomEvent("show-toast", {
          detail: { message: "订阅升级功能即将上线", type: "info" },
        }),
      );
      break;
    case "recharge":
      window.dispatchEvent(
        new CustomEvent("show-toast", {
          detail: { message: "能量充值功能即将上线", type: "info" },
        }),
      );
      break;
  }
}
