import { useEffect } from "react";
import { useAskUserStore } from "@/store/ask-user-store";
import { AskUserDialog } from "@/plugins/builtin/SmartAgent/components/AskUserDialog";
import { useAgentRunningStore } from "@/store/agent-running-store";

/** 全局 AskUser 浮窗 — 挂载在 App 层级，任何模式触发都能弹出 */
export function GlobalAskUserDialog() {
  const dialog = useAskUserStore((s) => s.dialog);
  const submit = useAskUserStore((s) => s.submit);
  const dismiss = useAskUserStore((s) => s.dismiss);
  const activeAgentRun = useAgentRunningStore((s) => s.info);

  useEffect(() => {
    if (!dialog) return;
    if (dialog.source === "agent" && !activeAgentRun) {
      dismiss();
    }
  }, [activeAgentRun, dialog, dismiss]);

  if (!dialog) return null;

  return (
    <AskUserDialog
      questions={dialog.questions}
      onSubmit={submit}
      onDismiss={dismiss}
      source={dialog.source}
      taskDescription={dialog.taskDescription}
    />
  );
}
