import { useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { useAIStore } from "@/store/ai-store";
import { useAgentStore } from "@/store/agent-store";
import { useWorkflowStore } from "@/store/workflow-store";
import { usePluginStore } from "@/store/plugin-store";
import { useBookmarkStore } from "@/store/bookmark-store";
import { useAppStore } from "@/store/app-store";
import { agentRunnerService } from "@/core/agent/agent-runner-service";
import { handleError, ErrorLevel } from "@/core/errors";
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

    let unlistenScheduled: (() => void) | undefined;
    let unlistenAgentTrigger: (() => void) | undefined;
    let unlistenAgentStatus: (() => void) | undefined;
    let unlistenAgentSkipped: (() => void) | undefined;
    listen<{ workflowId: string; workflowName: string }>(
      "workflow-scheduled-trigger",
      (event) => {
        if (cancelled) return;
        const { workflowId } = event.payload;
        useWorkflowStore.getState().executeWorkflow(workflowId);
      },
    ).then((fn) => {
      unlistenScheduled = fn;
    });
    listen<AgentScheduledTask>("agent-task-trigger", (event) => {
      if (cancelled) return;
      const task = event.payload;
      useAgentStore.getState().upsertScheduledTask(task);
      agentRunnerService.enqueue(task);
    }).then((fn) => {
      unlistenAgentTrigger = fn;
    });
    listen<AgentTaskStatusPatch>("agent-task-status", (event) => {
      if (cancelled) return;
      useAgentStore.getState().applyScheduledTaskPatch(event.payload);
    }).then((fn) => {
      unlistenAgentStatus = fn;
    });
    listen<AgentTaskSkippedEvent>("agent-task-skipped", (event) => {
      if (cancelled) return;
      useAgentStore.getState().applyScheduledTaskSkipped(event.payload);
    }).then((fn) => {
      unlistenAgentSkipped = fn;
    });

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
      unlistenScheduled?.();
      unlistenAgentTrigger?.();
      unlistenAgentStatus?.();
      unlistenAgentSkipped?.();
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
    let unlisten: (() => void) | undefined;
    listen<{ text: string }>("context-action", (event) => {
      setContextText(event.payload.text);
      pushView(CONTEXT_ACTION_VIEW_ID);
      void resizeManagedWindowHeight(getPreferredWindowHeight("expanded"));
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [pushView, setContextText]);

  // ── Workflow plugin action relay (backend → frontend) ──
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{
      requestId: string;
      pluginId: string;
      actionName: string;
      params: string;
    }>("workflow-plugin-action", async (event) => {
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
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);
}
