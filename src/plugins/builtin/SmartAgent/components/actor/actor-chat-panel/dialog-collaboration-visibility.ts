import type { DialogMessage } from "@/core/agent/actor/types";
import type { LocalCollaborationTimelineGroup } from "./DialogCollaborationTimeline";

function hasRenderableFollowUpAfterGroup(
  group: LocalCollaborationTimelineGroup,
  messages: readonly Pick<DialogMessage, "from" | "to" | "timestamp">[],
): boolean {
  const threshold = Math.max(group.completedAt ?? 0, group.updatedAt);
  return messages.some((message) =>
    message.timestamp > threshold
    && message.from !== "user"
    && (!message.to || message.to === "user"),
  );
}

export function partitionLocalCollaborationTimelineGroups(params: {
  groups: readonly LocalCollaborationTimelineGroup[];
  messages: readonly Pick<DialogMessage, "from" | "to" | "timestamp">[];
  hasActiveCollaborationFlow: boolean;
  hideCompletedGroups: boolean;
}): {
  visibleGroups: LocalCollaborationTimelineGroup[];
  collapsibleGroupCount: number;
} {
  const collapsibleGroupIds = new Set(
    params.hasActiveCollaborationFlow
      ? []
      : params.groups
        .filter((group) =>
          group.phase === "aggregated"
          && hasRenderableFollowUpAfterGroup(group, params.messages),
        )
        .map((group) => group.id),
  );

  return {
    visibleGroups: params.hideCompletedGroups
      ? params.groups.filter((group) => !collapsibleGroupIds.has(group.id))
      : [...params.groups],
    collapsibleGroupCount: collapsibleGroupIds.size,
  };
}
