import type { AICenterMode, AICenterSourceRef } from "@/store/app-store";
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

function buildModeMeta(mode: AICenterMode): AICenterModeMeta {
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

export const AI_CENTER_MODE_META: Record<AICenterMode, AICenterModeMeta> = {
  ask: buildModeMeta("ask"),
  agent: buildModeMeta("agent"),
  cluster: buildModeMeta("cluster"),
  dialog: buildModeMeta("dialog"),
};

export function formatAICenterModeLabel(mode?: AICenterMode | null): string {
  return formatAICenterProductLabel(mode);
}

export function describeAICenterSource(source?: Partial<AICenterSourceRef> | null): string {
  if (!source?.sourceMode) return "外部上下文";
  return source.sourceLabel?.trim() || formatAICenterModeLabel(source.sourceMode);
}
