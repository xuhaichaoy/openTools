import { useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
import { useAIStore } from "@/store/ai-store";
import { useAgentStore } from "@/store/agent-store";
import { useWorkflowStore } from "@/store/workflow-store";
import { usePluginStore } from "@/store/plugin-store";
import { useBookmarkStore } from "@/store/bookmark-store";
import { useAppStore } from "@/store/app-store";
import { agentRunnerService } from "@/core/agent/agent-runner-service";
import { handleError, ErrorLevel } from "@/core/errors";
import { createLogger } from "@/core/logger";
import { registry } from "@/core/plugin-system/registry";
import { getMToolsAI } from "@/core/ai/mtools-ai";
import {
  isBuiltinPluginInstallRequired,
  resolveBuiltinPlugins,
} from "@/plugins/builtin";
import { CONTEXT_ACTION_VIEW_ID } from "@/core/navigation/view-stack";
import type {
  AgentScheduledTask,
  AgentTaskSkippedEvent,
  AgentTaskStatusPatch,
} from "@/core/ai/types";
import {
  applyGlobalFontScale,
  getPreferredWindowHeight,
  loadLocalFontScalePreference,
} from "@/core/ui/local-ui-preferences";
import { resizeManagedWindowHeight } from "@/shell/WindowSizeManager";

const log = createLogger("AppInitializer");

function registerAsyncListener<T>(
  eventName: string,
  handler: Parameters<typeof listen<T>>[1],
  options?: {
    effectId?: string;
    onErrorContext?: string;
  },
): () => void {
  let released = false;
  let unlisten: UnlistenFn | null = null;

  listen<T>(eventName, handler)
    .then((fn) => {
      if (released) {
        fn();
        log.warn("listener resolved after cleanup", {
          effectId: options?.effectId,
          eventName,
        });
        return;
      }
      unlisten = fn;
      log.info("listener registered", {
        effectId: options?.effectId,
        eventName,
      });
    })
    .catch((e) =>
      handleError(e, {
        context: options?.onErrorContext ?? `注册事件监听失败(${eventName})`,
        level: ErrorLevel.Warning,
      }),
    );

  return () => {
    released = true;
    if (!unlisten) return;
    unlisten();
    unlisten = null;
    log.info("listener unregistered", {
      effectId: options?.effectId,
      eventName,
    });
  };
}

/**
 * App-level initialization: loads stores, starts schedulers,
 * and sets up Tauri event listeners.
 */
export function useAppInitializer(
  pushView: (viewId: string) => void,
  setContextText: (text: string) => void,
) {
  // ── Store loading & scheduler startup (once) ──
  useEffect(() => {
    let cancelled = false;
    const effectId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    log.warn("effect mount", {
      effectId,
      dev: import.meta.env.DEV,
    });

    applyGlobalFontScale(loadLocalFontScalePreference());

    useAIStore
      .getState()
      .loadConfig()
      .then(() => {
        if (!cancelled) useAIStore.getState().loadOwnKeys();
      });
    useAIStore.getState().loadHistory();
    useAgentStore.getState().loadHistory();
    useAgentStore.getState().loadScheduledTasks();
    useWorkflowStore.getState().loadWorkflows();
    usePluginStore.getState().loadPlugins();
    useBookmarkStore.getState().loadBookmarks();

    invoke("workflow_scheduler_start").catch((e) =>
      handleError(e, { context: "定时调度启动", level: ErrorLevel.Warning }),
    );
    invoke("agent_scheduler_start").catch((e) =>
      handleError(e, { context: "Agent 编排调度启动", level: ErrorLevel.Warning }),
    );

    const releaseWorkflowScheduled = registerAsyncListener<{ workflowId: string; workflowName: string }>(
      "workflow-scheduled-trigger",
      (event) => {
        if (cancelled) return;
        const { workflowId } = event.payload;
        useWorkflowStore.getState().executeWorkflow(workflowId);
      },
      {
        effectId,
      },
    );
    const releaseAgentTrigger = registerAsyncListener<AgentScheduledTask>(
      "agent-task-trigger",
      (event) => {
        if (cancelled) return;
        const task = event.payload;
        useAgentStore.getState().upsertScheduledTask(task);
        agentRunnerService.enqueue(task);
      },
      {
        effectId,
      },
    );
    const releaseAgentStatus = registerAsyncListener<AgentTaskStatusPatch>(
      "agent-task-status",
      (event) => {
        if (cancelled) return;
        useAgentStore.getState().applyScheduledTaskPatch(event.payload);
      },
      {
        effectId,
      },
    );
    const releaseAgentSkipped = registerAsyncListener<AgentTaskSkippedEvent>(
      "agent-task-skipped",
      (event) => {
        if (cancelled) return;
        useAgentStore.getState().applyScheduledTaskSkipped(event.payload);
      },
      {
        effectId,
      },
    );

    invoke<string>("load_general_settings")
      .then((json) => {
        if (cancelled) return;
        const settings = JSON.parse(json);
        if (settings.theme) {
          document.documentElement.setAttribute("data-theme", settings.theme);
        }
      })
      .catch((e) => handleError(e, { context: "加载通用设置" }));

    return () => {
      cancelled = true;
      log.warn("effect cleanup", { effectId });
      releaseWorkflowScheduled();
      releaseAgentTrigger();
      releaseAgentStatus();
      releaseAgentSkipped();
    };
  }, []);

  // ── Plugin re-registration on market install change ──
  const runtimePlugins = usePluginStore((s) => s.plugins);
  const installedOfficialBuiltinPluginIds = useMemo(() => {
    const ids = new Set<string>();
    runtimePlugins.forEach((plugin) => {
      const slug = plugin.slug?.toLowerCase();
      if (!plugin.enabled || !slug) return;
      if (plugin.source !== "official") return;
      if (!isBuiltinPluginInstallRequired(slug)) return;
      ids.add(slug);
    });
    return Array.from(ids).sort();
  }, [runtimePlugins]);

  useEffect(() => {
    registry.registerAll(
      resolveBuiltinPlugins(installedOfficialBuiltinPluginIds),
    );
  }, [installedOfficialBuiltinPluginIds]);

  // ── Pending navigation relay ──
  const pendingNavigate = useAppStore((s) => s.pendingNavigate);
  useEffect(() => {
    if (pendingNavigate) {
      const viewId = useAppStore.getState().consumeNavigate();
      if (viewId) {
        pushView(viewId);
      }
    }
  }, [pendingNavigate, pushView]);

  // ── Context action event from Rust ──
  useEffect(() => {
    const release = registerAsyncListener<{ text: string }>(
      "context-action",
      (event) => {
        setContextText(event.payload.text);
        pushView(CONTEXT_ACTION_VIEW_ID);
        void resizeManagedWindowHeight(getPreferredWindowHeight("expanded"));
      },
      {
        onErrorContext: "注册 context-action 监听失败",
      },
    );
    return () => release();
  }, [pushView, setContextText]);

  // ── Workflow plugin action relay (backend → frontend) ──
  useEffect(() => {
    const release = registerAsyncListener<{
      requestId: string;
      pluginId: string;
      actionName: string;
      params: string;
    }>(
      "workflow-plugin-action",
      async (event) => {
        const { requestId, pluginId, actionName, params } = event.payload;
        try {
          const allActions = registry.getAllActions();
          const found = allActions.find(
            (a) => a.pluginId === pluginId && a.action.name === actionName,
          );
          if (!found) {
            throw new Error(`找不到插件动作: ${pluginId}/${actionName}`);
          }
          let parsedParams: Record<string, unknown> = {};
          try {
            parsedParams = JSON.parse(params);
          } catch (e) {
            handleError(e, { context: "解析工作流参数", silent: true });
          }
          const result = await found.action.execute(parsedParams, {
            ai: getMToolsAI(),
          });
          await emit("workflow-plugin-action-result", {
            requestId,
            result: typeof result === "string" ? result : JSON.stringify(result),
          });
        } catch (e: unknown) {
          await emit("workflow-plugin-action-result", {
            requestId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      },
      {
        onErrorContext: "注册 workflow-plugin-action 监听失败",
      },
    );
    return () => release();
  }, []);
}
