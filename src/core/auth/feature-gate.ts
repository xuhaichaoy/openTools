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
 * 功能门控：检查当前用户是否有权使用指定功能
 */
export function checkFeatureAccess(feature: Feature): GateResult {
  const { isLoggedIn, user } = useAuthStore.getState();
  const plan = user?.plan || "free";
  const energy = user?.energy || 0;

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
      // 团队 AI 不需要个人能量，但需要登录
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
      // 高级工具（数据工坊等）不需要登录即可使用
      return { allowed: true };

    default:
      return { allowed: true };
  }
}

/**
 * React Hook 版本的功能门控
 */
export function useFeatureGate(feature: Feature): GateResult {
  // 直接从 store 读取（hook 上下文）
  return checkFeatureAccess(feature);
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
      // TODO: 打开升级/订阅页面
      break;
    case "recharge":
      // TODO: 打开能量购买页面
      break;
  }
}
