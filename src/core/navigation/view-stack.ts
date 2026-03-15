export const MAIN_VIEW_ID = "main";
export const HOME_VIEW_ID = "home";
export const PLUGIN_EMBED_VIEW_ID = "plugin-embed";
export const CONTEXT_ACTION_VIEW_ID = "context-action";
export const ROOT_VIEW_ID = "ai-center";

export const SHELL_VIEW_IDS = [
  MAIN_VIEW_ID,
  HOME_VIEW_ID,
  PLUGIN_EMBED_VIEW_ID,
  CONTEXT_ACTION_VIEW_ID,
] as const;

export type ShellViewId = (typeof SHELL_VIEW_IDS)[number];

export interface ViewEntry {
  viewId: string;
  params?: Record<string, unknown>;
}

const SHELL_VIEW_ID_SET = new Set<string>(SHELL_VIEW_IDS);

export function isShellViewId(viewId: string): viewId is ShellViewId {
  return SHELL_VIEW_ID_SET.has(viewId);
}

export function createRootViewStack(): ViewEntry[] {
  return [{ viewId: ROOT_VIEW_ID }];
}

export function getTopViewEntry(viewStack: ViewEntry[]): ViewEntry {
  return viewStack[viewStack.length - 1] ?? { viewId: ROOT_VIEW_ID };
}

export function pushViewEntry(
  viewStack: ViewEntry[],
  nextEntry: ViewEntry,
): ViewEntry[] {
  const top = getTopViewEntry(viewStack);
  if (top.viewId === nextEntry.viewId) {
    return viewStack;
  }
  return [...viewStack, nextEntry];
}

export function popViewEntry(viewStack: ViewEntry[]): ViewEntry[] {
  if (viewStack.length <= 1) {
    return createRootViewStack();
  }
  return viewStack.slice(0, -1);
}

export function replaceTopViewEntry(
  viewStack: ViewEntry[],
  nextEntry: ViewEntry,
): ViewEntry[] {
  if (viewStack.length <= 1) {
    return [nextEntry];
  }
  return [...viewStack.slice(0, -1), nextEntry];
}
