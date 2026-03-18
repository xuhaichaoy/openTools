import { create } from "zustand";
import type { ClusterPlan, PlanApprovalRequest } from "@/core/agent/cluster/types";

export type ApprovalDialogPresentation =
  | {
      kind: "plan";
    }
  | {
      kind: "boundary";
      title?: string;
      description?: string;
      modeLabel: string;
      taskPreview?: string;
      summary: string;
      coordinatorLabel?: string;
      participantLabels: string[];
      permissions: string[];
      notes?: string[];
    };

interface ApprovalDialogRequest {
  id: string;
  plan: ClusterPlan;
  sessionId?: string;
  presentation?: ApprovalDialogPresentation;
  resolve: (result: PlanApprovalRequest) => void;
}

interface ClusterPlanApprovalState {
  active: ApprovalDialogRequest | null;
  queue: ApprovalDialogRequest[];
  open: (params: {
    plan: ClusterPlan;
    sessionId?: string;
    presentation?: ApprovalDialogPresentation;
  }) => Promise<PlanApprovalRequest>;
  approve: () => void;
  reject: () => void;
  clearAll: () => void;
}

function nextId(): string {
  return `cluster-approval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function popNext(requests: ApprovalDialogRequest[]): [ApprovalDialogRequest | null, ApprovalDialogRequest[]] {
  if (requests.length === 0) return [null, []];
  const [head, ...rest] = requests;
  return [head, rest];
}

export const useClusterPlanApprovalStore = create<ClusterPlanApprovalState>((set, get) => ({
  active: null,
  queue: [],
  open: ({ plan, sessionId, presentation }) =>
    new Promise<PlanApprovalRequest>((resolve) => {
      const request: ApprovalDialogRequest = {
        id: nextId(),
        plan,
        sessionId,
        presentation,
        resolve,
      };
      set((state) => {
        if (!state.active) {
          return { active: request, queue: state.queue };
        }
        return { active: state.active, queue: [...state.queue, request] };
      });
    }),
  approve: () => {
    const current = get().active;
    if (!current) return;
    current.resolve({ plan: current.plan, status: "approved" });
    set((state) => {
      const [next, rest] = popNext(state.queue);
      return { active: next, queue: rest };
    });
  },
  reject: () => {
    const current = get().active;
    if (!current) return;
    current.resolve({ plan: current.plan, status: "rejected" });
    set((state) => {
      const [next, rest] = popNext(state.queue);
      return { active: next, queue: rest };
    });
  },
  clearAll: () => {
    const { active, queue } = get();
    if (active) active.resolve({ plan: active.plan, status: "rejected" });
    for (const req of queue) {
      req.resolve({ plan: req.plan, status: "rejected" });
    }
    set({ active: null, queue: [] });
  },
}));
