import { Lock, LogIn, Zap } from "lucide-react";
import type { GateResult } from "@/core/auth/feature-gate";
import { triggerGateAction } from "@/core/auth/feature-gate";

interface Props {
  gate: GateResult;
  featureLabel?: string;
}

/**
 * 当功能门控拒绝时显示的提示卡片
 */
export function UpgradePrompt({ gate, featureLabel }: Props) {
  if (gate.allowed) return null;

  const icons = {
    login: LogIn,
    upgrade: Lock,
    recharge: Zap,
  };

  const labels = {
    login: "去登录",
    upgrade: "去升级",
    recharge: "去充值",
  };

  const Icon = gate.action ? icons[gate.action] : Lock;
  const buttonLabel = gate.action ? labels[gate.action] : "了解更多";

  return (
    <div className="flex flex-col items-center justify-center py-12 px-6 text-center animate-in fade-in zoom-in-95 duration-300">
      <div className="w-16 h-16 rounded-full bg-indigo-500/10 flex items-center justify-center mb-4">
        <Icon className="w-8 h-8 text-indigo-500" />
      </div>
      {featureLabel && (
        <h3 className="text-lg font-bold mb-1">{featureLabel}</h3>
      )}
      <p className="text-sm text-[var(--color-text-secondary)] mb-6 max-w-xs">
        {gate.reason}
      </p>
      {gate.action && (
        <button
          onClick={() => triggerGateAction(gate.action!)}
          className="px-6 py-2.5 bg-indigo-500 text-white font-bold text-sm rounded-xl shadow-lg shadow-indigo-500/20 hover:bg-indigo-600 active:scale-95 transition-all"
        >
          {buttonLabel}
        </button>
      )}
    </div>
  );
}
