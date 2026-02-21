import type { ReactNode } from "react";
import { Play } from "lucide-react";

interface BuiltinPluginCard {
  id: string;
  viewId: string;
  installed: boolean;
  color: string;
  icon: ReactNode;
  name: string;
  description: string;
  category: string;
  actions?: unknown[];
}

interface BuiltinPluginListProps {
  plugins: BuiltinPluginCard[];
  onOpen: (viewId: string) => void;
}

export function BuiltinPluginList({ plugins, onOpen }: BuiltinPluginListProps) {
  return (
    <div className="h-full overflow-y-auto pr-1">
      <div className="space-y-2">
        {plugins.map((plugin) => (
          <div
            key={plugin.id}
            onClick={() => {
              if (!plugin.installed) return;
              onOpen(plugin.viewId);
            }}
            className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${
              plugin.installed
                ? "bg-[var(--color-bg-secondary)] border-[var(--color-border)] hover:border-orange-400/50 cursor-pointer"
                : "bg-[var(--color-bg-secondary)] border-[var(--color-border)] opacity-70"
            }`}
          >
            <div
              className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${plugin.color} [&_svg]:w-4 [&_svg]:h-4`}
            >
              {plugin.icon}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-[var(--color-text)] truncate">
                {plugin.name}
              </div>
              <div className="text-[10px] text-[var(--color-text-secondary)] truncate">
                {plugin.description}
              </div>
              <div className="text-[10px] text-[var(--color-text-secondary)] flex items-center gap-2 mt-0.5">
                <span className="px-1 rounded bg-[var(--color-bg-hover)]">
                  {plugin.category}
                </span>
                {plugin.actions && plugin.actions.length > 0 && (
                  <span className="text-indigo-400 bg-indigo-400/10 px-1 rounded">
                    AI {plugin.actions.length} 动作
                  </span>
                )}
                <span className="text-green-400 bg-green-400/10 px-1 rounded">
                  内置
                </span>
              </div>
            </div>
            <Play className="w-3.5 h-3.5 text-[var(--color-text-secondary)] shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}
