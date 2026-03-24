import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, Paperclip } from "lucide-react";

import type { StructuredMediaAttachment } from "@/core/media/structured-media";

function isHttpUrl(path: string): boolean {
  return /^https?:\/\//i.test(path);
}

function getAttachmentLabel(attachment: StructuredMediaAttachment): string {
  const explicit = String(attachment.fileName ?? "").trim();
  if (explicit) return explicit;
  const path = String(attachment.path ?? "").trim();
  return path.split("/").pop() || path;
}

async function openAttachmentTarget(path: string): Promise<void> {
  if (isHttpUrl(path)) {
    window.open(path, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    await invoke("shell_open_path", { path });
  } catch (error) {
    console.warn("[StructuredMediaAttachments] open attachment failed:", error);
    await invoke("open_file_location", { filePath: path });
  }
}

export function StructuredMediaAttachments({
  attachments,
  compact = false,
}: {
  attachments?: StructuredMediaAttachment[];
  compact?: boolean;
}) {
  if (!attachments?.length) return null;

  return (
    <div className={`flex flex-wrap gap-1.5 ${compact ? "" : "mt-2"}`}>
      {attachments.map((attachment) => (
        <button
          key={`${attachment.path}:${attachment.fileName ?? ""}`}
          type="button"
          onClick={() => {
            void openAttachmentTarget(attachment.path);
          }}
          className="inline-flex max-w-full items-center gap-1 rounded-full border border-[var(--color-border)] bg-[var(--color-bg)]/85 px-2.5 py-1 text-[11px] text-[var(--color-text-secondary)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)]/35 transition-colors"
          title={attachment.path}
        >
          <Paperclip className="h-3 w-3 shrink-0" />
          <span className="truncate">{getAttachmentLabel(attachment)}</span>
          <ExternalLink className="h-3 w-3 shrink-0" />
        </button>
      ))}
    </div>
  );
}
