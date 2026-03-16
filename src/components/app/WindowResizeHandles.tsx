import { useEffect, useRef } from "react";
import { LogicalSize, getCurrentWindow } from "@tauri-apps/api/window";
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

  function flushPendingSize() {
    if (frameRef.current !== null) return;

    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const pending = pendingSizeRef.current;
      pendingSizeRef.current = null;
      if (!pending) return;

      void getCurrentWindow()
        .setSize(new LogicalSize(pending.width, pending.height))
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
      void getCurrentWindow()
        .setSize(new LogicalSize(finalSize.width, finalSize.height))
        .catch(() => {});
    }

    if (!persist) return;

    persistWindowLayoutFromUserResize(
      finalSize?.width ?? window.innerWidth,
      finalSize?.height ?? window.innerHeight,
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
    if (Math.round(window.innerWidth) === width) return;

    void getCurrentWindow()
      .setSize(new LogicalSize(width, window.innerHeight))
      .catch(() => {});
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
