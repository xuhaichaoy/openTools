import { createLogger } from "@/core/logger";

const log = createLogger("PageDebug");
type PageDebugGlobal = typeof globalThis & {
  __MTOOLS_PAGE_DEBUG_INSTALLED__?: boolean;
};

function getPageDebugGlobal(): PageDebugGlobal {
  return globalThis as PageDebugGlobal;
}

function nextBootCount(): number {
  try {
    const raw = sessionStorage.getItem("mtools-debug-boot-count");
    const next = Number.isFinite(Number(raw)) ? Number(raw) + 1 : 1;
    sessionStorage.setItem("mtools-debug-boot-count", String(next));
    return next;
  } catch {
    return 1;
  }
}

function summarizeNavigationType(): string {
  try {
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return entry?.type || "unknown";
  } catch {
    return "unknown";
  }
}

export function installPageLifecycleDebug(): void {
  const debugGlobal = getPageDebugGlobal();
  if (!import.meta.env.DEV) return;
  if (debugGlobal.__MTOOLS_PAGE_DEBUG_INSTALLED__) return;
  debugGlobal.__MTOOLS_PAGE_DEBUG_INSTALLED__ = true;

  const bootCount = nextBootCount();
  const bootId = `${bootCount}-${Date.now().toString(36)}`;

  log.warn("Page bootstrap", {
    bootId,
    bootCount,
    href: window.location.href,
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    navigationType: summarizeNavigationType(),
  });

  window.addEventListener("beforeunload", () => {
    log.warn("beforeunload", {
      bootId,
      href: window.location.href,
      visibilityState: document.visibilityState,
    });
  });

  window.addEventListener("pagehide", (event) => {
    log.warn("pagehide", {
      bootId,
      persisted: event.persisted,
      visibilityState: document.visibilityState,
    });
  });

  window.addEventListener("pageshow", (event) => {
    log.warn("pageshow", {
      bootId,
      persisted: event.persisted,
      visibilityState: document.visibilityState,
    });
  });

  document.addEventListener("visibilitychange", () => {
    log.info("visibilitychange", {
      bootId,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
    });
  });

  window.addEventListener("error", (event) => {
    log.error("window.error", {
      bootId,
      message: event.message,
      source: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: event.error instanceof Error
        ? {
            message: event.error.message,
            stack: event.error.stack,
          }
        : event.error,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason instanceof Error
      ? { message: event.reason.message, stack: event.reason.stack }
      : event.reason;
    log.error("window.unhandledrejection", {
      bootId,
      reason,
    });
  });

  const hot = import.meta.hot;
  hot?.on("vite:beforeUpdate", (payload) => {
    const updates = Array.isArray((payload as { updates?: unknown[] }).updates)
      ? ((payload as { updates?: Array<{ type?: string; path?: string }> }).updates ?? []).map((item) => ({
          type: item.type,
          path: item.path,
        }))
      : [];
    log.warn("vite.beforeUpdate", {
      bootId,
      updates,
    });
  });
  hot?.on("vite:afterUpdate", (payload) => {
    log.warn("vite.afterUpdate", {
      bootId,
      hasPayload: !!payload,
    });
  });
  hot?.on("vite:invalidate", (payload) => {
    log.warn("vite.invalidate", {
      bootId,
      payload,
    });
  });
  hot?.on("vite:error", (payload) => {
    log.error("vite.error", {
      bootId,
      payload,
    });
  });
}
