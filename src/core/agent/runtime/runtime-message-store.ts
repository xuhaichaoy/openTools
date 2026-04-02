import type { InboxMessage } from "@/core/agent/actor/types";

export type RuntimeInboxMessage = Pick<
  InboxMessage,
  "id" | "from" | "content" | "expectReply" | "replyTo" | "images"
>;

export type RuntimeVisibleInboxMessage = Omit<RuntimeInboxMessage, "from"> & {
  from: string;
};

function normalizeImageRef(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export class RuntimeMessageStore {
  private readonly activeImageRefs = new Set<string>();
  private capturedInboxUserQueries: string[] = [];

  constructor(images?: readonly string[]) {
    this.mergeImages(images);
  }

  getCurrentImages(): string[] | undefined {
    if (this.activeImageRefs.size === 0) return undefined;
    return [...this.activeImageRefs];
  }

  mergeImages(images?: readonly string[]): void {
    for (const image of images ?? []) {
      const normalized = normalizeImageRef(image);
      if (normalized) {
        this.activeImageRefs.add(normalized);
      }
    }
  }

  recordDrainedMessages(
    messages: readonly RuntimeInboxMessage[],
    resolveSenderName: (from: string) => string,
  ): RuntimeVisibleInboxMessage[] {
    if (messages.length === 0) return [];

    messages.forEach((message) => this.mergeImages(message.images));

    const userMessages = messages
      .filter((message) => message.from === "user")
      .map((message) => String(message.content ?? "").trim())
      .filter(Boolean);
    if (userMessages.length > 0) {
      this.capturedInboxUserQueries.push(...userMessages);
    }

    return messages.map((message) => ({
      ...message,
      from: resolveSenderName(message.from),
    }));
  }

  consumeCapturedInboxUserQueries(): string[] | undefined {
    if (this.capturedInboxUserQueries.length === 0) return undefined;
    const captured = [...this.capturedInboxUserQueries];
    this.capturedInboxUserQueries = [];
    return captured;
  }

  resetCapturedInboxUserQuery(): void {
    this.capturedInboxUserQueries = [];
  }
}
