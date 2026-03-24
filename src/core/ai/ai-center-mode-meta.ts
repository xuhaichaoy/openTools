import type { AICenterSourceRef } from "@/store/app-store";
import type {
  AICenterCompatibleMode,
  HumanSelectableAIProductMode,
} from "@/core/ai/ai-mode-types";
import { normalizeHumanSelectableAIProductMode } from "@/core/ai/ai-mode-types";
import {
  formatAICenterProductLabel,
  getAICenterProductModeDefinition,
} from "./ai-product-modes";

export interface AICenterModeMeta {
  label: string;
  boundaryHeadline: string;
  boundaryDetail: string;
  modelScopeShort: string;
  modelScope: string;
  skillScopeShort: string;
  skillScope: string;
}

function buildModeMeta(mode: HumanSelectableAIProductMode): AICenterModeMeta {
  const definition = getAICenterProductModeDefinition(mode);
  return {
    label: definition.label,
    boundaryHeadline: definition.boundaryHeadline,
    boundaryDetail: definition.boundaryDetail,
    modelScopeShort: definition.modelScopeShort,
    modelScope: definition.modelScope,
    skillScopeShort: definition.skillScopeShort,
    skillScope: definition.skillScope,
  };
}

export const AI_CENTER_MODE_META: Record<HumanSelectableAIProductMode, AICenterModeMeta> = {
  explore: buildModeMeta("explore"),
  build: buildModeMeta("build"),
  plan: buildModeMeta("plan"),
  review: buildModeMeta("review"),
  dialog: buildModeMeta("dialog"),
};

export function getAICenterModeMeta(
  mode?: AICenterCompatibleMode | null,
): AICenterModeMeta {
  return AI_CENTER_MODE_META[normalizeHumanSelectableAIProductMode(mode)];
}

export function formatAICenterModeLabel(mode?: HumanSelectableAIProductMode | null | string): string {
  return formatAICenterProductLabel(mode);
}

export function describeAICenterSource(source?: Partial<AICenterSourceRef> | null): string {
  if (!source?.sourceMode) return "外部上下文";
  return source.sourceLabel?.trim() || formatAICenterModeLabel(
    normalizeHumanSelectableAIProductMode(source.sourceMode),
  );
}
