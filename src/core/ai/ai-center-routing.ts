import { useAIStore } from "@/store/ai-store";
import { useAppStore, type AICenterMode, type AgentHandoff } from "@/store/app-store";
import {
  recordAIRouteEvent,
  type AIRouteSource,
} from "@/store/ai-route-store";

interface RouteToAICenterParams {
  mode: AICenterMode;
  source: AIRouteSource;
  query?: string;
  images?: string[];
  /** @deprecated 用 agentHandoff 代替 */
  agentInitialQuery?: string;
  agentHandoff?: AgentHandoff;
  taskId?: string;
  note?: string;
  navigate?: boolean;
  pushView?: (viewId: string) => void;
}

function preview(input: string | undefined): string | undefined {
  const text = input?.trim();
  if (!text) return undefined;
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

export function routeToAICenter(params: RouteToAICenterParams): void {
  const {
    mode,
    source,
    query,
    images,
    agentInitialQuery,
    agentHandoff,
    taskId,
    note,
    navigate = true,
    pushView,
  } = params;

  const appStore = useAppStore.getState();
  appStore.setAiInitialMode(mode);
  appStore.setAiCenterMode(mode);

  if (mode === "ask" && query?.trim()) {
    void useAIStore.getState().sendMessage(query, images);
  }

  if (mode === "agent") {
    if (agentHandoff) {
      appStore.setPendingAgentHandoff(agentHandoff);
    } else if (agentInitialQuery?.trim()) {
      appStore.setPendingAgentHandoff({ query: agentInitialQuery });
    }
  }

  recordAIRouteEvent({
    mode,
    source,
    taskId,
    queryPreview: preview(query ?? agentHandoff?.query ?? agentInitialQuery),
    note,
  });

  if (!navigate) return;
  const currentView = appStore.currentView();
  if (currentView === "ai-center") return;

  if (pushView) {
    pushView("ai-center");
  } else {
    appStore.pushView("ai-center");
  }
}
