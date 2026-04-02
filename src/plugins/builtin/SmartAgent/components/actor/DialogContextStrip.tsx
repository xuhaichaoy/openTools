import React, { useMemo } from "react";
import type { DialogContextSnapshot } from "@/plugins/builtin/SmartAgent/core/dialog-context-snapshot";

interface DialogContextStripProps {
  snapshot?: DialogContextSnapshot | null;
}

function summarizeText(value: string | undefined, maxLength = 180): string {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

function getWorkspaceLabel(workspaceRoot?: string): string {
  const normalized = String(workspaceRoot ?? "").replace(/[\\/]+$/, "");
  if (!normalized) return "";
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] || normalized;
}

type StripPill = {
  key: string;
  label: string;
  title?: string;
  className: string;
};

function buildVisiblePills(snapshot?: DialogContextSnapshot | null): StripPill[] {
  if (!snapshot) return [];

  const pills: StripPill[] = [];
  if (snapshot.workspaceRoot) {
    pills.push({
      key: "workspace",
      label: `工作区 ${summarizeText(getWorkspaceLabel(snapshot.workspaceRoot), 18)}`,
      title: snapshot.workspaceRoot,
      className: "max-w-[180px] truncate rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-text-secondary)]",
    });
  }
  if (snapshot.sourceModeLabel) {
    pills.push({
      key: "source",
      label: `接力 ${summarizeText(snapshot.sourceModeLabel, 16)}`,
      title: snapshot.sourceModeLabel,
      className: "max-w-[180px] truncate rounded-full border border-sky-500/20 bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-700",
    });
  }
  if (snapshot.focusedSessionLabel) {
    pills.push({
      key: "focus",
      label: `聚焦 ${summarizeText(snapshot.focusedSessionLabel, 16)}`,
      title: snapshot.focusedSessionLabel,
      className: "max-w-[180px] truncate rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[10px] text-blue-700",
    });
  }
  if (snapshot.pendingInteractionCount > 0) {
    pills.push({
      key: "pending",
      label: `待回复 ${snapshot.pendingInteractionCount}`,
      className: "rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700",
    });
  }
  if (snapshot.queuedFollowUpCount > 0) {
    pills.push({
      key: "queued",
      label: `排队 ${snapshot.queuedFollowUpCount}`,
      className: "rounded-full border border-indigo-500/20 bg-indigo-500/10 px-2 py-0.5 text-[10px] text-indigo-700",
    });
  }
  if (snapshot.runningActorCount > 0) {
    pills.push({
      key: "running",
      label: `运行中 ${snapshot.runningActorCount}`,
      className: "rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700",
    });
  }

  return pills;
}

export function DialogContextStrip({ snapshot }: DialogContextStripProps) {
  const pills = useMemo(() => buildVisiblePills(snapshot), [snapshot]);
  if (pills.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/55 px-3 py-2">
      {pills.map((pill) => (
        <span
          key={pill.key}
          title={pill.title}
          className={pill.className}
        >
          {pill.label}
        </span>
      ))}
    </div>
  );
}
