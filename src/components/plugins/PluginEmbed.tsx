import { useState, useEffect, useRef } from "react";
import { ArrowLeft } from "lucide-react";
import { useDragWindow } from "@/hooks/useDragWindow";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface PluginEmbedProps {
  pluginId: string;
  featureCode: string;
  bridgeToken: string;
  title?: string;
  onBack: () => void;
}

export function PluginEmbed({
  pluginId,
  featureCode,
  bridgeToken,
  title,
  onBack,
}: PluginEmbedProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { onMouseDown } = useDragWindow();

  useEffect(() => {
    let cancelled = false;
    invoke<string>("plugin_get_embed_html", {
      pluginId,
      featureCode,
      bridgeToken,
    })
      .then((h) => {
        if (!cancelled) {
          setHtml(h);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
          setHtml(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [pluginId, featureCode, bridgeToken, reloadTick]);

  useEffect(() => {
    let cancelled = false;
    const unlistenTasks: Promise<() => void>[] = [];

    unlistenTasks.push(
      listen<any>("plugin-dev:file-changed", (event) => {
        if (cancelled) return;
        const pluginIds = Array.isArray(event.payload?.pluginIds)
          ? event.payload.pluginIds
          : [];
        if (pluginIds.includes(pluginId)) {
          setReloadTick((v) => v + 1);
        }
      }),
    );

    unlistenTasks.push(
      listen<any>("plugin-dev:simulate-event", (event) => {
        if (cancelled) return;
        const payload = event.payload ?? {};
        if (payload.pluginId !== pluginId || payload.featureCode !== featureCode) {
          return;
        }
        iframeRef.current?.contentWindow?.postMessage(
          {
            type: "mtools-dev-simulate",
            pluginId,
            eventType: payload.eventType,
            payload: payload.payload ?? null,
          },
          "*",
        );
      }),
    );

    return () => {
      cancelled = true;
      for (const task of unlistenTasks) {
        task.then((fn) => fn()).catch(() => {});
      }
    };
  }, [pluginId, featureCode]);

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)] rounded-xl overflow-hidden">
      <div
        className="flex items-center gap-2 px-4 py-2 border-b border-[var(--color-border)] shrink-0 cursor-grab active:cursor-grabbing"
        onMouseDown={onMouseDown}
      >
        <button
          onClick={onBack}
          className="p-1 rounded hover:bg-[var(--color-bg-hover)] text-[var(--color-text-secondary)]"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <span className="text-sm font-medium text-[var(--color-text)]">
          {title ?? "插件"}
        </span>
      </div>
      <div className="flex-1 min-h-0 relative">
        {error && (
          <div className="absolute inset-0 flex items-center justify-center p-4 text-sm text-[var(--color-text-secondary)]">
            {error}
          </div>
        )}
        {html && (
          <iframe
            ref={iframeRef}
            title="plugin"
            srcDoc={html}
            sandbox="allow-scripts allow-forms allow-popups"
            className="w-full h-full border-0 rounded-b-xl bg-[var(--color-bg)]"
          />
        )}
        {!html && !error && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-[var(--color-text-secondary)]">
            加载中…
          </div>
        )}
      </div>
    </div>
  );
}
