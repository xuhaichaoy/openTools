import { ConfirmDialog } from "@/plugins/builtin/SmartAgent/components/ConfirmDialog";
import { useConfirmDialogStore } from "@/store/confirm-dialog-store";

export function GlobalConfirmDialog() {
  const active = useConfirmDialogStore((s) => s.active);
  const submit = useConfirmDialogStore((s) => s.submit);

  if (!active) return null;

  return (
    <ConfirmDialog
      toolName={active.toolName}
      params={active.params}
      risk={active.risk}
      reason={active.reason}
      reviewedByModel={active.reviewedByModel}
      onResult={(result) => submit(result.confirmed)}
    />
  );
}
