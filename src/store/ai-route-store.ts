import { create } from "zustand";
import type { AICenterMode } from "@/store/app-store";

const MAX_ROUTE_EVENTS = 200;

export type AIRouteSource =
  | "main_search_submit"
  | "main_shell_shortcut"
  | "command_palette_ai"
  | "command_palette_shell"
  | "ask_continue_to_agent"
  | "ask_continue_to_cluster"
  | "ask_continue_to_dialog"
  | "cluster_continue_to_agent"
  | "cluster_continue_to_dialog"
  | "dialog_continue_to_agent"
  | "cluster_run"
  | "agent_run"
  | "floating_indicator";

export interface AIRouteEvent {
  id: string;
  timestamp: number;
  mode: AICenterMode;
  source: AIRouteSource;
  taskId?: string;
  queryPreview?: string;
  note?: string;
}

interface AIRouteState {
  events: AIRouteEvent[];
  record: (event: Omit<AIRouteEvent, "id" | "timestamp">) => AIRouteEvent;
  clear: () => void;
}

function buildEventId(): string {
  return `airoute-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useAIRouteStore = create<AIRouteState>((set, get) => ({
  events: [],
  record: (event) => {
    const next: AIRouteEvent = {
      ...event,
      id: buildEventId(),
      timestamp: Date.now(),
    };
    set((state) => ({
      events: [next, ...state.events].slice(0, MAX_ROUTE_EVENTS),
    }));
    return next;
  },
  clear: () => set({ events: [] }),
}));

export function recordAIRouteEvent(event: Omit<AIRouteEvent, "id" | "timestamp">): AIRouteEvent {
  return useAIRouteStore.getState().record(event);
}
