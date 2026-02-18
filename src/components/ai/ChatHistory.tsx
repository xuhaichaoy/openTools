import { ConversationList } from "./ConversationList";

interface ChatHistoryProps {
  show: boolean;
  onClose: () => void;
}

export function ChatHistory({ show, onClose }: ChatHistoryProps) {
  if (!show) return null;

  return (
    <>
      {/* 遮罩 */}
      <div
        className="absolute inset-0 bg-black/20 z-20"
        onClick={onClose}
      />
      {/* 侧边栏 */}
      <div className="absolute left-0 top-0 bottom-0 w-[280px] bg-[var(--color-bg)] border-r border-[var(--color-border)] z-30 shadow-2xl animate-in slide-in-from-left duration-200">
        <ConversationList onClose={onClose} />
      </div>
    </>
  );
}
