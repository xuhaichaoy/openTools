import { useState, useEffect } from "react";
import { Zap } from "lucide-react";
import { useAuthStore } from "@/store/auth-store";
import { api } from "@/core/api/client";

/**
 * 显示在搜索栏/工具栏的 AI 能量余额小组件
 */
export function EnergyBadge() {
  const { isLoggedIn, user, updateEnergy } = useAuthStore();
  const [energy, setEnergy] = useState(user?.energy || 0);

  useEffect(() => {
    if (!isLoggedIn) return;

    const fetchEnergy = async () => {
      try {
        const res = await api.get<{ balance: number }>("/ai/energy");
        setEnergy(res.balance);
        updateEnergy(res.balance);
      } catch {
        // silently fail
      }
    };

    fetchEnergy();
    const interval = setInterval(fetchEnergy, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [isLoggedIn, updateEnergy]);

  if (!isLoggedIn) return null;

  return (
    <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-indigo-500/10 text-indigo-500 text-xs font-bold">
      <Zap className="w-3 h-3" />
      {energy}
    </div>
  );
}
