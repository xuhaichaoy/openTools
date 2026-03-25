import {
  WINDOW_HEIGHT_CHAT,
  WINDOW_HEIGHT_EXPANDED,
} from "@/core/constants";

const LOCAL_FONT_SCALE_KEY = "mtools.local.font-scale.v1";
const LOCAL_WINDOW_LAYOUT_KEY = "mtools.local.window-layout.v1";

export const FONT_SCALE_OPTIONS = [1, 1.2] as const;

export type FontScaleOption = (typeof FONT_SCALE_OPTIONS)[number];
export type LocalWindowHeightBucket = "expanded" | "chat";

export interface LocalWindowLayoutPreference {
  width: number;
  expandedHeight: number;
  chatHeight: number;
}

export const MIN_WINDOW_WIDTH = 800;
export const MAX_WINDOW_WIDTH = 1680;
export const MIN_EXPANDED_WINDOW_HEIGHT = 600;
export const MIN_CHAT_WINDOW_HEIGHT = 600;
export const MAX_WINDOW_HEIGHT = 1200;

const DEFAULT_WINDOW_LAYOUT: LocalWindowLayoutPreference = {
  width: MIN_WINDOW_WIDTH,
  expandedHeight: WINDOW_HEIGHT_EXPANDED,
  chatHeight: WINDOW_HEIGHT_CHAT,
};

function canUseLocalStorage(): boolean {
  return (
    typeof window !== "undefined"
    && typeof localStorage !== "undefined"
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function roundSize(value: number): number {
  return Math.round(Number.isFinite(value) ? value : 0);
}

function sanitizeFontScale(value: number): FontScaleOption {
  const normalized = Number(value);
  let closest: FontScaleOption = FONT_SCALE_OPTIONS[0];
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const option of FONT_SCALE_OPTIONS) {
    const distance = Math.abs(option - normalized);
    if (distance < closestDistance) {
      closest = option;
      closestDistance = distance;
    }
  }

  return closest;
}

function sanitizeWindowLayout(
  value: Partial<LocalWindowLayoutPreference> | null | undefined,
): LocalWindowLayoutPreference {
  return {
    width: clamp(
      roundSize(value?.width ?? DEFAULT_WINDOW_LAYOUT.width),
      MIN_WINDOW_WIDTH,
      MAX_WINDOW_WIDTH,
    ),
    expandedHeight: clamp(
      roundSize(value?.expandedHeight ?? DEFAULT_WINDOW_LAYOUT.expandedHeight),
      MIN_EXPANDED_WINDOW_HEIGHT,
      MAX_WINDOW_HEIGHT,
    ),
    chatHeight: clamp(
      roundSize(value?.chatHeight ?? DEFAULT_WINDOW_LAYOUT.chatHeight),
      MIN_CHAT_WINDOW_HEIGHT,
      MAX_WINDOW_HEIGHT,
    ),
  };
}

export function loadLocalFontScalePreference(): FontScaleOption {
  if (!canUseLocalStorage()) {
    return FONT_SCALE_OPTIONS[0];
  }

  const raw = localStorage.getItem(LOCAL_FONT_SCALE_KEY);
  if (!raw) return FONT_SCALE_OPTIONS[0];

  return sanitizeFontScale(Number(raw));
}

export function saveLocalFontScalePreference(value: number): FontScaleOption {
  const next = sanitizeFontScale(value);
  if (!canUseLocalStorage()) {
    return next;
  }

  localStorage.setItem(LOCAL_FONT_SCALE_KEY, String(next));
  return next;
}

export function applyGlobalFontScale(value: number): FontScaleOption {
  const next = sanitizeFontScale(value);
  if (typeof document === "undefined") {
    return next;
  }

  document.documentElement.style.setProperty("--app-font-scale", String(next));
  return next;
}

export function loadLocalWindowLayoutPreference(): LocalWindowLayoutPreference {
  if (!canUseLocalStorage()) {
    return DEFAULT_WINDOW_LAYOUT;
  }

  try {
    const raw = localStorage.getItem(LOCAL_WINDOW_LAYOUT_KEY);
    if (!raw) return DEFAULT_WINDOW_LAYOUT;
    return sanitizeWindowLayout(JSON.parse(raw));
  } catch {
    return DEFAULT_WINDOW_LAYOUT;
  }
}

export function saveLocalWindowLayoutPreference(
  patch: Partial<LocalWindowLayoutPreference>,
): LocalWindowLayoutPreference {
  const current = loadLocalWindowLayoutPreference();
  const next = sanitizeWindowLayout({ ...current, ...patch });

  if (!canUseLocalStorage()) {
    return next;
  }

  localStorage.setItem(LOCAL_WINDOW_LAYOUT_KEY, JSON.stringify(next));
  return next;
}

export function getPreferredWindowHeight(
  bucket: LocalWindowHeightBucket,
): number {
  const current = loadLocalWindowLayoutPreference();
  return bucket === "chat" ? current.chatHeight : current.expandedHeight;
}

export function persistWindowLayoutFromUserResize(
  width: number,
  height: number,
  bucket: LocalWindowHeightBucket | null,
): LocalWindowLayoutPreference {
  const patch: Partial<LocalWindowLayoutPreference> = {
    width: clamp(roundSize(width), MIN_WINDOW_WIDTH, MAX_WINDOW_WIDTH),
  };

  if (bucket === "chat") {
    patch.chatHeight = clamp(
      roundSize(height),
      MIN_CHAT_WINDOW_HEIGHT,
      MAX_WINDOW_HEIGHT,
    );
  } else if (bucket === "expanded") {
    patch.expandedHeight = clamp(
      roundSize(height),
      MIN_EXPANDED_WINDOW_HEIGHT,
      MAX_WINDOW_HEIGHT,
    );
  }

  return saveLocalWindowLayoutPreference(patch);
}

export function resolveWindowResizeBucket(
  view: string,
  searchValue: string,
  resultCount: number,
): LocalWindowHeightBucket | null {
  if (view === "ai-center") {
    return "chat";
  }

  if (view === "main") {
    if (!searchValue) return "expanded";
    return resultCount > 0 ? "expanded" : null;
  }

  return "expanded";
}
