export type TeamMailboxEntryKind = "direct" | "broadcast";
export type TeamMailboxEntryStatus = "queued" | "sent" | "failed";

export interface TeamMailboxEntry {
  id: string;
  teamId: string;
  kind: TeamMailboxEntryKind;
  senderActorId: string;
  recipientTeammateId?: string;
  recipientName?: string;
  backendId: string;
  content: string;
  timestamp: number;
  status: TeamMailboxEntryStatus;
  messageId?: string;
  error?: string;
}

function createMailboxEntryId(teamId: string): string {
  return `mailbox-${teamId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function cloneMailboxEntry(entry: TeamMailboxEntry): TeamMailboxEntry {
  return { ...entry };
}

export class TeamMailbox {
  private static instance: TeamMailbox;
  private readonly entries: TeamMailboxEntry[] = [];

  static getInstance(): TeamMailbox {
    if (!TeamMailbox.instance) {
      TeamMailbox.instance = new TeamMailbox();
    }
    return TeamMailbox.instance;
  }

  append(
    entry: Omit<TeamMailboxEntry, "id" | "timestamp"> & { timestamp?: number },
  ): TeamMailboxEntry {
    const record: TeamMailboxEntry = {
      id: createMailboxEntryId(entry.teamId),
      timestamp: entry.timestamp ?? Date.now(),
      ...entry,
    };
    this.entries.push(record);
    return cloneMailboxEntry(record);
  }

  getMessagesForRecipient(recipientName: string, teamId: string): TeamMailboxEntry[] {
    return this.entries
      .filter(e => e.teamId === teamId && e.recipientName === recipientName)
      .map(cloneMailboxEntry);
  }

  update(
    entryId: string,
    patch: Partial<Pick<TeamMailboxEntry, "status" | "messageId" | "error">>,
  ): TeamMailboxEntry | undefined {
    const index = this.entries.findIndex((entry) => entry.id === entryId);
    if (index < 0) return undefined;
    this.entries[index] = {
      ...this.entries[index],
      ...patch,
    };
    return cloneMailboxEntry(this.entries[index]);
  }

  list(limit?: number): TeamMailboxEntry[] {
    const items = limit && limit > 0
      ? this.entries.slice(-limit)
      : this.entries;
    return items.map((entry) => cloneMailboxEntry(entry));
  }

  snapshot(): TeamMailboxEntry[] {
    return this.list();
  }

  clear(): void {
    this.entries.length = 0;
  }

  get size(): number {
    return this.entries.length;
  }
}
