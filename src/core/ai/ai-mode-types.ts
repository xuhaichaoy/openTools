export type AIProductMode =
  | "explore"
  | "build"
  | "plan"
  | "review"
  | "dialog"
  | "im_conversation";

export type HumanSelectableAIProductMode = Exclude<AIProductMode, "im_conversation">;

export type LegacyAICenterMode = "ask" | "agent" | "cluster" | "dialog";

export type AICenterCompatibleMode = AIProductMode | LegacyAICenterMode;
export type AICenterMode = AICenterCompatibleMode;
export type AIInitialMode = AICenterCompatibleMode;

export type RuntimeSessionMode =
  | "agent"
  | "cluster"
  | "ask"
  | "dialog"
  | "im_conversation";

export function normalizeAIProductMode(
  mode?: AICenterCompatibleMode | null,
): AIProductMode {
  switch (mode) {
    case "ask":
      return "explore";
    case "agent":
      return "build";
    case "cluster":
      return "plan";
    case "review":
    case "dialog":
    case "im_conversation":
    case "explore":
    case "build":
    case "plan":
      return mode;
    default:
      return "explore";
  }
}

export function normalizeHumanSelectableAIProductMode(
  mode?: AICenterCompatibleMode | null,
): HumanSelectableAIProductMode {
  const normalized = normalizeAIProductMode(mode);
  return normalized === "im_conversation" ? "dialog" : normalized;
}

export function getLegacyAICenterMode(
  mode?: AICenterCompatibleMode | null,
): LegacyAICenterMode {
  switch (normalizeAIProductMode(mode)) {
    case "explore":
      return "ask";
    case "build":
      return "agent";
    case "plan":
      return "cluster";
    case "review":
    case "dialog":
    case "im_conversation":
    default:
      return "dialog";
  }
}

export function getAIProductModeForRuntimeMode(
  mode: RuntimeSessionMode | AIProductMode,
): AIProductMode {
  switch (mode) {
    case "ask":
      return "explore";
    case "agent":
      return "build";
    case "cluster":
      return "plan";
    case "dialog":
      return "dialog";
    case "im_conversation":
      return "im_conversation";
    case "explore":
    case "build":
    case "plan":
    case "review":
      return mode;
    default:
      return "explore";
  }
}

export function getRuntimeSessionModeForProductMode(
  mode?: AICenterCompatibleMode | null,
): RuntimeSessionMode {
  switch (normalizeAIProductMode(mode)) {
    case "explore":
      return "ask";
    case "build":
      return "agent";
    case "plan":
      return "cluster";
    case "review":
    case "dialog":
      return "dialog";
    case "im_conversation":
      return "im_conversation";
    default:
      return "ask";
  }
}
