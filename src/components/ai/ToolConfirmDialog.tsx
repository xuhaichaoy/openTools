import { ConfirmDialog } from "@/plugins/builtin/SmartAgent/components/ConfirmDialog";
import { useAIStore } from "@/store/ai-store";

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

  if (!pendingToolConfirm) return null;

  return (
    <ConfirmDialog
      toolName={pendingToolConfirm.name}
      params={parseToolParams(pendingToolConfirm.arguments)}
      onResult={(result) => {
        void confirmTool(result.confirmed);
      }}
    />
  );
}
