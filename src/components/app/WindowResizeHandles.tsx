import { useEffect, useRef } from "react";
import { LogicalSize, currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import {
  MAX_WINDOW_HEIGHT,
  MAX_WINDOW_WIDTH,
  MIN_CHAT_WINDOW_HEIGHT,
  MIN_EXPANDED_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  loadLocalWindowLayoutPreference,
  persistWindowLayoutFromUserResize,
  type LocalWindowHeightBucket,
} from "@/core/ui/local-ui-preferences";

type ResizeDirection = "east" | "south" | "southeast";

const WINDOW_MONITOR_MARGIN = 24;

interface ResizeSession {
  direction: ResizeDirection;
  startX: number;
  startY: number;
  startWidth: number;
  startHeight: number;
}

interface ActivePointerListeners {
  move: ((event: PointerEvent) => void) | null;
  up: (() => void) | null;
  cancel: (() => void) | null;
}

function getMinHeight(bucket: LocalWindowHeightBucket | null): number {
  if (bucket === "chat") return MIN_CHAT_WINDOW_HEIGHT;
  if (bucket === "expanded") return MIN_EXPANDED_WINDOW_HEIGHT;
  return window.innerHeight;
}

function getCursor(direction: ResizeDirection): string {
  if (direction === "east") return "ew-resize";
  if (direction === "south") return "ns-resize";
  return "nwse-resize";
}

function clampDimension(value: number, min: number, max: number): number {
  const upper = Math.max(1, Math.round(max));
  const lower = Math.min(Math.max(1, Math.round(min)), upper);
  return Math.min(Math.max(Math.round(value), lower), upper);
}

async function getCurrentMonitorLogicalBounds() {
  const currentWindow = getCurrentWindow();
  const [monitor, fallbackScale] = await Promise.all([
    currentMonitor().catch(() => null),
    currentWindow.scaleFactor().catch(() => window.devicePixelRatio || 1),
  ]);
  const scale =
    monitor?.scaleFactor
    ?? fallbackScale
    ?? window.devicePixelRatio
    ?? 1;
  const physicalWidth = monitor?.workArea.size.width
    ?? Math.round(window.screen.availWidth * scale);
  const physicalHeight = monitor?.workArea.size.height
    ?? Math.round(window.screen.availHeight * scale);

  return {
    width: Math.max(
      1,
      Math.floor(physicalWidth / scale) - WINDOW_MONITOR_MARGIN * 2,
    ),
    height: Math.max(
      1,
      Math.floor(physicalHeight / scale) - WINDOW_MONITOR_MARGIN * 2,
    ),
  };
}

async function clampWindowSizeToCurrentMonitor(
  width: number,
  height: number,
  bucket: LocalWindowHeightBucket | null,
) {
  const monitorBounds = await getCurrentMonitorLogicalBounds();
  const maxWidth = Math.max(
    MIN_WINDOW_WIDTH,
    Math.min(MAX_WINDOW_WIDTH, monitorBounds.width),
  );
  const maxHeight = Math.max(1, Math.min(MAX_WINDOW_HEIGHT, monitorBounds.height));
  const minWidth = MIN_WINDOW_WIDTH;
  const requestedMinHeight = bucket === "chat"
    ? MIN_CHAT_WINDOW_HEIGHT
    : bucket === "expanded"
      ? MIN_EXPANDED_WINDOW_HEIGHT
      : 1;
  const minHeight = requestedMinHeight;
  const boundedMaxHeight = Math.max(minHeight, maxHeight);

  return {
    width: clampDimension(width, minWidth, maxWidth),
    height: clampDimension(height, minHeight, boundedMaxHeight),
  };
}

export function WindowResizeHandles({
  bucket,
}: {
  bucket: LocalWindowHeightBucket | null;
}) {
  const bucketRef = useRef(bucket);
  const cleanupDragRef = useRef<(persist: boolean) => void>(() => {});
  const dragRef = useRef<ResizeSession | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingSizeRef = useRef<{ width: number; height: number } | null>(null);
  const activeListenersRef = useRef<ActivePointerListeners>({
    move: null,
    up: null,
    cancel: null,
  });

  useEffect(() => {
    bucketRef.current = bucket;
  }, [bucket]);

  async function applyClampedWindowSize(
    width: number,
    height: number,
  ): Promise<{ width: number; height: number }> {
    const next = await clampWindowSizeToCurrentMonitor(width, height, bucketRef.current);
    if (
      Math.round(window.innerWidth) === next.width
      && Math.round(window.innerHeight) === next.height
    ) {
      return next;
    }

    await getCurrentWindow()
      .setSize(new LogicalSize(next.width, next.height))
      .catch(() => {});

    return next;
  }

  function flushPendingSize() {
    if (frameRef.current !== null) return;

    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const pending = pendingSizeRef.current;
      pendingSizeRef.current = null;
      if (!pending) return;

      void applyClampedWindowSize(pending.width, pending.height)
        .catch(() => {})
        .finally(() => {
          if (pendingSizeRef.current) {
            flushPendingSize();
          }
        });
    });
  }

  function cleanupDrag(persist: boolean) {
    if (activeListenersRef.current.move) {
      window.removeEventListener("pointermove", activeListenersRef.current.move);
    }
    if (activeListenersRef.current.up) {
      window.removeEventListener("pointerup", activeListenersRef.current.up);
    }
    if (activeListenersRef.current.cancel) {
      window.removeEventListener("pointercancel", activeListenersRef.current.cancel);
    }
    activeListenersRef.current = {
      move: null,
      up: null,
      cancel: null,
    };
    document.body.style.removeProperty("user-select");
    document.body.style.removeProperty("cursor");

    const finalSize = pendingSizeRef.current;
    pendingSizeRef.current = null;

    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    dragRef.current = null;

    if (finalSize) {
      void applyClampedWindowSize(finalSize.width, finalSize.height)
        .then((applied) => {
          if (!persist) return;
          persistWindowLayoutFromUserResize(
            applied.width,
            applied.height,
            bucketRef.current,
          );
        })
        .catch(() => {});
    }

    if (!persist || finalSize) return;

    persistWindowLayoutFromUserResize(
      Math.round(window.innerWidth),
      Math.round(window.innerHeight),
      bucketRef.current,
    );
  }

  useEffect(() => {
    cleanupDragRef.current = cleanupDrag;
  });

  function handlePointerMove(event: PointerEvent) {
    const session = dragRef.current;
    if (!session) return;

    const deltaX = event.clientX - session.startX;
    const deltaY = event.clientY - session.startY;
    let nextWidth = session.startWidth;
    let nextHeight = session.startHeight;

    if (session.direction === "east" || session.direction === "southeast") {
      nextWidth = Math.min(
        Math.max(Math.round(session.startWidth + deltaX), MIN_WINDOW_WIDTH),
        MAX_WINDOW_WIDTH,
      );
    }

    if (
      bucketRef.current
      && (session.direction === "south" || session.direction === "southeast")
    ) {
      nextHeight = Math.min(
        Math.max(
          Math.round(session.startHeight + deltaY),
          getMinHeight(bucketRef.current),
        ),
        MAX_WINDOW_HEIGHT,
      );
    }

    pendingSizeRef.current = { width: nextWidth, height: nextHeight };
    flushPendingSize();
  }

  useEffect(() => {
    const { width } = loadLocalWindowLayoutPreference();
    void applyClampedWindowSize(width, window.innerHeight);
  }, []);

  useEffect(() => {
    return () => {
      cleanupDragRef.current(false);
    };
  }, []);

  function beginResize(direction: ResizeDirection) {
    return (
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (direction !== "east" && !bucketRef.current) return;

    event.preventDefault();
    event.stopPropagation();

    dragRef.current = {
      direction,
      startX: event.clientX,
      startY: event.clientY,
      startWidth: window.innerWidth,
      startHeight: window.innerHeight,
    };

    document.body.style.setProperty("user-select", "none");
    document.body.style.setProperty("cursor", getCursor(direction));

    const moveListener = (nativeEvent: PointerEvent) => {
      handlePointerMove(nativeEvent);
    };
    const upListener = () => {
      cleanupDrag(true);
    };
    const cancelListener = () => {
      cleanupDrag(false);
    };

    activeListenersRef.current = {
      move: moveListener,
      up: upListener,
      cancel: cancelListener,
    };

    window.addEventListener("pointermove", moveListener);
    window.addEventListener("pointerup", upListener);
    window.addEventListener("pointercancel", cancelListener);
    };
  }

  const baseHandleClass =
    "absolute z-50 select-none touch-none bg-transparent";

  return (
    <>
      <div
        className={`${baseHandleClass} right-0 top-0 h-full w-2 cursor-ew-resize`}
        onPointerDown={beginResize("east")}
        aria-hidden="true"
      />

      {bucket && (
        <div
          className={`${baseHandleClass} bottom-0 left-0 h-2 w-full cursor-ns-resize`}
          onPointerDown={beginResize("south")}
          aria-hidden="true"
        />
      )}

      {bucket && (
        <>
          <div
            className={`${baseHandleClass} bottom-0 right-0 h-4 w-4 cursor-nwse-resize`}
            onPointerDown={beginResize("southeast")}
            aria-hidden="true"
          />
          <div className="pointer-events-none absolute bottom-2 right-2 z-40 grid grid-cols-2 gap-0.5 opacity-35">
            <span className="h-0.5 w-0.5 rounded-full bg-[var(--color-text-secondary)]" />
            <span className="h-0.5 w-0.5 rounded-full bg-[var(--color-text-secondary)]" />
            <span className="h-0.5 w-0.5 rounded-full bg-[var(--color-text-secondary)]" />
            <span className="h-0.5 w-0.5 rounded-full bg-[var(--color-text-secondary)]" />
          </div>
        </>
      )}
    </>
  );
}
