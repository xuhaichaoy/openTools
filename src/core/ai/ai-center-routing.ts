import { useAIStore } from "@/store/ai-store";
import {
  useAppStore,
  type AICenterMode,
  type AICenterHandoff,
} from "@/store/app-store";
import {
  recordAIRouteEvent,
  type AIRouteSource,
} from "@/store/ai-route-store";

interface RouteToAICenterParams {
  mode: AICenterMode;
  source: AIRouteSource;
  query?: string;
  images?: string[];
  /** @deprecated 用 handoff 代替 */
  agentInitialQuery?: string;
  /** 通用跨模式接力载荷 */
  handoff?: AICenterHandoff;
  /** @deprecated 使用 handoff */
  agentHandoff?: AICenterHandoff;
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
    handoff,
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

  const normalizedHandoff = handoff ?? agentHandoff;
  if (normalizedHandoff) {
    appStore.setPendingAICenterHandoff({
      mode,
      payload: normalizedHandoff,
      createdAt: Date.now(),
    });
  } else if (mode === "agent" && agentInitialQuery?.trim()) {
    appStore.setPendingAICenterHandoff({
      mode,
      payload: { query: agentInitialQuery },
      createdAt: Date.now(),
    });
  }

  recordAIRouteEvent({
    mode,
    source,
    taskId,
    queryPreview: preview(query ?? normalizedHandoff?.query ?? agentInitialQuery),
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
