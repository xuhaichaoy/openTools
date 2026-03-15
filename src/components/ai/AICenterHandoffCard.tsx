import React from "react";

import {
  describeAICenterHandoffIntent,
  getAICenterHandoffTitle,
} from "@/core/ai/ai-center-handoff";
import { describeAICenterSource } from "@/core/ai/ai-center-mode-meta";
import type { AICenterHandoff } from "@/store/app-store";

function formatFileRefLabel(path: string, label?: string, lineStart?: number, lineEnd?: number): string {
  const fileLabel = label?.trim() || path.split("/").pop() || path;
  if (typeof lineStart !== "number") return fileLabel;
  if (typeof lineEnd === "number" && lineEnd >= lineStart) {
    return `${fileLabel}:${lineStart}-${lineEnd}`;
  }
  return `${fileLabel}:${lineStart}`;
}

export function AICenterHandoffCard({
  handoff,
  variant = "info",
  dismissLabel,
  onDismiss,
}: {
  handoff: AICenterHandoff;
  variant?: "info" | "active";
  dismissLabel?: string;
  onDismiss?: () => void;
}) {
  const title = getAICenterHandoffTitle(handoff);
  const intentLabel = describeAICenterHandoffIntent(handoff.intent);
  const sourceLabel = handoff.sourceMode ? describeAICenterSource(handoff) : null;
  const keyPoints = handoff.keyPoints?.slice(0, 4) ?? [];
  const nextSteps = handoff.nextSteps?.slice(0, 4) ?? [];
  const sections = handoff.contextSections?.slice(0, 3) ?? [];
  const files = handoff.files?.slice(0, 6) ?? [];
  const tone = variant === "active"
    ? "border-indigo-500/15 bg-[linear-gradient(135deg,rgba(99,102,241,0.12),rgba(99,102,241,0.04))] text-[var(--color-text-secondary)]"
    : "border-cyan-500/15 bg-[linear-gradient(135deg,rgba(6,182,212,0.12),rgba(6,182,212,0.04))] text-[var(--color-text-secondary)]";

  return (
    <div className={`rounded-xl border px-3 py-2.5 text-[11px] ${tone}`}>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{title}</span>
            {intentLabel && (
              <span className="rounded-full border border-current/15 px-1.5 py-0.5 text-[10px] opacity-90">
                {intentLabel}
              </span>
            )}
            {sourceLabel && (
              <span className="rounded-full border border-current/15 px-1.5 py-0.5 text-[10px] opacity-80">
                来自 {sourceLabel}
              </span>
            )}
          </div>
          {handoff.summary && (
            <div className="mt-1 opacity-85">
              {handoff.summary}
            </div>
          )}
          {handoff.goal && handoff.goal !== title && (
            <div className="mt-1 opacity-80">
              目标：{handoff.goal}
            </div>
          )}
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            className="ml-auto rounded-full border border-current/15 px-2 py-0.5 text-[10px] opacity-80 transition-colors hover:opacity-100"
          >
            {dismissLabel || "隐藏"}
          </button>
        )}
      </div>

      {keyPoints.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide opacity-65">关键点</div>
          <div className="flex flex-wrap gap-1.5">
            {keyPoints.map((item) => (
              <span
                key={item}
                className="rounded-lg border border-current/10 bg-black/5 px-2 py-1 opacity-90 dark:bg-white/5"
              >
                {item}
              </span>
            ))}
          </div>
        </div>
      )}

      {nextSteps.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide opacity-65">下一步</div>
          <div className="space-y-1">
            {nextSteps.map((item) => (
              <div key={item} className="opacity-90">
                - {item}
              </div>
            ))}
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 text-[10px] uppercase tracking-wide opacity-65">带入文件</div>
          <div className="flex flex-wrap gap-1.5">
            {files.map((file) => (
              <span
                key={file.path}
                className="rounded-lg border border-current/10 bg-black/5 px-2 py-1 opacity-90 dark:bg-white/5"
                title={file.path}
              >
                {formatFileRefLabel(file.path, file.label, file.lineStart, file.lineEnd)}
                {file.reason ? ` · ${file.reason}` : ""}
              </span>
            ))}
          </div>
        </div>
      )}

      {sections.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {sections.map((section) => (
            <div key={section.title}>
              <div className="text-[10px] uppercase tracking-wide opacity-65">{section.title}</div>
              <div className="mt-1 space-y-1">
                {section.items.map((item) => (
                  <div key={item} className="opacity-85">
                    - {item}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
