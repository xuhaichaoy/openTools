import type { AIToolCall } from "@/core/plugin-system/plugin-interface";
import { estimateTokens } from "@/core/ai/token-utils";

export interface RuntimeTranscriptMessage {
  role: "user" | "assistant" | "tool";
  content: string | null;
  images?: string[];
  tool_calls?: AIToolCall[];
  tool_call_id?: string;
  name?: string;
}

function cloneToolCalls(toolCalls?: readonly AIToolCall[] | null): AIToolCall[] | undefined {
  if (!toolCalls?.length) return undefined;
  return toolCalls.map((toolCall) => ({
    ...toolCall,
    function: {
      ...toolCall.function,
    },
  }));
}

function normalizeImages(images?: readonly string[] | null): string[] | undefined {
  const normalized = (images ?? [])
    .map((image) => String(image ?? "").trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

export function cloneTranscriptMessages(
  messages?: readonly RuntimeTranscriptMessage[] | null,
): RuntimeTranscriptMessage[] {
  if (!messages?.length) return [];
  return messages.map((message) => ({
    role: message.role,
    content: message.content == null ? null : String(message.content),
    ...(normalizeImages(message.images) ? { images: normalizeImages(message.images) } : {}),
    ...(cloneToolCalls(message.tool_calls) ? { tool_calls: cloneToolCalls(message.tool_calls) } : {}),
    ...(message.tool_call_id ? { tool_call_id: String(message.tool_call_id) } : {}),
    ...(message.name ? { name: String(message.name) } : {}),
  }));
}

function mergeAdjacentMessages(
  messages: readonly RuntimeTranscriptMessage[],
): RuntimeTranscriptMessage[] {
  const merged: RuntimeTranscriptMessage[] = [];
  for (const message of messages) {
    const previous = merged[merged.length - 1];
    const canMerge =
      previous
      && previous.role === message.role
      && previous.role !== "tool"
      && !previous.tool_calls?.length
      && !message.tool_calls?.length
      && !previous.tool_call_id
      && !message.tool_call_id
      && !previous.name
      && !message.name;
    if (!canMerge) {
      merged.push({ ...message });
      continue;
    }
    merged[merged.length - 1] = {
      ...previous,
      content: [
        String(previous.content ?? "").trim(),
        String(message.content ?? "").trim(),
      ].filter(Boolean).join("\n\n"),
      images: normalizeImages([...(previous.images ?? []), ...(message.images ?? [])]),
    };
  }
  return merged;
}

export function filterUnresolvedToolUseMessages(
  messages: readonly RuntimeTranscriptMessage[],
): RuntimeTranscriptMessage[] {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const message of messages) {
    if (message.role === "assistant") {
      for (const toolCall of message.tool_calls ?? []) {
        const toolUseId = String(toolCall.id ?? "").trim();
        if (toolUseId) toolUseIds.add(toolUseId);
      }
    }
    if (message.role === "tool") {
      const toolUseId = String(message.tool_call_id ?? "").trim();
      if (toolUseId) toolResultIds.add(toolUseId);
    }
  }

  const unresolvedIds = new Set(
    [...toolUseIds].filter((toolUseId) => !toolResultIds.has(toolUseId)),
  );

  if (unresolvedIds.size === 0) return cloneTranscriptMessages(messages);

  return cloneTranscriptMessages(messages).filter((message) => {
    if (message.role !== "assistant" || !message.tool_calls?.length) return true;
    const toolUseIdsForMessage = message.tool_calls
      .map((toolCall) => String(toolCall.id ?? "").trim())
      .filter(Boolean);
    if (toolUseIdsForMessage.length === 0) return true;
    return !toolUseIdsForMessage.every((toolUseId) => unresolvedIds.has(toolUseId));
  });
}

export function filterOrphanedToolResultMessages(
  messages: readonly RuntimeTranscriptMessage[],
): RuntimeTranscriptMessage[] {
  const toolUseIds = new Set<string>();

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const toolCall of message.tool_calls ?? []) {
      const toolUseId = String(toolCall.id ?? "").trim();
      if (toolUseId) toolUseIds.add(toolUseId);
    }
  }

  if (toolUseIds.size === 0) {
    return cloneTranscriptMessages(
      messages.filter((message) => message.role !== "tool"),
    );
  }

  return cloneTranscriptMessages(messages).filter((message) => {
    if (message.role !== "tool") return true;
    const toolUseId = String(message.tool_call_id ?? "").trim();
    if (!toolUseId) return false;
    return toolUseIds.has(toolUseId);
  });
}

export function filterWhitespaceOnlyAssistantMessages(
  messages: readonly RuntimeTranscriptMessage[],
): RuntimeTranscriptMessage[] {
  const filtered = cloneTranscriptMessages(messages).filter((message) => {
    if (message.role !== "assistant") return true;
    if (message.tool_calls?.length) return true;
    return String(message.content ?? "").trim().length > 0;
  });
  return mergeAdjacentMessages(filtered);
}

export function prepareTranscriptMessagesForResume(
  messages?: readonly RuntimeTranscriptMessage[] | null,
): RuntimeTranscriptMessage[] {
  const cloned = cloneTranscriptMessages(messages);
  if (cloned.length === 0) return [];
  return filterWhitespaceOnlyAssistantMessages(
    filterOrphanedToolResultMessages(
      filterUnresolvedToolUseMessages(cloned),
    ),
  );
}

function estimateTranscriptMessageTokens(message: RuntimeTranscriptMessage): number {
  const parts = [
    message.role,
    message.content ?? "",
    message.name ?? "",
    message.tool_call_id ?? "",
    ...(message.tool_calls ?? []).map((toolCall) =>
      JSON.stringify({
        id: toolCall.id,
        type: toolCall.type,
        function: toolCall.function,
      })),
  ];
  return estimateTokens(parts.join("\n"));
}

export function trimTranscriptMessagesToBudget(
  messages: readonly RuntimeTranscriptMessage[],
  tokenBudget?: number,
): RuntimeTranscriptMessage[] {
  if (!messages.length) return [];
  if (!tokenBudget || tokenBudget <= 0) {
    return cloneTranscriptMessages(messages);
  }

  const selected: RuntimeTranscriptMessage[] = [];
  let usedTokens = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const nextTokens = estimateTranscriptMessageTokens(message);
    if (selected.length > 0 && usedTokens + nextTokens > tokenBudget) {
      break;
    }
    selected.unshift({ ...message });
    usedTokens += nextTokens;
  }
  return prepareTranscriptMessagesForResume(selected);
}
