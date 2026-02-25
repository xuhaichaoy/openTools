import { useEffect, useMemo, useRef } from "react";
import { registry } from "@/core/plugin-system/registry";
import { getMToolsAI } from "@/core/ai/mtools-ai";
import { ScopedStorage } from "@/core/plugin-system/storage";
import { createPluginContext } from "@/core/plugin-system/context";
import type { MToolsPlugin } from "@/core/plugin-system/plugin-interface";
import type { PluginContext } from "@/core/plugin-system/context";
import { isShellViewId } from "@/core/navigation/view-stack";
import { handleError } from "@/core/errors";

/**
 * Manages plugin activation/deactivation lifecycle with error handling.
 * Returns the active plugin and its context for rendering.
 */
export function usePluginLifecycle(
  view: string,
  resetToMain: () => void,
): { activePlugin: MToolsPlugin | undefined; pluginContext: PluginContext | null } {
  const activePlugin = registry.getByViewId(view);
  const prevPluginRef = useRef<MToolsPlugin | undefined>(undefined);

  // If view points to a non-existent plugin (and isn't a shell view), reset
  useEffect(() => {
    if (!activePlugin && !isShellViewId(view)) {
      resetToMain();
    }
  }, [activePlugin, view, resetToMain]);

  const pluginContext = useMemo(
    () =>
      activePlugin
        ? createPluginContext(getMToolsAI(), new ScopedStorage(activePlugin.id))
        : null,
    [activePlugin],
  );

  // Lifecycle hooks with error boundaries
  useEffect(() => {
    const prevPlugin = prevPluginRef.current;

    if (prevPlugin && prevPlugin.id !== activePlugin?.id) {
      try {
        prevPlugin.onDeactivate?.();
      } catch (e) {
        handleError(e, { context: `插件 ${prevPlugin.id} 停用失败`, silent: true });
      }
    }

    if (activePlugin && activePlugin.id !== prevPlugin?.id && pluginContext) {
      try {
        const result = activePlugin.onActivate?.(pluginContext);
        if (result instanceof Promise) {
          result.catch((e) => {
            handleError(e, { context: `插件 ${activePlugin.id} 激活失败`, silent: true });
          });
        }
      } catch (e) {
        handleError(e, { context: `插件 ${activePlugin.id} 激活失败`, silent: true });
      }
    }

    prevPluginRef.current = activePlugin;
  }, [activePlugin, pluginContext]);

  return { activePlugin, pluginContext };
}
