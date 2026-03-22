import { useAppStore } from "@/store/app-store";
import { Wrench } from "lucide-react";

export interface ResultItem {
  id: string;
  title: string;
  description: string;
  icon?: React.ReactNode;
  category?: string;
  color?: string; // 图标颜色类名，如 "text-indigo-500 bg-indigo-500/10"
  action?: () => void;
}

interface ResultListProps {
  items: ResultItem[];
}

export function ResultList({ items }: ResultListProps) {
  const selectedIndex = useAppStore((s) => s.selectedIndex);
  const setSelectedIndex = useAppStore((s) => s.setSelectedIndex);

  if (items.length === 0) return null;

  return (
    <div className="grid grid-cols-8 gap-2 pt-4">
      {items.map((item, index) => (
        <button
          key={item.id}
          className={`flex flex-col items-center justify-start gap-3 p-2 rounded-xl cursor-pointer transition-colors group h-[90px] ${
            index === selectedIndex
              ? "bg-[var(--color-bg-hover)]"
              : "hover:bg-[var(--color-bg-hover)]"
          }`}
          onClick={() => {
            setSelectedIndex(index);
            item.action?.();
          }}
          onMouseEnter={() => {
            if (index !== selectedIndex) {
              setSelectedIndex(index);
            }
          }}
          title={item.description}
        >
          <div
            className={`w-12 h-12 rounded-2xl flex items-center justify-center shadow-sm shrink-0 ${
              item.color || "bg-[var(--color-bg-secondary)]"
            } [&_svg]:w-6 [&_svg]:h-6`}
          >
            {item.icon || (
              <Wrench className="w-6 h-6 text-[var(--color-text-secondary)]" />
            )}
          </div>
          <span className="text-[11px] text-[var(--color-text)] font-medium text-center leading-tight line-clamp-1 w-full break-words opacity-90 group-hover:opacity-100">
            {item.title}
          </span>
        </button>
      ))}
    </div>
  );
}
