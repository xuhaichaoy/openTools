import { useEffect, useRef } from "react";
import { useAIStore } from "@/store/ai-store";
import { useConfirmDialogStore } from "@/store/confirm-dialog-store";

function parseToolParams(argumentsText: string): Record<string, unknown> {
  if (!argumentsText.trim()) return {};
  try {
    const parsed = JSON.parse(argumentsText);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : { rawArguments: argumentsText };
  } catch {
    return { rawArguments: argumentsText };
  }
}

export function ToolConfirmDialog() {
  const { pendingToolConfirm, confirmTool } = useAIStore();
  const openConfirmDialog = useConfirmDialogStore((s) => s.open);
  const activeKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pendingToolConfirm) {
      activeKeyRef.current = null;
      return;
    }

    const key = `${pendingToolConfirm.name}::${pendingToolConfirm.arguments}`;
    if (activeKeyRef.current === key) return;
    activeKeyRef.current = key;

    void openConfirmDialog({
      toolName: pendingToolConfirm.name,
      params: parseToolParams(pendingToolConfirm.arguments),
      source: "ask",
    }).then((confirmed) => {
      activeKeyRef.current = null;
      void confirmTool(confirmed);
    });
  }, [confirmTool, openConfirmDialog, pendingToolConfirm]);

  return null;
}
