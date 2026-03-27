import { create } from "zustand";
import type { ToolApprovalRisk } from "@/core/agent/actor/tool-approval-policy";

export type ConfirmDialogSource = "ask" | "agent" | "cluster" | "actor_dialog";

interface ConfirmDialogRequest {
  id: string;
  toolName: string;
  params: Record<string, unknown>;
  source: ConfirmDialogSource;
  risk?: ToolApprovalRisk;
  reason?: string;
  reviewedByModel?: boolean;
  resolve: (confirmed: boolean) => void;
}

interface ConfirmDialogState {
  active: ConfirmDialogRequest | null;
  queue: ConfirmDialogRequest[];
  open: (params: {
    toolName: string;
    params: Record<string, unknown>;
    source: ConfirmDialogSource;
    risk?: ToolApprovalRisk;
    reason?: string;
    reviewedByModel?: boolean;
  }) => Promise<boolean>;
  submit: (confirmed: boolean) => void;
  dismiss: () => void;
  clearAll: () => void;
}

function nextId(): string {
  return `confirm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function popNext(requests: ConfirmDialogRequest[]): [ConfirmDialogRequest | null, ConfirmDialogRequest[]] {
  if (requests.length === 0) return [null, []];
  const [head, ...rest] = requests;
  return [head, rest];
}

export const useConfirmDialogStore = create<ConfirmDialogState>((set, get) => ({
  active: null,
  queue: [],
  open: ({ toolName, params, source, risk, reason, reviewedByModel }) =>
    new Promise<boolean>((resolve) => {
      const request: ConfirmDialogRequest = {
        id: nextId(),
        toolName,
        params,
        source,
        risk,
        reason,
        reviewedByModel,
        resolve,
      };

      set((state) => {
        if (!state.active) {
          return { active: request, queue: state.queue };
        }
        return { active: state.active, queue: [...state.queue, request] };
      });
    }),
  submit: (confirmed) => {
    const current = get().active;
    if (!current) return;
    current.resolve(confirmed);
    set((state) => {
      const [next, rest] = popNext(state.queue);
      return { active: next, queue: rest };
    });
  },
  dismiss: () => {
    get().submit(false);
  },
  clearAll: () => {
    const { active, queue } = get();
    active?.resolve(false);
    for (const req of queue) {
      req.resolve(false);
    }
    set({ active: null, queue: [] });
  },
}));
